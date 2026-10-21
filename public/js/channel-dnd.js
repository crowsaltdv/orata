// Orata — drag a channel (or a category) up and down the sidebar to reorder it. Press, move a few pixels and a lifted copy follows the pointer,
// the real row turns into an empty slot, and the other rows slide out of the way as you cross them. Let go to drop; Esc puts it back.
import { useState, useRef, useLayoutEffect, useEffect } from '/js/lib.js';
import { state, set, rebuildIndex } from '/js/store.js';
import { api } from '/js/api.js';
import { act } from '/js/actions.js';
import { buildLayout, moveChannel, moveCategory, layoutChanges, applyChanges } from '/js/channel-order.js';

const THRESHOLD = 5;   // px of travel before a press becomes a drag, so a plain click still opens the channel
const SLIDE = 220;     // ms for the other rows to slide aside
const motion = () => { const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--m')); return Number.isFinite(v) ? v : 1; };   // the app's own speed / reduced-motion multiplier

function createController(root, setLayoutState, setDragState) {
  const c = { server: null, enabled: false, layout: null, active: null, pending: null, pointer: { x: 0, y: 0 }, tops: null, after: null, ghost: null, raf: 0, scrollTop: 0, landing: false };
  const setLayout = (layout) => { c.layout = layout; setLayoutState(layout); };

  /** Where every row is right now, so the next render can slide them from there to their new spots. */
  function snapshot() {
    c.tops = new Map();
    for (const el of root.current?.querySelectorAll('[data-dnd]') || []) c.tops.set(el.dataset.dnd, el.getBoundingClientRect().top);
  }
  c.afterRender = () => {
    const tops = c.tops; c.tops = null;
    if (tops && root.current) {
      const ms = SLIDE * motion();
      if (ms > 10) for (const el of root.current.querySelectorAll('[data-dnd]')) {
        const was = tops.get(el.dataset.dnd); if (was === undefined) continue;
        const dy = was - el.getBoundingClientRect().top;
        if (Math.abs(dy) > 1) el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: ms, easing: 'cubic-bezier(.2,.8,.2,1)' });
      }
    }
    const after = c.after; c.after = null; after?.();
  };

  const rowOf = (id) => root.current?.querySelector(`[data-dnd="${id}"]`);
  const slotOf = (el, kind) => (kind === 'channel' ? el.firstElementChild : el);   // a channel's wrapper also holds the people in its voice room

  /** Works out where the dragged row would go if it were dropped at the pointer, and rearranges the preview to match. */
  function retarget() {
    const a = c.active; const r = root.current; const lay = c.layout; if (!a || !r || !lay) return;
    const y = c.pointer.y; const above = (el) => { const b = slotOf(el, el.dataset.kind).getBoundingClientRect(); return y < b.top + b.height / 2; };
    let next;
    if (a.kind === 'category') {
      const heads = [...r.querySelectorAll('.cat-head[data-dnd]')].filter((el) => el.dataset.dnd !== a.id);
      const i = heads.findIndex(above);
      next = moveCategory(lay, a.id, i < 0 ? heads.length : i);
    } else {
      // the first visible row whose middle is below the pointer is the one we go in front of; a category's name counts as "the end of the group above it"
      const rows = [...r.querySelectorAll('[data-dnd]')].filter((el) => el.dataset.dnd !== a.id && !el.closest('.ch-list.collapsed'));
      const row = rows.find(above); const rest = (g) => g.ids.filter((x) => x !== a.id);
      let to; let index;
      if (!row) { to = lay[lay.length - 1]; index = rest(to).length; }
      else if (row.dataset.kind === 'category') { to = lay[Math.max(0, lay.findIndex((g) => g.catId === row.dataset.dnd) - 1)]; index = rest(to).length; }
      else { to = lay.find((g) => g.ids.includes(row.dataset.dnd)); index = to ? rest(to).indexOf(row.dataset.dnd) : 0; }
      next = to ? moveChannel(lay, a.id, to.catId, index) : lay;
    }
    if (next !== lay) { snapshot(); setLayout(next); }
  }

  const place = () => { const a = c.active; if (c.ghost && a) c.ghost.style.transform = `translate3d(${c.pointer.x - a.dx}px, ${c.pointer.y - a.dy}px, 0)`; };

  /** Scrolls the list when the pointer is held near its top or bottom edge. */
  function tick() {
    const r = root.current; if (!r || !c.active) return;
    const b = r.getBoundingClientRect(); const { x, y } = c.pointer; const edge = 56;
    if (x > b.left - 60 && x < b.right + 60) {
      const v = y < b.top + edge ? -(1 - Math.max(0, y - b.top) / edge) : y > b.bottom - edge ? 1 - Math.max(0, b.bottom - y) / edge : 0;
      if (v) r.scrollTop += v * 14;
    }
    if (r.scrollTop !== c.scrollTop) { c.scrollTop = r.scrollTop; retarget(); }   // it moved under the pointer (autoscroll or the wheel)
    c.raf = requestAnimationFrame(tick);
  }

  function begin() {
    const p = c.pending; c.pending = null;
    const rect = p.el.getBoundingClientRect();
    c.active = { kind: p.kind, id: p.id, dx: p.x - rect.left, dy: p.y - rect.top };
    const g = p.el.cloneNode(true);
    g.removeAttribute('data-dnd'); g.removeAttribute('tabindex'); g.removeAttribute('role'); g.setAttribute('aria-hidden', 'true');
    g.classList.add('dnd-ghost'); g.style.width = `${rect.width}px`; g.style.height = `${rect.height}px`;
    c.ghost = g; place(); document.body.appendChild(g);
    void g.offsetWidth; g.classList.add('lifted');   // lift off: it grows a little and tilts
    document.body.classList.add('dnd-active');
    c.scrollTop = root.current?.scrollTop || 0; c.raf = requestAnimationFrame(tick);
    snapshot(); setLayout(buildLayout(c.server.channels)); setDragState({ kind: p.kind, id: p.id });
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
    const stop = (e) => { e.stopPropagation(); e.preventDefault(); };   // the click that follows a drop must not open the channel
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
    if (abort) { c.after = () => land(a); snapshot(); setLayout(null); }   // everything slides back, then the copy settles into its old place
    else { const layout = c.layout; land(a); commit(layout); }
  }

  /** The copy glides into the slot it was dropped on (or into the category's name if the slot is hidden in a collapsed category), then the real row takes over. */
  function land(a) {
    const g = c.ghost; const row = rowOf(a.id); row?.getAnimations().forEach((x) => x.cancel());   // measure the slot where it really is, not mid-slide
    let slot = row && slotOf(row, a.kind); let hidden = false;
    const list = slot?.closest('.ch-list.collapsed');
    if (list) { slot = list.previousElementSibling; hidden = true; }
    const r = slot?.getBoundingClientRect();
    if (g) {
      g.classList.remove('lifted'); g.classList.add('landing');
      if (r) g.style.transform = `translate3d(${r.left}px, ${r.top}px, 0)`;
      if (hidden || !r) g.style.opacity = '0';
    }
    setTimeout(() => { g?.remove(); c.ghost = null; c.landing = false; document.body.classList.remove('dnd-active'); setLayout(null); setDragState(null); }, 240 * motion() + 20);
  }

  /** Shows the new order at once and tells the server; if it refuses, puts the old order back. */
  async function commit(layout) {
    const id = c.server.id; const prev = state.servers[id]; const items = layoutChanges(layout, c.server.channels);
    if (!prev || !items.length) return;
    const channels = applyChanges(prev.channels, items);
    set({ servers: { ...state.servers, [id]: { ...prev, channels } } }); rebuildIndex();
    const done = await act(api.put(`/servers/${id}/channel-order`, { items }));
    const now = state.servers[id];
    if (!done && now?.channels === channels) { snapshot(); set({ servers: { ...state.servers, [id]: { ...now, channels: prev.channels } } }); rebuildIndex(); }
  }

  c.down = (e, kind, id) => {
    if (!c.enabled || c.active || c.landing || c.pending || e.button !== 0 || e.pointerType === 'touch') return;
    if (e.target.closest?.('.ch-actions, .cat-add')) return;   // the little buttons on a row are not handles
    c.pending = { kind, id, el: e.currentTarget, x: e.clientX, y: e.clientY }; c.pointer = { x: e.clientX, y: e.clientY };
    listen(true);
  };
  c.destroy = () => { listen(false); cancelAnimationFrame(c.raf); c.ghost?.remove(); document.body.classList.remove('dnd-active'); };
  return c;
}

/** `root` goes on the scrolling list; rows get `data-dnd` / `data-kind` and call `down(event, kind, id)` on pointer-down. `layout` is the live preview while dragging (null otherwise). */
export function useChannelDnd(server, enabled) {
  const [layout, setLayout] = useState(null);
  const [drag, setDrag] = useState(null);   // { kind: 'channel' | 'category', id }
  const root = useRef(null); const ctl = useRef(null);
  if (!ctl.current) ctl.current = createController(root, setLayout, setDrag);
  const c = ctl.current; c.server = server; c.enabled = enabled;
  useLayoutEffect(() => c.afterRender());
  useEffect(() => () => c.destroy(), []);
  return { root, layout, drag, enabled, down: c.down };
}
