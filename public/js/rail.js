// Orate — server rail (left-most column).
import { html, useState, useMemo, cx, memo } from '/js/lib.js';
import { state, useSel, go, goChannel, openModal, openContext, updateSettings, serverUnread, unreadInfo, hasPerm, toast, shallowArrEq } from '/js/store.js';
import { Icon, Logo } from '/js/icons.js';
import { ServerIcon } from '/js/ui.js';
import { markServerRead, openSettings, act } from '/js/actions.js';
import { api } from '/js/api.js';
import { confirmDialog } from '/js/ui.js';
import { copyText } from '/js/lib.js';
import { t } from '/js/i18n.js';

export function orderedServerIds(servers, order) {
  const ids = Object.keys(servers);
  const rank = new Map(order.map((id, i) => [id, i]));
  return ids.sort((a, b) => (rank.has(a) ? rank.get(a) : 1e9 + Number(servers[a].createdAt || 0) / 1e3) - (rank.has(b) ? rank.get(b) : 1e9 + Number(servers[b].createdAt || 0) / 1e3));
}

export function serverMenu(server) {
  const me = state.me; const owner = server.ownerId === me.id;
  const muted = !!state.settings.mutedServers[server.id];
  const canSettings = hasPerm(server.id, 'MANAGE_SERVER') || hasPerm(server.id, 'MANAGE_CHANNELS') || hasPerm(server.id, 'MANAGE_ROLES');
  return [
    { label: t('Mark As Read'), icon: 'check', onClick: () => markServerRead(server.id) },
    { type: 'sep' },
    hasPerm(server.id, 'CREATE_INVITE') && { label: t('Invite People'), icon: 'user-plus', onClick: () => openModal('invite', { serverId: server.id }) },
    { label: muted ? t('Unmute Server') : t('Mute Server'), icon: muted ? 'bell' : 'bell-off', onClick: () => updateSettings({ mutedServers: { [server.id]: !muted } }) },
    canSettings && { label: t('Server Settings'), icon: 'settings', onClick: () => openServerSettings(server.id) },
    hasPerm(server.id, 'MANAGE_CHANNELS') && { label: t('Create Channel'), icon: 'plus', onClick: () => openModal('create-channel', { serverId: server.id }) },
    { type: 'sep' },
    { label: t('Copy Server ID'), icon: 'copy', onClick: async () => { await copyText(server.id); toast('Copied', 'success', 1500); } },
    owner
      ? { label: t('Delete Server'), icon: 'trash', danger: true, onClick: () => deleteServer(server) }
      : { label: t('Leave Server'), icon: 'log-out', danger: true, onClick: () => leaveServer(server) },
  ];
}
export function openServerSettings(id, page = 'overview') { import('/js/server-settings.js').then((m) => m.openServerSettings(id, page)); }
export async function leaveServer(server) {
  if (await confirmDialog({ title: `Leave '${server.name}'`, body: 'Are you sure you want to leave? You won’t be able to rejoin unless you are re-invited.', confirmLabel: 'Leave Server', danger: true })) {
    await act(api.post(`/servers/${server.id}/leave`));
  }
}
export async function deleteServer(server) {
  if (await confirmDialog({ title: `Delete '${server.name}'`, body: 'This permanently deletes the server, all of its channels and messages. This cannot be undone.', confirmLabel: 'Delete Server', danger: true, input: { label: 'Type the server name to confirm', match: server.name } })) {
    await act(api.del(`/servers/${server.id}`));
  }
}

const ServerButton = memo(function ServerButton({ id, active, unread, mentions, onDragStart, onDragOver, onDrop, dragging, over, entering }) {
  const server = useSel((s) => s.servers[id]);
  if (!server) return null;
  return html`<div class=${cx('rail-item', active && 'active', unread && !active && 'unread', dragging && 'dragging', over && 'drag-over', entering && 'entering')} draggable="true"
    onDragStart=${(e) => onDragStart(e, id)} onDragOver=${(e) => onDragOver(e, id)} onDrop=${(e) => onDrop(e, id)} onDragEnd=${() => onDragOver(null, null)}
    onContextMenu=${(e) => openContext(e, serverMenu(server))}>
    <span class="rail-pill"></span>
    <button type="button" class="rail-btn glass glass-rail" data-tip=${server.name} data-tip-pos="right" aria-label=${server.name} onClick=${() => goChannel(id, null)}>
      <${ServerIcon} server=${server} size=${48} />
    </button>
    ${mentions ? html`<span class="rail-badge">${mentions > 99 ? '99+' : mentions}</span>` : null}
  </div>`;
});

export function ServerRail() {
  const servers = useSel((s) => s.servers);
  const order = useSel((s) => s.settings.serverOrder, shallowArrEq);
  const route = useSel((s) => s.route.serverId);
  const view = useSel((s) => s.route.view);
  const ids = useMemo(() => orderedServerIds(servers, order), [servers, order]);
  const badges = useSel((s) => ids.map((id) => { const u = serverUnread(id); return `${id}:${u.unread ? 1 : 0}:${u.mentions}`; }).join('|'));
  const dmBadge = useSel((s) => Object.values(s.dms).reduce((n, c) => { const u = unreadInfo(c.id); return n + (u.mentions || (u.unread && !s.settings.mutedChannels[c.id] ? 1 : 0)); }, 0));
  const [drag, setDrag] = useState({ id: null, over: null });
  const info = Object.fromEntries(badges.split('|').filter(Boolean).map((x) => { const [id, u, m] = x.split(':'); return [id, { unread: u === '1', mentions: Number(m) }]; }));
  const onDragStart = (e, id) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); setDrag({ id, over: null }); };
  const onDragOver = (e, id) => { if (!e) { setDrag({ id: null, over: null }); return; } e.preventDefault(); if (drag.over !== id) setDrag((d) => ({ ...d, over: id })); };
  const onDrop = (e, id) => {
    e.preventDefault(); const from = drag.id; setDrag({ id: null, over: null });
    if (!from || from === id) return;
    const next = ids.filter((x) => x !== from); next.splice(next.indexOf(id), 0, from);
    updateSettings({ serverOrder: next });
  };
  return html`<nav class="rail panel" aria-label="Servers">
    <div class="rail-item ${route === '@me' && ['friends', 'dm'].includes(view) ? 'active' : ''}">
      <span class="rail-pill"></span>
      <button type="button" class="rail-btn home glass glass-rail" data-tip=${t('Direct Messages')} data-tip-pos="right" aria-label="Home" onClick=${() => go(state.route.view === 'dm' ? '/channels/@me' : (state.settings.lastChannel['@me'] ? `/channels/@me/${state.settings.lastChannel['@me']}` : '/channels/@me'))}><${Logo} size=${30} bg="var(--text)" /></button>
      ${dmBadge ? html`<span class="rail-badge">${dmBadge > 99 ? '99+' : dmBadge}</span>` : null}
    </div>
    <div class="rail-sep"></div>
    ${ids.map((id) => html`<${ServerButton} key=${id} id=${id} active=${route === id} unread=${info[id]?.unread} mentions=${info[id]?.mentions || 0} onDragStart=${onDragStart} onDragOver=${onDragOver} onDrop=${onDrop} dragging=${drag.id === id} over=${drag.over === id && drag.id !== id} />`)}
    <div class="rail-item"><button type="button" class="rail-btn add glass glass-rail" data-tip=${t('Add a Server')} data-tip-pos="right" aria-label="Add a server" onClick=${() => openModal('add-server')}><${Icon} name="plus" size=${24} sw=${2.4} /></button></div>
  </nav>`;
}
void openSettings;
