// Orate — image picking, cropping (avatars / banners / icons) and uploading.
import { html, useState, useEffect, useRef, clamp } from '/js/lib.js';
import { state, openModal, closeModal } from '/js/store.js';
import { Modal, Btn, Slider, MODALS } from '/js/ui.js';
import { upload } from '/js/api.js';
import { Icon } from '/js/icons.js';
import { canCropGif, cropGif } from '/js/gifcrop.js';

/** Pick a file from disk. Resolves with a File or null. */
export function pickFile(accept = 'image/*') {
  return new Promise((resolve) => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] || null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** Open the crop dialog; resolves with a Blob (png/webp/jpeg) or null when cancelled. */
export function cropImage(file, { aspect = 1, out = 512, round = false, title = 'Edit Image' } = {}) {
  return new Promise((resolve) => { openModal('crop', { file, aspect, out, round, title, resolve }); });
}

MODALS.crop = function CropModal({ id, file, aspect, out, round, title, resolve }) {
  // the frame is what you keep; around it the stage shows (dimmed) the part of the picture that will be cut off, like Discord's
  const padX = 34; const padY = aspect > 1.5 ? 56 : 34;
  const frameW = Math.min(360, innerWidth - 80 - 2 * padX); const frameH = Math.round(frameW / aspect);
  const [img, setImg] = useState(null); const [zoom, setZoom] = useState(1); const [pos, setPos] = useState({ x: 0, y: 0 }); const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);   // while an animated GIF is being cropped
  const drag = useRef(null); const url = useRef(null);
  const gif = file.type === 'image/gif' && canCropGif();
  useEffect(() => {
    url.current = URL.createObjectURL(file); const im = new Image(); im.onload = () => { setImg(im); }; im.src = url.current;
    return () => URL.revokeObjectURL(url.current);
  }, []);
  const base = img ? Math.max(frameW / img.naturalWidth, frameH / img.naturalHeight) : 1;
  const scale = base * zoom;
  const limit = (p, z = zoom) => { if (!img) return p; const s = base * z; const w = img.naturalWidth * s; const h = img.naturalHeight * s; return { x: clamp(p.x, frameW - w, 0), y: clamp(p.y, frameH - h, 0) }; };
  useEffect(() => { if (img) setPos(limit({ x: (frameW - img.naturalWidth * base) / 2, y: (frameH - img.naturalHeight * base) / 2 })); }, [img]);
  const done = (blob) => { closeModal(id); resolve(blob); };
  const apply = async () => {
    setBusy(true);
    if (gif) {   // an animated GIF keeps moving: every frame gets the same crop
      const gw = Math.min(out, aspect > 1.5 ? 640 : 512);
      try { const g = await cropGif(file, { sx: -pos.x / scale, sy: -pos.y / scale, sw: frameW / scale, sh: frameH / scale, width: gw, height: Math.round(gw / aspect), onProgress: setProgress }); if (g) { done(g); return; } } catch (e) { console.warn('[orate] could not crop the GIF', e); }
      setProgress(null);   // not animated, or the browser could not: crop the first frame like any picture
    }
    const c = document.createElement('canvas'); c.width = out; c.height = Math.round(out / aspect); const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, -pos.x / scale, -pos.y / scale, frameW / scale, frameH / scale, 0, 0, c.width, c.height);
    c.toBlob((b) => done(b), 'image/webp', 0.92);
  };
  const noDrag = (e) => e.preventDefault();   // never let the browser start dragging the picture itself (the ghost image Chrome shows)
  const onDown = (e) => { drag.current = { sx: e.clientX, sy: e.clientY, p: pos }; e.currentTarget.setPointerCapture(e.pointerId); };
  const onMove = (e) => { if (!drag.current) return; setPos(limit({ x: drag.current.p.x + e.clientX - drag.current.sx, y: drag.current.p.y + e.clientY - drag.current.sy })); };
  const setZ = (z) => { const cx0 = frameW / 2; const cy0 = frameH / 2; const ratio = (base * z) / scale; setZoom(z); setPos(limit({ x: cx0 - (cx0 - pos.x) * ratio, y: cy0 - (cy0 - pos.y) * ratio }, z)); };
  return html`<${Modal} title=${title} width=${frameW + 2 * padX + 48} onClose=${() => done(null)} footer=${html`<${Btn} variant="ghost" onClick=${() => done(null)}>Cancel<//><${Btn} variant="primary" loading=${busy} disabled=${!img} onClick=${apply}>Apply<//>`}>
    <div class="crop-stage" style=${{ padding: `${padY}px ${padX}px` }} onDragStart=${noDrag} onPointerDown=${onDown} onPointerMove=${onMove} onPointerUp=${() => (drag.current = null)} onPointerCancel=${() => (drag.current = null)} onWheel=${(e) => { e.preventDefault(); setZ(clamp(zoom - e.deltaY * 0.0015, 1, 4)); }}>
      <div class=${`crop-frame ${round ? 'round' : ''}`} style=${{ width: frameW + 'px', height: frameH + 'px' }}>
        ${img ? html`<img src=${url.current} draggable=${false} onDragStart=${noDrag} alt="" style=${{ width: img.naturalWidth * scale + 'px', height: img.naturalHeight * scale + 'px', transform: `translate(${pos.x}px, ${pos.y}px)` }} />` : null}
        <div class="crop-ring"></div>
      </div>
    </div>
    <div class="crop-zoom"><${Icon} name="image" size=${16} /><${Slider} value=${zoom} min=${1} max=${4} step=${0.01} onChange=${setZ} format=${(v) => v.toFixed(1) + '×'} /><${Icon} name="image" size=${22} /></div>
    <p class="crop-hint">${progress !== null ? `Cropping the animation… ${Math.round(progress * 100)}%` : gif ? 'Only the bright part shows. Drag the picture to move it, scroll or use the slider to zoom. The animation is kept.' : 'Only the bright part shows. Drag the picture to move it, scroll or use the slider to zoom.'}</p>
  <//>`;
};

/** Pick, crop and upload an image; resolves with the uploaded URL (or undefined if cancelled). */
export async function chooseAndUploadImage(opts) {
  const file = await pickFile('image/png,image/jpeg,image/webp,image/gif');
  if (!file) return undefined;
  return cropAndUpload(file, opts);
}
/** Crops (with the dialog) and uploads a picture you already have. A GIF stays animated; where the browser can't crop one it is uploaded as it is. */
export async function cropAndUpload(file, opts = {}) {
  if (file.type === 'image/gif' && opts.allowGif && !canCropGif()) {
    if (file.size >= 8 * 1024 * 1024) throw new Error('That GIF is too large (max 8 MB)');
    return (await upload(file)).url;
  }
  const blob = await cropImage(file, opts);
  if (!blob) return undefined;
  const isGif = blob.type === 'image/gif';
  const r = await upload(new File([blob], isGif ? 'image.gif' : 'image.webp', { type: isGif ? 'image/gif' : 'image/webp' }));
  return r.url;
}
/** Downloads a remote image through the server's image proxy and stores it as an upload; resolves with the new /uploads URL. With `crop` (the crop dialog's options) the GIF is positioned first — resolves undefined if that is cancelled. */
export async function uploadGifFrom(url, name = 'image.gif', crop = null) {
  if (!url) throw new Error('That GIF has no image to use');
  const r = await fetch('/api/img?url=' + encodeURIComponent(url));
  if (!r.ok) throw new Error('Could not download that GIF');
  const blob = await r.blob();
  if (blob.size > 8 * 1024 * 1024) throw new Error('That GIF is too large (max 8 MB)');
  const file = new File([blob], name, { type: blob.type || 'image/gif' });
  if (crop && canCropGif() && file.type === 'image/gif') return cropAndUpload(file, { ...crop, allowGif: true });
  const res = await upload(file);
  return res.url;
}
void state;
