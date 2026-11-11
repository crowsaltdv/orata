// Orata — custom cursors: what one is made of, and the one function that checks it. Settings → Theme holds yours (settings.cursor); a cursor can also be saved to the theme
// library and sent to Discovery's Cursors tab (theme kind 'cursor', public/js/theme-data.js, server/themes.js). The server runs sanitizeCursor() on every cursor it is sent and
// the browser on every one it applies, so both always agree. Like profile-data.js, no browser or server APIs in here on purpose.
//
// A cursor is a picture (PNG, at most 64 pixels on its longer side: Orata makes it so on upload, and the server again when a cursor is saved), where in the picture the tip is
// (`hot`, as fractions of its width and height: 0,0 is the top left corner), an optional second picture for the pointer over buttons and links (`pointer`, with its own tip),
// and how big it is drawn (`size`, the longer side in pixels). The normal cursor stays the normal one until you switch a custom one on (`on`).

export const CURSOR_SIZES = [[24, 'Small'], [32, 'Medium'], [48, 'Large'], [64, 'Huge']];
export const CURSOR_MAX_PX = 64;   // what is kept: a cursor is never drawn bigger (browsers ignore cursor pictures over 128)
export const DEFAULT_CURSOR = { on: false, image: null, pointer: null, size: 32, hot: { x: 0, y: 0 }, hotPointer: { x: 0.3, y: 0.05 } };

const UPLOAD = /^\/uploads\/([A-Za-z0-9_][A-Za-z0-9_.-]{0,119})$/;   // always one of this server's own uploads: a link to anywhere else would let its owner watch who has the cursor
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const frac = (v, fallback) => { const n = Number(v); return Number.isFinite(n) ? Math.round(Math.min(1, Math.max(0, n)) * 100) / 100 : fallback; };
const spot = (v, fallback) => (isObj(v) ? { x: frac(v.x, fallback.x), y: frac(v.y, fallback.y) } : { ...fallback });
const upload = (v) => (typeof v === 'string' && UPLOAD.test(v) ? v : null);

/** A clean cursor look from anything: { image, pointer, size, hot, hotPointer }, or null when there is no usable picture in it. (Whether it is switched on is `on` in the settings, not part of the look.) */
export function sanitizeCursor(data) {
  if (!isObj(data)) return null;
  const image = upload(data.image); if (!image) return null;
  const size = Number(data.size); const sizes = CURSOR_SIZES.map((s) => s[0]);
  return { image, pointer: upload(data.pointer), size: sizes.includes(size) ? size : DEFAULT_CURSOR.size, hot: spot(data.hot, DEFAULT_CURSOR.hot), hotPointer: spot(data.hotPointer, DEFAULT_CURSOR.hotPointer) };
}
/** The cursor look your settings make right now (null when none is chosen). */
export const cursorLookOf = (settings) => sanitizeCursor(settings?.cursor);
/** Is `data` (a theme's cursor) the same cursor as the settings' one? */
export const sameCursor = (a, b) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b);

/** Where a picture of `w`×`h` pixels is drawn at `size` (its longer side), and where its tip is in pixels: { w, h, x, y }. */
export function cursorBox(w, h, size, hot) {
  const k = size / Math.max(1, w, h); const cw = Math.max(1, Math.round(w * k)); const ch = Math.max(1, Math.round(h * k));
  return { w: cw, h: ch, x: Math.min(cw - 1, Math.round((hot?.x ?? 0) * cw)), y: Math.min(ch - 1, Math.round((hot?.y ?? 0) * ch)) };
}
