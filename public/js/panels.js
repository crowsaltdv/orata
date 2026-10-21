// Orate — right-hand panels: members, pinned messages, search, DM profile.
import { html, useState, useEffect, useMemo, useRef, cx, formatStamp, debounce, memo } from '/js/lib.js';
import { state, set, useSel, getChannel, dmName, dmUserId, openContext, openModal, hasPerm, hasChannelPerm, nameOf, roleColor, isOwnerOf } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { Avatar, Empty, Spinner, IconBtn } from '/js/ui.js';
import { api } from '/js/api.js';
import { jumpToMessage, pinMessage } from '/js/actions.js';
import { openProfile } from '/js/sidebar.js';
import { ProfileCard, userMenu } from '/js/profile.js';
import { renderMarkdown, plainPreview } from '/js/markdown.js';
import { addUsers } from '/js/store.js';
import { t } from '/js/i18n.js';
import { UserName } from '/js/profile-style.js';
import { ServerTag } from '/js/server-tag.js';

/* ------------------------------------------------------------------ members */
const MemberRow = memo(function MemberRow({ id, serverId, groupColor }) {
  const u = useSel((s) => s.users[id]);
  const nick = useSel((s) => s.servers[serverId]?.members.find((m) => m.id === id)?.nick);
  const color = useSel((s) => roleColor(serverId, id));
  const owner = useSel((s) => isOwnerOf(s.servers[serverId], id));
  const timedOut = useSel((s) => (s.servers[serverId]?.members.find((m) => m.id === id)?.timeoutUntil || 0) > Date.now());
  if (!u) return null;
  const off = u.status === 'offline';
  return html`<button type="button" class=${cx('member-row', off && 'off')} onClick=${(e) => openProfile(id, e.currentTarget)} onContextMenu=${(e) => openContext(e, userMenu(id, serverId))}>
    <${Avatar} user=${u} size=${34} status=${u.status} />
    <span class="mr-text"><span class="mr-name" style=${color ? { color } : null}><${UserName} user=${u} text=${nick || u.displayName} />${u.tag ? html`<${ServerTag} tag=${u.tag} />` : null}${owner ? html`<${Icon} name="crown" size=${13} class="crown" />` : null}${timedOut ? html`<span class="timeout-ico" title=${t('Timed out')}><${Icon} name="clock" size=${13} /></span>` : null}${u.bot ? html`<span class="bot-tag">APP</span>` : null}</span>
      ${u.customStatus ? html`<span class="mr-sub">${u.customStatus.emoji} ${u.customStatus.text}</span>` : null}</span>
  </button>`;
});

export function MembersPanel({ chId }) {
  const ch = useSel((s) => getChannel(chId));
  const server = useSel((s) => (ch?.serverId ? s.servers[ch.serverId] : null));
  const users = useSel((s) => s.users);
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const ids = server ? server.members.map((m) => m.id) : (ch?.recipients || []);
    const term = q.trim().toLowerCase();
    const rows = ids.map((id) => ({ id, u: users[id], m: server?.members.find((m) => m.id === id) })).filter((x) => x.u && (!term || x.u.displayName.toLowerCase().includes(term) || x.u.username.includes(term) || x.m?.nick?.toLowerCase().includes(term)));
    const hoisted = server ? server.roles.filter((r) => r.hoist && r.id !== server.id).sort((a, b) => b.position - a.position) : [];
    const used = new Set(); const out = [];
    const sortFn = (a, b) => (a.m?.nick || a.u.displayName).localeCompare(b.m?.nick || b.u.displayName);
    for (const r of hoisted) {
      const list = rows.filter((x) => x.u.status !== 'offline' && !used.has(x.id) && x.m?.roles.includes(r.id)).sort(sortFn);
      list.forEach((x) => used.add(x.id)); if (list.length) out.push({ key: r.id, title: r.name, color: r.color, list });
    }
    const online = rows.filter((x) => x.u.status !== 'offline' && !used.has(x.id)).sort(sortFn);
    const offline = rows.filter((x) => x.u.status === 'offline').sort(sortFn);
    if (online.length) out.push({ key: 'on', title: 'Online', list: online });
    if (offline.length) out.push({ key: 'off', title: 'Offline', list: offline });
    return out;
  }, [server, ch, users, q]);
  if (!ch) return null;
  const total = groups.reduce((n, g) => n + g.list.length, 0);
  return html`<div class="panel-pane members-pane">
    <div class="pane-search"><${Icon} name="search" size=${15} /><input placeholder=${t('Search members')} value=${q} onInput=${(e) => setQ(e.target.value)} />${q ? html`<button type="button" onClick=${() => setQ('')}><${Icon} name="x" size=${14} /></button>` : null}</div>
    <div class="pane-scroll">
      ${groups.map((g) => html`<div class="member-group" key=${g.key}><h5 style=${g.color ? { color: g.color } : null}>${g.title} — ${g.list.length}</h5>${g.list.map((x) => html`<${MemberRow} key=${x.id} id=${x.id} serverId=${ch.serverId} />`)}</div>`)}
      ${!total ? html`<${Empty} icon="users" title="No members found" />` : null}
    </div></div>`;
}

/* ------------------------------------------------------------------ DM profile */
export function DmProfilePanel({ chId }) {
  const ch = useSel((s) => getChannel(chId)); const other = ch ? dmUserId(ch) : null;
  if (!ch || !other) return null;
  return html`<div class="panel-pane profile-pane"><${ProfileCard} userId=${other} mode="panel" /></div>`;
}

/* ------------------------------------------------------------------ pins */
function MiniMessage({ m, ch, onJump, actions }) {
  const author = state.users[m.authorId]; const color = ch.serverId ? roleColor(ch.serverId, m.authorId) : null;
  return html`<div class="mini-msg">
    <div class="mm-head"><${Avatar} user=${author} size=${24} /><span class="mm-name" style=${color ? { color } : null}>${nameOf(m.authorId, ch.serverId)}</span><span class="mm-time">${formatStamp(m.createdAt, !state.settings.chat.hour24)}</span>
      <span class="mm-acts"><button type="button" class="mm-jump" onClick=${onJump}>${t('Jump')}</button>${actions}</span></div>
    <div class="mm-body msg-content" dangerouslySetInnerHTML=${{ __html: m.content ? renderMarkdown(m.content, { serverId: ch.serverId }) : `<i>${m.gif ? 'GIF' : m.sticker ? 'Sticker' : m.attachments?.length ? `${m.attachments.length} attachment${m.attachments.length > 1 ? 's' : ''}` : ''}</i>` }}></div>
  </div>`;
}
export function PinsPanel({ chId }) {
  const ch = getChannel(chId); const [data, setData] = useState(null); const rev = useSel((s) => (s.msgs[chId]?.list || []).filter((m) => m.pinned).map((m) => m.id).join());
  useEffect(() => { let live = true; setData(null); api.get(`/channels/${chId}/pins`).then((r) => { if (live) { addUsers(r.users); setData(r.messages); } }).catch(() => live && setData([])); return () => { live = false; }; }, [chId, rev]);
  if (!ch) return null;
  const can = ch.serverId ? hasChannelPerm(ch, 'MANAGE_MESSAGES') : true;
  return html`<div class="panel-pane">
    <div class="pane-head"><b>${t('Pinned Messages')}</b><${IconBtn} icon="x" label="Close" glass=${null} onClick=${() => set({ panel: state.local.panel === 'pins' ? 'members' : state.local.panel })} /></div>
    <div class="pane-scroll">${!data ? html`<div class="pk-center"><${Spinner} /></div>` : data.length ? data.map((m) => html`<${MiniMessage} key=${m.id} m=${m} ch=${ch} onJump=${() => jumpToMessage(chId, m.id)} actions=${can ? html`<button type="button" class="mm-jump danger" onClick=${() => pinMessage(ch, m.id, false)}>${t('Unpin')}</button>` : null} />`)
      : html`<${Empty} icon="pin" title=${t('No pinned messages yet')}>${t('Right-click any message and choose Pin Message to keep it here.')}<//>`}</div></div>`;
}

/* ------------------------------------------------------------------ search */
export function SearchPanel({ chId }) {
  const ch = getChannel(chId); const query = useSel((s) => s.searchQuery);
  const [scope, setScope] = useState(ch?.serverId ? 'channel' : 'channel'); const [has, setHas] = useState(''); const [res, setRes] = useState(null); const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    const q = query.trim(); if (!q && !has) { setRes(null); return undefined; }
    const my = ++seq.current; setLoading(true);
    const timer = setTimeout(async () => {
      const p = new URLSearchParams({ q }); if (has) p.set('has', has);
      if (scope === 'server' && ch?.serverId) p.set('serverId', ch.serverId); else p.set('channelId', chId);
      try { const r = await api.get('/search?' + p); if (my === seq.current) { addUsers(r.users); setRes(r); } } catch { if (my === seq.current) setRes({ results: [], total: 0 }); } finally { if (my === seq.current) setLoading(false); }
    }, 280);
    return () => clearTimeout(timer);
  }, [query, scope, has, chId]);
  if (!ch) return null;
  return html`<div class="panel-pane">
    <div class="pane-head"><b>${t('Search')}</b><${IconBtn} icon="x" label="Close" glass=${null} onClick=${() => set({ panel: state.local.panel, searchQuery: '' })} /></div>
    <div class="pane-search big"><${Icon} name="search" size=${16} /><input autofocus placeholder=${t('Search messages')} value=${query} onInput=${(e) => set({ searchQuery: e.target.value })} /></div>
    <div class="search-filters">
      ${ch.serverId ? html`<button type="button" class=${cx(scope === 'channel' && 'on')} onClick=${() => setScope('channel')}>${t('This channel')}</button><button type="button" class=${cx(scope === 'server' && 'on')} onClick=${() => setScope('server')}>${t('Whole server')}</button>` : null}
      ${['image', 'file', 'link', 'gif', 'pin'].map((h) => html`<button type="button" class=${cx(has === h && 'on')} onClick=${() => setHas(has === h ? '' : h)}>has: ${h}</button>`)}</div>
    <div class="pane-scroll">
      ${loading && !res ? html`<div class="pk-center"><${Spinner} /></div>` : null}
      ${res ? html`<div class="search-count">${res.total} ${res.total === 1 ? t('result') : t('results')}</div>${res.results.map((m) => { const c = getChannel(m.channelId); return html`<div class="search-hit" key=${m.id}>${scope === 'server' && c ? html`<div class="sh-ch"># ${c.name}</div>` : null}<${MiniMessage} m=${m} ch=${c || ch} onJump=${() => { if (c && c.id !== state.route.channelId) { import('/js/store.js').then((s) => s.goChannel(c.serverId, c.id)); } jumpToMessage(m.channelId, m.id); }} /></div>`; })}`
        : !loading ? html`<${Empty} icon="search" title=${t('Search this conversation')}>${t('Find messages by keyword, or filter by attachments and links.')}<//>` : null}
    </div></div>`;
}
void plainPreview; void debounce; void openModal; void dmName;
