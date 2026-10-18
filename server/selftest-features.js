// Orate feature self-test (runs after the main self-test):  npm test
// Channel & category permission overwrites (allow / deny / inherit, sync with the category), sessions that never expire, invite cards,
// the SoundCloud proxy (against a fake SoundCloud) and the "listening to" status.
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'orate-feat-test-'));
const PORT = 3800 + Math.floor(Math.random() * 90);
const SC_PORT = PORT + 100;
const base = `http://127.0.0.1:${PORT}`;
let pass = 0; let fail = 0;
const ok = (c, name, extra = '') => { if (c) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- a fake SoundCloud (token endpoint, search, track, stream) */
const sc = { tokens: 0, searches: [], badAuth: 0 };
const fakeSoundCloud = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${SC_PORT}`);
  const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url.pathname === '/oauth/token') {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const p = new URLSearchParams(body);
      const basic = Buffer.from(`test-id:test-secret`).toString('base64');
      if (req.headers.authorization !== 'Basic ' + basic || p.get('grant_type') !== 'client_credentials' || p.get('client_secret')) return json({ error: 'invalid_client' }, 401);   // only HTTP Basic is accepted
      sc.tokens++; json({ access_token: 'tok-' + sc.tokens, expires_in: 3600, token_type: 'bearer' });
    });
    return;
  }
  if (!/^OAuth tok-\d+$/.test(req.headers.authorization || '')) { sc.badAuth++; return json({ error: 'unauthorized' }, 401); }
  const track = (id, title) => ({ id, title, duration: 215000, permalink_url: `https://soundcloud.com/artist/${id}`, artwork_url: `https://i1.sndcdn.com/artworks-${id}-large.jpg`, user: { username: 'Test Artist', permalink_url: 'https://soundcloud.com/artist' }, access: 'playable', streamable: true });
  if (url.pathname === '/tracks') { sc.searches.push(url.searchParams.get('q')); return json([track(101, 'Night Drive'), track(102, 'Rain Sounds'), { ...track(103, 'Blocked'), access: 'blocked', streamable: false }]); }
  if (url.pathname === '/tracks/101/streams') return json({ http_mp3_128_url: `http://127.0.0.1:${SC_PORT}/media/101.mp3`, hls_mp3_128_url: `http://127.0.0.1:${SC_PORT}/media/101.m3u8` });
  if (url.pathname === '/tracks/102/streams') return json({ hls_mp3_128_url: `http://127.0.0.1:${SC_PORT}/media/102.m3u8` });
  if (url.pathname === '/tracks/103/streams') return json({});
  if (url.pathname === '/media/102.m3u8') { res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }); return res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:10.0,\nseg1.mp3\n#EXTINF:10.0,\nseg2.mp3\n#EXT-X-ENDLIST\n'); }
  if (url.pathname === '/media/seg1.mp3' || url.pathname === '/media/key.bin') { res.writeHead(200, { 'content-type': 'audio/mpeg' }); return res.end(Buffer.alloc(300, 9)); }
  if (url.pathname === '/media/101.mp3') { const buf = Buffer.alloc(2000, 7); if (req.headers.range) { res.writeHead(206, { 'content-type': 'audio/mpeg', 'content-range': 'bytes 0-99/2000', 'content-length': 100, 'accept-ranges': 'bytes' }); return res.end(buf.subarray(0, 100)); } res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': 2000, 'accept-ranges': 'bytes' }); return res.end(buf); }
  json({ error: 'not found' }, 404);
});

/* ---------------------------------------------------------------- scratch server */
let child = null;
function startServer(extra = {}) {
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), ORATE_DATA: data, HOST: '127.0.0.1', SMTP_HOST: '', REQUIRE_EMAIL_VERIFICATION: '', DATABASE_URL: '', KLIPY_API_KEY: '',
      SOUNDCLOUD_CLIENT_ID: 'test-id', SOUNDCLOUD_CLIENT_SECRET: 'test-secret', SOUNDCLOUD_API_BASE: `http://127.0.0.1:${SC_PORT}`, SOUNDCLOUD_AUTH_URL: `http://127.0.0.1:${SC_PORT}/oauth/token`, SOUNDCLOUD_MEDIA_HOSTS: '127.0.0.1', ...extra },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}
async function ready() { for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/config'); return; } catch { await sleep(100); } } }
async function stopServer() { if (!child) return; await sleep(900); /* let the 500 ms save debounce write db.json (Windows cannot deliver SIGINT) */ const c = child; child = null; const done = new Promise((r) => c.once('exit', r)); c.kill('SIGINT'); await Promise.race([done, sleep(3000)]); }

async function api(method, url, token, body, headers = {}) {
  const res = await fetch(base + '/api' + url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: j, headers: res.headers };
}
function connect(token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/gateway`); const events = []; const waiters = [];
    ws.on('open', () => ws.send(JSON.stringify({ op: 'identify', d: { token } })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw); events.push(m);
      for (const w of [...waiters]) if (w.op === m.op && (!w.fn || w.fn(m.d))) { waiters.splice(waiters.indexOf(w), 1); w.res(m.d); }
      if (m.op === 'ready' || m.op === 'invalid_session') resolve({ ws, events, op: m.op, ready: m.d, wait: (op, fn, ms = 3000) => new Promise((res, rej) => { const f = events.find((e) => e.op === op && (!fn || fn(e.d))); if (f) return res(f.d); const w = { op, fn, res }; waiters.push(w); setTimeout(() => rej(new Error('timeout waiting for ' + op)), ms); }) });
    });
  });
}
const register = async (username, email) => {
  const r = await api('POST', '/auth/register', null, { email, username, displayName: username[0].toUpperCase() + username.slice(1), password: 'password123', dob: { year: 1995, month: 1, day: 1 } });
  return { token: r.body.token, user: r.body.user };
};

async function main() {
  await new Promise((r) => fakeSoundCloud.listen(SC_PORT, '127.0.0.1', r));
  startServer(); await ready();
  console.log('Orate feature test on port', PORT);

  /* ---------------------------------------------------------------- permissions */
  console.log('\nChannel & category permissions');
  const A = await register('alice', 'a@feat.dev'); const B = await register('bob', 'b@feat.dev'); const C = await register('carol', 'c@feat.dev');
  let r = await api('POST', '/servers', A.token, { name: 'Perm Guild', template: 'gaming' });
  const S = r.body; const cat = S.channels.find((c) => c.type === 'category'); const general = S.channels.find((c) => c.type === 'text' && c.parentId === cat.id);
  ok(S.perms.includes('VIEW_CHANNEL'), 'owners (and @everyone) have View Channel');
  r = await api('POST', `/servers/${S.id}/invites`, A.token, {}); const code = r.body.code;
  await api('POST', `/invites/${code}/join`, B.token); await api('POST', `/invites/${code}/join`, C.token);
  r = await api('POST', `/servers/${S.id}/roles`, A.token, { name: 'VIP', color: '#ff00aa', permissions: [] });
  const vip = r.body; ok(!!vip.id, 'create a VIP role');
  r = await api('PUT', `/servers/${S.id}/members/${B.user.id}/roles/${vip.id}`, A.token); ok(r.status === 200, 'give bob the VIP role');
  const wb = await connect(B.token); const wc = await connect(C.token);
  const seen = (ready, id) => ready.servers.find((s) => s.id === S.id)?.channels.some((c) => c.id === id);
  ok(seen(wb.ready, general.id) && seen(wc.ready, general.id), 'everybody sees #general at first');

  // a private channel built from overwrites
  r = await api('POST', `/servers/${S.id}/channels`, A.token, { name: 'vip-lounge', type: 'text', parentId: cat.id, overwrites: [{ type: 'role', id: S.id, allow: [], deny: ['VIEW_CHANNEL'] }, { type: 'role', id: vip.id, allow: ['VIEW_CHANNEL'], deny: [] }] });
  const lounge = r.body; ok(r.status === 200 && lounge.private === true && lounge.synced === false, 'channel with its own overwrites is private and not synced', JSON.stringify(r.body));
  ok(Array.isArray(lounge.overwrites) && lounge.overwrites.length === 2, 'managers receive the overwrites');
  r = await api('GET', `/channels/${lounge.id}/messages`, B.token); ok(r.status === 200, 'bob (VIP role) can read the private channel');
  r = await api('GET', `/channels/${lounge.id}/messages`, C.token); ok(r.status === 404, 'carol (no role) cannot');
  const ready2 = await connect(C.token); ok(!seen(ready2.ready, lounge.id), 'the private channel is not in carol’s channel list'); ready2.ws.close();
  ok(!(await wc.wait('channel_create', (d) => d.channel.id === lounge.id, 600).catch(() => null)), 'carol never hears about the channel being created');
  ok(!!(await wb.wait('channel_create', (d) => d.channel.id === lounge.id, 1500).catch(() => null)), 'bob does');

  // denying / allowing single permissions, role vs member overwrites
  r = await api('POST', `/channels/${general.id}/messages`, C.token, { content: 'hello' }); ok(r.status === 200, 'carol can talk in #general');
  r = await api('PATCH', `/channels/${general.id}`, A.token, { overwrites: [{ type: 'role', id: S.id, allow: [], deny: ['SEND_MESSAGES'] }] });
  ok(r.status === 200 && r.body.synced === false, 'editing a synced channel’s permissions detaches it from the category');
  r = await api('POST', `/channels/${general.id}/messages`, C.token, { content: 'hello' }); ok(r.status === 403, '@everyone is denied Send Messages in #general');
  r = await api('PATCH', `/channels/${general.id}`, A.token, { overwrites: [{ type: 'role', id: S.id, allow: [], deny: ['SEND_MESSAGES'] }, { type: 'role', id: vip.id, allow: ['SEND_MESSAGES'], deny: [] }] });
  r = await api('POST', `/channels/${general.id}/messages`, B.token, { content: 'vip speaks' }); ok(r.status === 200, 'a role allow beats the @everyone deny');
  r = await api('PATCH', `/channels/${general.id}`, A.token, { overwrites: [{ type: 'role', id: S.id, allow: [], deny: ['SEND_MESSAGES'] }, { type: 'role', id: vip.id, allow: ['SEND_MESSAGES'], deny: [] }, { type: 'member', id: B.user.id, allow: [], deny: ['SEND_MESSAGES'] }] });
  r = await api('POST', `/channels/${general.id}/messages`, B.token, { content: 'muted again' }); ok(r.status === 403, 'a member deny beats the role allow');
  const sv = await wc.wait('server_update', (d) => d.server.id === S.id && d.server.channels.find((c) => c.id === general.id)?.cperms, 2000).catch(() => null);
  ok(sv && !sv.server.channels.find((c) => c.id === general.id).cperms.includes('SEND_MESSAGES') && sv.server.perms.includes('SEND_MESSAGES'), 'the client is told what it may do in the channel (cperms) while server-wide permissions stay');
  r = await api('POST', `/channels/${general.id}/messages`, A.token, { content: 'owner always can' }); ok(r.status === 200, 'the owner ignores overwrites');

  // permission hierarchy: a manager without Administrator cannot hand out what they lack, nor edit above themselves
  r = await api('POST', `/servers/${S.id}/roles`, A.token, { name: 'Mod', permissions: ['MANAGE_ROLES', 'SEND_MESSAGES'] }); const mod = r.body;
  await api('PUT', `/servers/${S.id}/members/${C.user.id}/roles/${mod.id}`, A.token);
  r = await api('PATCH', `/channels/${general.id}`, C.token, { overwrites: [{ type: 'role', id: S.id, allow: ['MENTION_EVERYONE'], deny: [] }] });
  ok(r.status === 403, 'a manager cannot allow a permission they do not have', String(r.status));
  r = await api('PATCH', `/channels/${general.id}`, C.token, { topic: 'x' }); ok(r.status === 403, 'Manage Permissions alone does not allow renaming');
  r = await api('PATCH', `/channels/${general.id}`, C.token, { overwrites: [{ type: 'role', id: mod.id, allow: [], deny: ['SEND_MESSAGES'] }] }); ok(r.status === 403, 'a manager cannot edit their own role’s overwrite');
  r = await api('PATCH', `/channels/${general.id}`, C.token, { overwrites: [{ type: 'role', id: S.id, allow: [], deny: ['SEND_MESSAGES', 'ADD_REACTIONS'] }, { type: 'role', id: vip.id, allow: ['SEND_MESSAGES'], deny: [] }, { type: 'member', id: B.user.id, allow: [], deny: ['SEND_MESSAGES'] }] });
  ok(r.status === 200, 'but they can restrict others (deny + permissions they hold)', JSON.stringify(r.body));

  // categories: synced channels follow, unsynced ones don't
  const a1 = (await api('POST', `/servers/${S.id}/channels`, A.token, { name: 'follows', type: 'text', parentId: cat.id })).body;
  const a2 = (await api('POST', `/servers/${S.id}/channels`, A.token, { name: 'own-rules', type: 'text', parentId: cat.id })).body;
  ok(a1.synced === true && a2.synced === true, 'new channels in a category start synced');
  r = await api('PATCH', `/channels/${a2.id}`, A.token, { synced: false }); ok(r.body.synced === false, 'a channel can be unsynced');
  r = await api('PATCH', `/channels/${cat.id}`, A.token, { overwrites: [{ type: 'role', id: S.id, allow: [], deny: ['VIEW_CHANNEL'] }, { type: 'role', id: vip.id, allow: ['VIEW_CHANNEL'], deny: [] }] });
  ok(r.status === 200, 'make the category private');
  r = await api('GET', `/channels/${a1.id}/messages`, C.token); ok(r.status === 404, 'the synced channel is private with it');
  r = await api('GET', `/channels/${a2.id}/messages`, C.token); ok(r.status === 200, 'the unsynced channel is not');
  r = await api('GET', `/channels/${a1.id}/messages`, B.token); ok(r.status === 200, 'VIP can still see the synced channel');
  const sv2 = await wc.wait('server_update', (d) => d.server.id === S.id && !d.server.channels.some((c) => c.id === a1.id), 2000).catch(() => null);
  ok(!!sv2 && sv2.server.channels.some((c) => c.id === cat.id), 'carol’s channel list drops the synced channel but keeps the category (an unsynced child is still visible)');
  r = await api('PATCH', `/channels/${a2.id}`, A.token, { synced: true }); ok(r.body.synced === true, 'Sync Now re-adopts the category’s permissions');
  r = await api('GET', `/channels/${a2.id}/messages`, C.token); ok(r.status === 404, '… and the channel is private again');
  r = await api('PATCH', `/channels/${a1.id}`, A.token, { synced: false }); ok(r.body.synced === false && r.body.overwrites.length === 2, 'unsyncing copies the category’s overwrites into the channel');
  r = await api('PATCH', `/channels/${cat.id}`, A.token, { overwrites: [] });
  r = await api('GET', `/channels/${a1.id}/messages`, C.token); ok(r.status === 404, 'an unsynced channel keeps its copy when the category changes');
  r = await api('GET', `/channels/${a2.id}/messages`, C.token); ok(r.status === 200, 'while a synced one follows (category is public again)');
  r = await api('PATCH', `/channels/${general.id}`, A.token, { synced: true }); ok(r.body.synced === true, '#general re-synced');

  // migration of the old "private channel" fields happens at startup
  await stopServer();
  const dbFile = path.join(data, 'db.json'); const dbj = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  const legacy = Object.values(dbj.channels).find((c) => c.name === 'own-rules');
  legacy.private = true; legacy.allowedRoles = [vip.id]; delete legacy.overwrites; legacy.synced = false;
  for (const s of Object.values(dbj.servers)) { s.permsV = undefined; for (const role of s.roles) if (role.id === s.id) role.permissions = role.permissions.filter((p) => p !== 'VIEW_CHANNEL'); }
  fs.writeFileSync(dbFile, JSON.stringify(dbj));
  wb.ws.close(); wc.ws.close();
  startServer(); await ready();
  r = await api('GET', `/channels/${legacy.id}/messages`, C.token); ok(r.status === 404, 'legacy private channel still hides from non-members after the upgrade');
  r = await api('GET', `/channels/${legacy.id}/messages`, B.token); ok(r.status === 200, '… and still shows to its allowed role');
  r = await api('GET', `/channels/${general.id}/messages`, C.token); ok(r.status === 200, 'old servers regain View Channel on @everyone');

  /* ---------------------------------------------------------------- sessions */
  console.log('\nSessions');
  r = await api('GET', '/me/sessions', A.token);
  ok(r.status === 200 && r.body.length >= 1 && r.body.every((s) => !('ip' in s)), 'the sessions list has no IP address');
  const raw = fs.readFileSync(dbFile, 'utf8'); ok(!/"ip":/.test(raw), 'no IP is stored in the database');
  ok(r.body.some((s) => s.current), 'the current device is marked');
  const login = await api('POST', '/auth/login', null, { login: 'alice', password: 'password123' }); const A2 = login.body.token;
  await stopServer(); startServer(); await ready();
  r = await api('GET', '/me', A.token); ok(r.status === 200, 'signed-in sessions survive a server restart');
  r = await api('GET', '/me', A2); ok(r.status === 200, '… including a second login');
  const stale = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  for (const s of Object.values(stale.sessions)) s.lastUsed = Date.now() - 400 * 24 * 3600 * 1000;
  fs.writeFileSync(dbFile, JSON.stringify(stale)); await stopServer(); startServer(); await ready();
  r = await api('GET', '/me', A.token); ok(r.status === 200, 'a session unused for over a year is still valid (nothing expires by itself)');
  r = await api('DELETE', `/me/sessions/${(await api('GET', '/me/sessions', A.token)).body.find((s) => !s.current).id}`, A.token);
  r = await api('GET', '/me', A2); ok(r.status === 401, 'revoking another device signs only that one out');
  r = await api('POST', '/auth/logout', A.token); r = await api('GET', '/me', A.token); ok(r.status === 401, 'logging out ends the session');
  const dead = await connect('nope'); ok(dead.op === 'invalid_session', 'the gateway tells unknown tokens to sign in again'); dead.ws.close();

  /* ---------------------------------------------------------------- invite card data */
  console.log('\nInvite cards');
  const A3 = (await api('POST', '/auth/login', null, { login: 'alice', password: 'password123' })).body.token;
  r = await api('GET', `/invites/${code}`, B.token);
  ok(r.status === 200 && r.body.server.name === 'Perm Guild' && r.body.server.memberCount === 3 && typeof r.body.server.createdAt === 'number' && r.body.joined === true, 'invite lookup returns the card data and whether you are already in');
  r = await api('POST', `/servers/${S.id}/invites`, A3, { maxUses: 1 }); const one = r.body.code;
  const D = await register('dave', 'd@feat.dev');
  r = await api('GET', `/invites/${one}`, D.token); ok(r.status === 200 && r.body.joined === false, 'a fresh invite shows a Join button state');
  await api('POST', `/invites/${one}/join`, D.token);
  const E = await register('erin', 'e@feat.dev');
  r = await api('GET', `/invites/${one}`, E.token); ok(r.status === 404, 'a used-up invite shows as invalid');
  r = await api('GET', `/invites/${one}`, D.token); ok(r.status === 200 && r.body.joined === true, '… but still opens "Go to Server" for those already inside');
  r = await api('GET', '/invites/nonsense', E.token); ok(r.status === 404, 'unknown invite codes are invalid');

  /* ---------------------------------------------------------------- music + listening status */
  console.log('\nMusic (SoundCloud)');
  r = await api('GET', '/config'); ok(r.body.music === true, '/api/config says music is available');
  r = await api('GET', '/music/search?q=night', null); ok(r.status === 401, 'search needs a login');
  r = await api('GET', '/music/search?q=night', A3);
  ok(r.status === 200 && r.body.tracks.length === 2 && r.body.tracks[0].title === 'Night Drive' && r.body.tracks[0].artist === 'Test Artist', 'search returns playable tracks (blocked ones are dropped)', JSON.stringify(r.body).slice(0, 160));
  ok(r.body.tracks[0].artwork.includes('t300x300') && sc.tokens === 1 && sc.badAuth === 0, 'artwork is upsized and the client-credentials token was fetched once');
  await api('GET', '/music/search?q=again', A3); ok(sc.tokens === 1, 'the access token is cached between searches');
  r = await api('GET', '/music/search?q=', A3); ok(r.status === 400, 'empty searches are rejected');
  r = await api('GET', '/music/tracks/101/source', null); ok(r.status === 401, 'asking for a stream link needs a login');
  r = await api('GET', '/music/tracks/bad!id/source', A3); ok(r.status === 400, 'track ids are validated');
  r = await api('GET', '/music/tracks/101/source', A3);
  ok(r.status === 200 && r.body.type === 'mp3' && r.body.url.startsWith('/api/music/proxy?u=') && !r.body.preview, 'a progressive MP3 is preferred when SoundCloud offers one', JSON.stringify(r.body).slice(0, 120));
  const mp3Url = r.body.url;
  let st = await fetch(base + mp3Url);
  ok(st.status === 200 && st.headers.get('content-type') === 'audio/mpeg' && (await st.arrayBuffer()).byteLength === 2000, 'the audio plays through the relay without a bearer token (an <audio> tag cannot send one)');
  st = await fetch(base + mp3Url, { headers: { range: 'bytes=0-99' } });
  ok(st.status === 206 && st.headers.get('content-range') === 'bytes 0-99/2000', 'range requests (seeking) are passed through');
  st = await fetch(base + mp3Url.replace(/sig=[^&]+/, 'sig=forged')); ok(st.status === 403, 'a forged link is refused');
  st = await fetch(base + mp3Url.replace(/exp=\d+/, 'exp=1')); ok(st.status === 403, 'so is a link whose time ran out or that was edited');
  st = await fetch(`${base}/api/music/proxy?u=${encodeURIComponent('https://evil.example/x.mp3')}&exp=${Date.now() + 1e6}&sig=abc`); ok(st.status === 403, 'the relay never fetches arbitrary addresses');
  r = await api('GET', '/music/tracks/102/source', A3); ok(r.body.type === 'hls', 'HLS is used when it is all SoundCloud has');
  st = await fetch(base + r.body.url); const pl = await st.text();
  ok(st.status === 200 && pl.startsWith('#EXTM3U') && (pl.match(/\/api\/music\/proxy\?u=/g) || []).length === 3 && !pl.includes('seg1.mp3\n') && pl.includes('URI="/api/music/proxy'), 'playlists are rewritten so segments and keys go through the relay too', pl.slice(0, 200));
  const seg = pl.split('\n').find((l) => l.startsWith('/api/music/proxy')); st = await fetch(base + seg);
  ok(st.status === 200 && (await st.arrayBuffer()).byteLength === 300, 'segments are relayed');
  r = await api('GET', '/music/tracks/103/source', A3); ok(r.status === 404 && r.body.code === 'music_unavailable', 'a track without streams explains that it can’t be played');

  console.log('\nListening status');
  const w1 = await connect(A3); const w2 = await connect(D.token);
  r = await api('PUT', '/me/listening', A3, { track: { id: 101, title: 'Night Drive', artist: 'Test Artist', artwork: 'https://i1.sndcdn.com/artworks-101-t300x300.jpg', url: 'https://soundcloud.com/artist/101', duration: 215000 }, position: 5000 });
  ok(r.status === 200 && r.body.listening?.title === 'Night Drive', 'set what you are listening to');
  const upd = await w2.wait('user_update', (d) => d.user.listening?.title === 'Night Drive', 2000).catch(() => null);
  ok(!!upd && upd.user.listening.artist === 'Test Artist' && upd.user.listening.endsAt > Date.now(), 'people who share a server see it live, with an end time');
  r = await api('GET', `/users/${(await api('GET', '/me', A3)).body.id}`, D.token); ok(r.body.user.listening?.title === 'Night Drive', 'it is on the profile too');
  r = await api('PUT', '/me/listening', A3, { track: { id: 'x', title: '<b>bad</b>', artist: 'a', artwork: 'javascript:alert(1)', url: 'javascript:alert(1)', duration: 1000 } });
  ok(r.status === 400 || (r.body.listening && !String(r.body.listening.url || '').startsWith('javascript:') && !String(r.body.listening.artwork || '').startsWith('javascript:')), 'links must be https');
  await api('PATCH', '/me/settings', A3, { privacy: { showActivity: false } });
  r = await api('PUT', '/me/listening', A3, { track: { id: 102, title: 'Rain Sounds', artist: 'Test Artist', artwork: null, url: 'https://soundcloud.com/artist/102', duration: 100000 } });
  r = await api('GET', `/users/${(await api('GET', '/me', A3)).body.id}`, D.token); ok(!r.body.user.listening, 'Activity Status off hides it from everybody else');
  await api('PATCH', '/me/settings', A3, { privacy: { showActivity: true } });
  await api('PUT', '/me/listening', A3, { track: { id: 102, title: 'Rain Sounds', artist: 'Test Artist', artwork: null, url: 'https://soundcloud.com/artist/102', duration: 100000 } });
  r = await api('DELETE', '/me/listening', A3); ok(r.status === 200, 'stop listening');
  ok(!!(await w2.wait('user_update', (d) => d.user.listening === null, 2000).catch(() => null)), 'everyone sees it clear');
  await api('PUT', '/me/listening', A3, { track: { id: 102, title: 'Rain Sounds', artist: 'Test Artist', artwork: null, url: 'https://soundcloud.com/artist/102', duration: 60000 } });
  w1.ws.close();
  const gone = await w2.wait('presence_update', (d) => d.userId === (A.user.id) && d.listening === null, 5000).catch(() => null);
  ok(!!gone, 'closing the last tab clears the status (the music stopped with it)');
  w2.ws.close();

  console.log('\nMusic without credentials');
  await stopServer(); startServer({ SOUNDCLOUD_CLIENT_ID: '', SOUNDCLOUD_CLIENT_SECRET: '' }); await ready();
  r = await api('GET', '/config'); ok(r.body.music === false, 'music reports itself as not configured');
  r = await api('GET', '/music/search?q=night', A3); ok(r.status === 503 && r.body.code === 'music_not_configured', 'searching explains that SoundCloud is not set up');

  console.log(`\n${pass} passed, ${fail} failed`);
}
main().catch((e) => { console.error(e); fail++; }).finally(async () => { await stopServer(); fakeSoundCloud.close(); setTimeout(() => { fs.rmSync(data, { recursive: true, force: true }); process.exit(fail ? 1 : 0); }, 300); });
