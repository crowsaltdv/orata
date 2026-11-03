// Orata — the layout of the screen: where the server bar, the channel list, your profile bar and the members panel sit (settings.layout, the Layout page
// in Settings). The chat itself always takes what is left. A layout is part of a site theme, so the server checks it with the same code for every theme
// it is sent (theme-data.js), and the browser for every theme it applies. Pieces are never placed freely: each one sits on an edge (left, right, and for
// the server bar also top and bottom) and the screen is a grid, so pieces fit next to each other and can never cover one another.
// Like theme-data.js, no browser or server APIs in here on purpose.

/** The pieces of the screen that can move. */
export const BLOCKS = ['rail', 'sidebar', 'userbar', 'panel'];
export const BLOCK_NAMES = { rail: 'Server bar', sidebar: 'Channel list', userbar: 'Your profile and voice controls', panel: 'Members and info' };
/** The edges each piece can sit on, in the order "rotate" goes through them (clockwise). The channel list, profile bar and members panel are columns, so left or right;
 *  the server bar can also lie along the top or the bottom. */
export const DOCKS = { rail: ['left', 'top', 'right', 'bottom'], sidebar: ['left', 'right'], userbar: ['left', 'right'], panel: ['left', 'right'] };
export const DEFAULT_LAYOUT = { rail: 'left', sidebar: 'left', userbar: 'left', panel: 'right', order: ['rail', 'sidebar', 'userbar', 'panel'] };
/** The side of a piece a tooltip opens on, when the piece sits on `dock` (away from the edge, towards the middle of the screen). */
export const TIP_SIDE = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
/** The width of the screen up to which the layout is the phone one (a drawer): the layout settings don't apply there. */
export const PHONE_MAX = 780;

/** A layout from anything: only the valid parts, as { rail, sidebar, userbar, panel, order } (what isn't valid is left out). Null when nothing in it is valid.
 *  `order` is every piece once, in the order given (a piece left out goes to the end). */
export function cleanLayout(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const b of BLOCKS) if (DOCKS[b].includes(raw[b])) out[b] = raw[b];
  if (Array.isArray(raw.order)) {
    const seen = []; for (const id of raw.order) if (BLOCKS.includes(id) && !seen.includes(id)) seen.push(id);
    if (seen.length) out.order = [...seen, ...DEFAULT_LAYOUT.order.filter((b) => !seen.includes(b))];
  }
  return Object.keys(out).length ? out : null;
}
/** A whole, valid layout: the valid parts of `raw`, and the rest as in the default layout. */
export const fullLayout = (raw) => ({ ...DEFAULT_LAYOUT, order: [...DEFAULT_LAYOUT.order], ...(cleanLayout(raw) || {}) });
export const sameLayout = (a, b) => JSON.stringify(fullLayout(a)) === JSON.stringify(fullLayout(b));
export const isDefaultLayout = (raw) => sameLayout(raw, DEFAULT_LAYOUT);

/** The columns on an edge, in the order they come in (the profile bar is not one: it sits under the columns of its edge). */
const columnsOn = (L, dock) => L.order.filter((b) => b !== 'userbar' && L[b] === dock);

/** Moves a piece to an edge (if it may sit there). `before` / `after`: a piece to go next to; with neither it goes to the outer end of that edge
 *  (the far left, the far right, the very top or bottom). Resolves the whole new layout. */
export function moveBlock(raw, id, dock, { before = null, after = null } = {}) {
  const L = fullLayout(raw); if (!BLOCKS.includes(id) || !DOCKS[id].includes(dock)) return L;
  const order = L.order.filter((b) => b !== id);
  const mates = order.filter((b) => b !== 'userbar' && L[b] === dock);
  let at;
  if (before && order.includes(before)) at = order.indexOf(before);
  else if (after && order.includes(after)) at = order.indexOf(after) + 1;
  else if (dock === 'left' || dock === 'top') at = mates.length ? order.indexOf(mates[0]) : order.length;
  else at = mates.length ? order.indexOf(mates[mates.length - 1]) + 1 : order.length;
  order.splice(at, 0, id);
  return { ...L, [id]: dock, order };
}
/** Turns a piece to the next edge it may sit on (the server bar: left, top, right, bottom, left …; the others: left and right). */
export function rotateBlock(raw, id) {
  const L = fullLayout(raw); const list = DOCKS[id]; if (!list) return L;
  return moveBlock(L, id, list[(list.indexOf(L[id]) + 1) % list.length]);
}
/** Swaps a column with its neighbour on the same edge: dir -1 = one place earlier (further left), 1 = later. */
export function shiftBlock(raw, id, dir) {
  const L = fullLayout(raw); if (!BLOCKS.includes(id) || id === 'userbar') return L;
  const mates = columnsOn(L, L[id]); const i = mates.indexOf(id); const j = i + dir;
  if (i < 0 || j < 0 || j >= mates.length) return L;
  const order = L.order.filter((b) => b !== id);
  order.splice(order.indexOf(mates[j]) + (dir > 0 ? 1 : 0), 0, id);
  return { ...L, order };
}
/** Can a piece move a place earlier / later on its edge? */
export const canShift = (raw, id, dir) => { const L = fullLayout(raw); if (id === 'userbar') return false; const m = columnsOn(L, L[id]); const j = m.indexOf(id) + dir; return j >= 0 && j < m.length; };

/** What is on each edge, as the screen shows it (the editor's picture and the real screen use the same): { left, right, top, bottom } lists of piece names, outermost first. */
export function edgesOf(raw, { panel = true } = {}) {
  const L = fullLayout(raw); const cols = (d) => columnsOn(L, d).filter((b) => panel || b !== 'panel');
  return { left: cols('left'), right: cols('right'), top: L.rail === 'top' ? ['rail'] : [], bottom: L.rail === 'bottom' ? ['rail'] : [], userbar: L.userbar };
}

/** The pixel sizes of the real screen's columns and rows (CSS values). */
export const REAL_SIZES = { rail: '74px', sidebar: 'var(--sidebar-w, 248px)', panel: 'auto', userbar: 'var(--sidebar-w, 248px)', railRow: 'auto', userbarRow: 'auto' };

/** The CSS grid the screen is built on: `columns`, `rows` and `areas` (grid-template-columns / -rows / -areas); every piece takes the area named after it ('rail',
 *  'sidebar', 'userbar', 'panel', and 'main' for the chat), so two can never share a spot. `panel: false` leaves the members panel out (nothing to show right now).
 *  The profile bar sits under the columns of its edge; on an edge with no column it makes one of its own. */
export function gridPlan(raw, { panel = true, sizes = REAL_SIZES } = {}) {
  const L = fullLayout(raw);
  const left = columnsOn(L, 'left').filter((b) => panel || b !== 'panel'); const right = columnsOn(L, 'right').filter((b) => panel || b !== 'panel');
  const bar = L.userbar; const alone = bar === 'left' ? !left.length : !right.length;
  const colsL = alone && bar === 'left' ? ['userbar'] : left; const colsR = alone && bar === 'right' ? ['userbar'] : right;
  const cols = [...colsL, 'main', ...colsR];
  const under = (c) => !alone && (bar === 'left' ? colsL : colsR).includes(c);
  const rows = []; const areas = [];
  if (L.rail === 'top') { rows.push(sizes.railRow); areas.push(cols.map(() => 'rail')); }
  rows.push('minmax(0, 1fr)'); areas.push([...cols]);
  if (!alone) { rows.push(sizes.userbarRow); areas.push(cols.map((c) => (under(c) ? 'userbar' : c))); }
  if (L.rail === 'bottom') { rows.push(sizes.railRow); areas.push(cols.map(() => 'rail')); }
  return { columns: cols.map((c) => (c === 'main' ? 'minmax(0, 1fr)' : sizes[c])).join(' '), rows: rows.join(' '), areas: areas.map((r) => `"${r.join(' ')}"`).join(' '), layout: L, alone };
}
