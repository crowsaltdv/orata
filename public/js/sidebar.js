// Orate — left sidebar: DM list (home) and channel list (server).
import { html, useState, useMemo, cx, memo, useRef } from '/js/lib.js';
import { state, useSel, go, goDm, goChannel, openModal, openContext, openPopover, updateSettings, unreadInfo, hasPerm, hasChannelPerm, getChannel, dmName, dmUserId, toast, isMuted } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { Avatar, Badge, StatusDot, ServerIcon, confirmDialog, POPOVERS } from '/js/ui.js';
import { ackChannel, markServerRead, openSettings, act, openDm } from '/js/actions.js';
import { api } from '/js/api.js';
import { serverMenu } from '/js/rail.js';
import { voice } from '/js/voice.js';
import { copyText, cmpId } from '/js/lib.js';
import { t } from '/js/i18n.js';

/* ------------------------------------------------------------------ DM list */
export function dmMenu(ch) {
  const other = dmUserId(ch); const muted = !!state.settings.mutedChannels[ch.id];
  return [
    { label: t('Mark As Read'), icon: 'check', onClick: () => ackChannel(ch.id) },
    ch.type === 'dm' && { label: t('Profile'), icon: 'user', onClick: () => openProfile(other) },
    { label: muted ? t('Unmute Conversation') : t('Mute Conversation'), icon: muted ? 'bell' : 'bell-off', onClick: () => updateSettings({ mutedChannels: { [ch.id]: !muted } }) },
    { type: 'sep' },
    ch.type === 'dm' ? { label: t('Close DM'), icon: 'x', onClick: () => act(api.del(`/channels/${ch.id}`)) } : { label: t('Leave Group'), icon: 'log-out', danger: true, onClick: async () => { if (await confirmDialog({ title: 'Leave group?', body: `You will no longer receive messages from ${dmName(ch)}.`, confirmLabel: 'Leave', danger: true })) act(api.del(`/channels/${ch.id}`)); } },
    { label: t('Copy Channel ID'), icon: 'copy', onClick: () => copyText(ch.id) },
  ];
}
export function openProfile(userId, anchor) {
  if (anchor) openPopover(anchor, 'profile', { userId, serverId: state.route.serverId !== '@me' ? state.route.serverId : null }, { placement: 'right' });
  else openModal('profile', { userId, serverId: state.route.serverId !== '@me' ? state.route.serverId : null });
}

const DmItem = memo(function DmItem({ id, active }) {
  const ch = useSel((s) => s.dms[id]);
  const other = ch?.type === 'dm' ? ch.recipients.find((r) => r !== state.me?.id) : null;
  const user = useSel((s) => (other ? s.users[other] : null));
  const names = useSel((s) => (ch?.type === 'group' ? dmName(ch) : user?.displayName));
  const info = useSel((s) => { const u = unreadInfo(id); return `${u.unread ? 1 : 0}:${u.mentions}`; });
  const muted = useSel((s) => !!s.settings.mutedChannels[id]);
  if (!ch) return null;
  const [unread, mentions] = info.split(':'); const isUnread = unread === '1' && !muted;
  return html`<div class=${cx('dm-item', active && 'active', isUnread && 'unread')} role="button" tabindex="0" onClick=${() => goDm(id)} onKeyDown=${(e) => e.key === 'Enter' && goDm(id)} onContextMenu=${(e) => openContext(e, dmMenu(ch))}>
    ${ch.type === 'group'
      ? html`<span class="group-av">${ch.icon ? html`<img src=${ch.icon} alt="" />` : html`<${Icon} name="users" size=${19} />`}</span>`
      : html`<${Avatar} user=${user} size=${36} status=${user?.status || 'offline'} />`}
    <span class="dm-text">
      <span class="dm-name"><span>${names}</span></span>
      <span class="dm-sub">${ch.type === 'group' ? `${ch.recipients.length} Members` : user?.customStatus ? `${user.customStatus.emoji || ''} ${user.customStatus.text}`.trim() : ''}</span>
    </span>
    ${Number(mentions) ? html`<${Badge} n=${Number(mentions)} />` : null}
    <button type="button" class="dm-close" aria-label="Close DM" onClick=${(e) => { e.stopPropagation(); ch.type === 'dm' ? act(api.del(`/channels/${id}`)) : openContext(e, dmMenu(ch)); }}><${Icon} name=${ch.type === 'dm' ? 'x' : 'more-h'} size=${14} /></button>
  </div>`;
});

export function DmSidebar() {
  const dms = useSel((s) => s.dms);
  const lastMsg = useSel((s) => s.lastMsg);
  const view = useSel((s) => s.route.view); const chId = useSel((s) => s.route.channelId);
  const sorted = useMemo(() => Object.values(dms).sort((a, b) => cmpId(lastMsg[b.id] || String(b.createdAt * 1000 || 0), lastMsg[a.id] || String(a.createdAt * 1000 || 0))), [dms, lastMsg]);
  const requests = useSel((s) => Object.values(s.relationships).filter((r) => r === 'incoming').length);
  const nav = (v, icon, label, extra) => html`<button type="button" class=${cx('nav-item glass glass-nav', view === v && 'active')} onClick=${() => go(v === 'friends' ? '/channels/@me' : '/' + v)}><${Icon} name=${icon} size=${21} />${label}${extra}</button>`;
  return html`<aside class="sidebar panel" aria-label="Direct messages">
    <div class="sb-top"><button type="button" class="sb-search glass glass-nav" onClick=${() => state.quick || import('/js/store.js').then((m) => m.set({ quick: true }))}>${t('Find or start a conversation')}</button></div>
    <div class="sb-nav">
      ${nav('friends', 'users', t('Friends'), requests ? html`<${Badge} n=${requests} class="nav-badge" />` : null)}
    </div>
    <div class="sb-section"><span>${t('Direct Messages')}</span><button type="button" data-tip=${t('Create DM')} onClick=${() => openModal('create-dm')} aria-label="Create DM"><${Icon} name="plus" size=${16} sw=${2.4} /></button></div>
    <div class="sb-scroll">
      ${sorted.length ? sorted.map((c) => html`<${DmItem} key=${c.id} id=${c.id} active=${view === 'dm' && chId === c.id} />`) : html`<div class="empty small"><p>${t('No conversations yet. Add a friend or press Ctrl+K to start one.')}</p></div>`}
    </div>
  </aside>`;
}

/* ------------------------------------------------------------------ channel list */
export function channelMenu(ch) {
  const server = state.servers[ch.serverId]; const muted = !!state.settings.mutedChannels[ch.id];
  const canManage = hasChannelPerm(ch, 'MANAGE_CHANNELS'); const canPerms = Array.isArray(ch.overwrites);
  if (ch.type === 'category') return [
    { label: state.settings.collapsed[ch.id] ? t('Expand Category') : t('Collapse Category'), icon: 'chevron-down', onClick: () => updateSettings({ collapsed: { [ch.id]: !state.settings.collapsed[ch.id] } }) },
    canManage && { label: t('Create Channel'), icon: 'plus', onClick: () => openModal('create-channel', { serverId: ch.serverId, parentId: ch.id }) },
    (canManage || canPerms) && { label: t('Edit Category'), icon: 'edit', onClick: () => openModal('edit-channel', { channelId: ch.id }) },
    canPerms && { label: t('Edit Permissions'), icon: 'shield', onClick: () => openModal('edit-channel', { channelId: ch.id, tab: 'permissions' }) },
    canManage && { label: t('Delete Category'), icon: 'trash', danger: true, onClick: () => deleteChannel(ch) },
  ];
  return [
    ch.type === 'text' && { label: t('Mark As Read'), icon: 'check', onClick: () => ackChannel(ch.id) },
    ch.type === 'voice' && { label: t('Join Voice'), icon: 'volume', onClick: () => { voice.join(ch.id); goChannel(ch.serverId, ch.id); } },
    { label: muted ? t('Unmute Channel') : t('Mute Channel'), icon: muted ? 'bell' : 'bell-off', onClick: () => updateSettings({ mutedChannels: { [ch.id]: !muted } }) },
    { label: t('Copy Link'), icon: 'link', onClick: async () => { await copyText(`${location.origin}/channels/${ch.serverId}/${ch.id}`); toast('Link copied', 'success', 1500); } },
    hasChannelPerm(ch, 'CREATE_INVITE') && { label: t('Invite People'), icon: 'user-plus', onClick: () => openModal('invite', { serverId: ch.serverId }) },
    (canManage || canPerms) && { type: 'sep' },
    (canManage || canPerms) && { label: t('Edit Channel'), icon: 'settings', onClick: () => openModal('edit-channel', { channelId: ch.id }) },
    canPerms && { label: t('Edit Permissions'), icon: 'shield', onClick: () => openModal('edit-channel', { channelId: ch.id, tab: 'permissions' }) },
    canManage && { label: t('Delete Channel'), icon: 'trash', danger: true, onClick: () => deleteChannel(ch) },
    state.settings.advanced.devMode && { label: t('Copy Channel ID'), icon: 'copy', onClick: () => copyText(ch.id) },
    void server,
  ];
}
export async function deleteChannel(ch) {
  if (await confirmDialog({ title: `Delete ${ch.type === 'category' ? 'Category' : 'Channel'}`, body: `Are you sure you want to delete ${ch.type === 'category' ? ch.name : '#' + ch.name}? This cannot be undone.`, confirmLabel: 'Delete', danger: true })) act(api.del(`/channels/${ch.id}`));
}

function VoiceUsers({ channelId, serverId }) {
  const room = useSel((s) => s.voice.states[channelId]);
  const speaking = useSel((s) => s.voice.speaking);
  const users = useSel((s) => s.users);
  if (!room) return null;
  const list = Object.values(room);
  return html`<div class="vc-users">${list.map((st) => { const u = users[st.userId]; return html`<div class="vc-user" key=${st.userId} onClick=${(e) => openProfile(st.userId, e.currentTarget)} onContextMenu=${(e) => openContext(e, [{ label: 'Profile', icon: 'user', onClick: () => openProfile(st.userId) }])}>
      <${Avatar} user=${u} size=${22} speaking=${!!speaking?.[st.userId] && !st.muted} />
      <span class="vc-name">${(serverId && state.servers[serverId]?.members.find((m) => m.id === st.userId)?.nick) || u?.displayName}</span>
      <span class="vc-ic">${st.screen ? html`<span class="live">LIVE</span>` : st.video ? html`<${Icon} name="video" size=${14} />` : null}${st.deafened ? html`<${Icon} name="headphones-off" size=${14} />` : st.muted ? html`<${Icon} name="mic-off" size=${14} />` : null}</span></div>`; })}</div>`;
}

const ChannelItem = memo(function ChannelItem({ ch, active, serverId }) {
  const info = useSel((s) => { const u = unreadInfo(ch.id); return `${u.unread ? 1 : 0}:${u.mentions}:${isMuted(ch) ? 1 : 0}`; });
  const [unread, mentions, muted] = info.split(':');
  const inCall = useSel((s) => s.voice.conn?.channelId === ch.id);
  const isVoice = ch.type === 'voice';
  const click = () => { if (isVoice) { if (!inCall) voice.join(ch.id); } goChannel(serverId, ch.id); };
  return html`<div>
    <div class=${cx('ch-item', active && 'active', unread === '1' && muted === '0' && 'unread', muted === '1' && 'muted', inCall && 'in-call')} role="button" tabindex="0" onClick=${click} onKeyDown=${(e) => e.key === 'Enter' && click()} onContextMenu=${(e) => openContext(e, channelMenu(ch))}>
      <${Icon} name=${isVoice ? 'volume' : ch.type === 'forum' ? 'forum' : ch.private ? 'hash-lock' : 'hash'} size=${19} class="ch-icon" />
      <span class="ch-name">${ch.name}</span>
      ${Number(mentions) ? html`<${Badge} n=${Number(mentions)} />` : null}
      <span class="ch-actions">
        ${hasChannelPerm(ch, 'CREATE_INVITE') ? html`<span data-tip="Create Invite" onClick=${(e) => { e.stopPropagation(); openModal('invite', { serverId, channelId: ch.id }); }}><${Icon} name="user-plus" size=${15} /></span>` : null}
        ${hasChannelPerm(ch, 'MANAGE_CHANNELS') || Array.isArray(ch.overwrites) ? html`<span data-tip="Edit Channel" onClick=${(e) => { e.stopPropagation(); openModal('edit-channel', { channelId: ch.id }); }}><${Icon} name="settings" size=${15} /></span>` : null}
      </span>
    </div>
    ${isVoice ? html`<${VoiceUsers} channelId=${ch.id} serverId=${serverId} />` : null}
  </div>`;
});

export function ChannelSidebar() {
  const sid = useSel((s) => s.route.serverId); const chId = useSel((s) => s.route.channelId);
  const server = useSel((s) => s.servers[sid]);
  const collapsed = useSel((s) => s.settings.collapsed);
  const activeForum = useSel((s) => s.channelIndex[s.route.channelId]?.forumId);   // while a post is open its forum stays highlighted
  const [menuOpen, setMenuOpen] = useState(false); const hdr = useRef(null);
  const groups = useMemo(() => {
    if (!server) return [];
    const cats = server.channels.filter((c) => c.type === 'category').sort((a, b) => a.position - b.position);
    const rest = server.channels.filter((c) => c.type !== 'category');
    const g = []; const loose = rest.filter((c) => !c.parentId || !cats.some((x) => x.id === c.parentId)).sort((a, b) => a.position - b.position);
    if (loose.length) g.push({ cat: null, items: loose });
    for (const c of cats) g.push({ cat: c, items: rest.filter((x) => x.parentId === c.id).sort((a, b) => a.position - b.position) });
    return g;
  }, [server]);
  if (!server) return null;
  const openMenu = (e) => { e.stopPropagation(); setMenuOpen(true); const rect = e.currentTarget.getBoundingClientRect(); openContext({ clientX: rect.left + 8, clientY: rect.bottom + 6, preventDefault() {}, stopPropagation() {} }, serverMenu(server)); setTimeout(() => setMenuOpen(false), 0); };
  return html`<aside class="sidebar panel" aria-label="Channels">
    <button type="button" class=${cx('sb-header', menuOpen && 'open', server.banner && 'has-banner')} ref=${hdr} onClick=${openMenu}>
      ${server.banner ? html`<span class="banner" style=${{ backgroundImage: `url("${server.banner}")` }}></span>` : null}
      <span class="sbh-name">${server.name}</span><${Icon} name="chevron-down" size=${18} />
    </button>
    <div class="sb-scroll" style="padding-top:2px">
      ${groups.map(({ cat, items }) => html`<div key=${cat?.id || 'loose'}>
        ${cat ? html`<div class=${cx('cat-head', collapsed[cat.id] && 'collapsed')} role="button" tabindex="0" onClick=${() => updateSettings({ collapsed: { [cat.id]: !collapsed[cat.id] } }, { sync: false })} onContextMenu=${(e) => openContext(e, channelMenu(cat))}>
          <${Icon} name="chevron-down" size=${13} sw=${3} /><span>${cat.name}</span>
          ${hasChannelPerm(cat, 'MANAGE_CHANNELS') ? html`<span class="cat-add" data-tip="Create Channel" onClick=${(e) => { e.stopPropagation(); openModal('create-channel', { serverId: server.id, parentId: cat.id }); }}><${Icon} name="plus" size=${16} sw=${2.4} /></span>` : null}</div>` : null}
        <div class=${cx('ch-list', cat && collapsed[cat.id] && 'collapsed')}><div>${items.map((c) => html`<${ChannelItem} key=${c.id} ch=${c} active=${chId === c.id || activeForum === c.id} serverId=${server.id} />`)}</div></div>
      </div>`)}
      ${!server.channels.length ? html`<div class="empty small"><p>No channels yet.</p></div>` : null}
    </div>
  </aside>`;
}
void ServerIcon; void StatusDot; void POPOVERS; void openDm; void markServerRead; void openSettings; void getChannel; void go;
