// Orata self-test for the screen layout (public/js/layout-data.js, Settings → Layout): checking a layout, moving / rotating / shifting a piece, and the grid the screen is
// built on, including that no two pieces can ever share a spot, whichever way the pieces are arranged. No server needed.  Runs with the other suites:  npm test
import { BLOCKS, DOCKS, DEFAULT_LAYOUT, cleanLayout, fullLayout, isDefaultLayout, moveBlock, rotateBlock, shiftBlock, canShift, gridPlan, edgesOf } from '../public/js/layout-data.js';
import { sanitizeSiteLook, siteLookOf, SITE_SECTIONS } from '../public/js/theme-data.js';
import { DEFAULT_SETTINGS } from '../public/js/defaults.js';

let pass = 0; let fail = 0;
const ok = (c, name, extra = '') => { if (c) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('Checking a layout');
ok(same(fullLayout(), DEFAULT_LAYOUT) && isDefaultLayout(undefined) && isDefaultLayout({}), 'nothing (or nothing valid) is the default layout');
ok(cleanLayout(null) === null && cleanLayout('x') === null && cleanLayout([1, 2]) === null && cleanLayout({ rail: 'diagonal' }) === null, 'junk is no layout at all');
ok(same(cleanLayout({ rail: 'top', sidebar: 'top', userbar: 'bottom', panel: 'left', extra: 1 }), { rail: 'top', panel: 'left' }), 'only edges a piece may sit on are kept (the channel list can’t go on top)');
ok(same(cleanLayout({ order: ['panel', 'panel', 'bogus', 'rail'] }).order, ['panel', 'rail', 'sidebar', 'userbar']), 'the order lists every piece once: repeats and strangers go, missing ones join at the end');
ok(same(fullLayout({ rail: 'bottom' }), { ...DEFAULT_LAYOUT, rail: 'bottom' }) && !isDefaultLayout({ rail: 'bottom' }), 'what is missing comes from the default layout');
ok(DEFAULT_SETTINGS.layout && same(DEFAULT_SETTINGS.layout, DEFAULT_LAYOUT) && DEFAULT_SETTINGS.layout !== DEFAULT_LAYOUT, 'the settings start with the default layout (a copy of it)');

console.log('\nMoving pieces');
const D = fullLayout();
let L = moveBlock(D, 'panel', 'left');
ok(L.panel === 'left' && same(L.order, ['panel', 'rail', 'sidebar', 'userbar']), 'a piece dropped on an edge goes to its outer end (far left)');
L = moveBlock(D, 'panel', 'left', { before: 'sidebar' }); ok(same(L.order, ['rail', 'panel', 'sidebar', 'userbar']), 'dropped before another piece, it goes right before it…');
L = moveBlock(D, 'panel', 'left', { after: 'sidebar' }); ok(same(L.order.filter((b) => b !== 'userbar'), ['rail', 'sidebar', 'panel']), '… and after it');
L = moveBlock(D, 'rail', 'right'); ok(L.rail === 'right' && same(L.order, ['sidebar', 'userbar', 'panel', 'rail']), 'to the right edge it goes to the far right, after what is there');
ok(same(moveBlock(D, 'sidebar', 'top'), D) && same(moveBlock(D, 'panel', 'bottom'), D) && same(moveBlock(D, 'userbar', 'top'), D) && same(moveBlock(D, 'bogus', 'left'), D), 'a piece can’t be put where it can’t sit');
ok(moveBlock(D, 'rail', 'top').rail === 'top' && moveBlock(D, 'rail', 'bottom').rail === 'bottom', 'only the server bar can lie along the top or the bottom');
let r = D; const seen = [];
for (let i = 0; i < 5; i++) { seen.push(r.rail); r = rotateBlock(r, 'rail'); }
ok(same(seen, ['left', 'top', 'right', 'bottom', 'left']), 'rotating the server bar goes left, top, right, bottom and round again');
ok(rotateBlock(D, 'sidebar').sidebar === 'right' && rotateBlock(rotateBlock(D, 'sidebar'), 'sidebar').sidebar === 'left', 'the other pieces turn between left and right');
ok(same(shiftBlock(D, 'sidebar', -1).order, ['sidebar', 'rail', 'userbar', 'panel']) && same(shiftBlock(D, 'rail', -1), D) && same(shiftBlock(D, 'panel', 1), D), 'a column swaps places with its neighbour (and not past the end)');
ok(canShift(D, 'sidebar', -1) && !canShift(D, 'rail', -1) && !canShift(D, 'panel', 1) && !canShift(D, 'userbar', 1), 'the buttons know when a piece can move');
ok(same(edgesOf(D), { left: ['rail', 'sidebar'], right: ['panel'], top: [], bottom: [], userbar: 'left' }), 'what is on each edge');

console.log('\nThe grid');
let p = gridPlan(D);
ok(p.areas === '"rail sidebar main panel" "userbar userbar main panel"' && p.columns === '74px var(--sidebar-w, 248px) minmax(0, 1fr) auto' && p.rows === 'minmax(0, 1fr) auto' && !p.alone, 'the default layout is the screen as it always was: the profile bar under the rail and the channel list');
p = gridPlan(D, { panel: false }); ok(p.areas === '"rail sidebar main" "userbar userbar main"', 'with no members panel to show, its column is left out');
p = gridPlan(moveBlock(D, 'rail', 'top')); ok(p.areas === '"rail rail rail" "sidebar main panel" "userbar main panel"' && p.rows === 'auto minmax(0, 1fr) auto', 'a server bar on top spans the whole width');
p = gridPlan(moveBlock(D, 'rail', 'bottom')); ok(p.areas.endsWith('"rail rail rail"') && p.rows === 'minmax(0, 1fr) auto auto', 'on the bottom it is the last row');
p = gridPlan(fullLayout({ userbar: 'right', panel: 'left' })); ok(p.alone && p.areas === '"rail sidebar panel main userbar"', 'a profile bar on an edge with no column makes a column of its own');
p = gridPlan(fullLayout({ userbar: 'right' })); ok(p.areas === '"rail sidebar main panel" "rail sidebar main userbar"' && !p.alone, 'a profile bar on the right sits under the members panel');

// no two pieces ever share a spot: over every arrangement, each name fills one rectangle of the grid and every piece is in it once
const perms = (a) => (a.length < 2 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((q) => [x, ...q])));
let combos = 0; let bad = null;
for (const rail of DOCKS.rail) for (const sidebar of DOCKS.sidebar) for (const userbar of DOCKS.userbar) for (const panel of DOCKS.panel) for (const order of perms(BLOCKS)) for (const showPanel of [true, false]) {
  combos++;
  const plan = gridPlan({ rail, sidebar, userbar, panel, order }, { panel: showPanel });
  const grid = [...plan.areas.matchAll(/"([^"]+)"/g)].map((m) => m[1].split(' '));
  const cols = plan.columns.split(/ (?![^(]*\))/).length; const names = new Set(grid.flat());
  const expected = ['main', 'rail', 'sidebar', 'userbar', ...(showPanel ? ['panel'] : [])];
  let good = grid.every((row) => row.length === cols) && same([...names].sort(), expected.sort());
  for (const n of names) {   // a rectangle: every cell inside the name's bounding box is that name
    const cells = grid.flatMap((row, y) => row.map((c, x) => [c, x, y])).filter((c) => c[0] === n);
    const xs = cells.map((c) => c[1]); const ys = cells.map((c) => c[2]);
    const box = (Math.max(...xs) - Math.min(...xs) + 1) * (Math.max(...ys) - Math.min(...ys) + 1);
    if (box !== cells.length) good = false;
  }
  if (!good && !bad) bad = { rail, sidebar, userbar, panel, order, showPanel, areas: plan.areas, columns: plan.columns };
}
ok(!bad, `${combos} arrangements: every piece is in the grid once, as one rectangle, so none covers another`, JSON.stringify(bad));

console.log('\nIn a theme');
ok(SITE_SECTIONS.includes('layout'), 'a site theme carries the layout');
const withLayout = sanitizeSiteLook({ theme: { radius: 20 }, layout: { rail: 'bottom', sidebar: 'nonsense', panel: 'left' } });
ok(same(withLayout.layout, { rail: 'bottom', panel: 'left' }) && withLayout.theme.radius === 20, 'its layout is checked with the same rules');
const without = sanitizeSiteLook({ theme: { radius: 20 } });
ok(without && !('layout' in without), 'a theme saved before layouts existed has none (so putting it on leaves yours as it is)');
ok(same(siteLookOf({ ...DEFAULT_SETTINGS }).layout, DEFAULT_LAYOUT), 'a theme saved from the settings holds the layout they have');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
