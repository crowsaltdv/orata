// Orate community-features self-test (runs after the other suites):  npm test
// Optional emails at sign-up, bans that also block the person's network (hashed, never shown), ban reasons, timeouts, GIF icons / banners,
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
    env: { ...process.env, PORT: String(PORT), ORATE_DATA: data, HOST: '127.0.0.1', SMTP_HOST: '', REQUIRE_EMAIL_VERIFICATION: '', DATABASE_URL: '', KLIPY_API_KEY: '', TRUST_PROXY: '1', ...extra },
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
const register = async (username, { email, ip } = {}) => {
  const r = await api('POST', '/auth/register', null, { ...(email !== undefined ? { email } : {}), username, displayName: username[0].toUpperCase() + username.slice(1), password: 'password123', dob: { year: 1995, month: 1, day: 1 } }, ip ? { 'x-forwarded-for': ip } : {});
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

  /* ---------------------------------------------------------------- bans that also block the network */
  console.log('\nBans');
  r = await api('POST', '/servers', A.token, { name: 'Ban Guild', template: 'gaming' }); const S = r.body;
  const text = S.channels.find((c) => c.type === 'text');
  r = await api('POST', `/servers/${S.id}/invites`, A.token, {}); const code = r.body.code;
  await api('POST', `/invites/${code}/join`, A.token, null, { 'x-forwarded-for': '203.0.113.50' });   // the owner's own network
  const M = await register('mallory', { ip: '203.0.113.7' });
  r = await api('POST', `/invites/${code}/join`, M.token, null, { 'x-forwarded-for': '203.0.113.7' }); ok(r.status === 200, 'mallory joins');
  await api('POST', `/channels/${text.id}/messages`, M.token, { content: 'spam one' }); await api('POST', `/channels/${text.id}/messages`, M.token, { content: 'spam two' });
  await api('POST', `/channels/${text.id}/messages`, A.token, { content: 'a normal message' });
  r = await api('PUT', `/servers/${S.id}/bans/${M.user.id}`, A.token, { reason: 'spamming', deleteHours: 1 }); ok(r.status === 200, 'the owner bans her with a reason and clears her last hour');
  r = await api('GET', `/channels/${text.id}/messages?limit=50`, A.token); ok(!r.body.messages.some((x) => x.authorId === M.user.id && x.type === 'default') && r.body.messages.some((x) => x.content === 'a normal message'), 'her recent messages are gone, other people’s stay');
  r = await api('GET', `/servers/${S.id}/bans`, A.token);
  ok(r.body.length === 1 && r.body[0].ban.reason === 'spamming' && r.body[0].ban.by === 'Alice' && r.body[0].ban.ipBanned === true && typeof r.body[0].ban.at === 'number', 'the ban list shows who, why, when and that her network is blocked');
  r = await api('POST', `/invites/${code}/join`, M.token, null, { 'x-forwarded-for': '203.0.113.7' }); ok(r.status === 403, 'she cannot rejoin');
  r = await api('POST', `/invites/${code}/join`, M.token, null, { 'x-forwarded-for': '198.51.100.99' }); ok(r.status === 403, 'not even from another network (account ban)');
  const M2 = await register('mallory2', { ip: '203.0.113.7' });
  r = await api('POST', `/invites/${code}/join`, M2.token, null, { 'x-forwarded-for': '203.0.113.7' }); ok(r.status === 403, 'a NEW account from her network is turned away too');
  r = await api('POST', `/invites/${code}/join`, M2.token, null, { 'x-forwarded-for': '198.51.100.99' }); ok(r.status === 403, '… even if it tries from another network later (it was seen on hers)');
  const clean = await register('carol', { ip: '198.51.100.20' });
  r = await api('POST', `/invites/${code}/join`, clean.token, null, { 'x-forwarded-for': '198.51.100.20' }); ok(r.status === 200, 'a stranger on a different network joins fine');
  const sameV6 = await register('v6user', { ip: '2001:db8:1:2:aaaa::1' });
  await api('POST', `/invites/${code}/join`, sameV6.token, null, { 'x-forwarded-for': '2001:db8:1:2:aaaa::1' });
  r = await api('PUT', `/servers/${S.id}/bans/${sameV6.user.id}`, A.token, {}); ok(r.status === 200, 'an IPv6 user is banned');
  const v6b = await register('v6other', { ip: '2001:db8:1:2:bbbb::9' });
  r = await api('POST', `/invites/${code}/join`, v6b.token, null, { 'x-forwarded-for': '2001:db8:1:2:bbbb::9' }); ok(r.status === 403, 'IPv6 is matched by /64 (what one connection controls)');
  const v6c = await register('v6far', { ip: '2001:db8:9:9:bbbb::9' });
  r = await api('POST', `/invites/${code}/join`, v6c.token, null, { 'x-forwarded-for': '2001:db8:9:9:bbbb::9' }); ok(r.status === 200, '… and a different /64 is unaffected');
  const priv = await register('lanuser', { ip: '10.0.0.5' });
  await api('POST', `/invites/${code}/join`, priv.token, null, { 'x-forwarded-for': '10.0.0.5' });
  r = await api('PUT', `/servers/${S.id}/bans/${priv.user.id}`, A.token, {}); ok(r.status === 200, 'someone on a private network is banned');
  const priv2 = await register('lanuser2', { ip: '10.0.0.5' });
  r = await api('POST', `/invites/${code}/join`, priv2.token, null, { 'x-forwarded-for': '10.0.0.5' }); ok(r.status === 200, 'private / loopback addresses are never used to ban (a whole LAN would be locked out)');
  const ownerNet = await register('bob', { ip: '203.0.113.50' });
  await api('POST', `/invites/${code}/join`, ownerNet.token, null, { 'x-forwarded-for': '203.0.113.50' });
  r = await api('PUT', `/servers/${S.id}/bans/${ownerNet.user.id}`, A.token, {}); ok(r.status === 200, 'someone who shares the owner’s network is banned');
  const ownerNet2 = await register('bob2', { ip: '203.0.113.50' });
  r = await api('POST', `/invites/${code}/join`, ownerNet2.token, null, { 'x-forwarded-for': '203.0.113.50' }); ok(r.status === 200, 'the owner’s own network is never blocked');
  r = await api('DELETE', `/servers/${S.id}/bans/${M.user.id}`, A.token); ok(r.status === 200, 'unban mallory');
  r = await api('POST', `/invites/${code}/join`, M2.token, null, { 'x-forwarded-for': '203.0.113.7' }); ok(r.status === 200, 'unbanning frees her network again');
  r = await api('GET', `/servers/${S.id}/bans`, M.token); ok(r.status === 404 || r.status === 403, 'only members with Ban Members can read the list');
  const blob = JSON.stringify([(await api('GET', '/me', A.token)).body, (await api('GET', '/me/sessions', A.token)).body, (await api('GET', `/servers/${S.id}/bans`, A.token)).body, (await api('GET', '/ready', A.token)).body]);
  ok(!/203\.0\.113|198\.51\.100|2001:db8|10\.0\.0\.5/.test(blob), 'no address appears in anything the API returns');
  await stopServer();
  const raw = fs.readFileSync(path.join(data, 'db.json'), 'utf8');
  ok(!/203\.0\.113|198\.51\.100|2001:db8|10\.0\.0\.5/.test(raw) && /"ips":\[\{"h":"[0-9a-f]{24}"/.test(raw), 'only keyed hashes are stored, never a readable address');
  startServer(); await ready();

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
  ok(altRow?.ban.altOf === 'alt_p1' && altRow.ban.reason.startsWith('Alt of alt_p1') && altRow.ban.ipBanned === true, 'the ban list says it is an alt, and of whom');
  r = await api('POST', `/invites/${code}/join`, P2.token, null, P2.h); ok(r.status === 403, 'the alt cannot come back');
  const P4 = await mk('alt_p4', '198.51.100.4', devA); ok(P4.joined === 403, 'a brand-new account on that browser is turned away');
  const P5 = await mk('alt_p5', '198.51.100.5', devB); ok(P5.joined === 200, 'a new account from a different browser and network is fine');
  r = await api('DELETE', `/servers/${S.id}/bans/${P1.user.id}`, A.token); ok(r.status === 200 && r.body.freed === 1, 'unbanning the person frees their alts too');
  r = await api('POST', `/invites/${code}/join`, P2.token, null, P2.h); ok(r.status === 200, '… and the alt can rejoin');
  const Q1 = await mk('alt_q1', '198.51.100.11', 'device-qqqqqqqqqqqqqqqq'); const Q2 = await mk('alt_q2', '198.51.100.12', 'device-qqqqqqqqqqqqqqqq');
  r = await api('PUT', `/servers/${S.id}/bans/${Q1.user.id}`, A.token, { alts: false }); ids = await memberIds(); ok(r.status === 200 && r.body.alts.length === 0 && ids.includes(Q2.user.id), 'a moderator can choose to ban just the one account');
  const N1 = await mk('alt_n1', '203.0.113.77'); const N2 = await mk('alt_n2', '203.0.113.77');
  r = await api('PUT', `/servers/${S.id}/bans/${N1.user.id}`, A.token, {}); ok(r.status === 200 && r.body.alts.some((x) => x.id === N2.user.id), 'accounts that share only a network are alts too');
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

  /* ---------------------------------------------------------------- a host-controlled header decides the address */
  console.log('\nCLIENT_IP_HEADER (behind a proxy that forwards a header the visitor cannot forge)');
  await stopServer(); startServer({ CLIENT_IP_HEADER: 'CF-Connecting-IP' }); await ready();
  const reg2 = async (username, headers) => (await api('POST', '/auth/register', null, { username, displayName: username, password: 'password123', dob: { year: 1995, month: 1, day: 1 } }, headers)).body;
  const join2 = (tok, headers) => api('POST', `/invites/${code}/join`, tok, null, headers);
  const h1H = { 'cf-connecting-ip': '203.0.113.99' }; const h1 = await reg2('hdr1', h1H);
  r = await join2(h1.token, h1H); ok(r.status === 200, 'a visitor behind the proxy joins');
  r = await api('PUT', `/servers/${S.id}/bans/${h1.user.id}`, A.token, {}); ok(r.status === 200, '… and is banned');
  const h2H = { 'cf-connecting-ip': '203.0.113.99', 'x-forwarded-for': '8.8.8.8' }; const h2 = await reg2('hdr2', h2H);
  r = await join2(h2.token, h2H); ok(r.status === 403, 'a new account is matched by the trusted header, whatever X-Forwarded-For claims');
  const h3H = { 'cf-connecting-ip': '198.51.100.77', 'x-forwarded-for': '203.0.113.99' }; const h3 = await reg2('hdr3', h3H);
  r = await join2(h3.token, h3H); ok(r.status === 200, 'a forged X-Forwarded-For cannot be used to frame someone else’s network');

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
