// Orate — image picking, cropping (avatars / banners / icons) and uploading.
import { html, useState, useEffect, useRef, clamp } from '/js/lib.js';
import { state, openModal, closeModal } from '/js/store.js';
import { Modal, Btn, Slider, MODALS } from '/js/ui.js';
import { upload } from '/js/api.js';
import { Icon } from '/js/icons.js';

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
  const frameW = Math.min(360, innerWidth - 80); const frameH = Math.round(frameW / aspect);
  const [img, setImg] = useState(null); const [zoom, setZoom] = useState(1); const [pos, setPos] = useState({ x: 0, y: 0 }); const [busy, setBusy] = useState(false);
  const drag = useRef(null); const url = useRef(null);
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
    const c = document.createElement('canvas'); c.width = out; c.height = Math.round(out / aspect); const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, -pos.x / scale, -pos.y / scale, frameW / scale, frameH / scale, 0, 0, c.width, c.height);
    c.toBlob((b) => done(b), 'image/webp', 0.92);
  };
  const onDown = (e) => { drag.current = { sx: e.clientX, sy: e.clientY, p: pos }; e.currentTarget.setPointerCapture(e.pointerId); };
  const onMove = (e) => { if (!drag.current) return; setPos(limit({ x: drag.current.p.x + e.clientX - drag.current.sx, y: drag.current.p.y + e.clientY - drag.current.sy })); };
  const setZ = (z) => { const cx0 = frameW / 2; const cy0 = frameH / 2; const ratio = (base * z) / scale; setZoom(z); setPos(limit({ x: cx0 - (cx0 - pos.x) * ratio, y: cy0 - (cy0 - pos.y) * ratio }, z)); };
  return html`<${Modal} title=${title} width=${frameW + 60} onClose=${() => done(null)} footer=${html`<${Btn} variant="ghost" onClick=${() => done(null)}>Cancel<//><${Btn} variant="primary" loading=${busy} disabled=${!img} onClick=${apply}>Apply<//>`}>
    <div class=${`crop-frame ${round ? 'round' : ''}`} style=${{ width: frameW + 'px', height: frameH + 'px' }} onPointerDown=${onDown} onPointerMove=${onMove} onPointerUp=${() => (drag.current = null)} onWheel=${(e) => { e.preventDefault(); setZ(clamp(zoom - e.deltaY * 0.0015, 1, 4)); }}>
      ${img ? html`<img src=${url.current} draggable="false" alt="" style=${{ width: img.naturalWidth * scale + 'px', height: img.naturalHeight * scale + 'px', transform: `translate(${pos.x}px, ${pos.y}px)` }} />` : null}
      ${round ? html`<div class="crop-ring"></div>` : null}
    </div>
    <div class="crop-zoom"><${Icon} name="image" size=${16} /><${Slider} value=${zoom} min=${1} max=${4} step=${0.01} onChange=${setZ} format=${(v) => v.toFixed(1) + '×'} /><${Icon} name="image" size=${22} /></div>
  <//>`;
};

/** Pick, crop and upload an image; resolves with the uploaded URL (or undefined if cancelled). */
export async function chooseAndUploadImage(opts) {
  const file = await pickFile('image/png,image/jpeg,image/webp,image/gif');
  if (!file) return undefined;
  if (file.type === 'image/gif' && opts.allowGif && file.size < 8 * 1024 * 1024) { const r = await upload(file); return r.url; }
  const blob = await cropImage(file, opts);
  if (!blob) return undefined;
  const r = await upload(new File([blob], 'image.webp', { type: 'image/webp' }));
  return r.url;
}
/** Downloads a remote image through the server's image proxy and stores it as an upload; resolves with the new /uploads URL. */
export async function uploadGifFrom(url, name = 'image.gif') {
  if (!url) throw new Error('That GIF has no image to use');
  const r = await fetch('/api/img?url=' + encodeURIComponent(url));
  if (!r.ok) throw new Error('Could not download that GIF');
  const blob = await r.blob();
  if (blob.size > 8 * 1024 * 1024) throw new Error('That GIF is too large for an avatar (max 8 MB)');
  const res = await upload(new File([blob], name, { type: blob.type || 'image/gif' }));
  return res.url;
}
void state;
