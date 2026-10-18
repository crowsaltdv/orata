// Orate — Friends page (Online / All / Pending / Blocked / Add Friend) and the "Active Now" column.
import { html, useState, useMemo, cx } from '/js/lib.js';
import { state, set, useSel, openContext, toast, openModal } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { Avatar, Btn, IconBtn, Empty, Badge } from '/js/ui.js';
import { api } from '/js/api.js';
import { act, openDm } from '/js/actions.js';
import { openProfile } from '/js/sidebar.js';
import { userMenu } from '/js/profile.js';
import { voice } from '/js/voice.js';
import { copyText } from '/js/lib.js';
import { t } from '/js/i18n.js';

function FriendRow({ id, type }) {
  const u = useSel((s) => s.users[id]);
  const inVoice = useSel((s) => { for (const [chId, room] of Object.entries(s.voice.states)) if (room[id]) return chId; return null; });
  if (!u) return null;
  const sub = type === 'incoming' ? t('Incoming Friend Request') : type === 'outgoing' ? t('Outgoing Friend Request') : type === 'blocked' ? t('Blocked') : u.customStatus ? `${u.customStatus.emoji || ''} ${u.customStatus.text}`.trim() : t(({ online: 'Online', idle: 'Idle', dnd: 'Do Not Disturb', offline: 'Offline' })[u.status] || 'Offline');
  const btn = (icon, label, fn, cls) => html`<button type="button" class=${cx('fr-btn', cls)} data-tip=${label} aria-label=${label} onClick=${(e) => { e.stopPropagation(); fn(e); }}><${Icon} name=${icon} size=${19} /></button>`;
  return html`<div class="friend-row" role="button" tabindex="0" onClick=${(e) => (type === 'friend' ? openDm(id) : openProfile(id, e.currentTarget))} onContextMenu=${(e) => openContext(e, userMenu(id, null))}>
    <${Avatar} user=${u} size=${40} status=${type === 'friend' || type === 'blocked' ? u.status : undefined} />
    <div class="fr-text"><div class="fr-name"><b>${u.displayName}</b><span class="fr-user">${u.username}</span></div><div class="fr-sub">${sub}</div></div>
    <div class="fr-actions">
      ${type === 'friend' ? html`${btn('message', t('Message'), () => openDm(id))}${inVoice ? btn('volume', t('Join voice'), () => { const ch = state.channelIndex[inVoice]; if (ch?.serverId) { voice.join(inVoice); import('/js/store.js').then((m) => m.goChannel(ch.serverId, inVoice)); } }, 'live') : ''}${btn('more-v', t('More'), (e) => { const r = e.currentTarget.getBoundingClientRect(); openContext({ clientX: r.left, clientY: r.bottom + 4 }, userMenu(id, null)); })}` : null}
      ${type === 'incoming' ? html`${btn('check', t('Accept'), () => act(api.put(`/relationships/${id}`)), 'ok')}${btn('x', t('Ignore'), () => act(api.del(`/relationships/${id}`)), 'no')}` : null}
      ${type === 'outgoing' ? btn('x', t('Cancel'), () => act(api.del(`/relationships/${id}`)), 'no') : null}
      ${type === 'blocked' ? btn('user-x', t('Unblock'), () => act(api.del(`/relationships/${id}`)), 'no') : null}
    </div></div>`;
}

function AddFriend() {
  const [name, setName] = useState(''); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState(null);
  const me = useSel((s) => s.me); const users = useSel((s) => s.users); const rel = useSel((s) => s.relationships);
  const suggestions = useMemo(() => Object.values(users).filter((u) => u.id !== me.id && !u.bot && !rel[u.id]).slice(0, 8), [users, rel, me]);
  const send = async (username) => {
    const n = (username ?? name).trim(); if (!n) return; setBusy(true); setMsg(null);
    try { await api.post('/relationships', { username: n }); setMsg({ ok: true, text: `Success! Your friend request to ${n} was sent.` }); setName(''); } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); }
  };
  return html`<div class="add-friend slide-up">
    <h2>${t('Add Friend')}</h2><p>${t('You can add friends with their Orate username.')}</p>
    <div class=${cx('af-input', msg && (msg.ok ? 'ok' : 'err'))}><input placeholder=${t('You can add friends with their Orate username.')} value=${name} onInput=${(e) => { setName(e.target.value); setMsg(null); }} onKeyDown=${(e) => e.key === 'Enter' && send()} autofocus />
      <${Btn} variant="primary" loading=${busy} disabled=${!name.trim()} onClick=${() => send()}>${t('Send Friend Request')}<//></div>
    ${msg ? html`<div class=${cx('af-msg', msg.ok ? 'ok' : 'err')}>${msg.text}</div>` : null}
    <div class="af-me"><span>${t('Your username')}: <b>${me.username}</b></span><button type="button" class="link-btn" onClick=${async () => { await copyText(me.username); toast('Username copied', 'success', 1400); }}>${t('Copy')}</button></div>
    ${suggestions.length ? html`<h4 class="af-sub">${t('People you may know')}</h4><div class="af-sug">${suggestions.map((u) => html`<div class="friend-row sug" key=${u.id}><${Avatar} user=${u} size=${36} status=${u.status} /><div class="fr-text"><div class="fr-name"><b>${u.displayName}</b><span class="fr-user">${u.username}</span></div></div><${Btn} size="sm" variant="primary" onClick=${() => send(u.username)}>${t('Add Friend')}<//></div>`)}</div>` : null}
  </div>`;
}

export function FriendsView() {
  const tab = useSel((s) => s.route.tab || 'online');
  const rel = useSel((s) => s.relationships); const users = useSel((s) => s.users);
  const [q, setQ] = useState('');
  const pendingN = Object.values(rel).filter((r) => r === 'incoming').length;
  const setTab = (tb) => set({ route: { ...state.route, tab: tb } });
  const list = useMemo(() => {
    const ids = Object.keys(rel).filter((id) => users[id]);
    const by = (type) => ids.filter((id) => rel[id] === type);
    let rows;
    if (tab === 'online') rows = by('friend').filter((id) => users[id].status !== 'offline').map((id) => ({ id, type: 'friend' }));
    else if (tab === 'all') rows = by('friend').map((id) => ({ id, type: 'friend' }));
    else if (tab === 'pending') rows = [...by('incoming').map((id) => ({ id, type: 'incoming' })), ...by('outgoing').map((id) => ({ id, type: 'outgoing' }))];
    else if (tab === 'blocked') rows = by('blocked').map((id) => ({ id, type: 'blocked' }));
    else rows = [];
    const term = q.trim().toLowerCase();
    if (term) rows = rows.filter((r) => users[r.id].displayName.toLowerCase().includes(term) || users[r.id].username.includes(term));
    return rows.sort((a, b) => users[a.id].displayName.localeCompare(users[b.id].displayName));
  }, [rel, users, tab, q]);
  const tabs = [['online', 'Online'], ['all', 'All'], ['pending', 'Pending'], ['blocked', 'Blocked']];
  const emptyBy = { online: ['users', t("No one's around to play with Orbit"), t('When friends are online, they’ll show up here.')], all: ['users', t('You have no friends yet'), t('Add someone by username to get started.')], pending: ['inbox', t('There are no pending friend requests.'), t('Here’s a bear for now.')], blocked: ['ban', t("You haven't blocked anyone."), t('Blocked users will show up here.')] };
  return html`<main class="main panel friends-view view-anim">
    <header class="m-header">
      <button type="button" class="mobile-only icon-btn" onClick=${() => set({ mobileNav: true })} aria-label="Menu"><${Icon} name="menu" size=${22} /></button>
      <div class="m-title"><${Icon} name="users" size=${22} /><span class="name">${t('Friends')}</span></div>
      <div class="ft-sep"></div>
      <nav class="friend-tabs">${tabs.map(([k, l]) => html`<button type="button" class=${cx('ftab', tab === k && 'on')} onClick=${() => setTab(k)}>${t(l)}${k === 'pending' && pendingN ? html`<${Badge} n=${pendingN} />` : null}</button>`)}
        <button type="button" class=${cx('ftab add', tab === 'add' && 'on')} onClick=${() => setTab('add')}>${t('Add Friend')}</button></nav>
    </header>
    <div class="friends-body">
      ${tab === 'add' ? html`<${AddFriend} />` : html`<div class="friends-list">
        <div class="pane-search big"><${Icon} name="search" size=${16} /><input placeholder=${t('Search')} value=${q} onInput=${(e) => setQ(e.target.value)} /></div>
        ${list.length ? html`<div class="fl-head">${t(tabs.find((x) => x[0] === tab)?.[1] || '').toUpperCase()} — ${list.length}</div><div class="fl-rows">${list.map((r) => html`<${FriendRow} key=${r.id + r.type} id=${r.id} type=${r.type} />`)}</div>`
          : html`<${Empty} icon=${emptyBy[tab][0]} title=${emptyBy[tab][1]}>${emptyBy[tab][2]}<//>`}
      </div>`}
    </div>
  </main>`;
}

export function ActiveNow() {
  const rel = useSel((s) => s.relationships); const users = useSel((s) => s.users); const vs = useSel((s) => s.voice.states);
  const rows = Object.keys(rel).filter((id) => rel[id] === 'friend' && users[id] && users[id].status !== 'offline').map((id) => {
    const room = Object.entries(vs).find(([, r]) => r[id]); return { u: users[id], room: room ? state.channelIndex[room[0]] : null };
  }).filter((x) => x.room || x.u.customStatus).slice(0, 12);
  return html`<aside class="right panel wide right-enter"><div class="panel-pane"><div class="pane-head"><b>${t('Active Now')}</b></div>
    <div class="pane-scroll">${rows.length ? rows.map(({ u, room }) => html`<div class="active-card" key=${u.id} onClick=${(e) => openProfile(u.id, e.currentTarget)}><${Avatar} user=${u} size=${40} status=${u.status} /><div><b>${u.displayName}</b><span>${room ? html`<${Icon} name="volume" size=${13} /> ${room.name}` : `${u.customStatus.emoji || ''} ${u.customStatus.text}`}</span></div></div>`)
      : html`<div class="active-empty"><b>${t("It's quiet for now…")}</b><p>${t("When a friend starts an activity — like hopping in a voice channel — we'll show it here!")}</p></div>`}</div></div></aside>`;
}
void IconBtn; void openModal;
