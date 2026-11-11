// Orata — puts a custom cursor on screen (cursor-data.js says what one is; Settings → Theme chooses it). While it is on:
//  • the whole page gets it as its cursor (so every part that doesn't ask for something else shows it), drawn at the size you chose from the stored picture;
//  • anything that asks for the pointing hand (buttons, links, cards) gets the pointer picture — or the same cursor when there is no second picture;
//  • text boxes keep the text cursor, and resizing, dragging and "not allowed" keep theirs, because they say something the picture can't.
// Off (the default) nothing here touches the page: the browser's own cursor. A cursor that can't be loaded leaves the normal one.
import { state, subscribe } from '/js/store.js';
import { cursorLookOf, cursorBox } from '/js/cursor-data.js';

const root = document.documentElement;
const built = new Map();   // "picture|size|tipx|tipy" -> the CSS value (a data: picture, so it needs no request and works on every page)

function loadImage(url) {
  return new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = url; setTimeout(() => res(null), 8000); });
}
/** The CSS `cursor` value for one picture at `size`, with its tip at `hot` (fractions). Resolves null when the picture can't be read. */
export async function cursorCss(url, size, hot) {
  const key = `${url}|${size}|${hot?.x}|${hot?.y}`; if (built.has(key)) return built.get(key);
  const im = await loadImage(url); if (!im) return null;
  const box = cursorBox(im.naturalWidth || im.width, im.naturalHeight || im.height, size, hot);
  const cv = document.createElement('canvas'); cv.width = box.w; cv.height = box.h; const c = cv.getContext('2d');
  c.imageSmoothingQuality = 'high'; c.drawImage(im, 0, 0, box.w, box.h);
  let data; try { data = cv.toDataURL('image/png'); } catch { return null; }
  const css = (kind) => `url("${data}") ${box.x} ${box.y}, ${kind}`;
  const out = { arrow: css('default'), pointer: css('pointer') }; built.set(key, out); return out;
}

let active = null;   // { arrow, pointer } while a custom cursor is on
let sig = ''; let token = 0; let seen = null;
async function sync() {
  if (state.settings.cursor === seen) return; seen = state.settings.cursor;   // (the store changes all the time: only a change of the cursor setting matters here)
  const s = state.settings.cursor; const look = s?.on ? cursorLookOf(state.settings) : null;
  const next = look ? JSON.stringify(look) : '';
  if (next === sig) return; sig = next; const mine = ++token;
  if (!look) { active = null; root.style.removeProperty('cursor'); dropMarks(); return; }
  const [arrow, pointer] = await Promise.all([cursorCss(look.image, look.size, look.hot), look.pointer ? cursorCss(look.pointer, look.size, look.hotPointer) : null]);
  if (mine !== token) return;   // another cursor was chosen while this one loaded
  if (!arrow) { active = null; root.style.removeProperty('cursor'); return; }
  active = { arrow: arrow.arrow, pointer: (pointer || arrow).pointer };
  root.style.setProperty('cursor', active.arrow);
}

/* the pointing hand: whatever the page says is clickable gets the pointer picture while the pointer is over it */
const marked = new Map();   // element -> the cursor it had of its own inline
function dropMarks() { for (const [el, old] of marked) { if (old) el.style.setProperty('cursor', old); else el.style.removeProperty('cursor'); } marked.clear(); }
function over(e) {
  if (!active) return;
  const el = e.target; if (!(el instanceof Element) || marked.has(el)) return;
  if (getComputedStyle(el).cursor !== 'pointer') return;
  marked.set(el, el.style.getPropertyValue('cursor')); el.style.setProperty('cursor', active.pointer);
}
function out(e) {
  const el = e.target; if (!marked.has(el)) return;
  const old = marked.get(el); marked.delete(el); if (old) el.style.setProperty('cursor', old); else el.style.removeProperty('cursor');
}

export function initCursor() {
  document.addEventListener('pointerover', over, true); document.addEventListener('pointerout', out, true);
  window.addEventListener('blur', dropMarks);
  subscribe(sync); sync();
}
