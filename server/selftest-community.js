// Orate community-features self-test (runs after the other suites):  npm test
// Optional emails at sign-up, bans that also block the person's network (hashed, never shown), ban reasons, timeouts, GIF icons / banners,
// custom emoji and stickers, forum channels and polls.
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

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
