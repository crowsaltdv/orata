// Orate — renders the current wallpaper (image / gradient / solid) into a canvas of any size, cover-fitted with the
// user's zoom + position, brightness and saturation. Shared by the rain effect and the liquid-glass lenses.

export function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; }

function coverRect(iw, ih, W, H, bg) {
  const zoom = bg.zoom || 1; const ir = iw / ih; const cr = W / H; let sw; let sh;
  if (ir > cr) { sh = ih / zoom; sw = sh * cr; } else { sw = iw / zoom; sh = sw / cr; }
  return [(iw - sw) * (bg.posX / 100), (ih - sh) * (bg.posY / 100), sw, sh];
}

/**
 * @param {{type:'image', img:HTMLImageElement}|{type:'draw', draw:(ctx,w,h)=>void}} source
 * @param {object} bg  settings.bg (zoom, posX, posY, brightness, saturate)
 * @param {{blur?: number}} opts  blur radius in canvas pixels
 */
export function wallpaperCanvas(source, bg, W, H, { blur = 0 } = {}) {
  const out = makeCanvas(W, H); const ctx = out.getContext('2d');
  ctx.fillStyle = '#0b0a14'; ctx.fillRect(0, 0, W, H);
  const hasFilter = 'filter' in ctx;
  const tone = `brightness(${bg.brightness}) saturate(${bg.saturate})`;
  let src = null;
  if (source.type === 'image' && source.img) src = source.img;
  else if (source.type === 'draw') { const t = makeCanvas(W, H); source.draw(t.getContext('2d'), t.width, t.height); src = t; }
  if (!src) return out;
  const iw = src.naturalWidth || src.width; const ih = src.naturalHeight || src.height;
  const [sx, sy, sw, sh] = source.type === 'image' ? coverRect(iw, ih, W, H, bg) : [0, 0, iw, ih];
  const pad = blur ? Math.ceil(blur * 2) : 0;            // overscan so a blurred edge never fades to transparent
  const dx = -pad;
  if (hasFilter) {
    ctx.filter = `${tone}${blur ? ` blur(${blur}px)` : ''}`;
    ctx.drawImage(src, sx, sy, sw, sh, dx, dx, W + pad * 2, H + pad * 2);
    ctx.filter = 'none';
  } else {
    // no ctx.filter (older Safari): downscale/upscale approximates a blur; tone is skipped
    if (blur) { const k = Math.max(0.02, 1 / (1 + blur)); const t = makeCanvas(W * k, H * k); const tc = t.getContext('2d'); tc.drawImage(src, sx, sy, sw, sh, 0, 0, t.width, t.height); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(t, 0, 0, W, H); }
    else ctx.drawImage(src, sx, sy, sw, sh, 0, 0, W, H);
  }
  return out;
}
