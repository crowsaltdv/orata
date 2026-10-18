// Orate — quick switcher (Ctrl+K), image lightbox.
import { html, useState, useEffect, useRef, useMemo, cx, clamp, ls } from '/js/lib.js';
import { state, set, useSel, go, goChannel, goDm, getChannel, dmName, dmUserId, unreadInfo } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { Avatar, ServerIcon, useEscape } from '/js/ui.js';
import { openDm } from '/js/actions.js';
import { cmpId } from '/js/lib.js';
import { t } from '/js/i18n.js';

/* ------------------------------------------------------------------ quick switcher */
function score(text, q) {
  text = text.toLowerCase(); if (!q) return 1;
  if (text === q) return 100; if (text.startsWith(q)) return 80; const i = text.indexOf(q); if (i >= 0) return 60 - Math.min(i, 30);
  // subsequence
  let p = 0; for (const c of text) if (c === q[p]) p++; return p === q.length ? 20 : 0;
}
export function QuickSwitcher() {
  const open = useSel((s) => s.quick);
  const [q, setQ] = useState(''); const [idx, setIdx] = useState(0); const input = useRef(null); const list = useRef(null);
  const close = () => { set({ quick: false }); setQ(''); };
  useEffect(() => { if (open) { setQ(''); setIdx(0); setTimeout(() => input.current?.focus(), 30); } }, [open]);
  useEscape(close, open);
  const items = useMemo(() => {
    if (!open) return [];
    let query = q.trim().toLowerCase(); let kind = null;
    if ('@#*!'.includes(query[0]) && query) { kind = query[0]; query = query.slice(1); }
    const out = [];
    const users = state.users; const me = state.me.id;
    const dmByUser = {}; for (const d of Object.values(state.dms)) if (d.type === 'dm') dmByUser[dmUserId(d)] = d;
    if (!kind || kind === '@') {
      for (const u of Object.values(users)) {
        if (u.id === me) continue; const s = Math.max(score(u.displayName, query), score(u.username, query)); if (!s) continue;
        const dm = dmByUser[u.id]; if (!dm && !['friend'].includes(state.relationships[u.id]) && !query) continue;
        out.push({ key: 'u' + u.id, kind: 'user', s: s + (dm ? 15 : 0) + (dm && unreadInfo(dm.id).unread ? 20 : 0), title: u.displayName, sub: '@' + u.username, user: u, run: () => (dm ? goDm(dm.id) : openDm(u.id)) });
      }
      for (const d of Object.values(state.dms)) if (d.type === 'group') { const s = score(dmName(d), query); if (s) out.push({ key: 'g' + d.id, kind: 'group', s: s + 10, title: dmName(d), sub: `${d.recipients.length} members`, icon: 'users', run: () => goDm(d.id) }); }
    }
    if (!kind || kind === '#' || kind === '!') {
      for (const sv of Object.values(state.servers)) for (const c of sv.channels) {
        if (c.type === 'category') continue; if (kind === '!' && c.type !== 'voice') continue; if (kind === '#' && c.type !== 'text') continue;
        const s = score(c.name, query); if (!s) continue;
        const u = unreadInfo(c.id);
        out.push({ key: 'c' + c.id, kind: 'channel', s: s + (u.unread ? 12 : 0) + (state.route.channelId === c.id ? -30 : 0), title: c.name, sub: sv.name, icon: c.type === 'voice' ? 'volume' : 'hash', server: sv, run: () => goChannel(sv.id, c.id) });
      }
    }
    if (!kind || kind === '*') for (const sv of Object.values(state.servers)) { const s = score(sv.name, query); if (s) out.push({ key: 's' + sv.id, kind: 'server', s: s + 5, title: sv.name, sub: `${sv.members.length} members`, server: sv, run: () => goChannel(sv.id, null) }); }
    return out.sort((a, b) => b.s - a.s).slice(0, 12);
  }, [open, q]);
  useEffect(() => setIdx(0), [q]);
  useEffect(() => { list.current?.querySelector('.qs-item.sel')?.scrollIntoView({ block: 'nearest' }); }, [idx]);
  if (!open) return null;
  const run = (it) => { close(); it?.run(); };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((idx + 1) % Math.max(1, items.length)); } else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((idx - 1 + items.length) % Math.max(1, items.length)); }
    else if (e.key === 'Enter') { e.preventDefault(); run(items[idx]); }
  };
  return html`<div class="modal-backdrop top" onPointerDown=${(e) => e.target === e.currentTarget && close()}>
    <div class="quick-switcher modal" role="dialog" aria-label="Quick switcher">
      <div class="qs-input"><${Icon} name="search" size=${20} /><input ref=${input} placeholder=${t('Where would you like to go?')} value=${q} onInput=${(e) => setQ(e.target.value)} onKeyDown=${onKey} /></div>
      <div class="qs-list" ref=${list}>
        ${items.map((it, i) => html`<button type="button" key=${it.key} class=${cx('qs-item', i === idx && 'sel')} onMouseEnter=${() => setIdx(i)} onClick=${() => run(it)}>
          ${it.user ? html`<${Avatar} user=${it.user} size=${30} status=${it.user.status} />` : it.server && it.kind === 'server' ? html`<${ServerIcon} server=${it.server} size=${30} class="qs-sv" />` : html`<span class="qs-ic"><${Icon} name=${it.icon} size=${18} /></span>`}
          <span class="qs-title">${it.title}</span><span class="qs-sub">${it.sub}</span><span class="qs-kind">${it.kind}</span></button>`)}
        ${!items.length ? html`<div class="qs-empty">${t('No matches. Try')} <b>@</b> ${t('for people')}, <b>#</b> ${t('for channels')}, <b>*</b> ${t('for servers')}.</div>` : null}
      </div>
      <div class="qs-foot"><b>PROTIP:</b> ${t('Start searches with')} <span class="kbd">@</span> <span class="kbd">#</span> <span class="kbd">!</span> <span class="kbd">*</span> ${t('to narrow results.')}</div>
    </div></div>`;
}

/* ------------------------------------------------------------------ lightbox */
export function Lightbox() {
  const lb = useSel((s) => s.lightbox);
  const [i, setI] = useState(0); const [z, setZ] = useState(1); const [pan, setPan] = useState({ x: 0, y: 0 }); const drag = useRef(null);
  useEffect(() => { if (lb) { setI(lb.index || 0); setZ(1); setPan({ x: 0, y: 0 }); } }, [lb]);
  const close = () => set({ lightbox: null });
  useEscape(close, !!lb);
  useEffect(() => {
    if (!lb) return undefined;
    const k = (e) => { if (e.key === 'ArrowRight') nav(1); else if (e.key === 'ArrowLeft') nav(-1); };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  });
  if (!lb) return null;
  const items = lb.items; const cur = items[clamp(i, 0, items.length - 1)];
  const nav = (d) => { setI((v) => (v + d + items.length) % items.length); setZ(1); setPan({ x: 0, y: 0 }); };
  const isVideo = cur.video || /\.(mp4|webm)$/i.test(cur.url);
  return html`<div class="lightbox" onPointerDown=${(e) => { if (e.target === e.currentTarget || e.target.classList.contains('lb-stage')) close(); }} onWheel=${(e) => { setZ(clamp(z - e.deltaY * 0.002, 0.5, 6)); }}>
    <div class="lb-top"><span class="lb-name">${cur.name || ''}${items.length > 1 ? ` · ${i + 1}/${items.length}` : ''}</span>
      <a class="icon-btn" href=${cur.url} target="_blank" rel="noopener noreferrer" data-tip="Open original" aria-label="Open original"><${Icon} name="external" size=${20} /></a>
      <a class="icon-btn" href=${cur.url} download=${cur.name || 'image'} data-tip="Download" aria-label="Download"><${Icon} name="download" size=${20} /></a>
      <button type="button" class="icon-btn" onClick=${() => { setZ(z > 1.4 ? 1 : 2.2); setPan({ x: 0, y: 0 }); }} data-tip="Zoom"><${Icon} name=${z > 1.4 ? 'zoom-out' : 'zoom-in'} size=${20} /></button>
      <button type="button" class="icon-btn" onClick=${close} aria-label="Close"><${Icon} name="x" size=${22} /></button></div>
    ${items.length > 1 ? html`<button type="button" class="lb-nav prev" onClick=${() => nav(-1)} aria-label="Previous"><${Icon} name="chevron-left" size=${30} /></button><button type="button" class="lb-nav next" onClick=${() => nav(1)} aria-label="Next"><${Icon} name="chevron-right" size=${30} /></button>` : null}
    <div class="lb-stage">
      ${isVideo ? html`<video src=${cur.video || cur.url} autoplay loop controls class="lb-media"></video>`
        : html`<img key=${cur.url} class="lb-media" src=${cur.url} alt=${cur.name} draggable="false" style=${{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${z})`, cursor: z > 1 ? 'grab' : 'zoom-in' }}
          onPointerDown=${(e) => { if (z > 1) { drag.current = { x: e.clientX - pan.x, y: e.clientY - pan.y }; e.currentTarget.setPointerCapture(e.pointerId); } }}
          onPointerMove=${(e) => drag.current && setPan({ x: e.clientX - drag.current.x, y: e.clientY - drag.current.y })} onPointerUp=${() => (drag.current = null)}
          onDblClick=${() => { setZ(z > 1.4 ? 1 : 2.4); setPan({ x: 0, y: 0 }); }} />`}
    </div></div>`;
}

void ls; void go; void getChannel; void cmpId;
