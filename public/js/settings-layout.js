// Orata — Settings → Layout: where the server bar, the channel list, your profile bar and the members panel sit on the screen (layout-data.js has the rules, app.js builds
// the real screen from them). A picture of the screen to drag the pieces around in — onto an edge, or next to another piece — and buttons for the same (a position, rotate,
// a place earlier or later), so it works without dragging too. Pieces slide into place (flip.js), and since the screen is a grid they fit next to each other and can never
// cover one another. The layout is part of a site theme: saving a theme keeps it, and putting a theme on brings its layout with it.
import { html, useState, useRef, cx } from '/js/lib.js';
import { useSel, updateSettings, toast } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { Btn, IconBtn, Section, Segmented } from '/js/ui.js';
import { t } from '/js/i18n.js';
import { BLOCKS, BLOCK_NAMES, DOCKS, DEFAULT_LAYOUT, PHONE_MAX, fullLayout, isDefaultLayout, gridPlan, moveBlock, rotateBlock, shiftBlock, canShift } from '/js/layout-data.js';
import { useFlip } from '/js/flip.js';

const ICON = { rail: 'server', sidebar: 'sidebar', userbar: 'user', panel: 'users', main: 'message' };
const SHORT = { rail: 'Servers', sidebar: 'Channels', userbar: 'You', panel: 'Members', main: 'Chat' };
const EDGE = { left: 'Left', top: 'Top', right: 'Right', bottom: 'Bottom' };
const EDGE_ICON = { left: 'arrow-left', top: 'arrow-up', right: 'arrow-right', bottom: 'arrow-down' };
const PICTURE = { rail: '34px', sidebar: '88px', panel: '88px', userbar: '88px', railRow: '34px', userbarRow: '38px' };   // the sizes in the picture (the real screen's are in layout-data.js)

const save = (layout) => updateSettings({ layout });

export function LayoutPage() {
  const raw = useSel((s) => s.settings.layout); const width = useSel((s) => s.width);
  const layout = fullLayout(raw); const plan = gridPlan(layout, { panel: true, sizes: PICTURE });
  const [drag, setDrag] = useState(null); const [over, setOver] = useState(null);   // the piece being dragged; where it would land: { key, tile, dock, before?, after?, ok }
  const screen = useRef(null);
  useFlip(screen, `${plan.areas}|${plan.columns}|${plan.rows}`);

  /** Where dropping the dragged piece on `tile` (at the pointer in `e`) would put it: the edge, and next to which piece. */
  const aim = (e, tile) => {
    const r = e.currentTarget.getBoundingClientRect(); const x = (e.clientX - r.left) / Math.max(1, r.width); const y = (e.clientY - r.top) / Math.max(1, r.height);
    let dock; let before; let after;
    if (tile === 'main') dock = drag === 'rail' ? Object.entries({ left: x, right: 1 - x, top: y, bottom: 1 - y }).sort((a, b) => a[1] - b[1])[0][0] : x < 0.5 ? 'left' : 'right';   // the chat: the nearest edge
    else if (tile === 'userbar') dock = layout.userbar;
    else if (tile === 'rail' && (layout.rail === 'top' || layout.rail === 'bottom')) dock = layout.rail;
    else { dock = layout[tile]; if (x < 0.5) before = tile; else after = tile; }
    return { key: `${tile}:${before || ''}:${after || ''}:${dock}`, tile, dock, before, after, ok: !!drag && drag !== tile && DOCKS[drag].includes(dock) };
  };
  const finish = () => { setDrag(null); setOver(null); };
  const dropOn = (target) => { if (drag && target?.ok) save(moveBlock(layout, drag, target.dock, { before: target.before, after: target.after })); finish(); };
  const hover = (e, tile) => { if (!drag) return; const a = aim(e, tile); if (a.ok) e.preventDefault(); if (over?.key !== a.key) setOver(a); };
  const edgeOk = (dock) => !!drag && DOCKS[drag].includes(dock);

  const tile = (id) => {
    const horizontal = id === 'rail' && (layout.rail === 'top' || layout.rail === 'bottom'); const movable = id !== 'main';
    const here = over && over.tile === id; const hot = here && over.ok;
    return html`<div key=${id} data-blk=${id} class=${cx('lay-blk', `b-${id}`, horizontal ? 'h' : 'v', drag === id && 'dragging', hot && 'hot', here && !over.ok && 'no', hot && over.before === id && 'before', hot && over.after === id && 'after')} style=${{ gridArea: id }}
        draggable=${movable ? 'true' : 'false'} title=${t(BLOCK_NAMES[id] || 'Chat')}
        onDragStart=${movable ? (e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); setDrag(id); } : null} onDragEnd=${finish}
        onDragOver=${(e) => hover(e, id)} onDrop=${(e) => { e.preventDefault(); dropOn(aim(e, id)); }}>
      <${Icon} name=${ICON[id]} size=${horizontal ? 17 : 19} /><span class="lay-name">${t(SHORT[id])}</span></div>`;
  };
  const edge = (dock) => html`<div key=${dock} class=${cx('lay-edge', dock, drag && (edgeOk(dock) ? 'ok' : 'no'), over?.key === `edge:${dock}` && 'hot')}
    onDragOver=${(e) => { if (!edgeOk(dock)) return; e.preventDefault(); if (over?.key !== `edge:${dock}`) setOver({ key: `edge:${dock}`, tile: null, dock, ok: true }); }}
    onDrop=${(e) => { e.preventDefault(); dropOn({ dock, ok: edgeOk(dock) }); }}><${Icon} name=${EDGE_ICON[dock]} size=${14} sw=${2.6} /><span>${t(EDGE[dock])}</span></div>`;

  return html`<div class="s-page layout-page">
    <${Section} title=${t('Screen layout')} desc=${t('Drag a piece to an edge of the picture, or next to another piece, and the screen follows. Pieces slide into place and can never cover each other.')}
      action=${html`<${Btn} icon="refresh" disabled=${isDefaultLayout(raw)} onClick=${() => { save(structuredClone(DEFAULT_LAYOUT)); toast(t('Default layout back'), 'success', 1800); }}>${t('Reset to default layout')}<//>`}>
      <div class=${cx('lay-stage', drag && 'dragging')}>
        ${['top', 'bottom', 'left', 'right'].map(edge)}
        <div class="lay-screen" ref=${screen} style=${{ gridTemplateColumns: plan.columns, gridTemplateRows: plan.rows, gridTemplateAreas: plan.areas }}>
          ${[...BLOCKS, 'main'].map(tile)}
        </div>
      </div>
      ${width <= PHONE_MAX ? html`<p class="lay-note"><${Icon} name="info" size=${14} /> ${t('This window is narrow, so Orata is showing its phone layout (a slide-out menu). Your layout is used when the window is wider.')}</p>` : null}
    <//>
    <${Section} title=${t('Pieces')} desc=${t('The same thing with buttons. Rotate turns a piece to its next edge; the server bar can go to all four sides, the others to the left or right.')}>
      <div class="lay-rows">${BLOCKS.map((id) => html`<div class="lay-row" key=${id}>
        <span class="lay-ic"><${Icon} name=${ICON[id]} size=${20} /></span>
        <div class="lay-title"><b>${t(BLOCK_NAMES[id])}</b></div>
        <${Segmented} size="sm" value=${layout[id]} options=${DOCKS[id].map((d) => ({ value: d, label: t(EDGE[d]) }))} onChange=${(d) => { if (d !== layout[id]) save(moveBlock(layout, id, d)); }} />
        <span class="lay-btns">
          <${IconBtn} icon="rotate-cw" label=${t('Rotate to the next edge')} glass=${null} size=${17} onClick=${() => save(rotateBlock(layout, id))} />
          <${IconBtn} icon="arrow-left" label=${t('One place earlier on its edge')} glass=${null} size=${17} disabled=${!canShift(layout, id, -1)} onClick=${() => save(shiftBlock(layout, id, -1))} />
          <${IconBtn} icon="arrow-right" label=${t('One place later on its edge')} glass=${null} size=${17} disabled=${!canShift(layout, id, 1)} onClick=${() => save(shiftBlock(layout, id, 1))} />
        </span></div>`)}</div>
      <p class="lay-note"><${Icon} name="palette" size=${14} /> ${t('Your layout is saved with your site themes: a theme you save keeps it, and putting that theme on brings its layout back. Themes saved before layouts existed leave yours as it is.')}</p>
    <//>
  </div>`;
}
