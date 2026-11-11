// Orata — optional Cloudflare R2 storage for uploaded files (or any S3-compatible bucket: AWS S3, Backblaze B2 …).
//
// Uploads (avatars, wallpapers, attachments, fonts …) are what fill a free Postgres database. With R2_BUCKET set they live in an R2 bucket instead (10 GB free on
// Cloudflare, and downloads cost nothing) and the database keeps only the chat state and the sign-in sessions, a few megabytes. R2 speaks the S3 protocol, so this
// talks to it with plain fetch and AWS Signature Version 4 made with node:crypto: no SDK, nothing to install. Orata's disk copy of every upload (data/uploads) stays a
// cache, as it is with Postgres, and the pictures are still served by Orata itself (the bucket stays private). Files that were stored in the database before R2 was
// switched on are still served from there until `npm run db:files-to-r2` moves them (core.js). README → "Cloudflare R2 for uploaded files".
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isSafeFileName, QuotaError } from './storage.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (n) => Math.round(n / 1048576);
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
/** RFC 3986 percent-encoding, as AWS wants it: letters, digits and - _ . ~ stay, every other byte becomes %XX. */
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encPath = (p) => p.split('/').map((s) => enc(s)).join('/');
const unxml = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const amzNow = () => new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');   // 20130524T000000Z

/** AWS Signature Version 4. Every header in `headers` is signed. Resolves the Authorization header's value, with the steps of it (for the tests against AWS's own examples):
 *  { authorization, signature, canonicalRequest, stringToSign }. `url` is the full address as it is sent; its path is encoded once (what S3 expects). */
export function signV4({ method, url, headers, payloadHash, accessKeyId, secretAccessKey, region, service = 's3', amzDate }) {
  const u = new URL(url);
  const uri = u.pathname.split('/').map((s) => enc(decodeURIComponent(s))).join('/') || '/';
  const query = [...u.searchParams.entries()].map(([k, v]) => [enc(k), enc(v)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&');
  const value = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const names = Object.keys(value).sort();
  const canonicalRequest = [method, uri, query, names.map((n) => `${n}:${value[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const date = amzDate.slice(0, 8); const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(stringToSign).digest('hex');
  return { authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope},SignedHeaders=${names.join(';')},Signature=${signature}`, signature, canonicalRequest, stringToSign };
}

const TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', pdf: 'application/pdf', txt: 'text/plain', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', json: 'application/json' };
/** A file's content type from its extension (for files copied from a folder, which only has names). */
export const typeOf = (name) => TYPES[String(name).split('.').pop().toLowerCase()] || 'application/octet-stream';

export class R2Store {
  /** The store the environment asks for (R2_BUCKET, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY; optionally R2_ENDPOINT for another S3-compatible service,
   *  R2_REGION, R2_PREFIX and R2_FILES_MB), or null when R2_BUCKET isn't set. Throws a plain explanation when it is set but incomplete. */
  static fromEnv(env) {
    const bucket = String(env.R2_BUCKET || '').trim(); if (!bucket) return null;
    const get = (k) => String(env[k] || '').trim();
    const missing = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', ...(get('R2_ENDPOINT') ? [] : ['R2_ACCOUNT_ID'])].filter((k) => !get(k));
    if (missing.length) throw new Error(`R2_BUCKET is set but ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} missing (README → "Cloudflare R2 for uploaded files").`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/.test(bucket)) throw new Error('R2_BUCKET isn’t a bucket name (3–63 letters, numbers and dashes).');
    return new R2Store({ bucket, accountId: get('R2_ACCOUNT_ID'), accessKeyId: get('R2_ACCESS_KEY_ID'), secretAccessKey: get('R2_SECRET_ACCESS_KEY'), endpoint: get('R2_ENDPOINT'), region: get('R2_REGION') || 'auto', prefix: get('R2_PREFIX'), limitMb: Number(env.R2_FILES_MB) || 9000 });
  }
  constructor({ bucket, accountId, accessKeyId, secretAccessKey, endpoint, region = 'auto', prefix = '', limitMb = 9000 }) {
    this.bucket = bucket; this.accessKeyId = accessKeyId; this.secretAccessKey = secretAccessKey; this.region = region;
    this.endpoint = (endpoint || `https://${accountId}.r2.cloudflarestorage.com`).replace(/\/+$/, '');
    const p = String(prefix || '').replace(/^\/+/, '').replace(/[^A-Za-z0-9_./-]/g, ''); this.prefix = p && !p.endsWith('/') ? `${p}/` : p;
    this.filesLimit = limitMb * 1024 * 1024;   // keeps the bucket inside Cloudflare's free 10 GB
    this.filesUsed = 0;
    this.host = `Cloudflare R2, bucket ${bucket}`;
  }

  /** One signed request. Retries a couple of times when the network drops or R2 says it is busy; resolves the response (any other status is the caller's to judge). */
  async call(method, key, { query = {}, body = null, type = null, timeoutMs = 60_000 } = {}) {
    const qs = Object.entries(query).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&');
    const url = `${this.endpoint}/${enc(this.bucket)}${key ? `/${encPath(key)}` : ''}${qs ? `?${qs}` : ''}`;
    const payloadHash = sha256(body || '');
    for (let attempt = 0; ; attempt++) {
      const amzDate = amzNow();
      const signed = { host: new URL(url).host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
      const { authorization } = signV4({ method, url, headers: signed, payloadHash, accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey, region: this.region, amzDate });
      let res;
      try {
        res = await fetch(url, { method, body, signal: AbortSignal.timeout(timeoutMs), headers: { 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, authorization, ...(type ? { 'content-type': type } : {}) } });
      } catch (e) {
        if (attempt >= 2) throw new Error(`Cannot reach R2: ${e.cause?.code || e.message}`);
        await sleep(500 * (attempt + 1)); continue;
      }
      if ((res.status >= 500 || res.status === 429) && attempt < 2) { await res.arrayBuffer().catch(() => {}); await sleep(500 * (attempt + 1)); continue; }
      return res;
    }
  }
  /** An error that says what R2 answered (its error code, never anything secret). */
  async fail(res, what) {
    const text = await res.text().catch(() => ''); const code = /<Code>([^<]*)<\/Code>/.exec(text)?.[1];
    const e = new Error(`R2 said ${res.status}${code ? ` (${code})` : ''} when ${what}`); e.status = res.status; return e;
  }

  /** Checks the bucket can be read with these keys and counts what it holds. A wrong key or bucket stops the start-up with a hint; a hiccup of the network or of R2 only warns. */
  async init() {
    try { this.filesUsed = (await this.listFiles()).reduce((n, f) => n + f.size, 0); } catch (e) {
      if (e.status && e.status < 500 && e.status !== 429) {
        const hint = e.status === 403 ? '\n  → The access key was refused, or it can’t use this bucket. In Cloudflare: R2 → Manage API tokens → create a token with “Object Read & Write” for the bucket, and copy both its Access Key ID and Secret Access Key.'
          : e.status === 404 ? '\n  → The bucket wasn’t found. Check R2_BUCKET (its exact name) and R2_ACCOUNT_ID (the long id at the top of the R2 page).' : '';
        throw new Error(`Cannot use the R2 bucket: ${e.message}${hint}`);
      }
      if (/ENOTFOUND/.test(e.message)) throw new Error(`Cannot use the R2 bucket: ${e.message}\n  → That address doesn’t exist. Check R2_ACCOUNT_ID (the long id at the top of Cloudflare’s R2 page), or R2_ENDPOINT if you set one.`);
      console.error(`[orata] R2 could not be reached just now (${e.message}); uploads will be tried again as they come.`);
    }
  }

  /* ---- uploaded files (the same four calls as PgStore, so core.js treats them alike) ---- */
  async putFile(name, type, buf) {
    if (!isSafeFileName(name)) throw new Error('bad file name');
    if (this.filesUsed + buf.length > this.filesLimit) throw new QuotaError(`Storage is full (${mb(this.filesUsed)} of ${mb(this.filesLimit)} MB used). Delete something or raise R2_FILES_MB.`);
    const res = await this.call('PUT', this.prefix + name, { body: buf, type: String(type || 'application/octet-stream').slice(0, 100), timeoutMs: 180_000 });
    if (!res.ok) throw await this.fail(res, 'saving a file');
    await res.arrayBuffer().catch(() => {});
    this.filesUsed += buf.length;
  }
  async getFile(name) {
    if (!isSafeFileName(name)) return null;
    const res = await this.call('GET', this.prefix + name);
    if (res.status === 404) { await res.arrayBuffer().catch(() => {}); return null; }
    if (!res.ok) throw await this.fail(res, 'fetching a file');
    return { type: res.headers.get('content-type') || 'application/octet-stream', data: Buffer.from(await res.arrayBuffer()) };
  }
  /** `{ size, type }` of a file, or null when there isn't one. */
  async headFile(name) {
    if (!isSafeFileName(name)) return null;
    const res = await this.call('HEAD', this.prefix + name);
    if (res.status === 404) return null;
    if (!res.ok) throw await this.fail(res, 'looking at a file');
    return { size: Number(res.headers.get('content-length') || 0), type: res.headers.get('content-type') || 'application/octet-stream' };
  }
  async deleteFile(name) {
    if (!isSafeFileName(name)) return;
    const had = await this.headFile(name); if (!had) return;
    const res = await this.call('DELETE', this.prefix + name);
    if (!res.ok && res.status !== 404) throw await this.fail(res, 'deleting a file');
    await res.arrayBuffer().catch(() => {});
    this.filesUsed = Math.max(0, this.filesUsed - had.size);
  }
  /** Every file in the bucket (under the prefix), as [{ name, size }], through as many pages as there are. */
  async listFiles() {
    const out = []; let token = null;
    do {
      const res = await this.call('GET', '', { query: { 'list-type': '2', 'max-keys': '1000', ...(this.prefix ? { prefix: this.prefix } : {}), ...(token ? { 'continuation-token': token } : {}) } });
      if (!res.ok) throw await this.fail(res, 'listing the bucket');
      const xml = await res.text();
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = unxml(/<Key>([\s\S]*?)<\/Key>/.exec(m[1])?.[1] ?? ''); const size = Number(/<Size>(\d+)<\/Size>/.exec(m[1])?.[1] ?? 0);
        const name = key.slice(this.prefix.length);
        if (key.startsWith(this.prefix) && isSafeFileName(name)) out.push({ name, size });
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? unxml(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] ?? '') || null : null;
    } while (token);
    return out.sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  /** Copies every file of a local uploads folder into the bucket (skipping ones already there). Resolves { added, skipped, bytes }. */
  async importDir(dir, log = () => {}) {
    if (!fs.existsSync(dir)) return { added: 0, skipped: 0, bytes: 0 };
    const have = new Set((await this.listFiles()).map((f) => f.name));
    let added = 0; let skipped = 0; let bytes = 0;
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (!isSafeFileName(name) || !fs.statSync(file).isFile() || have.has(name)) { skipped++; continue; }
      const buf = fs.readFileSync(file);
      await this.putFile(name, typeOf(name), buf); added++; bytes += buf.length;
      if (added % 25 === 0) log(`  … ${added} files copied`);
    }
    return { added, skipped, bytes };
  }
  /** Writes every file of the bucket into a local folder. Resolves the number of files. */
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
  async close() { /* nothing is kept open */ }
}

/** Moves uploaded files into the bucket `to`: each source is { label, list() → [{ name, size }], get(name) → { type?, data } | null, purge?() }. A file already in the bucket
 *  with the same size is left alone. Then every file of every source is looked up in the bucket again (by size), and only when all of them are there does `purge` empty the
 *  sources that can be (the database's table of files; never a folder on disk). Resolves { copied, bytes, skipped, missing: [names], purged: [labels] }. */
export async function migrateFiles({ sources, to, purge = false, log = () => {} }) {
  const have = new Map((await to.listFiles()).map((f) => [f.name, f.size]));
  const r = { copied: 0, bytes: 0, skipped: 0, missing: [], purged: [] };
  for (const src of sources) {
    for (const f of await src.list()) {
      if (have.get(f.name) === f.size) { r.skipped++; continue; }
      const got = await src.get(f.name);
      if (!got) { r.missing.push(f.name); continue; }
      await to.putFile(f.name, got.type && got.type !== 'application/octet-stream' ? got.type : typeOf(f.name), got.data);
      have.set(f.name, got.data.length); r.copied++; r.bytes += got.data.length;
      if (r.copied % 25 === 0) log(`  … ${r.copied} files copied`);
    }
  }
  const now = new Map((await to.listFiles()).map((f) => [f.name, f.size]));   // look again: trust what the bucket holds, not what was sent
  for (const src of sources) for (const f of await src.list()) if (now.get(f.name) !== f.size && !r.missing.includes(f.name)) r.missing.push(f.name);
  if (purge && !r.missing.length) for (const src of sources) if (src.purge) { await src.purge(); r.purged.push(src.label); }
  return r;
}
