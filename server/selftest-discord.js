// Orata Discord-bridge self-test (runs with the other suites):  npm test
// Starts a fake Discord (its API and its gateway WebSocket) and an Orata server pointed at it, then links a channel and sends messages,
// pictures, edits, deletes and replies both ways, catches up after a restart, and unlinks.
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'orata-discord-test-'));
const PORT = 3700 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${PORT}`;
let pass = 0; let fail = 0;
const ok = (c, name, extra = '') => { if (c) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
async function until(fn, ms = 4000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(60); } }

/* ---------------------------------------------------------------- the fake Discord */
const calls = [];   // every API call Orata made: { method, path, body (parsed JSON or raw text), type }
let gw = null; let gseq = 0; let identify = null; let backlog = [];
let sf = 1300000000000000000n; const snow = () => String(++sf);   // Discord ids grow with time
const HOOK_TOKEN = 'h'.repeat(68);
const fake = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks); const type = req.headers['content-type'] || ''; const u = new URL(req.url, 'http://x');
    let body = null; try { body = type.includes('json') ? JSON.parse(raw) : raw.toString('latin1'); } catch { body = raw.toString(); }
    if (u.pathname === '/files/cat.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG); }
    calls.push({ method: req.method, path: u.pathname, query: u.search, body, type, auth: req.headers.authorization });
    const json = (v, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
    const p = u.pathname.replace(/^\/api/, '');
    if (p === '/applications/900/commands') return json(req.method === 'PUT' ? body : []);
    if (/^\/channels\/\w+\/webhooks$/.test(p)) return json({ id: 'wh1', token: HOOK_TOKEN });
    if (p === `/webhooks/wh1/${HOOK_TOKEN}` && req.method === 'POST') { const id = snow(); calls[calls.length - 1].id = id; return json({ id }); }
    if (p.startsWith(`/webhooks/wh1/${HOOK_TOKEN}`)) { res.writeHead(204); return res.end(); }
    if (/^\/interactions\//.test(p)) { res.writeHead(204); return res.end(); }
    if (p === '/channels/2001/messages') { const after = BigInt(u.searchParams.get('after') || 0); return json(backlog.filter((m) => BigInt(m.id) > after).reverse()); }   // newest first, like Discord
    json({ message: 'Unknown' }, 404);
  });
});
const wss = new WebSocketServer({ server: fake, path: '/gateway' });
const FPORT = PORT + 100;
const dispatch = (t, d) => gw?.send(JSON.stringify({ op: 0, t, s: ++gseq, d }));
wss.on('connection', (ws) => {
  gw = ws; ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 30000 } }));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.op === 1) ws.send(JSON.stringify({ op: 11 }));
    if (m.op === 2) {
      identify = m.d;
      dispatch('READY', { session_id: 'sess1', resume_gateway_url: `ws://127.0.0.1:${FPORT}/gateway`, application: { id: '900' }, user: { id: '900', username: 'Orbit' } });
      dispatch('GUILD_CREATE', { id: '4001', name: 'Fake Guild', roles: [{ id: '3001', name: 'Mods' }], channels: [{ id: '2001', name: 'general', type: 0 }, { id: '2002', name: 'memes', type: 0 }] });
    }
  });
});

/* ---------------------------------------------------------------- Orata */
let child = null;
function startServer() {
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), ORATE_DATA: data, HOST: '127.0.0.1', SMTP_HOST: '', REQUIRE_EMAIL_VERIFICATION: '', DATABASE_URL: '', KLIPY_API_KEY: '', ACCOUNTS_PER_BROWSER: '1000', ACCOUNTS_PER_HOUR: '1000',
      DISCORD_BOT_TOKEN: 'fake-token', DISCORD_API: `http://127.0.0.1:${FPORT}/api`, DISCORD_GATEWAY: `ws://127.0.0.1:${FPORT}/gateway`, PUBLIC_URL: 'https://orata.example' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}
async function ready() { for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/config'); return; } catch { await sleep(100); } } }
async function stopServer() { if (!child) return; await sleep(900); const c = child; child = null; const done = new Promise((r) => c.once('exit', r)); c.kill('SIGINT'); await Promise.race([done, sleep(3000)]); }
async function api(method, url, token, body) {
  const res = await fetch(base + '/api' + url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: j };
}
const register = async (username) => (await api('POST', '/auth/register', null, { username, displayName: username[0].toUpperCase() + username.slice(1), password: 'password123', dob: { year: 1995, month: 1, day: 1 } })).body;
const hookPosts = () => calls.filter((c) => c.method === 'POST' && c.path === `/api/webhooks/wh1/${HOOK_TOKEN}`);
const said = (c) => (typeof c.body === 'string' ? JSON.parse(/name="payload_json"\r\n(?:Content-Type: [^\r]*\r\n)?\r\n([^\r]*)/.exec(c.body)?.[1] || '{}') : c.body);
const interaction = (extra) => ({ id: snow(), token: 'itok', type: 2, guild_id: '4001', channel_id: '2001', channel: { id: '2001', type: 0, name: 'general' }, member: { permissions: '32', user: { id: '1007', username: 'admin7', global_name: 'Ada' } }, ...extra });
const callbacks = () => calls.filter((c) => c.path.startsWith('/api/interactions/'));

async function main() {
  await new Promise((r) => fake.listen(FPORT, '127.0.0.1', r));
  startServer(); await ready();
  console.log('Orata Discord-bridge test on port', PORT);

  console.log('\nConnecting');
  await until(() => identify);
  ok(identify?.token === 'fake-token' && identify.intents === (1 | 512 | 32768), 'logs in to Discord with the token, asking for messages and their text');
  const put = await until(() => calls.find((c) => c.method === 'PUT' && c.path === '/api/applications/900/commands'));
  ok(put?.body.some((c) => c.name === 'orata-link' && c.default_member_permissions === '32') && put.body.some((c) => c.name === 'orata-unlink'), 'sets up /orata-link and /orata-unlink, shown only to people who can manage the server');
  ok((await api('GET', '/config')).body.discord === true, 'Orata says Discord linking is on');

  console.log('\nLinking');
  const A = await register('alice'); const B = await register('bob');
  const S = (await api('POST', '/servers', A.token, { name: 'Bridge Town', orbit: true })).body; const text = S.channels.find((c) => c.type === 'text');
  await api('POST', `/invites/${(await api('POST', `/servers/${S.id}/invites`, A.token, {})).body.code}/join`, B.token);
  const cmd = (tok, name) => api('POST', `/channels/${text.id}/command`, tok, { name, args: '' });
  const msgs = async () => (await api('GET', `/channels/${text.id}/messages?limit=50`, A.token)).body.messages;
  let r = await cmd(B.token, 'link'); ok(r.status === 403, 'a member without Manage Server can’t /link');
  r = await cmd(A.token, 'link'); const code = /code:([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(r.body?.ephemeral || '')?.[1];
  ok(r.status === 200 && code && r.body.ephemeral.includes('client_id=900'), '/link gives the admin a one-time code (and the link to add the bot)');
  ok(!(await msgs()).some((m) => m.content.includes(code)), '… that nobody else sees');
  dispatch('INTERACTION_CREATE', interaction({ member: { permissions: '0', user: { id: '1008', username: 'rando' } }, data: { name: 'orata-link', options: [{ name: 'code', value: code }] } }));
  let cb = await until(() => callbacks()[0]);
  ok(cb?.body.data.content.includes('Manage Server') && cb.body.data.flags === 64, 'on Discord, only someone who can manage the server can link (told privately)');
  dispatch('INTERACTION_CREATE', interaction({ data: { name: 'orata-link', options: [{ name: 'code', value: 'ZZZZ-ZZZZ' }] } }));
  cb = await until(() => callbacks()[1]); ok(cb?.body.data.content.includes('isn’t valid'), 'a wrong code is refused');
  dispatch('INTERACTION_CREATE', interaction({ data: { name: 'orata-link', options: [{ name: 'code', value: code.toLowerCase() } ] } }));
  cb = await until(() => callbacks()[2]);
  ok(cb?.body.data.content.includes('Linked with **#') && calls.some((c) => c.path === '/api/channels/2001/webhooks'), 'the right code links the channels (and makes a webhook to post with)');
  const notice = await until(async () => (await msgs()).find((m) => m.authorId === S.orbitId && /now linked/.test(m.content)));
  ok(notice?.content.includes('#general') && notice.content.includes('Fake Guild'), 'Orbit says so in the Orata channel');
  ok(!!await until(() => hookPosts().find((c) => /now linked/.test(said(c).content))), '… and the same notice shows up on Discord');

  console.log('\nDiscord → Orata');
  const d1 = snow();
  dispatch('MESSAGE_CREATE', { id: d1, channel_id: '2001', guild_id: '4001', type: 0, content: '**hi** <@1002> <:blob:123456> <#2002> <@&3001>', author: { id: '1001', username: 'dana', global_name: 'Dana', avatar: 'abc' }, member: { nick: null },
    mentions: [{ id: '1002', username: 'sam', global_name: 'Sam' }], attachments: [{ id: 'a1', filename: 'cat.png', size: PNG.length, url: `http://127.0.0.1:${FPORT}/files/cat.png`, content_type: 'image/png', width: 1, height: 1 }] });
  const m1 = await until(async () => (await msgs()).find((m) => m.bridge?.id === '1001'));
  ok(m1?.bridge.name === 'Dana' && m1.bridge.avatar === 'https://cdn.discordapp.com/avatars/1001/abc.png?size=128', 'a Discord message shows the sender’s Discord name and picture');
  ok(m1?.content === '**hi** @Sam :blob: #memes @Mods', 'formatting stays, mentions become names and custom emoji plain :name:', m1?.content);
  ok(m1?.attachments[0]?.url.startsWith('/uploads/') && (await fetch(base + m1.attachments[0].url)).status === 200, 'its picture is copied into Orata');
  dispatch('MESSAGE_CREATE', { id: snow(), channel_id: '2001', guild_id: '4001', type: 0, content: 'beep', author: { id: '1009', username: 'somebot', bot: true } });
  dispatch('MESSAGE_CREATE', { id: snow(), channel_id: '2001', guild_id: '4001', type: 0, content: 'echo', webhook_id: 'wh1', author: { id: 'wh1', username: 'Alice', bot: true } });
  await sleep(500);
  ok(!(await msgs()).some((m) => m.content === 'beep' || m.content === 'echo'), 'bots, and the bridge’s own copies, are not mirrored back');
  ok(!hookPosts().some((c) => said(c).content?.includes('hi')), '… and a Discord message isn’t sent back to Discord');

  console.log('\nOrata → Discord');
  r = await api('POST', `/channels/${text.id}/messages`, A.token, { content: `hey <@${B.user.id}> @everyone` });
  const mineId = r.body.id;
  let h = await until(() => hookPosts().find((c) => said(c).content?.startsWith('hey')));
  ok(said(h).content === 'hey @Bob @everyone' && said(h).username === 'Alice', 'an Orata message goes to Discord under the sender’s name, mentions as plain names', said(h || { body: {} }).content);
  ok(said(h).avatar_url === 'https://orata.example/img/icon-192.png' && said(h).allowed_mentions?.parse.length === 0, '… with their picture (the logo without one), and it can’t ping anyone on Discord');
  const up = await (await fetch(base + '/api/upload', { method: 'POST', headers: { authorization: 'Bearer ' + A.token, 'content-type': 'image/png', 'x-filename': 'dog.png' }, body: PNG })).json();
  r = await api('POST', `/channels/${text.id}/messages`, A.token, { content: 'look', attachments: [up] }); const lookId = r.body.id;
  h = await until(() => hookPosts().find((c) => typeof c.body === 'string' && c.body.includes('look')));
  ok(h?.type.startsWith('multipart/form-data') && h.body.includes('name="files[0]"; filename="dog.png"'), 'pictures are uploaded to Discord as real files');
  await api('PATCH', `/channels/${text.id}/messages/${mineId}`, A.token, { content: 'hey (edited)' });
  const patch = await until(() => calls.find((c) => c.method === 'PATCH' && c.path.includes('/messages/')));
  ok(patch?.body.content === 'hey (edited)', 'editing in Orata edits the Discord copy');
  await api('DELETE', `/channels/${text.id}/messages/${mineId}`, A.token);
  ok(!!await until(() => calls.find((c) => c.method === 'DELETE' && c.path.includes(`/webhooks/wh1/${HOOK_TOKEN}/messages/`))), 'deleting in Orata deletes the Discord copy');

  console.log('\nEdits, replies and deletes from Discord');
  dispatch('MESSAGE_UPDATE', { id: d1, channel_id: '2001', guild_id: '4001', content: 'hi again', mentions: [] });
  const e1 = await until(async () => (await msgs()).find((m) => m.id === m1.id && m.content === 'hi again'));
  ok(e1?.editedAt, 'editing on Discord edits the Orata copy');
  const lookOut = hookPosts().find((c) => typeof c.body === 'string' && c.body.includes('look'));   // the Discord id the fake gave the copy of “look”
  dispatch('MESSAGE_CREATE', { id: snow(), channel_id: '2001', guild_id: '4001', type: 19, content: 'nice dog', author: { id: '1003', username: 'eve', global_name: 'Eve' }, member: { nick: 'Evie' }, mentions: [],
    message_reference: { message_id: lookOut.id } });
  const rep = await until(async () => (await msgs()).find((m) => m.content === 'nice dog'));
  ok(rep?.replyTo === lookId && rep.mentions.includes(A.user.id) && rep.bridge.name === 'Evie', 'a Discord reply to an Orata message is a real reply here (and pings its author)');
  dispatch('MESSAGE_DELETE', { id: d1, channel_id: '2001', guild_id: '4001' });
  ok(!!await until(async () => !(await msgs()).some((m) => m.id === m1.id)), 'deleting on Discord deletes the Orata copy');

  console.log('\nCatching up after a restart');
  await stopServer();
  backlog = [
    { id: snow(), channel_id: '2001', type: 0, content: 'while you slept 1', author: { id: '1001', username: 'dana', global_name: 'Dana' }, mentions: [], attachments: [] },
    { id: snow(), channel_id: '2001', type: 0, content: 'while you slept 2', author: { id: '1001', username: 'dana', global_name: 'Dana' }, mentions: [], attachments: [] },
  ];
  identify = null; startServer(); await ready(); await until(() => identify);
  const caught = await until(async () => { const l = (await msgs()).filter((m) => /while you slept/.test(m.content)); return l.length === 2 && l; });
  ok(caught && caught[0].content.endsWith('1') && caught[1].content.endsWith('2'), 'messages sent on Discord while Orata was asleep show up, in order');
  calls.length = 0; identify = null; await stopServer(); startServer(); await ready(); await until(() => identify); await sleep(800);
  ok((await msgs()).filter((m) => /while you slept/.test(m.content)).length === 2, '… once');

  console.log('\nUnlinking');
  r = await cmd(A.token, 'unlink'); ok(r.status === 200, '/unlink in Orata ends the link');
  ok(!!await until(() => hookPosts().find((c) => /no longer linked with Orata/.test(said(c).content))) && !!await until(() => calls.find((c) => c.method === 'DELETE' && c.path === `/api/webhooks/wh1/${HOOK_TOKEN}`)), '… says so on Discord and removes the webhook');
  ok((await msgs()).some((m) => m.authorId === S.orbitId && /no longer linked/.test(m.content)), '… and Orbit says so here');
  dispatch('MESSAGE_CREATE', { id: snow(), channel_id: '2001', guild_id: '4001', type: 0, content: 'anyone there?', author: { id: '1001', username: 'dana' } });
  await sleep(500); ok(!(await msgs()).some((m) => m.content === 'anyone there?'), 'after that, Discord messages stop coming');
  r = await cmd(A.token, 'unlink'); ok(r.status === 400, '/unlink on a channel that isn’t linked says so');
  const log = (await api('GET', `/servers/${S.id}/audit-log?action=discord_`, A.token)).body.entries;
  ok(log.length === 2 && log.some((e) => e.action === 'discord_link' && e.actorId === A.user.id), 'linking and unlinking are in the audit log');

  await stopServer(); fake.close(); wss.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); stopServer().finally(() => process.exit(1)); });
