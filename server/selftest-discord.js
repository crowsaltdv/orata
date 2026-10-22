// Orata Discord-bridge self-test (runs with the other suites):  npm test
// Starts a fake Discord (its API and its gateway WebSocket) and an Orata server pointed at it, then links a channel and sends messages,
// pictures, edits, deletes and replies both ways, catches up after a restart, and unlinks. Then moves a Discord server's roles, channels and emoji
// into Orata with /transfer.
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'orata-discord-test-'));
const PORT = 3700 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${PORT}`;
let pass = 0; let fail = 0;
const ok = (c, name, extra = '') => { if (c) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOTTIE = { v: '5.7.4', fr: 30, ip: 0, op: 30, w: 160, h: 160, layers: [] };   // the smallest Lottie animation
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
async function until(fn, ms = 4000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(60); } }

/* ---------------------------------------------------------------- the fake Discord */
const calls = [];   // every API call Orata made: { method, path, body (parsed JSON or raw text), type }
let gw = null; let gseq = 0; let identify = null; let backlog = []; let slowDown = false; let noListForms = false;   // noListForms: refuse a form with lists once, like an old Discord   // slowDown: answer the next catch-up with Discord's "429, try again shortly\"
let sf = 1300000000000000000n; const snow = () => String(++sf);   // Discord ids grow with time
const HOOK_TOKEN = 'h'.repeat(68);
const bit = (...n) => String(n.reduce((a, b) => a | (1n << BigInt(b)), 0n));   // Discord permission bits
const GUILD = { id: '4001', name: 'Fake Guild', icon: 'abc123', emojis: [{ id: '7001', name: 'blob', animated: false }, { id: '7002', name: 'x', animated: false }],
  roles: [{ id: '4001', name: '@everyone', position: 0, permissions: bit(6, 10, 11) }, { id: '3001', name: 'Mods', position: 3, color: 0xff0000, hoist: true, permissions: bit(1, 13) },
    { id: '3002', name: 'Helpers', position: 2, color: 0x00ff00, permissions: bit(13) }, { id: '3003', name: 'VIP', position: 1, color: 0, permissions: '0' }, { id: '3004', name: 'Orata-Link', position: 4, managed: true, permissions: bit(3) }] };
const GUILD_CHANNELS = [
  { id: '2100', type: 4, name: 'Main', position: 0 },
  { id: '2001', type: 0, name: 'general', position: 0, parent_id: '2100', topic: 'say hi' },
  { id: '2101', type: 0, name: 'staff-chat', position: 1, parent_id: '2100', permission_overwrites: [{ id: '4001', type: 0, allow: '0', deny: bit(10) }, { id: '3002', type: 0, allow: bit(10), deny: '0' }, { id: '3003', type: 0, allow: bit(10), deny: '0' }, { id: '1001', type: 1, allow: bit(10), deny: '0' }] },
  { id: '2102', type: 2, name: 'Lounge', position: 2, parent_id: '2100' },
  { id: '2103', type: 0, name: 'off-topic', position: 3 },
  { id: '2104', type: 11, name: 'a thread', position: 0, parent_id: '2001' },
];
const fake = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks); const type = req.headers['content-type'] || ''; const u = new URL(req.url, 'http://x');
    let body = null; try { body = type.includes('json') ? JSON.parse(raw) : raw.toString('latin1'); } catch { body = raw.toString(); }
    if (u.pathname === '/files/cat.png' || /^\/stickers\/\d+\.png$/.test(u.pathname) || /^\/emojis\/\d+\.png$/.test(u.pathname) || u.pathname.startsWith('/icons/4001/')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG); }
    if (/^\/stickers\/\d+\.json$/.test(u.pathname)) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(LOTTIE)); }
    calls.push({ method: req.method, path: u.pathname, query: u.search, body, type, auth: req.headers.authorization });
    const json = (v, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
    const p = u.pathname.replace(/^\/api/, '');
    if (p === '/applications/900/commands') return json(req.method === 'PUT' ? body : []);
    if (/^\/channels\/\w+\/webhooks$/.test(p)) return json({ id: 'wh1', token: HOOK_TOKEN });
    if (p === '/guilds/4001') return json(GUILD);
    if (p === '/guilds/4001/channels') return json(GUILD_CHANNELS);
    if (p === `/webhooks/wh1/${HOOK_TOKEN}` && req.method === 'POST') { const id = snow(); calls[calls.length - 1].id = id; return json({ id }); }
    if (p.startsWith(`/webhooks/wh1/${HOOK_TOKEN}`)) { res.writeHead(204); return res.end(); }
    if (/^\/interactions\//.test(p) && noListForms && body?.type === 9 && body.data.components.some((c) => c.type === 18)) { noListForms = false; return json({ message: 'Invalid Form Body' }, 400); }
    if (/^\/interactions\//.test(p)) { res.writeHead(204); return res.end(); }
    if (p.startsWith('/webhooks/900/itok/')) return json({});   // filling in a "thinking…" answer
    if (p === '/channels/2003/messages') return json({ message: 'Missing Access' }, 403);   // a channel the bot can't read
    if (p === '/channels/2001/messages' && slowDown && u.searchParams.has('after')) { slowDown = false; return json({ message: 'You are being rate limited.', retry_after: 0.3, global: false }, 429); }
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
      DISCORD_BOT_TOKEN: 'fake-token', DISCORD_API: `http://127.0.0.1:${FPORT}/api`, DISCORD_GATEWAY: `ws://127.0.0.1:${FPORT}/gateway`, PUBLIC_URL: '', TRUST_PROXY: '' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}
async function ready() { for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/config'); return; } catch { await sleep(100); } } }
async function stopServer() { if (!child) return; await sleep(900); const c = child; child = null; const done = new Promise((r) => c.once('exit', r)); c.kill('SIGINT'); await Promise.race([done, sleep(3000)]); }
async function api(method, url, token, body, headers = {}) {
  const res = await fetch(base + '/api' + url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: j };
}
const register = async (username) => (await api('POST', '/auth/register', null, { agree: true, username, displayName: username[0].toUpperCase() + username.slice(1), password: 'password123', dob: { year: 1995, month: 1, day: 1 } })).body;
const hookPosts = () => calls.filter((c) => c.method === 'POST' && c.path === `/api/webhooks/wh1/${HOOK_TOKEN}`);
const said = (c) => (typeof c.body === 'string' ? JSON.parse(/name="payload_json"\r\n(?:Content-Type: [^\r]*\r\n)?\r\n([^\r]*)/.exec(c.body)?.[1] || '{}') : c.body);
const interaction = (extra) => ({ id: snow(), token: 'itok', application_id: '900', type: 2, guild_id: '4001', channel_id: '2001', channel: { id: '2001', type: 0, name: 'general' }, member: { permissions: '32', user: { id: '1007', username: 'admin7', global_name: 'Ada' } }, ...extra });
// what the bot answered on Discord: at once (type 4), or "thinking…" (type 5) filled in afterwards
const answers = () => calls.filter((c) => (c.path.startsWith('/api/interactions/') && c.body?.type === 4) || (c.method === 'PATCH' && c.path === '/api/webhooks/900/itok/messages/@original')).map((c) => ({ content: c.body.data?.content ?? c.body.content, flags: c.body.data?.flags }));

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
  let r = await cmd(B.token, 'link-instructions');
  ok(r.status === 200 && r.body.ephemeral.includes('isn’t linked') && r.body.ephemeral.includes('/orata-link code:') && r.body.ephemeral.includes('polls') && r.body.ephemeral.includes('client_id=900'), 'anyone can read /link-instructions: what comes across, how to link, and that it isn’t linked yet');
  r = await cmd(B.token, 'link'); ok(r.status === 403, 'a member without Manage Server can’t /link');
  r = await cmd(A.token, 'link'); const code = /code:([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(r.body?.ephemeral || '')?.[1];
  ok(r.status === 200 && code && r.body.ephemeral.includes('client_id=900'), '/link gives the admin a one-time code (and the link to add the bot)');
  ok(!(await msgs()).some((m) => m.content.includes(code)), '… that nobody else sees');
  dispatch('INTERACTION_CREATE', interaction({ member: { permissions: '0', user: { id: '1008', username: 'rando' } }, data: { name: 'orata-link', options: [{ name: 'code', value: code }] } }));
  let cb = await until(() => answers()[0]);
  ok(cb?.content.includes('Manage Server') && cb.flags === 64, 'on Discord, only someone who can manage the server can link (told privately)');
  dispatch('INTERACTION_CREATE', interaction({ data: { name: 'orata-link', options: [{ name: 'code', value: 'ZZZZ-ZZZZ' }] } }));
  cb = await until(() => answers()[1]); ok(cb?.content.includes('isn’t valid'), 'a wrong code is refused');
  ok(calls.some((c) => c.path.startsWith('/api/interactions/') && c.body?.type === 5 && c.body.data.flags === 64), '… after answering Discord at once with a private “thinking…” (Discord waits only 3 seconds)');
  dispatch('INTERACTION_CREATE', interaction({ channel_id: '2003', channel: { id: '2003', type: 0, name: 'secret' }, data: { name: 'orata-link', options: [{ name: 'code', value: code } ] } }));
  cb = await until(() => answers()[2]);
  ok(cb?.content.includes('Read Message History') && !calls.some((c) => c.path === '/api/channels/2003/webhooks'), 'a channel the bot can’t read isn’t linked (it says which permissions it needs)');
  dispatch('INTERACTION_CREATE', interaction({ data: { name: 'orata-link', options: [{ name: 'code', value: code.toLowerCase() } ] } }));
  cb = await until(() => answers()[3]);
  ok(cb?.content.includes('Linked with **#') && calls.some((c) => c.path === '/api/channels/2001/webhooks'), 'the right code links the channels (and makes a webhook to post with)');
  const notice = await until(async () => (await msgs()).find((m) => m.authorId === S.orbitId && /now linked/.test(m.content)));
  ok(notice?.content.includes('#general') && notice.content.includes('Fake Guild'), 'Orbit says so in the Orata channel');
  ok(!!await until(() => hookPosts().find((c) => /now linked/.test(said(c).content))), '… and the same notice shows up on Discord');
  ok(hookPosts().every((c) => !c.auth) && calls.some((c) => c.path.includes('/channels/') && c.auth === 'Bot fake-token'), 'webhook posts don’t send the bot token (a webhook’s address is its key), Discord’s API does');
  r = await cmd(B.token, 'link-instructions'); ok(r.body.ephemeral.includes('linked with **#general** in **Fake Guild**') && !r.body.ephemeral.includes('Bot status'), '/link-instructions then says which Discord channel it’s linked with');
  r = await cmd(A.token, 'link-instructions');
  ok(/Discord: connected/.test(r.body.ephemeral) && r.body.ephemeral.includes('Last Discord command: /orata-link') && r.body.ephemeral.includes('Last problem: Discord said 403'), 'admins also see the bot’s status: connected, the last command it got and the last problem (here the unreadable channel)', r.body.ephemeral.split('Bot status')[1]);

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
  r = await api('POST', `/channels/${text.id}/messages`, A.token, { content: `hey <@${B.user.id}> @everyone` }, { 'x-forwarded-proto': 'https' });   // like behind Render's proxy, without TRUST_PROXY
  const mineId = r.body.id;
  let h = await until(() => hookPosts().find((c) => said(c).content?.startsWith('hey')));
  ok(said(h).content === 'hey @Bob @everyone' && said(h).username === 'Alice', 'an Orata message goes to Discord under the sender’s name, mentions as plain names', said(h || { body: {} }).content);
  ok(said(h).avatar_url === `https://127.0.0.1:${PORT}/img/icon-192.png` && said(h).allowed_mentions?.parse.length === 0, '… with their picture from Orata’s https address, learned even behind a proxy without TRUST_PROXY (the logo without one), and it can’t ping anyone on Discord', said(h || { body: {} }).avatar_url);
  const up = await (await fetch(base + '/api/upload', { method: 'POST', headers: { authorization: 'Bearer ' + A.token, 'content-type': 'image/png', 'x-filename': 'dog.png' }, body: PNG })).json();
  r = await api('POST', `/channels/${text.id}/messages`, A.token, { content: 'look', attachments: [up] }); const lookId = r.body.id;
  h = await until(() => hookPosts().find((c) => typeof c.body === 'string' && c.body.includes('look')));
  ok(h?.type.startsWith('multipart/form-data') && h.body.includes('name="files[0]"; filename="dog.png"'), 'pictures are uploaded to Discord as real files');
  await api('PATCH', '/me', A.token, { avatar: up.url }); await api('POST', `/channels/${text.id}/messages`, A.token, { content: 'new face' });
  h = await until(() => hookPosts().find((c) => said(c).content === 'new face'));
  ok(said(h || { body: {} }).avatar_url === `https://127.0.0.1:${PORT}${up.url}`, 'an uploaded profile picture shows on Discord too', said(h || { body: {} }).avatar_url);
  const webp = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#8b5cf6' } }).webp().toBuffer();   // Orata saves cropped pictures as WebP
  const upw = await (await fetch(base + '/api/upload', { method: 'POST', headers: { authorization: 'Bearer ' + A.token, 'content-type': 'image/webp', 'x-filename': 'face.webp' }, body: webp })).json();
  await api('PATCH', '/me', A.token, { avatar: upw.url }); await api('POST', `/channels/${text.id}/messages`, A.token, { content: 'webp face' });
  h = await until(() => hookPosts().find((c) => said(c).content === 'webp face')); const pngUrl = said(h || { body: {} }).avatar_url || '';
  const png = pngUrl.startsWith(`https://127.0.0.1:${PORT}/uploads/`) && pngUrl.endsWith('.png') ? Buffer.from(await (await fetch(base + pngUrl.slice(`https://127.0.0.1:${PORT}`.length))).arrayBuffer()) : null;
  ok(png?.subarray(1, 4).toString() === 'PNG', 'a WebP profile picture goes to Discord as a PNG copy (Discord can’t show WebP ones)', pngUrl);
  await api('PATCH', `/channels/${text.id}/messages/${mineId}`, A.token, { content: 'hey (edited)' });
  const patch = await until(() => calls.find((c) => c.method === 'PATCH' && c.path.startsWith(`/api/webhooks/wh1/${HOOK_TOKEN}/messages/`)));
  ok(patch?.body.content === 'hey (edited)', 'editing in Orata edits the Discord copy');
  await api('DELETE', `/channels/${text.id}/messages/${mineId}`, A.token);
  ok(!!await until(() => calls.find((c) => c.method === 'DELETE' && c.path.includes(`/webhooks/wh1/${HOOK_TOKEN}/messages/`))), 'deleting in Orata deletes the Discord copy');

  console.log('\nGIFs');
  const gifv = (n) => ({ type: 'gifv', url: `https://tenor.com/view/cat-gif-${n}`, provider: { name: 'Tenor' }, thumbnail: { url: `https://media.tenor.com/x/cat${n}.png`, width: 220, height: 200 }, video: { url: `https://media.tenor.com/x/cat${n}.mp4`, width: 220, height: 200 } });
  const dana = { id: '1001', username: 'dana', global_name: 'Dana' };
  dispatch('MESSAGE_CREATE', { id: snow(), channel_id: '2001', guild_id: '4001', type: 0, content: 'https://tenor.com/view/cat-gif-1', author: dana, mentions: [], attachments: [], embeds: [gifv(1)] });
  const g1 = await until(async () => (await msgs()).find((m) => m.gif?.mp4 === 'https://media.tenor.com/x/cat1.mp4'));
  ok(g1 && g1.content === '' && g1.gif.w === 220, 'a GIF from Discord’s GIF picker shows as a GIF (not as its link)');
  const late = snow();
  dispatch('MESSAGE_CREATE', { id: late, channel_id: '2001', guild_id: '4001', type: 0, content: 'https://tenor.com/view/cat-gif-2', author: dana, mentions: [], attachments: [], embeds: [] });
  await until(async () => (await msgs()).find((m) => m.content === 'https://tenor.com/view/cat-gif-2'));
  dispatch('MESSAGE_UPDATE', { id: late, channel_id: '2001', guild_id: '4001', embeds: [gifv(2)] });
  const g2 = await until(async () => (await msgs()).find((m) => m.gif?.mp4 === 'https://media.tenor.com/x/cat2.mp4'));
  ok(g2 && g2.content === '' && !g2.editedAt, '… also when Discord adds the GIF a moment later (and it isn’t marked edited)');
  console.log('\nStickers');
  dispatch('MESSAGE_CREATE', { id: snow(), channel_id: '2001', guild_id: '4001', type: 0, content: '', author: dana, mentions: [], attachments: [], sticker_items: [{ id: '5001', name: 'party', format_type: 1 }] });
  const s1 = await until(async () => (await msgs()).find((m) => m.sticker?.title === 'party'));
  ok(s1?.sticker.url.startsWith('/uploads/') && !s1.sticker.lottie && (await fetch(base + s1.sticker.url)).status === 200, 'a server sticker comes across as an Orata sticker');
  dispatch('MESSAGE_CREATE', { id: snow(), channel_id: '2001', guild_id: '4001', type: 0, content: '', author: dana, mentions: [], attachments: [], sticker_items: [{ id: '5002', name: 'wave', format_type: 3 }] });
  const s2 = await until(async () => (await msgs()).find((m) => m.sticker?.title === 'wave'));
  ok(s2?.sticker.lottie && (await (await fetch(base + s2.sticker.url)).json()).w === 160, '… and Discord’s own (animated Lottie) stickers too');
  dispatch('MESSAGE_CREATE', { id: snow(), channel_id: '2001', guild_id: '4001', type: 0, content: '', author: dana, mentions: [], attachments: [], poll: { question: { text: 'Nope?' }, answers: [{ answer_id: 1, poll_media: { text: 'a' } }] } });
  await sleep(400); ok(!(await msgs()).some((m) => m.poll), 'polls aren’t mirrored');
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
  slowDown = true; identify = null; startServer(); await ready(); await until(() => identify);
  const caught = await until(async () => { const l = (await msgs()).filter((m) => /while you slept/.test(m.content)); return l.length === 2 && l; });
  ok(caught && caught[0].content.endsWith('1') && caught[1].content.endsWith('2'), 'messages sent on Discord while Orata was asleep show up, in order (even when Discord first says “slow down”)');
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

  console.log('\nMoving a Discord server into Orata');
  r = await cmd(B.token, 'transfer'); ok(r.status === 403, 'a member without Manage Server can’t /transfer');
  r = await cmd(A.token, 'help'); ok(r.status === 200 && r.body.ephemeral.includes('/transfer'), 'admins see /transfer in /help');
  calls.length = 0; identify = null; await stopServer(); startServer(); await ready(); await until(() => identify);   // a restart, to see the commands Discord gets
  const put3 = await until(() => calls.find((c) => c.method === 'PUT' && c.path === '/api/applications/900/commands'));
  ok(put3?.body.some((c) => c.name === 'transfer' && c.default_member_permissions === '32' && c.options[0].required), 'Discord gets /transfer code:…, shown only to people who can manage the server');
  const moveCode = async (chId) => /code:([A-Z0-9]{4}-[A-Z0-9]{4})/.exec((await api('POST', `/channels/${chId}/command`, A.token, { name: 'transfer', args: '' })).body?.ephemeral || '')?.[1];
  const code1 = await moveCode(text.id); ok(!!code1, 'an admin gets a one-time code from Orbit');
  const openForm = async (c, extra = {}) => { calls.length = 0; dispatch('INTERACTION_CREATE', interaction({ ...extra, data: { name: 'transfer', options: [{ name: 'code', value: c }] } })); await sleep(300); return until(() => [...calls].reverse().find((x) => x.path.startsWith('/api/interactions/') && [4, 9].includes(x.body?.type))); };
  let form = await openForm(code1, { member: { permissions: '0', user: { id: '1008', username: 'rando' } } });
  ok(form?.body.type === 4 && /Manage Server/.test(form.body.data.content), 'on Discord it needs Manage Server');
  form = await openForm('ZZZZ-ZZZZ'); ok(form?.body.type === 4 && /isn’t valid/.test(form.body.data.content), 'a wrong code says so');
  form = await openForm(code1); const fields = form?.body.data?.components || [];
  ok(form?.body.type === 9 && fields.some((f) => f.component?.custom_id === 'what' && f.component.options.some((o) => o.value === 'all' && o.label === 'Whole server')) && fields.some((f) => f.component?.type === 6) && fields.some((f) => f.component?.type === 8) && /custom roles/.test(fields[0].content),
    '/transfer opens a form: the whole server, what to move, lists of roles and channels, and the note about custom roles');
  const submit = (f, picked) => { calls.length = 0; dispatch('INTERACTION_CREATE', interaction({ type: 5, data: { custom_id: f.body.data.custom_id, components: [{ type: 10, id: 1 }, ...['what', 'roles', 'channels'].map((k, n) => ({ type: 18, component: { type: [3, 6, 8][n], custom_id: k, values: picked[k] || [] } }))] } })); };
  const summary = (re) => until(() => answers().find((a) => re.test(a.content || '')), 6000);
  submit(form, { what: ['emojis'], roles: ['3002'], channels: ['2101'] });
  let done = await summary(/Moved into|Nothing|went wrong/);
  ok(/1 role, 2 channels, 1 emoji/.test(done?.content) && /permissions for 1 role/.test(done.content) && /single members/.test(done.content), 'it moves what was picked, and says what it couldn’t', done?.content);
  let sv = (await api('GET', '/ready', A.token)).body.servers.find((x) => x.id === S.id);
  const helpers = sv.roles.find((x) => x.name === 'Helpers'); const chat = sv.channels.find((c) => c.name === 'staff-chat'); const main = sv.channels.find((c) => c.name === 'Main');
  ok(helpers?.color === '#00ff00' && helpers.permissions.includes('MANAGE_MESSAGES') && !sv.roles.some((x) => ['VIP', 'Orata-Link'].includes(x.name)), 'a moved role keeps its colour and permissions; the others (and bot roles) stay behind');
  ok(main?.type === 'category' && chat?.parentId === main.id && chat.overwrites?.length === 2 && chat.overwrites.some((o) => o.id === S.id && o.deny.includes('VIEW_CHANNEL')) && chat.overwrites.some((o) => o.id === helpers.id && o.allow.includes('VIEW_CHANNEL')),
    'a channel comes with its category and the permissions of the roles that moved', JSON.stringify(chat));
  ok(sv.emojis.some((e) => e.name === 'blob' && e.url.startsWith('/uploads/')) && sv.name === 'Bridge Town' && !sv.channels.some((c) => c.name === 'off-topic'), 'emoji come across; the name and everything not picked stay as they were');
  submit(form, { what: ['all'] }); ok(!!await summary(/ran out or was already used/), 'a code works once');
  // typed answers (the form for Discord apps without lists in forms): names instead of ids
  noListForms = true; form = await openForm(await moveCode(text.id));
  ok(form?.body.type === 9 && form.body.data.components.every((c) => c.type === 1 && c.components[0].type === 4), 'when Discord refuses lists in a form, the same questions come as typed answers');
  calls.length = 0; dispatch('INTERACTION_CREATE', interaction({ type: 5, data: { custom_id: form.body.data.custom_id, components: [['what', ''], ['roles', 'VIP, nobody'], ['channels', '#off-topic']].map(([k, v]) => ({ type: 1, components: [{ type: 4, custom_id: k, value: v }] })) } }));
  done = await summary(/Moved into|Nothing|went wrong/);
  sv = (await api('GET', '/ready', A.token)).body.servers.find((x) => x.id === S.id);
  ok(/1 role, 1 channel\b/.test(done?.content) && sv.roles.some((x) => x.name === 'VIP') && sv.channels.some((c) => c.name === 'off-topic' && !c.parentId), 'typed role and channel names work too', done?.content);
  // the whole server, into a new Orata server
  const Fs = (await api('POST', '/servers', A.token, { name: 'Fresh', orbit: true })).body; const before = Fs.channels.length;
  form = await openForm(await moveCode(Fs.channels.find((c) => c.type === 'text').id)); submit(form, { what: ['all'] });
  done = await summary(/Moved into|Nothing|went wrong/);
  sv = (await api('GET', '/ready', A.token)).body.servers.find((x) => x.id === Fs.id); const ev = sv.roles.find((x) => x.id === Fs.id);
  ok(/Moved into \*\*Fake Guild\*\*/.test(done?.content) && sv.name === 'Fake Guild' && sv.icon?.startsWith('/uploads/') && ['Mods', 'Helpers', 'VIP'].every((n) => sv.roles.some((x) => x.name === n)), 'the whole server brings its name, icon and every role', done?.content);
  ok(sv.channels.length === before + 5 && sv.channels.some((c) => c.name === 'Lounge' && c.type === 'voice') && !sv.channels.some((c) => c.name === 'a thread') && ['VIEW_CHANNEL', 'SEND_MESSAGES', 'ADD_REACTIONS'].every((p) => ev.permissions.includes(p)),
    '… every channel (threads stay behind) and @everyone’s permissions', JSON.stringify(sv.channels.map((c) => c.name)));
  ok(sv.channels.find((c) => c.name === 'staff-chat')?.overwrites?.length === 3, '… with every role’s channel permissions');
  const tlog = (await api('GET', `/servers/${Fs.id}/audit-log?action=discord_transfer`, A.token)).body.entries;
  ok(tlog.length === 1 && tlog[0].actorId === A.user.id && tlog[0].details.guild === 'Fake Guild', 'moving is in the audit log');

  await stopServer(); fake.close(); wss.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); stopServer().finally(() => process.exit(1)); });
