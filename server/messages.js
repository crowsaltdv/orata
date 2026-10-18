// Orate — message creation shared by the REST API and the built-in bot.
import { db, newId, save, emitTo, audienceOf, messageView, publicUser, can, channelView } from './core.js';

export const hooks = { onMessage: [] };

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
    out.push({
      id: String(a.id || path.basename(a.url)).slice(0, 40), url: a.url, name: String(a.name || 'file').slice(0, 200), size: st.size,
      type: String(a.type || 'application/octet-stream').slice(0, 100),
      width: a.width ? clampInt(a.width, 1, 20000, undefined) : undefined, height: a.height ? clampInt(a.height, 1, 20000, undefined) : undefined,
      spoiler: !!a.spoiler,
    });
  }
  return out;
}

export function postMessage(ch, authorId, { content = '', attachments = [], gif = null, sticker = null, replyTo = null, replyPing = true, type = 'default', nonce } = {}) {
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
  if (/(^|\s)@(everyone|here)\b/.test(content) && server && can(server, authorId, 'MENTION_EVERYONE')) mentionEveryone = true;

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
  (db.messages[ch.id] ||= []).push(msg);
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
  for (const fn of hooks.onMessage) { try { fn(ch, msg); } catch (e) { console.error('[hook]', e); } }
  return msg;
}
