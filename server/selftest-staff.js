// Orata self-test for joining by application, server tags you can join from, channel emoji, the newer AutoMod rules, name rules, and the
// Orata staff tools (badges, locking, terminating, reports and flags). Runs with the other suites:  npm test
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'orata-staff-test-'));
const PORT = 3880 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${PORT}`;
let pass = 0; let fail = 0;
const ok = (c, name, extra = '') => { if (c) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rot13 = (s) => s.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97));   // so this file has no swear words in it

let child = null;
function startServer() {
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), ORATE_DATA: data, HOST: '127.0.0.1', DISCORD_BOT_TOKEN: '', SMTP_HOST: '', REQUIRE_EMAIL_VERIFICATION: '', DATABASE_URL: '', KLIPY_API_KEY: '', ACCOUNTS_PER_BROWSER: '1000', ACCOUNTS_PER_HOUR: '1000', TRUST_PROXY: '1' },
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
let ip = 10;   // each sign-up from its own address: sign-ups are limited per address
const register = async (username, extra = {}) => {
  const r = await api('POST', '/auth/register', null, { agree: true, username, displayName: extra.displayName || username[0].toUpperCase() + username.slice(1), password: 'password123', dob: { year: 1995, month: 1, day: 1 } }, { 'x-forwarded-for': `198.51.100.${ip++}` });
  return { token: r.body?.token, user: r.body?.user, res: r };
};
const msgs = async (tok, chId) => (await api('GET', `/channels/${chId}/messages?limit=50`, tok)).body?.messages || [];

async function main() {
  startServer(); await ready();
  console.log('Orata applications & staff test on port', PORT);

  console.log('\nName rules');
  let r = await register('orata_staff'); ok(r.res.status === 400 && r.res.body.code === 'username', 'nobody can be called after Orata staff');
  r = await register('normalguy', { displayName: 'Orata Admin' }); ok(r.res.status === 400 && r.res.body.code === 'displayName', '… not in their display name either');
  r = await register(rot13('shpxre')); ok(r.res.status === 400, 'no swear words in usernames');
  r = await api('POST', '/auth/check', null, { username: 'st4ff_bob' }); ok(r.body.username === false, 'look-alikes (st4ff) count');
  const A = await register('alice'); const B = await register('bob'); const C = await register('carol'); const D = await register('dave'); const E = await register('erin'); const F = await register('frank'); const G = await register('gina');
  ok(A.token && B.token, 'ordinary names are fine');
  r = await api('PATCH', '/me', B.token, { displayName: 'Mod Team' }); ok(r.status === 400, 'a display name can’t become “Mod Team” later');

  console.log('\nAutoMod');
  const S = (await api('POST', '/servers', A.token, { name: 'Club' })).body; const text = S.channels.find((c) => c.type === 'text');
  const code = (await api('POST', `/servers/${S.id}/invites`, A.token, {})).body.code;
  await api('POST', `/invites/${code}/join`, B.token);
  await api('PATCH', `/servers/${S.id}`, A.token, { automod: { walls: 500, invites: 'others', links: true } });
  const say = (tok, content) => api('POST', `/channels/${text.id}/messages`, tok, { content });
  r = await say(B.token, 'word '.repeat(130)); ok(r.status === 400 && /walls of text/.test(r.body.error), 'a pasted wall of text is blocked');
  r = await say(B.token, `hi ${'!'.repeat(40)}`); ok(r.status === 400, '… and so is one character 40 times in a row');
  r = await say(B.token, 'join https://discord.gg/abc123'); ok(r.status === 400 && /other apps/.test(r.body.error), '“Only Orata invites” blocks Discord invites');
  r = await say(B.token, `come to ${base}/invite/abc123`); ok(r.status === 200, '… but lets Orata’s own invites through, even with links blocked');
  r = await say(B.token, 'see https://example.com'); ok(r.status === 400, 'other links are still blocked');
  await api('PATCH', `/servers/${S.id}`, A.token, { automod: {} });

  console.log('\nChannel emoji');
  r = await api('POST', `/servers/${S.id}/channels`, A.token, { name: '🎮 Gaming Zone', emoji: '🔥' });
  ok(r.body.name === '🎮-gaming-zone' && r.body.emoji === '🔥', 'emoji in a channel’s name, and one in place of #');
  r = await api('PATCH', `/channels/${r.body.id}`, A.token, { emoji: 'abc' }); ok(r.status === 200 && !r.body.emoji, 'only an emoji can stand in for #');

  console.log('\nApply to join');
  r = await api('PATCH', `/servers/${S.id}`, A.token, { joinMode: 'apply', applyQuestion: 'Why do you like clubs?' });
  const appsId = r.body.applicationsChannelId; const appsCh = r.body.channels.find((c) => c.id === appsId);
  ok(appsCh?.name === 'applications' && appsCh.emoji === '📝', 'switching it on makes the applications channel');
  r = await api('GET', `/invites/${code}`, C.token); ok(r.body.server.joinMode === 'apply' && r.body.server.applyQuestion === 'Why do you like clubs?', 'the invite says the server takes applications, with its question');
  r = await api('POST', `/invites/${code}/join`, C.token); ok(r.status === 403 && r.body.code === 'apply_required', 'an invite doesn’t let people straight in');
  r = await api('POST', `/invites/${code}/apply`, C.token, { message: 'I love clubs' }); ok(r.status === 200 && r.body.application.status === 'pending', 'applying sends the application');
  r = await api('POST', `/invites/${code}/apply`, C.token, { message: 'again' }); ok(r.status === 400 && r.body.code === 'already_applied', 'one application at a time');
  let card = (await msgs(A.token, appsId)).find((m) => m.type === 'application' && m.application?.userId === C.user.id);
  ok(card?.application.message === 'I love clubs' && card.application.status === 'pending', 'it shows up as a card in the applications channel');
  r = await api('GET', `/channels/${appsId}/messages`, B.token); ok(r.status === 403 || r.status === 404, 'members without Access Applications can’t see the channel');
  r = await api('POST', `/servers/${S.id}/applications/${card.application.id}/accept`, B.token); ok(r.status === 403, '… or accept anyone');
  const role = (await api('POST', `/servers/${S.id}/roles`, A.token, { name: 'Gatekeeper', permissions: ['ACCESS_APPLICATIONS'] })).body;
  await api('PUT', `/servers/${S.id}/members/${B.user.id}/roles/${role.id}`, A.token);
  r = await api('GET', `/channels/${appsId}/messages`, B.token); ok(r.status === 200, 'the Access Applications permission shows the channel');
  r = await api('POST', `/servers/${S.id}/applications/${card.application.id}/reject`, B.token, { reason: 'not today' }); ok(r.status === 200, '… and lets them reject');
  card = (await msgs(A.token, appsId)).find((m) => m.id === card.id); ok(card.application.status === 'rejected' && card.application.reason === 'not today', 'the card says who decided and why');
  const dm = (await api('GET', '/ready', C.token)).body.dms.find((c) => c.type === 'dm');
  ok((await msgs(C.token, dm.id)).some((m) => /wasn’t accepted.*not today/.test(m.content)), 'the applicant hears back from Orbit');
  r = await api('POST', `/invites/${code}/apply`, C.token, { message: 'pls' }); ok(r.status === 400 && r.body.code === 'apply_wait', 'after a rejection they wait a day to apply again');
  await api('POST', `/invites/${code}/apply`, D.token, { message: 'hi' });
  const dApp = (await msgs(A.token, appsId)).find((m) => m.application?.userId === D.user.id);
  r = await api('POST', `/servers/${S.id}/applications/${dApp.application.id}/accept`, B.token);
  ok(r.status === 200 && (await api('GET', `/servers/${S.id}/preview`, D.token)).status !== 500 && (await api('GET', '/ready', D.token)).body.servers.some((s) => s.id === S.id), 'accepting lets them in');
  r = await api('DELETE', `/channels/${appsId}`, A.token); ok(r.status === 403, 'nobody can delete the applications channel while applying is on');
  r = await api('PATCH', `/channels/${appsId}`, A.token, { name: 'renamed' }); ok(r.status === 403, '… or rename it');
  r = await api('POST', `/servers/${S.id}/channels`, A.token, { name: 'Staff', type: 'category' }); const cat = r.body;
  r = await api('PATCH', `/channels/${appsId}`, A.token, { parentId: cat.id }); ok(r.status === 200, '… but it can be moved');
  await api('POST', `/invites/${code}/apply`, E.token, { message: 'me too' });
  r = await api('PATCH', `/servers/${S.id}`, A.token, { joinMode: 'invite' });
  ok(r.body.joinMode === 'invite' && (await api('GET', '/ready', E.token)).body.servers.some((s) => s.id === S.id), 'switching applying off lets everyone waiting in');
  r = await api('DELETE', `/channels/${appsId}`, A.token); ok(r.status === 200, 'then the channel can be deleted');

  console.log('\nJoining from a server tag');
  await api('PUT', `/servers/${S.id}/tag`, A.token, { text: 'CLUB', icon: 'star', color: '#22aa55' });
  r = await api('GET', `/servers/${S.id}/preview`, F.token); ok(r.status === 200 && r.body.name === 'Club' && r.body.joinMode === 'invite' && !r.body.member, 'clicking a tag shows its server');
  r = await api('POST', `/servers/${S.id}/join`, F.token); ok(r.status === 200 && (await api('GET', '/ready', F.token)).body.servers.some((s) => s.id === S.id), '… and anyone can join it from there');
  await api('PATCH', `/servers/${S.id}`, A.token, { joinMode: 'apply' });
  r = await api('POST', `/servers/${S.id}/join`, G.token); ok(r.status === 403 && r.body.code === 'apply_required', 'when it takes applications, the tag asks you to apply');
  r = await api('POST', `/servers/${S.id}/apply`, G.token, { message: 'saw your tag' }); ok(r.status === 200 && r.body.application.status === 'pending', '… and you can apply right there');
  const plain = (await api('POST', '/servers', A.token, { name: 'No tag' })).body;
  r = await api('GET', `/servers/${plain.id}/preview`, G.token); ok(r.status === 404, 'a server without a tag can’t be looked up this way');

  console.log('\nStaff tools');
  const X = await register('xavier'); const Y = await register('yara'); const Z = await register('zoe');
  await stopServer();   // make alice a founder (oratedev) and xavier a developer
  const j = JSON.parse(fs.readFileSync(path.join(data, 'db.json'), 'utf8'));
  j.users[A.user.id].username = 'oratedev'; j.users[A.user.id].badges = ['dev']; j.users[X.user.id].badges = ['dev'];
  fs.writeFileSync(path.join(data, 'db.json'), JSON.stringify(j)); startServer(); await ready();
  r = await api('PUT', `/users/${Y.user.id}/badges`, X.token, { badges: ['staff'] }); ok(r.status === 403, 'a developer who isn’t a founder can’t hand out the staff badge');
  r = await api('PUT', `/users/${Y.user.id}/badges`, A.token, { badges: ['staff'] }); ok(r.status === 200, 'a founder can');
  await api('PUT', `/users/${Z.user.id}/badges`, A.token, { badges: ['staff'] });
  r = await api('GET', '/staff/overview', B.token); ok(r.status === 403, 'the staff tools are for staff only');
  r = await api('GET', '/staff/overview', Y.token);
  const humans = Object.values(j.users).filter((u) => !u.bot && !u.deleted).length;
  ok(r.status === 200 && r.body.stats.accounts === humans && r.body.team.some((u) => u.id === Y.user.id), 'staff see how many accounts exist, and the team', JSON.stringify(r.body?.stats));
  r = await api('POST', `/staff/users/${B.user.id}/lock`, Y.token, { hours: 24, reason: 'cool off' }); ok(r.status === 200 && r.body.state === 'locked', 'staff can lock an account for a while');
  r = await api('GET', '/me', B.token); ok(r.status === 401, '… which signs them out');
  r = await api('POST', '/auth/login', null, { login: 'bob', password: 'password123' }); ok(r.status === 403 && /locked.*cool off/.test(r.body.error), '… and says why when they try to sign in');
  await api('POST', `/staff/users/${B.user.id}/unlock`, Y.token);
  r = await api('POST', '/auth/login', null, { login: 'bob', password: 'password123' }); ok(r.status === 200, 'unlocking lets them back in'); B.token = r.body.token;
  r = await api('POST', `/staff/users/${C.user.id}/terminate`, Y.token, { reason: 'scams' });
  ok(r.status === 200 && r.body.state === 'terminated', 'staff can terminate an account');
  r = await api('POST', '/auth/login', null, { login: 'carol', password: 'password123' }); ok(r.status === 403 && /terminated.*scams/.test(r.body.error), '… for good (it says so at sign-in)');
  r = await api('GET', `/users/${C.user.id}`, B.token); ok(r.body.user?.terminated === true, 'their profile says the account was terminated');
  r = await api('POST', `/staff/users/${A.user.id}/lock`, Y.token, { hours: 1, reason: 'x' }); ok(r.status === 403, 'nobody can lock a founder');
  r = await api('POST', `/staff/users/${Z.user.id}/lock`, Y.token, { hours: 1, reason: 'x' }); ok(r.status === 403, 'staff can’t lock other staff');
  r = await api('POST', `/staff/users/${C.user.id}/unterminate`, Y.token); ok(r.status === 200 && r.body.state === 'active', 'a termination can be undone');
  r = await api('POST', `/channels/${text.id}/messages`, D.token, { content: 'get free nitro at discord-gift.xyz' }); const scam = r.body;
  await api('POST', '/reports', E.token, { messageId: scam.id, channelId: text.id, reason: 'scam', note: 'phishing' });
  r = await api('GET', '/staff/flags', Y.token);
  const auto = r.body.flags.find((f) => f.messageId === scam.id && !f.reportedBy); const rep = r.body.flags.find((f) => f.messageId === scam.id && f.reportedBy === E.user.id);
  ok(auto?.reason === 'scam' && /free nitro/.test(auto.excerpt), 'Orata flags a scam-looking message by itself');
  ok(rep?.note === 'phishing' && rep.where === `#${text.name} in Club`, 'reports reach staff with the message and where it was');
  r = await api('GET', '/staff/overview', Y.token); const needs = r.body.attention?.find((u) => u.id === D.user.id);
  ok(needs?.openFlags === 2 && needs.why.includes('Scam-looking link') && needs.why.includes('Reported: Scam, phishing or malware') && r.body.newest?.length > 0 && !('messagesToday' in r.body.stats),
    'the overview lists accounts that need a look, and why, plus the newest accounts', JSON.stringify(r.body?.attention));
  r = await api('POST', `/staff/flags/${rep.id}`, Y.token, { action: 'delete' }); ok(r.status === 200 && !(await msgs(B.token, text.id)).some((m) => m.id === scam.id), 'staff can delete a flagged message');
  r = await api('POST', '/reports', E.token, { userId: E.user.id, reason: 'scam' }); ok(r.status === 400, 'you can’t report yourself');
  r = await api('GET', '/staff/log', Y.token); ok(['lock', 'unlock', 'terminate', 'unterminate', 'delete_message'].every((a) => r.body.log.some((e) => e.action === a && e.by === Y.user.id)), 'every staff action is in the staff log');

  console.log('\nReport reasons, and reports that are obviously jokes');
  r = await api('POST', '/reports', E.token, { userId: B.user.id, reason: 'spam' }); ok(r.status === 400, '“spam” isn’t a report reason');
  r = await api('POST', '/reports', E.token, { userId: B.user.id, reason: 'harassment' }); ok(r.status === 400, '… nor is “harassment”');
  const hi = (await say(B.token, 'hi')).body;
  await api('POST', '/reports', E.token, { messageId: hi.id, channelId: text.id, reason: 'hate' });
  await api('POST', '/reports', D.token, { userId: B.user.id, reason: 'impersonation', note: 'lol jk' });
  await api('POST', '/reports', D.token, { userId: B.user.id, reason: 'self-harm', note: 'lol' });
  r = await api('GET', '/staff/flags', Y.token);
  ok(!r.body.flags.some((f) => f.messageId === hi.id) && !r.body.flags.some((f) => f.reason === 'impersonation' && f.reportedBy === D.user.id) && r.body.hidden === 2,
    'reports that are obviously jokes stay out of staff’s way', JSON.stringify(r.body.hidden));
  const urgent = r.body.flags.find((f) => f.reason === 'self-harm' && f.reportedBy === D.user.id);
  ok(urgent?.label === 'Reported: Self-harm or suicide' && /joke/.test(urgent.doubt) && r.body.flags.at(-1).id === urgent.id, '… but never ones where someone may be in danger: those are tagged as looking like a joke, and go last');
  const hum = (await say(E.token, 'mostly hum')).body; const worry = (await say(E.token, 'how old are you? send pics')).body;
  await api('POST', '/reports', B.token, { messageId: hum.id, channelId: text.id, reason: 'child-safety' });
  await api('POST', '/reports', B.token, { messageId: worry.id, channelId: text.id, reason: 'child-safety' });
  r = await api('GET', '/staff/flags', Y.token);
  ok(/anything to do with that/.test(r.body.flags.find((f) => f.messageId === hum.id)?.doubt) && r.body.flags.some((f) => f.messageId === worry.id && !f.doubt),
    'a serious report about a message with nothing to do with it is tagged; one that might be real isn’t');
  r = await api('GET', '/staff/flags?hidden=1', Y.token); const joke = r.body.flags.find((f) => f.reason === 'impersonation' && f.reportedBy === D.user.id);
  ok(/joke/.test(joke?.hidden) && /everyday message/.test(r.body.flags.find((f) => f.messageId === hi.id)?.hidden), 'staff can still see them, and why they were hidden');
  await api('POST', `/staff/flags/${joke.id}`, Y.token, { action: 'unhide' });
  ok((await api('GET', '/staff/flags', Y.token)).body.flags.some((f) => f.id === joke.id), '“Not a joke” puts one back');
  await api('POST', '/reports', D.token, { userId: B.user.id, reason: 'scam', note: 'keeps scamming people' });
  r = await api('GET', '/staff/flags?hidden=1', Y.token); ok(r.body.flags.some((f) => f.reportedBy === D.user.id && f.reason === 'scam' && /twice today/.test(f.hidden)), 'a third report of the same person in a day is hidden');
  await api('POST', '/reports', E.token, { messageId: hi.id, channelId: text.id, reason: 'hate' });
  r = await api('GET', '/staff/flags?hidden=1', Y.token); ok(r.body.flags.filter((f) => f.messageId === hi.id).length === 1, 'reporting the same thing twice makes one report');

  console.log('\nServers, ghosting, and who used a command');
  r = await api('POST', '/reports', B.token, { serverId: S.id, reason: 'scam', note: 'fake giveaways' }); ok(r.status === 200, 'anyone can report a server');
  r = await api('POST', '/reports', A.token, { serverId: S.id, reason: 'scam' }); ok(r.status === 400, '… but not their own');
  r = await api('GET', '/staff/servers', B.token); ok(r.status === 403, 'only staff see every server');
  r = await api('GET', '/staff/servers', Y.token); const club = r.body.find?.((s) => s.id === S.id);
  ok(club?.reports === 1 && club.score > 0 && r.body[0].id === S.id, 'a reported server comes first on the staff list', JSON.stringify(club));
  r = await api('GET', `/channels/${text.id}/messages`, Y.token); ok(r.status === 404, 'staff can’t read a server they aren’t in…');
  r = await api('POST', `/staff/servers/${S.id}/ghost`, Y.token);
  ok(r.status === 200 && r.body.server.channels.some((c) => c.id === text.id) && !r.body.server.members.some((m) => m.id === Y.user.id), '… until they ghost in, without becoming a member');
  ok((await msgs(Y.token, text.id)).length > 0, 'a ghost reads the messages');
  r = await say(Y.token, 'boo'); ok(r.status === 403, 'a ghost can’t post');
  r = await api('POST', `/channels/${text.id}/typing`, Y.token); ok(r.status === 403, '… or show up typing');
  r = await api('GET', '/staff/log', Y.token); ok(r.body.log.some((e) => e.action === 'ghost' && e.serverName === 'Club'), 'ghosting goes in the staff log');
  await api('PUT', `/servers/${S.id}/orbit`, A.token);
  r = await api('POST', `/channels/${text.id}/command`, A.token, { name: 'say', args: 'hello from orbit' });
  const said = (await msgs(B.token, text.id)).find((m) => m.content === 'hello from orbit');
  ok(said?.command?.name === 'say' && !said.command.by, 'Orbit’s answer shows a command was used, not who', JSON.stringify(r.body));
  r = await api('GET', `/channels/${text.id}/messages/${said?.id}/command`, B.token); ok(r.status === 403, 'members can’t find out who used it');
  r = await api('GET', `/channels/${text.id}/messages/${said?.id}/command`, A.token); ok(r.body?.user?.id === A.user.id, 'the server’s admins can');
  r = await api('GET', `/channels/${text.id}/messages/${said?.id}/command`, Y.token); ok(r.body?.user?.id === A.user.id, '… and so can Orata staff');
  r = await api('GET', `/servers/${S.id}/audit-log`, A.token); ok(r.body.entries.some((e) => e.action === 'orbit_command' && e.actorId === A.user.id && e.details?.command === 'say'), 'it’s in the audit log too');
  await api('DELETE', `/staff/servers/${S.id}/ghost`, Y.token);
  r = await api('GET', `/channels/${text.id}/messages`, Y.token); ok(r.status === 404, 'leaving ghost mode closes the server again');

  console.log('\nDMs, and agreeing to the rules');
  const flaggedDm = (await api('POST', '/dms', B.token, { recipientId: E.user.id })).body;
  await api('POST', `/channels/${flaggedDm.id}/messages`, B.token, { content: 'hey erin' });
  const bait = (await api('POST', `/channels/${flaggedDm.id}/messages`, B.token, { content: 'free nitro here: discord-gift.xyz/claim' })).body;
  r = await api('GET', `/channels/${flaggedDm.id}/messages`, Y.token); ok(r.status === 404, 'staff can’t open a DM by itself');
  r = await api('GET', '/staff/flags', Y.token); const dmFlag = r.body.flags.find((f) => f.messageId === bait.id);
  ok(dmFlag?.reason === 'scam' && dmFlag.where === 'a DM', 'Orata flags a scam link in a DM too');
  r = await api('GET', `/staff/flags/${dmFlag?.id}/conversation`, B.token); ok(r.status === 403, 'only staff can read a flagged DM');
  r = await api('GET', `/staff/flags/${dmFlag?.id}/conversation`, Y.token);
  ok(r.status === 200 && r.body.flagged === bait.id && r.body.messages.some((m) => m.content === 'hey erin'), 'staff can read the DM around a flagged message');
  r = await api('GET', '/staff/log', Y.token); ok(r.body.log.some((e) => e.action === 'view_dm' && e.target === B.user.id), '… and that goes in the staff log');
  const group = (await api('POST', '/dms', B.token, { recipientIds: [E.user.id, D.user.id] })).body;
  await api('POST', `/channels/${group.id}/messages`, B.token, { content: 'claim your prize now at grabify.link/abc' });
  r = await api('GET', '/staff/dms', B.token); ok(r.status === 403, 'only staff see flagged DMs');
  r = await api('GET', '/staff/dms', Y.token); const dmRow = r.body.find?.((c) => c.id === flaggedDm.id); const groupRow = r.body.find?.((c) => c.id === group.id);
  ok(dmRow && !dmRow.group && dmRow.open >= 1 && groupRow?.group && groupRow.recipients.length === 3 && groupRow.last.where === 'a group DM', 'the DMs tab lists flagged DMs and group DMs', JSON.stringify(r.body));
  ok(!r.body.some((c) => c.id === dm?.id), '… and no DM without a flag');
  const quiet = (await api('POST', '/servers', A.token, { name: 'Quiet Corner' })).body;
  r = await api('POST', `/staff/servers/${quiet.id}/ghost`, Y.token); ok(r.status === 403, 'staff can’t ghost into a server nobody reported or flagged');
  r = await api('POST', '/auth/register', null, { username: 'nodeal', displayName: 'No', password: 'password123', dob: { year: 1995, month: 1, day: 1 } }, { 'x-forwarded-for': '198.51.100.250' });
  ok(r.status === 400 && r.body.code === 'agree', 'signing up needs agreeing to the Terms, Privacy Policy and Community Guidelines');
  for (const p of ['terms', 'privacy', 'guidelines']) { const res = await fetch(`${base}/${p}`); const body = await res.text(); ok(res.ok && /<h1>/.test(body) && !/id="app"/.test(body), `/${p} is its own page`); }

  await stopServer();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); stopServer().finally(() => process.exit(1)); });
