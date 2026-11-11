// Orata self-test for Cloudflare R2 file storage (server/r2.js, README → "Cloudflare R2 for uploaded files").
// 1. The request signing (AWS Signature Version 4) against AWS's own published examples. 2. The store against a fake R2 (S3 protocol) that checks the signature of every request
// it gets, including pages, retries, quota and wrong keys. 3. Moving files into R2 (and that nothing is deleted unless every file made it). 4. The real server with R2 set up:
// an upload lands in the bucket, and comes back from it after the disk cache is wiped. Runs with the other suites:  npm test
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signV4, R2Store, migrateFiles, typeOf } from './r2.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0; let fail = 0;
const ok = (c, name, extra = '') => { if (c) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/* ---------------------------------------------------------------- 1. the signing, against AWS's examples */
console.log('Signing requests (AWS Signature Version 4)');
const AWS = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', amzDate: '20130524T000000Z' };
const EMPTY = sha256('');
const get = signV4({ method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9', 'x-amz-content-sha256': EMPTY, 'x-amz-date': '20130524T000000Z' }, payloadHash: EMPTY, ...AWS });
ok(sha256(get.canonicalRequest) === '7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972' && get.signature === 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41', 'AWS’s “GET Object” example gives exactly AWS’s signature');
ok(get.authorization === 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41', '… and the Authorization header is the one AWS shows');
const putHash = '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072';   // sha256 of "Welcome to Amazon S3."
ok(sha256('Welcome to Amazon S3.') === putHash, '(the example’s file is “Welcome to Amazon S3.”)');
const put = signV4({ method: 'PUT', url: 'https://examplebucket.s3.amazonaws.com/test%24file.text', headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', host: 'examplebucket.s3.amazonaws.com', 'x-amz-content-sha256': putHash, 'x-amz-date': '20130524T000000Z', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' }, payloadHash: putHash, ...AWS });
ok(put.signature === '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd', '“PUT Object” does too (a $ in the name is signed as %24)');
const list = signV4({ method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/?prefix=J&max-keys=2', headers: { host: 'examplebucket.s3.amazonaws.com', 'x-amz-content-sha256': EMPTY, 'x-amz-date': '20130524T000000Z' }, payloadHash: EMPTY, ...AWS });
ok(list.signature === '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7' && list.canonicalRequest.split('\n')[2] === 'max-keys=2&prefix=J', 'and “GET Bucket (List Objects)”, whose query is sorted and encoded');
ok(typeOf('x.PNG') === 'image/png' && typeOf('x.woff2') === 'font/woff2' && typeOf('x') === 'application/octet-stream', 'a file’s type is told from its extension when it comes from a folder');

/* ---------------------------------------------------------------- 2. a fake R2 */
const bucket = new Map();   // key -> { type, data }
const seen = [];            // [method, path+query] of each request that arrived
const F = { busy: 0, pageSize: 2, drop: null };   // busy: answer the next n requests with 503; drop: a PUT of a key containing this is accepted but not kept
const KEY = 'AKTEST'; const SECRET = 'SECRETSECRET';
const fake = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks); seen.push([req.method, req.url]);
    const xml = (status, text) => { res.writeHead(status, { 'content-type': 'application/xml' }); res.end(text); };
    const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request,SignedHeaders=([a-z0-9;-]+),Signature=([0-9a-f]{64})$/.exec(req.headers.authorization || '');
    if (F.busy > 0) { F.busy--; return xml(503, '<Error><Code>SlowDown</Code></Error>'); }
    if (!m) return xml(403, '<Error><Code>AccessDenied</Code></Error>');
    const [, key, date, region, signed, signature] = m;
    const stamp = req.headers['x-amz-date'] || '';
    const fresh = /^\d{8}T\d{6}Z$/.test(stamp) && stamp.startsWith(date) && Math.abs(Date.now() - Date.parse(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`)) < 300_000;
    const headers = Object.fromEntries(signed.split(';').map((n) => [n, req.headers[n] ?? '']));
    const again = signV4({ method: req.method, url: `http://${req.headers.host}${req.url}`, headers, payloadHash: req.headers['x-amz-content-sha256'], accessKeyId: key, secretAccessKey: SECRET, region, amzDate: stamp });
    if (key !== KEY || !fresh || again.signature !== signature) return xml(403, '<Error><Code>SignatureDoesNotMatch</Code></Error>');
    if (req.headers['x-amz-content-sha256'] !== sha256(body)) return xml(400, '<Error><Code>XAmzContentSHA256Mismatch</Code></Error>');
    const u = new URL(req.url, 'http://x'); const parts = u.pathname.split('/').map(decodeURIComponent);   // ['', bucket, ...key]
    if (parts[1] !== 'orata') return xml(404, '<Error><Code>NoSuchBucket</Code></Error>');
    const k = parts.slice(2).join('/');
    if (!k && req.method === 'GET') {   // ListObjectsV2, two keys to a page
      const prefix = u.searchParams.get('prefix') || ''; const all = [...bucket.keys()].filter((x) => x.startsWith(prefix)).sort();
      const from = Number(u.searchParams.get('continuation-token') || 0); const page = all.slice(from, from + F.pageSize); const more = from + F.pageSize < all.length;
      const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      return xml(200, `<?xml version="1.0"?><ListBucketResult><Name>orata</Name><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${from + F.pageSize}</NextContinuationToken>` : ''}${page.map((x) => `<Contents><Key>${esc(x)}</Key><Size>${bucket.get(x).data.length}</Size></Contents>`).join('')}</ListBucketResult>`);
    }
    if (req.method === 'PUT') { if (!(F.drop && k.includes(F.drop))) bucket.set(k, { type: req.headers['content-type'] || '', data: body }); res.writeHead(200, { etag: '"x"' }); return res.end(); }
    if (req.method === 'DELETE') { bucket.delete(k); res.writeHead(204); return res.end(); }
    const o = bucket.get(k); if (!o) return xml(404, '<Error><Code>NoSuchKey</Code></Error>');
    res.writeHead(200, { 'content-type': o.type, 'content-length': o.data.length }); return res.end(req.method === 'HEAD' ? undefined : o.data);
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const endpoint = `http://127.0.0.1:${fake.address().port}`;
const mk = (extra = {}) => new R2Store({ bucket: 'orata', endpoint, accessKeyId: KEY, secretAccessKey: SECRET, ...extra });

console.log('\nSetting it up');
ok(R2Store.fromEnv({}) === null && R2Store.fromEnv({ R2_BUCKET: ' ' }) === null, 'without R2_BUCKET there is no R2 (files stay as they were)');
let err = null; try { R2Store.fromEnv({ R2_BUCKET: 'orata', R2_ACCOUNT_ID: 'acct' }); } catch (e) { err = e; }
ok(/R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are missing/.test(err?.message), 'with it but without the keys it says which are missing');
err = null; try { R2Store.fromEnv({ R2_BUCKET: 'orata', R2_ACCESS_KEY_ID: 'a', R2_SECRET_ACCESS_KEY: 'b' }); } catch (e) { err = e; }
ok(/R2_ACCOUNT_ID is missing/.test(err?.message), '… the account id too (unless another address is given)');
err = null; try { R2Store.fromEnv({ R2_BUCKET: 'bad name!', R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'a', R2_SECRET_ACCESS_KEY: 'b' }); } catch (e) { err = e; }
ok(/isn’t a bucket name/.test(err?.message), 'a bucket name has to look like one');
const real = R2Store.fromEnv({ R2_BUCKET: 'orata-files', R2_ACCOUNT_ID: 'abc123', R2_ACCESS_KEY_ID: 'a', R2_SECRET_ACCESS_KEY: 'b', R2_PREFIX: '/up', R2_FILES_MB: '500' });
ok(real.endpoint === 'https://abc123.r2.cloudflarestorage.com' && real.prefix === 'up/' && real.region === 'auto' && real.filesLimit === 500 * 1048576 && /orata-files/.test(real.host), 'Cloudflare’s address comes from the account id; region “auto”; the folder and the limit are settable');

console.log('\nThe store');
const store = mk({ prefix: 'up', limitMb: 1 });
await store.init(); ok(store.filesUsed === 0, 'an empty bucket starts at nothing used');
await store.putFile('1700.png', 'image/png', PNG);
ok(bucket.get('up/1700.png')?.data.equals(PNG) && bucket.get('up/1700.png').type === 'image/png', 'a file is saved in the bucket under the folder, with its type (every request signed correctly)');
const back = await store.getFile('1700.png'); ok(back?.data.equals(PNG) && back.type === 'image/png', 'and comes back the same');
ok((await store.headFile('1700.png')).size === PNG.length && await store.getFile('nope.png') === null && await store.headFile('nope.png') === null, 'a size can be asked for, and a missing file is just null');
let bad = null; try { await store.putFile('../x', 'a/b', Buffer.from('x')); } catch (e) { bad = e; } ok(!!bad && !bucket.has('x'), 'a name that could leave the folder is refused');
for (const n of ['1.png', '2.png', '3.png', '4.png']) await store.putFile(n, 'image/png', PNG);
bucket.set('other/x.png', { type: '', data: PNG }); bucket.set('up/has space.png', { type: '', data: PNG });
seen.length = 0; const names = (await store.listFiles()).map((f) => f.name);
ok(names.join() === '1.png,1700.png,2.png,3.png,4.png' && seen.filter((s) => /continuation-token/.test(s[1])).length === 2, 'the list goes through every page (here three) and ignores other folders and odd names');
const used = store.filesUsed; await store.deleteFile('1.png');
ok(!bucket.has('up/1.png') && store.filesUsed === used - PNG.length, 'deleting takes the file out and gives its size back');
await store.deleteFile('never-was.png'); ok(true, 'deleting what isn’t there is fine');
const big = Buffer.alloc(600 * 1024, 1); let quota = null;
await store.putFile('big1.bin', 'x/y', big); try { await store.putFile('big2.bin', 'x/y', big); } catch (e) { quota = e; }
ok(quota?.code === 'QUOTA' && /R2_FILES_MB/.test(quota.message) && !bucket.has('up/big2.bin'), 'past the limit (R2_FILES_MB, to stay inside the free 10 GB) it refuses, as a full database does');
F.busy = 2; seen.length = 0; const retried = await store.getFile('2.png');
ok(retried?.data.equals(PNG) && seen.length === 3, 'when R2 is busy (503) it asks again, up to twice, and gets the file');
F.busy = 3; let gaveUp = null; try { await store.getFile('2.png'); } catch (e) { gaveUp = e; }
ok(gaveUp && /503/.test(gaveUp.message) && !/SECRET/.test(gaveUp.message), 'if it stays busy that is reported (never with a secret in it)');
let init = null; try { await mk({ secretAccessKey: 'wrong' }).init(); } catch (e) { init = e; }
ok(/403/.test(init?.message) && /Object Read & Write/.test(init.message), 'a wrong key stops the start-up and says how to make a right one');
init = null; try { await mk({ bucket: 'nope' }).init(); } catch (e) { init = e; }
ok(/404/.test(init?.message) && /R2_BUCKET/.test(init.message), 'a wrong bucket says so');
init = null; try { await new R2Store({ bucket: 'orata', endpoint: 'http://no-such-host.invalid', accessKeyId: KEY, secretAccessKey: SECRET }).init(); } catch (e) { init = e; }
ok(/R2_ACCOUNT_ID/.test(init?.message), 'an address that doesn’t exist points at the account id');
init = null; try { await new R2Store({ bucket: 'orata', endpoint: 'http://127.0.0.1:1', accessKeyId: KEY, secretAccessKey: SECRET }).init(); } catch (e) { init = e; }
ok(!init, 'but an R2 that just can’t be reached right now only warns: the site starts anyway');

console.log('\nMoving files into R2');
const mem = (files) => ({ files, purged: 0, label: 'the database', list: async () => [...files].map(([name, b]) => ({ name, size: b.length })), get: async (n) => (files.has(n) ? { type: 'image/png', data: files.get(n) } : null), purge: async function purge() { this.purged++; files.clear(); } });
const dest = () => mk({ prefix: `m${Math.random().toString(36).slice(2, 7)}` });
let src = mem(new Map([['a.png', Buffer.from('aaa')], ['b.png', Buffer.from('bbbb')]])); let to = dest(); await to.init();
let r = await migrateFiles({ sources: [src], to });
ok(r.copied === 2 && r.bytes === 7 && !r.missing.length && (await to.getFile('b.png')).data.toString() === 'bbbb' && src.files.size === 2 && !r.purged.length, 'files are copied, and without --purge nothing is touched at the source');
r = await migrateFiles({ sources: [src], to, purge: true });
ok(r.copied === 0 && r.skipped === 2 && r.purged[0] === 'the database' && src.files.size === 0, 'run again with --purge, what is there already isn’t sent twice, and the source is emptied');
src = mem(new Map([['a.png', Buffer.from('aaa')]])); src.get = async () => null;   // a file listed but gone when asked for
to = dest(); await to.init(); r = await migrateFiles({ sources: [src], to, purge: true });
ok(r.missing.join() === 'a.png' && src.files.size === 1 && !r.purged.length, 'a file that can’t be read is reported, and nothing is deleted');
src = mem(new Map([['ghost.png', Buffer.from('boo')], ['fine.png', Buffer.from('ok')]])); F.drop = 'ghost'; to = dest(); await to.init();
r = await migrateFiles({ sources: [src], to, purge: true }); F.drop = null;
ok(r.missing.join() === 'ghost.png' && src.files.size === 2, 'a file R2 said yes to but didn’t keep is caught by looking again, and nothing is deleted');
const disk = { label: 'data/uploads', list: async () => [{ name: 'd.png', size: 1 }], get: async () => ({ data: Buffer.from('d') }) };
src = mem(new Map([['a.png', Buffer.from('aaa')]])); to = dest(); await to.init(); r = await migrateFiles({ sources: [src, disk], to, purge: true });
ok(r.copied === 2 && r.purged.length === 1 && r.purged[0] === 'the database', 'a folder on disk is copied too, but never emptied');

/* ---------------------------------------------------------------- 4. the real server and the tool */
console.log('\nThe server with R2');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'orata-r2-test-'));
const PORT = 3900 + Math.floor(Math.random() * 90); const base = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, PORT: String(PORT), ORATE_DATA: data, HOST: '127.0.0.1', DISCORD_BOT_TOKEN: '', SMTP_HOST: '', REQUIRE_EMAIL_VERIFICATION: '', DATABASE_URL: '', KLIPY_API_KEY: '', ACCOUNTS_PER_BROWSER: '1000', ACCOUNTS_PER_HOUR: '1000',
  R2_BUCKET: 'orata', R2_ENDPOINT: endpoint, R2_ACCESS_KEY_ID: KEY, R2_SECRET_ACCESS_KEY: SECRET, R2_FILES_MB: '1', MUSIC: 'off' };
const half = spawnSync(process.execPath, [path.join(ROOT, 'server', 'index.js')], { env: { ...env, R2_SECRET_ACCESS_KEY: '' }, encoding: 'utf8', timeout: 20_000 });
ok(half.status !== 0 && /R2_SECRET_ACCESS_KEY is missing/.test(half.stderr), 'a half-set-up R2 stops the server with a plain message');
let out = ''; const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
child.stdout.on('data', (d) => { out += d; });
for (let i = 0; i < 80; i++) { try { await fetch(base + '/api/config'); break; } catch { await sleep(100); } }
const api = async (method, url, token, body, headers = {}) => { const res = await fetch(base + '/api' + url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await res.json(); } catch { /* none */ } return { status: res.status, body: j }; };
// the command-line tool (not spawnSync: that would stop this process, and the fake R2 in it, from answering the tool)
const tool = (extra = {}, ...args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(ROOT, 'server', 'db-tool.js'), ...args], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = ''; let stderr = '';
  p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; }); p.on('close', (status) => resolve({ status, stdout, stderr }));
  setTimeout(() => p.kill(), 60_000).unref();
});
try {
  ok(/Storage: local files .*; uploaded files in Cloudflare R2, bucket orata/.test(out), 'the start-up text says where the uploaded files live');
  const A = (await api('POST', '/auth/register', null, { agree: true, username: 'alice', displayName: 'Alice', password: 'password123', dob: { year: 1995, month: 1, day: 1 } }, { 'x-forwarded-for': '198.51.100.20' })).body;
  const up = async (buf, name = 'dog.png', type = 'image/png') => { const res = await fetch(base + '/api/upload', { method: 'POST', headers: { authorization: 'Bearer ' + A.token, 'content-type': type, 'x-filename': name }, body: buf }); return { status: res.status, body: await res.json().catch(() => null) }; };
  let r1 = await up(PNG); const file = path.basename(r1.body?.url || '');
  ok(r1.status === 200 && bucket.get(file)?.data.equals(PNG) && bucket.get(file).type === 'image/png', 'an upload goes to the bucket (not only to the disk)');
  ok(fs.existsSync(path.join(data, 'uploads', file)), '… and stays on disk as a cache');
  fs.rmSync(path.join(data, 'uploads', file));   // like a restart that wiped the host’s disk
  seen.length = 0; const again = await fetch(`${base}/uploads/${file}`);
  ok(again.status === 200 && Buffer.from(await again.arrayBuffer()).equals(PNG) && seen.some((s) => s[0] === 'GET' && s[1].endsWith(`/${file}`)), 'after the disk is wiped the file comes back from the bucket, and is served as before');
  ok((await fetch(`${base}/uploads/nothing-here.png`)).status === 404, 'a file that is nowhere is a plain 404');
  const tooBig = await up(Buffer.alloc(1200 * 1024, 7), 'big.bin', 'application/octet-stream');
  ok(tooBig.status === 507 && tooBig.body?.code === 'storage_full' && !fs.readdirSync(path.join(data, 'uploads')).some((n) => n.endsWith('.bin')), 'past R2_FILES_MB an upload is refused (507) and nothing is kept on disk');

  console.log('\nThe tool');
  let t = await tool({ R2_BUCKET: '' }, 'files-to-r2'); ok(t.status === 1 && /R2 is not set up/.test(t.stderr), 'db:files-to-r2 without R2 says R2 isn’t set up');
  fs.writeFileSync(path.join(data, 'uploads', 'old1.png'), PNG); fs.writeFileSync(path.join(data, 'uploads', 'old2.txt'), 'hello');
  t = await tool({ R2_FILES_MB: '9' }, 'files-to-r2');
  ok(t.status === 0 && bucket.get('old1.png')?.data.equals(PNG) && bucket.get('old2.txt')?.type === 'text/plain' && /Checked: every file is in the bucket/.test(t.stdout), 'with no database, it moves what is in data/uploads (with their types) and checks it', `${t.stdout}${t.stderr}`);
  t = await tool({ R2_FILES_MB: '9' }, 'files-to-r2', '--purge'); ok(t.status === 1 && /--purge empties the database/.test(t.stderr), '--purge with no database is explained, not ignored', `${t.stdout}${t.stderr}`);
  const gone = bucket.size; t = await tool({ R2_FILES_MB: '9' }, 'files-to-r2'); ok(t.status === 0 && /0 file\(s\) copied/.test(t.stdout) && bucket.size === gone, 'running it again copies nothing twice', `${t.stdout}${t.stderr}`);
} finally {
  child.kill('SIGINT'); await sleep(400); fs.rmSync(data, { recursive: true, force: true });
}

/* ---------------------------------------------------------------- 5. with Postgres too: files that start in the database (needs PGlite, like selftest-pg.js; skipped without it) */
let PGlite; let PGLiteSocketServer;
try { ({ PGlite } = await import('@electric-sql/pglite')); ({ PGLiteSocketServer } = await import('@electric-sql/pglite-socket')); } catch {
  console.log('\nWith Postgres too: skipped (PGlite is not installed).\n  To run it:  npm install --no-save @electric-sql/pglite @electric-sql/pglite-socket');
}
if (PGlite) {
  console.log('\nWith Postgres too: files that start in the database');
  const { default: pgmod } = await import('pg'); const { Client } = pgmod;
  bucket.clear(); F.pageSize = 2;   // (an empty bucket, as a new one is)
  const PGPORT = 5900 + Math.floor(Math.random() * 90);
  const pgdb = await PGlite.create(); const sock = new PGLiteSocketServer({ db: pgdb, port: PGPORT, host: '127.0.0.1', maxConnections: 100 }); await sock.start();
  const DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${PGPORT}/postgres`;
  const sql = async (text, params) => { const c = new Client({ connectionString: DATABASE_URL }); await c.connect(); try { return await c.query(text, params); } finally { await c.end(); } };
  const rows = async () => (await sql('SELECT count(*)::int AS n FROM orate_files')).rows[0].n;
  let nextPort = PORT + 1; const dirs = []; const kids = [];
  const boot = async (extra = {}) => {
    const port = nextPort++; const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orata-r2pg-test-')); dirs.push(dir);
    const e = { ...env, PORT: String(port), ORATE_DATA: dir, DATABASE_URL, DATABASE_SAVE_DELAY_MS: '150', DATABASE_POOL_MAX: '2', R2_FILES_MB: '9', ...extra };
    const kid = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { env: e, stdio: ['ignore', 'ignore', 'inherit'] }); kids.push(kid);
    const srv = { kid, dir, base: `http://127.0.0.1:${port}` };
    for (let i = 0; i < 150; i++) { try { await fetch(srv.base + '/api/config'); break; } catch { await sleep(100); } }
    return srv;
  };
  const stop = async (srv) => { srv.kid.kill('SIGINT'); await sleep(600); };
  const upload = async (srv, token, buf, name) => (await (await fetch(srv.base + '/api/upload', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'image/png', 'x-filename': name }, body: buf })).json());
  const toolPg = (extra, ...args) => tool({ DATABASE_URL, R2_FILES_MB: '9', ...extra }, ...args);
  try {
    // the way things are on Neon before R2: uploads are rows of the database
    let s = await boot({ R2_BUCKET: '' });
    const A = await (await fetch(s.base + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.31' }, body: JSON.stringify({ agree: true, username: 'pgalice', displayName: 'Pg', password: 'password123', dob: { year: 1995, month: 1, day: 1 } }) })).json();
    const one = await upload(s, A.token, PNG, 'one.png'); const TWO = Buffer.concat([PNG, Buffer.from('two')]); const two = await upload(s, A.token, TWO, 'two.png');
    ok(await rows() === 2, 'without R2, uploads are rows in the database (as on Neon today)');
    await sleep(900); await stop(s);   // (the server saves a moment after a change; a stop on Windows is a kill, so give it that moment)
    let t = await toolPg({}, 'info');
    ok(t.status === 0 && /Files still in the database: 2 file\(s\)/.test(t.stdout) && /Files in R2: 0 file\(s\)/.test(t.stdout), 'db:info with R2 set up shows what is still in the database and what is in the bucket', `${t.stdout}${t.stderr}`);
    // R2 switched on, nothing moved yet, and a restart that wiped the disk: nothing is lost
    s = await boot();
    const oneName = path.basename(one.url); const twoName = path.basename(two.url);
    const legacy = await fetch(`${s.base}${one.url}`);
    ok(legacy.status === 200 && Buffer.from(await legacy.arrayBuffer()).equals(PNG) && !bucket.has(oneName), 'with R2 switched on and nothing moved yet, a file that is only in the database is still served');
    const three = await upload(s, A.token, Buffer.concat([PNG, Buffer.from('3')]), 'three.png');
    ok(bucket.has(path.basename(three.url)) && await rows() === 2, 'a new upload goes to the bucket, not into the database');
    // moving them
    t = await toolPg({ ORATE_DATA: s.dir }, 'files-to-r2');
    ok(t.status === 0 && /2 file\(s\) copied/.test(t.stdout) && bucket.get(oneName)?.data.equals(PNG) && bucket.get(twoName)?.data.equals(TWO) && await rows() === 2 && /Run it again with -- --purge/.test(t.stdout), 'db:files-to-r2 copies them into the bucket, and without --purge leaves the database as it was', `${t.stdout}${t.stderr}`);
    // a file the bucket doesn't keep: nothing is deleted
    await sql('INSERT INTO orate_files (name, type, size, data) VALUES ($1, $2, $3, $4)', ['ghost.png', 'image/png', 3, Buffer.from('boo')]); F.drop = 'ghost';
    t = await toolPg({ ORATE_DATA: s.dir }, 'files-to-r2', '--purge'); F.drop = null;
    ok(t.status === 1 && /ghost\.png/.test(t.stdout) && /Nothing was deleted/.test(t.stdout) && await rows() === 3, '--purge with a file that didn’t make it to R2 refuses: the database keeps everything');
    t = await toolPg({ ORATE_DATA: s.dir }, 'files-to-r2', '--purge');
    ok(t.status === 0 && /Emptied the files kept in the database/.test(t.stdout) && await rows() === 0, 'once every file is in the bucket, --purge empties the database’s table of files');
    fs.rmSync(path.join(s.dir, 'uploads'), { recursive: true, force: true }); fs.mkdirSync(path.join(s.dir, 'uploads'));   // the disk cache wiped again
    const after = await fetch(`${s.base}${two.url}`);
    ok(after.status === 200 && Buffer.from(await after.arrayBuffer()).equals(TWO), 'and the moved files are served from R2 as before');
    ok(!!(await sql('SELECT 1 FROM orate_state WHERE id = 1')).rows.length && (await sql('SELECT count(*)::int AS n FROM orate_sessions')).rows[0].n >= 1, 'the chat state and the sessions are still in the database, untouched');
    await stop(s);
    const out2 = fs.mkdtempSync(path.join(os.tmpdir(), 'orata-r2pg-export-')); dirs.push(out2);
    t = await toolPg({ ORATE_DATA: out2 }, 'export');
    ok(t.status === 0 && fs.existsSync(path.join(out2, 'db.json')) && [oneName, twoName, path.basename(three.url)].every((n) => fs.existsSync(path.join(out2, 'uploads', n))), 'db:export brings the files back out of the bucket too (backing up and leaving work as before)', `${t.stdout}${t.stderr}`);
  } finally {
    for (const k of kids) k.kill('SIGINT');
    await sleep(500); try { await sock.stop(); await pgdb.close(); } catch { /* already down */ }
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
}
fake.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
