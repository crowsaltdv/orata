// Orata — user-facing actions (messages, read state, navigation helpers).
import { state, set, getChannel, toast, updateSettings, goDm, goChannel, addUsers, unreadInfo } from '/js/store.js';
import { api } from '/js/api.js';
import { cmpId, debounce, uid } from '/js/lib.js';
import { playSound } from '/js/sound.js';

export function errMsg(e) { return e?.message || 'Something went wrong'; }
export async function act(promise, { success, silent } = {}) {
  try { const r = await promise; if (success) toast(success, 'success'); return r; } catch (e) { if (!silent) toast(errMsg(e), 'error'); return undefined; }
}

/* ------------------------------------------------------------ message cache */
const emptyEntry = () => ({ list: [], loaded: false, loading: false, hasMore: false, hasNewer: false });
export const getEntry = (chId) => state.msgs[chId] || emptyEntry();
export function patchEntry(chId, fn) {
  const cur = getEntry(chId); const next = typeof fn === 'function' ? fn(cur) : { ...cur, ...fn };
  set({ msgs: { ...state.msgs, [chId]: next } });
}
export function mapMessage(chId, id, fn) {
  const e = state.msgs[chId]; if (!e) return;
  let hit = false;
  const list = e.list.map((m) => { if (m.id === id) { hit = true; return fn(m); } return m; });
  if (hit) set({ msgs: { ...state.msgs, [chId]: { ...e, list } } });
}

export async function loadMessages(chId, { around, force } = {}) {
  const e = getEntry(chId);
  if (!force && !around && (e.loaded || e.loading)) return;
  patchEntry(chId, { loading: true });
  try {
    const q = around ? `around=${around}&limit=50` : 'limit=50';
    const r = await api.get(`/channels/${chId}/messages?${q}`);
    addUsers(r.users);
    const list = r.messages;
    const last = state.lastMsg[chId];
    const reachedEnd = !around || !last || (list.length && cmpId(list[list.length - 1].id, last) >= 0);
    patchEntry(chId, { list, loaded: true, loading: false, hasMore: r.hasMore, hasNewer: !reachedEnd, fresh: Date.now() });
  } catch (err) {
    patchEntry(chId, { loading: false, error: errMsg(err) });
  }
}
export async function loadOlder(chId) {
  const e = getEntry(chId); if (e.loading || !e.hasMore || !e.list.length) return;
  patchEntry(chId, { loading: true });
  try {
    const r = await api.get(`/channels/${chId}/messages?before=${e.list[0].id}&limit=50`);
    addUsers(r.users);
    patchEntry(chId, (cur) => ({ ...cur, list: [...r.messages.filter((m) => !cur.list.some((x) => x.id === m.id)), ...cur.list], hasMore: r.hasMore, loading: false, prepended: Date.now() }));
  } catch { patchEntry(chId, { loading: false }); }
}
export async function loadNewer(chId) {
  const e = getEntry(chId); if (e.loading || !e.hasNewer || !e.list.length) return;
  patchEntry(chId, { loading: true });
  try {
    const r = await api.get(`/channels/${chId}/messages?after=${e.list[e.list.length - 1].id}&limit=50`);
    addUsers(r.users);
    const last = state.lastMsg[chId];
    patchEntry(chId, (cur) => {
      const list = [...cur.list, ...r.messages.filter((m) => !cur.list.some((x) => x.id === m.id))];
      return { ...cur, list, loading: false, hasNewer: !(last && cmpId(list[list.length - 1].id, last) >= 0) };
    });
  } catch { patchEntry(chId, { loading: false }); }
}
export async function jumpToLatest(chId) { await loadMessages(chId, { force: true }); set({ jump: { id: null, ts: Date.now(), bottom: true, chId } }); }
export async function jumpToMessage(chId, mid) {
  const e = getEntry(chId);
  if (!e.list.some((m) => m.id === mid)) await loadMessages(chId, { around: mid, force: true });
  set({ jump: { id: mid, ts: Date.now(), chId } });
}
/** Opens a message in its own channel (a forward's "from" line): loads the messages around it, goes there and scrolls to it.
 *  Says why not when it can't: 'hidden' (you can't see that channel), 'gone' (the message was deleted) or 'error' (it couldn't be loaded). */
export async function openMessage(chId, mid) {
  const ch = getChannel(chId); if (!ch) return 'hidden';
  const t0 = Date.now();
  await loadMessages(chId, { around: mid, force: true });
  const e = getEntry(chId);
  if (!(e.fresh >= t0)) return 'error';   // (loadMessages stamps `fresh` only when it worked)
  if (!e.list.some((m) => m.id === mid)) return 'gone';
  if (ch.serverId) goChannel(ch.serverId, chId); else goDm(chId);
  set({ jump: { id: mid, ts: Date.now(), chId } });
  return 'ok';
}

/* ------------------------------------------------------------ sending */
export async function sendMessage(ch, { content = '', attachments = [], gif = null, sticker = null, replyTo = null, replyPing = true, wait = null }) {
  const me = state.me; const nonce = uid() + Date.now().toString(36);
  const ref = replyTo ? getEntry(ch.id).list.find((m) => m.id === replyTo) : null;
  const optimistic = {
    id: 'n:' + nonce, nonce, channelId: ch.id, authorId: me.id, content, createdAt: Date.now(), editedAt: null,
    attachments: attachments.map((a) => ({ ...a })), gif, sticker, reactions: {}, replyTo, mentions: [], mentionRoles: [], pinned: false, type: 'default', pending: true,
    reply: ref ? { id: ref.id, authorId: ref.authorId, content: (ref.content || '').slice(0, 160), attachments: ref.attachments?.length || 0, gif: !!ref.gif, sticker: !!ref.sticker } : (replyTo ? { id: replyTo, deleted: true } : null),
  };
  const entry = getEntry(ch.id);
  if (entry.hasNewer) await jumpToLatest(ch.id);
  patchEntry(ch.id, (cur) => ({ ...cur, list: [...cur.list, optimistic], loaded: true }));
  set({ jump: { id: null, ts: Date.now(), bottom: true, chId: ch.id, soft: true } });
  playSound('send');
  try {
    const finalAtt = wait ? await wait() : attachments;
    const m = await api.post(`/channels/${ch.id}/messages`, { content, attachments: finalAtt, gif, sticker, replyTo, replyPing, nonce });
    patchEntry(ch.id, (cur) => {
      if (cur.list.some((x) => x.id === m.id)) return { ...cur, list: cur.list.filter((x) => x.id !== 'n:' + nonce) };
      return { ...cur, list: cur.list.map((x) => (x.id === 'n:' + nonce ? m : x)) };
    });
    state.lastMsg = { ...state.lastMsg, [ch.id]: cmpId(state.lastMsg[ch.id] || '0', m.id) > 0 ? state.lastMsg[ch.id] : m.id };
    return m;
  } catch (e) {
    patchEntry(ch.id, (cur) => ({ ...cur, list: cur.list.map((x) => (x.id === 'n:' + nonce ? { ...x, pending: false, failed: true, error: errMsg(e) } : x)) }));
    if (e.code === 'rate_limited' || e.code === 'slowmode') toast(errMsg(e), 'error');
    return null;
  }
}
export async function retryMessage(ch, msg) {
  patchEntry(ch.id, (cur) => ({ ...cur, list: cur.list.filter((x) => x.id !== msg.id) }));
  return sendMessage(ch, { content: msg.content, attachments: msg.attachments, gif: msg.gif, sticker: msg.sticker, replyTo: msg.replyTo });
}
export function discardMessage(ch, msg) { patchEntry(ch.id, (cur) => ({ ...cur, list: cur.list.filter((x) => x.id !== msg.id) })); }
export const editMessage = (ch, id, content) => act(api.patch(`/channels/${ch.id}/messages/${id}`, { content }));
export const deleteMessage = (ch, id) => act(api.del(`/channels/${ch.id}/messages/${id}`));
export async function toggleReaction(ch, msg, emoji) {
  const mine = msg.reactions?.[emoji]?.includes(state.me.id);
  const url = `/channels/${ch.id}/messages/${msg.id}/reactions/${encodeURIComponent(emoji)}/@me`;
  // optimistic
  mapMessage(ch.id, msg.id, (m) => applyReaction(m, emoji, state.me.id, !mine));
  try { await (mine ? api.del(url) : api.put(url)); } catch (e) { mapMessage(ch.id, msg.id, (m) => applyReaction(m, emoji, state.me.id, !!mine)); toast(errMsg(e), 'error'); }
}
export function applyReaction(m, emoji, userId, add) {
  const cur = m.reactions?.[emoji] || [];
  const has = cur.includes(userId);
  if (add === has) return m;
  const next = { ...m.reactions };
  const arr = add ? [...cur, userId] : cur.filter((x) => x !== userId);
  if (arr.length) next[emoji] = arr; else delete next[emoji];
  return { ...m, reactions: next };
}
export const pinMessage = (ch, id, on = true) => act(on ? api.put(`/channels/${ch.id}/pins/${id}`) : api.del(`/channels/${ch.id}/pins/${id}`));

/* ------------------------------------------------------------ typing + read state */
const lastTyping = {};
export function sendTyping(chId) {
  const now = Date.now(); if (now - (lastTyping[chId] || 0) < 7000) return;
  lastTyping[chId] = now; api.post(`/channels/${chId}/typing`).catch(() => {});
}
const ackQueue = {};
const doAck = debounce(() => { for (const id of Object.keys(ackQueue)) { api.post(`/channels/${id}/ack`, { messageId: ackQueue[id] }).catch(() => {}); delete ackQueue[id]; } }, 400);
export function ackChannel(chId) {
  const last = state.lastMsg[chId]; if (!last) return;
  const cur = state.reads[chId];
  if (cur?.lastRead && cmpId(cur.lastRead, last) >= 0 && !cur.mentions) return;
  set({ reads: { ...state.reads, [chId]: { lastRead: last, mentions: 0 } } });
  ackQueue[chId] = last; doAck();
}
export function markServerRead(serverId) {
  const s = state.servers[serverId]; if (!s) return;
  for (const c of s.channels) if (c.type === 'text' && unreadInfo(c.id).unread) ackChannel(c.id);
}
export function markAllRead() { for (const s of Object.values(state.servers)) markServerRead(s.id); for (const d of Object.values(state.dms)) ackChannel(d.id); }

/* ------------------------------------------------------------ DMs */
export async function openDm(userId) {
  const existing = Object.values(state.dms).find((c) => c.type === 'dm' && c.recipients.includes(userId));
  if (existing) { goDm(existing.id); return existing; }
  const ch = await act(api.post('/dms', { recipientId: userId }));
  if (ch) { if (!state.dms[ch.id]) set({ dms: { ...state.dms, [ch.id]: ch } }); goDm(ch.id); }
  return ch;
}

/* ------------------------------------------------------------ settings overlay */
export const openSettings = (page = 'account') => set({ settingsPage: page, ctx: null, popover: null });
export const closeSettings = () => set({ settingsPage: null });
