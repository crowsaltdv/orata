// Orata feature self-test (runs after the main self-test):  npm test
// Channel & category permission overwrites (allow / deny / inherit, sync with the category), sessions that never expire, invite cards,
// the keyless Apple Music preview player (against a fake iTunes Search server) and the "listening to" status.
import { spawn } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'orate-feat-test-'));
const PORT = 3800 + Math.floor(Math.random() * 90);
const AP_PORT = PORT + 100;
const base = `http://127.0.0.1:${PORT}`;
let pass = 0; let fail = 0;
const ok = (c, name, extra = '') => { if (c) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- a fake iTunes Search API (/search, /lookup) + preview host */
const ap = { requests: [], mediaFetches: {} };
const itunesSong = (id, name, extra = {}) => ({ wrapperType: 'track', kind: 'song', trackId: id, artistName: 'Test Artist', collectionName: 'Test Album', trackName: name, trackViewUrl: `https://music.apple.com/us/album/${name.toLowerCase().replace(/\W+/g, '-')}/55?i=${id}&uo=4`, previewUrl: `http://127.0.0.1:${AP_PORT}/media/${id}.m4a`, artworkUrl100: `https://is1-ssl.mzstatic.com/image/thumb/Music/test/${id}/100x100bb.jpg`, trackTimeMillis: 215000, trackExplicitness: 'notExplicit', ...extra });
const fakeItunes = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${AP_PORT}`);
  const js = (o, code = 200) => { res.writeHead(code, { 'content-type': 'text/javascript; charset=utf-8' }); res.end(JSON.stringify(o)); };   // the real one is served as text/javascript too
  if (url.pathname.startsWith('/media/')) {
    const id = url.pathname.split('/').pop().replace('.m4a', ''); ap.mediaFetches[id] = (ap.mediaFetches[id] || 0) + 1;
    res.writeHead(200, { 'content-type': 'audio/x-m4p', 'content-length': 20000 }); return res.end(Buffer.alloc(20000, 7));   // Apple labels previews audio/x-m4p
  }
  ap.requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), hasAuth: !!req.headers.authorization });
  if (url.pathname === '/search') {
    const term = url.searchParams.get('term');
    if (term === 'ratelimit') { res.writeHead(403); return res.end('Forbidden'); }
    if (term === 'empty') return js({ resultCount: 0, results: [] });
    return js({ resultCount: 6, results: [itunesSong(101, 'Night Drive'), itunesSong(102, 'Rain Sounds', { trackTimeMillis: 187000, trackExplicitness: 'explicit' }), itunesSong(103, 'No Preview Here', { previewUrl: undefined }), { ...itunesSong(201, 'An Album'), wrapperType: 'collection', kind: undefined }, { ...itunesSong(202, 'A Video'), kind: 'music-video' }, itunesSong(203, 'Bad Host', { previewUrl: 'https://evil.example/x.m4a' })] });
  }
  const rss = url.pathname.match(/^\/us\/rss\/topsongs\/limit=30(?:\/genre=(\d+))?\/json$/);
  if (rss) {
    const entry = (id, name) => ({ 'im:name': { label: name }, 'im:image': [{ label: `https://is1-ssl.mzstatic.com/image/thumb/Music/test/${id}/55x55bb.png` }, { label: `https://is1-ssl.mzstatic.com/image/thumb/Music/test/${id}/170x170bb.png` }], 'im:collection': { 'im:name': { label: 'Chart Album' } }, id: { label: `https://music.apple.com/us/album/x/1?i=${id}`, attributes: { 'im:id': String(id) } }, 'im:artist': { label: 'Chart Artist' }, link: [{ attributes: { rel: 'alternate', href: `https://music.apple.com/us/album/x/1?i=${id}&uo=2` } }, { attributes: { rel: 'enclosure', href: `http://127.0.0.1:${AP_PORT}/media/${id}.m4a` } }] });
    return js({ feed: { entry: [entry(rss[1] === '14' ? 301 : 300, rss[1] === '14' ? 'Pop Hit' : 'Overall Hit'), { ...entry(302, 'No Preview'), link: [] }] } });
  }
  if (url.pathname === '/lookup') {
    const id = Number(url.searchParams.get('id'));
    if (id === 104) return js({ resultCount: 1, results: [itunesSong(104, 'Deep Cut', { trackTimeMillis: 187000 })] });
    if (id === 103) return js({ resultCount: 1, results: [itunesSong(103, 'No Preview Here', { previewUrl: undefined })] });
    return js({ resultCount: 0, results: [] });
  }
  res.writeHead(404); res.end();
});

/* ---------------------------------------------------------------- scratch server */
let child = null;
function startServer(extra = {}) {
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), ORATE_DATA: data, HOST: '127.0.0.1', SMTP_HOST: '', REQUIRE_EMAIL_VERIFICATION: '', DATABASE_URL: '', KLIPY_API_KEY: '',
      MUSIC: '', MUSIC_API_BASE: `http://127.0.0.1:${AP_PORT}`, MUSIC_MEDIA_HOSTS: '127.0.0.1', ...extra },
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
  await new Promise((r) => fakeItunes.listen(AP_PORT, '127.0.0.1', r));
  startServer(); await ready();
  console.log('Orata feature test on port', PORT);

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
  for (const u of Object.values(dbj.users)) delete u.avatarBg; dbj.avatarBgDone = undefined;   // an old database: nobody has a default-avatar gradient yet
  for (const s of Object.values(dbj.servers)) { s.permsV = undefined; for (const role of s.roles) { role.permissions = role.permissions.filter((p) => p !== 'SEND_GIFS'); if (role.id === s.id) role.permissions = role.permissions.filter((p) => p !== 'VIEW_CHANNEL'); } }   // (an old server has neither View Channel on @everyone nor the GIFs permission)
  fs.writeFileSync(dbFile, JSON.stringify(dbj));
  wb.ws.close(); wc.ws.close();
  startServer(); await ready();
  r = await api('GET', `/channels/${legacy.id}/messages`, C.token); ok(r.status === 404, 'legacy private channel still hides from non-members after the upgrade');
  r = await api('GET', `/channels/${legacy.id}/messages`, B.token); ok(r.status === 200, '… and still shows to its allowed role');
  r = await api('GET', `/channels/${general.id}/messages`, C.token); ok(r.status === 200, 'old servers regain View Channel on @everyone');
  r = await api('GET', '/me', A.token); const bgA = r.body.avatarBg; r = await api('GET', '/me', C.token);
  ok(/^#[0-9a-f]{6}$/.test(bgA?.a) && /^#[0-9a-f]{6}$/.test(bgA?.b) && typeof bgA.angle === 'number' && /^#[0-9a-f]{6}$/.test(r.body.avatarBg?.a) && JSON.stringify(bgA) !== JSON.stringify(r.body.avatarBg), 'existing accounts each got their own random default-avatar gradient when they upgraded');
  r = await api('GET', '/ready', A.token); ok(r.body.servers.every((sv) => sv.roles.filter((ro) => ro.permissions.includes('SEND_MESSAGES')).every((ro) => ro.permissions.includes('SEND_GIFS'))), 'and everybody who could send messages keeps being able to send GIFs & stickers (the new permission)');

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
  console.log('\nMusic (Apple Music previews, no key)');
  r = await api('GET', '/config'); ok(r.body.music === true, '/api/config says music is available — without any key being set');
  r = await api('GET', '/music/search?q=night', null); ok(r.status === 401, 'search needs a login');
  r = await api('GET', '/music/search?q=night', A3);
  ok(r.status === 200 && r.body.tracks.map((x) => x.id).join() === '101,102', 'search returns the songs that have a preview (albums, videos, other hosts and previewless songs are left out)', JSON.stringify(r.body).slice(0, 200));
  const t0 = r.body.tracks[0];
  ok(t0.title === 'Night Drive' && t0.artist === 'Test Artist' && t0.album === 'Test Album' && t0.artwork === 'https://is1-ssl.mzstatic.com/image/thumb/Music/test/101/300x300bb.jpg' && t0.url.startsWith('https://music.apple.com/') && t0.duration === 215000 && t0.explicit === false && r.body.tracks[1].explicit === true, 'titles, artwork (upsized), the Apple Music link and the song length come through');
  ok(!JSON.stringify(r.body).includes('127.0.0.1') && !('_preview' in t0), 'the preview address stays on the server');
  const q1 = ap.requests.find((x) => x.path === '/search');
  ok(q1.query.term === 'night' && q1.query.media === 'music' && q1.query.entity === 'song' && q1.query.country === 'US' && !q1.hasAuth, 'it asked Apple\'s keyless search for songs in the US storefront, with no credentials');
  await api('GET', '/music/search?q=night', A3); ok(ap.requests.filter((x) => x.path === '/search').length === 1, 'repeat searches are served from a cache');
  r = await api('GET', '/music/search?q=empty', A3); ok(r.status === 200 && r.body.tracks.length === 0, 'an empty result is an empty list');
  r = await api('GET', '/music/search?q=', A3); ok(r.status === 400, 'blank searches are rejected');
  r = await api('GET', '/music/search?q=ratelimit', A3); ok(r.status === 429 && r.body.code === 'rate_limited', 'when Apple says "too many requests" (403) people are told to wait');
  r = await api('GET', '/music/charts', null); ok(r.status === 401, 'the category list needs a login');
  r = await api('GET', '/music/charts', A3); ok(r.status === 200 && r.body.genres[0].key === 'top' && r.body.genres.some((g) => g.key === 'hiphop' && g.name === 'Hip-Hop / Rap') && r.body.genres.length >= 15, 'the Music page has categories');
  r = await api('GET', '/music/charts/pop', A3);
  ok(r.status === 200 && r.body.tracks.length === 1 && r.body.tracks[0].id === '301' && r.body.tracks[0].title === 'Pop Hit' && r.body.tracks[0].artist === 'Chart Artist' && r.body.tracks[0].artwork.endsWith('/301/300x300bb.png') && !JSON.stringify(r.body).includes('127.0.0.1'), 'a category lists the top songs that have a preview (artwork upsized, preview address kept on the server)', JSON.stringify(r.body).slice(0, 200));
  ok(ap.requests.some((x) => x.path === '/us/rss/topsongs/limit=30/genre=14/json' && !x.hasAuth), "… from Apple's keyless genre chart");
  r = await api('GET', '/music/charts/top', A3); ok(r.body.tracks[0].id === '300', 'Top Songs is the overall chart');
  const chartCalls = ap.requests.filter((x) => x.path.includes('/rss/')).length; await api('GET', '/music/charts/pop', A3); ok(ap.requests.filter((x) => x.path.includes('/rss/')).length === chartCalls, 'charts are cached');
  r = await api('GET', '/music/charts/nonsense', A3); ok(r.status === 404, 'unknown categories are refused');
  r = await api('GET', '/music/tracks/101/source', null); ok(r.status === 401, 'asking for a play link needs a login');
  r = await api('GET', '/music/tracks/bad!id/source', A3); ok(r.status === 400, 'track ids are validated');
  r = await api('GET', '/music/tracks/101/source', A3);
  ok(r.status === 200 && r.body.type === 'audio/mp4' && r.body.preview === true && r.body.bytes === 20000 && r.body.url.startsWith('/api/music/play/101?exp='), 'the player gets a signed link; the preview was downloaded first (and labelled audio/mp4, not Apple\'s audio/x-m4p)', JSON.stringify(r.body).slice(0, 140));
  const playUrl = r.body.url;
  let st = await fetch(base + playUrl);
  ok(st.status === 200 && st.headers.get('content-type') === 'audio/mp4' && (await st.arrayBuffer()).byteLength === 20000, 'the audio plays without a bearer token (an <audio> tag cannot send one)');
  st = await fetch(base + playUrl); ok(st.status === 200 && ap.mediaFetches['101'] === 1, '… as often as needed from memory — Apple was asked once');
  st = await fetch(base + playUrl, { headers: { range: 'bytes=0-99' } });
  ok(st.status === 206 && st.headers.get('content-range') === 'bytes 0-99/20000' && (await st.arrayBuffer()).byteLength === 100, 'range requests (seeking) are answered');
  st = await fetch(base + playUrl, { headers: { range: 'bytes=15000-' } }); ok(st.status === 206 && st.headers.get('content-range') === 'bytes 15000-19999/20000', 'so are open-ended ranges');
  st = await fetch(base + playUrl, { headers: { range: 'bytes=-500' } }); ok(st.status === 206 && st.headers.get('content-range') === 'bytes 19500-19999/20000', 'and suffix ranges');
  st = await fetch(base + playUrl, { headers: { range: 'bytes=50000-60000' } }); ok(st.status === 416, 'a range past the end is refused');
  st = await fetch(base + playUrl.replace(/sig=[^&]+/, 'sig=forged')); ok(st.status === 403, 'a forged link is refused');
  st = await fetch(base + playUrl.replace(/exp=\d+/, 'exp=1')); ok(st.status === 403, 'so is a link whose time ran out or that was edited');
  st = await fetch(base + playUrl.replace('/play/101', '/play/102')); ok(st.status === 403, 'and a link cannot be reused for another track');
  r = await api('GET', '/music/tracks/103/source', A3); ok(r.status === 404 && r.body.code === 'music_unavailable', 'a song without a preview says so (the player skips it)');
  r = await api('GET', '/music/tracks/999/source', A3); ok(r.status === 404 && r.body.code === 'music_unavailable', 'so does an unknown one');
  r = await api('GET', '/music/tracks/203/source', A3); ok(r.status === 404, 'a preview on a non-Apple host is never fetched');
  ok(ap.mediaFetches['203'] === undefined, '… (the fake never saw a request for it)');

  console.log('\nListening status');
  const w1 = await connect(A3); const w2 = await connect(D.token);
  r = await api('PUT', '/me/listening', A3, { track: { id: '101', title: 'Night Drive' }, duration: 30000, position: 5000 });
  ok(r.status === 200 && r.body.listening?.title === 'Night Drive' && r.body.listening.artist === 'Test Artist' && r.body.listening.artwork.endsWith('/300x300bb.jpg') && r.body.listening.url.startsWith('https://music.apple.com/') && r.body.listening.duration === 30000, 'set what you are listening to');
  const upd = await w2.wait('user_update', (d) => d.user.listening?.title === 'Night Drive', 2000).catch(() => null);
  ok(!!upd && upd.user.listening.artist === 'Test Artist' && upd.user.listening.endsAt > Date.now(), 'people who share a server see it live, with an end time');
  r = await api('GET', `/users/${(await api('GET', '/me', A3)).body.id}`, D.token); ok(r.body.user.listening?.title === 'Night Drive', 'it is on the profile too');
  r = await api('PUT', '/me/listening', A3, { track: { id: '101', title: '<img src=x onerror=alert(1)>', artist: 'Somebody Else', artwork: 'https://evil.example/pixel.gif', url: 'https://evil.example/' }, duration: 30000 });
  ok(r.status === 200 && r.body.listening.title === 'Night Drive' && r.body.listening.artwork.startsWith('https://is1-ssl.mzstatic.com/') && r.body.listening.url.startsWith('https://music.apple.com/'), 'titles, artwork and links come from Apple via the server — whatever a client sends is ignored');
  r = await api('PUT', '/me/listening', A3, { track: { id: '104' }, position: 1000 });
  ok(r.status === 200 && r.body.listening.title === 'Deep Cut' && r.body.listening.duration === 30000, 'a song the server hasn’t listed yet is looked up on Apple (and a preview lasts 30 s unless the player says otherwise)');
  r = await api('PUT', '/me/listening', A3, { track: { id: '999' }, duration: 30000 }); ok(r.status === 404, 'an unknown song is refused');
  r = await api('PUT', '/me/listening', A3, { track: { id: 'x1' }, duration: 30000 }); ok(r.status === 400, 'so is a malformed id');
  await api('PATCH', '/me/settings', A3, { privacy: { showActivity: false } });
  r = await api('PUT', '/me/listening', A3, { track: { id: '102' }, duration: 30000 });
  r = await api('GET', `/users/${(await api('GET', '/me', A3)).body.id}`, D.token); ok(!r.body.user.listening, 'Activity Status off hides it from everybody else');
  await api('PATCH', '/me/settings', A3, { privacy: { showActivity: true } });
  await api('PUT', '/me/listening', A3, { track: { id: '102' }, duration: 30000 });
  r = await api('DELETE', '/me/listening', A3); ok(r.status === 200, 'stop listening');
  ok(!!(await w2.wait('user_update', (d) => d.user.listening === null, 2000).catch(() => null)), 'everyone sees it clear');
  await api('PUT', '/me/listening', A3, { track: { id: '102' }, duration: 60000 });
  w1.ws.close();
  const gone = await w2.wait('presence_update', (d) => d.userId === (A.user.id) && d.listening === null, 5000).catch(() => null);
  ok(!!gone, 'closing the last tab clears the status (the music stopped with it)');
  w2.ws.close();

  console.log('\nRequest budget');
  await stopServer(); startServer({ MUSIC_API_PER_MIN: '2' }); await ready();
  const before = ap.requests.length;
  r = await api('GET', '/music/search?q=one', A3); const r2 = await api('GET', '/music/search?q=two', A3); r = await api('GET', '/music/search?q=three', A3);
  ok(r2.status === 200 && r.status === 429 && r.body.code === 'rate_limited' && ap.requests.length === before + 2, 'Orata never sends Apple more than MUSIC_API_PER_MIN requests a minute, however many people search');
  r = await api('GET', '/music/search?q=one', A3); ok(r.status === 200, '… and cached searches still work when the budget is used up');

  console.log('\nMusic switched off');
  await stopServer(); startServer({ MUSIC: 'off' }); await ready();
  r = await api('GET', '/config'); ok(r.body.music === false, 'MUSIC=off turns the player off');
  r = await api('GET', '/music/search?q=night', A3); ok(r.status === 503 && r.body.code === 'music_not_configured', 'and searching explains it');

  console.log(`\n${pass} passed, ${fail} failed`);
}
main().catch((e) => { console.error(e); fail++; }).finally(async () => { await stopServer(); fakeItunes.close(); setTimeout(() => { fs.rmSync(data, { recursive: true, force: true }); process.exit(fail ? 1 : 0); }, 300); });
