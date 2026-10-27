// Orata feature self-test (runs after the main self-test):  npm test
// Channel & category permission overwrites (allow / deny / inherit, sync with the category), sessions that never expire, invite cards,
// the Music player's server side (YouTube Music through ytmusicapi, against a fake helper) and the "listening to" status.
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
const base = `http://127.0.0.1:${PORT}`;
let pass = 0; let fail = 0;
const ok = (c, name, extra = '') => { if (c) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- a fake music helper (what music-service/service.py would answer) */
const HELPER = path.join(ROOT, 'server', 'selftest-music-helper.mjs'); const HELPER_LOG = path.join(data, 'music-helper.log');
const WATCH_CLIENT = path.join(ROOT, 'server', 'selftest-watch-client.mjs'); const WATCH_LOG = path.join(data, 'watch-client.log');   // stands in for YouTube.js
const helperCalls = (op) => { let list = []; try { list = fs.readFileSync(HELPER_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* nothing asked yet */ } return op ? list.filter((x) => x.op === op) : list; };
/** Starts a helper program, waits for its "ready" line, sends it `requests` and collects the answers; { error } when it can't be started. */
function talkToHelper(cmd, args, requests, ms = 20000) {
  return new Promise((resolve) => {
    let p; let buf = ''; const lines = [];
    const done = (v) => { clearTimeout(timer); try { p?.kill(); } catch { /* gone */ } resolve(v); };
    const timer = setTimeout(() => done({ lines }), ms);
    try { p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }); } catch (e) { return done({ error: e }); }
    p.on('error', (e) => done({ error: e }));
    p.on('exit', () => done({ lines }));
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => {
      buf += d;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l) continue;
        let m; try { m = JSON.parse(l); } catch { continue; }
        lines.push(m);
        if (lines.length === 1 && m.ready === true) for (const q of requests) p.stdin.write(`${JSON.stringify(q)}\n`);
        if (m.ready === false || lines.length > requests.length) return done({ lines });
      }
    });
  });
}

/* ---------------------------------------------------------------- scratch server */
// a stand-in for YouTube's video pages (Song guess reads the "Most replayed" heat map there): a spike at the start everyone replays, the real peak at 80 s,
// and no heat map at all for rainsounds2
const HEAT = Array.from({ length: 100 }, (_, i) => `{"startMillis":"${i * 2000}","durationMillis":"2000","intensityScoreNormalized":${i === 0 ? 1 : i === 40 ? 0.9 : i === 39 || i === 41 ? 0.7 : 0.2}}`).join(',');
const ytPages = http.createServer((req, res) => res.end(req.url.includes('rainsounds2') ? '<html>no heat map</html>' : `<html>{"markersList":[${HEAT}]}</html>`)).listen(0, '127.0.0.1');
let child = null;
function startServer(extra = {}) {
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), ORATE_DATA: data, HOST: '127.0.0.1', DISCORD_BOT_TOKEN: '', SMTP_HOST: '', REQUIRE_EMAIL_VERIFICATION: '', DATABASE_URL: '', KLIPY_API_KEY: '',
      MUSIC: '', MUSIC_HELPER: JSON.stringify([process.execPath, HELPER]), FAKE_MUSIC_LOG: HELPER_LOG,
      WATCH: '', WATCH_CLIENT, FAKE_WATCH_LOG: WATCH_LOG, GUESS_PAGE_URL: `http://127.0.0.1:${ytPages.address()?.port}/watch?v=`, ...extra },
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
  const r = await api('POST', '/auth/register', null, { agree: true, email, username, displayName: username[0].toUpperCase() + username.slice(1), password: 'password123', dob: { year: 1995, month: 1, day: 1 } });
  return { token: r.body.token, user: r.body.user };
};

async function main() {
  if (!ytPages.listening) await new Promise((r) => ytPages.once("listening", r));
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
  Object.assign(dbj.channels[general.id], { synced: false, overwrites: [{ type: 'role', id: S.id, allow: [], deny: ['ADD_REACTIONS'] }, { type: 'role', id: vip.id, allow: ['ADD_REACTIONS'], deny: [] }] });   // an old channel: one role denied reacting, another allowed it
  for (const u of Object.values(dbj.users)) delete u.avatarBg; dbj.avatarBgDone = undefined;   // an old database: nobody has a default-avatar gradient yet
  for (const s of Object.values(dbj.servers)) { s.permsV = undefined; for (const role of s.roles) { role.permissions = role.permissions.filter((p) => p !== 'SEND_GIFS' && p !== 'USE_REACTIONS'); if (role.id === s.id) role.permissions = role.permissions.filter((p) => p !== 'VIEW_CHANNEL'); } }   // (an old server has neither View Channel on @everyone nor the GIFs permission)
  fs.writeFileSync(dbFile, JSON.stringify(dbj));
  wb.ws.close(); wc.ws.close();
  startServer(); await ready();
  r = await api('GET', `/channels/${legacy.id}/messages`, C.token); ok(r.status === 404, 'legacy private channel still hides from non-members after the upgrade');
  r = await api('GET', `/channels/${legacy.id}/messages`, B.token); ok(r.status === 200, '… and still shows to its allowed role');
  r = await api('GET', `/channels/${general.id}/messages`, C.token); ok(r.status === 200, 'old servers regain View Channel on @everyone');
  r = await api('GET', '/me', A.token); const bgA = r.body.avatarBg; r = await api('GET', '/me', C.token);
  ok(/^#[0-9a-f]{6}$/.test(bgA?.a) && /^#[0-9a-f]{6}$/.test(bgA?.b) && typeof bgA.angle === 'number' && /^#[0-9a-f]{6}$/.test(r.body.avatarBg?.a) && JSON.stringify(bgA) !== JSON.stringify(r.body.avatarBg), 'existing accounts each got their own random default-avatar gradient when they upgraded');
  r = await api('GET', '/ready', A.token); ok(r.body.servers.every((sv) => sv.roles.filter((ro) => ro.permissions.includes('SEND_MESSAGES')).every((ro) => ro.permissions.includes('SEND_GIFS'))), 'and everybody who could send messages keeps being able to send GIFs & stickers (the new permission)');
  r = await api('GET', '/ready', A.token); ok(r.body.servers.every((sv) => sv.roles.filter((ro) => ro.permissions.includes('ADD_REACTIONS')).every((ro) => ro.permissions.includes('USE_REACTIONS'))), 'and everybody who could react keeps being able to (React to Messages, a permission of its own now, comes with Add Reactions)');
  await sleep(900); const upgraded = JSON.parse(fs.readFileSync(dbFile, 'utf8')); const rules = upgraded.channels[general.id].overwrites || [];
  ok(rules.find((o) => o.id === S.id)?.deny.join() === 'ADD_REACTIONS,USE_REACTIONS' && rules.find((o) => o.id === vip.id)?.allow.join() === 'ADD_REACTIONS,USE_REACTIONS', 'a channel that denied (or allowed) reactions still does: the new permission follows the old one in its overwrites', JSON.stringify(rules));
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
  console.log('\nMusic (YouTube Music through ytmusicapi)');
  r = await api('GET', '/config'); ok(r.body.music === true && r.body.musicWhy === null, '/api/config says music is available — without any key being set');
  r = await api('GET', '/music/search?q=night', null); ok(r.status === 401, 'search needs a login');
  r = await api('GET', '/music/search?q=night', A3);
  ok(r.status === 200 && r.body.tracks.map((x) => x.id).join() === 'nightdrive1,rainsounds2,evilartwork', 'search returns songs that have a real YouTube video id (the others are left out)', JSON.stringify(r.body).slice(0, 240));
  const t0 = r.body.tracks[0];
  ok(t0.title === 'Night Drive' && t0.artist === 'Test Artist' && t0.album === 'Test Album' && t0.artwork === 'https://i.ytimg.com/vi/nightdrive1/hqdefault.jpg' && t0.url === 'https://music.youtube.com/watch?v=nightdrive1' && t0.duration === 215000 && t0.explicit === false && r.body.tracks[1].explicit === true && r.body.tracks[1].artwork.startsWith('https://yt3.googleusercontent.com/'), 'titles, artwork, the YouTube Music link and the song length come through');
  ok(r.body.tracks[2].artwork === null, 'artwork from any other website is dropped');
  ok(r.body.artists.length === 1 && r.body.artists[0].id === 'UCtestartist000000001' && r.body.artists[0].name === 'Test Artist' && r.body.artists[0].avatar.startsWith('https://yt3.googleusercontent.com/'), 'a search also finds matching artists (with their picture; unusable ones are left out)');
  const s1 = helperCalls('search'); ok(s1.length === 1 && s1[0].q === 'night' && s1[0].limit === 40, 'one search was sent to the helper');
  await api('GET', '/music/search?q=night', A3); ok(helperCalls('search').length === 1, 'repeat searches are served from a cache');
  r = await api('GET', '/music/search?q=empty', A3); ok(r.status === 200 && r.body.tracks.length === 0, 'an empty result is an empty list');
  r = await api('GET', '/music/search?q=', A3); ok(r.status === 400, 'blank searches are rejected');
  r = await api('GET', '/music/search?q=broken', A3); ok(r.status === 502 && r.body.code === 'music_upstream' && !JSON.stringify(r.body).includes('boom'), 'when YouTube Music fails people get a plain message (the technical error stays on the server)');
  r = await api('GET', '/music/charts', null); ok(r.status === 401, 'the category list needs a login');
  r = await api('GET', '/music/charts', A3);
  ok(r.status === 200 && r.body.genres[0].key === 'top' && r.body.genres.some((g) => g.key === 'g-pop' && g.name === 'Pop' && g.group === 'genre') && r.body.genres.some((g) => g.key === 'm-chill' && g.group === 'mood') && !r.body.genres.some((g) => g.key === 'BAD KEY!'), 'the Music page has categories (charts, genres, moods; unusable keys are dropped)', JSON.stringify(r.body).slice(0, 200));
  r = await api('GET', '/music/charts/g-pop', A3); ok(r.status === 200 && r.body.tracks.length === 1 && r.body.tracks[0].id === 'popsong0001' && r.body.tracks[0].title === 'Pop Hit', 'a category lists its songs');
  r = await api('GET', '/music/charts/top', A3); ok(r.body.tracks[0].id === 'overallhit0', 'Top Songs is the overall chart');
  const catCalls = helperCalls('category').length; await api('GET', '/music/charts/g-pop', A3); ok(helperCalls('category').length === catCalls, 'categories are cached');
  r = await api('GET', '/music/charts/nonsense', A3); ok(r.status === 404 && helperCalls('category').every((x) => x.key !== 'nonsense'), 'unknown categories are refused without bothering YouTube');
  r = await api('GET', '/music/tracks/nightdrive1/source', A3); ok(r.status === 404, 'there is no audio relay: the browser plays the song in YouTube’s own player');

  console.log('\nArtist and album pages');
  const ARTIST = 'UCtestartist000000001'; const ALBUM = 'MPREbtestalbum01';
  r = await api('GET', `/music/artists/${ARTIST}`, null); ok(r.status === 401, 'artist pages need a login');
  r = await api('GET', `/music/artists/${ARTIST}`, A3);
  const ar = r.body.artist;
  ok(r.status === 200 && ar.name === 'Test Artist' && ar.subscribers === '1.2M' && ar.avatar.startsWith('https://yt3.googleusercontent.com/') && ar.banner.startsWith('https://lh3.googleusercontent.com/') && ar.songs.map((x) => x.id).join() === 'nightdrive1,rainsounds2', 'an artist page has their picture, banner, numbers and songs', JSON.stringify(r.body).slice(0, 240));
  ok(ar.albums.length === 1 && ar.albums[0].id === ALBUM && ar.albums[0].title === 'Test Album' && ar.albums[0].year === '2024' && ar.albums[0].type === 'Album', 'their albums are listed (entries without a usable id are left out)');
  ok(ar.singles.length === 1 && ar.singles[0].type === 'Single' && ar.singles[0].artwork === null, 'so are singles — and artwork from another website is dropped');
  ok(ar.songs[0].artists[0].id === ARTIST && ar.songs[0].albumId === ALBUM, 'every song knows its artist and its album, so the app can link to both');
  await api('GET', `/music/artists/${ARTIST}`, A3); ok(helperCalls('artist').length === 1, 'artist pages are cached');
  r = await api('GET', '/music/artists/UCnobodyhomehere00000', A3); ok(r.status === 404 && r.body.code === 'music_unavailable', 'an unknown artist says so');
  r = await api('GET', '/music/artists/x!', A3); ok(r.status === 400, 'a malformed artist id is refused');
  r = await api('GET', `/music/albums/${ALBUM}`, A3);
  const al = r.body.album;
  ok(r.status === 200 && al.title === 'Test Album' && al.type === 'Album' && al.year === '2024' && al.artists[0].id === ARTIST && al.duration === 400000 && al.tracks.map((x) => x.id).join() === 'nightdrive1,albumtrack2', 'an album page lists its songs in order, with its year, type and artists', JSON.stringify(r.body).slice(0, 240));
  ok(al.tracks.every((x) => x.album === 'Test Album' && x.albumId === ALBUM), 'the songs are sorted into their album');
  r = await api('GET', '/music/albums/MPREbnosuchalbum1', A3); ok(r.status === 404, 'an unknown album says so');

  console.log('\nPlaylists');
  r = await api('GET', '/me/playlists', null); ok(r.status === 401, 'playlists need a login');
  r = await api('GET', '/me/playlists', A3); ok(r.status === 200 && r.body.playlists.length === 0, 'you start with none');
  r = await api('POST', '/me/playlists', A3, { name: '   ' }); ok(r.status === 400, 'a playlist needs a name');
  const songsBefore = helperCalls('song').length;
  r = await api('POST', '/me/playlists', A3, { name: '  Road   trip  ', trackId: 'nightdrive1' });
  const pl = r.body.playlist;
  ok(r.status === 200 && pl.name === 'Road trip' && pl.count === 1 && pl.covers.length === 1, 'create one (tidied name), starting with a song');
  ok(helperCalls('song').length === songsBefore, '… songs the server has already shown need no new lookup');
  r = await api('POST', `/me/playlists/${pl.id}/tracks`, A3, { trackId: 'rainsounds2' }); ok(r.status === 200 && r.body.added === true && r.body.playlist.count === 2, 'add a song');
  r = await api('POST', `/me/playlists/${pl.id}/tracks`, A3, { trackId: 'rainsounds2' }); ok(r.body.added === false && r.body.playlist.count === 2, 'adding it again changes nothing');
  r = await api('POST', `/me/playlists/${pl.id}/tracks`, A3, { trackId: 'deepcut0001' }); ok(r.status === 200 && r.body.playlist.count === 3, 'a song the server hasn’t listed is looked up first');
  r = await api('POST', `/me/playlists/${pl.id}/tracks`, A3, { trackId: 'nosuchtrack' }); ok(r.status === 404 && r.body.code === 'music_unavailable', 'an unknown song is refused');
  r = await api('POST', `/me/playlists/${pl.id}/tracks`, A3, { trackId: 'x1' }); ok(r.status === 400, 'so is a malformed id');
  r = await api('GET', `/me/playlists/${pl.id}`, A3);
  ok(r.status === 200 && r.body.playlist.tracks.map((x) => x.id).join() === 'nightdrive1,rainsounds2,deepcut0001' && r.body.playlist.tracks[0].title === 'Night Drive' && r.body.playlist.tracks[0].url === 'https://music.youtube.com/watch?v=nightdrive1' && r.body.playlist.tracks[0].artists[0].id === ARTIST && r.body.playlist.tracks[0].albumId === ALBUM, 'it lists its songs in the order added, with artist and album links');
  r = await api('GET', '/me/playlists', D.token); ok(r.status === 200 && r.body.playlists.length === 0, 'other people never see your playlists');
  r = await api('GET', `/me/playlists/${pl.id}`, D.token); ok(r.status === 404, '… or open them');
  r = await api('POST', `/me/playlists/${pl.id}/tracks`, D.token, { trackId: 'nightdrive1' }); ok(r.status === 404, '… or add to them');
  r = await api('DELETE', `/me/playlists/${pl.id}`, D.token); ok(r.status === 404, '… or delete them');
  r = await api('PATCH', `/me/playlists/${pl.id}`, A3, { name: 'Summer' }); ok(r.status === 200 && r.body.playlist.name === 'Summer', 'rename it');
  r = await api('PATCH', `/me/playlists/${pl.id}`, A3, { name: '' }); ok(r.status === 400, '… but not to nothing');
  r = await api('DELETE', `/me/playlists/${pl.id}/tracks/rainsounds2`, A3); ok(r.status === 200 && r.body.playlist.count === 2, 'remove a song');
  r = await api('GET', '/me/playlists', A3); ok(r.body.playlists.length === 1 && r.body.playlists[0].name === 'Summer' && r.body.playlists[0].count === 2, 'the list shows it with its new name and size');
  const filler = []; for (let i = 0; i < 49; i++) filler.push((await api('POST', '/me/playlists', A3, { name: `Filler ${i}` })).status);
  ok(filler.every((c) => c === 200), 'you can have 50 playlists');
  r = await api('POST', '/me/playlists', A3, { name: 'One too many' }); ok(r.status === 400, '… and no more');
  for (const x of (await api('GET', '/me/playlists', A3)).body.playlists.filter((x) => x.name.startsWith('Filler'))) await api('DELETE', `/me/playlists/${x.id}`, A3);
  r = await api('GET', '/me/playlists', A3); ok(r.body.playlists.length === 1, 'deleting playlists frees the room again');

  console.log('\nBig music lists, page by page');
  r = await api('GET', '/music/search?q=many', A3); const sp1 = r.body;
  ok(r.status === 200 && sp1.tracks.length === 30 && sp1.hasMore === true, 'a search comes 30 songs at a time and says there is more');
  const seenIds = new Set(sp1.tracks.map((x) => x.id)); let offset = 30; let pages = 1;
  while (true) { r = await api('GET', `/music/search?q=many&offset=${offset}`, A3); for (const x of r.body.tracks) seenIds.add(x.id); offset += r.body.tracks.length; pages++; if (!r.body.hasMore || pages > 10) break; }
  ok(offset === 150 && seenIds.size === 150, 'scrolling on reaches all 150 results, none twice', `${offset} ${seenIds.size}`);
  ok(helperCalls('search').filter((x) => x.q === 'many').length === 2, '… with just two asks to YouTube Music');
  r = await api('GET', '/music/charts/g-hip-hop?limit=100', A3); ok(r.body.tracks.length === 100 && r.body.hasMore, 'a genre comes page after page');
  const hh = new Set(r.body.tracks.map((x) => x.id)); offset = 100;
  while (true) { r = await api('GET', `/music/charts/g-hip-hop?offset=${offset}&limit=100`, A3); for (const x of r.body.tracks) hh.add(x.id); offset += r.body.tracks.length; if (!r.body.hasMore) break; }
  ok(offset === 200 && hh.size === 200, 'all 200 songs of its playlists, a song in two of them only once', `${offset} ${hh.size}`);
  r = await api('GET', '/music/charts/trending?limit=60', A3); ok(r.body.tracks.length === 50 && new Set(r.body.tracks.map((x) => x.id)).size === 50 && !r.body.hasMore, 'Trending goes on past its first 20 into the playlist behind them');
  r = await api('GET', '/music/charts/g-hip-hop?offset=50&limit=10', A3); ok(r.body.tracks[0].id === 'h0000000050' && helperCalls('category').filter((x) => x.key === 'g-hip-hop').length === 4, 'pages already fetched come from the cache');

  console.log('\nPlaylists: order, library, sharing');
  await api('POST', `/me/playlists/${pl.id}/tracks`, A3, { trackId: 'rainsounds2' });
  r = await api('GET', `/me/playlists/${pl.id}`, A3); const order = r.body.playlist.tracks.map((x) => x.id);
  ok(r.body.playlist.duration === r.body.playlist.tracks.reduce((n, x) => n + x.duration, 0), 'a playlist says how long it is');
  r = await api('PUT', `/me/playlists/${pl.id}/order`, A3, { ids: [...order].reverse() }); ok(r.status === 200, 'drag a song somewhere else');
  r = await api('GET', `/me/playlists/${pl.id}`, A3); ok(r.body.playlist.tracks.map((x) => x.id).join() === [...order].reverse().join(), '… and the new order is kept');
  r = await api('PUT', `/me/playlists/${pl.id}/order`, A3, { ids: [order[0], order[0], order[1]] }); ok(r.status === 400, 'an order has to be exactly the playlist’s songs');
  r = await api('PUT', `/me/playlists/${pl.id}/order`, D.token, { ids: order }); ok(r.status === 404, 'nobody else can reorder it');
  r = await api('GET', '/me/library', A3); ok(r.status === 200 && r.body.tracks.length === order.length, '“Shuffle library” plays from every song in your playlists, once each');
  const textCh = (await api('GET', '/ready', A3)).body.servers.find((x) => x.id === S.id).channels.find((c) => c.type === 'text');
  r = await api('POST', `/channels/${textCh.id}/messages`, D.token, { playlist: { id: pl.id } }); ok(r.status === 404, 'you can only share your own playlists');
  const empty = (await api('POST', '/me/playlists', A3, { name: 'Nothing yet' })).body.playlist;
  r = await api('POST', `/channels/${textCh.id}/messages`, A3, { playlist: { id: empty.id } }); ok(r.status === 400, '… and not an empty one');
  r = await api('POST', `/channels/${textCh.id}/messages`, A3, { playlist: { id: pl.id } }); const card = r.body;
  ok(r.status === 200 && card.playlist?.name === 'Summer' && card.playlist.count === order.length && card.playlist.preview.length === order.length && card.playlist.duration > 0 && card.playlist.covers, 'share a playlist as a card in a channel');
  r = await api('GET', `/channels/${textCh.id}/messages?limit=5`, D.token); ok(r.body.messages.some((m) => m.id === card.id && m.playlist?.name === 'Summer'), 'the card is kept with the channel’s messages');
  r = await api('GET', `/channels/${textCh.id}/messages/${card.id}/playlist`, D.token); ok(r.status === 200 && r.body.playlist.tracks.length === order.length && r.body.users[0].id === r.body.playlist.ownerId, 'someone in the channel opens all its songs');
  r = await api('GET', `/channels/${textCh.id}/messages/${card.id}/playlist`, E.token); ok(r.status === 404, 'someone who can’t see the channel can’t');
  r = await api('POST', `/channels/${textCh.id}/messages/${card.id}/playlist/save`, D.token); const copy = r.body.playlist;
  ok(r.status === 200 && copy.name === 'Summer' && copy.count === order.length, 'save a copy of it');
  await api('DELETE', `/me/playlists/${copy.id}/tracks/${order[0]}`, D.token);
  r = await api('GET', `/me/playlists/${pl.id}`, A3); ok(r.body.playlist.tracks.length === order.length, '… changing the copy never touches the original');
  await api('DELETE', `/me/playlists/${empty.id}`, A3);
  r = await api('POST', `/channels/${textCh.id}/messages`, D.token, { song: { id: 'nightdrive1', title: 'Fake title', artwork: 'https://evil.example/x.png' } });
  ok(r.status === 200 && r.body.song?.title === 'Night Drive' && r.body.song.artist === 'Test Artist' && r.body.song.url === 'https://music.youtube.com/watch?v=nightdrive1' && !JSON.stringify(r.body.song).includes('evil'), '/song shares a song card, with YouTube Music’s own details');
  const songMsg = r.body.id;
  r = await api('GET', `/channels/${textCh.id}/messages?limit=5`, A3); ok(r.body.messages.some((m) => m.id === songMsg && m.song?.id === 'nightdrive1'), '… and it stays in the channel');
  r = await api('POST', `/channels/${textCh.id}/messages`, D.token, { song: { id: 'nosuchtrack' } }); ok(r.status === 404, 'a song YouTube Music doesn’t have is refused');
  r = await api('POST', `/channels/${textCh.id}/messages`, D.token, { song: { id: '<script>' } }); ok(r.status === 400, '… and so is a made-up id');

  console.log('\nListening status');
  const w1 = await connect(A3); const w2 = await connect(D.token);
  r = await api('PUT', '/me/listening', A3, { track: { id: 'nightdrive1', title: 'Night Drive' }, duration: 30000, position: 5000 });
  ok(r.status === 200 && r.body.listening?.title === 'Night Drive' && r.body.listening.artist === 'Test Artist' && r.body.listening.artwork === 'https://i.ytimg.com/vi/nightdrive1/hqdefault.jpg' && r.body.listening.url === 'https://music.youtube.com/watch?v=nightdrive1' && r.body.listening.duration === 30000 && r.body.listening.artistId === ARTIST && r.body.listening.albumId === ALBUM, 'set what you are listening to (with the artist and album, so a profile can link to them)');
  const upd = await w2.wait('user_update', (d) => d.user.listening?.title === 'Night Drive', 2000).catch(() => null);
  ok(!!upd && upd.user.listening.artist === 'Test Artist' && upd.user.listening.endsAt > Date.now(), 'people who share a server see it live, with an end time');
  r = await api('GET', `/users/${(await api('GET', '/me', A3)).body.id}`, D.token); ok(r.body.user.listening?.title === 'Night Drive', 'it is on the profile too');
  r = await api('PUT', '/me/listening', A3, { track: { id: 'nightdrive1', title: '<img src=x onerror=alert(1)>', artist: 'Somebody Else', artwork: 'https://evil.example/pixel.gif', url: 'https://evil.example/' }, duration: 30000 });
  ok(r.status === 200 && r.body.listening.title === 'Night Drive' && r.body.listening.artwork.startsWith('https://i.ytimg.com/') && r.body.listening.url.startsWith('https://music.youtube.com/'), 'titles, artwork and links come from YouTube Music via the server — whatever a client sends is ignored');
  r = await api('PUT', '/me/listening', A3, { track: { id: 'deepcut0001' }, position: 1000 });
  ok(r.status === 200 && r.body.listening.title === 'Deep Cut' && r.body.listening.duration === 187000, 'a song the server hasn’t listed yet is looked up on YouTube Music (and lasts as long as it says unless the player says otherwise)');
  r = await api('PUT', '/me/listening', A3, { track: { id: 'nosuchtrack' }, duration: 30000 }); ok(r.status === 404 && r.body.code === 'music_unavailable', 'an unknown song is refused');
  r = await api('PUT', '/me/listening', A3, { track: { id: 'x1' }, duration: 30000 }); ok(r.status === 400, 'so is a malformed id');
  await api('PATCH', '/me/settings', A3, { privacy: { showActivity: false } });
  r = await api('PUT', '/me/listening', A3, { track: { id: 'rainsounds2' }, duration: 30000 });
  r = await api('GET', `/users/${(await api('GET', '/me', A3)).body.id}`, D.token); ok(!r.body.user.listening, 'Activity Status off hides it from everybody else');
  await api('PATCH', '/me/settings', A3, { privacy: { showActivity: true } });
  await api('PUT', '/me/listening', A3, { track: { id: 'rainsounds2' }, duration: 30000 });
  r = await api('DELETE', '/me/listening', A3); ok(r.status === 200, 'stop listening');
  ok(!!(await w2.wait('user_update', (d) => d.user.listening === null, 2000).catch(() => null)), 'everyone sees it clear');
  await api('PUT', '/me/listening', A3, { track: { id: 'rainsounds2' }, duration: 60000 });
  w1.ws.close();
  const gone = await w2.wait('presence_update', (d) => d.userId === (A.user.id) && d.listening === null, 5000).catch(() => null);
  ok(!!gone, 'closing the last tab clears the status (the music stopped with it)');
  w2.ws.close();

  console.log('\nSong guess (only its testers for now)');
  const G = await register('guesser', 'g@feat.dev');
  r = await api('GET', '/music/guess', G.token); ok(r.status === 403, 'nobody but its testers can open Song guess');
  r = await api('POST', '/music/guess/round', G.token, {}); ok(r.status === 403, '… or get a song to guess');
  await stopServer();
  { const f = path.join(data, 'db.json'); const j = JSON.parse(fs.readFileSync(f, 'utf8')); j.users[G.user.id].username = 'orata_dev'; fs.writeFileSync(f, JSON.stringify(j)); }
  startServer(); await ready();
  r = await api('GET', '/music/guess', G.token);
  ok(r.status === 200 && r.body.genres.includes('Pop') && r.body.eras.includes('2010s') && r.body.artists.includes('Taylor Swift') && r.body.difficulties.join() === 'easy,medium,hard,expert,impossible', 'orata_dev gets the genres, eras, artists and difficulties');
  r = await api('POST', '/music/guess/round', G.token, { difficulty: 'easy' }); ok(r.status === 200 && r.body.song?.id === 'overallhit0' && !!r.body.song.title, 'everything left open: a song from the top chart');
  ok(r.body.start === 80, 'it plays from the most replayed part (YouTube’s heat map), not the start everyone replays', r.body.start);
  const askedFor = () => helperCalls('search').slice(-1)[0]?.q;
  const guessGot = new Set();
  const starts = {};
  for (let i = 0; i < 2; i++) { r = await api('POST', '/music/guess/round', G.token, { artist: 'Taylor Swift', difficulty: 'easy' }); if (r.body.song) { guessGot.add(r.body.song.id); starts[r.body.song.id] = r.body.start; } }
  ok(helperCalls('artist').length > 0 && guessGot.size === 2 && [...guessGot].every((id) => ['nightdrive1', 'rainsounds2'].includes(id)), 'an artist: their own list of songs, most played first, and the same one doesn’t come back for a while');
  ok(starts.rainsounds2 === 65, 'a song without a heat map plays from about a third of the way in (65 s of 215 s)', starts.rainsounds2);
  r = await api('POST', '/music/guess/round', G.token, { genre: 'Pop' }); ok(r.body.song?.id === 'popsong0001', 'a genre: YouTube Music’s own playlists for it');
  r = await api('POST', '/music/guess/round', G.token, { genre: 'Rock', era: '1980s', difficulty: 'impossible' }); ok(r.status === 200 && askedFor() === '1980s Rock hits' && !!r.body.song, 'a genre and an era: their hits; Impossible on a short list takes its deepest end');
  r = await api('POST', '/music/guess/round', G.token, { genre: 'Polka Metal' }); ok(r.status === 400, 'only the choices on the list');
  r = await api('POST', '/music/guess/round', G.token, { difficulty: 'legendary' }); ok(r.status === 400, '… and the five difficulties');

  console.log('\nRequest budget');
  await stopServer(); startServer({ MUSIC_API_PER_MIN: '4' }); await ready();
  const before = helperCalls().length;
  r = await api('GET', '/music/search?q=one', A3); const r2 = await api('GET', '/music/search?q=two', A3); r = await api('GET', '/music/search?q=three', A3);
  ok(r2.status === 200 && r.status === 429 && r.body.code === 'rate_limited' && helperCalls().length === before + 4, 'Orata never sends YouTube more than MUSIC_API_PER_MIN requests a minute, however many people search (a search asks for songs and for artists)');
  r = await api('GET', '/music/search?q=one', A3); ok(r.status === 200, '… and cached searches still work when the budget is used up');

  console.log('\nMusic helper trouble');
  await stopServer(); startServer(); await ready();
  r = await api('GET', '/me/playlists', A3); ok(r.body.playlists.length === 1 && r.body.playlists[0].name === 'Summer' && r.body.playlists[0].count === 3, 'playlists survive a restart');
  r = await api('GET', '/music/search?q=crash', A3); ok(r.status === 502 && r.body.code === 'music_upstream', 'if the helper dies in the middle of a request the person gets an error, not a hang');
  r = await api('GET', '/music/search?q=afterwards', A3); ok(r.status === 200 && r.body.tracks.length === 3, '… and the next search starts it again');
  await stopServer(); startServer({ MUSIC_HELPER: JSON.stringify(['no-such-program-for-orata-tests']) }); await ready();
  r = await api('GET', '/config'); ok(r.body.music === false && /Python/.test(r.body.musicWhy || ''), 'without Python (or the helper) /api/config says music is off and what is missing');
  r = await api('GET', '/music/search?q=night', A3); ok(r.status === 503 && r.body.code === 'music_not_configured' && /Python/.test(r.body.error), 'searching says what to install');
  r = await api('GET', '/me', A3); ok(r.status === 200, 'and the rest of Orata carries on');

  console.log('\nMusic switched off');
  await stopServer(); startServer({ MUSIC: 'off' }); await ready();
  r = await api('GET', '/config'); ok(r.body.music === false, 'MUSIC=off turns the player off');
  r = await api('GET', '/music/search?q=night', A3); ok(r.status === 503 && r.body.code === 'music_not_configured', 'and searching explains it');

  console.log('\nWatch (videos, found with YouTube.js)');
  await stopServer(); startServer({}); await ready();   // (the YouTube.js stand-in, server/selftest-watch-client.mjs, is what answers)
  const wcalls = (op) => { let list = []; try { list = fs.readFileSync(WATCH_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* nothing asked yet */ } return op ? list.filter((x) => x.op === op) : list; };
  const isId = (v) => /^[A-Za-z0-9_-]{11}$/.test(v.id) && v.title && /^https:\/\/i\.ytimg\.com\//.test(v.thumbnail);
  r = await api('GET', '/config'); ok(r.body.watch === true, '/api/config says Watch is on');
  r = await api('GET', '/watch/home'); ok(r.status === 401, 'Watch is for signed-in people');
  r = await api('GET', '/watch/home', A3);
  ok(r.status === 200 && r.body.chips[0].key === 'all' && r.body.chips.some((c) => c.key === 'music') && r.body.videos.length === 30 && r.body.hasMore === true, 'the home page offers categories and a first page of videos', JSON.stringify(r.body).slice(0, 200));
  ok(new Set(r.body.videos.map((v) => v.title.replace(/ result \d+.*/, ''))).size >= 5 && new Set(r.body.videos.map((v) => v.id)).size === r.body.videos.length && r.body.videos.every(isId), '… a mix taken from several categories, with no video twice, every one with a real id, title and thumbnail');
  const home = await api('GET', '/watch/home?chip=gaming&limit=7', A3); const home2 = await api('GET', '/watch/home?chip=gaming&limit=7&offset=7', A3); const home3 = await api('GET', '/watch/home?chip=gaming&limit=40&offset=14', A3);
  const gaming = [...home.body.videos, ...home2.body.videos, ...home3.body.videos];
  ok(home.body.videos.length === 7 && home.body.hasMore && new Set(gaming.map((v) => v.id)).size === gaming.length && gaming.length > 20 && !home3.body.hasMore, 'a category is read a page at a time, later pages come from YouTube\'s own "next page", and a video repeated across pages shows once', `${gaming.length} videos, more=${home3.body.hasMore}`);
  { const h = { authorization: 'Bearer ' + A3, 'accept-encoding': 'gzip' };
    let res2 = await fetch(`${base}/api/watch/home?chip=gaming`, { headers: h });
    ok(res2.status === 200 && /private/.test(res2.headers.get('cache-control') || '') && /max-age=300/.test(res2.headers.get('cache-control') || ''), 'what Watch finds is kept by the browser for a few minutes (so going back to a page costs nothing)', res2.headers.get('cache-control')); await res2.arrayBuffer();
    ok(res2.headers.get('content-encoding') === 'gzip', '… and goes out gzipped (a fraction of the bytes)', res2.headers.get('content-encoding'));
    res2 = await fetch(`${base}/api/watch/search?q=`, { headers: h }); ok(res2.status === 400 && !/max-age/.test(res2.headers.get('cache-control') || ''), 'an error is never kept'); await res2.arrayBuffer();
    res2 = await fetch(`${base}/js/watch.js`, { headers: h }); ok(res2.status === 200 && res2.headers.get('content-encoding') === 'gzip', 'the site’s own scripts go out gzipped too', res2.headers.get('content-encoding')); await res2.arrayBuffer();
    res2 = await fetch(`${base}/api/config`, { headers: { 'accept-encoding': 'identity' } }); ok(res2.status === 200 && !res2.headers.get('content-encoding'), '… but only for browsers that ask for it'); await res2.arrayBuffer(); }
  r = await api('GET', '/watch/home?chip=live', A3); ok(r.body.videos[0].live === true && r.body.videos[0].duration === '' && /watching/.test(r.body.videos[0].views), 'live streams are marked LIVE and have no length');
  r = await api('GET', '/watch/home?chip=nonsense', A3); ok(r.status === 404, 'an unknown category is refused');

  r = await api('GET', '/watch/search?q=lofi', A3);
  ok(r.status === 200 && r.body.videos.length === 24 && r.body.videos.every(isId) && r.body.videos[0].channel.name === 'Test Channel' && r.body.videos[0].channel.id === 'UCtestchannel00000000001' && r.body.videos[0].duration === '3:33' && r.body.videos[0].views === '1.2M views' && r.body.videos[0].published === '2 days ago',
    'search returns videos with their channel, length, views and age', JSON.stringify(r.body.videos?.[0]));
  ok(!r.body.videos.some((v) => v.title === 'Broken id' || v.title === '') && r.body.videos.find((v) => v.title === 'Stranger avatar')?.channel.avatar === null, '… leaving out shelves, broken ids and untitled things, and picture addresses from other websites');
  ok(r.body.channels.length === 1 && r.body.channels[0].name === 'Test Channel' && r.body.channels[0].handle === '@testchannel' && r.body.channels[0].subscribers === '1.2M subscribers' && r.body.channels[0].description === '', '… and the best matching channel (YouTube moves the handle and subscribers around; "N/A" is dropped)', JSON.stringify(r.body.channels));
  const searchesBefore = wcalls('search').length; await api('GET', '/watch/search?q=lofi', A3); ok(wcalls('search').length === searchesBefore, 'repeat searches come from the cache');
  r = await api('GET', '/watch/search?q=lofi&offset=24', A3); ok(r.status === 200 && r.body.channels.length === 0 && r.body.videos.length > 0 && !r.body.videos.some((v) => v.title.endsWith('result 1')), 'later pages carry on from there, without the channel again');
  r = await api('GET', '/watch/search?q=', A3); ok(r.status === 400, 'a blank search is refused');
  r = await api('GET', '/watch/search?q=explode', A3); ok(r.status === 502 && r.body.code === 'watch_upstream' && !JSON.stringify(r.body).includes('exploded'), 'when YouTube fails people get a plain message (the technical error stays on the server)');
  r = await api('GET', '/watch/suggest?q=lofi', A3); ok(r.body.suggestions.join('|') === 'lofi one|lofi two', 'the search box suggests what people search for (blanks dropped)');
  r = await api('GET', '/watch/suggest?q=', A3); ok(r.status === 200 && r.body.suggestions.length === 0, '… and suggests nothing for nothing');

  const V = 'v0000000042';
  r = await api('GET', `/watch/videos/${V}`, A3); const vd = r.body.video;
  ok(r.status === 200 && vd.id === V && vd.title === `Video ${V}` && vd.views === 1234567 && vd.likes === 4321 && vd.published === 'Oct 25, 2009' && vd.duration === 213 && vd.live === false, 'a video comes with its title, views, likes, date and length', JSON.stringify(vd));
  ok(vd.channel.id === 'UCtestchannel00000000001' && vd.channel.name === 'Test Channel' && vd.channel.subscribers === '4.55M subscribers' && /^https:\/\/yt3\.ggpht\.com\//.test(vd.channel.avatar), '… its channel (name, picture, subscribers)');
  ok(vd.description === 'line one\n\nline two https://example.com/page', '… and its description with the paragraphs kept (not three blank lines in a row)', JSON.stringify(vd.description));
  const rel = r.body.related;
  ok(rel.length === 3 && rel.every(isId) && !rel.some((x) => x.id === V) && rel[0].title === 'Related one' && rel[0].channel.name === 'Related Channel' && rel[0].channel.id === 'UCtestchannel00000000001' && rel[0].duration === '12:34' && rel[0].views === '55K views' && rel[0].published === '3 weeks ago' && rel[2].live === true,
    'related videos are read from YouTube\'s new layout too — not the video itself or playlists, and a LIVE badge marks a stream', JSON.stringify(rel.map((x) => x.title)));
  ok(vd.blocked === null, 'a normal video isn’t marked');
  r = await api('GET', '/watch/search?q=agecheck', A3); ok(r.body.videos.some((v) => v.id === 'agerestrict'), 'a video nobody has opened yet still shows in a list (nothing is known about it)');
  r = await api('GET', '/watch/videos/agerestrict', A3); ok(r.status === 200 && r.body.video.blocked === 'age', 'an age-restricted video is marked (YouTube asks people to sign in to confirm their age, which can’t happen inside Orata)');
  r = await api('GET', '/watch/videos/embedoffxxx', A3); ok(r.body.video.blocked === 'embed', 'a video whose owner switched embedding off is marked');
  r = await api('GET', '/watch/videos/botcheckxxx', A3); ok(r.body.video.blocked === null, 'a "confirm you’re not a bot" sign-in isn’t blamed on the video');
  r = await api('GET', '/watch/videos/bogusunplay', A3); ok(r.body.video.blocked === null, '… and neither is the "unavailable" YouTube says about plenty of normal videos (only a clear answer blocks anything)');
  r = await api('GET', '/watch/search?q=agecheck%20two', A3); ok(!r.body.videos.some((v) => v.id === 'agerestrict') && r.body.videos.length > 10, 'once a video is known not to play here it is left out of lists');
  const infoCalls = wcalls('info').length; await api('GET', `/watch/videos/${V}`, A3); ok(wcalls('info').length === infoCalls, 'a video that was just looked at comes from the cache');
  r = await api('GET', '/watch/videos/short', A3); ok(r.status === 400, 'something that isn\'t a video id is refused without asking YouTube');
  r = await api('GET', '/watch/videos/gone0000000', A3); ok(r.status === 404 && /isn’t available/.test(r.body.error), 'a deleted or private video says it isn\'t available');
  r = await api('GET', '/watch/videos/boom0000000', A3); ok(r.status === 502 && r.body.code === 'watch_upstream', 'any other trouble is a "try again", not a missing video');

  r = await api('GET', `/watch/videos/${V}/comments?limit=5`, A3); const c0 = r.body.comments;
  ok(r.status === 200 && c0.length === 5 && r.body.hasMore && c0[0].pinned === true && c0[0].owner === true && c0[0].author.channelId === 'UCtestchannel00000000001' && c0[1].author.channelId === null && c0[1].replies === '3' && c0[2].hearted === true && c0[0].likes === '1.5K' && c0[0].text === 'comment 0.0\nsecond line', 'comments come with who wrote them, when, likes, replies, pinned and hearted', JSON.stringify(c0[0]));
  r = await api('GET', `/watch/videos/${V}/comments?limit=20&offset=5`, A3); ok(r.body.comments.length === 11 && !r.body.hasMore && r.body.comments[0].id === 'c-0-5' && r.body.comments[3].id === 'c-1-0', 'more comments carry on from where the last page ended (across YouTube\'s pages)', JSON.stringify(r.body.comments.map((x) => x.id)));

  const CH = 'UCtestchannel00000000001';
  r = await api('GET', `/watch/channels/${CH}`, A3); const cd = r.body.channel;
  ok(r.status === 200 && cd.name === 'Test Channel' && cd.handle === '@testchannel' && cd.subscribers === '4.55M subscribers' && cd.videoCount === '437 videos' && cd.description === 'About this channel' && /googleusercontent\.com/.test(cd.banner) && /googleusercontent\.com/.test(cd.avatar), 'a channel has a name, handle, subscribers, video count, description, picture and banner', JSON.stringify(cd));
  r = await api('GET', `/watch/channels/${CH}/videos?limit=30`, A3); ok(r.status === 200 && r.body.videos.length === 24 && r.body.videos.every(isId) && r.body.videos[0].views === '55K views' && r.body.videos[0].published === '3 weeks ago' && r.body.videos[0].channel === null && !r.body.hasMore, 'its videos list (an upload has no channel line: it is all views and age)', JSON.stringify(r.body.videos?.[0]));
  r = await api('GET', '/watch/channels/UCgonegonegonegonegone00', A3); ok(r.status === 404, 'a channel that is gone says so');
  r = await api('GET', '/watch/channels/nonsense', A3); ok(r.status === 400, 'something that isn\'t a channel id is refused');

  await stopServer(); startServer({ WATCH_API_PER_MIN: '3' }); await ready();
  for (const id of ['v0000000001', 'v0000000002', 'v0000000003']) await api('GET', `/watch/videos/${id}`, A3);   // each video asks YouTube once
  r = await api('GET', '/watch/videos/v0000000004', A3); ok(r.status === 429 && r.body.code === 'rate_limited', 'Orata never sends YouTube more than WATCH_API_PER_MIN requests a minute, however many people browse');
  await stopServer(); startServer({ WATCH: 'off' }); await ready();
  r = await api('GET', '/config'); ok(r.body.watch === false, 'WATCH=off turns Watch off (and /api/config says so, which hides its buttons)');
  r = await api('GET', '/watch/home', A3); ok(r.status === 503 && r.body.code === 'watch_not_configured', '… and the pages explain it');
  await stopServer(); startServer({ WATCH_CLIENT: path.join(os.tmpdir(), 'no-such-youtube-library.mjs') }); await ready();
  r = await api('GET', '/watch/home', A3); ok(r.status === 503 && r.body.code === 'watch_not_configured' && /npm install/.test(r.body.error), 'without the library on the server the pages say what to install, and the rest of Orata carries on');
  r = await api('GET', '/config'); ok(r.status === 200, '… (the rest of Orata still answers)');

  console.log('\nWatching together in a call');
  {   // (a block of its own: this section's names stay out of the rest of the file)
  await stopServer(); startServer({ WATCH_API_PER_MIN: '1000' }); await ready();
  const movie = (await api('POST', `/servers/${S.id}/channels`, A3, { name: 'Movie Night', type: 'voice' })).body;
  const pa = await connect(A3); const pb = await connect(B.token); const pc = await connect(C.token); const pd = await connect(D.token);
  const put = (w, op, d = {}) => w.ws.send(JSON.stringify({ op, d }));
  const until = async (fn, ms = 2500) => { for (let t = 0; t < ms; t += 40) { if (fn()) return true; await sleep(40); } return false; };
  const party = (w) => {   // what this person's screen knows: the latest state, with the queue it already had when a state doesn't carry one (as public/js/party.js does)
    let cur; for (const e of w.events) {
      if (e.op === 'voice_joined' && e.d.channelId === movie.id) cur = e.d.party;
      else if (e.op === 'voice_left' && e.d.channelId === movie.id) cur = null;
      else if (e.op === 'party_state' && e.d.channelId === movie.id) { const p = e.d.party; cur = p && { ...p, queue: p.queue ?? cur?.queue ?? [] }; }
    } return cur;
  };
  const raw = (w, act) => [...w.events].reverse().find((e) => e.op === 'party_state' && e.d.party?.last?.act === act)?.d.party;   // the state as it came over the wire
  const errors = (w) => w.events.filter((e) => e.op === 'error' && e.d.party).map((e) => e.d.message);
  const vid = (n) => `v${String(n).padStart(10, '0')}`;
  const joinCall = async (w) => { const n = w.events.length; const mine = () => w.events.slice(n).find((e) => e.op === 'voice_joined' && e.d.channelId === movie.id)?.d; put(w, 'voice_join', { channelId: movie.id }); await until(mine); return mine() || null; };
  const ja = await joinCall(pa); await joinCall(pb); await joinCall(pc);
  ok(ja && ja.party === null, 'a call with nobody watching has no watch party');
  put(pd, 'party_start', { videoId: vid(1) }); await sleep(400);
  ok(!party(pa) && !errors(pd).length, 'somebody who isn’t in the call can’t start one (and nothing happens)');

  put(pb, 'party_start', { videoId: vid(1) });
  ok(await until(() => party(pa)?.current?.id === vid(1) && party(pc)?.current?.id === vid(1)), 'pressing Watch Together starts a party that everybody in the call is told about');
  let pt = party(pa);
  ok(pt.hostId === B.user.id && pt.controllers.length === 0 && pt.playing === true && pt.rate === 1 && pt.current.title === `Video ${vid(1)}` && pt.current.seconds === 213 && pt.current.addedBy === B.user.id && /^https:\/\/i\.ytimg\.com\//.test(pt.current.thumbnail), 'the first person to start it is the host, and the video starts playing (title, length and picture come from the server)', JSON.stringify(pt));
  put(pc, 'party_start', {}); await sleep(300);
  ok(party(pc).hostId === B.user.id && !errors(pc).length, 'starting it again just joins the existing party — the host stays the host');

  put(pa, 'party_add', { videoId: vid(2) }); put(pa, 'party_control', { action: 'pause', key: pt.current.key }); put(pa, 'party_stop'); put(pa, 'party_grant', { userId: A.user.id, on: true }); put(pa, 'party_skip'); await sleep(500);
  ok(errors(pa).length === 5 && errors(pa).every((m) => /host/.test(m)) && party(pa).playing === true && party(pa).queue.length === 0 && party(pa).controllers.length === 0, 'everybody else can only watch: choosing videos, pausing, ending the party, handing out control and skipping are all refused');

  { const n0 = pa.events.filter((e) => e.op === 'party_state').length; put(pa, 'party_control', { action: 'seek', key: pt.current.key, pos: 50 });
    ok(await until(() => pa.events.filter((e) => e.op === 'party_state').length > n0) && party(pa).pos < 10, 'a refused button is answered with the real state (so a screen that guessed the result is put right)'); }
  put(pb, 'party_add', { videoId: vid(2) }); put(pb, 'party_add', { videoId: vid(3) }); put(pb, 'party_add', { videoId: 'gone0000000' }); put(pb, 'party_add', { videoId: 'nonsense' });
  ok(await until(() => party(pa).queue.length === 2 && errors(pb).length === 2), 'the host adds videos to the queue (a missing or invalid one is refused)');
  ok(party(pa).queue.map((x) => x.id).join() === [vid(2), vid(3)].join() && party(pa).current.id === vid(1), '… in the order they were asked for, behind the video that is playing');

  put(pb, 'party_add', { videoId: 'agerestrict' }); put(pb, 'party_add', { videoId: 'embedoffxxx' });
  ok(await until(() => errors(pb).some((m) => /age-restricted/.test(m)) && errors(pb).some((m) => /owner/.test(m))) && party(pa).queue.length === 2, 'a video that can’t be played here (age-restricted, embedding off) is refused when somebody tries to add it');
  put(pb, 'party_grant', { userId: A.user.id, on: true });
  ok(await until(() => party(pc).controllers.includes(A.user.id)) && party(pa).hostId === B.user.id, 'the host gives somebody the right to control the video');
  put(pb, 'party_grant', { userId: B.user.id, on: true }); put(pb, 'party_grant', { userId: D.user.id, on: true }); await sleep(300);
  ok(party(pa).controllers.join() === A.user.id, '… but not to themselves or to somebody who isn’t in the call');

  pt = party(pa);
  put(pa, 'party_control', { action: 'seek', key: pt.current.key, pos: 100 });
  ok(await until(() => party(pc)?.last?.act === 'seek'), 'somebody the host allowed jumps to another spot');
  let s1 = party(pc);
  ok(s1.pos >= 100 && s1.pos < 103 && s1.playing && s1.last.by === A.user.id && s1.last.arg === 100, '… everybody is told where (about 1:40, still playing) and who did it', JSON.stringify(s1));
  ok(raw(pc, 'seek').queue === undefined && Array.isArray(raw(pc, 'add').queue) && s1.queue.length === 2, 'a state that doesn’t change the queue doesn’t carry it (the queue is the biggest part); one that does, does');
  put(pa, 'party_control', { action: 'rate', key: pt.current.key, rate: 2 });
  ok(await until(() => party(pc).rate === 2), '… and sets 2× speed');
  const rev = party(pc).rev; put(pa, 'party_control', { action: 'rate', key: pt.current.key, rate: 3 }); put(pa, 'party_control', { action: 'seek', key: pt.current.key, pos: 'soon' }); put(pa, 'party_control', { action: 'seek', key: 'stale', pos: 5 }); await sleep(400);
  ok(party(pc).rev === rev && party(pc).rate === 2, 'a speed that doesn’t exist, a position that isn’t a number and a button for an earlier video change nothing');
  const t0 = party(pc).pos; await sleep(1000); put(pc, 'voice_leave'); await sleep(300); const jc = await joinCall(pc);
  ok(Array.isArray(jc.party.queue) && jc.party.queue.length === 2, 'somebody who joins gets the whole party, queue included');
  ok(jc.party.current.id === vid(1) && jc.party.playing && jc.party.pos >= t0 + 1.5 && jc.party.pos < t0 + 4, 'somebody who joins the call a moment later is handed the video at the right moment (it ran at 2× meanwhile)', `${t0} → ${jc.party?.pos}`);
  put(pa, 'party_control', { action: 'pause', key: pt.current.key });
  ok(await until(() => party(pb)?.playing === false), 'a controller pauses it for everybody');
  const frozen = party(pb).pos; await sleep(700);
  ok(party(pb).pos === frozen && frozen >= 100, '… and the position stays where it stopped');
  put(pa, 'party_control', { action: 'seek', key: pt.current.key, pos: 99999 }); await sleep(300);
  ok(party(pb).pos === 213, 'jumping past the end stops at the end of the video');
  put(pa, 'party_control', { action: 'play', key: pt.current.key }); put(pa, 'party_control', { action: 'seek', key: pt.current.key, pos: 20 }); put(pa, 'party_control', { action: 'rate', key: pt.current.key, rate: 1 });
  ok(await until(() => party(pb).playing && party(pb).rate === 1 && party(pb).pos >= 20 && party(pb).pos < 22), 'play, jump back, normal speed');

  put(pc, 'party_ended', { key: pt.current.key }); await sleep(300);
  ok(party(pb).current.id === vid(1), 'a browser saying the video ended when it hasn’t does nothing');
  put(pb, 'party_control', { action: 'seek', key: pt.current.key, pos: 205 });
  await until(() => party(pc).pos >= 205);
  put(pc, 'party_ended', { key: pt.current.key });
  ok(await until(() => party(pa).current?.id === vid(2)), 'when the video ends (any browser can say so) the next one in the queue starts');
  pt = party(pa);
  ok(pt.queue.length === 1 && pt.pos < 2 && pt.rate === 1 && pt.playing && pt.last.act === 'next' && pt.last.by === null, '… from the beginning, at normal speed');

  put(pa, 'party_skip');
  ok(await until(() => party(pb).current?.id === vid(3) && party(pb).queue.length === 0), 'a controller skips to the next video');
  for (const n of [4, 5, 6]) put(pb, 'party_add', { videoId: vid(n) });
  await until(() => party(pb).queue.length === 3);
  const q = party(pb).queue; put(pb, 'party_move', { key: q[2].key, to: 0 }); await until(() => party(pa).queue[0]?.id === vid(6));
  ok(party(pa).queue.map((x) => x.id).join() === [vid(6), vid(4), vid(5)].join(), 'the host drags a video to the front of the queue');
  put(pb, 'party_remove', { key: party(pb).queue[1].key });
  ok(await until(() => party(pa).queue.length === 2) && party(pa).queue.map((x) => x.id).join() === [vid(6), vid(5)].join(), '… and takes one out');
  put(pa, 'party_play_now', { key: party(pa).queue[1].key });
  ok(await until(() => party(pb).current?.id === vid(5)) && party(pb).queue.map((x) => x.id).join() === vid(6) && party(pb).pos < 2, 'or plays a queued video right now');
  put(pa, 'party_add', { videoId: vid(7), now: true });
  ok(await until(() => party(pb).current?.id === vid(7)) && party(pb).queue.length === 1, 'adding with "play now" starts it at once');

  put(pc, 'party_react', { emoji: '🔥' }); put(pc, 'party_react', { emoji: 'not an emoji' });
  const heard = await pa.wait('party_react', (d) => d.userId === C.user.id, 1500).catch(() => null);
  ok(heard?.emoji === '🔥' && heard.channelId === movie.id && !pa.events.some((e) => e.op === 'party_react' && e.d.emoji === 'not an emoji'), 'anybody can send a reaction (from a short list), and everyone sees who sent it');

  put(pa, 'voice_leave'); await until(() => party(pb) && !party(pb).controllers.length);
  ok(party(pb).hostId === B.user.id && party(pb).controllers.length === 0 && party(pb).current.id === vid(7), 'a controller who leaves the call just loses the right — the party goes on');
  for (let n = 0; n < 52; n++) put(pb, 'party_add', { videoId: vid(1000 + n) });
  ok(await until(() => party(pb).queue.length === 50, 6000) && await until(() => errors(pb).some((m) => /queue is full/.test(m)), 3000), 'the queue holds 50 videos and says so when it is full');

  { const key = party(pb).current.key;
    put(pc, 'party_unplayable', { key }); await sleep(500);
    ok(party(pb).current.key === key, 'somebody who can’t skip can’t make a working video skip by claiming it won’t play');
    const title = party(pb).current.title; const left = party(pb).queue.length;
    put(pb, 'party_unplayable', { key });
    ok(await until(() => party(pb).current.key !== key && party(pb).last.act === 'blocked' && party(pb).last.by === null && party(pb).last.arg === title && party(pb).queue.length === left - 1), 'when the host’s player says a video can’t be shown, the party moves on to the next one (and says why)');
    const rev = party(pb).rev; put(pb, 'party_unplayable', { key }); await sleep(400);
    ok(party(pb).rev === rev, '… once: the same report again changes nothing'); }
  put(pb, 'voice_leave');
  ok(await until(() => party(pc) === null), 'when the host leaves the call, the watch party ends for everybody');
  const jb = await joinCall(pb); ok(jb.party === null, '… and there is nothing to join afterwards');
  put(pc, 'party_start', { videoId: vid(9) });
  ok(await until(() => party(pc)?.hostId === C.user.id && party(pb)?.current?.id === vid(9)), 'the next person to press Watch Together starts a new party and becomes the host');
  put(pc, 'party_stop');
  ok(await until(() => party(pb) === null), 'the host can end it for everybody');

  put(pc, 'party_start', { videoId: vid(10) }); await until(() => party(pb)?.current?.id === vid(10));
  put(pc, 'party_control', { action: 'seek', key: party(pb).current.key, pos: 212 });
  ok(await until(() => party(pb)?.current === null, 12000), 'if no browser says a video ended, the server moves on a few seconds later (here: to the end of the queue)');

  // stages and DMs
  r = await api('POST', `/servers/${S.id}/channels`, A3, { name: 'Town Square', type: 'stage' }); const stg = r.body;
  put(pa, 'voice_join', { channelId: stg.id }); await pa.wait('voice_joined', (d) => d.channelId === stg.id, 2000).catch(() => null);
  put(pa, 'party_start', {}); await sleep(400);
  ok(errors(pa).some((m) => /stage/.test(m)), 'a stage has no watch party (people there can still use the Watch page)');
  await joinCall(pd); for (let n = 0; n < 130; n++) put(pd, 'party_react', { emoji: '👍' });
  ok(await until(() => errors(pd).some((m) => /Slow down/.test(m))), 'sending far too many things at once is slowed down');
  for (const w of [pa, pb, pc, pd]) w.ws.close();
  await sleep(200);
  }

  console.log('\nDesktop app download');
  const dl = fs.mkdtempSync(path.join(os.tmpdir(), 'orate-desktop-'));
  await stopServer(); startServer({ DESKTOP_DIR: dl, DESKTOP_APP_URL: '', DESKTOP_APP_VERSION: '' }); await ready();
  r = await api('GET', '/config'); ok(r.body.desktop === null, 'with no installer on the server, /api/config offers none (so the website shows no download button)');
  let res = await fetch(`${base}/download/1.0.0`); ok(res.status === 404, '… and the download address says so');
  fs.writeFileSync(path.join(dl, 'Orata Setup 1.0.0.exe'), Buffer.alloc(3000, 1)); fs.writeFileSync(path.join(dl, 'Orata Setup 1.10.2.exe'), Buffer.alloc(5000, 2));
  fs.writeFileSync(path.join(dl, 'notes.txt'), 'not an installer'); fs.writeFileSync(path.join(dl, 'Orata Setup 9.9.9.exe.part'), 'unfinished'); fs.writeFileSync(path.join(dl, 'Other Setup 5.0.0.exe'), 'another program');
  await stopServer(); startServer({ DESKTOP_DIR: dl, DESKTOP_APP_URL: '', DESKTOP_APP_VERSION: '' }); await ready();
  r = await api('GET', '/config');
  ok(r.body.desktop?.version === '1.10.2' && r.body.desktop.size === 5000 && r.body.desktop.url === '/download/1.10.2', 'the newest installer is offered, at the site\'s own address /download/1.10.2 (1.10.2 beats 1.0.0; other files in the folder are ignored)', JSON.stringify(r.body.desktop));
  res = await fetch(`${base}/download/1.10.2`); const bytes = Buffer.from(await res.arrayBuffer());
  ok(res.status === 200 && bytes.length === 5000 && bytes[0] === 2 && /attachment; filename="Orata Setup 1\.10\.2\.exe"/.test(res.headers.get('content-disposition') || ''), 'it downloads without signing in, as a file called "Orata Setup 1.10.2.exe"', res.headers.get('content-disposition'));
  res = await fetch(`${base}/download/1.10.2`, { headers: { range: 'bytes=0-9' } }); ok(res.status === 206 && res.headers.get('content-range') === 'bytes 0-9/5000' && (await res.arrayBuffer()).byteLength === 10, 'a broken download can resume (Range requests are answered)');
  res = await fetch(`${base}/download/1.0.0`, { redirect: 'manual' }); ok(res.status === 302 && res.headers.get('location') === '/download/1.10.2', 'a link to an older version lands on the current one');
  res = await fetch(`${base}/download`); await res.arrayBuffer(); ok(res.status === 200, '/download alone gives the current installer');
  fs.writeFileSync(path.join(dl, 'Orata Setup 2.0.0.exe'), Buffer.alloc(7000, 3)); await sleep(5300);
  r = await api('GET', '/config'); ok(r.body.desktop?.version === '2.0.0' && r.body.desktop.size === 7000, 'a new installer dropped into the folder is picked up within seconds, with no restart');
  /* DESKTOP_APP_URL: the server fetches the file itself, so people only ever see Orata's address. The upstream below stands in for a GitHub release: its link redirects to the file, like a real one. */
  const BIG = 150_000; let hits = 0;
  const upstream = http.createServer((q, s) => {
    if (q.url === '/release/Orata%20Setup%203.1.0.exe') { s.writeHead(302, { location: '/cdn/blob' }); return s.end(); }
    if (q.url === '/cdn/blob') { hits++; s.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': BIG }); return s.end(Buffer.alloc(BIG, 7)); }
    if (q.url === '/page') { s.writeHead(200, { 'content-type': 'text/html' }); return s.end('<html>this is a web page, not the installer</html>'); }
    s.writeHead(404); s.end('nope');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve)); const up = `http://127.0.0.1:${upstream.address().port}`;
  const mirror = path.join(dl, 'mirror');
  await stopServer(); startServer({ DESKTOP_DIR: mirror, DESKTOP_APP_URL: `${up}/release/Orata%20Setup%203.1.0.exe`, DESKTOP_APP_VERSION: '' }); await ready();
  r = await api('GET', '/config'); ok(r.body.desktop?.url === '/download/3.1.0' && r.body.desktop.version === '3.1.0', 'with DESKTOP_APP_URL (a GitHub release file, say) the site still offers its own address /download/3.1.0, and reads the version from the link', JSON.stringify(r.body.desktop));
  res = await fetch(`${base}/download/3.1.0`); let got = Buffer.from(await res.arrayBuffer());
  ok(res.status === 200 && got.length === BIG && got[0] === 7 && /attachment; filename="Orata Setup 3\.1\.0\.exe"/.test(res.headers.get('content-disposition') || ''), '… and it downloads from Orata itself (no redirect away), as "Orata Setup 3.1.0.exe", though the file lives elsewhere', res.status + ' ' + res.headers.get('content-disposition'));
  res = await fetch(`${base}/download`); got = Buffer.from(await res.arrayBuffer()); ok(res.status === 200 && got.length === BIG, '/download alone gives the installer too');
  res = await fetch(`${base}/api/download/desktop`); await res.arrayBuffer(); ok(res.status === 200, '… and so does /api/download/desktop');
  ok(hits === 1 && fs.existsSync(path.join(mirror, 'Orata Setup 3.1.0.exe')), 'the server fetched it once and keeps it (not once per download)', 'fetches from the link: ' + hits);
  r = await api('GET', '/config'); ok(r.body.desktop?.size === BIG, 'once it has the file, the website knows its size');
  res = await fetch(`${base}/download/2.5.0`, { redirect: 'manual' }); ok(res.status === 302 && res.headers.get('location') === '/download/3.1.0', 'a link to an older version lands on the current one');
  await stopServer(); startServer({ DESKTOP_DIR: path.join(dl, 'dead'), DESKTOP_APP_URL: `${up}/gone.exe`, DESKTOP_APP_VERSION: '4.0.0' }); await ready();
  r = await api('GET', '/config'); ok(r.body.desktop?.version === '4.0.0' && r.body.desktop.url === '/download/4.0.0', 'DESKTOP_APP_VERSION names the version when the link doesn\'t');
  res = await fetch(`${base}/download/4.0.0`); ok(res.status === 404 && /isn’t available/.test(await res.text()), 'a link that doesn\'t work gives a plain "not available", not a broken download');
  ok(!fs.existsSync(path.join(dl, 'dead')) || fs.readdirSync(path.join(dl, 'dead')).length === 0, '… and leaves no half-downloaded file behind');
  await stopServer(); startServer({ DESKTOP_DIR: path.join(dl, 'page'), DESKTOP_APP_URL: `${up}/page`, DESKTOP_APP_VERSION: '4.0.0' }); await ready();
  res = await fetch(`${base}/download/4.0.0`); ok(res.status === 404, 'a link to a web page instead of the file is refused, not handed out as the installer');
  await stopServer(); startServer({ DESKTOP_DIR: path.join(dl, 'nothing-here'), DESKTOP_APP_URL: 'https://downloads.example.invalid/Orata-Setup.exe', DESKTOP_APP_VERSION: '1.0/../../x' }); await ready();
  r = await api('GET', '/config'); ok(r.body.desktop?.version === null && r.body.desktop.url === '/download', 'a link and version with no x.y.z in them are offered at plain /download, nothing odd in the address');
  await stopServer(); startServer({ DESKTOP_DIR: path.join(dl, 'nothing-here'), DESKTOP_APP_URL: 'http://downloads.example.com/Orata-Setup.exe' }); await ready();
  r = await api('GET', '/config'); ok(r.body.desktop === null, 'a link that is not https is ignored (so the installer can\'t be swapped on the way)');
  res = await fetch(`${base}/download/1.0.0`); ok(res.status === 404, '… and /download says there is nothing');
  upstream.close();
  fs.rmSync(dl, { recursive: true, force: true });

  /* the real helper (music-service/service.py), only the parts that need no internet: it starts, and refuses bad requests politely */
  console.log('\nThe real music helper (offline checks)');
  let real = null;
  for (const py of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) {
    real = await talkToHelper(py, [path.join(ROOT, 'music-service', 'service.py')], [{ id: 1, op: 'ping' }, { id: 2, op: 'search', q: '   ' }, { id: 3, op: 'song', videoId: 'bad!' }, { id: 4, op: 'nonsense' }]);
    if (!real.error) break;
  }
  if (real?.error || !real?.lines.length) ok(true, 'skipped: no working Python on this machine (the helper is optional)');
  else if (real.lines[0].ready === false) ok(/pip install/.test(real.lines[0].error), 'without ytmusicapi the helper says how to install it');
  else {
    const byId = Object.fromEntries(real.lines.slice(1).map((l) => [l.id, l]));
    ok(real.lines[0].ready === true && byId[1]?.result === 'pong', 'it starts and answers a ping');
    ok(byId[2]?.ok === false && byId[2].code === 'bad_request' && byId[3]?.code === 'bad_request' && byId[4]?.code === 'bad_request', 'blank searches, malformed track ids and unknown operations are refused politely');
  }

  /* ---------------------------------------------------------------- read states, "seen" faces, who is looking */
  console.log('\nRead states, "seen" faces and who is looking');
  const P = await register('pia', 'p@feat.dev'); const Q = await register('quinn', 'q@feat.dev'); const W = await register('wren', 'w@feat.dev'); const Z = await register('zed', 'z@feat.dev');
  r = await api('POST', '/dms', P.token, { recipientIds: [Q.user.id, W.user.id] }); const grp = r.body;
  ok(r.status === 200 && grp.type === 'group', 'a group DM to test with');
  r = await api('POST', `/channels/${grp.id}/messages`, P.token, { content: 'anyone here?' }); const m1 = r.body;
  r = await api('GET', '/ready', P.token); const grpView = r.body.dms.find((d) => d.id === grp.id);
  ok(r.body.readStates[grp.id]?.lastRead === m1.id && !r.body.readStates[grp.id].mentions, 'your own message counts as read (no phantom unread badge when you open the site)');
  ok(grpView?.reads?.[P.user.id] === m1.id && !grpView.reads[Q.user.id], 'a DM or group carries how far each member has read');
  const gp = await connect(P.token); const gq = await connect(Q.token); const gz = await connect(Z.token);
  await api('POST', `/channels/${grp.id}/ack`, Q.token, { messageId: m1.id });
  let ev = await gp.wait('dm_read', (d) => d.channelId === grp.id && d.userId === Q.user.id).catch(() => null);
  ok(ev?.lastRead === m1.id, 'when someone reads it, the others are told (their face moves to that message)');
  const view = (g, channelId) => g.ws.send(JSON.stringify({ op: 'view', d: { channelId } }));
  const viewers = (g, n) => g.wait('viewers', (d) => d.channelId === grp.id && d.users.length === n).then((d) => d.users.map((u) => u.id).sort().join()).catch(() => null);
  view(gp, grp.id); ok(await viewers(gp, 1) === P.user.id, 'opening a channel: you are told who is looking at it');
  gp.events.length = 0; view(gq, grp.id); ok(await viewers(gp, 2) === [P.user.id, Q.user.id].sort().join(), '… and told again when someone else opens it');
  gp.events.length = 0; gq.ws.send(JSON.stringify({ op: 'idle', d: { idle: true } })); ok(await viewers(gp, 1) === P.user.id, 'someone gone idle isn’t looking any more');
  gp.events.length = 0; gq.ws.send(JSON.stringify({ op: 'idle', d: { idle: false } })); ok(await viewers(gp, 2) !== null, '… until they are back');
  gp.events.length = 0; view(gq, null); ok(await viewers(gp, 1) === P.user.id, 'leaving the channel takes them off');
  view(gq, grp.id); await viewers(gp, 2); gp.events.length = 0; gq.ws.close(); ok(await viewers(gp, 1) === P.user.id, 'so does closing the tab');
  gp.events.length = 0; view(gz, grp.id); await sleep(400);
  ok(!gz.events.some((e) => e.op === 'viewers') && !gp.events.some((e) => e.op === 'viewers'), 'someone who can’t see the channel can’t look at it');
  gp.ws.close(); gz.ws.close();

  console.log(`\n${pass} passed, ${fail} failed`);
}
main().catch((e) => { console.error(e); fail++; }).finally(async () => { await stopServer(); setTimeout(() => { fs.rmSync(data, { recursive: true, force: true }); process.exit(fail ? 1 : 0); }, 300); });
