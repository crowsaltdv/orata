// Orata backend self-test:  npm test
// Boots the server on a scratch port with a throw-away data dir and exercises the main flows.
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'orate-test-'));
const PORT = 3900 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${PORT}`;
const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { env: { ...process.env, PORT: String(PORT), ORATE_DATA: data, HOST: '127.0.0.1', DISCORD_BOT_TOKEN: '', SMTP_HOST: '', REQUIRE_EMAIL_VERIFICATION: '', DATABASE_URL: '', TURN_URLS: 'turn:turn.test:3478,turns:turn.test:5349', TURN_SECRET: 'test-secret', TURN_TTL: '600' }, stdio: ['ignore', 'pipe', 'inherit'] });
let pass = 0; let fail = 0;
const ok = (c, name, extra = '') => { if (c) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };

async function api(method, url, token, body, headers = {}) {
  const res = await fetch(base + '/api' + url, { method, headers: { ...(body && !(body instanceof Buffer) ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers }, body: body ? (body instanceof Buffer ? body : JSON.stringify(body)) : undefined });
  let j = null; try { j = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: j };
}
function connect(token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/gateway`); const events = []; const waiters = [];
    ws.on('open', () => ws.send(JSON.stringify({ op: 'identify', d: { token } })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw); events.push(m);
      for (const w of [...waiters]) if (w.op === m.op && (!w.fn || w.fn(m.d))) { waiters.splice(waiters.indexOf(w), 1); w.res(m.d); }
      if (m.op === 'ready') resolve({ ws, events, ready: m.d, wait: (op, fn, ms = 3000) => new Promise((res, rej) => { const f = events.find((e) => e.op === op && (!fn || fn(e.d))); if (f) return res(f.d); const w = { op, fn, res }; waiters.push(w); setTimeout(() => rej(new Error('timeout waiting for ' + op)), ms); }) });
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/config'); break; } catch { await sleep(100); } }
  console.log('Orata self-test on port', PORT);

  console.log('\nAuth');
  let r = await api('POST', '/auth/register', null, { agree: true, email: 'a@test.dev', username: 'alice', displayName: 'Alice', password: 'hunter2hunter2', dob: { year: 1999, month: 5, day: 4 } });
  ok(r.status === 200 && r.body.token, 'register alice');
  const A = r.body.token; const alice = r.body.user;
  r = await api('POST', '/auth/register', null, { agree: true, email: 'a@test.dev', username: 'alice2', displayName: 'A', password: 'hunter2hunter2', dob: { year: 1999, month: 5, day: 4 } });
  ok(r.status === 400 && r.body.code === 'email', 'duplicate email rejected');
  r = await api('POST', '/auth/register', null, { agree: true, email: 'kid@test.dev', username: 'kid', displayName: 'Kid', password: 'hunter2hunter2', dob: { year: new Date().getFullYear() - 8, month: 1, day: 1 } });
  ok(r.status === 400 && r.body.code === 'dob', 'underage rejected');
  r = await api('POST', '/auth/register', null, { agree: true, email: 'b@test.dev', username: 'bob', displayName: 'Bob', password: 'password123', dob: { year: 1995, month: 1, day: 1 } });
  const B = r.body.token; const bob = r.body.user;
  ok(!!B, 'register bob');
  r = await api('POST', '/auth/login', null, { login: 'ALICE', password: 'wrong' });
  ok(r.status === 401, 'bad password rejected');
  r = await api('POST', '/auth/login', null, { login: 'b@test.dev', password: 'password123' });
  ok(r.status === 200 && r.body.user.username === 'bob', 'login by email');

  console.log('\nGateway');
  const wa = await connect(A); const wb = await connect(B);
  ok(wa.ready.servers.length === 1 && wa.ready.servers[0].name === 'Orata Community', 'alice is in the community server');
  ok(wb.ready.servers.length === 1, 'bob auto-joined the community');
  ok(wa.ready.dms.length === 1, 'welcome DM with Orbit exists');

  console.log('\nServers & channels');
  r = await api('POST', '/servers', A, { name: 'Test Guild', template: 'gaming' });
  ok(r.status === 200 && r.body.channels.length >= 6, 'create server from template');
  const S = r.body; const text = S.channels.find((c) => c.type === 'text');
  r = await api('POST', `/servers/${S.id}/invites`, A, {});
  const code = r.body.code; ok(!!code, 'create invite');
  r = await api('POST', `/invites/${code}/join`, B);
  ok(r.status === 200 && r.body.id === S.id, 'bob joins via invite');
  const added = await wa.wait('member_add', (d) => d.serverId === S.id).catch(() => null);
  ok(!!added, 'alice receives member_add');
  r = await api('POST', `/servers/${S.id}/channels`, A, { name: 'Dev Talk', type: 'text', parentId: text.parentId });
  ok(r.body.name === 'dev-talk', 'channel names are slugified'); const dev = r.body;
  r = await api('PATCH', `/servers/${S.id}`, B, { name: 'hax' });
  ok(r.status === 403, 'non-admin cannot edit server');
  // dragging channels around the sidebar: a new order, and a channel moved into a different category
  const cats = S.channels.filter((c) => c.type === 'category').sort((a, b) => a.position - b.position);
  r = await api('PUT', `/servers/${S.id}/channel-order`, B, { items: [{ id: dev.id, position: 0, parentId: null }] });
  ok(r.status === 403, 'non-admin cannot reorder channels');
  r = await api('PUT', `/servers/${S.id}/channel-order`, A, { items: [{ id: dev.id, position: 0, parentId: cats[1].id }, { id: cats[1].id, position: 0, parentId: null }, { id: cats[0].id, position: 1, parentId: 'x' }] });
  const moved = await wa.wait('server_update', (d) => d.server.id === S.id && d.server.channels.find((c) => c.id === dev.id)?.parentId === cats[1].id).catch(() => null);
  const chOf = (id) => moved?.server.channels.find((c) => c.id === id);
  ok(r.status === 200 && !!moved, 'reorder channels: members hear about the new order');
  ok(chOf(dev.id)?.position === 0 && chOf(cats[1].id)?.position === 0 && chOf(cats[0].id)?.position === 1 && chOf(cats[0].id)?.parentId == null, 'reorder channels: positions saved (a category stays top-level)');
  r = await api('PUT', `/servers/${S.id}/channel-order`, A, { items: [{ id: dev.id, position: 3, parentId: '123' }, { id: '999', position: 1, parentId: null }] });
  const back = await wa.wait('server_update', (d) => d.server.id === S.id && d.server.channels.find((c) => c.id === dev.id)?.position === 3).catch(() => null);
  ok(r.status === 200 && back?.server.channels.find((c) => c.id === dev.id)?.parentId == null, 'reorder channels: unknown categories and channels are ignored');

  console.log('\nMessages');
  r = await api('POST', `/channels/${text.id}/messages`, B, { content: `hello <@${alice.id}> **world** https://example.com`, nonce: 'n1' });
  ok(r.status === 200 && r.body.mentions.includes(alice.id), 'post message with mention');
  const ev = await wa.wait('message_create', (d) => d.message.channelId === text.id && d.message.content.startsWith('hello'));
  ok(ev.message.content.startsWith('hello') && ev.message.nonce === 'n1', 'alice receives message_create');
  const mid = r.body.id;
  r = await api('PUT', `/channels/${text.id}/messages/${mid}/reactions/${encodeURIComponent('🔥')}/@me`, A);
  ok(r.status === 200, 'react');
  ok(!!(await wb.wait('reaction_add', (d) => d.messageId === mid).catch(() => null)), 'bob receives reaction_add');
  r = await api('PATCH', `/channels/${text.id}/messages/${mid}`, B, { content: 'edited' });
  ok(r.body.editedAt, 'edit own message');
  r = await api('PATCH', `/channels/${text.id}/messages/${mid}`, A, { content: 'nope' });
  ok(r.status === 403, "cannot edit someone else's message");
  r = await api('PUT', `/channels/${text.id}/pins/${mid}`, A);
  ok(r.status === 200, 'pin message (owner)');
  r = await api('GET', `/channels/${text.id}/pins`, A);
  ok(r.body.messages.length === 1, 'pins listed');
  r = await api('GET', `/channels/${text.id}/messages?limit=10`, A);
  ok(r.body.messages.length >= 2, 'history fetch');
  r = await api('GET', `/search?serverId=${S.id}&q=edited`, A);
  ok(r.body.results.length === 1, 'search finds message');
  r = await api('POST', `/channels/${text.id}/messages`, A, { content: 'reply!', replyTo: mid });
  ok(r.body.reply?.id === mid && r.body.mentions.includes(bob.id), 'reply includes reference + ping');
  r = await api('DELETE', `/channels/${text.id}/messages/${mid}`, A);
  ok(r.status === 200, 'owner can delete others messages');

  console.log('\nFriends & DMs');
  r = await api('POST', '/relationships', A, { username: 'bob' });
  ok(r.status === 200, 'friend request');
  ok(!!(await wb.wait('relationship_update', (d) => d.type === 'incoming').catch(() => null)), 'bob sees incoming request');
  r = await api('PUT', `/relationships/${alice.id}`, B);
  ok(r.status === 200, 'accept request');
  r = await api('POST', '/dms', A, { recipientId: bob.id });
  ok(r.body.type === 'dm', 'open DM');
  const dm = r.body;
  r = await api('POST', `/channels/${dm.id}/messages`, A, { content: 'psst' });
  ok(!!(await wb.wait('message_create', (d) => d.message.channelId === dm.id).catch(() => null)), 'DM delivered');
  const orbitDm = wa.ready.dms[0];
  r = await api('POST', `/channels/${orbitDm.id}/messages`, A, { content: 'ping' });
  const pong = await wa.wait('message_create', (d) => d.message.channelId === orbitDm.id && d.message.content.includes('Pong'), 4000).catch(() => null);
  ok(!!pong, 'Orbit replies to ping');
  r = await api('POST', '/dms', A, { recipientIds: [bob.id, wa.ready.botId], name: 'trio' });
  ok(r.body.type === 'group', 'group DM created');

  console.log('\nUploads, GIFs, fonts');
  r = await api('POST', '/upload', A, Buffer.from('hello world'), { 'x-filename': 'hi.txt', 'content-type': 'text/plain' });
  ok(r.status === 200 && r.body.url.startsWith('/uploads/'), 'upload file');
  const up = r.body;
  r = await api('POST', `/channels/${text.id}/messages`, A, { content: '', attachments: [up] });
  ok(r.body.attachments?.length === 1 && r.body.attachments[0].size === 11, 'attachment message');
  const f = await fetch(base + up.url);
  ok(f.status === 200, 'uploaded file is served');
  // Lite mode's smaller pictures, and the page asking for every start-up module at once
  r = await api('POST', '/upload', A, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'), { 'x-filename': 'dot.png', 'content-type': 'image/png' });
  const small = await fetch(`${base}/thumbs/96/${r.body.url.slice('/uploads/'.length)}`);
  ok(small.status === 200 && small.headers.get('content-type') === 'image/webp', 'an uploaded picture has a small copy for Lite mode');
  ok((await fetch(`${base}/thumbs/97/${r.body.url.slice('/uploads/'.length)}`)).status === 404 && (await fetch(`${base}/thumbs/96/..%2Fdb.json`)).status === 404, '… only at the set sizes, and only for uploads');
  r = await api('POST', '/upload', A, Buffer.from('R0lGODlhAQABAIAAAP8AAAAA/yH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAQABAAACAkQBACH5BAAKAAAALAAAAAABAAEAAAICTAEAOw==', 'base64'), { 'x-filename': 'blink.gif', 'content-type': 'image/gif' });   // two frames, red then blue
  const smallGif = Buffer.from(await (await fetch(`${base}/thumbs/96/${r.body.url.slice('/uploads/'.length)}`)).arrayBuffer());
  ok((await sharp(smallGif, { animated: true }).metadata()).pages === 2, '… and an animated GIF (avatar, banner…) stays animated');
  ok((await (await fetch(base + '/channels/@me')).text()).includes('<link rel="modulepreload" href="/js/app.js"'), 'the page asks for every start-up module at once');
  r = await api('GET', '/gifs?mode=trending&per_page=4', A);
  ok(r.status === 200 && r.body.items?.length > 0, 'GIF trending via KLIPY', JSON.stringify(r.body).slice(0, 120));
  if (r.body.items?.[0]) {
    const g = r.body.items[0];
    r = await api('POST', `/channels/${text.id}/messages`, A, { content: '', gif: { id: g.id, title: g.title, url: g.full.url, mp4: g.full.mp4, gif: g.full.gif, poster: g.full.poster, w: g.w, h: g.h } });
    ok(r.status === 200 && r.body.gif, 'send GIF message');
  }
  r = await api('GET', '/gifs?type=stickers&mode=search&q=hello&per_page=4', A);
  ok(r.status === 200 && r.body.items?.length > 0, 'sticker search');
  r = await api('GET', '/fonts', A);
  ok(Array.isArray(r.body) && r.body.length > 500, 'fonts list');

  console.log('\nSettings & profile');
  r = await api('PATCH', '/me', A, { displayName: 'Alice ✨', bio: 'hi', status: 'dnd', customStatus: { emoji: '🎧', text: 'coding' }, tag: { text: 'orat' } });
  ok(r.body.displayName === 'Alice ✨' && r.body.customStatus.text === 'coding' && !r.body.tag, 'update profile (you can’t set your own tag)');
  r = await api('PATCH', '/me/settings', A, { theme: { accent: '#ff00aa' } });
  ok(r.body.theme.accent === '#ff00aa', 'sync settings');
  r = await api('POST', '/me/password', A, { current: 'hunter2hunter2', password: 'new-password-123' });
  ok(r.status === 200, 'change password');
  r = await api('POST', '/auth/login', null, { login: 'alice', password: 'new-password-123' });
  ok(r.status === 200, 'login with new password');
  r = await api('GET', '/me', 'garbage');
  ok(r.status === 401, 'bad token rejected');

  console.log('\nSafety & sync');
  r = await fetch(base + '/api/img?url=' + encodeURIComponent('http://127.0.0.1:9/x.png'));
  ok(r.status >= 400, 'image proxy refuses private addresses', String(r.status));
  r = await api('PATCH', '/me/settings', A, { theme: { accent: '#00ff88' } }, { 'x-conn': wa.ready.connId });
  ok(!(await wb.wait('settings_update', null, 700).catch(() => null)), 'other users never receive settings events');
  ok(!(await wa.wait('settings_update', (d) => d.settings.theme?.accent === '#00ff88', 700).catch(() => null)), 'originating connection does not get its own settings echo');
  const wa2 = await connect(A);
  r = await api('PATCH', '/me/settings', A, { theme: { accent: '#ff8800' } }, { 'x-conn': wa.ready.connId });
  ok(!!(await wa2.wait('settings_update', (d) => d.settings.theme?.accent === '#ff8800', 1500).catch(() => null)), 'other devices receive the settings update');
  wa2.ws.close();

  console.log('\nICE / TURN');
  r = await api('GET', '/ice', A);
  const turnEntry = r.body.iceServers?.find((s) => s.username);
  ok(r.status === 200 && r.body.iceServers[0].urls.some((u) => u.startsWith('stun:')), 'STUN servers are always offered');
  ok(turnEntry?.urls.length === 2 && turnEntry.urls[0] === 'turn:turn.test:3478', 'TURN urls come from TURN_URLS');
  const [exp, uid] = (turnEntry?.username || '').split(':');
  ok(uid === alice.id && Number(exp) > Date.now() / 1000 && Number(exp) <= Date.now() / 1000 + 601, 'TURN username is "<expiry>:<userId>" with the configured TTL');
  ok(turnEntry?.credential === crypto.createHmac('sha1', 'test-secret').update(turnEntry.username).digest('base64'), 'TURN credential is HMAC-SHA1(secret, username)');
  r = await api('GET', '/ice', null);
  ok(r.status === 401, '/api/ice requires sign-in');
  r = await api('GET', '/config');
  ok(r.body.turn === true, '/api/config advertises TURN');

  console.log('\nVoice');
  wa.ws.send(JSON.stringify({ op: 'voice_join', d: { channelId: S.channels.find((c) => c.type === 'voice').id } }));
  ok(!!(await wa.wait('voice_joined').catch(() => null)), 'alice joins voice');
  wb.ws.send(JSON.stringify({ op: 'voice_join', d: { channelId: S.channels.find((c) => c.type === 'voice').id } }));
  const jb = await wb.wait('voice_joined').catch(() => null);
  ok(jb?.peers.includes(alice.id), 'bob sees alice as peer');
  wb.ws.send(JSON.stringify({ op: 'voice_signal', d: { to: alice.id, signal: { type: 'offer', sdp: 'x' } } }));
  ok(!!(await wa.wait('voice_signal').catch(() => null)), 'signal relayed');

  console.log('\nStage channels');
  r = await api('POST', `/servers/${S.id}/channels`, A, { name: 'Town Hall', type: 'stage' });
  ok(r.status === 200 && r.body.type === 'stage', 'a moderator creates a stage channel');
  const stage = r.body; const send = (w, op, d) => w.ws.send(JSON.stringify({ op, d }));
  const upd = (w, pred) => w.wait('voice_state_update', (d) => d.channelId === stage.id && pred(d), 1500).catch(() => null);
  const stateOf = async (uid) => (await api('GET', '/ready', A)).body.voiceStates.find((x) => x.channelId === stage.id && x.userId === uid);
  r = await api('POST', `/channels/${stage.id}/messages`, A, { content: 'hi' });
  ok(r.status === 400, 'a stage has no text messages');
  send(wa, 'voice_join', { channelId: stage.id });
  const ja = await wa.wait('voice_joined', (d) => d.channelId === stage.id).catch(() => null);
  ok(ja?.states.find((x) => x.userId === alice.id)?.speaker === true, 'the moderator who opens an empty stage is a speaker');
  send(wb, 'voice_join', { channelId: stage.id });
  const jb2 = await wb.wait('voice_joined', (d) => d.channelId === stage.id).catch(() => null);
  const sb = jb2?.states.find((x) => x.userId === bob.id);
  ok(sb && sb.speaker === false && sb.muted === true, 'everybody else joins the audience, muted');
  ok(jb2?.peers.length === 1 && jb2.peers[0] === alice.id, 'the audience is told to connect to the speakers only');
  send(wb, 'voice_update', { muted: false, video: true, screen: true }); await sleep(250);
  let st = await stateOf(bob.id);
  ok(st && st.muted === true && !st.video && !st.screen, 'a listener cannot unmute or share video, even by asking the server');
  send(wb, 'voice_update', { hand: true }); await sleep(250);
  st = await stateOf(bob.id); ok(st?.hand === true && st.handAt > 0, 'raising a hand is recorded');
  ok(!!(await upd(wa, (d) => d.userId === bob.id && d.state?.hand === true)), '… and the stage is told');
  send(wb, 'stage_speaker', { userId: bob.id, speaker: true });
  ok(!!(await wb.wait('error', (d) => /moderators/.test(d.message), 1500).catch(() => null)), 'a listener cannot promote themselves');
  send(wb, 'voice_signal', { to: alice.id, signal: { x: 1 } });
  ok(!!(await wa.wait('voice_signal', (d) => d.channelId === stage.id && d.signal.x === 1, 1500).catch(() => null)), 'a listener can connect to a speaker');
  send(wa, 'stage_speaker', { userId: alice.id, speaker: false }); await sleep(250);
  ok((await stateOf(alice.id))?.speaker === false, 'a speaker can step down');
  send(wb, 'voice_signal', { to: alice.id, signal: { y: 2 } });
  ok(!(await wa.wait('voice_signal', (d) => d.channelId === stage.id && d.signal.y === 2, 700).catch(() => null)), 'two listeners never connect to each other');
  send(wa, 'stage_speaker', { userId: bob.id, speaker: true }); await sleep(250);
  st = await stateOf(bob.id); ok(st?.speaker === true && !st.hand && st.muted === true, 'a moderator invites someone up: they speak, the hand comes down, they start muted');
  send(wb, 'voice_update', { muted: false }); await sleep(250);
  ok((await stateOf(bob.id))?.muted === false, 'a speaker can unmute');
  send(wb, 'voice_signal', { to: alice.id, signal: { z: 3 } });
  ok(!!(await wa.wait('voice_signal', (d) => d.channelId === stage.id && d.signal.z === 3, 1500).catch(() => null)), 'a speaker connects to the listeners');
  send(wb, 'stage_speaker', { userId: bob.id, speaker: false }); await sleep(250);
  st = await stateOf(bob.id); ok(st?.speaker === false && st.muted === true, 'a speaker steps down: muted again, back in the audience');
  send(wa, 'stage_speaker', { userId: bob.id, speaker: true }); await sleep(250);
  ok((await stateOf(bob.id))?.speaker === true, 'invited up again');
  r = await api('PATCH', `/channels/${stage.id}`, A, { overwrites: [{ type: 'role', id: S.id, allow: [], deny: ['SPEAK'] }] });
  ok(r.status === 200, 'the stage forbids speaking for everyone');
  await sleep(400);
  ok((await stateOf(bob.id))?.speaker === false, 'a speaker who loses the right to speak steps down');
  send(wb, 'voice_update', { hand: true }); await sleep(250);
  ok(!(await stateOf(bob.id))?.hand, '… and cannot raise a hand either');
  send(wa, 'stage_speaker', { userId: bob.id, speaker: true });
  ok(!!(await wa.wait('error', (d) => /permission/.test(d.message), 1500).catch(() => null)), 'a moderator cannot invite someone who may not speak');
  r = await api('PATCH', `/channels/${stage.id}`, A, { overwrites: [] });
  ok(r.status === 200, 'speaking allowed again');
  send(wb, 'voice_leave', {}); send(wa, 'voice_leave', {}); await sleep(300);
  ok(!(await stateOf(alice.id)) && !(await stateOf(bob.id)), 'leaving empties the stage');

  console.log('\nModeration');
  r = await api('DELETE', `/servers/${S.id}/members/${bob.id}`, A);
  ok(r.status === 200, 'kick member');
  r = await api('POST', `/invites/${code}/join`, B);
  ok(r.status === 200, 're-join after kick works');
  r = await api('PUT', `/servers/${S.id}/bans/${bob.id}`, A);
  r = await api('POST', `/invites/${code}/join`, B);
  ok(r.status === 403, 'banned user cannot re-join');

  wa.ws.close(); wb.ws.close();
  console.log(`\n${pass} passed, ${fail} failed`);
}
main().catch((e) => { console.error(e); fail++; }).finally(() => { child.kill(); setTimeout(() => { fs.rmSync(data, { recursive: true, force: true }); process.exit(fail ? 1 : 0); }, 300); });
