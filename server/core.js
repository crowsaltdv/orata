// Orate — shared server core: persistence, ids, permissions, serializers, event fan-out.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.ORATE_DATA || path.join(ROOT, 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'db.json');

/* ---------------------------------------------------------------- env */
export function loadEnv() {
  const env = {};
  try {
    const raw = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
      if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env */ }
  return { ...env, ...process.env };
}
export const ENV = loadEnv();

/* ---------------------------------------------------------------- db */
const empty = () => ({ users: {}, sessions: {}, servers: {}, channels: {}, messages: {}, invites: {}, botId: null, defaultServerId: null });
export let db = empty();
try {
  if (fs.existsSync(DB_FILE)) db = { ...empty(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
} catch (e) {
  console.error('[orate] db.json unreadable, keeping a backup and starting fresh:', e.message);
  try { fs.copyFileSync(DB_FILE, DB_FILE + '.corrupt-' + Date.now()); } catch { /* ignore */ }
}
let timer = null; let dirty = false;
export function save() { dirty = true; if (!timer) timer = setTimeout(flush, 500); }
export function flush() {
  clearTimeout(timer); timer = null;
  if (!dirty) return; dirty = false;
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}
process.on('exit', flush);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { flush(); process.exit(0); });

let lastId = 0;
export function newId() { let t = Date.now() * 1000; if (t <= lastId) t = lastId + 1; lastId = t; return String(t); }
export const cmpId = (a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0);
export const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/* indexes (rebuilt on load) */
export const byUsername = new Map();
export const byEmail = new Map();
for (const u of Object.values(db.users)) { byUsername.set(u.username, u.id); if (u.email) byEmail.set(u.email, u.id); }
export const inviteCodes = db.invites;

/* ------------------------------------------------------------- errors */
export class ApiError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code || 'error'; }
}
export const bad = (m, code) => new ApiError(400, m, code);
export const forbidden = (m = 'Missing permissions') => new ApiError(403, m, 'forbidden');
export const notFound = (m = 'Not found') => new ApiError(404, m, 'not_found');

/* -------------------------------------------------------- connections */
// userId -> Set<conn>  (conn = { id, ws, userId, idle, voice })
export const conns = new Map();
export function isOnline(userId) { return (conns.get(userId)?.size || 0) > 0; }
export function send(conn, op, d) {
  if (conn.ws.readyState === 1) conn.ws.send(JSON.stringify({ op, d }));
}
export function emitTo(userIds, op, d, exceptConn) {
  const payload = JSON.stringify({ op, d });
  for (const id of new Set(userIds)) {
    const set = conns.get(id);
    if (!set) continue;
    for (const c of set) if (c !== exceptConn && c.ws.readyState === 1) c.ws.send(payload);
  }
}

/* -------------------------------------------------------- permissions */
export const PERMS = ['ADMINISTRATOR', 'MANAGE_SERVER', 'MANAGE_CHANNELS', 'MANAGE_ROLES', 'MANAGE_MESSAGES', 'KICK_MEMBERS', 'BAN_MEMBERS', 'CREATE_INVITE', 'SEND_MESSAGES', 'ATTACH_FILES', 'ADD_REACTIONS', 'MENTION_EVERYONE', 'CONNECT', 'SPEAK', 'CHANGE_NICKNAME', 'MANAGE_NICKNAMES'];
export const DEFAULT_PERMS = ['CREATE_INVITE', 'SEND_MESSAGES', 'ATTACH_FILES', 'ADD_REACTIONS', 'CONNECT', 'SPEAK', 'CHANGE_NICKNAME'];

export function memberOf(server, userId) { return server?.members?.[userId] || null; }
export function permsOf(server, userId) {
  if (!server) return new Set();
  if (server.ownerId === userId) return new Set(PERMS);
  const m = server.members[userId];
  if (!m) return new Set();
  const set = new Set(server.roles.find((r) => r.id === server.id)?.permissions || []);
  for (const rid of m.roles) for (const p of server.roles.find((r) => r.id === rid)?.permissions || []) set.add(p);
  if (set.has('ADMINISTRATOR')) return new Set(PERMS);
  return set;
}
export const can = (server, userId, perm) => permsOf(server, userId).has(perm);
export function need(server, userId, perm) { if (!can(server, userId, perm)) throw forbidden(); }
export function topRolePos(server, userId) {
  if (server.ownerId === userId) return Infinity;
  const m = server.members[userId]; if (!m) return -1;
  return Math.max(0, ...m.roles.map((rid) => server.roles.find((r) => r.id === rid)?.position || 0));
}

export function canView(userId, ch) {
  if (!ch) return false;
  if (!ch.serverId) return (ch.recipients || []).includes(userId);
  const server = db.servers[ch.serverId];
  if (!server || !server.members[userId]) return false;
  if (!ch.private) return true;
  if (can(server, userId, 'ADMINISTRATOR')) return true;
  const roles = server.members[userId].roles;
  return (ch.allowedRoles || []).some((r) => roles.includes(r)) || (ch.allowedUsers || []).includes(userId);
}
export function audienceOf(ch) {
  if (!ch.serverId) return ch.recipients || [];
  const server = db.servers[ch.serverId]; if (!server) return [];
  return Object.keys(server.members).filter((uid) => canView(uid, ch));
}
export function serverAudience(server) { return Object.keys(server.members); }
export function channelsOfServer(serverId) { return Object.values(db.channels).filter((c) => c.serverId === serverId); }

/* ------------------------------------------------------------ presence */
export function effectiveStatus(u) {
  if (!u) return 'offline';
  if (u.bot) return 'online';
  const set = conns.get(u.id);
  if (!set || !set.size) return 'offline';
  if (u.status === 'invisible') return 'offline';
  if (u.status === 'online' || !u.status) return [...set].every((c) => c.idle) ? 'idle' : 'online';
  return u.status;
}
export function relatedUserIds(userId) {
  const out = new Set([userId]);
  for (const s of Object.values(db.servers)) if (s.members[userId]) for (const id of Object.keys(s.members)) out.add(id);
  for (const c of Object.values(db.channels)) if (!c.serverId && c.recipients?.includes(userId)) for (const id of c.recipients) out.add(id);
  const u = db.users[userId];
  for (const [id, t] of Object.entries(u?.rel || {})) if (t !== 'blocked') out.add(id);
  return out;
}
export function broadcastPresence(userId) {
  const u = db.users[userId]; if (!u) return;
  emitTo(relatedUserIds(userId), 'presence_update', { userId, status: effectiveStatus(u), customStatus: u.customStatus || null });
}

/* --------------------------------------------------------- serializers */
export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, username: u.username, displayName: u.displayName, avatar: u.avatar || null,
    banner: u.banner || null, bannerColor: u.bannerColor || null, accentColor: u.accentColor || null,
    bio: u.bio || '', pronouns: u.pronouns || '', tag: u.tag || null, createdAt: u.createdAt,
    bot: !!u.bot, status: effectiveStatus(u), customStatus: u.customStatus || null,
  };
}
export function selfUser(u) {
  return { ...publicUser(u), email: u.email, status: u.status || 'online', settings: u.settings || {}, dob: u.dob || null, verified: true };
}

export function serverView(server, userId) {
  const chans = channelsOfServer(server.id).filter((c) => canView(userId, c)).map(channelView).sort((a, b) => a.position - b.position);
  return {
    id: server.id, name: server.name, icon: server.icon || null, banner: server.banner || null,
    description: server.description || '', ownerId: server.ownerId, createdAt: server.createdAt,
    accent: server.accent || null, roles: server.roles, channels: chans,
    members: Object.entries(server.members).map(([id, m]) => ({ id, roles: m.roles, nick: m.nick || null, joinedAt: m.joinedAt })),
    perms: [...permsOf(server, userId)], systemChannelId: server.systemChannelId || null,
  };
}
export function channelView(c) {
  return {
    id: c.id, serverId: c.serverId || null, type: c.type, name: c.name || null, topic: c.topic || '',
    parentId: c.parentId || null, position: c.position || 0, private: !!c.private,
    allowedRoles: c.allowedRoles || [], recipients: c.recipients || undefined, ownerId: c.ownerId || undefined,
    icon: c.icon || undefined, lastMessageId: lastMessageId(c.id), nsfw: !!c.nsfw, slowmode: c.slowmode || 0,
  };
}
export function lastMessageId(channelId) { const a = db.messages[channelId]; return a?.length ? a[a.length - 1].id : null; }

export function messageView(m) {
  let reply = null;
  if (m.replyTo) {
    const ref = (db.messages[m.channelId] || []).find((x) => x.id === m.replyTo);
    reply = ref ? { id: ref.id, authorId: ref.authorId, content: (ref.content || '').slice(0, 160), attachments: (ref.attachments || []).length, gif: !!ref.gif, sticker: !!ref.sticker }
      : { id: m.replyTo, deleted: true };
  }
  return {
    id: m.id, channelId: m.channelId, authorId: m.authorId, content: m.content, createdAt: m.createdAt, editedAt: m.editedAt || null,
    attachments: m.attachments || [], gif: m.gif || null, sticker: m.sticker || null, reactions: m.reactions || {},
    replyTo: m.replyTo || null, reply, mentions: m.mentions || [], mentionRoles: m.mentionRoles || [],
    mentionEveryone: !!m.mentionEveryone, pinned: !!m.pinned, type: m.type || 'default', nonce: undefined,
  };
}

/* ------------------------------------------------------------- helpers */
export function readStateFor(user, ch) {
  const rs = user.reads?.[ch.id];
  const list = db.messages[ch.id] || [];
  const lastRead = rs?.lastRead || null;
  let mentions = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (lastRead && cmpId(m.id, lastRead) <= 0) break;
    if (m.authorId === user.id) continue;
    if (m.mentions?.includes(user.id) || m.mentionEveryone || (ch.serverId && m.mentionRoles?.some((r) => db.servers[ch.serverId]?.members[user.id]?.roles.includes(r)))) mentions++;
    if (mentions >= 99) break;
  }
  return { lastRead, mentions };
}

export function systemMessage(channelId, type, authorId, content = '') {
  const m = { id: newId(), channelId, authorId, content, createdAt: Date.now(), type, attachments: [], reactions: {}, mentions: [] };
  (db.messages[channelId] ||= []).push(m);
  save();
  const ch = db.channels[channelId];
  if (ch) emitTo(audienceOf(ch), 'message_create', { message: messageView(m), users: [publicUser(db.users[authorId])] });
  return m;
}

const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function randomCode(n = 8) { const b = crypto.randomBytes(n); let s = ''; for (let i = 0; i < n; i++) s += ALPHABET[b[i] % ALPHABET.length]; return s; }

export const RESERVED = new Set(['everyone', 'here', 'admin', 'administrator', 'system', 'orate', 'moderator', 'staff']);

export function ensureBot() {
  if (db.botId && db.users[db.botId]) return db.users[db.botId];
  const id = newId();
  db.users[id] = { id, username: 'orbit', displayName: 'Orbit', email: null, bot: true, status: 'online', createdAt: Date.now(), bio: 'Your friendly Orate helper. Say "help" in a DM.', tag: { text: 'ORATE', icon: 'bolt', color: '#8b5cf6' }, bannerColor: '#6d28d9', rel: {}, reads: {}, settings: {} };
  byUsername.set('orbit', id);
  db.botId = id;
  save();
  return db.users[id];
}

export function createServer(owner, { name, icon = null, template = 'default' }) {
  const id = newId();
  const everyone = { id, name: '@everyone', color: null, position: 0, permissions: [...DEFAULT_PERMS], hoist: false };
  const server = { id, name: String(name).slice(0, 100), icon, banner: null, description: '', ownerId: owner.id, createdAt: Date.now(), roles: [everyone], members: { [owner.id]: { roles: [], joinedAt: Date.now() } }, bans: [], accent: null };
  db.servers[id] = server;
  const mk = (type, nm, parentId, position, extra = {}) => {
    const cid = newId();
    db.channels[cid] = { id: cid, serverId: id, type, name: nm, parentId, position, topic: '', ...extra };
    db.messages[cid] = [];
    return cid;
  };
  const layouts = {
    default: { text: ['general', 'memes', 'media'], voice: ['Lounge', 'Gaming'] },
    gaming: { text: ['announcements', 'general', 'looking-for-group', 'clips'], voice: ['Squad 1', 'Squad 2', 'AFK'] },
    community: { text: ['welcome', 'announcements', 'general', 'off-topic', 'showcase'], voice: ['Hangout', 'Music'] },
    friends: { text: ['general', 'photos', 'plans'], voice: ['Chill'] },
    study: { text: ['general', 'resources', 'homework-help'], voice: ['Study Room', 'Break Room'] },
  };
  const lay = layouts[template] || layouts.default;
  const catT = mk('category', 'Text Channels', null, 0);
  const catV = mk('category', 'Voice Channels', null, 100);
  lay.text.forEach((n, i) => mk('text', n, catT, 1 + i));
  lay.voice.forEach((n, i) => mk('voice', n, catV, 101 + i));
  const first = Object.values(db.channels).find((c) => c.serverId === id && c.type === 'text');
  server.systemChannelId = first?.id || null;
  save();
  return server;
}

export function addMember(server, user) {
  server.members[user.id] = { roles: [], joinedAt: Date.now() };
  save();
}

export function removeFromVoice(userId, why = 'left') {
  const set = conns.get(userId);
  if (!set) return;
  for (const c of set) if (c.voice) c.leaveVoice?.(why);
}

/* ---------------------------------------------------------------- voice */
// channelId -> Map<userId, state>
export const voice = new Map();
export function voiceStateList(userId) {
  const out = [];
  for (const [channelId, room] of voice) {
    const ch = db.channels[channelId]; if (!ch || !canView(userId, ch)) continue;
    for (const st of room.values()) out.push(st);
  }
  return out;
}
