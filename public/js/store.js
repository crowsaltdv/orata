// Orata — global reactive store (single mutable root + selector subscriptions).
import { useReducer, useRef, useEffect, ls, uid, debounce, cmpId } from '/js/lib.js';
import { DEFAULT_SETTINGS, DEFAULT_LOCAL, deepMerge, migrateSettings } from '/js/defaults.js';

/** Accounts remembered on this device for the account switcher (their tokens stay in localStorage, never in the store). */
const savedAccounts = () => { const l = ls('accounts', []); return Array.isArray(l) ? l.filter((a) => a && a.id && a.token).map(({ token, ...a }) => a) : []; };

export const state = {
  token: ls('token', null), accounts: savedAccounts(), addingFrom: null,
  phase: 'boot', // boot | auth | loading | ready
  connection: 'connecting', // connecting | online | offline
  me: null, users: {}, servers: {}, dms: {}, relationships: {}, channelIndex: {},
  msgs: {}, reads: {}, lastMsg: {}, typing: {}, pinsCount: {},
  voice: { states: {}, conn: null, speaking: {}, rev: 0 }, calls: {}, // incoming rings: channelId -> { from, at }
  route: { view: 'friends', serverId: '@me', channelId: null, tab: 'online', param: null },
  panel: null, panelData: null, // right-hand panel
  modals: [], ctx: null, popover: null, saveBar: null, lightbox: null, toasts: [], quick: false, settingsPage: null, serverSettings: null,
  settings: deepMerge(DEFAULT_SETTINGS, migrateSettings(ls('settings', {}))),
  local: deepMerge(DEFAULT_LOCAL, ls('local', {})),
  focused: document.hasFocus(), idle: false, width: window.innerWidth, mobileNav: false,
  music: { genres: null, category: 'top', charts: {}, chartLoading: false, chartError: null, recent: ls('musicRecentYT', []) || [], playlists: null, artists: [], query: '', results: null, searching: false, error: null, queue: [], orig: [], index: -1, track: null, playing: false, loading: false, position: 0, duration: 0, volume: Number(ls('musicVolume', 0.7)) || 0.7, muted: false, shuffle: ['off', 'playlist', 'library'].includes(ls('musicShuffle', 'off')) ? ls('musicShuffle', 'off') : 'off', repeat: ['off', 'all', 'one'].includes(ls('musicRepeat', 'off')) ? ls('musicRepeat', 'off') : 'off', library: [], showQueue: false, chartMore: {}, loadingMore: false, resultsMore: false }, musicOk: null, postIndex: {}, postLists: {},
  gifOk: true, gated: false, wsDiag: null, emailVerif: { enabled: false, required: false, smtp: false }, verifyDismissed: false, botId: null, sessionId: null, jump: null, themesRev: 0, replyTo: null, editing: null, searchQuery: '', speaking: {},
};
state.panel = state.local.panel;

const subs = new Set();
let queued = false;
function flush() { queued = false; for (const fn of [...subs]) fn(); }
export function notify() { if (!queued) { queued = true; queueMicrotask(flush); } }
export function set(patch) { Object.assign(state, typeof patch === 'function' ? patch(state) : patch); notify(); }
export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }

export function useSel(sel, eq = Object.is) {
  const [, force] = useReducer((c) => c + 1, 0);
  const ref = useRef(null);
  const val = sel(state);
  ref.current = { sel, eq, val };
  useEffect(() => {
    const check = () => {
      const r = ref.current; let nv;
      try { nv = r.sel(state); } catch { nv = r.val; }
      if (!r.eq(nv, r.val)) { r.val = nv; force(); }
    };
    const off = subscribe(check);
    check();   // a change between the render and this subscription would otherwise be missed for good
    return off;
  }, []);
  return val;
}
/** Re-render on any store change (use sparingly). */
export function useStore() { return useSel((s) => ({ ...s }), () => false) && state; }
export const shallowArrEq = (a, b) => a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]));

/* ----------------------------------------------------------- settings */
const syncSettings = debounce(async () => {
  if (!state.token) return;
  const { api } = await import('/js/api.js');
  try { await api.patch('/me/settings', state.settings); } catch { /* offline: stays local */ }
}, 1200);
const persistLocal = debounce(() => { ls('settings', null, state.settings); }, 200);

export function updateSettings(patch, { sync = true } = {}) {
  const next = deepMerge(state.settings, patch);
  set({ settings: next });
  persistLocal();
  if (sync) syncSettings();
}
export function setSetting(path, value) {
  const parts = path.split('.'); const patch = {}; let cur = patch;
  parts.forEach((p, i) => { if (i === parts.length - 1) cur[p] = value; else cur = (cur[p] = {}); });
  updateSettings(patch);
}
export function updateLocal(patch) {
  const next = deepMerge(state.local, patch);
  set({ local: next }); ls('local', null, next);
}
export function resetSettings(keys) {
  const next = { ...state.settings };
  for (const k of keys) next[k] = structuredClone(DEFAULT_SETTINGS[k]);
  set({ settings: next }); ls('settings', null, next); syncSettings();
}

/* ----------------------------------------------------------- indexes & lookups */
export function rebuildIndex() {
  const idx = {};
  for (const s of Object.values(state.servers)) for (const c of s.channels) idx[c.id] = c;
  for (const d of Object.values(state.dms)) idx[d.id] = d;
  for (const p of Object.values(state.postIndex)) if (state.servers[p.serverId]) idx[p.id] = p;   // forum posts are channels too
  state.channelIndex = idx;
}
export const getChannel = (id) => state.channelIndex[id];
export const getUser = (id) => state.users[id];
export const isMuted = (chOrId) => {
  const ch = typeof chOrId === 'string' ? getChannel(chOrId) : chOrId; if (!ch) return false;
  return !!(state.settings.mutedChannels[ch.id] || (ch.serverId && state.settings.mutedServers[ch.serverId]));
};
export function memberOf(serverId, userId) { return state.servers[serverId]?.members.find((m) => m.id === userId) || null; }
export function nameOf(userId, serverId) {
  const u = state.users[userId];
  const m = serverId && memberOf(serverId, userId);
  return m?.nick || u?.displayName || 'Unknown User';
}
export function topRole(serverId, userId) {
  const s = state.servers[serverId]; const m = s && memberOf(serverId, userId); if (!m) return null;
  let best = null;
  for (const rid of m.roles) { const r = s.roles.find((x) => x.id === rid); if (r && r.color && (!best || r.position > best.position)) best = r; }
  return best;
}
export const roleColor = (serverId, userId) => topRole(serverId, userId)?.color || null;
/** The server's owner or one of its co-owners (who get the crown and every permission). */
export const isOwnerOf = (s, userId) => !!s && (s.ownerId === userId || !!s.coOwners?.includes(userId));
export function hasPerm(serverId, perm) {
  const s = state.servers[serverId]; if (!s) return false;
  return s.ownerId === state.me?.id || s.perms.includes('ADMINISTRATOR') || s.perms.includes(perm);
}
/** Custom emoji of every server you are in. */
export function allCustomEmojis() {
  const out = [];
  for (const s of Object.values(state.servers)) for (const e of s.emojis || []) out.push({ ...e, serverId: s.id, serverName: s.name });
  return out;
}
export const emojiById = (id) => { for (const s of Object.values(state.servers)) { const e = s.emojis?.find((x) => x.id === id); if (e) return e; } return null; };
/** `<:name:id>` (or `<a:name:id>` when animated) for the custom emoji called `name`; the current server's wins. */
export function customToken(name, serverId = state.route?.serverId) {
  const list = allCustomEmojis().filter((e) => e.name.toLowerCase() === String(name).toLowerCase());
  const e = list.find((x) => x.serverId === serverId) || list[0]; if (!e) return null;
  return `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`;
}
/** What the signed-in user may do in one channel: the channel's own overwrites (when it has any) or else their server-wide permissions. */
export function hasChannelPerm(ch, perm) {
  if (!ch?.serverId) return true;
  const s = state.servers[ch.serverId]; if (!s) return false;
  if (s.ownerId === state.me?.id) return true;
  const list = ch.cperms || (ch.type === 'post' ? state.channelIndex[ch.forumId]?.cperms : null) || s.perms;   // a post follows its forum
  return list.includes('ADMINISTRATOR') || list.includes(perm);
}
export function dmName(ch, max = 3) {
  if (!ch) return '';
  if (ch.type === 'group') {
    if (ch.name) return ch.name;
    const names = ch.recipients.filter((id) => id !== state.me?.id).map((id) => state.users[id]?.displayName || '?');
    return names.slice(0, max).join(', ') + (names.length > max ? '…' : '');
  }
  const other = ch.recipients.find((id) => id !== state.me?.id);
  return state.users[other]?.displayName || 'Unknown User';
}
export const dmUserId = (ch) => ch?.recipients?.find((id) => id !== state.me?.id);
export const isBot = (id) => !!state.users[id]?.bot;

export function addUsers(list) {
  if (!list?.length) return;
  const next = { ...state.users };
  for (const u of list) if (u) next[u.id] = { ...next[u.id], ...u };
  state.users = next;
}

export function unreadInfo(channelId) {
  const ch = getChannel(channelId); if (!ch || ch.type === 'voice' || ch.type === 'stage' || ch.type === 'category') return { unread: false, mentions: 0 };
  const last = state.lastMsg[channelId]; const read = state.reads[channelId];
  const unread = !!last && (!read?.lastRead || cmpId(last, read.lastRead) > 0);
  return { unread, mentions: read?.mentions || 0 };
}
export function serverUnread(serverId) {
  const s = state.servers[serverId]; if (!s) return { unread: false, mentions: 0 };
  let unread = false; let mentions = 0;
  for (const c of s.channels) {
    if (c.type !== 'text') continue;
    const u = unreadInfo(c.id);
    mentions += u.mentions;
    if (u.unread && !state.settings.mutedChannels[c.id]) unread = true;
  }
  for (const p of Object.values(state.postIndex)) if (p.serverId === serverId) mentions += state.reads[p.id]?.mentions || 0;   // mentions inside forum posts count too
  if (state.settings.mutedServers[serverId]) unread = false;
  return { unread, mentions };
}

/* ----------------------------------------------------------- navigation */
export function parseRoute(path) {
  const p = path.split('?')[0].replace(/\/+$/, '') || '/';
  let m;
  if ((m = p.match(/^\/channels\/@me\/(\d+)$/))) return { view: 'dm', serverId: '@me', channelId: m[1] };
  if (p === '/channels/@me' || p === '/' || p === '/friends') return { view: 'friends', serverId: '@me', channelId: null, tab: state.route.tab || 'online' };
  if ((m = p.match(/^\/channels\/(\d+)\/(\d+)$/))) return { view: 'channel', serverId: m[1], channelId: m[2] };
  if ((m = p.match(/^\/channels\/(\d+)$/))) return { view: 'channel', serverId: m[1], channelId: null };
  if ((m = p.match(/^\/invite\/([\w-]+)$/))) return { view: 'invite', serverId: '@me', channelId: null, param: m[1] };
  if ((m = p.match(/^\/music\/(artist|album|playlist|shared)\/([\w-]+)$/))) return { view: 'music', serverId: '@me', channelId: null, musicView: m[1], musicId: m[2] };   // an artist's, an album's or one of your playlists' page
  if (p === '/music') return { view: 'music', serverId: '@me', channelId: null, musicView: null, musicId: null };
  if (p === '/staff') return { view: 'staff', serverId: '@me', channelId: null };   // Orata staff tools (staff.js)
  if (p === '/themes' || p === '/themes/discover') return { view: 'themes', serverId: '@me', channelId: null, themesView: 'discover' };   // Discovery and your theme library (themes.js)
  if (p === '/themes/library') return { view: 'themes', serverId: '@me', channelId: null, themesView: 'library' };
  if (p === '/themes/review') return { view: 'themes', serverId: '@me', channelId: null, themesView: 'review' };   // Orata staff: themes waiting for approval
  if (p === '/login' || p === '/register') return { view: p.slice(1), serverId: '@me', channelId: null };
  if (p === '/verify') return { view: 'verify', serverId: '@me', channelId: null };   // the link in the verification email (the token is read from the query string)
  return { view: 'friends', serverId: '@me', channelId: null };
}
export function routePath(r) {
  switch (r.view) {
    case 'dm': return `/channels/@me/${r.channelId}`;
    case 'friends': return '/channels/@me';
    case 'music': return r.musicView && r.musicId ? `/music/${r.musicView}/${r.musicId}` : '/music';
    case 'staff': return '/staff';
    case 'themes': return r.themesView === 'library' ? '/themes/library' : r.themesView === 'review' ? '/themes/review' : '/themes';
    case 'channel': return r.channelId ? `/channels/${r.serverId}/${r.channelId}` : `/channels/${r.serverId}`;
    default: return '/channels/@me';
  }
}
export function resolveRoute(r) {
  // fill in a default channel for servers, validate existence
  if (r.view === 'channel') {
    const s = state.servers[r.serverId];
    if (!s) return { view: 'friends', serverId: '@me', channelId: null, tab: 'online' };
    let ch = r.channelId && (s.channels.find((c) => c.id === r.channelId) || (state.postIndex[r.channelId]?.serverId === s.id ? state.postIndex[r.channelId] : null));
    if (!ch) {
      const remembered = state.settings.lastChannel?.[s.id];
      ch = s.channels.find((c) => c.id === remembered && c.type !== 'category') || s.channels.find((c) => c.id === s.systemChannelId) || s.channels.find((c) => c.type === 'text') || s.channels.find((c) => c.type === 'voice');
    }
    return { ...r, channelId: ch?.id || null };
  }
  if (r.view === 'dm' && !state.dms[r.channelId]) return { view: 'friends', serverId: '@me', channelId: null, tab: 'online' };
  return r;
}
export function go(path, { replace = false } = {}) {
  const r = resolveRoute(typeof path === 'string' ? parseRoute(path) : path);
  const url = routePath(r);
  if (location.pathname !== url) history[replace ? 'replaceState' : 'pushState']({}, '', url);
  const prev = state.route;
  set({ route: { ...prev, tab: prev.tab, ...r }, mobileNav: false });
  if (r.channelId && r.serverId !== '@me') updateSettings({ lastChannel: { [r.serverId]: r.channelId } }, { sync: false });
  return r;
}
export const goChannel = (serverId, channelId) => go({ view: 'channel', serverId, channelId });
export const goDm = (channelId) => go({ view: 'dm', serverId: '@me', channelId });
window.addEventListener('popstate', () => { if (state.phase === 'ready') { set({ route: { ...state.route, ...resolveRoute(parseRoute(location.pathname)) } }); } });

/* ----------------------------------------------------------- overlays */
export function openModal(kind, props = {}) {
  const id = uid();
  set({ modals: [...state.modals, { id, kind, props }], ctx: null, popover: null });
  return id;
}
export function closeModal(id) { set({ modals: id ? state.modals.filter((m) => m.id !== id) : state.modals.slice(0, -1) }); }
export function openContext(e, items, opts = {}) {
  if (e?.preventDefault) { e.preventDefault(); e.stopPropagation(); }
  const x = e?.clientX ?? opts.x ?? 0; const y = e?.clientY ?? opts.y ?? 0;
  set({ ctx: { x, y, items, id: uid(), ...opts }, popover: null });
}
export const closeContext = () => state.ctx && set({ ctx: null });
export function openPopover(anchor, kind, props = {}, opts = {}) {
  const rect = anchor?.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor;
  set({ popover: { id: uid(), kind, props, rect: { x: rect.x ?? rect.left, y: rect.y ?? rect.top, w: rect.width, h: rect.height }, placement: opts.placement || 'right', ...opts }, ctx: null });
}
export const closePopover = () => state.popover && set({ popover: null });
export function toast(message, type = 'info', ms = 3800) {
  const id = uid();
  set({ toasts: [...state.toasts, { id, message, type }] });
  setTimeout(() => set({ toasts: state.toasts.filter((t) => t.id !== id) }), ms);
}
export const dismissToast = (id) => set({ toasts: state.toasts.filter((t) => t.id !== id) });

window.addEventListener('focus', () => set({ focused: true }));
window.addEventListener('blur', () => set({ focused: false }));
window.addEventListener('resize', debounce(() => set({ width: window.innerWidth }), 80));
