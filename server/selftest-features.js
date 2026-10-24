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
let child = null;
function startServer(extra = {}) {
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), ORATE_DATA: data, HOST: '127.0.0.1', DISCORD_BOT_TOKEN: '', SMTP_HOST: '', REQUIRE_EMAIL_VERIFICATION: '', DATABASE_URL: '', KLIPY_API_KEY: '',
      MUSIC: '', MUSIC_HELPER: JSON.stringify([process.execPath, HELPER]), FAKE_MUSIC_LOG: HELPER_LOG, ...extra },
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
