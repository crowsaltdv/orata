// Orata — message creation shared by the REST API and the built-in bot.
import { db, newId, save, emitTo, audienceOf, messageView, publicUser, canIn, channelView, customEmojisIn, postView, removeUpload } from './core.js';

export const hooks = { onMessage: [], onEdit: [], onDelete: [] };   // onDelete gets (channel, ids)
const run = (list, ...args) => { for (const fn of list) { try { fn(...args); } catch (e) { console.error('[hook]', e); } } };
/** Tells the hooks (the Discord bridge) that a message was edited, or that messages were deleted. */
export const messageEdited = (ch, m) => run(hooks.onEdit, ch, m);
export const messagesDeleted = (ch, ids) => { if (ids.length) run(hooks.onDelete, ch, ids); };
/** Audio messages (recorded, or an audio file dropped in) are at most 3 minutes long and delete themselves a day after they are sent. */
export const VOICE_MAX_SECONDS = 180;
export const VOICE_TTL = 86400_000;

const URL_HOSTS_OK = /^https:\/\/([a-z0-9-]+\.)*klipy\.com\//i;
const SAFE_UPLOAD = /^\/uploads\/[A-Za-z0-9_.-]+$/;

export function sanitizeMedia(obj, kind) {
  if (!obj || typeof obj !== 'object') return null;
  const url = String(obj.url || '');
  if (!URL_HOSTS_OK.test(url)) return null;
  const clean = { id: String(obj.id || '').slice(0, 40), title: String(obj.title || '').slice(0, 200), url, w: clampInt(obj.w, 1, 4000, 220), h: clampInt(obj.h, 1, 4000, 220) };
  for (const k of ['gif', 'webp', 'mp4', 'webm', 'jpg', 'png', 'poster']) if (obj[k] && URL_HOSTS_OK.test(String(obj[k]))) clean[k] = String(obj[k]);
  clean.kind = kind;
  return clean;
}
export function clampInt(v, lo, hi, d) { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; }

export function sanitizeAttachments(list, fs, path, uploadDir) {
  const out = [];
  for (const a of Array.isArray(list) ? list.slice(0, 10) : []) {
    if (!a || !SAFE_UPLOAD.test(String(a.url || ''))) continue;
    const file = path.join(uploadDir, path.basename(a.url));
    let st; try { st = fs.statSync(file); } catch { continue; }
    const type = String(a.type || 'application/octet-stream').slice(0, 100);
    const voice = !!a.voice && type.startsWith('audio/'); const secs = Number(a.duration);
    if (voice && !(secs > 0 && secs <= VOICE_MAX_SECONDS + 1)) continue;   // longer than 3 minutes: not an audio message
    out.push({
      id: String(a.id || path.basename(a.url)).slice(0, 40), url: a.url, name: String(a.name || 'file').slice(0, 200), size: st.size, type,
      width: a.width ? clampInt(a.width, 1, 20000, undefined) : undefined, height: a.height ? clampInt(a.height, 1, 20000, undefined) : undefined,
      spoiler: !!a.spoiler, ...(voice ? { voice: true, duration: Math.round(secs * 10) / 10 } : {}),
    });
  }
  return out;
}

export function postMessage(ch, authorId, { content = '', attachments = [], gif = null, sticker = null, replyTo = null, replyPing = true, type = 'default', nonce, poll = null, theme = null, forward = null, bridge = null } = {}) {
  content = String(content).replace(/\r\n/g, '\n').slice(0, 4000);
  const server = ch.serverId ? db.servers[ch.serverId] : null;
  const author = db.users[authorId];

  const mentionSet = new Set();
  for (const m of content.matchAll(/<@!?(\d{10,20})>/g)) {
    const id = m[1];
    if (db.users[id] && (server ? server.members[id] : ch.recipients?.includes(id))) mentionSet.add(id);
  }
  const mentionRoles = server ? [...new Set([...content.matchAll(/<@&(\d{10,20})>/g)].map((m) => m[1]))].filter((id) => server.roles.some((r) => r.id === id && r.id !== server.id)) : [];
  let mentionEveryone = false;
  if (/(^|\s)@(everyone|here)\b/.test(content) && server && canIn(authorId, ch, 'MENTION_EVERYONE')) mentionEveryone = true;

  let replyId = null;
  if (replyTo) {
    const ref = (db.messages[ch.id] || []).find((x) => x.id === String(replyTo));
    if (ref) {
      replyId = ref.id;
      if (replyPing && ref.authorId !== authorId && (server ? server.members[ref.authorId] : ch.recipients?.includes(ref.authorId))) mentionSet.add(ref.authorId);
    }
  }
  mentionSet.delete(authorId);

  const msg = {
    id: newId(), channelId: ch.id, authorId, content, createdAt: Date.now(), editedAt: null,
    attachments, gif, sticker, reactions: {}, replyTo: replyId, mentions: [...mentionSet], mentionRoles, mentionEveryone, pinned: false, type,
  };
  const emojis = customEmojisIn(content, authorId); if (emojis) msg.emojis = emojis;
  if (poll) msg.poll = poll;
  if (theme) msg.theme = theme;
  if (forward) msg.forward = forward;   // a copy of a message forwarded from elsewhere
  if (bridge) msg.bridge = bridge;   // posted from a linked Discord channel: { id, name, avatar } of the Discord sender
  if (attachments.some((a) => a.voice)) { msg.expiresAt = msg.createdAt + VOICE_TTL; expiring.set(msg.id, { channelId: ch.id, at: msg.expiresAt }); }
  (db.messages[ch.id] ||= []).push(msg);
  if (ch.type === 'post') { ch.lastActivity = msg.createdAt; emitTo(audienceOf(ch), 'post_update', { post: postView(ch) }); }   // keeps the forum list's "last activity" and reply counts live
  // keep memory bounded per channel (oldest are dropped from the live window; they remain on disk until next save)
  if (db.messages[ch.id].length > 20000) db.messages[ch.id].splice(0, db.messages[ch.id].length - 20000);

  // re-open closed DMs
  if (!ch.serverId) {
    for (const uid of ch.recipients || []) {
      const u = db.users[uid];
      if (u?.closedDms?.[ch.id] && uid !== authorId) { delete u.closedDms[ch.id]; emitTo([uid], 'dm_open', { channel: channelView(ch), users: (ch.recipients || []).map((id) => publicUser(db.users[id])) }); }
    }
  }
  save();
  const view = messageView(msg); view.nonce = nonce;
  emitTo(audienceOf(ch), 'message_create', { message: view, users: author ? [publicUser(author)] : [] });
  run(hooks.onMessage, ch, msg);
  return msg;
}

/* ---------------------------------------------------------------- audio messages expire */
const expiring = new Map();   // message id -> { channelId, at } for every audio message still waiting to expire
for (const [chId, list] of Object.entries(db.messages)) for (const m of list || []) if (m.expiresAt) expiring.set(m.id, { channelId: chId, at: m.expiresAt });
/** A day after it was sent the audio is deleted (the file too); the message goes with it unless it also holds text or other things. */
function sweepExpired() {
  const now = Date.now();
  for (const [id, x] of expiring) {
    if (x.at > now) continue;
    expiring.delete(id);
    const list = db.messages[x.channelId]; const m = list?.find((y) => y.id === id); const ch = db.channels[x.channelId];
    if (!m || !ch) continue;
    for (const a of (m.attachments || []).filter((y) => y.voice)) removeUpload(a.url.split('/').pop());
    m.attachments = (m.attachments || []).filter((y) => !y.voice); delete m.expiresAt;
    if (!m.content?.trim() && !m.attachments.length && !m.gif && !m.sticker && !m.poll && !m.theme) {
      list.splice(list.indexOf(m), 1);
      emitTo(audienceOf(ch), 'message_delete', { channelId: ch.id, messageId: id }); messagesDeleted(ch, [id]);
    } else emitTo(audienceOf(ch), 'message_update', { message: messageView(m) });
    save();
  }
}
setTimeout(sweepExpired, 2000).unref();
setInterval(sweepExpired, 60_000).unref();
