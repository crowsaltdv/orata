// Orata — shared server core: persistence, ids, permissions, serializers, event fan-out.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { ROOT, ENV, loadEnv } from './env.js';
import { PgStore, ConflictError, isSafeFileName } from './storage.js';
import { sanitizeProfileStyle } from '../public/js/profile-data.js';
export { ROOT, ENV, loadEnv };
export const DATA_DIR = process.env.ORATE_DATA || path.join(ROOT, 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'db.json');

/** A random, good-looking gradient for a default avatar (the colour behind the logo): two hues a little apart, rich but never neon or muddy. */
export function randomAvatarBg() {
  const hex = (h, s, l) => {
    s /= 100; l /= 100; const k = (n) => (n + h / 30) % 12; const a = s * Math.min(l, 1 - l); const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return '#' + [f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  };
  const h = Math.floor(Math.random() * 360); const h2 = (h + 35 + Math.floor(Math.random() * 60)) % 360;
  return { a: hex(h, 70 + Math.random() * 15, 52 + Math.random() * 8), b: hex(h2, 68 + Math.random() * 17, 44 + Math.random() * 10), angle: Math.floor(Math.random() * 24) * 15 };
}

/* ---------------------------------------------------------------- browser ids, for bans
 * Orata keeps no IP addresses and ignores the network entirely: two people on one connection (a school, a café, a family) are strangers. To make bans
 * stick, each account remembers a few keyed hashes (HMAC) of the random ids of the browsers it was used from; they are never sent to clients. */
/** A keyed hash of the random id each browser sends (x-orate-device): a much stronger sign of "same person" than a shared network. */
export function deviceHash(id) {
  const v = String(id || ''); if (!/^[A-Za-z0-9_-]{16,64}$/.test(v)) return null;
  if (!db.ipSecret) { db.ipSecret = crypto.randomBytes(24).toString('hex'); save(); }
  return 'dv' + crypto.createHmac('sha256', db.ipSecret).update('dev:' + v).digest('hex').slice(0, 22);
}
/** The ids a browser carries: the header the page sends and its first-party cookie (the page keeps both in step, so clearing just one of them does not make it a new browser). */
function cookieValue(req, name) {
  const m = String(req?.headers?.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  if (!m) return '';
  try { return decodeURIComponent(m[1]); } catch { return ''; }
}
export const deviceHashes = (req) => [...new Set([deviceHash(req?.headers?.['x-orate-device']), deviceHash(cookieValue(req, 'orate_dev'))].filter(Boolean))];
const remember = (user, field, h, max) => {
  const now = Date.now(); const list = (user[field] ||= []); const hit = list.find((x) => x.h === h);
  if (hit) { if (now - hit.at > 6 * 3600_000) { hit.at = now; save(); } return; }
  list.unshift({ h, at: now }); if (list.length > max) list.length = max; save();
};
/** Remembers (as hashes) the browser this account just used; at most 8, refreshed at most every 6 hours. Used only to find ban evaders and alts. */
export function noteDevice(user, req) {
  if (!user) return;
  for (const d of deviceHashes(req)) remember(user, 'devs', d, 8);
}
/** Everything that links an account to others: the browsers it was recently used from (plus `extra`, e.g. the one it is using right now). */
export const deviceHashesOf = (user, extra = null) => {
  const now = Date.now(); const fresh = (x) => now - x.at < 180 * 86400_000;
  const out = new Set((user?.devs || []).filter(fresh).map((x) => x.h));
  for (const e of [].concat(extra || [])) if (e) out.add(e);
  return out;
};
/** The hashes of the browser this request came from. */
export const requestHashes = (req) => deviceHashes(req);

/* ---------------------------------------------------------------- db: files in data/ (default) or PostgreSQL (DATABASE_URL) */
export const pg = ENV.DATABASE_URL ? new PgStore(ENV.DATABASE_URL, ENV) : null;
const empty = () => ({ users: {}, sessions: {}, servers: {}, channels: {}, messages: {}, invites: {}, emailTokens: {}, botId: null, defaultServerId: null });
export let db = empty();
/** Orate_dev: co-owner of the community server and one of the first developers (see migrateDb and badges.js). */
export const ORATE_DEV_ID = '1792465419498000';
let pgVersion = 0;   // the version of the database row this process last loaded or wrote

if (pg) {
  await pg.init();
  const st = await pg.loadState();
  if (st) { db = { ...empty(), ...JSON.parse(st.json) }; pgVersion = st.version; }
  else {
    // A brand-new database. Adopt local files (data/db.json + uploads/) if there are any, so moving to Postgres loses nothing.
    let seed = empty(); let adopted = false;
    if (fs.existsSync(DB_FILE)) {
      try { seed = { ...empty(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; adopted = true; } catch (e) { console.error('[orata] data/db.json is unreadable, not importing it:', e.message); }
    }
    pgVersion = await pg.createState(JSON.stringify(seed));
    if (pgVersion) {
      db = seed;
      if (adopted) {
        console.log('[orata] This database is empty, so your local data/db.json was imported into it.');
        const r = await pg.importDir(UPLOAD_DIR, console.log);
        console.log(`[orata] ${r.added} uploaded file(s) copied to the database.`);
      }
    } else { const again = await pg.loadState(); db = { ...empty(), ...JSON.parse(again.json) }; pgVersion = again.version; }   // another instance created it a moment ago
  }
} else {
  try {
    if (fs.existsSync(DB_FILE)) db = { ...empty(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
  } catch (e) {
    console.error('[orata] db.json unreadable, keeping a backup and starting fresh:', e.message);
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
      if (e instanceof ConflictError || e.code === 'CONFLICT') { await anotherInstance(); return; }
      dirty = true; console.error('[orata] could not save to the database, will retry:', e.message);
      if (!timer) { timer = setTimeout(flush, retryMs); retryMs = Math.min(60_000, retryMs * 2); }
    } finally { writing = false; }
  });
  return chain;
}
/** Two Orata processes share this database. Never overwrite the other's data. In this process's first minutes that's a deploy: the old
 *  version keeps saving until the host switches over to this one (and quitting would only make the host retry, never finishing the deploy),
 *  so load the newer data and carry on, like a restart would but without one. After that it's two instances by mistake: exit, as before.
 *  Either way, this process's changes since its last save are dropped (they're the other one's to keep). */
const STARTED_AT = Date.now();
const TAKEOVER_MS = Number(ENV.DATABASE_TAKEOVER_GRACE_MS ?? 5 * 60_000);
async function anotherInstance() {
  if (Date.now() - STARTED_AT < TAKEOVER_MS && await reload()) { console.error('[orata] Another Orata instance (an older deploy still shutting down?) saved to the database: loaded its newer data instead of exiting.'); return; }
  console.error('[orata] The database was changed by another Orata instance. Exiting so this one restarts with the latest data.\n        (Run only one Orata instance per database.)');
  process.exit(1);
}
/** Loads the newest save in place of this process's data (dropping anything unsaved). */
async function reload() {
  const st = await pg.loadState().catch(() => null); if (!st) return false;
  adopt(st.json); pgVersion = st.version; dirty = false; clearTimeout(timer); timer = null;
  for (const uid of [...conns.keys(), ...gatedConns.keys()]) closeConns(uid, 4000, 'reloaded');   // their apps reconnect and load the newer data
  return true;
}
/** Swaps in newer data, keeping this object and its top-level objects (anything holding one keeps seeing current data). */
function adopt(json) {
  const fresh = { ...empty(), ...JSON.parse(json) };
  for (const k of Object.keys(db)) if (!(k in fresh)) delete db[k];
  for (const [k, v] of Object.entries(fresh)) {
    const cur = db[k];
    if (cur && v && typeof cur === 'object' && typeof v === 'object' && !Array.isArray(cur) && !Array.isArray(v)) { for (const x of Object.keys(cur)) delete cur[x]; Object.assign(cur, v); } else db[k] = v;
  }
  indexUsers();
}
if (pg) {
  // A new deploy's first minutes: while this process has nothing unsaved, pick up the old version's saves at once, so its own changes
  // land on current data instead of conflicting (and being dropped) later
  let said = false;
  const keepUp = setInterval(async () => {
    if (Date.now() - STARTED_AT >= TAKEOVER_MS) { clearInterval(keepUp); return; }
    if (dirty || writing) return;
    try {
      const v = await pg.peekVersion();
      if (v && v !== pgVersion && !dirty && !writing && await reload() && !said) { said = true; console.log('[orata] Another Orata instance (an older deploy?) is still saving to the database: keeping up with its data until it stops.'); }
    } catch { /* the next check or write will tell */ }
  }, 1000);
  keepUp.unref();
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
/** Deletes an upload everywhere it is kept (used when an audio message expires). */
export function removeUpload(name) {
  if (!isSafeFileName(name)) return;
  try { fs.unlinkSync(path.join(UPLOAD_DIR, name)); } catch { /* already gone */ }
  if (pg) pg.deleteFile(name).catch((e) => console.error('[orata] could not delete an expired upload:', e.message));
}
export const storageSummary = () => (pg ? `PostgreSQL (${pg.host})` : `local files (${path.relative(ROOT, DATA_DIR) || '.'}/)`);

let lastId = 0;
export function newId() { let t = Date.now() * 1000; if (t <= lastId) t = lastId + 1; lastId = t; return String(t); }
export const cmpId = (a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0);
export const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/* indexes (rebuilt on load) */
export const byUsername = new Map();
export const byEmail = new Map();
function indexUsers() {
  byUsername.clear(); byEmail.clear();
  for (const u of Object.values(db.users)) { if (!u.serverBot) byUsername.set(u.username, u.id); if (u.email) byEmail.set(u.email, u.id); delete u.tag; delete u.decoration; }   // personal tags (server tags replaced them) and avatar decorations no longer exist
}
indexUsers();
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
export const PERMS = ['ADMINISTRATOR', 'MANAGE_SERVER', 'MANAGE_CHANNELS', 'MANAGE_ROLES', 'MANAGE_MESSAGES', 'KICK_MEMBERS', 'BAN_MEMBERS', 'CREATE_INVITE', 'SEND_MESSAGES', 'ATTACH_FILES', 'ADD_REACTIONS', 'USE_REACTIONS', 'MENTION_EVERYONE', 'CONNECT', 'SPEAK', 'CHANGE_NICKNAME', 'MANAGE_NICKNAMES', 'VIEW_CHANNEL', 'MODERATE_MEMBERS', 'MANAGE_EXPRESSIONS', 'SEND_GIFS', 'ACCESS_APPLICATIONS'];
export const DEFAULT_PERMS = ['VIEW_CHANNEL', 'CREATE_INVITE', 'SEND_MESSAGES', 'SEND_GIFS', 'ATTACH_FILES', 'ADD_REACTIONS', 'USE_REACTIONS', 'CONNECT', 'SPEAK', 'CHANGE_NICKNAME'];
/** The permissions a channel (or category) can override per role / member — MANAGE_ROLES doubles as "Manage Permissions" there. */
export const CHANNEL_PERMS = ['VIEW_CHANNEL', 'MANAGE_CHANNELS', 'MANAGE_ROLES', 'CREATE_INVITE', 'SEND_MESSAGES', 'ATTACH_FILES', 'ADD_REACTIONS', 'USE_REACTIONS', 'MENTION_EVERYONE', 'MANAGE_MESSAGES', 'CONNECT', 'SPEAK'];
const CHANNEL_PERM_SET = new Set(CHANNEL_PERMS);

export function memberOf(server, userId) { return server?.members?.[userId] || null; }
/** The owner, or a co-owner (`server.coOwners`, while they are a member): every permission, above every role. Deleting or transferring the server stays the owner's alone. */
export const isOwner = (server, userId) => server?.ownerId === userId || (!!server?.members?.[userId] && !!server.coOwners?.includes(userId));
/** Writes down who did what in a server's audit log (Server Settings → Audit Log), newest first, at most 500 kept. actorId null = AutoMod. */
export function audit(server, actorId, action, { target = null, reason = '', ...details } = {}) {
  if (!server) return;
  (server.auditLog ||= []).unshift({ id: newId(), at: Date.now(), actorId, action, target, ...(reason ? { reason: String(reason).slice(0, 200) } : {}), ...(Object.keys(details).length ? { details } : {}) });
  if (server.auditLog.length > 500) server.auditLog.length = 500;
}
/** Orata staff looking around a server they aren't in (Staff page → Servers → Ghost in, server/staff.js): user id → { serverId, at }.
 * A ghost can see every channel and message there and nothing more: read only, not in the member list, over after 2 hours. */
export const ghosts = new Map();
export const ghostIn = (userId, serverId) => { const g = ghosts.get(userId); return !!g && g.serverId === serverId && Date.now() - g.at < 2 * 3600_000; };
export function permsOf(server, userId) {
  if (!server) return new Set();
  if (isOwner(server, userId)) return new Set(PERMS);
  const m = server.members[userId];
  if (!m) return ghostIn(userId, server.id) ? new Set(['VIEW_CHANNEL']) : new Set();
  const set = new Set(server.roles.find((r) => r.id === server.id)?.permissions || []);
  for (const rid of m.roles) for (const p of server.roles.find((r) => r.id === rid)?.permissions || []) set.add(p);
  if (set.has('ADMINISTRATOR')) return new Set(PERMS);
  if (m.pending) return new Set(['VIEW_CHANNEL']);   // hasn't accepted the server's rules yet (onboarding): read only
  if (m.timeoutUntil > Date.now()) return new Set(['VIEW_CHANNEL']);   // timed out: you can read, nothing else
  return set;
}
export const isTimedOut = (server, userId) => (server?.members?.[userId]?.timeoutUntil || 0) > Date.now();
export const can = (server, userId, perm) => permsOf(server, userId).has(perm);
export function need(server, userId, perm) { if (!can(server, userId, perm)) throw forbidden(); }
export function topRolePos(server, userId) {
  if (isOwner(server, userId)) return Infinity;
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
  if (ch.type === 'post') return overwritesOf(db.channels[ch.forumId]);   // a forum post follows its forum
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
  if (ch.applications) { if (base.has('ACCESS_APPLICATIONS')) out.add('VIEW_CHANNEL'); else out.delete('VIEW_CHANNEL'); }   // the applications channel follows the permission, not overwrites
  if (isTimedOut(server, userId)) return out.has('VIEW_CHANNEL') ? new Set(['VIEW_CHANNEL']) : new Set();   // overwrites cannot lift a timeout
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
  if (!server || !(server.members[userId] || ghostIn(userId, server.id))) return false;
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
    if ((s.permsV || 0) < 2) {
      const ev = s.roles.find((r) => r.id === s.id);
      if (ev && !ev.permissions.includes('VIEW_CHANNEL')) ev.permissions.push('VIEW_CHANNEL');
      s.permsV = 2; changed = true;
    }
    if (s.permsV < 3) {   // v3: "Send GIFs & Stickers" is its own permission — everybody who could already send messages keeps being able to
      for (const role of s.roles) if (role.permissions.includes('SEND_MESSAGES') && !role.permissions.includes('SEND_GIFS')) role.permissions.push('SEND_GIFS');
      s.permsV = 3; changed = true;
    }
    if (s.permsV < 4) {   // v4: "React to Messages" (joining a reaction that is already there) is its own permission, apart from "Add New Reactions" — whoever could react keeps being able to, and a channel that denied reactions keeps denying them
      for (const role of s.roles) if (role.permissions.includes('ADD_REACTIONS') && !role.permissions.includes('USE_REACTIONS')) role.permissions.push('USE_REACTIONS');
      for (const c of Object.values(db.channels)) if (c.serverId === s.id) for (const o of c.overwrites || []) for (const k of ['allow', 'deny']) if (o[k]?.includes('ADD_REACTIONS') && !o[k].includes('USE_REACTIONS')) o[k].push('USE_REACTIONS');
      s.permsV = 4; changed = true;
    }
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
  if (!db.avatarBgDone) {   // once: every account gets its own random gradient behind the default avatar's logo
    for (const u of Object.values(db.users)) if (!u.avatarBg) u.avatarBg = randomAvatarBg();
    db.avatarBgDone = true; changed = true;
  }
  // bans no longer follow networks: forget the network hashes kept for that, keep the browser ones
  for (const u of Object.values(db.users)) if (u.ips) { delete u.ips; changed = true; }
  for (const s of Object.values(db.servers)) {
    if (s.bannedIps) {
      s.bannedDevices ||= {};
      for (const [h, id] of Object.entries(s.bannedIps)) if (h.startsWith('dv')) s.bannedDevices[h] = id;
      delete s.bannedIps; changed = true;
    }
    if (s.timeoutLinks) { s.timeoutLinks = s.timeoutLinks.map((l) => ({ ...l, hashes: (l.hashes || []).filter((h) => String(h).startsWith('dv')) })).filter((l) => l.hashes.length); changed = true; }
  }
  if (!db.coOwnerSeedV1) {   // once: Orate_dev co-owns the community server next to its owner
    const community = db.servers[db.defaultServerId];
    if (community && !community.coOwners?.includes(ORATE_DEV_ID)) (community.coOwners ||= []).push(ORATE_DEV_ID);
    db.coOwnerSeedV1 = true; changed = true;
  }
  if (!db.orataRenameV1) {   // once: Orate is now Orata, so rename what was saved under the old name (unless someone changed it since)
    const community = db.servers[db.defaultServerId];
    if (community?.name === 'Orate Community') community.name = 'Orata Community';
    if (community?.description === 'The default hangout for everyone on this Orate instance.') community.description = 'The default hangout for everyone on this Orata instance.';
    for (const u of Object.values(db.users)) if (u.bot && u.bio === 'Your friendly Orate helper. Say "help" in a DM.') u.bio = 'Your friendly Orata helper. Say "help" in a DM.';
    db.orataRenameV1 = true; changed = true;
  }
  if (changed) save();
}
export function audienceOf(ch) {
  if (!ch.serverId) return ch.recipients || [];
  const server = db.servers[ch.serverId]; if (!server) return [];
  const out = Object.keys(server.members).filter((uid) => canView(uid, ch));
  for (const uid of ghosts.keys()) if (!server.members[uid] && ghostIn(uid, server.id)) out.push(uid);   // staff ghosting here see new messages live
  return out;
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
/** The server tag a person wears next to their name (one server they are in that has a tag; see PUT /servers/:id/tag), or null. */
const wornTag = (u) => { const s = u?.tagServer && db.servers[u.tagServer]; return s?.tag && s.members[u.id] ? { text: s.tag.text, icon: s.tag.icon, color: s.tag.color, serverId: s.id, server: s.name } : null; };
export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, username: u.username, displayName: u.displayName, avatar: u.avatar || null,
    banner: u.banner || null, bannerColor: u.bannerColor || null, accentColor: u.accentColor || null,
    bio: u.bio || '', pronouns: u.pronouns || '', profile: u.profile ? sanitizeProfileStyle(u.profile) : null, avatarBg: u.avatarBg || null, createdAt: u.createdAt,   // (re-checked on the way out so styles saved by older versions, e.g. frames, simply disappear)
    bot: !!u.bot, status: effectiveStatus(u), customStatus: u.customStatus || null, listening: visibleListening(u),
    badges: (u.badges || []).map((id) => db.badges?.[id]).filter(Boolean), tag: wornTag(u), terminated: u.terminated ? true : undefined,   // whole badges (see badges.js), so a profile can show them without the catalog
  };
}
export function selfUser(u) {
  return { ...publicUser(u), tagServer: u.tagServer || null, email: u.email, status: u.status || 'online', settings: u.settings || {}, dob: u.dob || null, emailVerified: u.emailVerified !== false };
}

export function serverView(server, userId) {
  const chans = channelsOfServer(server.id).filter((c) => c.type !== 'post' && listedFor(userId, c)).map((c) => channelView(c, userId)).sort((a, b) => a.position - b.position);   // posts live inside their forum, not in the channel list
  return {
    id: server.id, name: server.name, icon: server.icon || null, banner: server.banner || null,
    description: server.description || '', ownerId: server.ownerId, coOwners: server.coOwners || [], createdAt: server.createdAt,
    accent: server.accent || null, roles: server.roles, channels: chans,
    orbitId: server.orbitId && server.members[server.orbitId] ? server.orbitId : null, orbitRoles: server.orbit?.roles || {},   // this server's Orbit (server/orbit.js)
    automod: server.automod || null, onboarding: server.onboarding || null, vanity: server.vanity || null, tag: server.tag || null,
    joinMode: server.joinMode || 'invite', applyQuestion: server.applyQuestion || '', applicationsChannelId: server.joinMode === 'apply' ? server.applicationsChannelId || null : null,
    members: Object.entries(server.members).map(([id, m]) => memberView(id, m)),
    perms: [...permsOf(server, userId)], systemChannelId: server.systemChannelId || null,
    emojis: server.emojis || [], stickers: server.stickers || [],
    safety: { profanity: server.safety?.profanity || 'off', ...(permsOf(server, userId).has('MANAGE_SERVER') || permsOf(server, userId).has('ADMINISTRATOR') || server.ownerId === userId ? { words: server.safety?.words || [] } : {}) },
  };
}
/** `userId` adds what that member may do here (`cperms`, only when overwrites make it differ from their server-wide permissions) and, for people who can manage permissions, the overwrites themselves. */
export const memberView = (id, m) => ({ id, roles: m.roles, nick: m.nick || null, joinedAt: m.joinedAt, timeoutUntil: m.timeoutUntil > Date.now() ? m.timeoutUntil : null, pending: m.pending ? true : undefined });
export function channelView(c, userId) {
  const v = c.type === 'post' ? { ...postView(c), position: 0, topic: '' } : {
    id: c.id, serverId: c.serverId || null, type: c.type, name: c.name || null, topic: c.topic || '',
    parentId: c.parentId || null, position: c.position || 0,
    recipients: c.recipients || undefined, ownerId: c.ownerId || undefined,
    icon: c.icon || undefined, emoji: c.emoji || undefined, lastMessageId: lastMessageId(c.id), nsfw: !!c.nsfw, slowmode: c.slowmode || 0,
  };
  if (c.serverId) {
    const ows = overwritesOf(c);
    if (c.type === 'forum') { v.tags = c.tags || []; v.requireTag = !!c.requireTag; }
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
/* ---- custom emoji ---- */
export const CUSTOM_EMOJI = /<(a?):([A-Za-z0-9_]{2,32}):(\d{6,20})>/g;
/** The custom emoji with this id in a server the person belongs to (anyone in a server may use its emoji everywhere). */
export function findEmoji(id, userId) {
  for (const s of Object.values(db.servers)) if (s.members[userId]) { const e = s.emojis?.find((x) => x.id === id); if (e) return { ...e, serverId: s.id }; }
  return null;
}
/** The emoji used in a message, with their pictures, so people who aren't in that server can still see them. */
export function customEmojisIn(content, userId, existing = []) {
  const out = new Map(existing.map((e) => [e.id, e]));
  for (const m of String(content || '').matchAll(CUSTOM_EMOJI)) {
    if (out.size >= 25 && !out.has(m[3])) break;
    const e = out.get(m[3]) || findEmoji(m[3], userId); if (e) out.set(m[3], { id: e.id, name: e.name, url: e.url, animated: !!e.animated });
  }
  return out.size ? [...out.values()] : undefined;
}
/* ---- polls ---- */
/** A poll as clients see it: who voted for what is public (like Discord's polls), `closed` once it ended. */
export function pollView(p) {
  const votes = p.votes || {};
  return {
    question: p.question, multi: !!p.multi, expiresAt: p.expiresAt || null, closed: !!p.closed || !!(p.expiresAt && p.expiresAt <= Date.now()), total: Object.keys(votes).length,
    answers: p.answers.map((a) => ({ id: a.id, text: a.text, emoji: a.emoji || null, voters: Object.entries(votes).filter(([, v]) => v.includes(a.id)).map(([uid]) => uid).slice(0, 200) })),
  };
}
/** A forum post as the forum list shows it. */
export function postView(p) {
  const list = db.messages[p.id] || []; const first = list[0];
  const img = first?.attachments?.find((a) => /^image\//.test(a.type || ''));
  return {
    id: p.id, serverId: p.serverId, type: 'post', forumId: p.forumId, name: p.name, ownerId: p.ownerId, createdAt: p.createdAt, lastActivity: p.lastActivity || p.createdAt,
    messageCount: Math.max(0, list.length - 1), tagIds: p.tagIds || [], locked: !!p.locked, pinned: !!p.pinned,
    preview: first ? String(first.content || '').slice(0, 300) : '', image: img?.url || null, lastMessageId: lastMessageId(p.id),
  };
}
export function lastMessageId(channelId) { const a = db.messages[channelId]; return a?.length ? a[a.length - 1].id : null; }

/** The application a card in the applications channel is about (server/applications.js). */
function applicationView(m) {
  const a = db.servers[db.channels[m.channelId]?.serverId]?.applications?.[m.application];
  return a ? { id: a.id, userId: a.userId, message: a.message, at: a.at, status: a.status, by: a.by || null, decidedAt: a.decidedAt || null, reason: a.reason || '' } : { id: m.application, status: 'gone' };
}
export function messageView(m) {
  let reply = null;
  if (m.replyTo) {
    const ref = (db.messages[m.channelId] || []).find((x) => x.id === m.replyTo);
    reply = ref ? { id: ref.id, authorId: ref.authorId, bridge: ref.bridge, content: (ref.content || '').slice(0, 160), attachments: (ref.attachments || []).length, gif: !!ref.gif, sticker: !!ref.sticker }
      : { id: m.replyTo, deleted: true };
  }
  return {
    id: m.id, channelId: m.channelId, authorId: m.authorId, content: m.content, createdAt: m.createdAt, editedAt: m.editedAt || null,
    attachments: m.attachments || [], gif: m.gif || null, sticker: m.sticker || null, reactions: m.reactions || {},
    replyTo: m.replyTo || null, reply, mentions: m.mentions || [], mentionRoles: m.mentionRoles || [],
    mentionEveryone: !!m.mentionEveryone, pinned: !!m.pinned, type: m.type || 'default', nonce: undefined, expiresAt: m.expiresAt || undefined, forward: m.forward || undefined, bridge: m.bridge || undefined, application: m.application ? applicationView(m) : undefined, command: m.command ? { name: m.command.name } : undefined /* who used it: only server admins and staff may ask (orbit.js) */, emojis: m.emojis, poll: m.poll ? pollView(m.poll) : undefined, theme: m.theme || undefined,
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

export const RESERVED = new Set(['everyone', 'here', 'admin', 'administrator', 'system', 'orate', 'orata', 'moderator', 'staff']);

export function ensureBot() {
  if (db.botId && db.users[db.botId]) return db.users[db.botId];
  const id = newId();
  db.users[id] = { id, username: 'orbit', displayName: 'Orbit', email: null, bot: true, avatarBg: randomAvatarBg(), status: 'online', createdAt: Date.now(), bio: 'Your friendly Orata helper. Say "help" in a DM.', bannerColor: '#6d28d9', rel: {}, reads: {}, settings: {} };
  byUsername.set('orbit', id);
  db.botId = id;
  save();
  return db.users[id];
}

export function createServer(owner, { name, icon = null, template = 'default' }) {
  const id = newId();
  const everyone = { id, name: '@everyone', color: null, position: 0, permissions: [...DEFAULT_PERMS], hoist: false };
  const server = { id, name: String(name).slice(0, 100), icon, banner: null, description: '', ownerId: owner.id, createdAt: Date.now(), permsV: 4, roles: [everyone], members: { [owner.id]: { roles: [], joinedAt: Date.now() } }, bans: [], accent: null };
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
  server.members[user.id] = { roles: [], joinedAt: Date.now(), ...(server.onboarding?.enabled && !user.bot ? { pending: true } : {}) };   // with onboarding on, a newcomer reads the rules first
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
