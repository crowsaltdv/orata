// Orata PostgreSQL storage self-test (runs after the other suites):  npm test
// Needs a Postgres to talk to. It uses PGlite (real Postgres compiled to WebAssembly) behind a local socket, so no install of
// Postgres is required — but PGlite is not an Orata dependency; if it is missing this suite is skipped. To run it:
//     npm install --no-save @electric-sql/pglite @electric-sql/pglite-socket
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let PGlite; let PGLiteSocketServer;
try { ({ PGlite } = await import('@electric-sql/pglite')); ({ PGLiteSocketServer } = await import('@electric-sql/pglite-socket')); } catch {
  console.log('PostgreSQL storage self-test: skipped (PGlite is not installed).\n  To run it:  npm install --no-save @electric-sql/pglite @electric-sql/pglite-socket');
  process.exit(0);
}
const { default: pgmod } = await import('pg'); const { Client } = pgmod;

let pass = 0; let fail = 0;
const ok = (c, name, extra = '') => { if (c) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(60); } return fn(); };
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/* ---------------------------------------------------------------- a real Postgres on a local socket */
const PGPORT = 5600 + Math.floor(Math.random() * 300);
const pgdb = await PGlite.create();
const sock = new PGLiteSocketServer({ db: pgdb, port: PGPORT, host: '127.0.0.1', maxConnections: 100 });
await sock.start();
const DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${PGPORT}/postgres`;
const sql = async (text, params) => { const c = new Client({ connectionString: DATABASE_URL }); await c.connect(); try { return await c.query(text, params); } finally { await c.end(); } };
const resetDb = async () => { await sql('DROP TABLE IF EXISTS orate_state'); await sql('DROP TABLE IF EXISTS orate_files'); await sql('DROP TABLE IF EXISTS orate_sessions'); };
const readState = async () => { const r = await sql('SELECT version, data FROM orate_state WHERE id = 1'); return r.rows[0] ? { version: Number(r.rows[0].version), db: JSON.parse(zlib.gunzipSync(r.rows[0].data).toString()) } : null; };

/* ---------------------------------------------------------------- scratch Orata servers */
let nextPort = 3700 + Math.floor(Math.random() * 90);
function startServer(extraEnv = {}, { withDb = true, dataDir } = {}) {
  const port = nextPort++;
  const data = dataDir || tmp('orate-pg-test-');
  const env = { ...process.env, PORT: String(port), ORATE_DATA: data, HOST: '127.0.0.1', SMTP_HOST: '', REQUIRE_EMAIL_VERIFICATION: '', PUBLIC_URL: '', DATABASE_URL: withDb ? DATABASE_URL : '', DATABASE_SAVE_DELAY_MS: '150', DATABASE_POOL_MAX: '3', ...extraEnv };
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const srv = { child, data, port, out: '', base: `http://127.0.0.1:${port}`, exited: null };
  child.stdout.on('data', (d) => { srv.out += d; }); child.stderr.on('data', (d) => { srv.out += d; });
  child.on('exit', (code) => { srv.exited = code ?? 'killed'; });
  srv.api = async (method, url, token, body, headers = {}) => {
    const res = await fetch(srv.base + '/api' + url, { method, headers: { ...(body && !(body instanceof Buffer) ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers }, body: body ? (body instanceof Buffer ? body : JSON.stringify(body)) : undefined });
    let j = null; try { j = await res.json(); } catch { /* none */ }
    return { status: res.status, body: j };
  };
  srv.ready = async () => { for (let i = 0; i < 150 && srv.exited === null; i++) { try { await fetch(srv.base + '/api/config'); return true; } catch { await sleep(100); } } return false; };
  srv.stop = () => { child.kill(); };
  return srv;
}
const reg = (srv, name) => srv.api('POST', '/auth/register', null, { email: `${name}@example.com`, username: name, displayName: name, password: 'hunter2hunter2', dob: { year: 1995, month: 5, day: 5 } });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const textChannel = async (srv, token) => { const r = await srv.api('GET', '/ready', token); return r.body.servers[0].channels.find((c) => c.type === 'text'); };
const servers = [];
const boot = async (...a) => { const s = startServer(...a); servers.push(s); const up = await s.ready(); return up ? s : s; };

async function main() {
  console.log('PostgreSQL storage self-test (PGlite on port', PGPORT + ')');
  try {
    /* ---------- connection settings ---------- */
    console.log('\nConnection settings');
    const { poolOptions } = await import('./storage.js');
    ok(poolOptions('postgres://u:p@localhost/db').ssl === false, 'localhost: no TLS');
    ok(poolOptions('postgres://u:p@ep-1.neon.tech/db?sslmode=require').ssl?.rejectUnauthorized === true && !poolOptions('postgres://u:p@ep-1.neon.tech/db?sslmode=require').connectionString.includes('sslmode'), 'remote host: verified TLS (sslmode removed from the URL so it cannot override)');
    ok(poolOptions('postgres://u:p@db.example.com/db', { DATABASE_SSL: 'no-verify' }).ssl?.rejectUnauthorized === false, 'DATABASE_SSL=no-verify skips certificate checks');
    ok(poolOptions('postgres://u:p@db.example.com/db', { DATABASE_SSL: 'off' }).ssl === false, 'DATABASE_SSL=off disables TLS');

    /* ---------- persistence ---------- */
    console.log('\nData survives a wiped disk');
    const s1 = await boot();
    ok(/Storage: PostgreSQL \(127\.0\.0\.1\)/.test(s1.out), 'the startup banner says PostgreSQL');
    let r = await reg(s1, 'alice'); const alice = r.body.token;
    ok(r.status === 200, 'sign-up works');
    const ch = await textChannel(s1, alice);
    r = await s1.api('POST', `/channels/${ch.id}/messages`, alice, { content: 'hello from before the restart' });
    ok(r.status === 200, 'a message is posted');
    r = await s1.api('POST', '/upload', alice, PNG, { 'content-type': 'image/png', 'x-filename': 'dot.png' });
    ok(r.status === 200 && r.body.url.startsWith('/uploads/'), 'a file is uploaded');
    const upUrl = r.body.url; const upName = upUrl.split('/').pop();
    const st1 = await until(async () => { const s = await readState(); return s && s.version > 1 && s.db.users && Object.values(s.db.users).some((u) => u.username === 'alice') && Object.values(s.db.messages).some((l) => l.some((m) => m.content.includes('before the restart'))) ? s : null; });
    ok(!!st1, 'the whole database (account + message) is stored in Postgres as gzipped JSON');
    const fileRow = (await sql('SELECT name, size FROM orate_files WHERE name = $1', [upName])).rows[0];
    ok(fileRow && Number(fileRow.size) === PNG.length, 'the uploaded file is stored in Postgres');
    ok(!fs.existsSync(path.join(s1.data, 'db.json')), 'no db.json is written locally');
    s1.stop(); await until(() => s1.exited !== null);

    const s2 = await boot();   // a brand-new empty data directory: like Render after a restart
    ok(!fs.existsSync(path.join(s2.data, 'uploads', upName)), '(the new server starts with an empty disk)');
    r = await s2.api('POST', '/auth/login', null, { login: 'alice', password: 'hunter2hunter2' });
    ok(r.status === 200 && !!r.body.token, 'the account still exists and can log in');
    const alice2 = r.body.token;
    r = await s2.api('GET', `/channels/${ch.id}/messages?limit=20`, alice2);
    ok(r.status === 200 && JSON.stringify(r.body).includes('hello from before the restart'), 'the message history is intact');
    const img = await fetch(s2.base + upUrl);
    const imgBuf = Buffer.from(await img.arrayBuffer());
    ok(img.status === 200 && imgBuf.equals(PNG) && /image\/png/.test(img.headers.get('content-type') || ''), 'the uploaded file is served again (restored from Postgres)');
    ok(fs.existsSync(path.join(s2.data, 'uploads', upName)), '…and cached on disk for next time');
    r = await s2.api('POST', '/upload', alice2, PNG, { 'content-type': 'image/png', 'x-filename': 'second.png' });
    const second = r.body.url;
    s2.stop(); await until(() => s2.exited !== null);

    const s3 = await boot();   // another wiped disk; attach a file that exists only in the database
    r = await s3.api('POST', '/auth/login', null, { login: 'alice', password: 'hunter2hunter2' }); const alice3 = r.body.token;
    r = await s3.api('POST', `/channels/${ch.id}/messages`, alice3, { content: 'with a file', attachments: [{ url: second, name: 'second.png', type: 'image/png' }] });
    ok(r.status === 200 && r.body.attachments?.length === 1 && r.body.attachments[0].size === PNG.length, 'attaching a file that is only in the database works (restored first)');
    s3.stop(); await until(() => s3.exited !== null);

    /* ---------- sessions ---------- */
    console.log('\nSessions are saved on their own, before the login answers');
    const s3b = await boot({ DATABASE_SAVE_DELAY_MS: '60000' });   // the big state row would not be written for a minute…
    r = await s3b.api('POST', '/auth/login', null, { login: 'alice', password: 'hunter2hunter2' }); const aliceB = r.body.token;
    ok(r.status === 200 && !!aliceB, 'login works');
    const sessRows = (await sql('SELECT hash, user_id, ua FROM orate_sessions')).rows;
    ok(sessRows.length >= 1 && !('ip' in sessRows[0]), 'the session is already in its own table (no IP column)');
    s3b.child.kill(); await until(() => s3b.exited !== null);   // …and the process dies without flushing anything
    const s3c = await boot();
    r = await s3c.api('GET', '/me', aliceB);
    ok(r.status === 200 && r.body.username === 'alice', 'the login still works after a crash, an update or a lost write race');
    r = await s3c.api('GET', '/me/sessions', aliceB);
    ok(r.status === 200 && r.body.some((x) => x.current) && r.body.every((x) => !('ip' in x)), 'the session list reads from the table');
    r = await s3c.api('POST', '/auth/logout', aliceB); r = await s3c.api('GET', '/me', aliceB);
    ok(r.status === 401, 'logging out ends it');
    ok((await sql('SELECT count(*)::int AS n FROM orate_sessions WHERE hash = $1', [crypto.createHash('sha256').update(aliceB).digest('hex')])).rows[0].n === 0, '…from the table too');
    s3c.stop(); await until(() => s3c.exited !== null);

    /* ---------- storage limit ---------- */
    console.log('\nStorage limit');
    const s4 = await boot({ DATABASE_FILES_MB: '1' });
    r = await s4.api('POST', '/auth/login', null, { login: 'alice', password: 'hunter2hunter2' }); const alice4 = r.body.token;
    const used0 = Number((await sql('SELECT COALESCE(SUM(size),0) AS n FROM orate_files')).rows[0].n);
    const big = Buffer.alloc(Math.floor((1048576 - used0) * 0.6), 7);
    r = await s4.api('POST', '/upload', alice4, big, { 'content-type': 'application/octet-stream', 'x-filename': 'a.bin' });
    ok(r.status === 200, 'a file under the limit is accepted');
    r = await s4.api('POST', '/upload', alice4, big, { 'content-type': 'application/octet-stream', 'x-filename': 'b.bin' });
    ok(r.status === 507 && r.body.code === 'storage_full' && /Storage is full/.test(r.body.error), 'a file over the limit is refused with a clear message');
    ok(fs.readdirSync(path.join(s4.data, 'uploads')).filter((n) => fs.statSync(path.join(s4.data, 'uploads', n)).size === big.length).length === 1, 'the refused file is not kept on disk');
    ok(Number((await sql('SELECT COUNT(*) AS n FROM orate_files WHERE size = $1', [big.length])).rows[0].n) === 1, '…nor in the database');
    s4.stop(); await until(() => s4.exited !== null);

    /* ---------- two instances ---------- */
    console.log('\nTwo instances on one database');
    const a = await boot(); const b = await boot();
    ok(a.exited === null && b.exited === null, 'two servers start against the same database');
    await reg(b, 'carol');
    await until(async () => (await readState())?.db && Object.values((await readState()).db.users).some((u) => u.username === 'carol'));
    await reg(a, 'dave');   // a loaded the old state: its write must be refused, not silently overwrite carol
    await until(() => a.exited !== null, 10000);
    ok(a.exited === 1 && /another Orata instance/.test(a.out), 'the stale instance exits instead of overwriting the newer data');
    const after = await readState();
    ok(Object.values(after.db.users).some((u) => u.username === 'carol') && !Object.values(after.db.users).some((u) => u.username === 'dave'), 'the data written by the other instance is intact');
    b.stop(); await until(() => b.exited !== null);

    /* ---------- import ---------- */
    console.log('\nMoving local files into the database');
    await resetDb();
    const local = await boot({}, { withDb: false });
    ok(/Storage: local files/.test(local.out), 'without DATABASE_URL Orata still uses local files');
    r = await reg(local, 'erin'); const erin = r.body.token;
    r = await local.api('POST', '/upload', erin, PNG, { 'content-type': 'image/png', 'x-filename': 'erin.png' }); const erinFile = r.body.url;
    await until(() => fs.existsSync(path.join(local.data, 'db.json')) && fs.readFileSync(path.join(local.data, 'db.json'), 'utf8').includes('erin'));
    local.stop(); await until(() => local.exited !== null);
    const adopt = await boot({}, { dataDir: local.data });   // same folder, but now with DATABASE_URL and an empty database
    ok(/imported into it/.test(adopt.out) && /1 uploaded file/.test(adopt.out), 'an empty database adopts data/db.json and data/uploads automatically');
    r = await adopt.api('POST', '/auth/login', null, { login: 'erin', password: 'hunter2hunter2' });
    ok(r.status === 200, 'the imported account works');
    ok((await sql('SELECT 1 FROM orate_files WHERE name = $1', [erinFile.split('/').pop()])).rowCount === 1, 'the imported file is in the database');
    adopt.stop(); await until(() => adopt.exited !== null);

    /* ---------- the command-line tool ---------- */
    console.log('\nCommand-line tool (db:info / db:import / db:export)');
    // async on purpose: the Postgres server lives in this very process, so a blocking spawnSync would deadlock it
    const tool = (args, dataDir) => new Promise((resolve) => {
      const c = spawn(process.execPath, [path.join(ROOT, 'server', 'db-tool.js'), ...args], { env: { ...process.env, DATABASE_URL, ORATE_DATA: dataDir, DATABASE_SSL: 'off', DATABASE_POOL_MAX: '1' } });
      let stdout = ''; let stderr = ''; c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; });
      const kill = setTimeout(() => c.kill(), 60000); c.on('exit', (status) => { clearTimeout(kill); resolve({ status, stdout, stderr }); });
    });
    let t = await tool(['info'], local.data);
    ok(t.status === 0 && /1 user\(s\)/.test(t.stdout) && /1 uploaded file/.test(t.stdout), 'db:info shows what is stored');
    t = await tool(['import'], local.data);
    ok(t.status === 1 && /already holds data/.test(t.stderr), 'db:import refuses to overwrite existing data', (t.stdout + t.stderr).slice(0, 400));
    const outDir = tmp('orate-export-');
    t = await tool(['export'], outDir);
    ok(t.status === 0 && fs.existsSync(path.join(outDir, 'db.json')) && fs.readdirSync(path.join(outDir, 'uploads')).includes(erinFile.split('/').pop()), 'db:export writes db.json and the uploaded files', (t.stdout + t.stderr).slice(0, 500));
    ok(Object.values(JSON.parse(fs.readFileSync(path.join(outDir, 'db.json'), 'utf8')).users).some((u) => u.username === 'erin'), '…with the account inside');
    t = await tool(['export'], outDir);
    ok(t.status === 1 && /already exists/.test(t.stderr), 'db:export refuses to replace an existing db.json without --force');
    t = await tool(['export', '--force'], outDir);
    ok(t.status === 0 && fs.readdirSync(outDir).some((n) => n.startsWith('db.json.bak-')), 'db:export --force keeps a backup of the old file');
    const back = await boot({}, { withDb: false, dataDir: outDir });   // the exported folder is a complete, working data directory
    r = await back.api('POST', '/auth/login', null, { login: 'erin', password: 'hunter2hunter2' });
    ok(r.status === 200, 'an exported folder runs as a normal local Orata');
    back.stop(); await until(() => back.exited !== null);
  } finally {
    for (const s of servers) { try { s.stop(); } catch { /* ignore */ } }
    await sock.stop(); await pgdb.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
