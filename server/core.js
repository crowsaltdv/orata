// Orate — shared server core: persistence, ids, permissions, serializers, event fan-out.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { ROOT, ENV, loadEnv } from './env.js';
import { PgStore, ConflictError, isSafeFileName } from './storage.js';
export { ROOT, ENV, loadEnv };
export const DATA_DIR = process.env.ORATE_DATA || path.join(ROOT, 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'db.json');

/* ---------------------------------------------------------------- db: files in data/ (default) or PostgreSQL (DATABASE_URL) */
export const pg = ENV.DATABASE_URL ? new PgStore(ENV.DATABASE_URL, ENV) : null;
const empty = () => ({ users: {}, sessions: {}, servers: {}, channels: {}, messages: {}, invites: {}, emailTokens: {}, botId: null, defaultServerId: null });
export let db = empty();
let pgVersion = 0;   // the version of the database row this process last loaded or wrote

if (pg) {
  await pg.init();
  const st = await pg.loadState();
  if (st) { db = { ...empty(), ...JSON.parse(st.json) }; pgVersion = st.version; }
  else {
    // A brand-new database. Adopt local files (data/db.json + uploads/) if there are any, so moving to Postgres loses nothing.
    let seed = empty(); let adopted = false;
    if (fs.existsSync(DB_FILE)) {
      try { seed = { ...empty(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; adopted = true; } catch (e) { console.error('[orate] data/db.json is unreadable, not importing it:', e.message); }
    }
    pgVersion = await pg.createState(JSON.stringify(seed));
    if (pgVersion) {
      db = seed;
      if (adopted) {
        console.log('[orate] This database is empty, so your local data/db.json was imported into it.');
        const r = await pg.importDir(UPLOAD_DIR, console.log);
        console.log(`[orate] ${r.added} uploaded file(s) copied to the database.`);
      }
    } else { const again = await pg.loadState(); db = { ...empty(), ...JSON.parse(again.json) }; pgVersion = again.version; }   // another instance created it a moment ago
  }
} else {
  try {
    if (fs.existsSync(DB_FILE)) db = { ...empty(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
  } catch (e) {
    console.error('[orate] db.json unreadable, keeping a backup and starting fresh:', e.message);
    try { fs.copyFileSync(DB_FILE, DB_FILE + '.corrupt-' + Date.now()); } catch { /* ignore */ }
  }
}

const SAVE_DELAY_MS = pg ? (Number(ENV.DATABASE_SAVE_DELAY_MS) || 2500) : 500;
let timer = null; let dirty = false; let lastSaveAt = 0; let retryMs = 2000; let chain = Promise.resolve(); let writing = false;
export function save() { dirty = true; lastSaveAt = Date.now(); if (!timer) timer = setTimeout(flush, SAVE_DELAY_MS); }
/** Writes pending changes. Always returns a promise (already settled when storing in files). */
export function flush() {
  clearTimeout(timer); timer = null;
  if (!pg) {
    if (!dirty) return Promise.resolve();
    dirty = false;
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
    return Promise.resolve();
  }
  chain = chain.then(async () => {
    if (!dirty) return;
    dirty = false; writing = true;
    try { pgVersion = await pg.saveState(JSON.stringify(db), pgVersion); retryMs = 2000; } catch (e) {
      if (e instanceof ConflictError || e.code === 'CONFLICT') anotherInstance();
      dirty = true; console.error('[orate] could not save to the database, will retry:', e.message);
      if (!timer) { timer = setTimeout(flush, retryMs); retryMs = Math.min(60_000, retryMs * 2); }
    } finally { writing = false; }
  });
  return chain;
}
/** Two Orate processes share this database (e.g. an old and a new deploy). Never overwrite; restart so we load the latest data. */
function anotherInstance() {
  console.error('[orate] The database was changed by another Orate instance. Exiting so this one restarts with the latest data.\n        (Run only one Orate instance per database.)');
  process.exit(1);
}
if (pg) {
  // While people are active, notice quickly when another instance wrote. Stay quiet when idle so a serverless database can suspend.
  setInterval(async () => {
    if (dirty || writing || Date.now() - lastSaveAt > 10 * 60_000) return;
    try { const v = await pg.peekVersion(); if (v && v !== pgVersion && !dirty && !writing) anotherInstance(); } catch { /* the next write will tell */ }
  }, 30_000).unref();
}
process.on('exit', () => { if (!pg) flush(); });
migrateDb();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {   // flush, then leave (at most ~8 s for a slow database)
  const bye = setTimeout(() => process.exit(0), 8000); bye.unref();
  Promise.resolve(flush()).catch(() => {}).finally(() => process.exit(0));
});

/** Uploads: always kept in data/uploads (a cache when Postgres is used) and, with DATABASE_URL, also in the database. */
export async function storeUpload(name, type, buf) {
  if (pg) await pg.putFile(name, type, buf);   // first, so a full database refuses the upload before anything is kept
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
}
/** Makes sure an uploaded file is on local disk (fetching it from the database after a restart). Resolves whether it exists. */
export async function restoreUpload(name) {
  if (!isSafeFileName(name)) return false;
  const file = path.join(UPLOAD_DIR, name);
  if (fs.existsSync(file)) return true;
  if (!pg) return false;
  const f = await pg.getFile(name); if (!f) return false;
  const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, f.data); fs.renameSync(tmp, file);
  return true;
}
export const storageSummary = () => (pg ? `PostgreSQL (${pg.host})` : `local files (${path.relative(ROOT, DATA_DIR) || '.'}/)`);

let lastId = 0;
export function newId() { let t = Date.now() * 1000; if (t <= lastId) t = lastId + 1; lastId = t; return String(t); }
export const cmpId = (a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0);
export const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/* indexes (rebuilt on load) */
export const byUsername = new Map();
export const byEmail = new Map();
for (const u of Object.values(db.users)) { byUsername.set(u.username, u.id); if (u.email) byEmail.set(u.email, u.id); delete u.tag; delete u.decoration; }   // tags and avatar decorations no longer exist
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
// sockets of accounts that must verify their email first: they get no events and may do nothing (see verify.js)
export const gatedConns = new Map();
/** Closes every live socket of a user (so their client reconnects and re-bootstraps). */
export function closeConns(userId, code, reason, { onlyGated = false } = {}) {
  for (const set of onlyGated ? [gatedConns.get(userId)] : [conns.get(userId), gatedConns.get(userId)]) for (const c of set || []) { try { c.ws.close(code, reason); } catch { /* ignore */ } }
}
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
export const PERMS = ['ADMINISTRATOR', 'MANAGE_SERVER', 'MANAGE_CHANNELS', 'MANAGE_ROLES', 'MANAGE_MESSAGES', 'KICK_MEMBERS', 'BAN_MEMBERS', 'CREATE_INVITE', 'SEND_MESSAGES', 'ATTACH_FILES', 'ADD_REACTIONS', 'MENTION_EVERYONE', 'CONNECT', 'SPEAK', 'CHANGE_NICKNAME', 'MANAGE_NICKNAMES', 'VIEW_CHANNEL'];
export const DEFAULT_PERMS = ['VIEW_CHANNEL', 'CREATE_INVITE', 'SEND_MESSAGES', 'ATTACH_FILES', 'ADD_REACTIONS', 'CONNECT', 'SPEAK', 'CHANGE_NICKNAME'];
/** The permissions a channel (or category) can override per role / member — MANAGE_ROLES doubles as "Manage Permissions" there. */
export const CHANNEL_PERMS = ['VIEW_CHANNEL', 'MANAGE_CHANNELS', 'MANAGE_ROLES', 'CREATE_INVITE', 'SEND_MESSAGES', 'ATTACH_FILES', 'ADD_REACTIONS', 'MENTION_EVERYONE', 'MANAGE_MESSAGES', 'CONNECT', 'SPEAK'];
const CHANNEL_PERM_SET = new Set(CHANNEL_PERMS);

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

/* ---- channel permission overwrites (Discord's model) ----
 * A channel or category holds `overwrites: [{ type: 'role' | 'member', id, allow: [perm], deny: [perm] }]`.
 * A channel inside a category is *synced* unless `synced === false`: it then uses its category's overwrites as they are, so editing
 * the category updates every synced channel, and "unsyncing" copies them into the channel so it can diverge. */
export const isSynced = (ch) => !!ch && ch.type !== 'category' && !!ch.parentId && ch.synced !== false && !!db.channels[ch.parentId];
export function overwritesOf(ch) {
  if (!ch) return [];
  if (isSynced(ch)) return db.channels[ch.parentId].overwrites || [];
  return ch.overwrites || [];
}
/** What a member may do in one channel: server permissions, then @everyone's overwrite, then the member's roles' overwrites, then their own. */
export function permsIn(server, userId, ch) {
  const base = permsOf(server, userId);
  if (!ch || !server.members[userId] || base.has('ADMINISTRATOR')) return base;   // owners and administrators see and may do everything
  const ows = overwritesOf(ch);
  const out = new Set(base);
  if (ows.length) {
    const apply = (allow, deny) => { for (const p of deny) out.delete(p); for (const p of allow) out.add(p); };
    const ev = ows.find((o) => o.type === 'role' && o.id === server.id); if (ev) apply(ev.allow, ev.deny);
    const allow = new Set(); const deny = new Set(); const roles = server.members[userId].roles;
    for (const o of ows) if (o.type === 'role' && o.id !== server.id && roles.includes(o.id)) { for (const p of o.allow) allow.add(p); for (const p of o.deny) deny.add(p); }
    apply(allow, deny);
    const mo = ows.find((o) => o.type === 'member' && o.id === userId); if (mo) apply(mo.allow, mo.deny);
  }
  return out.has('VIEW_CHANNEL') ? out : new Set();   // a channel you cannot see grants nothing
}
export function canIn(userId, ch, perm) {
  const server = ch?.serverId && db.servers[ch.serverId];
  return !!server && permsIn(server, userId, ch).has(perm);
}
export function needIn(userId, ch, perm) { if (!canIn(userId, ch, perm)) throw forbidden(); }
export function canView(userId, ch) {
  if (!ch) return false;
  if (!ch.serverId) return (ch.recipients || []).includes(userId);
  const server = db.servers[ch.serverId];
  if (!server || !server.members[userId]) return false;
  return permsIn(server, userId, ch).has('VIEW_CHANNEL');
}
/** In the channel list a category is shown when you can see it or any channel inside it. */
export function listedFor(userId, ch) {
  if (canView(userId, ch)) return true;
  return ch.type === 'category' && Object.values(db.channels).some((c) => c.parentId === ch.id && canView(userId, c));
}
/** Validates overwrites coming from a client: known roles / members, known permissions, no duplicates. */
export function sanitizeOverwrites(server, list) {
  const out = []; const seen = new Set();
  for (const o of Array.isArray(list) ? list : []) {
    const type = o?.type === 'member' ? 'member' : o?.type === 'role' ? 'role' : null; const id = String(o?.id ?? '');
    if (!type || seen.has(type + id)) continue;
    if (type === 'role' ? !server.roles.some((r) => r.id === id) : !server.members[id]) continue;
    const pick = (a) => [...new Set((Array.isArray(a) ? a : []).filter((p) => CHANNEL_PERM_SET.has(p)))];
    const allow = pick(o.allow); const deny = pick(o.deny).filter((p) => !allow.includes(p));
    seen.add(type + id); out.push({ type, id, allow, deny });
    if (out.length >= 100) break;
  }
  return out;
}
/** Brings an old database up to date: VIEW_CHANNEL on @everyone, and the old "private channel" lists turned into overwrites. */
function migrateDb() {
  let changed = false;
  for (const s of Object.values(db.servers)) {
    if (s.permsV === 2) continue;
    const ev = s.roles.find((r) => r.id === s.id);
    if (ev && !ev.permissions.includes('VIEW_CHANNEL')) ev.permissions.push('VIEW_CHANNEL');
    s.permsV = 2; changed = true;
  }
  for (const c of Object.values(db.channels)) {
    if (!c.serverId || !('private' in c || 'allowedRoles' in c || 'allowedUsers' in c)) continue;
    if (c.private) {
      c.overwrites = [{ type: 'role', id: c.serverId, allow: [], deny: ['VIEW_CHANNEL'] },
        ...(c.allowedRoles || []).map((id) => ({ type: 'role', id, allow: ['VIEW_CHANNEL'], deny: [] })),
        ...(c.allowedUsers || []).map((id) => ({ type: 'member', id, allow: ['VIEW_CHANNEL'], deny: [] }))];
      if (c.parentId) c.synced = false;
    }
    delete c.private; delete c.allowedRoles; delete c.allowedUsers; changed = true;
  }
  if (changed) save();
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
  emitTo(relatedUserIds(userId), 'presence_update', { userId, status: effectiveStatus(u), customStatus: u.customStatus || null, listening: visibleListening(u) });
}

/* --------------------------------------------------------- serializers */
/** What other people may see of the track someone is playing: nothing if they turned off Activity Status, are invisible, or it must have ended. */
export function visibleListening(u) {
  const l = u?.listening;
  if (!l || l.endsAt < Date.now() || u.status === 'invisible' || u.settings?.privacy?.showActivity === false) return null;
  return l;
}
export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, username: u.username, displayName: u.displayName, avatar: u.avatar || null,
    banner: u.banner || null, bannerColor: u.bannerColor || null, accentColor: u.accentColor || null,
    bio: u.bio || '', pronouns: u.pronouns || '', createdAt: u.createdAt,
    bot: !!u.bot, status: effectiveStatus(u), customStatus: u.customStatus || null, listening: visibleListening(u),
  };
}
export function selfUser(u) {
  return { ...publicUser(u), email: u.email, status: u.status || 'online', settings: u.settings || {}, dob: u.dob || null, emailVerified: u.emailVerified !== false };
}

export function serverView(server, userId) {
  const chans = channelsOfServer(server.id).filter((c) => listedFor(userId, c)).map((c) => channelView(c, userId)).sort((a, b) => a.position - b.position);
  return {
    id: server.id, name: server.name, icon: server.icon || null, banner: server.banner || null,
    description: server.description || '', ownerId: server.ownerId, createdAt: server.createdAt,
    accent: server.accent || null, roles: server.roles, channels: chans,
    members: Object.entries(server.members).map(([id, m]) => ({ id, roles: m.roles, nick: m.nick || null, joinedAt: m.joinedAt })),
    perms: [...permsOf(server, userId)], systemChannelId: server.systemChannelId || null,
  };
}
/** `userId` adds what that member may do here (`cperms`, only when overwrites make it differ from their server-wide permissions) and, for people who can manage permissions, the overwrites themselves. */
export function channelView(c, userId) {
  const v = {
    id: c.id, serverId: c.serverId || null, type: c.type, name: c.name || null, topic: c.topic || '',
    parentId: c.parentId || null, position: c.position || 0,
    recipients: c.recipients || undefined, ownerId: c.ownerId || undefined,
    icon: c.icon || undefined, lastMessageId: lastMessageId(c.id), nsfw: !!c.nsfw, slowmode: c.slowmode || 0,
  };
  if (c.serverId) {
    const ows = overwritesOf(c);
    v.private = ows.some((o) => o.type === 'role' && o.id === c.serverId && o.deny.includes('VIEW_CHANNEL'));
    if (c.type !== 'category' && c.parentId) v.synced = isSynced(c);
    const server = db.servers[c.serverId];
    if (userId && server) {
      const p = permsIn(server, userId, c);
      if (ows.length) v.cperms = [...p];
      if (p.has('MANAGE_ROLES')) v.overwrites = ows;
    }
  }
  return v;
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
  db.users[id] = { id, username: 'orbit', displayName: 'Orbit', email: null, bot: true, status: 'online', createdAt: Date.now(), bio: 'Your friendly Orate helper. Say "help" in a DM.', bannerColor: '#6d28d9', rel: {}, reads: {}, settings: {} };
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
