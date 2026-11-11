// Orata — drag a server or a folder around the server bar, the same way channels are dragged in the channel list (channel-dnd.js): press, move a few pixels and a lifted
// copy follows the pointer (and swings as you move it: drag-ghost.js), the real one turns into an empty slot, the others slide out of the way as you cross them, and letting
// go drops it where the slot is. Esc, or letting go away from the bar, puts it back. Over the middle of another server it doesn't reorder: that server lights up and
// dropping makes a folder with the two (over a folder: puts it in). It works along the bar whichever edge the bar is on (left, right, top or bottom).
// rail.js gives the controller the layout (`applyDrop` says what a drop does to it) and what to call to save; it shows `preview` while a drag is going on.
import { useState, useRef, useLayoutEffect, useEffect } from '/js/lib.js';
import { createGhost } from '/js/drag-ghost.js';

const THRESHOLD = 5;   // px of travel before a press becomes a drag, so a plain click still opens the server
const SLIDE = 220;     // ms for the others to slide aside
const motion = () => { const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--m')); return Number.isFinite(v) ? v : 1; };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/** A layout as text, to tell whether two are the same arrangement. */
const keyOf = (layout) => layout.map((x) => (x.kind === 'folder' ? `${x.id}[${x.servers.join(',')}]` : x.id)).join('|');
const MERGE_FROM = 0.27; const MERGE_TO = 0.73;   // the middle of a server (along the bar) is "put it with this one"

function createController(root, ui) {
  const c = { deps: null, active: null, pending: null, pointer: { x: 0, y: 0 }, ghost: null, raf: 0, flip: null, after: null, landing: false, base: null, preview: null, merge: null, target: null, zone: null, scroll: 0 };
  const horizontal = () => !!c.deps?.horizontal;

  /** Where every server and folder head is right now, so the next render can slide them from there to their new spots. */
  function snapshot() {
    c.flip = new Map();
    for (const el of root.current?.querySelectorAll('[data-flip]') || []) { const r = el.getBoundingClientRect(); c.flip.set(el.dataset.flip, { x: r.left, y: r.top }); }
  }
  c.afterRender = () => {
    const was = c.flip; c.flip = null;
    if (was && root.current) {
      const ms = SLIDE * motion();
      if (ms > 10) for (const el of root.current.querySelectorAll('[data-flip]')) {
        const from = was.get(el.dataset.flip); if (!from) continue;
        const r = el.getBoundingClientRect(); const dx = from.x - r.left; const dy = from.y - r.top;
        if (Math.abs(dx) + Math.abs(dy) > 1) el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: ms, easing: 'cubic-bezier(.2,.8,.2,1)' });
      }
    }
    const after = c.after; c.after = null; after?.();
  };

  const rowOf = (a) => root.current?.querySelector(`[data-rail="${a.kind}:${a.id}"]`);
  const setPreview = (layout) => { c.preview = layout; ui.setPreview(layout); };
  const setMerge = (m) => { const same = (c.merge?.id === m?.id && c.merge?.kind === m?.kind); if (same) return; c.merge = m; ui.setMerge(m); };

  /** The servers and folders the dragged one could go next to or onto, in the order they are on screen, with where each is. */
  function candidates() {
    const r = root.current; const a = c.active; const out = [];
    if (a.kind === 'folder') {   // a folder only moves between the top-level entries of the bar
      for (const el of r.querySelectorAll(':scope > [data-rail]')) { const [kind, id] = el.dataset.rail.split(':'); if (kind === 'folder' && id === a.id) continue; out.push({ el, kind, id, folderId: null, rect: el.getBoundingClientRect() }); }
    } else {
      for (const el of r.querySelectorAll('[data-rail]')) {
        const [kind, id] = el.dataset.rail.split(':'); if (kind === 'server' && id === a.id) continue;
        if (kind === 'folder') out.push({ el, kind, id, folderId: null, rect: (el.querySelector(':scope > .folder-head') || el).getBoundingClientRect() });
        else out.push({ el, kind, id, folderId: el.dataset.folder || null, rect: el.getBoundingClientRect() });
      }
    }
    return out;
  }

  /** What the pointer is over: { cand, zone } ('before', 'after' or 'merge'), or null when it is not near the bar. */
  function locate() {
    const r = root.current; const a = c.active; if (!r || !a) return null;
    const h = horizontal(); const box = r.getBoundingClientRect(); const { x, y } = c.pointer;
    const cross = h ? y : x; if (cross < (h ? box.top : box.left) - 110 || cross > (h ? box.bottom : box.right) + 110) return null;   // away from the bar: not a drop
    const pos = h ? x : y; let best = null;
    for (const cand of candidates()) { const lo = h ? cand.rect.left : cand.rect.top; const hi = h ? cand.rect.right : cand.rect.bottom; const d = pos < lo ? lo - pos : pos > hi ? pos - hi : 0; if (!best || d < best.d) best = { cand, d, lo, hi }; }
    if (!best) return null;
    const { cand, lo, hi } = best; const ratio = clamp((pos - lo) / Math.max(1, hi - lo), 0, 1);
    const canMerge = a.kind === 'server' && !cand.folderId;
    let zone;
    if (canMerge && cand.kind === 'folder' && cand.el.classList.contains('open')) zone = ratio < MERGE_FROM ? 'before' : 'merge';   // an open folder: lower than its top edge is "into it"
    else if (canMerge && ratio > MERGE_FROM && ratio < MERGE_TO) zone = 'merge';
    else zone = ratio < 0.5 ? 'before' : 'after';
    return { cand, zone };
  }

  /** Works out where the dragged one would go if it were dropped now, and rearranges the preview to match. */
  function retarget() {
    const a = c.active; const dep = c.deps; if (!a || !dep) return;
    const hit = locate();
    c.target = hit ? { kind: hit.cand.kind, id: hit.cand.id, folderId: hit.cand.folderId } : null; c.zone = hit ? hit.zone : null;
    if (!hit) { setMerge(null); if (keyOf(c.preview) !== keyOf(c.base)) { snapshot(); setPreview(c.base); } return; }   // away from the bar: everything goes back
    if (hit.zone === 'merge') { setMerge({ kind: hit.cand.kind, id: hit.cand.id }); return; }   // the one under the pointer lights up; nothing moves
    setMerge(null);
    const next = dep.applyDrop(c.base, { kind: a.kind, id: a.id, folderId: a.folderId }, c.target, hit.zone);
    if (keyOf(next) !== keyOf(c.preview)) { snapshot(); setPreview(next); }
  }

  const place = () => { if (c.ghost && c.active) c.ghost.move(c.pointer.x, c.pointer.y); };

  /** Scrolls the bar when the pointer is held near its start or end edge. */
  function tick() {
    const r = root.current; if (!r || !c.active) return;
    const h = horizontal(); const b = r.getBoundingClientRect(); const edge = 56; const pos = h ? c.pointer.x : c.pointer.y; const lo = h ? b.left : b.top; const hi = h ? b.right : b.bottom;
    const v = pos < lo + edge ? -(1 - Math.max(0, pos - lo) / edge) : pos > hi - edge ? 1 - Math.max(0, hi - pos) / edge : 0;
    if (v) { if (h) r.scrollLeft += v * 14; else r.scrollTop += v * 14; }
    const now = h ? r.scrollLeft : r.scrollTop; if (now !== c.scroll) { c.scroll = now; retarget(); }   // it moved under the pointer (autoscroll or the wheel)
    c.raf = requestAnimationFrame(tick);
  }

  function begin() {
    const p = c.pending; c.pending = null; const dep = c.deps;
    const rect = p.el.getBoundingClientRect();
    c.active = { kind: p.kind, id: p.id, folderId: p.folderId || null, dx: p.x - rect.left, dy: p.y - rect.top };
    c.base = dep.layout; c.preview = dep.layout; c.merge = null; c.target = null; c.zone = null;
    c.ghost = createGhost(p.el, { x: p.x, y: p.y, dx: c.active.dx, dy: c.active.dy, className: 'rail-ghost', grow: 1.12 });
    document.body.classList.add('dnd-active');
    c.scroll = horizontal() ? (root.current?.scrollLeft || 0) : (root.current?.scrollTop || 0); c.raf = requestAnimationFrame(tick);
    ui.setDrag({ kind: p.kind, id: p.id });
  }

  function move(e) {
    if (e.pointerType === 'mouse' && !(e.buttons & 1)) return cancel();   // the button came up where we could not see it
    c.pointer = { x: e.clientX, y: e.clientY };
    if (c.pending) { if (Math.hypot(e.clientX - c.pending.x, e.clientY - c.pending.y) < THRESHOLD) return; begin(); }
    if (c.active) { place(); retarget(); }
  }
  function up() {
    listen(false);
    if (c.pending) { c.pending = null; return; }   // it was only a click
    if (!c.active) return;
    const stop = (e) => { e.stopPropagation(); e.preventDefault(); };   // the click that follows a drop must not open the server
    window.addEventListener('click', stop, true); setTimeout(() => window.removeEventListener('click', stop, true), 0);
    finish(false);
  }
  function cancel() {
    listen(false);
    if (c.pending) { c.pending = null; return; }
    if (c.active) finish(true);
  }
  function key(e) { if (e.key === 'Escape' && c.active) { e.preventDefault(); e.stopPropagation(); cancel(); } }
  const events = () => [['pointermove', move], ['pointerup', up], ['pointercancel', cancel], ['keydown', key, true], ['blur', cancel]];
  function listen(on) { for (const [name, fn, capture] of events()) window[on ? 'addEventListener' : 'removeEventListener'](name, fn, capture); }

  function finish(abort) {
    const a = c.active; c.active = null; c.landing = true; cancelAnimationFrame(c.raf);
    const dep = c.deps; let final = null;
    if (!abort && c.target && c.zone) final = dep.applyDrop(c.base, { kind: a.kind, id: a.id, folderId: a.folderId }, c.target, c.zone);
    const changed = !!final && keyOf(final) !== keyOf(c.base);
    const target = c.target; const merged = c.zone === 'merge';
    setMerge(null);
    // the copy lands once the list has been drawn the way it ends up (after the render, or on the next frame when nothing needs drawing)
    const settle = (fn, redraw) => { c.after = fn; if (!redraw) requestAnimationFrame(() => { const f = c.after; if (f) { c.after = null; f(); } }); };
    if (!changed) {   // nothing to change (or Esc): everything slides back, then the copy settles into the old place
      const redraw = keyOf(c.preview) !== keyOf(c.base); if (redraw) { snapshot(); setPreview(c.base); }
      settle(() => land(a, null), redraw); return;
    }
    const redraw = keyOf(final) !== keyOf(c.preview); if (redraw) { snapshot(); setPreview(final); }   // (dropped on a server or a folder: it joins it now)
    dep.save(final);
    const fallback = merged && target ? rowOf(target)?.getBoundingClientRect() : null;   // (where it lands when it is inside a folder that is shut: on the folder)
    settle(() => land(a, fallback), redraw);
  }

  /** The copy glides into the slot it was dropped on (or fades out on `fallback` when the slot is out of sight), then the real one takes over. */
  function land(a, fallback) {
    const g = c.ghost; const row = rowOf(a); row?.getAnimations().forEach((x) => x.cancel());   // measure the slot where it really is, not mid-slide
    let to = row?.getBoundingClientRect(); let hidden = false; const ms = 240 * motion();
    if (!to && fallback) { to = fallback; hidden = true; }
    g?.land(to || null, { hidden: hidden || !to, ms });
    setTimeout(() => { g?.destroy(); c.ghost = null; c.landing = false; document.body.classList.remove('dnd-active'); ui.setPreview(null); ui.setDrag(null); ui.setMerge(null); }, ms + 20);
  }

  /** A press on a server or folder: `d` = { kind, id, folderId }, `el` = what to copy (the server's button, or the whole folder). */
  c.down = (e, d, el) => {
    if (c.active || c.landing || c.pending || e.button !== 0 || e.pointerType === 'touch') return;
    c.pending = { ...d, el: el || e.currentTarget, x: e.clientX, y: e.clientY }; c.pointer = { x: e.clientX, y: e.clientY };
    listen(true);
  };
  c.destroy = () => { listen(false); cancelAnimationFrame(c.raf); c.ghost?.destroy(); document.body.classList.remove('dnd-active'); };
  return c;
}

/** `deps` = { layout, horizontal, applyDrop(layout, drag, target, zone), save(layout) }. `root` goes on the bar; servers and folders get `data-rail` ("server:id" / "folder:id"),
 *  `data-folder` (the folder a server is in) and `data-flip` (their own key), and call `down(event, { kind, id, folderId }, element)` on pointer-down. */
export function useRailDnd(deps) {
  const [preview, setPreview] = useState(null); const [drag, setDrag] = useState(null); const [merge, setMerge] = useState(null);
  const root = useRef(null); const ctl = useRef(null);
  if (!ctl.current) ctl.current = createController(root, { setPreview, setDrag, setMerge });
  const c = ctl.current; c.deps = deps;
  useLayoutEffect(() => c.afterRender());
  useEffect(() => () => c.destroy(), []);
  return { root, preview, drag, merge, down: c.down };
}
