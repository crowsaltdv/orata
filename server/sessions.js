// Orata — sign-in sessions.
//
// A session is created on login and then lives until its owner logs out (or changes their password, or deletes the account) — there is no
// expiry, so nobody is signed out "automatically". Where it is kept:
//   * local files: inside db.json, like everything else;
//   * PostgreSQL:  in its own table (orate_sessions), written *before* the login answers. It deliberately is not part of the one big
//                  state row: that row is guarded by a version number, and when two processes share a database (an old and a new
//                  deploy, two Render links, a laptop next to the server) the loser of a write race restarts and forgets what it had not
//                  saved yet — which used to sign people out the moment they logged in.
import crypto from 'node:crypto';
import { db, pg, sha, save } from './core.js';

const cache = new Map();   // hash → session; only used with Postgres (a lookup is one query, then it stays in memory)

if (pg) {
  // sessions from before this table existed move over once; nobody has to sign in again
  const legacy = Object.entries(db.sessions || {});
  if (legacy.length) {
    for (const [hash, s] of legacy) await pg.putSession(hash, { userId: s.userId, createdAt: s.createdAt || Date.now(), lastUsed: s.lastUsed || Date.now(), ua: s.ua || '' });
    db.sessions = {}; save();
  }
}

/** Resolves a new bearer token. */
export async function createSession(userId, ua = '') {
  const token = crypto.randomBytes(32).toString('base64url'); const hash = sha(token);
  const s = { userId, createdAt: Date.now(), lastUsed: Date.now(), ua: String(ua || '').slice(0, 200) };
  if (pg) { await pg.putSession(hash, s); cache.set(hash, s); } else { db.sessions[hash] = s; save(); }
  return token;
}

/** Resolves `{ hash, rec }` for a bearer token, or null when it is not (or no longer) a session. */
export async function findSession(token) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const hash = sha(token);
  let rec = cache.get(hash) || db.sessions[hash] || null;
  if (!rec && pg) { rec = await pg.getSession(hash); if (rec) cache.set(hash, rec); }
  return rec ? { hash, rec } : null;
}

/** Remembers that the session was used (at most once an hour, so a busy account does not write constantly). */
export function touchSession(hash, rec) {
  if (Date.now() - rec.lastUsed < 3600_000) return;
  rec.lastUsed = Date.now();
  if (pg) pg.touchSession(hash, rec.lastUsed).catch(() => {}); else save();
}

export async function endSession(hash) {
  cache.delete(hash);
  if (db.sessions[hash]) { delete db.sessions[hash]; save(); }
  if (pg) await pg.deleteSession(hash);
}
/** Ends all of a user's sessions, except (optionally) one. */
export async function endUserSessions(userId, exceptHash = null) {
  for (const [hash, s] of Object.entries(db.sessions)) if (s.userId === userId && hash !== exceptHash) { delete db.sessions[hash]; save(); }
  for (const [hash, s] of cache) if (s.userId === userId && hash !== exceptHash) cache.delete(hash);
  if (pg) await pg.deleteUserSessions(userId, exceptHash);
}
/** `[{ hash, userId, createdAt, lastUsed, ua }]` — no addresses are kept. */
export async function listSessions(userId) {
  const out = new Map();
  for (const [hash, s] of Object.entries(db.sessions)) if (s.userId === userId) out.set(hash, { hash, userId, createdAt: s.createdAt, lastUsed: s.lastUsed, ua: s.ua || '' });
  if (pg) for (const s of await pg.listSessions(userId)) out.set(s.hash, s);
  return [...out.values()];
}
