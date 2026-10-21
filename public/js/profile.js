// Orata — profile card (popout, side panel and full modal) + user context menus.
import { html, useState, useEffect, cx, formatMemberSince, copyText, avatarColor } from '/js/lib.js';
import { state, set, useSel, openModal, closeModal, closePopover, openContext, toast, hasPerm, memberOf, topRole, nameOf, goDm, isOwnerOf } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { Avatar, Btn, IconBtn, MODALS, POPOVERS, Modal, Spinner, TextInput, confirmDialog } from '/js/ui.js';
import { api } from '/js/api.js';
import { act, openDm } from '/js/actions.js';
import { renderMarkdown } from '/js/markdown.js';
import { t } from '/js/i18n.js';
import { ListeningCard, myListening } from '/js/music.js';
import { cardLook, CardDecor, NameText, useProfileFonts } from '/js/profile-style.js';
import { Badges, isDev } from '/js/badges.js';
import { ServerTag } from '/js/server-tag.js';

const cache = new Map();
function useProfile(userId) {
  const [d, setD] = useState(cache.get(userId) || null);
  useEffect(() => {
    let live = true; setD(cache.get(userId) || null);
    api.get(`/users/${userId}`).then((r) => { cache.set(userId, r); if (live) setD(r); }).catch(() => {});
    return () => { live = false; };
  }, [userId]);
  return d;
}

export function userMenu(userId, serverId) {
  const me = state.me; const u = state.users[userId]; if (!u) return [];
  const rel = state.relationships[userId]; const self = userId === me.id;
  const server = serverId ? state.servers[serverId] : null; const member = server && memberOf(serverId, userId);
  const items = [
    { label: t('Profile'), icon: 'user', onClick: () => openModal('profile', { userId, serverId }) },
    !self && { label: t('Message'), icon: 'message', onClick: () => openDm(userId) },
    !self && !u.bot && { type: 'sep' },
    !self && !u.bot && (rel === 'friend' ? { label: t('Remove Friend'), icon: 'user-minus', onClick: () => act(api.del(`/relationships/${userId}`), { success: 'Friend removed' }) }
      : rel === 'incoming' ? { label: t('Accept Friend Request'), icon: 'user-check', onClick: () => act(api.put(`/relationships/${userId}`)) }
        : rel === 'outgoing' ? { label: t('Cancel Friend Request'), icon: 'user-x', onClick: () => act(api.del(`/relationships/${userId}`)) }
          : rel === 'blocked' ? null : { label: t('Add Friend'), icon: 'user-plus', onClick: () => act(api.post('/relationships', { username: u.username }), { success: 'Friend request sent' }) }),
    !self && !u.bot && (rel === 'blocked' ? { label: t('Unblock'), icon: 'ban', onClick: () => act(api.del(`/relationships/${userId}`)) } : { label: t('Block'), icon: 'ban', danger: true, onClick: async () => { if (await confirmDialog({ title: `Block ${u.displayName}?`, body: 'They won’t be able to message you and you won’t see their DMs.', confirmLabel: 'Block', danger: true })) act(api.put(`/relationships/${userId}/block`)); } }),
  ];
  if (server && member && !self) {
    const mine = server.perms;
    const canRoles = hasPerm(serverId, 'MANAGE_ROLES');
    const roles = server.roles.filter((r) => r.id !== server.id);
    items.push({ type: 'sep' });
    if (hasPerm(serverId, 'MANAGE_NICKNAMES')) items.push({ label: t('Change Nickname'), icon: 'edit', onClick: () => openModal('nickname', { serverId, userId }) });
    if (canRoles && roles.length) items.push({ label: t('Roles'), icon: 'tag', submenu: roles.map((r) => ({ label: r.name, checked: member.roles.includes(r.id), onClick: () => act(member.roles.includes(r.id) ? api.del(`/servers/${serverId}/members/${userId}/roles/${r.id}`) : api.put(`/servers/${serverId}/members/${userId}/roles/${r.id}`)) })) });
    if (hasPerm(serverId, 'MODERATE_MEMBERS') && !isOwnerOf(server, userId)) {
      const set = async (minutes) => {
        const r = await act(api.put(`/servers/${serverId}/members/${userId}/timeout`, { minutes }));
        if (r) toast(minutes ? `${u.displayName} was timed out${r.alts ? `, along with ${r.alts} other account${r.alts === 1 ? '' : 's'} of theirs` : ''}` : `Timeout removed${r.alts ? ` (and for ${r.alts} other account${r.alts === 1 ? '' : 's'})` : ''}`, 'success', 3500);
      };
      items.push({ label: t('Timeout'), icon: 'clock', submenu: [
        ...[[1, '60 seconds'], [5, '5 minutes'], [10, '10 minutes'], [60, '1 hour'], [1440, '1 day'], [10080, '1 week']].map(([m, l]) => ({ label: t(l), onClick: () => set(m) })),
        member.timeoutUntil > Date.now() && { label: t('Remove Timeout'), icon: 'x', onClick: () => set(0) },
      ].filter(Boolean) });
    }
    if (hasPerm(serverId, 'KICK_MEMBERS') && !isOwnerOf(server, userId)) items.push({ label: `${t('Kick')} ${u.displayName}`, icon: 'log-out', danger: true, onClick: async () => { if (await confirmDialog({ title: `Kick ${u.displayName}`, body: 'They can rejoin with a new invite.', confirmLabel: 'Kick', danger: true })) act(api.del(`/servers/${serverId}/members/${userId}`), { success: 'Member kicked' }); } });
    if (hasPerm(serverId, 'BAN_MEMBERS') && !isOwnerOf(server, userId)) items.push({ label: `${t('Ban')} ${u.displayName}`, icon: 'ban', danger: true, onClick: () => openModal('ban', { serverId, userId }) });
    void mine;
  }
  if (isDev(me) && !u.bot) items.push({ type: 'sep' }, { label: t('Edit Badges'), icon: 'award', onClick: () => openModal('badges', { userId }) });
  items.push({ type: 'sep' }, { label: t('Copy User ID'), icon: 'copy', onClick: async () => { await copyText(userId); toast('Copied', 'success', 1400); } });
  return items.filter(Boolean);
}

/** A banner picture is shown at the shape it was cropped to (3 : 1), so what you chose in the crop dialog is exactly what shows. `shape={false}` keeps a fixed strip. */
export function Banner({ user, height = 96, server, shape = true }) {
  const style = user.banner ? { backgroundImage: `url("${user.banner}")` } : { background: `linear-gradient(135deg, ${user.bannerColor || avatarColor(user.id)}, ${user.accentColor || 'var(--accent-2)'})` };
  void server;
  return html`<div class="pc-banner" style=${{ ...(user.banner && shape ? { aspectRatio: '3 / 1' } : { height: height + 'px' }), ...style }}></div>`;
}

export function ProfileCard({ userId, serverId, mode = 'popout', onClose, userOverride }) {
  const stateUser = useSel((s) => s.users[userId]); const user = userOverride || stateUser;
  const me = useSel((s) => s.me);
  const rel = useSel((s) => s.relationships[userId]);
  const member = useSel((s) => (serverId ? s.servers[serverId]?.members.find((m) => m.id === userId) : null));
  const server = useSel((s) => (serverId ? s.servers[serverId] : null));
  const d = useProfile(userId); const [msg, setMsg] = useState('');
  useProfileFonts(user?.profile);
  if (!user) return html`<div class="profile-card ${mode}"><div class="pk-center"><${Spinner} /></div></div>`;
  const self = userId === me.id; const nick = member?.nick;
  const roles = member && server ? server.roles.filter((r) => member.roles.includes(r.id)).sort((a, b) => b.position - a.position) : [];
  const cs = user.customStatus;
  const playingNow = useSel((s) => (userId === s.me?.id && s.music.playing ? s.music.track : null));   // your own card follows your player, whatever Activity Status says
  const listening = userId === me.id ? (playingNow ? myListening() : null) : user.listening;
  const bio = user.bio ? renderMarkdown(user.bio, { serverId }) : '';
  const act2 = (fn) => async () => { await fn(); };
  const look = cardLook(user.profile);
  return html`<div class=${cx('profile-card', mode, ...look.cls)} style=${look.style}>
    <${CardDecor} profile=${user.profile} />
    <div class="pc-top"><${Banner} user=${user} height=${mode === 'panel' ? 120 : 98} />
      <div class="pc-actions">
        ${mode === 'popout' || mode === 'panel' ? html`<${IconBtn} icon="more-h" label="More" glass=${null} onClick=${(e) => { const r = e.currentTarget.getBoundingClientRect(); openContext({ clientX: r.left, clientY: r.bottom + 4 }, userMenu(userId, serverId)); }} />` : null}
        ${!self && !user.bot && !rel ? html`<${IconBtn} icon="user-plus" label=${t('Add Friend')} glass=${null} onClick=${act2(() => act(api.post('/relationships', { username: user.username }), { success: 'Friend request sent' }))} />` : null}
        ${!self && rel === 'incoming' ? html`<${IconBtn} icon="user-check" label=${t('Accept Friend Request')} glass=${null} onClick=${act2(() => act(api.put(`/relationships/${userId}`)))} />` : null}
        ${rel === 'friend' ? html`<span class="pc-friend" data-tip="Friends"><${Icon} name="user-check" size=${16} /></span>` : null}
      </div>
      <${Avatar} user=${user} size=${mode === 'panel' ? 96 : 80} status=${user.status} class="pc-avatar" />
    </div>
    <div class="pc-body">
      <div class="pc-name"><${NameText} text=${nick || user.displayName} profile=${user.profile} />${user.bot ? html`<span class="bot-tag">APP</span>` : null}${user.tag ? html`<${ServerTag} tag=${user.tag} />` : null}<${Badges} user=${user} /></div>
      <div class="pc-user">${user.username}${user.pronouns ? html`<i> • ${user.pronouns}</i>` : null}</div>
      ${cs ? html`<div class="pc-status"><span>${cs.emoji}</span>${cs.text}</div>` : null}
      ${listening ? html`<${ListeningCard} listening=${listening} />` : null}
      ${mode === 'panel' && d ? html`<div class="pc-mutual-row">${d.mutualServers.length ? html`<span class="mut-avs">${d.mutualServers.slice(0, 3).map((s) => html`<span class="mut-av" title=${s.name}>${s.icon ? html`<img src=${s.icon} alt="" />` : s.name[0]}</span>`)}</span><span>${d.mutualServers.length} ${t('Mutual Servers')}</span>` : null}</div>` : null}
      ${bio ? html`<div class="pc-section"><h5>${t('About Me')}</h5><div class="pc-bio msg-content" dangerouslySetInnerHTML=${{ __html: bio }}></div></div>` : null}
      ${roles.length ? html`<div class="pc-section"><h5>${roles.length > 1 ? t('Roles') : t('Role')}</h5><div class="pc-roles">${roles.map((r) => html`<span class="role-chip"><i style=${{ background: r.color || 'var(--text-3)' }}></i>${r.name}</span>`)}</div></div>` : null}
      <div class="pc-section"><h5>${t('Orata Member Since')}</h5><div class="pc-since"><${Icon} name="calendar" size=${15} />${formatMemberSince(user.createdAt)}${member ? html`<span class="dot">•</span><${Icon} name="server" size=${14} />${formatMemberSince(member.joinedAt)}` : null}</div></div>
      ${mode !== 'panel' && d && (d.mutualServers.length || d.mutualFriends.length) && mode === 'modal' ? html`<div class="pc-section"><h5>${t('Mutual Servers')} — ${d.mutualServers.length}</h5><div class="pc-list">${d.mutualServers.map((s) => html`<div class="pc-list-item"><span class="mut-av">${s.icon ? html`<img src=${s.icon} alt="" />` : s.name[0]}</span>${s.name}</div>`)}</div></div>
        <div class="pc-section"><h5>${t('Mutual Friends')} — ${d.mutualFriends.length}</h5><div class="pc-list">${d.mutualFriends.map((f) => html`<div class="pc-list-item"><${Avatar} user=${f} size=${26} />${f.displayName}</div>`)}</div></div>` : null}
      ${mode === 'popout' && !self ? html`<div class="pc-msg"><input class="input" placeholder=${`${t('Message')} @${user.username}`} value=${msg} onInput=${(e) => setMsg(e.target.value)} onKeyDown=${async (e) => { if (e.key === 'Enter' && msg.trim()) { const ch = await openDm(userId); if (ch) { const { sendMessage } = await import('/js/actions.js'); const { encodeMentions } = await import('/js/markdown.js'); await sendMessage(ch, { content: encodeMentions(msg.trim(), ch) }); } onClose?.(); closePopover(); } }} /></div>` : null}
      ${mode !== 'modal' ? html`<button type="button" class="pc-view" onClick=${() => { closePopover(); openModal('profile', { userId, serverId }); }}>${t('View Full Profile')}</button>` : null}
      ${mode === 'popout' && self ? html`<button type="button" class="pc-view" onClick=${() => { closePopover(); import('/js/actions.js').then((a) => a.openSettings('profile')); }}>${t('Edit Profile')}</button>` : null}
    </div>
  </div>`;
}

POPOVERS.profile = function ProfilePopout({ userId, serverId, close }) { return html`<div class="pop-card profile-pop"><${ProfileCard} userId=${userId} serverId=${serverId} mode="popout" onClose=${close} /></div>`; };
MODALS.profile = function ProfileModal({ id, userId, serverId }) {
  const user = state.users[userId]; const self = userId === state.me.id; const rel = state.relationships[userId];
  return html`<${Modal} width=${520} flush hideClose onClose=${() => closeModal(id)}>
    <${ProfileCard} userId=${userId} serverId=${serverId} mode="modal" />
    <div class="modal-foot spread">${!self ? html`<${Btn} variant="primary" icon="message" onClick=${() => { closeModal(id); openDm(userId); }}>${t('Send Message')}<//>` : html`<${Btn} variant="primary" icon="edit" onClick=${() => { closeModal(id); import('/js/actions.js').then((a) => a.openSettings('profile')); }}>${t('Edit Profile')}<//>`}
      ${!self && !user?.bot && !rel ? html`<${Btn} icon="user-plus" onClick=${() => act(api.post('/relationships', { username: user.username }), { success: 'Friend request sent' })}>${t('Add Friend')}<//>` : null}
      <${Btn} variant="ghost" onClick=${() => closeModal(id)}>${t('Close')}<//></div>
  <//>`;
};
MODALS.nickname = function NicknameModal({ id, serverId, userId }) {
  const [v, setV] = useState(memberOf(serverId, userId)?.nick || ''); const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); await act(api.patch(`/servers/${serverId}/members/${userId}`, { nick: v })); closeModal(id); };
  return html`<${Modal} title=${t('Change Nickname')} width=${420} onClose=${() => closeModal(id)} footer=${html`<${Btn} variant="ghost" onClick=${() => closeModal(id)}>Cancel<//><${Btn} variant="primary" loading=${busy} onClick=${save}>Save<//>`}>
    <${TextInput} value=${v} onInput=${setV} maxlength="32" placeholder=${state.users[userId]?.displayName} autofocus onKeyDown=${(e) => e.key === 'Enter' && save()} /><//>`;
};
void set; void topRole; void nameOf; void goDm;
