// Orate — server rail (left-most column): music, home, servers and server folders.
import { html, useState, useMemo, cx, memo } from '/js/lib.js';
import { state, useSel, go, goChannel, openModal, closeModal, openContext, updateSettings, serverUnread, unreadInfo, hasPerm, toast, shallowArrEq } from '/js/store.js';
import { Icon, Logo } from '/js/icons.js';
import { ServerIcon, Modal, Btn, Field, TextInput, MODALS, ColorSwatch } from '/js/ui.js';
import { markServerRead, openSettings, act } from '/js/actions.js';
import { api } from '/js/api.js';
import { confirmDialog } from '/js/ui.js';
import { copyText } from '/js/lib.js';
import { t } from '/js/i18n.js';
import { openMusic } from '/js/music.js';

/* ------------------------------------------------------------------ layout: servers and folders in one ordered list */
/**
 * settings.serverOrder lists the top-level entries (server ids and folder ids); settings.serverFolders = [{ id, name, color, open, servers: [serverId] }].
 * Returns [{ kind: 'server', id } | { kind: 'folder', id, name, color, open, servers }] — servers you left are dropped, new servers go to the end.
 */
export function railLayout(servers, order, folders) {
  const byId = new Map(); const inFolder = new Set();
  for (const f of folders || []) {
    if (!f?.id || byId.has(f.id)) continue;
    const ids = (f.servers || []).filter((id) => servers[id] && !inFolder.has(id)); ids.forEach((id) => inFolder.add(id));
    byId.set(f.id, { kind: 'folder', id: f.id, name: f.name || '', color: f.color || null, open: f.open !== false, servers: ids });
  }
  const top = []; const seen = new Set();
  for (const key of order || []) {
    if (seen.has(key)) continue;
    if (byId.has(key)) { seen.add(key); if (byId.get(key).servers.length) top.push(byId.get(key)); } else if (servers[key] && !inFolder.has(key)) { seen.add(key); top.push({ kind: 'server', id: key }); }
  }
  for (const f of byId.values()) if (!seen.has(f.id) && f.servers.length) top.push(f);
  const fresh = Object.keys(servers).filter((id) => !inFolder.has(id) && !seen.has(id)).sort((a, b) => Number(servers[a].createdAt || 0) - Number(servers[b].createdAt || 0));
  for (const id of fresh) top.push({ kind: 'server', id });
  return top;
}
const currentLayout = () => railLayout(state.servers, state.settings.serverOrder, state.settings.serverFolders);
function saveLayout(top) {
  const live = top.filter((x) => x.kind === 'server' || x.servers.length);
  updateSettings({
    serverFolders: live.filter((x) => x.kind === 'folder').map(({ id, name, color, open, servers }) => ({ id, name: name || '', color: color || null, open: open !== false, servers })),
    serverOrder: live.map((x) => x.id),
  });
}
const newFolder = (servers) => ({ kind: 'folder', id: `f-${Math.random().toString(36).slice(2, 8)}`, name: '', color: null, open: true, servers });
const clone = (top) => top.map((x) => (x.kind === 'folder' ? { ...x, servers: [...x.servers] } : { ...x }));
function takeServer(top, id) {
  for (let i = 0; i < top.length; i++) {
    const it = top[i];
    if (it.kind === 'server' && it.id === id) { top.splice(i, 1); return; }
    if (it.kind === 'folder' && it.servers.includes(id)) { it.servers = it.servers.filter((x) => x !== id); return; }
  }
}
/** What dropping `drag` on `target` ({ kind, id, folderId }) at `zone` ('before' | 'after' | 'merge') does to the list. */
export function applyDrop(top, drag, target, zone) {
  const t2 = clone(top);
  const at = (kind, id) => t2.findIndex((x) => x.kind === kind && x.id === id);
  if (drag.kind === 'folder') {
    const from = at('folder', drag.id); if (from < 0) return top;
    const key = target.folderId ? { kind: 'folder', id: target.folderId } : target;   // a server inside a folder stands for the folder
    if (key.kind === 'folder' && key.id === drag.id) return top;
    const [moved] = t2.splice(from, 1); const ti = at(key.kind, key.id); if (ti < 0) return top;
    t2.splice(zone === 'after' ? ti + 1 : ti, 0, moved); return t2;
  }
  if (target.kind === 'server' && target.id === drag.id) return top;
  if (target.kind === 'server' && target.folderId) {   // among the servers of a folder
    takeServer(t2, drag.id);
    const f = t2[at('folder', target.folderId)]; if (!f) return top;
    f.servers.splice(f.servers.indexOf(target.id) + (zone === 'after' ? 1 : 0), 0, drag.id); return t2;
  }
  if (target.kind === 'server') {
    takeServer(t2, drag.id);
    const ti = at('server', target.id); if (ti < 0) return top;
    if (zone === 'merge') { t2.splice(ti, 1, newFolder([target.id, drag.id])); return t2; }   // two servers dragged together make a folder
    t2.splice(zone === 'after' ? ti + 1 : ti, 0, { kind: 'server', id: drag.id }); return t2;
  }
  takeServer(t2, drag.id);
  const fi = at('folder', target.id); if (fi < 0) return top;
  if (zone === 'merge') { t2[fi].servers.push(drag.id); return t2; }
  t2.splice(zone === 'after' ? fi + 1 : fi, 0, { kind: 'server', id: drag.id }); return t2;
}
export const folderOps = {
  create(serverId) { const top = clone(currentLayout()); const idx = top.findIndex((x) => x.kind === 'server' && x.id === serverId); takeServer(top, serverId); const f = newFolder([serverId]); top.splice(idx < 0 ? top.length : idx, 0, f); saveLayout(top); setTimeout(() => openModal('edit-folder', { folderId: f.id }), 60); },
  add(serverId, folderId) { const top = clone(currentLayout()); takeServer(top, serverId); const f = top.find((x) => x.kind === 'folder' && x.id === folderId); if (f) f.servers.push(serverId); saveLayout(top); },
  remove(serverId) { const top = clone(currentLayout()); const fi = top.findIndex((x) => x.kind === 'folder' && x.servers.includes(serverId)); if (fi < 0) return; takeServer(top, serverId); top.splice(fi + 1, 0, { kind: 'server', id: serverId }); saveLayout(top); },
  ungroup(folderId) { const top = currentLayout(); const fi = top.findIndex((x) => x.kind === 'folder' && x.id === folderId); if (fi < 0) return; top.splice(fi, 1, ...top[fi].servers.map((id) => ({ kind: 'server', id }))); saveLayout(top); },
  patch(folderId, p) { saveLayout(currentLayout().map((x) => (x.kind === 'folder' && x.id === folderId ? { ...x, ...p } : x))); },
};

export function serverMenu(server) {
  const me = state.me; const owner = server.ownerId === me.id;
  const muted = !!state.settings.mutedServers[server.id];
  const canSettings = hasPerm(server.id, 'MANAGE_SERVER') || hasPerm(server.id, 'MANAGE_CHANNELS') || hasPerm(server.id, 'MANAGE_ROLES');
  const folders = currentLayout().filter((x) => x.kind === 'folder'); const cur = folders.find((f) => f.servers.includes(server.id));
  return [
    { label: t('Mark As Read'), icon: 'check', onClick: () => markServerRead(server.id) },
    { type: 'sep' },
    hasPerm(server.id, 'CREATE_INVITE') && { label: t('Invite People'), icon: 'user-plus', onClick: () => openModal('invite', { serverId: server.id }) },
    server.onboarding?.enabled && { label: t('Rules & roles'), icon: 'shield', onClick: () => import('/js/onboarding.js').then(() => openModal('onboarding', { serverId: server.id })) },
    { label: muted ? t('Unmute Server') : t('Mute Server'), icon: muted ? 'bell' : 'bell-off', onClick: () => updateSettings({ mutedServers: { [server.id]: !muted } }) },
    { label: t('Server Folder'), icon: 'folder', submenu: [
      { label: t('New Folder'), icon: 'plus', onClick: () => folderOps.create(server.id) },
      ...folders.filter((f) => f.id !== cur?.id).map((f) => ({ label: f.name || t('Folder'), icon: 'folder', onClick: () => folderOps.add(server.id, f.id) })),
      cur && { label: t('Remove from Folder'), icon: 'x', onClick: () => folderOps.remove(server.id) },
    ].filter(Boolean) },
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

/* ------------------------------------------------------------------ folder editor */
const FOLDER_COLORS = ['#8b5cf6', '#ec4899', '#f97316', '#eab308', '#10b981', '#06b6d4', '#3b82f6', '#ef4444', '#64748b'];
MODALS['edit-folder'] = function EditFolder({ id, folderId }) {
  const folder = currentLayout().find((x) => x.kind === 'folder' && x.id === folderId);
  const [name, setName] = useState(folder?.name || ''); const [color, setColor] = useState(folder?.color || null);
  if (!folder) return null;
  const close = () => closeModal(id);
  return html`<${Modal} title=${t('Folder Settings')} width=${420} onClose=${close}
    footer=${html`<${Btn} variant="danger" class="mr-auto" icon="trash" onClick=${() => { folderOps.ungroup(folderId); close(); }}>${t('Ungroup')}<//><${Btn} variant="ghost" onClick=${close}>${t('Cancel')}<//><${Btn} variant="primary" onClick=${() => { folderOps.patch(folderId, { name: name.trim().slice(0, 32), color }); close(); }}>${t('Save')}<//>`}>
    <${Field} label=${t('Folder name')}><${TextInput} value=${name} onInput=${setName} maxlength="32" placeholder=${t('Folder')} autofocus onKeyDown=${(e) => e.key === 'Enter' && (folderOps.patch(folderId, { name: name.trim().slice(0, 32), color }), close())} /><//>
    <${Field} label=${t('Folder colour')}><div class="folder-colors">
      <button type="button" class=${cx('fc-sw', !color && 'sel')} style=${{ background: 'var(--accent-grad)' }} onClick=${() => setColor(null)} aria-label=${t('Default')}><${Icon} name="check" size=${14} sw=${3.5} /></button>
      ${FOLDER_COLORS.map((c) => html`<button type="button" key=${c} class=${cx('fc-sw', color === c && 'sel')} style=${{ background: c }} onClick=${() => setColor(c)} aria-label=${c}><${Icon} name="check" size=${14} sw=${3.5} /></button>`)}</div><//>
  <//>`;
};

/* ------------------------------------------------------------------ items */
const ServerButton = memo(function ServerButton({ id, folderId, active, unread, mentions, dnd }) {
  const server = useSel((s) => s.servers[id]);
  if (!server) return null;
  const over = dnd.over && dnd.over.kind === 'server' && dnd.over.id === id ? dnd.over.zone : null;
  return html`<div class=${cx('rail-item', active && 'active', unread && !active && 'unread', dnd.drag?.kind === 'server' && dnd.drag.id === id && 'dragging', over && `drop-${over}`)} draggable="true"
    onDragStart=${(e) => dnd.start(e, { kind: 'server', id, folderId })} onDragOver=${(e) => dnd.hover(e, { kind: 'server', id, folderId })} onDrop=${(e) => dnd.drop(e, { kind: 'server', id, folderId })} onDragEnd=${dnd.end}
    onContextMenu=${(e) => openContext(e, serverMenu(server))}>
    <span class="rail-pill"></span>
    <button type="button" class="rail-btn glass glass-rail" data-tip=${server.name} data-tip-pos="right" aria-label=${server.name} onClick=${() => goChannel(id, null)}>
      <${ServerIcon} server=${server} size=${48} />
      ${mentions ? html`<span class="rail-badge">${mentions > 99 ? '99+' : mentions}</span>` : null}
    </button>
  </div>`;
});

function FolderItem({ folder, info, route, dnd }) {
  const mentions = folder.servers.reduce((n, id) => n + (info[id]?.mentions || 0), 0);
  const unread = folder.servers.some((id) => info[id]?.unread);
  const holdsActive = folder.servers.includes(route);
  const servers = useSel((s) => s.servers);
  const over = dnd.over && dnd.over.kind === 'folder' && dnd.over.id === folder.id ? dnd.over.zone : null;
  const toggle = () => updateSettings({ serverFolders: (state.settings.serverFolders || []).map((f) => (f.id === folder.id ? { ...f, open: !folder.open } : f)) });
  const label = folder.name || folder.servers.map((id) => servers[id]?.name).filter(Boolean).join(', ');
  const menu = [
    { label: folder.open ? t('Collapse Folder') : t('Expand Folder'), icon: 'folder', onClick: toggle },
    { label: t('Mark Folder As Read'), icon: 'check', onClick: () => folder.servers.forEach((id) => markServerRead(id)) },
    { label: t('Folder Settings'), icon: 'settings', onClick: () => openModal('edit-folder', { folderId: folder.id }) },
    { type: 'sep' },
    { label: t('Ungroup Folder'), icon: 'trash', danger: true, onClick: () => folderOps.ungroup(folder.id) },
  ];
  return html`<div class=${cx('rail-folder', folder.open && 'open', over && `drop-${over}`, dnd.drag?.kind === 'folder' && dnd.drag.id === folder.id && 'dragging')} style=${folder.color ? { '--fc': folder.color } : null}>
    <div class=${cx('rail-item folder-head', !folder.open && holdsActive && 'active', !folder.open && unread && !holdsActive && 'unread')} draggable="true"
      onDragStart=${(e) => dnd.start(e, { kind: 'folder', id: folder.id })} onDragOver=${(e) => dnd.hover(e, { kind: 'folder', id: folder.id })} onDrop=${(e) => dnd.drop(e, { kind: 'folder', id: folder.id })} onDragEnd=${dnd.end}
      onContextMenu=${(e) => openContext(e, menu)}>
      <span class="rail-pill"></span>
      <button type="button" class="rail-btn folder glass glass-rail" data-tip=${label || t('Folder')} data-tip-pos="right" aria-label=${label || t('Folder')} aria-expanded=${folder.open} onClick=${toggle}>
        ${folder.open ? html`<${Icon} name="folder" size=${26} sw=${2} />` : html`<span class="fold-grid">${folder.servers.slice(0, 4).map((id) => html`<span class="fold-mini" key=${id}><${ServerIcon} server=${servers[id]} size=${18} /></span>`)}</span>`}
        ${!folder.open && mentions ? html`<span class="rail-badge">${mentions > 99 ? '99+' : mentions}</span>` : null}
      </button>
    </div>
    ${folder.open ? html`<div class="folder-body">${folder.servers.map((id) => html`<${ServerButton} key=${id} id=${id} folderId=${folder.id} active=${route === id} unread=${info[id]?.unread} mentions=${info[id]?.mentions || 0} dnd=${dnd} />`)}</div>` : null}
  </div>`;
}

export function ServerRail() {
  const servers = useSel((s) => s.servers);
  const order = useSel((s) => s.settings.serverOrder, shallowArrEq);
  const folders = useSel((s) => s.settings.serverFolders);
  const route = useSel((s) => s.route.serverId);
  const view = useSel((s) => s.route.view);
  const musicOpen = view === 'music'; const playing = useSel((s) => s.music.playing);
  const layout = useMemo(() => railLayout(servers, order, folders), [servers, order, folders]);
  const badges = useSel((s) => Object.keys(s.servers).map((id) => { const u = serverUnread(id); return `${id}:${u.unread ? 1 : 0}:${u.mentions}`; }).join('|'));
  const dmBadge = useSel((s) => Object.values(s.dms).reduce((n, c) => { const u = unreadInfo(c.id); return n + (u.mentions || (u.unread && !s.settings.mutedChannels[c.id] ? 1 : 0)); }, 0));
  const [drag, setDrag] = useState(null); const [over, setOver] = useState(null);
  const info = Object.fromEntries(badges.split('|').filter(Boolean).map((x) => { const [id, u, m] = x.split(':'); return [id, { unread: u === '1', mentions: Number(m) }]; }));

  // drag & drop: the middle of a server lets you drop on it (→ folder), the top / bottom edge reorders
  const zoneFor = (e, target) => {
    const r = e.currentTarget.getBoundingClientRect(); const y = (e.clientY - r.top) / Math.max(1, r.height);
    const canMerge = drag?.kind === 'server' && !(target.kind === 'server' && target.folderId);
    if (canMerge && y > 0.27 && y < 0.73) return 'merge';
    return y < 0.5 ? 'before' : 'after';
  };
  const dnd = {
    drag, over,
    start(e, d) { e.stopPropagation(); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', d.id); setDrag(d); },
    hover(e, target) {
      if (!drag) return; e.preventDefault(); e.stopPropagation();
      if (drag.kind === target.kind && drag.id === target.id) { if (over) setOver(null); return; }
      const key = drag.kind === 'folder' && target.folderId ? { kind: 'folder', id: target.folderId } : target;   // folders only move between top-level entries
      const zone = zoneFor(e, target);
      if (!over || over.kind !== key.kind || over.id !== key.id || over.zone !== zone) setOver({ kind: key.kind, id: key.id, zone, nested: !!target.folderId });
    },
    drop(e, target) {
      e.preventDefault(); e.stopPropagation();
      const d = drag; const zone = over?.zone || zoneFor(e, target); setDrag(null); setOver(null);
      if (d) { const next = applyDrop(layout, d, target, zone); if (next !== layout) saveLayout(next); }
    },
    end() { setDrag(null); setOver(null); },
  };
  return html`<nav class="rail panel" aria-label="Servers">
    <div class=${cx('rail-item', musicOpen && 'active')}>
      <span class="rail-pill"></span>
      <button type="button" class=${cx('rail-btn music glass glass-rail', playing && 'playing')} data-tip=${t('Music')} data-tip-pos="right" aria-label=${t('Music')} aria-pressed=${musicOpen} onClick=${openMusic}>
        ${playing ? html`<span class="eq" aria-hidden="true"><i></i><i></i><i></i><i></i></span>` : html`<${Icon} name="music" size=${24} />`}</button>
    </div>
    <div class="rail-item ${route === '@me' && ['friends', 'dm'].includes(view) ? 'active' : ''}">
      <span class="rail-pill"></span>
      <button type="button" class="rail-btn home glass glass-rail" data-tip=${t('Direct Messages')} data-tip-pos="right" aria-label="Home" onClick=${() => go(state.route.view === 'dm' ? '/channels/@me' : (state.settings.lastChannel['@me'] ? `/channels/@me/${state.settings.lastChannel['@me']}` : '/channels/@me'))}><${Logo} size=${30} bg="var(--text)" />
        ${dmBadge ? html`<span class="rail-badge">${dmBadge > 99 ? '99+' : dmBadge}</span>` : null}</button>
    </div>
    <div class="rail-sep"></div>
    ${layout.map((it) => (it.kind === 'folder'
      ? html`<${FolderItem} key=${it.id} folder=${it} info=${info} route=${route} dnd=${dnd} />`
      : html`<${ServerButton} key=${it.id} id=${it.id} active=${route === it.id} unread=${info[it.id]?.unread} mentions=${info[it.id]?.mentions || 0} dnd=${dnd} />`))}
    <div class="rail-item"><button type="button" class="rail-btn add glass glass-rail" data-tip=${t('Add a Server')} data-tip-pos="right" aria-label="Add a server" onClick=${() => openModal('add-server')}><${Icon} name="plus" size=${24} sw=${2.4} /></button></div>
  </nav>`;
}
void openSettings; void unreadInfo; void ColorSwatch;
