// Orate community-features self-test (runs after the other suites):  npm test
// Optional emails at sign-up, bans that follow the person's browser (hashed, never shown; networks are ignored), ban reasons, timeouts, GIF icons / banners,
// custom emoji and stickers, forum channels and polls.
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { ENGINES } from '../public/js/profile-effects.js';
import { EFFECTS } from '../public/js/profile-data.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'orate-comm-test-'));
const PORT = 3600 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${PORT}`;
let pass = 0; let fail = 0;
const ok = (c, name, extra = '') => { if (c) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

let child = null;
function startServer(extra = {}) {
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    // the ban tests make many accounts on one browser, so the per-browser account limits are raised except where they are tested
    env: { ...process.env, PORT: String(PORT), ORATE_DATA: data, HOST: '127.0.0.1', SMTP_HOST: '', REQUIRE_EMAIL_VERIFICATION: '', DATABASE_URL: '', KLIPY_API_KEY: '', TRUST_PROXY: '1', ACCOUNTS_PER_BROWSER: '1000', ACCOUNTS_PER_HOUR: '1000', ...extra },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}
async function ready() { for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/config'); return; } catch { await sleep(100); } } }
async function stopServer() { if (!child) return; await sleep(900); const c = child; child = null; const done = new Promise((r) => c.once('exit', r)); c.kill('SIGINT'); await Promise.race([done, sleep(3000)]); }

async function api(method, url, token, body, headers = {}) {
  const res = await fetch(base + '/api' + url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: j };
}
const upload = async (token, buf, type = 'image/png', name = 'a.png') => (await (await fetch(base + '/api/upload', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': type, 'x-filename': name }, body: buf })).json());
function connect(token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/gateway`); const events = []; const waiters = [];
    ws.on('open', () => ws.send(JSON.stringify({ op: 'identify', d: { token } })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw); events.push(m);
      for (const w of [...waiters]) if (w.op === m.op && (!w.fn || w.fn(m.d))) { waiters.splice(waiters.indexOf(w), 1); w.res(m.d); }
      if (m.op === 'ready') resolve({ ws, events, ready: m.d, wait: (op, fn, ms = 2500) => new Promise((res, rej) => { const f = events.find((e) => e.op === op && (!fn || fn(e.d))); if (f) return res(f.d); const w = { op, fn, res }; waiters.push(w); setTimeout(() => rej(new Error('timeout waiting for ' + op)), ms); }) });
    });
  });
}
let n = 0;
const register = async (username, { email, ip, dev } = {}) => {
  const r = await api('POST', '/auth/register', null, { ...(email !== undefined ? { email } : {}), username, displayName: username[0].toUpperCase() + username.slice(1), password: 'password123', dob: { year: 1995, month: 1, day: 1 } }, { ...(ip ? { 'x-forwarded-for': ip } : {}), ...(dev ? { 'x-orate-device': dev } : {}) });
  return { token: r.body?.token, user: r.body?.user, res: r };
};

async function main() {
  startServer(); await ready();
  console.log('Orate community-features test on port', PORT);

  /* ---------------------------------------------------------------- sign-up without an email */
  console.log('\nSign-up without an email');
  let A = await register('alice');
  ok(A.res.status === 200 && A.token && A.user.email === null, 'an account needs no email');
  let r = await api('POST', '/auth/login', null, { login: 'alice', password: 'password123' }); ok(r.status === 200, 'it signs in with just the username');
  r = await api('POST', '/auth/register', null, { email: 'nope', username: 'bad1', displayName: 'Bad', password: 'password123', dob: { year: 1995, month: 1, day: 1 } }); ok(r.status === 400 && r.body.code === 'email', 'an email that is given must still be valid');
  const E = await register('erin', { email: 'erin@comm.dev' }); ok(E.res.status === 200 && E.user.email === 'erin@comm.dev', 'an email can still be given');
  r = await api('POST', '/auth/register', null, { email: 'ERIN@comm.dev', username: 'erin2', displayName: 'E', password: 'password123', dob: { year: 1995, month: 1, day: 1 } }); ok(r.status === 400 && r.body.code === 'email', '… and stays unique');
  r = await api('PATCH', '/me', A.token, { email: 'alice@comm.dev', password: 'password123' }); ok(r.status === 200 && r.body.email === 'alice@comm.dev', 'an email can be added later (with the password)');
  r = await api('PATCH', '/me', A.token, { email: '', password: 'password123' }); ok(r.status === 200 && r.body.email === null, '… and removed again');
  r = await api('POST', '/auth/login', null, { login: 'alice@comm.dev', password: 'password123' }); ok(r.status === 401, 'a removed email no longer signs in');
  r = await api('POST', '/auth/resend-verification', A.token); ok(r.status === 400, 'there is nothing to verify without an email');

  /* ---------------------------------------------------------------- bans that follow the browser (and never the network) */
  console.log('\nBans');
  r = await api('POST', '/servers', A.token, { name: 'Ban Guild', template: 'gaming' }); const S = r.body;
  const text = S.channels.find((c) => c.type === 'text');
  r = await api('POST', `/servers/${S.id}/invites`, A.token, {}); const code = r.body.code;
  const hdr = (dev, ip) => ({ ...(ip ? { 'x-forwarded-for': ip } : {}), ...(dev ? { 'x-orate-device': dev } : {}) });
  const devOwner = 'device-oooooooooooooooo'; const devM = 'device-mmmmmmmmmmmmmmmm'; const devCarol = 'device-carolcarolcarol'; const devFar = 'device-farfarfarfarfar';
  const joinWith = (tok, dev, ip) => api('POST', `/invites/${code}/join`, tok, null, hdr(dev, ip));
  await joinWith(A.token, devOwner, '203.0.113.50');   // the owner's own browser
  const M = await register('mallory', { dev: devM, ip: '203.0.113.7' });
  r = await joinWith(M.token, devM, '203.0.113.7'); ok(r.status === 200, 'mallory joins');
  await api('POST', `/channels/${text.id}/messages`, M.token, { content: 'spam one' }); await api('POST', `/channels/${text.id}/messages`, M.token, { content: 'spam two' });
  await api('POST', `/channels/${text.id}/messages`, A.token, { content: 'a normal message' });
  r = await api('PUT', `/servers/${S.id}/bans/${M.user.id}`, A.token, { reason: 'spamming', deleteHours: 1 }); ok(r.status === 200, 'the owner bans her with a reason and clears her last hour');
  r = await api('GET', `/channels/${text.id}/messages?limit=50`, A.token); ok(!r.body.messages.some((x) => x.authorId === M.user.id && x.type === 'default') && r.body.messages.some((x) => x.content === 'a normal message'), 'her recent messages are gone, other people’s stay');
  r = await api('GET', `/servers/${S.id}/bans`, A.token);
  ok(r.body.length === 1 && r.body[0].ban.reason === 'spamming' && r.body[0].ban.by === 'Alice' && r.body[0].ban.deviceBanned === true && typeof r.body[0].ban.at === 'number', 'the ban list shows who, why, when and that her browser is blocked');
  r = await joinWith(M.token, devM, '203.0.113.7'); ok(r.status === 403, 'she cannot rejoin');
  r = await joinWith(M.token, devFar, '198.51.100.99'); ok(r.status === 403, 'not even from another browser (account ban)');
  const M2 = await register('mallory2', { dev: devM, ip: '198.51.100.30' });
  r = await joinWith(M2.token, devM, '198.51.100.30'); ok(r.status === 403, 'a NEW account from her browser is turned away too');
  r = await joinWith(M2.token, devFar, '198.51.100.31'); ok(r.status === 403, '… even if it tries from another browser later (it was seen on hers)');
  const carol = await register('carol', { dev: devCarol, ip: '203.0.113.7' });
  r = await joinWith(carol.token, devCarol, '203.0.113.7'); ok(r.status === 200, 'a stranger on mallory’s own network, in another browser, joins fine — networks are ignored');
  const noDev = await register('nodevice', { ip: '203.0.113.7' });
  r = await joinWith(noDev.token, null, '203.0.113.7'); ok(r.status === 200, '… and so does a visitor that sends no browser id at all');
  const ownerBr = await register('bob', { dev: devOwner });
  await joinWith(ownerBr.token, devOwner);
  r = await api('PUT', `/servers/${S.id}/bans/${ownerBr.user.id}`, A.token, {}); ok(r.status === 200, 'someone who uses the owner’s browser is banned');
  const ownerBr2 = await register('bob2', { dev: devOwner });
  r = await joinWith(ownerBr2.token, devOwner); ok(r.status === 200, 'the owner’s own browser is never blocked');
  r = await api('DELETE', `/servers/${S.id}/bans/${M.user.id}`, A.token); ok(r.status === 200, 'unban mallory');
  r = await joinWith(M2.token, devM, '198.51.100.30'); ok(r.status === 200, 'unbanning frees her browser again');
  r = await api('GET', `/servers/${S.id}/bans`, M.token); ok(r.status === 404 || r.status === 403, 'only members with Ban Members can read the list');
  const BT = await register('banme', { dev: 'device-bantestbantest1' }); await joinWith(BT.token, 'device-bantestbantest1');
  r = await api('PUT', `/servers/${S.id}/bans/${BT.user.id}`, A.token, {}); ok(r.status === 200, 'ban one more person (used for the upgrade check below)');
  const blob = JSON.stringify([(await api('GET', '/me', A.token)).body, (await api('GET', '/me/sessions', A.token)).body, (await api('GET', `/servers/${S.id}/bans`, A.token)).body, (await api('GET', '/ready', A.token)).body]);
  ok(!/203\.0\.113|198\.51\.100|device-mmmm|device-bantest/.test(blob), 'no address and no browser id appears in anything the API returns');
  await stopServer();
  let raw = fs.readFileSync(path.join(data, 'db.json'), 'utf8');
  ok(!/203\.0\.113|198\.51\.100|device-mmmm|device-bantest/.test(raw) && /"devs":\[\{"h":"dv[0-9a-f]{22}"/.test(raw) && !/"ips"/.test(raw), 'only keyed browser hashes are stored — no address, no readable id, no network hashes at all');
  // a database from before this change: network hashes on accounts and in the ban list, mixed with the browser ones
  const old = JSON.parse(raw); const oldS = old.servers[S.id];
  for (const u of Object.values(old.users)) u.ips = [{ h: '0123456789abcdef01234567', at: Date.now() }];
  oldS.bannedIps = { ...oldS.bannedDevices, '0123456789abcdef01234567': BT.user.id, fedcba987654321012345678: BT.user.id }; delete oldS.bannedDevices;
  fs.writeFileSync(path.join(data, 'db.json'), JSON.stringify(old));
  startServer(); await ready(); await sleep(1200); await stopServer();
  const up = JSON.parse(fs.readFileSync(path.join(data, 'db.json'), 'utf8')); const upS = up.servers[S.id];
  ok(!Object.values(up.users).some((u) => u.ips) && !upS.bannedIps, 'upgrading forgets every network hash');
  ok(Object.keys(upS.bannedDevices || {}).length >= 1 && Object.keys(upS.bannedDevices).every((k) => k.startsWith('dv')), '… and keeps the browser bans');
  startServer(); await ready();
  const BT2 = await register('banme2', { dev: 'device-bantestbantest1', ip: '192.0.2.1' }); r = await joinWith(BT2.token, 'device-bantestbantest1', '192.0.2.1'); ok(r.status === 403, 'a browser ban made before the upgrade still holds');

  /* ---------------------------------------------------------------- timeouts */
  console.log('\nTimeouts');
  const T = await register('tim'); await api('POST', `/invites/${code}/join`, T.token);
  const MOD = await register('moddy'); await api('POST', `/invites/${code}/join`, MOD.token);
  r = await api('POST', `/servers/${S.id}/roles`, A.token, { name: 'Mod', permissions: ['MODERATE_MEMBERS'] }); const modRole = r.body;
  await api('PUT', `/servers/${S.id}/members/${MOD.user.id}/roles/${modRole.id}`, A.token);
  r = await api('PUT', `/servers/${S.id}/members/${T.user.id}/timeout`, T.token, { minutes: 5 }); ok(r.status === 403, 'a normal member cannot time anyone out');
  r = await api('PUT', `/servers/${S.id}/members/${T.user.id}/timeout`, MOD.token, { minutes: 5 }); ok(r.status === 200 && r.body.timeoutUntil > Date.now(), 'a moderator can');
  r = await api('POST', `/channels/${text.id}/messages`, T.token, { content: 'hi' }); ok(r.status === 403, 'a timed-out member cannot talk');
  r = await api('GET', `/channels/${text.id}/messages?limit=5`, T.token); ok(r.status === 200, '… but can still read');
  r = await api('PUT', `/channels/${text.id}/messages/${(await api('GET', `/channels/${text.id}/messages?limit=1`, T.token)).body.messages[0].id}/reactions/${encodeURIComponent('👍')}/@me`, T.token); ok(r.status === 403, '… and cannot react');
  const view = (await api('GET', '/ready', A.token)).body.servers.find((s) => s.id === S.id);
  ok(view.members.find((m) => m.id === T.user.id).timeoutUntil > Date.now() && view.perms.includes('MODERATE_MEMBERS') && view.perms.includes('MANAGE_EXPRESSIONS'), 'everybody’s member list shows the timeout');
  r = await api('PUT', `/servers/${S.id}/members/${A.user.id}/timeout`, MOD.token, { minutes: 5 }); ok(r.status === 403, 'the owner cannot be timed out');
  r = await api('PUT', `/servers/${S.id}/members/${T.user.id}/timeout`, MOD.token, { minutes: 0 }); ok(r.status === 200 && r.body.timeoutUntil === null, 'a timeout can be lifted');
  r = await api('POST', `/channels/${text.id}/messages`, T.token, { content: 'back' }); ok(r.status === 200, '… and then they can talk again');

  /* ---------------------------------------------------------------- alt accounts: a ban or a timeout follows the person */
  console.log('\nAlt accounts');
  const mk = async (name, ip, dev) => {
    const h = { ...(ip ? { 'x-forwarded-for': ip } : {}), ...(dev ? { 'x-orate-device': dev } : {}) };
    const reg0 = await api('POST', '/auth/register', null, { username: name, displayName: name, password: 'password123', dob: { year: 1995, month: 1, day: 1 } }, h);
    const joined = await api('POST', `/invites/${code}/join`, reg0.body.token, null, h);
    return { token: reg0.body.token, user: reg0.body.user, h, joined: joined.status };
  };
  const memberIds = async () => (await api('GET', '/ready', A.token)).body.servers.find((s) => s.id === S.id).members.map((m) => m.id);
  const devA = 'device-aaaaaaaaaaaaaaaa'; const devB = 'device-bbbbbbbbbbbbbbbb';
  const P1 = await mk('alt_p1', '198.51.100.1', devA); const P2 = await mk('alt_p2', '198.51.100.2', devA); const P3 = await mk('alt_p3', '198.51.100.3', devB);
  ok(P1.joined === 200 && P2.joined === 200 && P3.joined === 200, 'three accounts join (two of them from the same browser)');
  r = await api('PUT', `/servers/${S.id}/bans/${P1.user.id}`, A.token, { reason: 'spam' });
  ok(r.status === 200 && r.body.alts.length === 1 && r.body.alts[0].id === P2.user.id, 'banning one account bans the other account on the same browser, even from another network');
  let ids = await memberIds(); ok(!ids.includes(P1.user.id) && !ids.includes(P2.user.id) && ids.includes(P3.user.id), '… and only those two leave; an unrelated account stays');
  r = await api('GET', `/servers/${S.id}/bans`, A.token); const altRow = r.body.find((x) => x.id === P2.user.id);
  ok(altRow?.ban.altOf === 'alt_p1' && altRow.ban.reason.startsWith('Alt of alt_p1') && altRow.ban.deviceBanned === true, 'the ban list says it is an alt, and of whom');
  r = await api('POST', `/invites/${code}/join`, P2.token, null, P2.h); ok(r.status === 403, 'the alt cannot come back');
  const P4 = await mk('alt_p4', '198.51.100.4', devA); ok(P4.joined === 403, 'a brand-new account on that browser is turned away');
  const P5 = await mk('alt_p5', '198.51.100.5', devB); ok(P5.joined === 200, 'a new account from a different browser and network is fine');
  r = await api('DELETE', `/servers/${S.id}/bans/${P1.user.id}`, A.token); ok(r.status === 200 && r.body.freed === 1, 'unbanning the person frees their alts too');
  r = await api('POST', `/invites/${code}/join`, P2.token, null, P2.h); ok(r.status === 200, '… and the alt can rejoin');
  const Q1 = await mk('alt_q1', '198.51.100.11', 'device-qqqqqqqqqqqqqqqq'); const Q2 = await mk('alt_q2', '198.51.100.12', 'device-qqqqqqqqqqqqqqqq');
  r = await api('PUT', `/servers/${S.id}/bans/${Q1.user.id}`, A.token, { alts: false }); ids = await memberIds(); ok(r.status === 200 && r.body.alts.length === 0 && ids.includes(Q2.user.id), 'a moderator can choose to ban just the one account');
  const N1 = await mk('alt_n1', '203.0.113.77'); const N2 = await mk('alt_n2', '203.0.113.77');
  r = await api('PUT', `/servers/${S.id}/bans/${N1.user.id}`, A.token, {}); ids = await memberIds(); ok(r.status === 200 && r.body.alts.length === 0 && ids.includes(N2.user.id), 'accounts that share only a network are NOT alts — networks are ignored');
  const U1 = await mk('alt_u1', '198.51.100.21', 'device-uuuuuuuuuuuuuuuu'); const U2 = await mk('alt_u2', '198.51.100.22', 'device-uuuuuuuuuuuuuuuu');
  await api('PUT', `/servers/${S.id}/members/${MOD.user.id}/roles/${modRole.id}`, A.token);
  r = await api('PUT', `/servers/${S.id}/members/${U1.user.id}/timeout`, MOD.token, { minutes: 5 });
  const timed = async (id) => ((await api('GET', '/ready', A.token)).body.servers.find((s) => s.id === S.id).members.find((m) => m.id === id)?.timeoutUntil || 0) > Date.now();
  ok(r.status === 200 && r.body.alts === 1 && await timed(U1.user.id) && await timed(U2.user.id), 'a timeout reaches the person’s other accounts too');
  const U3 = await mk('alt_u3', '198.51.100.23', 'device-uuuuuuuuuuuuuuuu'); ok(U3.joined === 200 && await timed(U3.user.id), 'an account made afterwards on that browser joins already timed out');
  r = await api('POST', `/channels/${text.id}/messages`, U3.token, { content: 'hello' }); ok(r.status === 403, '… and cannot talk');
  r = await api('PUT', `/servers/${S.id}/members/${U1.user.id}/timeout`, MOD.token, { minutes: 0 });
  ok(r.status === 200 && !(await timed(U1.user.id)) && !(await timed(U2.user.id)) && !(await timed(U3.user.id)), 'lifting it lifts it for all of them');

  /* ---------------------------------------------------------------- a ban follows the browser into the community server too (it is joined automatically at sign-up) */
  console.log('\nBans and the default community server');
  const comm = (await api('GET', '/ready', A.token)).body.servers.find((s) => s.name === 'Orate Community');
  const mkc = async (name, ip, dev, cookie) => {
    const h = { ...(ip ? { 'x-forwarded-for': ip } : {}), ...(dev ? { 'x-orate-device': dev } : {}), ...(cookie ? { cookie: `theme=dark; orate_dev=${cookie}; other=1` } : {}) };
    const reg0 = await api('POST', '/auth/register', null, { username: name, displayName: name, password: 'password123', dob: { year: 1995, month: 1, day: 1 } }, h);
    const inC = (await api('GET', '/ready', reg0.body.token, null, h)).body.servers.some((s) => s.id === comm.id);
    return { token: reg0.body.token, user: reg0.body.user, h, inC };
  };
  const devC = 'device-cccccccccccccccc'; const devD = 'device-dddddddddddddddd';
  const C1 = await mkc('cm_one', '198.51.100.31', devC); ok(comm && C1.inC, 'a new account joins the community server automatically');
  r = await api('PUT', `/servers/${comm.id}/bans/${C1.user.id}`, A.token, { reason: 'spam' }); ok(r.status === 200, 'ban someone from the community server');
  const C2 = await mkc('cm_two', '198.51.100.32', devC); ok(C2.token && !C2.inC, 'a new account from the same browser is not put in the community server');
  const C3 = await mkc('cm_three', '198.51.100.33', null, devC); ok(C3.token && !C3.inC, 'the browser is recognised by its cookie alone (local storage cleared)');
  const C4 = await mkc('cm_four', '198.51.100.34', devD, devC); ok(C4.token && !C4.inC, '… even when the header carries a different id');
  r = await api('POST', `/invites/${(await api('POST', `/servers/${comm.id}/invites`, A.token, {})).body.code}/join`, C3.token, null, C3.h); ok(r.status === 403, '… and an invite does not let them in either');
  const C5 = await mkc('cm_five', '198.51.100.35', 'device-eeeeeeeeeeeeeeee'); ok(C5.inC, 'a new account from another browser and network still joins');
  r = await api('GET', `/servers/${comm.id}/bans`, A.token); ok(r.body.some((x) => x.id === C1.user.id) && !r.body.some((x) => x.id === C2.user.id), 'the new accounts were never members, so only the banned one is listed');
  r = await api('DELETE', `/servers/${comm.id}/bans/${C1.user.id}`, A.token); ok(r.status === 200, 'unban');
  const C6 = await mkc('cm_six', '198.51.100.36', devC); ok(C6.inC, 'after the unban the browser can join the community server again');
  const T1 = await mkc('cm_time1', '198.51.100.41', 'device-tttttttttttttttt');
  r = await api('PUT', `/servers/${comm.id}/members/${T1.user.id}/timeout`, A.token, { minutes: 5 }); ok(r.status === 200, 'time someone out in the community server');
  const T2 = await mkc('cm_time2', '198.51.100.42', null, 'device-tttttttttttttttt');
  const t2 = (await api('GET', '/ready', A.token)).body.servers.find((s) => s.id === comm.id).members.find((m) => m.id === T2.user.id);
  ok(T2.inC && t2?.timeoutUntil > Date.now(), 'a new account from that browser joins the community server already timed out');

  /* ---------------------------------------------------------------- swearing protection + the GIFs & stickers permission */
  console.log('\nSwearing protection');
  const W = await register('wordy'); await api('POST', `/invites/${code}/join`, W.token);
  const say = (tok, content) => api('POST', `/channels/${text.id}/messages`, tok, { content });
  r = await say(W.token, 'well, fuck'); ok(r.status === 200 && r.body.content === 'well, fuck', 'it is off by default: nothing is filtered');
  ok((await api('GET', '/ready', W.token)).body.servers.find((s) => s.id === S.id).safety.profanity === 'off', 'and members can see that it is off');
  r = await api('PATCH', `/servers/${S.id}`, W.token, { profanity: 'block' }); ok(r.status === 403, 'only people who manage the server can change it');
  r = await api('PATCH', `/servers/${S.id}`, A.token, { profanity: 'shout' }); ok(r.status === 400, 'unknown modes are refused');
  r = await api('PATCH', `/servers/${S.id}`, A.token, { profanity: 'censor' }); ok(r.status === 200 && r.body.safety.profanity === 'censor' && Array.isArray(r.body.safety.words), 'censor mode');
  r = await say(W.token, 'what the f.u.c.k is this sh1t'); ok(r.status === 200 && !/f\.u\.c\.k|sh1t/i.test(r.body.content) && r.body.content.includes('∗') && r.body.content.startsWith('what the f'), 'swear words are hidden (even with symbols and look-alike characters), the rest stays');
  r = await say(W.token, 'my class assignment is a Scunthorpe document'); ok(r.body.content === 'my class assignment is a Scunthorpe document', 'innocent words are never touched');
  r = await say(A.token, 'bullshit'); ok(r.body.content === 'bullshit', 'the owner is not filtered');
  const wm = (await say(W.token, 'clean text')).body; r = await api('PATCH', `/channels/${text.id}/messages/${wm.id}`, W.token, { content: 'now with damn in it' }); ok(r.status === 200 && !/damn/i.test(r.body.content), 'edits are filtered too');
  r = await api('PATCH', `/servers/${S.id}`, A.token, { profanity: 'block' });
  r = await say(W.token, 'you dumbass'); ok(r.status === 400 && r.body.code === 'profanity', 'block mode refuses the message');
  r = await api('PATCH', `/channels/${text.id}/messages/${wm.id}`, W.token, { content: 'shit edit' }); ok(r.status === 400, '… and the edit');
  r = await api('POST', `/channels/${text.id}/messages`, W.token, { poll: { question: 'is this fucking ok?', answers: [{ text: 'yes' }, { text: 'no' }] } }); ok(r.status === 400, '… and a poll question');
  const rulesForum = (await api('POST', `/servers/${S.id}/channels`, A.token, { name: 'swear-forum', type: 'forum' })).body;
  r = await api('POST', `/channels/${rulesForum.id}/posts`, W.token, { title: 'what the fuck', content: 'hello' }); ok(r.status === 400, '… and a forum post title');
  r = await api('PATCH', `/servers/${S.id}`, A.token, { blockedWords: 'Pineapple Pizza, Heck\n  x ,pineapple pizza', profanity: 'censor' });
  ok(JSON.stringify(r.body.safety.words) === JSON.stringify(['pineapple pizza', 'heck']), 'the server can add its own words');
  ok(!('words' in (await api('GET', '/ready', W.token)).body.servers.find((s) => s.id === S.id).safety), 'ordinary members do not get the list');
  r = await say(W.token, 'I love pineapple pizza, heck yes'); ok(r.body.content === `I love p${'∗'.repeat(14)}, h∗∗∗ yes`, 'custom words (even two-word ones) are filtered like the built-in ones');
  r = await api('PATCH', `/servers/${S.id}`, A.token, { profanity: 'off' }); r = await say(W.token, 'fuck pineapple pizza'); ok(r.body.content === 'fuck pineapple pizza', 'switching it off lets everything through again');

  console.log('\nSend GIFs & Stickers permission');
  const stkOnly = await api('POST', `/servers/${S.id}/stickers`, A.token, { name: 'Perm', description: 'x', url: (await upload(A.token, PNG)).url });
  const sendSticker = (tok) => api('POST', `/channels/${text.id}/messages`, tok, { sticker: { custom: { serverId: S.id, id: stkOnly.body.id } } });
  ok((await api('GET', '/ready', A.token)).body.servers.find((x) => x.id === S.id).roles.find((x) => x.id === S.id).permissions.includes('SEND_GIFS'), 'SEND_GIFS is part of the default permissions of a new server');
  r = await sendSticker(W.token); ok(r.status === 200, 'with the permission (the default) stickers can be sent');
  const everyoneRole = (await api('GET', '/ready', A.token)).body.servers.find((s) => s.id === S.id).roles.find((x) => x.id === S.id);
  r = await api('PATCH', `/servers/${S.id}/roles/${S.id}`, A.token, { permissions: everyoneRole.permissions.filter((p) => p !== 'SEND_GIFS') }); ok(r.status === 200, 'remove it from @everyone');
  r = await sendSticker(W.token); ok(r.status === 403 && r.body.code === 'no_gifs', 'now stickers (and GIFs) are refused');
  r = await say(W.token, 'but words are fine'); ok(r.status === 200, '… while ordinary messages still work');
  r = await sendSticker(A.token); ok(r.status === 200, 'the owner is unaffected');
  r = await api('POST', `/servers/${S.id}/roles`, A.token, { name: 'Memers', permissions: ['SEND_GIFS'] }); const memer = r.body;
  await api('PUT', `/servers/${S.id}/members/${W.user.id}/roles/${memer.id}`, A.token); r = await sendSticker(W.token); ok(r.status === 200, 'a role that grants it brings it back');
  await api('PATCH', `/servers/${S.id}/roles/${S.id}`, A.token, { permissions: everyoneRole.permissions });
  ok((await api('GET', '/ready', W.token)).body.servers.find((s) => s.id === S.id).perms.includes('SEND_GIFS'), 'members can see whether they have it (the picker buttons hide without it)');

  /* ---------------------------------------------------------------- GIF icons and banners */
  console.log('\nGIF server icon and banner');
  const gifUp = await upload(A.token, GIF, 'image/gif', 'icon.gif');
  r = await api('PATCH', `/servers/${S.id}`, A.token, { icon: gifUp.url, banner: gifUp.url }); ok(r.status === 200 && r.body.icon === gifUp.url && r.body.banner === gifUp.url, 'an uploaded GIF can be the icon and the banner');
  r = await api('PATCH', `/servers/${S.id}`, A.token, { icon: 'https://evil.example/x.gif' }); ok(r.status === 400, 'only uploads are accepted');

  /* ---------------------------------------------------------------- custom emoji + stickers */
  console.log('\nCustom emoji and stickers');
  const png = await upload(A.token, PNG); const big = await upload(A.token, Buffer.concat([PNG, Buffer.alloc(600 * 1024)])); const junk = await upload(A.token, Buffer.from('this is not a picture at all'), 'image/png', 'x.png');
  r = await api('POST', `/servers/${S.id}/emojis`, T.token, { name: 'party_parrot', url: png.url }); ok(r.status === 403, 'only people with Manage Expressions add emoji');
  r = await api('POST', `/servers/${S.id}/emojis`, A.token, { name: 'party_parrot', url: png.url }); const emo = r.body; ok(r.status === 200 && emo.id && emo.animated === false, 'the owner adds an emoji');
  r = await api('POST', `/servers/${S.id}/emojis`, A.token, { name: 'Party_Parrot', url: png.url }); ok(r.status === 400, 'names are unique (ignoring case)');
  r = await api('POST', `/servers/${S.id}/emojis`, A.token, { name: 'bad name', url: png.url }); ok(r.status === 400, 'names are letters, numbers and underscores');
  r = await api('POST', `/servers/${S.id}/emojis`, A.token, { name: 'toobig', url: big.url }); ok(r.status === 400 && /512/.test(r.body.error), 'pictures over 512 KB are refused');
  r = await api('POST', `/servers/${S.id}/emojis`, A.token, { name: 'notimg', url: junk.url }); ok(r.status === 400, 'so are files that are not pictures');
  r = await api('POST', `/servers/${S.id}/emojis`, A.token, { name: 'dance', url: gifUp.url }); ok(r.status === 200 && r.body.animated === true, 'a GIF becomes an animated emoji');
  r = await api('PATCH', `/servers/${S.id}/emojis/${emo.id}`, A.token, { name: 'parrot' }); ok(r.status === 200 && r.body.name === 'parrot', 'emoji can be renamed');
  const sv = (await api('GET', '/ready', T.token)).body.servers.find((s) => s.id === S.id); ok(sv.emojis.length === 2 && sv.emojis.some((e) => e.name === 'parrot'), 'every member receives the server’s emoji');
  r = await api('POST', `/channels/${text.id}/messages`, T.token, { content: `look <:parrot:${emo.id}> and <:nope:123456789012>` });
  ok(r.status === 200 && r.body.emojis?.length === 1 && r.body.emojis[0].url === emo.url, 'a message carries the pictures of the custom emoji it uses (unknown ones are ignored)');
  const other = await register('outsider'); r = await api('POST', `/servers/${(await api('POST', '/servers', other.token, { name: 'Elsewhere' })).body.id}/channels`, other.token, { name: 'x' });
  const oS = (await api('GET', '/ready', other.token)).body.servers.find((s) => s.name === 'Elsewhere'); const oText = oS.channels.find((c) => c.type === 'text');
  r = await api('POST', `/channels/${oText.id}/messages`, other.token, { content: `<:parrot:${emo.id}>` }); ok(r.status === 200 && !r.body.emojis, 'emoji only work for members of the server they belong to');
  const mid = (await api('POST', `/channels/${text.id}/messages`, T.token, { content: 'react to me' })).body.id;
  r = await api('PUT', `/channels/${text.id}/messages/${mid}/reactions/${encodeURIComponent(`<:parrot:${emo.id}>`)}/@me`, T.token); ok(r.status === 200, 'a custom emoji works as a reaction');
  r = await api('GET', `/channels/${text.id}/messages?limit=2`, T.token); const reacted = r.body.messages.find((x) => x.id === mid); ok(reacted.reactions[`<:parrot:${emo.id}>`]?.length === 1 && reacted.emojis?.[0]?.id === emo.id, '… and the message knows its picture');
  r = await api('PUT', `/channels/${oText.id}/messages/${(await api('POST', `/channels/${oText.id}/messages`, other.token, { content: 'hi' })).body.id}/reactions/${encodeURIComponent(`<:parrot:${emo.id}>`)}/@me`, other.token); ok(r.status === 400, 'but not for people outside the server');
  r = await api('POST', `/servers/${S.id}/stickers`, A.token, { name: 'Wave', description: 'hello there', url: png.url }); const stk = r.body; ok(r.status === 200 && stk.description === 'hello there', 'the owner adds a sticker');
  r = await api('POST', `/channels/${text.id}/messages`, T.token, { sticker: { custom: { serverId: S.id, id: stk.id } } }); ok(r.status === 200 && r.body.sticker?.url === stk.url && r.body.sticker.custom === true, 'members send the server’s stickers');
  r = await api('POST', `/channels/${oText.id}/messages`, other.token, { sticker: { custom: { serverId: S.id, id: stk.id } } }); ok(r.status === 400, 'people outside the server cannot');
  r = await api('POST', `/channels/${text.id}/messages`, T.token, { sticker: { custom: { serverId: S.id, id: 'nope' } } }); ok(r.status === 400, 'an unknown sticker is not sent');
  r = await api('DELETE', `/servers/${S.id}/emojis/${emo.id}`, A.token); ok(r.status === 200, 'delete the emoji');
  r = await api('GET', `/channels/${text.id}/messages?limit=10`, T.token); ok(r.body.messages.some((x) => x.emojis?.some((e) => e.id === emo.id)), 'messages that used it keep their picture');

  /* ---------------------------------------------------------------- forum channels */
  console.log('\nForum channels');
  const wa = await connect(A.token); const wt = await connect(T.token);
  r = await api('POST', `/servers/${S.id}/channels`, A.token, { name: 'Help Desk', type: 'forum', tags: [{ name: 'Help' }, { name: 'Showcase', emoji: '✨' }, { name: '  ' }] });
  const forum = r.body; ok(r.status === 200 && forum.type === 'forum' && forum.name === 'help-desk' && forum.tags.length === 2 && forum.tags[1].emoji === '✨' && forum.tags.every((t) => t.id), 'create a forum with tags');
  const [tagHelp, tagShow] = forum.tags;
  r = await api('POST', `/channels/${forum.id}/messages`, T.token, { content: 'hello' }); ok(r.status === 400, 'a forum has no messages of its own');
  r = await api('POST', `/channels/${forum.id}/posts`, T.token, { title: 'My cat won’t eat', content: 'Any ideas? **please**', tags: [tagHelp.id, 'bogus'] });
  const post = r.body.post; ok(r.status === 200 && post.type === 'post' && post.forumId === forum.id && post.name === 'My cat won’t eat' && post.tagIds.join() === tagHelp.id && r.body.message.content.includes('please'), 'anyone who can talk starts a post (unknown tags are dropped)');
  ok(!!(await wa.wait('post_create', (d) => d.post.id === post.id).catch(() => null)), 'the forum’s members hear about it live');
  const sv2 = (await api('GET', '/ready', T.token)).body.servers.find((s) => s.id === S.id); ok(!sv2.channels.some((c) => c.type === 'post') && sv2.channels.some((c) => c.id === forum.id), 'posts stay out of the channel list');
  r = await api('POST', `/channels/${forum.id}/posts`, T.token, { title: '', content: 'x' }); ok(r.status === 400, 'a post needs a title');
  r = await api('POST', `/channels/${forum.id}/posts`, T.token, { title: 'Empty' }); ok(r.status === 400, '… and something to say');
  r = await api('POST', `/channels/${post.id}/messages`, A.token, { content: 'try a different food' }); ok(r.status === 200, 'people reply inside the post');
  ok(!!(await wt.wait('message_create', (d) => d.message.channelId === post.id).catch(() => null)), 'replies arrive live');
  const upd = await wa.wait('post_update', (d) => d.post.id === post.id && d.post.messageCount >= 1).catch(() => null); ok(!!upd && upd.post.lastActivity >= post.createdAt, 'the list’s reply count and last activity update live');
  r = await api('GET', `/channels/${forum.id}/posts`, A.token); ok(r.status === 200 && r.body.posts.length === 1 && r.body.posts[0].messageCount === 1 && r.body.posts[0].preview.includes('please') && r.body.total === 1, 'the forum lists its posts');
  r = await api('POST', `/channels/${forum.id}/posts`, A.token, { title: 'Look at my build', content: 'proud', tags: [tagShow.id] }); const post2 = r.body.post;
  r = await api('GET', `/channels/${forum.id}/posts?tag=${tagShow.id}`, A.token); ok(r.body.posts.length === 1 && r.body.posts[0].id === post2.id, 'filter by tag');
  r = await api('GET', `/channels/${forum.id}/posts?q=cat`, A.token); ok(r.body.posts.length === 1 && r.body.posts[0].id === post.id, 'search by words');
  r = await api('GET', `/channels/${forum.id}/posts?sort=new`, A.token); ok(r.body.posts[0].id === post2.id, 'newest first');
  r = await api('GET', `/channels/${forum.id}/posts?sort=recent`, A.token); ok(r.body.posts[0].id === post2.id || r.body.posts[0].id === post.id, 'recent activity');
  r = await api('PATCH', `/channels/${post2.id}`, T.token, { pinned: true }); ok(r.status === 403, 'only moderators pin');
  r = await api('PATCH', `/channels/${post.id}`, A.token, { pinned: true }); ok(r.status === 200, 'a moderator pins');
  r = await api('GET', `/channels/${forum.id}/posts?sort=new`, A.token); ok(r.body.posts[0].id === post.id && r.body.posts[0].pinned, 'pinned posts come first');
  r = await api('PATCH', `/channels/${post.id}`, T.token, { name: 'My cat won’t eat (solved)', locked: true }); ok(r.status === 200 && r.body.locked === true && r.body.name.endsWith('(solved)'), 'the owner renames and locks their post');
  const C = await register('carlos'); await api('POST', `/invites/${code}/join`, C.token);
  r = await api('POST', `/channels/${post.id}/messages`, C.token, { content: 'late reply' }); ok(r.status === 403, 'nobody else can reply to a locked post');
  r = await api('POST', `/channels/${post.id}/messages`, T.token, { content: 'thanks all' }); ok(r.status === 200, '… but its owner can');
  r = await api('PATCH', `/channels/${post.id}`, C.token, { locked: false }); ok(r.status === 403, 'strangers cannot unlock it');
  r = await api('PATCH', `/channels/${post.id}`, A.token, { locked: false }); ok(r.status === 200, 'a moderator can');
  r = await api('GET', `/channels/${post.id}`, C.token); ok(r.status === 200 && r.body.type === 'post' && r.body.forumId === forum.id, 'a link to a post resolves it');
  r = await api('PATCH', `/channels/${forum.id}`, A.token, { requireTag: true }); ok(r.status === 200 && r.body.requireTag === true, 'a forum can require a tag');
  r = await api('POST', `/channels/${forum.id}/posts`, T.token, { title: 'No tag', content: 'x' }); ok(r.status === 400 && r.body.code === 'tags', '… then a post without one is refused');
  r = await api('PATCH', `/channels/${forum.id}`, A.token, { requireTag: false, tags: [tagHelp] }); ok(r.body.tags.length === 1, 'tags can be edited');
  r = await api('POST', `/channels/${post.id}/messages`, A.token, { content: 'x'.repeat(10) }); const mm = r.body;
  r = await api('DELETE', `/channels/${post.id}`, C.token); ok(r.status === 403, 'strangers cannot delete a post');
  // posts follow the forum's permissions
  r = await api('PATCH', `/channels/${forum.id}`, A.token, { overwrites: [{ type: 'role', id: S.id, allow: [], deny: ['VIEW_CHANNEL'] }, { type: 'member', id: T.user.id, allow: ['VIEW_CHANNEL'], deny: [] }], synced: false });
  ok(r.status === 200, 'make the forum private');
  r = await api('GET', `/channels/${post.id}/messages`, C.token); ok(r.status === 404, 'its posts are private too');
  r = await api('GET', `/channels/${forum.id}/posts`, C.token); ok(r.status === 404, '… and so is the list');
  r = await api('GET', `/channels/${post.id}/messages`, T.token); ok(r.status === 200, 'but someone allowed in can read them');
  ok(!(await wa.wait('post_create', (d) => d.post.id === 'never', 300).catch(() => null)), '(sanity)');
  r = await api('PATCH', `/channels/${forum.id}`, A.token, { overwrites: [], synced: false });
  r = await api('DELETE', `/channels/${post.id}`, T.token); ok(r.status === 200, 'the owner deletes their post');
  ok(!!(await wa.wait('post_delete', (d) => d.postId === post.id).catch(() => null)), 'everyone hears the post is gone');
  r = await api('GET', `/channels/${post.id}/messages`, A.token); ok(r.status === 404, 'its messages are gone');
  r = await api('DELETE', `/channels/${forum.id}`, A.token); ok(r.status === 200, 'deleting a forum…');
  r = await api('GET', `/channels/${post2.id}`, A.token); ok(r.status === 404, '… deletes its posts');
  void mm; wa.ws.close(); wt.ws.close();

  /* ---------------------------------------------------------------- polls */
  console.log('\nPolls');
  const wp = await connect(T.token);
  r = await api('POST', `/channels/${text.id}/messages`, A.token, { poll: { question: 'Pizza tonight?', answers: [{ text: 'Yes' }, { text: 'No' }, { text: 'Maybe' }], hours: 1 } });
  const pm = r.body; ok(r.status === 200 && pm.poll.answers.length === 3 && pm.poll.total === 0 && pm.poll.closed === false && pm.poll.multi === false && pm.poll.expiresAt > Date.now(), 'post a poll (no text needed)');
  r = await api('POST', `/channels/${text.id}/messages`, A.token, { poll: { question: 'x', answers: [{ text: 'only one' }] } }); ok(r.status === 400, 'a poll needs two answers');
  r = await api('POST', `/channels/${text.id}/messages`, A.token, { poll: { question: 'x', answers: Array.from({ length: 11 }, (_, i) => ({ text: 'a' + i })) } }); ok(r.status === 400, '… and at most ten');
  r = await api('POST', `/channels/${text.id}/messages`, A.token, { poll: { question: '  ', answers: [{ text: 'a' }, { text: 'b' }] } }); ok(r.status === 400, '… and a question');
  const vote = (tok, answers) => api('PUT', `/channels/${text.id}/messages/${pm.id}/poll/votes`, tok, { answers });
  r = await vote(T.token, ['1']); ok(r.status === 200, 'vote');
  const up2 = await wp.wait('message_update', (d) => d.message.id === pm.id && d.message.poll.total === 1).catch(() => null);
  ok(!!up2 && up2.message.poll.answers[0].voters.join() === T.user.id, 'everybody sees the vote live (and who cast it)');
  r = await vote(T.token, ['2', '3']); const pv = (await api('GET', `/channels/${text.id}/messages?limit=5`, A.token)).body.messages.find((x) => x.id === pm.id).poll;
  ok(r.status === 200 && pv.answers[0].voters.length === 0 && pv.answers[1].voters.length === 1 && pv.answers[2].voters.length === 0 && pv.total === 1, 'a single-choice poll keeps one vote and moves it');
  r = await vote(A.token, ['1']); r = await vote(T.token, []); const pv2 = (await api('GET', `/channels/${text.id}/messages?limit=5`, A.token)).body.messages.find((x) => x.id === pm.id).poll; ok(pv2.total === 1 && pv2.answers[0].voters.length === 1 && pv2.answers[1].voters.length === 0, 'a vote can be taken back');
  r = await api('POST', `/channels/${text.id}/messages`, A.token, { poll: { question: 'Toppings?', answers: [{ text: 'Cheese' }, { text: 'Olives' }, { text: 'Pineapple' }], multi: true, hours: 4 } }); const multi = r.body;
  r = await api('PUT', `/channels/${text.id}/messages/${multi.id}/poll/votes`, T.token, { answers: ['1', '3', 'bogus'] });
  const mv = (await api('GET', `/channels/${text.id}/messages?limit=5`, A.token)).body.messages.find((x) => x.id === multi.id).poll; ok(r.status === 200 && mv.multi && mv.answers[0].voters.length === 1 && mv.answers[2].voters.length === 1 && mv.total === 1, 'a multiple-choice poll keeps several (and ignores unknown answers)');
  r = await api('POST', `/channels/${text.id}/messages/${pm.id}/poll/close`, T.token); ok(r.status === 403, 'only the author or a moderator ends a poll');
  r = await api('POST', `/channels/${text.id}/messages/${pm.id}/poll/close`, A.token); ok(r.status === 200, 'the author ends it');
  r = await vote(T.token, ['2']); ok(r.status === 400 && r.body.code === 'poll_closed', 'nobody can vote after that');
  r = await api('PATCH', `/channels/${text.id}/messages/${pm.id}`, A.token, { content: 'changed' }); ok(r.status === 403, 'a poll cannot be edited');
  wp.ws.close();
  await stopServer();
  const dbf = path.join(data, 'db.json'); const dj = JSON.parse(fs.readFileSync(dbf, 'utf8'));
  for (const list of Object.values(dj.messages)) for (const m of list) if (m.id === multi.id) m.poll.expiresAt = Date.now() - 1000;
  fs.writeFileSync(dbf, JSON.stringify(dj)); startServer(); await ready();
  r = await api('PUT', `/channels/${text.id}/messages/${multi.id}/poll/votes`, T.token, { answers: ['2'] }); ok(r.status === 400, 'a poll whose time ran out takes no more votes');
  ok((await api('GET', `/channels/${text.id}/messages?limit=10`, A.token)).body.messages.find((x) => x.id === multi.id).poll.closed === true, '… and shows as closed');

  /* ---------------------------------------------------------------- shared themes (/theme) */
  console.log('\nShared themes');
  const look = { theme: { mode: 'dark', accent: '#112233', panelOpacity: 0.5 }, bg: { type: 'mesh', mesh: 'aurora', library: ['/uploads/x.png'], gradient: { c1: '#000000', c2: '#ffffff', angle: 10 } }, motion: { reduce: true, speed: 1 }, evil: { x: 1 } };
  r = await api('POST', `/channels/${text.id}/messages`, A.token, { theme: { name: 'Night owl\nmode', data: look } });
  const tm = r.body; ok(r.status === 200 && tm.theme.name === 'Night owl mode' && tm.theme.data.theme.accent === '#112233' && tm.theme.data.bg.gradient.angle === 10, 'a theme is posted as a message (no text needed)');
  ok(!tm.theme.data.bg.library && !tm.theme.data.motion.reduce && tm.theme.data.motion.speed === 1 && !tm.theme.data.evil, 'saved wallpapers, the reduced-motion choice and unknown sections are never shared');
  r = await api('GET', `/channels/${text.id}/messages?limit=5`, T.token); ok(r.body.messages.some((x) => x.id === tm.id && x.theme?.data?.bg?.mesh === 'aurora'), 'everyone in the channel receives it');
  r = await api('POST', `/channels/${text.id}/messages`, A.token, { theme: { data: { theme: { accent: 'red;} body{display:none', mode: 'light' }, fonts: { ui: 'a"b' } } } });
  ok(r.status === 200 && r.body.theme.data.theme.mode === 'light' && !('accent' in r.body.theme.data.theme) && !r.body.theme.data.fonts && r.body.theme.name === null, 'strings that could break out of a CSS value are dropped');
  r = await api('POST', `/channels/${text.id}/messages`, A.token, { theme: { data: {} } }); ok(r.status === 400, 'an empty theme is refused');
  r = await api('POST', `/channels/${text.id}/messages`, A.token, { theme: 'dark' }); ok(r.status === 400, '… and so is anything that is not a theme');
  r = await api('POST', `/channels/${text.id}/messages`, A.token, { theme: { data: { bg: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, 'x'.repeat(280)])) } } }); ok(r.status === 400, 'an oversized theme is refused');
  r = await api('PATCH', `/channels/${text.id}/messages/${tm.id}`, A.token, { content: 'changed' }); ok(r.status === 403, 'a shared theme cannot be edited');

  /* ---------------------------------------------------------------- default avatar gradients */
  console.log('\nDefault avatar');
  const bgs = [A.user.avatarBg, E.user.avatarBg, M.user.avatarBg];
  ok(bgs.every((b) => /^#[0-9a-f]{6}$/.test(b?.a) && /^#[0-9a-f]{6}$/.test(b?.b) && b.angle >= 0 && b.angle < 360) && new Set(bgs.map((b) => b.a + b.b)).size === 3, 'every new account gets its own random gradient behind the default avatar');
  const before = (await api('GET', '/me', A.token)).body.avatarBg; r = await api('PATCH', '/me', A.token, { avatarBg: 'random' });
  ok(r.status === 200 && r.body.avatarBg && JSON.stringify(r.body.avatarBg) !== JSON.stringify(before), 'Shuffle picks a new one');
  r = await api('PATCH', '/me', A.token, { avatarBg: { a: '#ff0000' } }); ok(r.status === 200 && JSON.stringify(r.body.avatarBg) !== JSON.stringify({ a: '#ff0000' }), 'it cannot be set to anything but a fresh random one');
  ok((await api('GET', '/ready', T.token)).body.users.find((x) => x.id === A.user.id)?.avatarBg?.a === (await api('GET', '/me', A.token)).body.avatarBg.a, 'everyone sees the same gradient');

  /* ---------------------------------------------------------------- profile styling + GIF banners */
  console.log('\nProfile styling');
  r = await api('PATCH', '/me', A.token, { banner: gifUp.url }); ok(r.status === 200 && r.body.banner === gifUp.url, 'a GIF can be your profile banner');
  const style = { colors: { mode: 'gradient', a: '#FF0000', b: '#0000ff', angle: 999, tint: 5 }, outline: { color: '#00ff00', color2: '#ffff00', width: 99, style: 'wavy' }, shadow: { color: '#112233', blur: 500, x: 3 },
    fonts: { name: 'pacifico', text: 'not-a-font' }, nameColor: { mode: 'gradient', a: '#FDE047', b: '#22c55e', angle: 720 }, nameOutline: { mode: 'solid', a: '#14532d', width: 99 }, nameShadow: { color: '#14532d', angle: 135, distance: 400, blur: 2 },
    effect: { id: 'rays', color: '#ffffff', density: 9 }, frame: { id: 'neon', color: '#123456' }, avatarFrame: { id: 'spin', color: '#aa00aa' }, nameStyle: { color: '#abcdef' }, evil: { x: 1 } };
  r = await api('PATCH', '/me', A.token, { profile: style }); const ps = r.body.profile;
  ok(r.status === 200 && ps.colors.a === '#ff0000' && ps.colors.angle === 360 && ps.colors.tint === 1 && ps.outline.width === 8 && ps.outline.style === 'solid' && ps.outline.color2 === '#ffff00' && ps.shadow.blur === 80, 'colours, outline and shadow are saved (numbers clamped, unknown styles replaced)');
  ok(ps.fonts.name === 'pacifico' && ps.fonts.text === null && ps.nameColor.mode === 'gradient' && ps.nameColor.a === '#fde047' && ps.nameColor.angle === 360 && ps.nameOutline.width === 6 && ps.nameOutline.b === '#14532d' && ps.nameShadow.distance === 24 && ps.nameShadow.angle === 135, 'the name font, a gradient name color, its outline and an angled shadow are saved (clamped)');
  ok(ps.effect.id === 'rays' && ps.effect.density === 1 && !('frame' in ps) && !('avatarFrame' in ps) && !('nameStyle' in ps) && !('evil' in ps), 'effects are saved; frames, the old name style and unknown parts are dropped');
  r = await api('GET', `/users/${A.user.id}`, T.token); ok(r.status === 200 && r.body.user.profile?.nameShadow?.color === '#14532d', 'other people see it on your profile');
  r = await api('GET', '/ready', T.token); ok(r.body.users.find((x) => x.id === A.user.id)?.profile?.effect?.id === 'rays', '… and on you everywhere you appear');
  const rbStyle = { colors: { mode: 'solid', a: '#ff0000', rainbow: true }, outline: { color: '#00ff00', rainbow: true }, shadow: { color: '#112233', rainbow: true }, nameColor: { mode: 'solid', a: '#fde047', rainbow: true }, nameOutline: { mode: 'solid', a: '#14532d', rainbow: 'yes' }, nameShadow: { color: '#14532d', rainbow: true }, effect: { id: 'rays', color: '#ffffff', rainbow: true } };
  r = await api('PATCH', '/me', A.token, { profile: rbStyle }); const rb = r.body.profile;
  ok(r.status === 200 && rb.colors.rainbow && rb.outline.rainbow && rb.shadow.rainbow && rb.nameColor.rainbow && rb.nameShadow.rainbow && rb.effect.rainbow, 'every colored part (card colors, outline, shadow, name color, name shadow, effect) can be rainbow');
  ok(!('rainbow' in rb.nameOutline), '… and only a real true counts');
  r = await api('PATCH', '/me', A.token, { profile: { colors: { mode: 'solid', a: '#ff0000' } } }); ok(r.status === 200 && !('rainbow' in r.body.profile.colors), 'rainbow is off unless asked for');
  r = await api('PATCH', '/me', A.token, { bannerColor: '#ff0000', accentColor: '#0000ff' }); ok(r.status === 200 && r.body.bannerColor === '#ff0000' && r.body.accentColor === '#0000ff', 'the banner has two gradient colors');
  r = await api('GET', `/users/${A.user.id}`, T.token); ok(r.body.user.bannerColor === '#ff0000' && r.body.user.accentColor === '#0000ff', '… that everyone sees');
  r = await api('PATCH', '/me', A.token, { accentColor: null }); ok(r.status === 200 && r.body.accentColor === null, 'the second banner color can be reset');
  const cardUp = await upload(A.token, PNG, 'image/png', 'card.png');
  r = await api('PATCH', '/me', A.token, { profile: { colors: { mode: 'image', a: '#8b5cf6', image: cardUp.url, imageOpacity: 7 } } });
  ok(r.status === 200 && r.body.profile.colors.mode === 'image' && r.body.profile.colors.image === cardUp.url && r.body.profile.colors.imageOpacity === 1, 'the card colors can be a picture of yours, at an opacity (clamped)');
  r = await api('PATCH', '/me', A.token, { profile: { colors: { mode: 'image', a: '#8b5cf6', image: 'https://example.com/pixel.png' } } });
  ok(r.status === 200 && r.body.profile.colors.mode === 'gradient' && !('image' in r.body.profile.colors), 'a picture from anywhere else is refused (it could be used to watch who opens a profile)');
  r = await api('PATCH', '/me', A.token, { profile: { colors: { mode: 'image', a: '#8b5cf6', image: '/uploads/../../etc/passwd' } } });
  ok(r.status === 200 && !('image' in r.body.profile.colors), '… and so is a path that is not a plain upload');
  r = await api('PATCH', '/me', A.token, { profile: { colors: { mode: 'image', a: '#8b5cf6' } } });
  ok(r.status === 200 && r.body.profile.colors.mode === 'gradient', 'picture mode without a picture falls back to a gradient');
  r = await api('PATCH', '/me', A.token, { profile: { effect: { id: 'lasers' }, avatarFrame: { id: 'ring' } } }); ok(r.status === 200 && r.body.profile === null, 'nothing valid left means no style');
  for (const [id] of EFFECTS) { r = await api('PATCH', '/me', A.token, { profile: { effect: { id, color: '#336699' } } }); if (r.status !== 200 || r.body.profile?.effect?.id !== id) { ok(false, `effect ${id} is accepted`); break; } }
  ok(EFFECTS.length >= 40, `${EFFECTS.length} effects to choose from, and every one is accepted`);
  const rec = new Proxy(function () {}, { get: (t, k) => (k === 'canvas' ? { width: 300, height: 200 } : rec), apply: () => rec, set: () => true });   // a canvas context that records nothing
  let engineError = null;
  for (const [id] of EFFECTS) { const eng = ENGINES[id]; try { const parts = Array.from({ length: eng.count }, () => eng.make(300, 200, Math.random, true)); for (let k = 0; k < 40; k++) { for (const p of parts) eng.update(p, 0.033, 300, 200, Math.random, k * 0.033); if (eng.drawAll) eng.drawAll(rec, parts, '#336699', null, k * 0.033, 300, 200); else for (const p of parts) eng.draw(rec, p, '#336699', '#cc6699', k * 0.033, 300, 200); } } catch (e) { engineError = `${id}: ${e.message}`; break; } }
  ok(!engineError, 'every effect engine runs without errors', engineError);
  r = await api('PATCH', '/me', A.token, { profile: style }); r = await api('PATCH', '/me', A.token, { profile: null }); ok(r.status === 200 && r.body.profile === null, 'a style can be removed');
  r = await api('PATCH', '/me', A.token, { profile: 'pink' }); ok(r.status === 400, 'a style that is not an object is refused');
  r = await api('PATCH', '/me', A.token, { profile: { fonts: { name: 'pacifico' }, junk: 'x'.repeat(5000) } }); ok(r.status === 400, 'and so is an oversized one');

  /* ---------------------------------------------------------------- badges and co-owners */
  console.log('\nBadges and co-owners');
  ok(EFFECTS.some(([id]) => id === 'sakura'), 'there is a Sakura effect');
  const DV = await register('devy', { ip: '192.0.2.201' }); const PL = await register('plainy', { ip: '192.0.2.202' });
  const CO = await register('cowner', { ip: '192.0.2.203' }); const MB = await register('membo', { ip: '192.0.2.204' });
  r = await api('POST', '/servers', A.token, { name: 'Co Guild' }); const CG = r.body;
  const cgCode = (await api('POST', `/servers/${CG.id}/invites`, A.token, {})).body.code;
  for (const x of [CO, MB, PL]) await api('POST', `/invites/${cgCode}/join`, x.token);
  r = await api('GET', '/badges', PL.token); ok(r.status === 200 && r.body.some((b) => b.id === 'dev' && b.builtin), 'the built-in badges are listed');
  r = await api('PUT', `/users/${PL.user.id}/badges`, PL.token, { badges: ['dev'] }); ok(r.status === 403, 'someone who is not a developer can’t give badges (not even to themselves)');
  r = await api('POST', '/badges', PL.token, { name: 'Mine', icon: 'star', color: '#ff0000' }); ok(r.status === 403, '… or make one');
  r = await api('PATCH', '/me', PL.token, { badges: ['dev'] }); ok(r.status === 200 && !r.body.badges.length, '… and badges are not part of your own profile settings');
  await stopServer();
  const bj = JSON.parse(fs.readFileSync(path.join(data, 'db.json'), 'utf8'));
  bj.users[DV.user.id].badges = ['dev']; bj.servers[CG.id].coOwners = [CO.user.id];
  fs.writeFileSync(path.join(data, 'db.json'), JSON.stringify(bj)); startServer(); await ready();
  r = await api('POST', '/badges', DV.token, { name: 'Sakura Fan', emoji: '🌸', color: '#FFB7C5' }); const fan = r.body;
  ok(r.status === 200 && fan.emoji === '🌸' && fan.color === '#ffb7c5' && !fan.builtin, 'a developer makes a custom badge');
  r = await api('POST', '/badges', DV.token, { name: 'x', icon: '<script>', color: '#ffffff' }); ok(r.status === 400, 'a badge needs a real icon name or an emoji');
  r = await api('PUT', `/users/${PL.user.id}/badges`, DV.token, { badges: [fan.id, 'early', 'nope'] }); ok(r.status === 200 && r.body.badges.map((b) => b.id).join() === `${fan.id},early`, 'a developer gives someone badges (unknown ones are dropped)');
  r = await api('GET', `/users/${PL.user.id}`, MB.token); ok(r.body.user.badges.some((b) => b.name === 'Sakura Fan'), '… and everyone sees them on the profile');
  r = await api('PUT', `/users/${DV.user.id}/badges`, DV.token, { badges: [] }); ok(r.status === 400, 'a developer can’t take the developer badge from themselves');
  r = await api('DELETE', '/badges/dev', DV.token); ok(r.status === 400, 'built-in badges can’t be deleted');
  r = await api('DELETE', `/badges/${fan.id}`, DV.token); ok(r.status === 200, 'a custom badge can be deleted');
  r = await api('GET', `/users/${PL.user.id}`, MB.token); ok(r.body.user.badges.map((b) => b.id).join() === 'early', '… and is gone from everyone who had it');
  const coView = (await api('GET', '/ready', CO.token)).body.servers.find((s) => s.id === CG.id);
  ok(coView.coOwners.includes(CO.user.id) && coView.perms.includes('ADMINISTRATOR'), 'a co-owner has every permission (and the crown)');
  r = await api('DELETE', `/servers/${CG.id}/members/${MB.user.id}`, CO.token); ok(r.status === 200, '… can kick a member');
  r = await api('DELETE', `/servers/${CG.id}/members/${CO.user.id}`, A.token); ok(r.status === 403, '… can’t be kicked, not even by the owner');
  r = await api('PUT', `/servers/${CG.id}/members/${CO.user.id}/timeout`, A.token, { minutes: 5 }); ok(r.status === 403, '… or timed out');
  r = await api('DELETE', `/servers/${CG.id}`, CO.token); ok(r.status === 403, 'deleting the server stays the owner’s');
  r = await api('POST', `/servers/${CG.id}/transfer`, CO.token, { userId: CO.user.id }); ok(r.status === 403, '… and so does transferring it');

  /* ---------------------------------------------------------------- audio messages */
  console.log('\nAudio messages');
  const ach = (await api('GET', '/ready', A.token)).body.servers.find((s) => s.id === CG.id).channels.find((c) => c.type === 'text');
  const aud = async () => (await upload(A.token, Buffer.from('not-really-opus-' + Math.random()), 'audio/webm', 'audio-message.webm')).url;
  const AU1 = await aud(); const AU2 = await aud();
  r = await api('POST', `/channels/${ach.id}/messages`, A.token, { attachments: [{ url: AU1, name: 'audio-message.webm', type: 'audio/webm', voice: true, duration: 42.3 }] }); const VM1 = r.body;
  ok(r.status === 200 && VM1.attachments[0].voice === true && VM1.attachments[0].duration === 42.3 && VM1.expiresAt - VM1.createdAt === 86400_000, 'an audio message keeps its length and is set to delete itself after a day');
  r = await api('POST', `/channels/${ach.id}/messages`, A.token, { content: 'too long', attachments: [{ url: await aud(), type: 'audio/webm', voice: true, duration: 181.6 }] });
  ok(r.status === 200 && !r.body.attachments.length && !r.body.expiresAt, 'audio longer than 3 minutes is not accepted as an audio message');
  r = await api('POST', `/channels/${ach.id}/messages`, A.token, { content: 'listen to this', attachments: [{ url: AU2, type: 'audio/mpeg', voice: true, duration: 9 }] }); const VM2 = r.body;

  /* ---------------------------------------------------------------- Orbit in a server */
  console.log('\nOrbit in a server');
  r = await api('POST', '/servers', A.token, { name: 'Bot Guild', orbit: true }); const BG = r.body;
  ok(BG.orbitId && BG.members.some((m) => m.id === BG.orbitId), 'a server made with “Add Orbit” ticked has its own Orbit');
  const bgText = BG.channels.find((c) => c.type === 'text');
  const bgCode = (await api('POST', `/servers/${BG.id}/invites`, A.token, {})).body.code;
  for (const x of [PL, CO]) await api('POST', `/invites/${bgCode}/join`, x.token);
  const cmd = (tok, name, args = '') => api('POST', `/channels/${bgText.id}/command`, tok, { name, args });
  const bgMsgs = async () => (await api('GET', `/channels/${bgText.id}/messages?limit=20`, A.token)).body.messages;
  r = await cmd(PL.token, 'ping'); ok(r.status === 200 && /Pong/.test(r.body.ephemeral) && !(await bgMsgs()).some((m) => /Pong/.test(m.content)), '/ping answers only the person who asked');
  r = await cmd(PL.token, 'help'); ok(r.body.ephemeral.includes('/roll') && !r.body.ephemeral.includes('/kick'), '/help lists only the commands you can use');
  r = await cmd(A.token, 'help'); ok(r.body.ephemeral.includes('/kick') && r.body.ephemeral.includes('/settings'), '… and moderators see theirs');
  r = await cmd(PL.token, 'roll', '2d6'); ok(r.status === 200 && (await bgMsgs()).some((m) => m.authorId === BG.orbitId && m.content.includes('🎲')), 'fun commands answer in the channel, for everyone');
  r = await cmd(PL.token, 'say', 'hello'); ok(r.status === 403, 'a member can’t make Orbit /say things');
  r = await cmd(A.token, 'say', 'Welcome everyone'); ok(r.status === 200 && (await bgMsgs()).some((m) => m.authorId === BG.orbitId && m.content === 'Welcome everyone'), '… a moderator can');
  r = await cmd(PL.token, 'kick', `<@${CO.user.id}>`); ok(r.status === 403, 'a member without Kick Members can’t /kick');
  r = await cmd(A.token, 'timeout', `<@${CO.user.id}>`); ok(r.status === 400, '/timeout needs a duration');
  r = await cmd(A.token, 'timeout', `${CO.user.id} 10m being loud`);
  const coIn = async () => (await api('GET', '/ready', A.token)).body.servers.find((s) => s.id === BG.id).members.find((m) => m.id === CO.user.id);
  ok(r.status === 200 && (await coIn()).timeoutUntil > Date.now() + 9 * 60_000, '/timeout works with an ID and a duration');
  r = await cmd(A.token, 'kick', '@cowner spamming'); ok(r.status === 200 && !(await coIn()), '/kick works with an @username');
  await api('POST', `/invites/${bgCode}/join`, CO.token);
  r = await cmd(A.token, 'ban', `<@${CO.user.id}> rude`); ok(r.status === 200 && (await api('GET', `/servers/${BG.id}/bans`, A.token)).body.some((x) => x.id === CO.user.id), '/ban works with an @mention');
  const gamer = (await api('POST', `/servers/${BG.id}/roles`, A.token, { name: 'Gamer' })).body;
  r = await api('PATCH', `/servers/${BG.id}/orbit`, PL.token, { displayName: 'Hacked' }); ok(r.status === 403, 'only people with Manage Server can change Orbit’s settings');
  r = await api('PATCH', `/servers/${BG.id}/orbit`, A.token, { displayName: 'Helper', bio: 'At your service', roles: { roll: [gamer.id, 'nope'] } });
  ok(r.status === 200 && r.body.user.displayName === 'Helper' && r.body.roles.roll.join() === gamer.id, '/settings renames this server’s Orbit and narrows a command to a role');
  r = await cmd(PL.token, 'roll'); ok(r.status === 403, '… so a member without that role can’t use it');
  await api('PUT', `/servers/${BG.id}/members/${PL.user.id}/roles/${gamer.id}`, A.token); r = await cmd(PL.token, 'roll'); ok(r.status === 200, '… and one with it can');
  const dmOrbit = (await api('GET', '/ready', A.token)).body.botId;
  ok((await api('GET', `/users/${dmOrbit}`, A.token)).body.user.displayName === 'Orbit', 'everyone’s DM Orbit keeps its name');
  r = await cmd(PL.token, 'remind', 'soon stretch'); ok(r.status === 400, '/remind needs a time');
  r = await cmd(PL.token, 'remind', '5m stretch your legs'); ok(r.status === 200 && /5 minutes/.test(r.body.ephemeral), '/remind confirms only to you');
  r = await api('POST', `/channels/${ach.id}/command`, A.token, { name: 'ping' }); ok(r.status === 400, 'a server without Orbit has no commands');

  // a day later: the audio is gone (and its file), and the reminder is due
  await stopServer();
  const xj = JSON.parse(fs.readFileSync(path.join(data, 'db.json'), 'utf8'));
  for (const m of xj.messages[ach.id]) if (m.expiresAt) m.expiresAt = Date.now() - 1000;
  for (const x of xj.reminders) x.at = Date.now() - 1000;
  fs.writeFileSync(path.join(data, 'db.json'), JSON.stringify(xj)); startServer(); await ready(); await sleep(2800);
  const left = (await api('GET', `/channels/${ach.id}/messages?limit=20`, A.token)).body.messages;
  ok(!left.some((m) => m.id === VM1.id), 'an audio message deletes itself after a day');
  ok(left.find((m) => m.id === VM2.id)?.content === 'listen to this' && !left.find((m) => m.id === VM2.id).attachments.length, '… and one with text keeps the text');
  ok((await fetch(base + AU1)).status === 404, '… and the audio file is deleted too');
  ok((await bgMsgs()).some((m) => m.authorId === BG.orbitId && m.content.includes('stretch your legs') && m.mentions.includes(PL.user.id)), 'Orbit pings the person in the channel when a reminder is due');

  /* ---------------------------------------------------------------- forwarding */
  console.log('\nForwarding');
  const src = (await api('POST', `/channels/${bgText.id}/messages`, PL.token, { content: 'look at this' })).body;
  r = await api('POST', `/channels/${ach.id}/messages`, A.token, { content: 'fyi', forward: { channelId: bgText.id, messageId: src.id } }); const FW = r.body;
  ok(r.status === 200 && FW.content === 'fyi' && FW.forward?.content === 'look at this' && FW.forward.from.includes('Bot Guild') && FW.forward.authorName === 'Plainy', 'a message can be forwarded to another channel, with a note');
  r = await api('POST', `/channels/${bgText.id}/messages`, PL.token, { forward: { channelId: ach.id, messageId: FW.id } });
  ok(r.status === 200 && r.body.forward.content === 'look at this' && r.body.forward.from.includes('Bot Guild'), 'forwarding a forwarded message passes on the original');
  r = await api('POST', `/channels/${ach.id}/messages`, CO.token, { forward: { channelId: bgText.id, messageId: src.id } }); ok(r.status === 404, 'a message from a channel you can’t see can’t be forwarded');

  /* ---------------------------------------------------------------- reaction roles */
  console.log('\nReaction roles');
  const owl = (await api('POST', `/servers/${BG.id}/roles`, A.token, { name: 'Night Owl' })).body;
  r = await api('POST', `/channels/${bgText.id}/reaction-roles`, PL.token, { content: 'roles', pairs: [{ emoji: '🦉', roleId: owl.id }] }); ok(r.status === 403, 'a member without Manage Roles can’t set up reaction roles');
  r = await api('POST', `/channels/${bgText.id}/reaction-roles`, A.token, { content: 'Pick one', pairs: [{ emoji: '🦉', roleId: owl.id }] }); const RR = r.body;
  ok(r.status === 200 && RR.authorId === BG.orbitId && RR.reactions['🦉']?.includes(BG.orbitId) && RR.content.includes('Night Owl'), 'Orbit posts the reaction-roles message and reacts first');
  const plRoles = async () => (await api('GET', '/ready', A.token)).body.servers.find((s) => s.id === BG.id).members.find((m) => m.id === PL.user.id).roles;
  await api('PUT', `/channels/${bgText.id}/messages/${RR.id}/reactions/${encodeURIComponent('🦉')}/@me`, PL.token); ok((await plRoles()).includes(owl.id), 'reacting gives the role');
  await api('DELETE', `/channels/${bgText.id}/messages/${RR.id}/reactions/${encodeURIComponent('🦉')}/@me`, PL.token); ok(!(await plRoles()).includes(owl.id), 'taking the reaction back removes it');
  const boss = (await api('POST', `/servers/${BG.id}/roles`, A.token, { name: 'Boss', permissions: ['ADMINISTRATOR'] })).body;
  r = await api('POST', `/channels/${bgText.id}/reaction-roles`, A.token, { pairs: [{ emoji: '👑', roleId: boss.id }] }); ok(r.status === 400, 'an administrator role can’t be handed out with a reaction');

  /* ---------------------------------------------------------------- AutoMod */
  console.log('\nAutoMod');
  r = await api('PATCH', `/servers/${BG.id}`, A.token, { automod: { links: true, mentions: 2, spam: true } }); ok(r.status === 200 && r.body.automod.links && r.body.automod.mentions === 2, 'AutoMod rules can be turned on');
  r = await api('POST', `/channels/${bgText.id}/messages`, PL.token, { content: 'go to https://example.com now' }); ok(r.status === 400 && r.body.code === 'automod' && /links/.test(r.body.error), 'a link is blocked, and the sender is told why');
  r = await api('POST', `/channels/${bgText.id}/messages`, A.token, { content: 'owner link https://example.com' }); ok(r.status === 200, '… but the owner isn’t checked');
  r = await api('PATCH', `/channels/${bgText.id}/messages/${src.id}`, PL.token, { content: 'edited to https://example.com' }); ok(r.status === 400, 'an edit that adds a link is blocked too');
  r = await api('POST', `/channels/${bgText.id}/messages`, PL.token, { content: `<@${A.user.id}> <@${BG.orbitId}> <@${PL.user.id}>` }); ok(r.status === 400 && /mentions/.test(r.body.error), 'too many mentions are blocked');
  for (let i = 0; i < 2; i++) await api('POST', `/channels/${bgText.id}/messages`, PL.token, { content: 'same thing' });
  r = await api('POST', `/channels/${bgText.id}/messages`, PL.token, { content: 'same thing' }); ok(r.status === 400 && /spam/.test(r.body.error), 'the same message a third time is spam');
  r = await api('POST', `/channels/${bgText.id}/command`, PL.token, { name: 'choose', args: 'https://a.example | https://b.example' }); ok(r.status === 400 && r.body.code === 'automod', 'what Orbit would repeat for someone is checked too');
  await api('PATCH', `/servers/${BG.id}`, A.token, { automod: { invites: true, timeout: 5 } });
  r = await api('POST', `/channels/${bgText.id}/messages`, PL.token, { content: `join us ${base}/invite/abcd1234` });
  const plMember = async () => (await api('GET', '/ready', A.token)).body.servers.find((s) => s.id === BG.id).members.find((m) => m.id === PL.user.id);
  ok(r.status === 400 && (await plMember()).timeoutUntil > Date.now() + 4 * 60_000, 'an invite link is blocked and the sender is timed out for 5 minutes');
  await api('PUT', `/servers/${BG.id}/members/${PL.user.id}/timeout`, A.token, { minutes: 0 }); await api('PATCH', `/servers/${BG.id}`, A.token, { automod: {} });

  /* ---------------------------------------------------------------- onboarding */
  console.log('\nOnboarding');
  const artists = (await api('POST', `/servers/${BG.id}/roles`, A.token, { name: 'Artists' })).body;
  r = await api('PATCH', `/servers/${BG.id}`, A.token, { onboarding: { enabled: true, rules: 'Be nice', roles: [{ roleId: artists.id, emoji: '🎨', desc: 'You draw' }, { roleId: boss.id }] } });
  ok(r.status === 200 && r.body.onboarding.roles.length === 1 && r.body.onboarding.roles[0].roleId === artists.id, 'onboarding only offers roles that grant nothing extra');
  const NB = await register('newbie', { ip: '192.0.2.240' }); await api('POST', `/invites/${bgCode}/join`, NB.token);
  r = await api('POST', `/channels/${bgText.id}/messages`, NB.token, { content: 'hi' }); ok(r.status === 403, 'a newcomer can’t talk before finishing the rules screen');
  const nbView = (await api('GET', '/ready', NB.token)).body.servers.find((s) => s.id === BG.id);
  ok(nbView.members.find((m) => m.id === NB.user.id).pending === true && nbView.onboarding.rules === 'Be nice', '… and is shown the rules');
  r = await api('POST', `/servers/${BG.id}/onboarding`, NB.token, { roles: [artists.id, boss.id] });
  const nbm = (await api('GET', '/ready', NB.token)).body.servers.find((s) => s.id === BG.id).members.find((m) => m.id === NB.user.id);
  ok(r.status === 200 && !nbm.pending && nbm.roles.includes(artists.id) && !nbm.roles.includes(boss.id), 'finishing gives the picked roles (only offered ones)');
  r = await api('POST', `/channels/${bgText.id}/messages`, NB.token, { content: 'hi all' }); ok(r.status === 200, '… and then they can talk');
  ok(!(await plMember()).pending, 'people already in the server aren’t asked');

  /* ---------------------------------------------------------------- audit log */
  console.log('\nAudit log');
  r = await api('GET', `/servers/${BG.id}/audit-log`, PL.token); ok(r.status === 403, 'only people who can manage the server see the audit log');
  r = await api('GET', `/servers/${BG.id}/audit-log`, A.token); const acts = r.body.entries.map((e) => e.action);
  ok(['member_kick', 'member_ban', 'member_timeout', 'member_timeout_remove', 'role_create', 'automod_block', 'reaction_roles_create', 'server_update', 'orbit_update', 'invite_create'].every((a) => acts.includes(a)), 'kicks, bans, timeouts, roles, AutoMod blocks, settings and invites are all logged');
  const kickE = r.body.entries.find((e) => e.action === 'member_kick');
  ok(kickE.actorId === A.user.id && kickE.target === CO.user.id && kickE.reason === 'spamming' && r.body.entries.find((e) => e.action === 'automod_block').actorId === null, '… with who did it, to whom and why (AutoMod for its own blocks)');
  r = await api('GET', `/servers/${BG.id}/audit-log?action=automod`, A.token); ok(r.body.entries.length >= 4 && r.body.entries.every((e) => e.action === 'automod_block'), '… and it can be filtered');

  /* ---------------------------------------------------------------- custom invite link */
  console.log('\nCustom invite link');
  const mgr = (await api('POST', `/servers/${BG.id}/roles`, A.token, { name: 'Managers', permissions: ['MANAGE_SERVER'] })).body;
  await api('PUT', `/servers/${BG.id}/members/${PL.user.id}/roles/${mgr.id}`, A.token);
  r = await api('PUT', `/servers/${BG.id}/vanity`, PL.token, { code: 'bot-guild' }); ok(r.status === 403, 'only admins can set the custom invite link (Manage Server isn’t enough)');
  r = await api('PUT', `/servers/${BG.id}/vanity`, A.token, { code: '-bad' }); ok(r.status === 400, 'it must be 3–32 letters, numbers or dashes');
  r = await api('PUT', `/servers/${BG.id}/vanity`, A.token, { code: 'Bot-Guild' }); ok(r.status === 200 && r.body.code === 'bot-guild', 'an admin sets it (it is stored in lower case)');
  r = await api('GET', '/invites/BOT-GUILD', MB.token); ok(r.status === 200 && r.body.server.id === BG.id, 'the link works however it is typed');
  r = await api('POST', '/invites/bot-guild/join', MB.token); ok(r.status === 200 && r.body.id === BG.id, 'and anyone can join with it');
  r = await api('PUT', `/servers/${BG.id}/vanity`, A.token, { code: 'bot-guild-2' }); ok(r.status === 429 && r.body.code === 'vanity_wait' && /6 days/.test(r.body.error), 'it can only be changed once every 7 days');
  r = await api('PUT', `/servers/${CG.id}/vanity`, CO.token, { code: 'bot-guild' }); ok(r.status === 400 && /taken/.test(r.body.error), 'two servers can’t have the same link');
  r = await api('DELETE', '/invites/bot-guild', A.token); ok(r.status === 403, 'it can’t be deleted like an ordinary invite');
  r = await api('GET', `/servers/${BG.id}/invites`, A.token); ok(!r.body.some((i) => i.code === 'bot-guild'), 'it isn’t listed with the ordinary invites');
  await stopServer();
  const vj = JSON.parse(fs.readFileSync(path.join(data, 'db.json'), 'utf8')); vj.servers[BG.id].vanity.changedAt -= 8 * 86400_000;
  fs.writeFileSync(path.join(data, 'db.json'), JSON.stringify(vj)); startServer(); await ready();
  r = await api('PUT', `/servers/${BG.id}/vanity`, A.token, { code: 'bot-guild-2' }); ok(r.status === 200 && r.body.code === 'bot-guild-2', 'a week later it can be changed');
  r = await api('GET', '/invites/bot-guild', MB.token); ok(r.status === 404, '… and the old link stops working');
  r = await api('PUT', `/servers/${CG.id}/vanity`, A.token, { code: 'co-guild' }); ok(r.status === 403 && r.body.code === 'vanity_limit' && r.body.error.includes('Bot Guild'), 'one person can have a custom link on one server only');
  const VX = await register('vanityx', { dev: 'device-vanityvanity01', ip: '192.0.2.241' }); const VY = await register('vanityy', { dev: 'device-vanityvanity01', ip: '192.0.2.242' });
  const VXS = (await api('POST', '/servers', VX.token, { name: 'X Guild' }, { 'x-forwarded-for': '192.0.2.241' })).body; const VYS = (await api('POST', '/servers', VY.token, { name: 'Y Guild' }, { 'x-forwarded-for': '192.0.2.242' })).body;
  r = await api('PUT', `/servers/${VXS.id}/vanity`, VX.token, { code: 'x-guild' }); ok(r.status === 200, 'someone else can set one for their own server');
  r = await api('PUT', `/servers/${VYS.id}/vanity`, VY.token, { code: 'y-guild' }); ok(r.status === 403 && r.body.code === 'vanity_limit' && r.body.error.includes('X Guild'), '… but another account on the same browser counts as the same person');
  r = await api('GET', `/servers/${BG.id}/audit-log?action=vanity_`, A.token); ok(r.body.entries.length === 2 && r.body.entries[0].details.old === 'bot-guild', 'changes are in the audit log');

  /* ---------------------------------------------------------------- server tags */
  console.log('\nServer tags');
  r = await api('PUT', `/servers/${BG.id}/tag`, PL.token, { text: 'BOT', icon: 'bolt', color: '#ff0000' }); ok(r.status === 403, 'only admins can set the server tag (Manage Server isn’t enough)');
  r = await api('PUT', `/servers/${BG.id}/tag`, A.token, { text: 'TOOLONG', icon: 'bolt', color: '#ff0000' }); ok(r.status === 400, 'a tag is at most 5 characters');
  r = await api('PUT', `/servers/${BG.id}/tag`, A.token, { text: 'B-T', icon: 'bolt', color: '#ff0000' }); ok(r.status === 400, '… of letters and numbers only');
  r = await api('PUT', `/servers/${BG.id}/tag`, A.token, { text: 'BOT1', icon: 'bolt', color: '#FF0000' }); ok(r.status === 200 && r.body.text === 'BOT1' && r.body.icon === 'bolt' && r.body.color === '#ff0000', 'an admin sets the tag with an icon and a color');
  r = await api('PUT', `/servers/${BG.id}/tag`, A.token, { text: 'BOT2', icon: 'bolt', color: '#ff0000' }); ok(r.status === 429 && r.body.code === 'tag_wait' && /6 days/.test(r.body.error), 'it can only be changed once a week');
  r = await api('PATCH', '/me', PL.token, { tagServer: BG.id }); ok(r.status === 200 && r.body.tagServer === BG.id, 'a member wears the server’s tag');
  r = await api('GET', `/users/${PL.user.id}`, MB.token); ok(r.body.user.tag?.text === 'BOT1' && r.body.user.tag.icon === 'bolt' && r.body.user.tag.server === 'Bot Guild', '… and everyone sees it next to their name');
  r = await api('PATCH', '/me', CO.token, { tagServer: BG.id }); ok(r.status === 400, 'only members can wear a server’s tag');
  r = await api('PATCH', '/me', A.token, { tagServer: CG.id }); ok(r.status === 400, '… and only a server that has one');
  await api('PATCH', '/me', MB.token, { tagServer: BG.id }); await api('POST', `/servers/${BG.id}/leave`, MB.token);
  r = await api('GET', `/users/${MB.user.id}`, PL.token); ok(!r.body.user.tag, 'leaving the server takes the tag off');
  r = await api('PATCH', '/me', PL.token, { tagServer: null }); ok(r.status === 200 && !r.body.tag, 'it can be taken off');

  /* ---------------------------------------------------------------- accounts per browser */
  console.log('\nAccounts per browser');
  await stopServer(); startServer({ ACCOUNTS_PER_BROWSER: '', ACCOUNTS_PER_HOUR: '' }); await ready();   // the real limits: 3 and 3
  const lim = (n) => register(`limit${n}`, { dev: 'device-limitlimitlimit1', ip: `192.0.2.${220 + n}` });
  const L1 = await lim(1); const L2 = await lim(2); const L3 = await lim(3);
  ok(L1.token && L2.token && L3.token, 'a browser can make 3 accounts');
  const L4 = await lim(4); ok(L4.res.status === 429 && L4.res.body.code === 'account_wait' && /Wait (59|60) minutes/.test(L4.res.body.error), 'a 4th in the same hour is told how many minutes to wait');
  ok((await register('limitother', { dev: 'device-otherotherother1', ip: '192.0.2.230' })).token, '… while another browser on the same network still can');
  await stopServer();
  const lj = JSON.parse(fs.readFileSync(path.join(data, 'db.json'), 'utf8'));
  for (const x of [L1, L2, L3]) lj.users[x.user.id].createdAt -= 2 * 3600_000;
  fs.writeFileSync(path.join(data, 'db.json'), JSON.stringify(lj)); startServer({ ACCOUNTS_PER_BROWSER: '', ACCOUNTS_PER_HOUR: '' }); await ready();
  r = (await lim(4)).res; ok(r.status === 403 && r.body.code === 'account_limit', 'an hour later it still can’t have more than 3 at once');
  r = await api('DELETE', '/me', L1.token, { password: 'password123' }); ok(r.status === 200 && (await lim(4)).token, '… until one of them is deleted');

  /* ---------------------------------------------------------------- hosted TURN relays (calls need one when two networks can't link directly) */
  console.log('\nHosted TURN relays');
  const seen = [];
  const relay = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      if (req.url.startsWith('/v1/turn/keys/key-1/credentials/generate-ice-servers') && req.headers.authorization === 'Bearer cf-token') {
        res.setHeader('content-type', 'application/json'); res.statusCode = 201;
        return res.end(JSON.stringify({ iceServers: [{ urls: ['stun:stun.cloudflare.test:3478'] }, { urls: ['turn:turn.cloudflare.test:3478?transport=udp', 'turns:turn.cloudflare.test:5349?transport=tcp'], username: 'cf-user', credential: 'cf-cred' }] }));
      }
      if (req.url.startsWith('/api/v1/turn/credentials?apiKey=met-key')) {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify([{ urls: 'stun:relay.metered.test:80' }, { urls: 'turn:relay.metered.test:443', username: 'm-user', credential: 'm-cred' }]));
      }
      res.statusCode = 401; res.end('{"error":"nope"}');
    });
  });
  await new Promise((r) => relay.listen(0, '127.0.0.1', r)); const relayBase = `http://127.0.0.1:${relay.address().port}`;
  const iceOf = async (tok) => (await api('GET', '/ice', tok)).body;
  r = await api('GET', '/ice', A.token); ok(r.body.turn === false && r.body.iceServers.length === 1 && r.body.iceServers[0].urls.length === 3, 'with no relay configured there is only STUN (the call can fail across strict networks)');
  await stopServer(); startServer({ CLOUDFLARE_TURN_KEY_ID: 'key-1', CLOUDFLARE_TURN_API_TOKEN: 'cf-token', CLOUDFLARE_TURN_API_BASE: relayBase }); await ready();
  let ice = await iceOf(A.token);
  const cfTurn = ice.iceServers.find((s) => s.username === 'cf-user');
  ok(ice.turn === true && cfTurn?.credential === 'cf-cred' && cfTurn.urls.length === 2 && ice.iceServers[0].urls.some((u) => u.startsWith('stun:')), 'Cloudflare: the relay’s servers and credentials are handed to the browser');
  ok(seen.length === 1 && seen[0].method === 'POST' && JSON.parse(seen[0].body).ttl === 86400, '… fetched once with the server’s own token');
  await iceOf(T.token); await iceOf(A.token); ok(seen.length === 1, '… and cached, not fetched for every person who joins a call');
  r = await api('GET', '/config', null); ok(r.body.turn === true, 'the config tells the client a relay exists');
  await stopServer(); startServer({ METERED_APP: 'demo', METERED_API_KEY: 'met-key', METERED_API_BASE: relayBase }); await ready();
  ice = await iceOf(A.token); ok(ice.turn === true && ice.iceServers.some((s) => s.username === 'm-user' && s.credential === 'm-cred'), 'Metered: works the same way');
  await stopServer(); startServer({ CLOUDFLARE_TURN_KEY_ID: 'key-1', CLOUDFLARE_TURN_API_TOKEN: 'wrong', CLOUDFLARE_TURN_API_BASE: relayBase }); await ready();
  ice = await iceOf(A.token); ok(ice.turn === false && ice.iceServers.length === 1, 'a relay that refuses the key never breaks calls (STUN only)');
  relay.close();

  /* ---------------------------------------------------------------- email verification still works for those who give an email */
  console.log('\nEmail verification and optional emails together');
  await stopServer(); startServer({ REQUIRE_EMAIL_VERIFICATION: 'true' }); await ready();   // (the header setting above no longer applies)
  r = await api('POST', '/auth/register', null, { username: 'noemail', displayName: 'No', password: 'password123', dob: { year: 1995, month: 1, day: 1 } });
  ok(r.status === 200 && r.body.token && !r.body.verify, 'with verification on, an account without an email is created at once');
  r = await api('GET', '/me', r.body.token); ok(r.status === 200 && r.body.emailVerified === true, '… and is not locked out');
  r = await api('POST', '/auth/register', null, { email: 'someone@comm.dev', username: 'withemail', displayName: 'W', password: 'password123', dob: { year: 1995, month: 1, day: 1 } });
  ok(r.status === 200 && r.body.verify === true && !r.body.token, 'one who gives an email still has to type the code');

  console.log(`\n${pass} passed, ${fail} failed`);
}
main().catch((e) => { console.error(e); fail++; }).finally(async () => { await stopServer(); setTimeout(() => { fs.rmSync(data, { recursive: true, force: true }); process.exit(fail ? 1 : 0); }, 300); });
void n;
