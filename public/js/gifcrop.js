// Orata — crops an animated GIF in the browser: every frame is decoded (WebCodecs), the chosen part of it is drawn at the new size and a new GIF is written.
// That is what lets a GIF avatar, banner or icon be moved and zoomed in the crop dialog like any other picture.

export const canCropGif = () => typeof ImageDecoder === 'function';
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Median-cut palette over all frames: one 255-color palette (index 255 is kept for "see-through") and a lookup from 15-bit colors to palette indexes. */
function buildPalette(frames) {
  const hist = new Uint32Array(32768); let alpha = false;
  for (const f of frames) { const d = f.rgba; for (let p = 0; p < d.length; p += 4) { if (d[p + 3] < 128) { alpha = true; continue; } hist[((d[p] >> 3) << 10) | ((d[p + 1] >> 3) << 5) | (d[p + 2] >> 3)]++; } }
  const cols = []; for (let b = 0; b < 32768; b++) if (hist[b]) cols.push(b);
  const chan = (b, c) => (c === 0 ? b >> 10 : c === 1 ? (b >> 5) & 31 : b & 31);
  const weight = (bx) => { let n = 0; for (const b of bx) n += hist[b]; return n; };
  const boxes = cols.length ? [cols] : []; const weights = boxes.map(weight);
  while (boxes.length < 255) {
    let bi = -1; let best = 0;
    for (let i = 0; i < boxes.length; i++) if (boxes[i].length > 1 && weights[i] > best) { best = weights[i]; bi = i; }
    if (bi < 0) break;
    const bx = boxes[bi]; const lo = [31, 31, 31]; const hi = [0, 0, 0];
    for (const b of bx) for (let c = 0; c < 3; c++) { const v = chan(b, c); if (v < lo[c]) lo[c] = v; if (v > hi[c]) hi[c] = v; }
    const rng = hi.map((h, c) => h - lo[c]); const c = rng.indexOf(Math.max(...rng));
    bx.sort((a, b) => chan(a, c) - chan(b, c));
    let acc = 0; let cut = 1;
    for (let i = 0; i < bx.length - 1; i++) { acc += hist[bx[i]]; cut = i + 1; if (acc >= weights[bi] / 2) break; }
    const a = bx.slice(0, cut); const b = bx.slice(cut);
    boxes.splice(bi, 1, a, b); weights.splice(bi, 1, weight(a), weight(b));
  }
  const palette = new Uint8Array(768); const lut = new Uint8Array(32768);
  boxes.forEach((bx, i) => {
    let r = 0; let g = 0; let bl = 0; let n = 0;
    for (const b of bx) { const w = hist[b]; r += (b >> 10) * w; g += ((b >> 5) & 31) * w; bl += (b & 31) * w; n += w; lut[b] = i; }
    const e = (v) => { const q = Math.round(v / (n || 1)); return (q << 3) | (q >> 2); };
    palette[i * 3] = e(r); palette[i * 3 + 1] = e(g); palette[i * 3 + 2] = e(bl);
  });
  return { palette, lut, alpha };
}

/** GIF's variable-width LZW (after omggif's writer): returns the compressed bytes as GIF sub-blocks. */
function lzw(indices, minCode) {
  const out = []; let block = []; let cur = 0; let shift = 0;
  const clear = 1 << minCode; const eoi = clear + 1; let next = eoi + 1; let size = minCode + 1;
  const push = (byte) => { block.push(byte); if (block.length === 255) { out.push(255, ...block); block = []; } };
  const emit = (code) => { cur |= code << shift; shift += size; while (shift >= 8) { push(cur & 255); cur >>>= 8; shift -= 8; } };
  let table = new Map(); let ib = indices[0]; emit(clear);
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]; const key = (ib << 8) | k; const hit = table.get(key);
    if (hit === undefined) {
      emit(ib);
      if (next === 4096) { emit(clear); next = eoi + 1; size = minCode + 1; table = new Map(); }
      else { if (next >= (1 << size)) size++; table.set(key, next++); }
      ib = k;
    } else ib = hit;
  }
  emit(ib); emit(eoi); if (shift > 0) push(cur & 255);
  if (block.length) out.push(block.length, ...block);
  out.push(0);
  return out;
}

/** Writes frames ({ rgba, delay in 1/100 s }) as an animated GIF. */
export async function encodeGif(frames, w, h, onProgress) {
  const { palette, lut, alpha } = buildPalette(frames); const trans = 255;
  const bytes = [];
  const u16 = (n) => [n & 255, (n >> 8) & 255];
  bytes.push(...[0x47, 0x49, 0x46, 0x38, 0x39, 0x61], ...u16(w), ...u16(h), 0xf7, 0, 0);
  bytes.push(...palette);
  bytes.push(0x21, 0xff, 0x0b, ...[...'NETSCAPE2.0'].map((c) => c.charCodeAt(0)), 3, 1, 0, 0, 0);   // loop forever
  let prev = null; const chunks = [];
  for (let n = 0; n < frames.length; n++) {
    const d = frames[n].rgba; const idx = new Uint8Array(w * h);
    for (let p = 0, i = 0; p < d.length; p += 4, i++) idx[i] = d[p + 3] < 128 ? trans : lut[((d[p] >> 3) << 10) | ((d[p + 1] >> 3) << 5) | (d[p + 2] >> 3)];
    let body = idx;
    if (!alpha && prev) { body = idx.slice(); for (let i = 0; i < body.length; i++) if (idx[i] === prev[i]) body[i] = trans; }   // unchanged pixels stay see-through: far smaller files
    prev = idx;
    const head = [0x21, 0xf9, 4, ((alpha ? 2 : 1) << 2) | 1, ...u16(frames[n].delay), trans, 0, 0x2c, 0, 0, 0, 0, ...u16(w), ...u16(h), 0, 8];
    chunks.push(Uint8Array.from(head), Uint8Array.from(lzw(body, 8)));
    if (n % 3 === 0) { onProgress?.(0.5 + 0.5 * (n / frames.length)); await tick(); }
  }
  return new Blob([Uint8Array.from(bytes), ...chunks, Uint8Array.from([0x3b])], { type: 'image/gif' });
}

/**
 * Crops `file` (an animated GIF) to the rectangle (sx, sy, sw, sh) of the original and scales it to width × height.
 * Resolves with a GIF Blob, or null when the browser can't do it or the picture isn't animated (the caller then uses its normal still-picture path).
 */
export async function cropGif(file, { sx, sy, sw, sh, width, height, onProgress, maxBytes = 7.5 * 1024 * 1024 }) {
  if (!canCropGif()) return null;
  const dec = new ImageDecoder({ data: await file.arrayBuffer(), type: 'image/gif' });
  try {
    await dec.tracks.ready;
    const total = dec.tracks.selectedTrack.frameCount;
    if (!(total > 1)) return null;
    const keep = Math.max(2, Math.min(150, Math.floor(24e6 / (width * height))));   // a picture of this size gets at most this many frames
    const step = Math.max(1, Math.ceil(total / keep));
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.imageSmoothingQuality = 'high';
    let frames = [];
    for (let i = 0; i < total; i += step) {
      const { image } = await dec.decode({ frameIndex: i });
      const cs = image.duration ? Math.round(image.duration / 10000) : 10;
      ctx.clearRect(0, 0, width, height); ctx.drawImage(image, sx, sy, sw, sh, 0, 0, width, height); image.close();
      frames.push({ rgba: new Uint8ClampedArray(ctx.getImageData(0, 0, width, height).data), delay: Math.min(65535, Math.max(2, cs * step)) });
      if (frames.length % 4 === 0) { onProgress?.(0.5 * (i / total)); await tick(); }
    }
    let blob = await encodeGif(frames, width, height, onProgress);
    for (let tries = 0; blob.size > maxBytes && frames.length > 4 && tries < 3; tries++) {   // too big: drop every other frame (their time is added to the one kept)
      frames = frames.filter((_, i) => i % 2 === 0).map((f, i, all) => ({ ...f, delay: Math.min(65535, f.delay * 2) }));
      blob = await encodeGif(frames, width, height, onProgress);
    }
    onProgress?.(1);
    return blob;
  } finally { dec.close(); }
}
