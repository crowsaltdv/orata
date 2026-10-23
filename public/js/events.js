// Orata — gateway event handlers, session lifecycle (login / logout / bootstrap).
import { state, set, rebuildIndex, addUsers, getChannel, toast, go, parseRoute, resolveRoute, updateSettings, dmName, nameOf, isMuted, notify, subscribe } from '/js/store.js';
import { api, gateway, hooks } from '/js/api.js';
import { ls, lsRemove, cmpId } from '/js/lib.js';
import { DEFAULT_SETTINGS, deepMerge, migrateSettings } from '/js/defaults.js';
import { mapMessage, patchEntry, applyReaction, loadMessages, ackChannel } from '/js/actions.js';
import { playSound, startRing, stopRing } from '/js/sound.js';
import { stopMusic } from '/js/music.js';
import { ensurePost } from '/js/forum.js';

/* ------------------------------------------------------------ session */
export async function login(loginName, password) {
  const r = await api.post('/auth/login', { login: loginName, password });
  await startSession(r.token);
}
/** Resolves undefined once signed in, or `{ verify: true, ticket, email, mode, resendIn }` when an emailed code must be typed first. */
export async function register(payload) {
  const r = await api.post('/auth/register', payload);
  if (r.verify) return r;
  await startSession(r.token);
}
/** Step 2 of a verified sign-up: the code from the email creates the account. */
export async function confirmRegistration(ticket, code) {
  const r = await api.post('/auth/register/confirm', { ticket, code });
  await startSession(r.token);
}
export const resendRegistrationCode = (ticket) => api.post('/auth/register/resend', { ticket });
export async function startSession(token) {
  ls('token', null, token);
  set({ token, phase: 'loading' });
  gateway.connect();
}
/** Forgets everything about the signed-in account in memory (not on the device's account list). */
function clearSession() {
  stopMusic({ silent: true });
  gateway.disconnect(); lsRemove('token');
  set({
    token: null, phase: 'auth', gated: false, verifyDismissed: false, me: null, users: {}, servers: {}, dms: {}, relationships: {}, channelIndex: {}, msgs: {}, reads: {}, lastMsg: {}, typing: {}, viewers: {},
    voice: { states: {}, conn: null }, calls: {}, modals: [], ctx: null, popover: null, settingsPage: null, serverSettings: null, panel: state.local.panel, musicOk: null, musicWhy: null, postIndex: {}, postLists: {},
  });
}
export async function logout({ silent } = {}) {
  const leaving = state.token; const meId = state.me?.id;
  try { if (!silent && leaving) await api.post('/auth/logout'); } catch { /* ignore */ }
  const rest = readAccounts().filter((a) => a.token !== leaving && a.id !== meId);
  writeAccounts(rest);
  clearSession();
  if (rest.length) { enter(rest[0]); return; }   // still signed in somewhere else on this device: carry on there
  history.replaceState({}, '', '/login');
  set({ route: { view: 'login', serverId: '@me', channelId: null }, addingFrom: null });
}
// A 401 means the server really does not know this login any more (it was signed out from another device, the password changed, or the
// account was deleted) — sessions never time out by themselves.
hooks.unauthorized = () => { if (state.token) { logout({ silent: true }); } };

/* ------------------------------------------------------------ account switcher (several logins on one device, like Discord) */
const readAccounts = () => { const l = ls('accounts', []); return Array.isArray(l) ? l.filter((a) => a && a.id && a.token) : []; };
function writeAccounts(list) { ls('accounts', null, list); set({ accounts: list.map(({ token, ...a }) => a) }); }
function rememberAccount(user) {
  if (!state.token || !user?.id) return;
  const mine = { id: user.id, token: state.token, username: user.username, displayName: user.displayName, avatar: user.avatar || null };
  const list = readAccounts().filter((a) => a.id === user.id || a.token !== state.token);
  writeAccounts(list.some((a) => a.id === user.id) ? list.map((a) => (a.id === user.id ? mine : a)) : [...list, mine]);
}
function enter(acc) {
  history.replaceState({}, '', '/channels/@me');
  set({ route: { view: 'boot', serverId: '@me', channelId: null }, addingFrom: null });
  return startSession(acc.token);
}
export function switchAccount(id) {
  const acc = readAccounts().find((a) => a.id === id);
  if (!acc || acc.token === state.token) return;
  clearSession(); enter(acc);
}
/** Shows the login screen without signing the current account out; "Back" returns to it. */
export function beginAddAccount() {
  const from = state.me?.id || null;
  clearSession();
  history.replaceState({}, '', '/login');
  set({ addingFrom: from, route: { view: 'login', serverId: '@me', channelId: null } });
}
export function cancelAddAccount() {
  const list = readAccounts(); const acc = list.find((a) => a.id === state.addingFrom) || list[0];
  if (acc) enter(acc); else set({ addingFrom: null });
}
export async function removeAccount(id) {
  const acc = readAccounts().find((a) => a.id === id); if (!acc) return;
  if (acc.token === state.token) return logout();
  try { await fetch('/api/auth/logout', { method: 'POST', headers: { authorization: 'Bearer ' + acc.token } }); } catch { /* offline: it is only forgotten here */ }
  writeAccounts(readAccounts().filter((a) => a.id !== id));
}

/* ------------------------------------------------------------ bootstrap */
function bootstrap(d) {
  const users = {}; for (const u of d.users) users[u.id] = u;
  users[d.user.id] = { ...users[d.user.id], ...d.user };
  const servers = {}; for (const s of d.servers) servers[s.id] = s;
  const dms = {}; for (const c of d.dms) dms[c.id] = c;
  const rel = {}; for (const r of d.relationships) rel[r.id] = r.type;
  const lastMsg = {};
  for (const c of [...d.dms, ...d.servers.flatMap((s) => s.channels)]) if (c.lastMessageId) lastMsg[c.id] = c.lastMessageId;
  const voiceStates = {};
  for (const v of d.voiceStates) (voiceStates[v.channelId] ||= {})[v.userId] = v;

  // settings: the account copy wins on a new device; otherwise push this device's choices up
  const reconnect = state.phase === 'ready';
  let settings = state.settings;
  const remote = d.user.settings || {};
  // an account that has never saved a look (a brand-new sign-up) starts from the default theme, not from whatever this browser had left over
  if (Object.keys(remote).length) settings = deepMerge(DEFAULT_SETTINGS, migrateSettings(remote));
  else if (!reconnect) settings = deepMerge(DEFAULT_SETTINGS, {});
  rememberAccount(d.user); ls('returning', null, true);   // this browser has had an account: from now on the first screen is Log In
  set({
    me: d.user, users, servers, dms, relationships: rel, reads: d.readStates, lastMsg, voice: { ...state.voice, states: voiceStates }, botId: d.botId, settings,
    sessionId: d.connId, phase: 'ready', typing: {}, gated: !!d.gated,
  });
  if (!reconnect) performance.mark?.('orata-ready');   // how long Orata takes to be usable (speed tests: performance.getEntriesByName('orata-ready'))
  ls('settings', null, settings);
  if (!Object.keys(remote).length) updateSettings({}, { sync: true });
  rebuildIndex();
  // a link to a forum post: it isn't in the channel list, so fetch it and go there once we know it
  const deep = parseRoute(location.pathname);
  if (deep.view === 'channel' && deep.channelId && servers[deep.serverId] && !servers[deep.serverId].channels.some((c) => c.id === deep.channelId)) ensurePost(deep.channelId).then((p) => { if (p && p.serverId === deep.serverId) go({ view: 'channel', serverId: p.serverId, channelId: p.id }); });
  const r = resolveRoute(state.route.view === 'login' || state.route.view === 'register' || state.route.view === 'boot' ? parseRoute(location.pathname) : state.route);
  if (r.view !== 'verify' && (!reconnect || !getChannel(state.route.channelId))) go(r.view === 'login' || r.view === 'register' ? { view: 'friends', serverId: '@me', channelId: null } : r, { replace: true });
  if (reconnect) { // re-sync whatever is on screen after a dropped connection
    for (const chId of Object.keys(state.msgs)) if (state.msgs[chId].loaded) loadMessages(chId, { force: true });
  }
  if (state.settings.notif.desktop && 'Notification' in window && Notification.permission === 'default') { /* asked from settings, never on load */ }
}
gateway.on('ready', (d) => { bootstrap(d); api.get('/config').then((c) => set({ gifOk: !!c.gifs, musicOk: !!c.music, musicWhy: c.musicWhy || null, discordOk: !!c.discord, maxUpload: c.maxUpload, turn: !!c.turn, emailVerif: { enabled: !!c.emailVerification?.enabled, required: !!c.emailVerification?.required, smtp: !!c.emailVerification?.smtp } })).catch(() => {}); });

/* ------------------------------------------------------------ helpers */
function isMentioned(m, ch) {
  const me = state.me; if (!me) return false;
  if (m.mentions?.includes(me.id) || m.mentionEveryone) return true;
  if (ch.serverId && m.mentionRoles?.length) { const mem = state.servers[ch.serverId]?.members.find((x) => x.id === me.id); return !!mem?.roles.some((r) => m.mentionRoles.includes(r)); }
  return false;
}
function previewText(m) {
  if (m.content) return m.content.replace(/<@!?(\d+)>/g, (_, id) => '@' + (state.users[id]?.displayName || 'user')).replace(/<#(\d+)>/g, (_, id) => '#' + (getChannel(id)?.name || 'channel')).replace(/[*_~`|>]/g, '').slice(0, 140);
  if (m.forward) return 'forwarded a message';
  if (m.poll) return 'started a poll: ' + m.poll.question; if (m.theme) return 'shared a theme'; if (m.gif) return 'sent a GIF'; if (m.sticker) return 'sent a sticker'; if (m.attachments?.length) return m.attachments.length > 1 ? `sent ${m.attachments.length} attachments` : 'sent an attachment';
  return '';
}
function notifyMessage(m, ch, mentioned) {
  const n = state.settings.notif; if (state.me.status === 'dnd') return;
  const dm = !ch.serverId;
  const wants = dm ? !n.mentionsOnly || mentioned : mentioned;
  if (!wants || isMuted(ch)) return;
  const here = state.route.channelId === ch.id && state.focused && !document.hidden;
  if (here) return;
  playSound(mentioned ? 'mention' : 'message');
  if (n.desktop && 'Notification' in window && Notification.permission === 'granted' && (!state.focused || document.hidden)) {
    const author = m.bridge?.name || nameOf(m.authorId, ch.serverId);
    const title = dm ? (ch.type === 'group' ? `${author} · ${dmName(ch)}` : author) : `${author} (#${ch.name}, ${state.servers[ch.serverId]?.name})`;
    try {
      const note = new Notification(title, { body: previewText(m), icon: m.bridge?.avatar || state.users[m.authorId]?.avatar || '/img/icon-192.png', tag: ch.id, silent: true });
      note.onclick = () => { window.focus(); go(dm ? { view: 'dm', serverId: '@me', channelId: ch.id } : { view: 'channel', serverId: ch.serverId, channelId: ch.id }); note.close(); };
    } catch { /* ignore */ }
  }
}

/* ------------------------------------------------------------ messages */
gateway.on('message_create', ({ message: m, users }) => {
  addUsers(users);
  const ch = getChannel(m.channelId); if (!ch) return;
  if (state.dms[ch.id]) setDmRead(ch.id, m.authorId, m.id);   // whoever writes has read everything before it
  const prevLast = state.lastMsg[ch.id];
  if (!prevLast || cmpId(m.id, prevLast) > 0) state.lastMsg = { ...state.lastMsg, [ch.id]: m.id };
  const e = state.msgs[ch.id];
  if (e?.loaded && !e.hasNewer) {
    patchEntry(ch.id, (cur) => {
      const idx = m.nonce ? cur.list.findIndex((x) => x.nonce === m.nonce) : -1;
      if (idx >= 0) return { ...cur, list: cur.list.map((x, i) => (i === idx ? m : x)) };
      if (cur.list.some((x) => x.id === m.id)) return cur;
      return { ...cur, list: [...cur.list, m] };
    });
  }
  // typing stops when a message lands
  const t = state.typing[ch.id];
  if (t?.[m.authorId]) { const nt = { ...t }; delete nt[m.authorId]; state.typing = { ...state.typing, [ch.id]: nt }; }
  const mine = m.authorId === state.me.id;
  if (mine) { if (!state.reads[ch.id] || cmpId(m.id, state.reads[ch.id].lastRead || '0') > 0) state.reads = { ...state.reads, [ch.id]: { lastRead: m.id, mentions: 0 } }; notify(); return; }
  const mentioned = isMentioned(m, ch);
  const viewing = state.route.channelId === ch.id && state.focused;
  if (!viewing && mentioned && !isMuted(ch)) state.reads = { ...state.reads, [ch.id]: { ...state.reads[ch.id], mentions: (state.reads[ch.id]?.mentions || 0) + 1 } };
  if (m.type === 'default' || m.type === undefined) notifyMessage(m, ch, mentioned);
  if (viewing) ackChannel(ch.id);
  notify();
});
gateway.on('message_update', ({ message: m }) => mapMessage(m.channelId, m.id, () => m));
gateway.on('message_delete', ({ channelId, messageId }) => {
  const e = state.msgs[channelId]; if (!e) return;
  patchEntry(channelId, { ...e, list: e.list.filter((x) => x.id !== messageId) });
  if (state.lastMsg[channelId] === messageId) { const l = (state.msgs[channelId]?.list || []).slice(-1)[0]; state.lastMsg = { ...state.lastMsg, [channelId]: l?.id || null }; }
});
gateway.on('reaction_add', ({ channelId, messageId, emoji, userId }) => mapMessage(channelId, messageId, (m) => applyReaction(m, emoji, userId, true)));
gateway.on('reaction_remove', ({ channelId, messageId, emoji, userId }) => mapMessage(channelId, messageId, (m) => applyReaction(m, emoji, userId, false)));
gateway.on('typing', ({ channelId, userId }) => {
  const cur = state.typing[channelId] || {};
  set({ typing: { ...state.typing, [channelId]: { ...cur, [userId]: Date.now() + 9000 } } });
});
gateway.on('read_ack', ({ channelId, lastRead, mentions }) => set({ reads: { ...state.reads, [channelId]: { lastRead, mentions } } }));
/* how far each member of a DM or group has read (messagelist.js puts their faces on the newest message they've seen) */
function setDmRead(chId, userId, id) {
  const d = state.dms[chId]; const cur = d?.reads?.[userId]; if (!d || (cur && cmpId(cur, id) >= 0)) return;
  state.dms = { ...state.dms, [chId]: { ...d, reads: { ...d.reads, [userId]: id } } };
}
gateway.on('dm_read', ({ channelId, userId, lastRead }) => { if (lastRead) { setDmRead(channelId, userId, lastRead); notify(); } });
/* who else is looking at the channel you have open (composer.js shows their faces): the gateway is told which channel this tab shows */
let viewSent;
function sendView() {
  const r = state.route; const id = document.visibilityState === 'visible' && (r.view === 'dm' || r.view === 'channel') ? r.channelId || null : null;
  if (id !== viewSent && gateway.send('view', { channelId: id })) { viewSent = id; state.viewers = {}; }
}
subscribe(sendView); document.addEventListener('visibilitychange', sendView);
gateway.on('ready', () => { viewSent = undefined; sendView(); });
gateway.on('viewers', ({ channelId, users }) => { addUsers(users); set({ viewers: { ...state.viewers, [channelId]: users.map((u) => u.id) } }); });
setInterval(() => {
  const now = Date.now(); let changed = false; const next = {};
  for (const [ch, users] of Object.entries(state.typing)) {
    const keep = {}; for (const [u, t] of Object.entries(users)) if (t > now) keep[u] = t; else changed = true;
    next[ch] = keep;
  }
  if (changed) set({ typing: next });
}, 1500);

/* ------------------------------------------------------------ users & presence */
gateway.on('presence_update', ({ userId, status, customStatus, listening }) => {
  const u = state.users[userId]; if (!u) return;
  set({ users: { ...state.users, [userId]: { ...u, status, customStatus, ...(listening !== undefined ? { listening } : null) } } });
});
gateway.on('user_update', ({ user }) => addUsersNotify([user]));
gateway.on('self_update', ({ user }) => { set({ me: { ...state.me, ...user } }); rememberAccount(state.me); addUsersNotify([user]); });
gateway.on('themes_update', () => set({ themesRev: state.themesRev + 1 }));   // another device changed the theme library (themes.js reloads it when open)
gateway.on('settings_update', ({ settings }) => { const next = deepMerge(DEFAULT_SETTINGS, migrateSettings(settings)); set({ settings: next }); ls('settings', null, next); });
function addUsersNotify(list) { addUsers(list); notify(); }

/* ------------------------------------------------------------ servers / channels / members */
gateway.on('server_create', ({ server, users }) => { addUsers(users); set({ servers: { ...state.servers, [server.id]: server } }); rebuildIndex(); });
gateway.on('server_update', ({ server }) => {
  if (!state.servers[server.id]) return;
  const lastMsg = { ...state.lastMsg }; for (const c of server.channels) if (c.lastMessageId && !lastMsg[c.id]) lastMsg[c.id] = c.lastMessageId;   // channels that just became visible
  set({ servers: { ...state.servers, [server.id]: server }, lastMsg }); rebuildIndex();
  if (state.route.serverId === server.id && state.route.channelId && !server.channels.some((c) => c.id === state.route.channelId)) go({ view: 'channel', serverId: server.id, channelId: null });   // its permissions changed: you can no longer see it
});
gateway.on('server_delete', ({ serverId }) => {
  const servers = { ...state.servers }; delete servers[serverId];
  set({ servers }); rebuildIndex();
  if (state.route.serverId === serverId) go('/channels/@me');
  if (state.serverSettings?.id === serverId) set({ serverSettings: null });
});
const patchServer = (id, fn) => { const s = state.servers[id]; if (s) { set({ servers: { ...state.servers, [id]: fn(s) } }); rebuildIndex(); } };
gateway.on('channel_create', ({ channel }) => patchServer(channel.serverId, (s) => ({ ...s, channels: s.channels.some((c) => c.id === channel.id) ? s.channels : [...s.channels, channel].sort((a, b) => a.position - b.position) })));
gateway.on('channel_update', ({ channel }) => patchServer(channel.serverId, (s) => ({ ...s, channels: s.channels.some((c) => c.id === channel.id) ? s.channels.map((c) => (c.id === channel.id ? { ...c, ...channel, lastMessageId: c.lastMessageId } : c)) : [...s.channels, channel] })));
gateway.on('channel_delete', ({ serverId, channelId }) => {
  patchServer(serverId, (s) => ({ ...s, channels: s.channels.filter((c) => c.id !== channelId) }));
  if (state.route.channelId === channelId) go({ view: 'channel', serverId, channelId: null });
});
gateway.on('member_add', ({ serverId, member, user }) => { addUsers([user]); patchServer(serverId, (s) => ({ ...s, members: s.members.some((m) => m.id === member.id) ? s.members : [...s.members, member] })); });
gateway.on('member_remove', ({ serverId, userId }) => patchServer(serverId, (s) => ({ ...s, members: s.members.filter((m) => m.id !== userId) })));
gateway.on('member_update', ({ serverId, member }) => patchServer(serverId, (s) => ({ ...s, members: s.members.map((m) => (m.id === member.id ? member : m)) })));

/* ------------------------------------------------------------ DMs & relationships */
function putDm(channel, users) { addUsers(users); set({ dms: { ...state.dms, [channel.id]: { ...state.dms[channel.id], ...channel } } }); rebuildIndex(); if (channel.lastMessageId && !state.lastMsg[channel.id]) state.lastMsg = { ...state.lastMsg, [channel.id]: channel.lastMessageId }; }
gateway.on('dm_create', ({ channel, users }) => putDm(channel, users));
gateway.on('dm_open', ({ channel, users }) => putDm(channel, users));
gateway.on('dm_update', ({ channel, users }) => putDm(channel, users));
gateway.on('dm_close', ({ channelId }) => {
  const dms = { ...state.dms }; delete dms[channelId]; set({ dms }); rebuildIndex();
  if (state.route.channelId === channelId) go('/channels/@me');
});
gateway.on('relationship_update', ({ id, type, user }) => {
  if (user) addUsers([user]);
  const rel = { ...state.relationships }; if (type) rel[id] = type; else delete rel[id];
  set({ relationships: rel });
  if (type === 'incoming') { playSound('message'); toast(`${state.users[id]?.displayName || 'Someone'} sent you a friend request`, 'info'); }
});

/* ------------------------------------------------------------ voice state + calls */
gateway.on('voice_state_update', ({ channelId, userId, state: st }) => {
  const room = { ...(state.voice.states[channelId] || {}) };
  if (st) room[userId] = st; else delete room[userId];
  const states = { ...state.voice.states, [channelId]: room }; if (!Object.keys(room).length) delete states[channelId];
  set({ voice: { ...state.voice, states } });
  if (state.voice.conn?.channelId === channelId && userId !== state.me.id) playSound(st ? 'join' : 'leave');
});
gateway.on('call_ring', ({ channelId, from, users }) => {
  addUsers(users);
  if (state.me.status === 'dnd' || state.voice.conn) return;
  set({ calls: { ...state.calls, [channelId]: { from, at: Date.now() } } }); startRing();
  setTimeout(() => dismissCall(channelId), 45000);
});
gateway.on('call_end', ({ channelId }) => dismissCall(channelId));
export function dismissCall(channelId) {
  if (!state.calls[channelId]) return;
  const calls = { ...state.calls }; delete calls[channelId]; set({ calls });
  if (!Object.keys(calls).length) stopRing();
}

/* ------------------------------------------------------------ idle detection */
let idleTimer = null;
function setIdle(v) { if (state.idle !== v) { state.idle = v; gateway.send('idle', { idle: v }); } }
function bump() { setIdle(false); clearTimeout(idleTimer); idleTimer = setTimeout(() => setIdle(true), 5 * 60_000); }
for (const ev of ['mousemove', 'keydown', 'pointerdown', 'wheel', 'touchstart']) window.addEventListener(ev, bump, { passive: true });
document.addEventListener('visibilitychange', bump);
bump();
