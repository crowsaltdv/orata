// Orate — optional PostgreSQL storage (set DATABASE_URL).
//
// Without DATABASE_URL Orate keeps everything in files under data/ (db.json + uploads/). That is perfect on your own computer but
// useless on hosts whose disk is wiped on every restart (Render's free plan, Heroku, …). With DATABASE_URL — a free Neon or Supabase
// database works — the same data lives in Postgres instead:
//
//   orate_state   one row: the whole database as gzipped JSON plus a version number (optimistic concurrency, see core.js)
//   orate_files   one row per uploaded file (avatars, attachments …)
//
// This file only talks to Postgres; core.js decides when to load and save.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
export const isSafeFileName = (n) => typeof n === 'string' && n.length < 200 && SAFE_NAME.test(n);

export class ConflictError extends Error { constructor() { super('the database was changed by another Orate instance'); this.code = 'CONFLICT'; } }
export class QuotaError extends Error { constructor(msg) { super(msg); this.code = 'QUOTA'; } }

const TRANSIENT = /Connection terminated|ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED|57P01|08006|08003|08001|terminating connection|timeout exceeded|server closed the connection/i;
const isTransient = (e) => TRANSIENT.test(`${e?.message || ''} ${e?.code || ''}`);

/** Turns DATABASE_URL (+ DATABASE_SSL) into pg Pool options. TLS is decided here because pg lets the URL's sslmode override options. */
export function poolOptions(url, env = {}) {
  const u = new URL(url);
  const mode = (u.searchParams.get('sslmode') || '').toLowerCase();
  u.searchParams.delete('sslmode'); u.searchParams.delete('ssl'); u.searchParams.delete('uselibpqcompat');
  const loopback = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/i.test(u.hostname);
  const setting = String(env.DATABASE_SSL ?? '').trim().toLowerCase();
  let ssl = { rejectUnauthorized: true };
  if (setting === 'off' || setting === 'false' || mode === 'disable' || (loopback && !setting && mode !== 'require')) ssl = false;
  else if (setting === 'no-verify' || mode === 'no-verify') ssl = { rejectUnauthorized: false };
  return {
    connectionString: u.toString(), ssl,
    max: Math.max(1, Number(env.DATABASE_POOL_MAX) || 3), idleTimeoutMillis: 20_000, connectionTimeoutMillis: 20_000,
    application_name: 'orate',
  };
}

export class PgStore {
  constructor(url, env = {}) {
    this.url = url; this.env = env; this.pool = null;
    this.filesLimit = (Number(env.DATABASE_FILES_MB) || 350) * 1024 * 1024;   // keeps uploads from filling a 0.5 GB free database
    this.filesUsed = 0;
    try { this.host = new URL(url).hostname; } catch { this.host = 'database'; }
  }

  async init() {
    let mod;
    try { mod = await import('pg'); } catch (e) {
      if (e.code === 'ERR_MODULE_NOT_FOUND') throw new Error('DATABASE_URL is set but the "pg" package is not installed. Run:  npm install');
      throw e;
    }
    const Pool = mod.Pool || mod.default?.Pool;
    this.pool = new Pool(poolOptions(this.url, this.env));
    this.pool.on('error', (e) => console.error('[orate] database connection error (it will reconnect):', e.message));   // idle clients can be dropped by the server
    try {
      await this.q('SELECT 1');
    } catch (e) {
      const hint = /certificate|self[- ]signed/i.test(e.message) ? '\n  → The database\'s TLS certificate could not be verified. If you trust this host set DATABASE_SSL=no-verify.'
        : /password authentication|SASL|28P01/i.test(e.message) ? '\n  → The database refused the login. Re-copy DATABASE_URL (user and password) from your provider.'
          : /ENOTFOUND|ECONNREFUSED|timeout/i.test(e.message) ? '\n  → Could not reach the database. Check the host in DATABASE_URL and that it is running.' : '';
      throw new Error(`Cannot connect to the database: ${e.message}${hint}`);
    }
    await this.q('CREATE TABLE IF NOT EXISTS orate_state (id integer PRIMARY KEY, version bigint NOT NULL, data bytea NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())');
    await this.q('CREATE TABLE IF NOT EXISTS orate_files (name text PRIMARY KEY, type text NOT NULL, size integer NOT NULL, data bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now())');
    await this.q('CREATE TABLE IF NOT EXISTS orate_sessions (hash text PRIMARY KEY, user_id text NOT NULL, created_at bigint NOT NULL, last_used bigint NOT NULL, ua text NOT NULL DEFAULT \'\')');
    await this.q('CREATE INDEX IF NOT EXISTS orate_sessions_user ON orate_sessions (user_id)');
    const used = await this.q('SELECT COALESCE(SUM(size), 0) AS n FROM orate_files');
    this.filesUsed = Number(used.rows[0].n);
  }

  /** Runs a query, retrying a couple of times when the connection was dropped (serverless databases suspend and wake up). */
  async q(text, params) {
    for (let attempt = 0; ; attempt++) {
      try { return await this.pool.query(text, params); } catch (e) {
        if (attempt >= 2 || !isTransient(e)) throw e;
        await sleep(600 * (attempt + 1));
      }
    }
  }

  /* ---- the database itself ---- */
  /** Resolves `{ version, json }`, or null when this database has never held an Orate state. */
  async loadState() {
    const r = await this.q('SELECT version, data FROM orate_state WHERE id = 1');
    if (!r.rows.length) return null;
    return { version: Number(r.rows[0].version), json: (await gunzip(r.rows[0].data)).toString('utf8') };
  }
  /** Creates the first state row. Resolves the new version, or 0 when somebody else created it first. */
  async createState(json) {
    const r = await this.q('INSERT INTO orate_state (id, version, data) VALUES (1, 1, $1) ON CONFLICT (id) DO NOTHING RETURNING version', [await gzip(json)]);
    return r.rows.length ? Number(r.rows[0].version) : 0;
  }
  /** Overwrites the state if it is still at `expected`. Resolves the new version; throws ConflictError if another instance wrote meanwhile. */
  async saveState(json, expected) {
    const gz = await gzip(json);
    let res = null; let retried = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { res = await this.pool.query('UPDATE orate_state SET version = version + 1, data = $1, updated_at = now() WHERE id = 1 AND version = $2 RETURNING version', [gz, expected]); break; } catch (e) {
        if (attempt === 2 || !isTransient(e)) throw e;
        retried = true; await sleep(600 * (attempt + 1));
      }
    }
    if (res.rowCount === 1) return Number(res.rows[0].version);
    if (retried) {   // the first attempt may have been applied just before the connection dropped
      const cur = await this.q('SELECT version, data FROM orate_state WHERE id = 1');
      if (cur.rows[0] && Buffer.compare(cur.rows[0].data, gz) === 0) return Number(cur.rows[0].version);
    }
    throw new ConflictError();
  }
  /** Overwrites the state unconditionally (used by the import tool). */
  async forceState(json) {
    const gz = await gzip(json);
    const r = await this.q('INSERT INTO orate_state (id, version, data) VALUES (1, 1, $1) ON CONFLICT (id) DO UPDATE SET version = orate_state.version + 1, data = EXCLUDED.data, updated_at = now() RETURNING version', [gz]);
    return Number(r.rows[0].version);
  }
  async peekVersion() {
    const r = await this.q('SELECT version FROM orate_state WHERE id = 1');
    return r.rows.length ? Number(r.rows[0].version) : 0;
  }

  /* ---- sign-in sessions (their own table, so they never depend on the state row's version — see sessions.js) ---- */
  async putSession(hash, s) {
    await this.q('INSERT INTO orate_sessions (hash, user_id, created_at, last_used, ua) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (hash) DO NOTHING', [hash, s.userId, s.createdAt, s.lastUsed, s.ua || '']);
  }
  async getSession(hash) {
    const r = await this.q('SELECT user_id, created_at, last_used, ua FROM orate_sessions WHERE hash = $1', [hash]);
    return r.rows.length ? { userId: r.rows[0].user_id, createdAt: Number(r.rows[0].created_at), lastUsed: Number(r.rows[0].last_used), ua: r.rows[0].ua } : null;
  }
  async touchSession(hash, ts) { await this.q('UPDATE orate_sessions SET last_used = $2 WHERE hash = $1', [hash, ts]); }
  async deleteSession(hash) { await this.q('DELETE FROM orate_sessions WHERE hash = $1', [hash]); }
  async deleteUserSessions(userId, exceptHash) { await this.q('DELETE FROM orate_sessions WHERE user_id = $1 AND ($2::text IS NULL OR hash <> $2)', [userId, exceptHash]); }
  async listSessions(userId) {
    const r = await this.q('SELECT hash, created_at, last_used, ua FROM orate_sessions WHERE user_id = $1', [userId]);
    return r.rows.map((x) => ({ hash: x.hash, userId, createdAt: Number(x.created_at), lastUsed: Number(x.last_used), ua: x.ua }));
  }

  /* ---- uploaded files ---- */
  async putFile(name, type, buf) {
    if (!isSafeFileName(name)) throw new Error('bad file name');
    if (this.filesUsed + buf.length > this.filesLimit) {
      const mb = (n) => Math.round(n / 1048576);
      throw new QuotaError(`Storage is full (${mb(this.filesUsed)} of ${mb(this.filesLimit)} MB used). Delete something or raise DATABASE_FILES_MB.`);
    }
    await this.q('INSERT INTO orate_files (name, type, size, data) VALUES ($1, $2, $3, $4) ON CONFLICT (name) DO UPDATE SET type = EXCLUDED.type, size = EXCLUDED.size, data = EXCLUDED.data', [name, String(type || 'application/octet-stream').slice(0, 100), buf.length, buf]);
    this.filesUsed += buf.length;
  }
  async getFile(name) {
    if (!isSafeFileName(name)) return null;
    const r = await this.q('SELECT type, data FROM orate_files WHERE name = $1', [name]);
    return r.rows.length ? { type: r.rows[0].type, data: r.rows[0].data } : null;
  }
  async listFiles() { return (await this.q('SELECT name, size FROM orate_files ORDER BY name')).rows.map((r) => ({ name: r.name, size: Number(r.size) })); }

  /** Copies every file of a local uploads folder into the database (skipping ones already there). Resolves { added, skipped, bytes }. */
  async importDir(dir, log = () => {}) {
    if (!fs.existsSync(dir)) return { added: 0, skipped: 0, bytes: 0 };
    const have = new Set((await this.listFiles()).map((f) => f.name));
    let added = 0; let skipped = 0; let bytes = 0;
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (!isSafeFileName(name) || !fs.statSync(file).isFile() || have.has(name)) { skipped++; continue; }
      const buf = fs.readFileSync(file);
      await this.putFile(name, 'application/octet-stream', buf); added++; bytes += buf.length;
      if (added % 25 === 0) log(`  … ${added} files copied`);
    }
    return { added, skipped, bytes };
  }
  /** Writes every stored file into a local folder. Resolves the number of files. */
  async exportDir(dir, log = () => {}) {
    fs.mkdirSync(dir, { recursive: true });
    let n = 0;
    for (const { name } of await this.listFiles()) {
      const f = await this.getFile(name); if (!f) continue;
      fs.writeFileSync(path.join(dir, name), f.data); n++;
      if (n % 25 === 0) log(`  … ${n} files written`);
    }
    return n;
  }

  async close() { try { await this.pool?.end(); } catch { /* ignore */ } }
}
