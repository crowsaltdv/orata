// Orata self-test for what Orbit does that Discord servers add other bots for (server/orbit-plus.js): counting, welcome and goodbye messages,
// a role for newcomers, the member count, levels, giveaways, the starboard, tickets, warnings, saved replies, suggestions and slowmode.
// Runs with the other suites:  npm test
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'orata-orbit-test-'));
const PORT = 3970 + Math.floor(Math.random() * 25);
const base = `http://127.0.0.1:${PORT}`;
let pass = 0; let fail = 0;
const ok = (c, name, extra = '') => { if (c) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const register = async (username) => {
  const r = await api('POST', '/auth/register', null, { agree: true, username, displayName: username[0].toUpperCase() + username.slice(1), password: 'password123', dob: { year: 1995, month: 1, day: 1 } }, { 'x-forwarded-for': `198.51.100.${ip++}` });
  return { token: r.body?.token, user: r.body?.user };
};
const msgs = async (tok, chId) => (await api('GET', `/channels/${chId}/messages?limit=50`, tok)).body?.messages || [];
const last = async (tok, chId) => (await msgs(tok, chId)).at(-1);

async function main() {
  startServer(); await ready();
  console.log('Orbit features test on port', PORT);
  const A = await register('alice'); const B = await register('bob'); const C = await register('carol'); const D = await register('dave');
  let S = (await api('POST', '/servers', A.token, { name: 'Bot Land', orbit: true })).body; const text = S.channels.find((c) => c.type === 'text');
  const code = (await api('POST', `/servers/${S.id}/invites`, A.token, { maxUses: 0 })).body.code;
  for (const p of [B, D]) await api('POST', `/invites/${code}/join`, p.token);
  const cmd = async (who, name, args = '', chId = text.id) => (await api('POST', `/channels/${chId}/command`, who.token, { name, args }));
  const say = (who, content, chId = text.id) => api('POST', `/channels/${chId}/messages`, who.token, { content });
  const view = async (who = A) => (await api('GET', '/ready', who.token)).body.servers.find((x) => x.id === S.id);
  const react = (who, chId, mid, emoji) => api('PUT', `/channels/${chId}/messages/${mid}/reactions/${encodeURIComponent(emoji)}/@me`, who.token);
  let r;

  console.log('\nCounting');
  r = await cmd(B, 'counting'); ok(r.status === 403, 'only people who can manage channels set up counting');
  r = await cmd(A, 'counting'); ok(r.status === 200 && /Counting is on/.test(r.body.ephemeral) && /Counting starts here/.test((await last(A.token, text.id)).content), '/counting makes this the counting channel');
  const one = (await say(B, '1')).body; await sleep(100);
  const two = (await say(B, '2')).body; await sleep(100);
  let list = await msgs(A.token, text.id);
  ok(list.find((m) => m.id === one.id)?.reactions['✅']?.includes(S.orbitId), 'the right number gets a ✅');
  ok(list.find((m) => m.id === two.id)?.reactions['❌'] && /ruined it at \*\*1\*\*/.test(list.at(-1).content) && /twice in a row/.test(list.at(-1).content), 'counting twice in a row gets a ❌ and starts it over');
  await say(A, 'nice try'); await say(A, '1'); await say(B, '2'); const bad = (await say(A, '5')).body; await sleep(100);
  list = await msgs(A.token, text.id);
  ok(list.find((m) => m.id === bad.id)?.reactions['❌'] && /next number was \*\*3\*\*/.test(list.at(-1).content) && /Best so far: 2/.test(list.at(-1).content), 'a wrong number says what it should have been (words in between are just chat)');
  await cmd(A, 'counting', 'off');

  console.log('\nWelcome, goodbye, a role for newcomers, the member count');
  const newbie = (await api('POST', `/servers/${S.id}/roles`, A.token, { name: 'Newbie' })).body;
  r = await cmd(A, 'welcome', `#${text.name} Hey {user}, welcome to {server}! You’re #{count}.`); ok(r.status === 200 && /Hey <@/.test(r.body.ephemeral), '/welcome shows what newcomers will see');
  await cmd(A, 'goodbye', 'Bye **{name}**!');
  r = await cmd(A, 'autorole', '@Newbie'); ok(r.status === 200 && /Newbie/.test(r.body.ephemeral), '/autorole picks a role for everyone who joins');
  r = await cmd(A, 'membercount'); const countCh = (await view()).channels.find((c) => /^👥 Members: 3$/.test(c.name));
  ok(r.status === 200 && countCh?.type === 'voice', '/membercount makes a channel showing the member count');
  await api('POST', `/invites/${code}/join`, C.token); await sleep(150);
  let sv = await view();
  ok((await last(A.token, text.id)).content === `Hey <@${C.user.id}>, welcome to Bot Land! You’re #4.`, 'someone joining is welcomed');
  ok(sv.members.find((m) => m.id === C.user.id)?.roles.includes(newbie.id), '… gets the role');
  ok(sv.channels.find((c) => c.id === countCh?.id)?.name === '👥 Members: 4', '… and the member count goes up');
  await api('POST', `/servers/${S.id}/leave`, C.token); await sleep(150); sv = await view();
  ok((await last(A.token, text.id)).content === 'Bye **Carol**!' && sv.channels.find((c) => c.id === countCh?.id)?.name === '👥 Members: 3', 'leaving says goodbye and the count goes down');
  await cmd(A, 'welcome', 'off'); await cmd(A, 'goodbye', 'off'); await cmd(A, 'autorole', 'off');

  console.log('\nLevels');
  const helper = (await api('POST', `/servers/${S.id}/roles`, A.token, { name: 'Helper' })).body;
  r = await cmd(B, 'levels', 'on'); ok(r.status === 403, 'only people who can manage the server turn levels on');
  await cmd(A, 'levels', 'on'); r = await cmd(A, 'levels', 'reward 1 @Helper'); ok(/level 1 now gives \*\*Helper\*\*/.test(r.body.ephemeral), 'a level can give a role');
  await say(B, 'hello everyone'); r = await cmd(B, 'rank');
  const xp1 = Number(/(\d+) XP/.exec(r.body.ephemeral)?.[1]); ok(xp1 >= 15 && xp1 <= 25 && /level \*\*0\*\*/.test(r.body.ephemeral), 'chatting earns XP (/rank)');
  await say(B, 'again'); r = await cmd(B, 'rank'); ok(Number(/(\d+) XP/.exec(r.body.ephemeral)?.[1]) === xp1, '… once a minute, so spamming earns nothing');
  await stopServer();
  { const j = JSON.parse(fs.readFileSync(path.join(data, 'db.json'), 'utf8')); j.servers[S.id].orbit.xp[B.user.id] = { xp: 95, at: 0 }; fs.writeFileSync(path.join(data, 'db.json'), JSON.stringify(j)); }
  startServer(); await ready();
  await say(B, 'one more'); await sleep(150);
  ok(/<@\d+> reached \*\*level 1\*\*! You got the \*\*Helper\*\* role/.test((await last(A.token, text.id)).content) && (await view()).members.find((m) => m.id === B.user.id)?.roles.includes(helper.id), 'levelling up is announced and gives the role');
  r = await cmd(D, 'leaderboard'); ok(r.status === 200 && /🥇 Bob: level 1/.test((await last(A.token, text.id)).content), '/leaderboard shows the top of the server');

  console.log('\nGiveaways');
  r = await cmd(B, 'giveaway', '1h 1 Cookie'); ok(r.status === 403, 'only people who can manage messages start giveaways');
  await cmd(A, 'giveaway', '1h 1 Cookie'); const g = await last(A.token, text.id);
  ok(/GIVEAWAY: Cookie/.test(g.content) && g.reactions['🎉']?.includes(S.orbitId), '/giveaway posts it, ready to enter with 🎉');
  await react(B, text.id, g.id, '🎉');
  await cmd(A, 'giveaway', 'end'); await sleep(100);
  ok((await last(A.token, text.id)).content === `🎉 Congratulations <@${B.user.id}>! You won **Cookie**.`, '/giveaway end picks the winner from who entered (never Orbit)');
  r = await cmd(A, 'giveaway', 'end'); ok(r.status === 400, '… once');

  console.log('\nStarboard');
  const board = (await api('POST', `/servers/${S.id}/channels`, A.token, { name: 'starboard' })).body;
  await cmd(A, 'starboard', '#starboard 2');
  const star = (await say(D, 'this is a great message')).body;
  await react(A, text.id, star.id, '⭐'); ok(!(await msgs(A.token, board.id)).length, 'one star isn’t enough');
  await react(B, text.id, star.id, '⭐'); await sleep(100);
  let starred = await msgs(A.token, board.id);
  ok(starred.length === 1 && /⭐ \*\*2\*\*/.test(starred[0].content) && starred[0].forward?.content === 'this is a great message' && starred[0].forward.authorId === D.user.id, 'two stars repost it on the starboard');
  await react(D, text.id, star.id, '⭐'); await sleep(100); ok((await msgs(A.token, board.id)).length === 1, '… only once');

  console.log('\nTickets');
  await api('POST', `/invites/${code}/join`, C.token);
  r = await cmd(D, 'ticket', 'my role is missing'); const tId = /<#(\d+)>/.exec(r.body?.ephemeral || '')?.[1];
  ok(r.status === 200 && tId && /Ticket opened by/.test((await last(D.token, tId))?.content), '/ticket opens a private channel');
  ok((await api('GET', `/channels/${tId}/messages`, C.token)).status === 404 && (await api('GET', `/channels/${tId}/messages`, A.token)).status === 200, '… that other members can’t see, but staff can');
  r = await cmd(D, 'ticket'); ok(/already have a ticket/.test(r.body?.ephemeral), 'one open ticket each');
  r = await cmd(C, 'close', '', text.id); ok(r.status === 400, '/close only works in a ticket');
  r = await cmd(D, 'close', '', tId); ok(r.status === 200 && !(await view()).channels.some((c) => c.id === tId), '/close removes it');

  console.log('\nWarnings, saved replies, suggestions, slowmode');
  r = await cmd(B, 'warn', '@alice rude'); ok(r.status === 403, 'only moderators warn');
  r = await cmd(A, 'warn', '@bob spamming links'); ok(r.status === 200 && /Bob\*\* was warned by .*spamming links.*#1/.test((await last(A.token, text.id)).content), '/warn warns publicly and counts');
  r = await cmd(A, 'warnings', '@bob'); ok(/1 warning:/.test(r.body.ephemeral) && /spamming links/.test(r.body.ephemeral), '/warnings lists them');
  r = await cmd(A, 'clearwarnings', '@bob'); ok(/Cleared 1 warning/.test(r.body.ephemeral) && /no warnings/.test((await cmd(A, 'warnings', '@bob')).body.ephemeral), '/clearwarnings clears them');
  ok((await api('GET', `/servers/${S.id}/audit-log?action=member_warn`, A.token)).body.entries.filter((e) => e.action === 'member_warn').length === 1, 'warnings are in the audit log');
  r = await cmd(B, 'tag', 'add rules Be nice'); ok(r.status === 403, 'only people who can manage messages add saved replies');
  await cmd(A, 'tag', 'add rules Be nice.\nNo spam.'); r = await cmd(B, 'tag', 'rules');
  ok(r.status === 200 && (await last(A.token, text.id)).content === 'Be nice.\nNo spam.', 'anyone can post a saved reply (line breaks kept)');
  ok(/`rules`/.test((await cmd(B, 'tag')).body.ephemeral), '/tag lists them');
  const ideas = (await api('POST', `/servers/${S.id}/channels`, A.token, { name: 'ideas' })).body;
  await cmd(A, 'suggestions', '#ideas'); r = await cmd(B, 'suggest', 'a channel for memes');
  const idea = await last(A.token, ideas.id);
  ok(/Suggestion from Bob/.test(idea?.content) && idea.reactions['👍']?.length === 1 && idea.reactions['👎']?.length === 1 && /Posted in/.test(r.body.ephemeral), '/suggest posts in the suggestions channel with 👍 and 👎');
  r = await cmd(A, 'slowmode', '10s'); ok(r.status === 200 && (await view()).channels.find((c) => c.id === text.id)?.slowmode === 10, '/slowmode slows the channel');
  await cmd(A, 'slowmode', 'off');
  r = await cmd(B, 'help'); ok(/\/rank/.test(r.body.ephemeral) && /\/ticket/.test(r.body.ephemeral) && !/\/welcome/.test(r.body.ephemeral), '/help shows each person what they can use');

  await stopServer();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); stopServer().finally(() => process.exit(1)); });
