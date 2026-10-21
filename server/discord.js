// Orata — the Discord bridge. A linked Orata channel and Discord channel act as one conversation: messages, pictures, edits and deletes go both ways.
// From Discord, a message is posted here by the server's Orbit with `bridge` = the Discord sender's name and picture; from here, it goes to Discord
// through a webhook that shows the Orata sender's name and picture. Mentions become plain names and custom emoji plain :name: text on the other side.
// Linking: /link (Orbit) in the Orata channel gives a one-time code, and a Discord admin types /orata-link code:… in the Discord channel.
// /unlink here or /orata-unlink there ends it. Needs DISCORD_BOT_TOKEN (README → "Discord bridge"). No Discord library: the gateway is a
// WebSocket (ws) and everything else is plain fetch.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { db, save, ENV, UPLOAD_DIR, newId, emitTo, audienceOf, messageView, storeUpload, restoreUpload, audit, bad } from './core.js';
import { hooks, postMessage } from './messages.js';

const TOKEN = ENV.DISCORD_BOT_TOKEN || '';
export const discordOn = !!TOKEN;
const API = (ENV.DISCORD_API || 'https://discord.com/api/v10').replace(/\/$/, '');   // both can point at the self-test's fake Discord
const GATEWAY = ENV.DISCORD_GATEWAY || 'wss://gateway.discord.gg/?v=10&encoding=json';
const PUBLIC = (ENV.PUBLIC_URL || '').trim().replace(/\/+$/, '');
const MAX_FILE = Number(ENV.MAX_UPLOAD_MB || 25) * 1024 * 1024;
const DISCORD_MAX_FILE = 10 * 1024 * 1024;   // the most Discord takes in one file from a webhook (without boosts)
const INTENTS = 1 | 512 | 32768 | (1 << 24);   // servers, server messages, message content (privileged: switched on in the Developer Portal), poll votes
const MANAGE_GUILD = 0x20n; const ADMINISTRATOR = 0x8n;
const BOT_PERMISSIONS = '536988672';   // view channels, send messages, embed links, attach files, read message history, manage webhooks
const CODE_TTL = 10 * 60_000; const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MAX_PAIRS = 3000;   // ponytail: per link, the last 3000 message pairs are kept (and searched one by one) for edits and deletes; older messages stop syncing
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const later = (a, b) => (BigInt(a) > BigInt(b || 0) ? a : b);   // the newer of two Discord ids (they grow with time)

let guard = (ch, uid, text) => text;   // the server's swearing protection, handed over by api.js
const links = () => (db.discord ||= { links: {} }).links;   // Orata channel id -> { guildId, channelId, webhookId, webhookToken, site, by, at, lastSeen, pairs }
const linkOf = (discordChannelId) => Object.entries(links()).find(([, l]) => l.channelId === discordChannelId) || [];
const orbitOf = (s) => (s?.orbitId && s.members[s.orbitId] && db.users[s.orbitId] ? s.orbitId : null);
const codes = new Map();   // one-time link codes: code -> { channelId, userId, at }
const bot = { ws: null, seq: null, session: null, resumeUrl: null, appId: null, beat: null, acked: true, backoff: 1000, guilds: new Map() };

/* ---------------------------------------------------------------- Discord's API */
async function rest(method, route, body, files) {
  for (let tries = 0; ; tries++) {
    const headers = { authorization: `Bot ${TOKEN}`, 'user-agent': 'DiscordBot (https://github.com/crowsaltdv/orata, 1.0)' };
    let payload;
    if (files?.length) { payload = new FormData(); payload.append('payload_json', JSON.stringify(body)); files.forEach((f, i) => payload.append(`files[${i}]`, new Blob([f.data], { type: f.type }), f.name)); }
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(API + route, { method, headers, body: payload });
    if (res.status === 429 && tries < 3) { const j = await res.json().catch(() => ({})); await sleep(Math.min(10, Number(j.retry_after) || 1) * 1000); continue; }
    if (!res.ok) { const e = new Error(`Discord said ${res.status} to ${method} ${route.split('?')[0].replace(/\/[\w-]{40,}/g, '/…')}`); e.status = res.status; throw e; }
    return res.status === 204 ? null : res.json();
  }
}
const hookUrl = (l, tail = '') => `/webhooks/${l.webhookId}/${l.webhookToken}${tail}`;

/* ---------------------------------------------------------------- the gateway (Discord's live connection) */
function connect(resume) {
  const ws = bot.ws = new WebSocket(resume && bot.resumeUrl ? `${bot.resumeUrl}/?v=10&encoding=json` : GATEWAY);
  ws.on('message', (raw) => { let p; try { p = JSON.parse(raw); } catch { return; } if (p.s) bot.seq = p.s; onPacket(p, ws); });
  ws.on('close', (code) => onClose(code, ws));
  ws.on('error', (e) => console.error('[discord] connection error:', e.message));
}
const send = (op, d) => { if (bot.ws?.readyState === WebSocket.OPEN) bot.ws.send(JSON.stringify({ op, d })); };
function onPacket(p, ws) {
  if (p.op === 10) {   // hello: start the heartbeat, then log in (or pick up where we left off)
    clearInterval(bot.beat); bot.acked = true;
    const every = p.d.heartbeat_interval; setTimeout(() => beat(ws), Math.random() * every); bot.beat = setInterval(() => beat(ws), every);
    if (bot.session) send(6, { token: TOKEN, session_id: bot.session, seq: bot.seq });
    else send(2, { token: TOKEN, intents: INTENTS, properties: { os: 'linux', browser: 'orata', device: 'orata' } });
  } else if (p.op === 11) bot.acked = true;
  else if (p.op === 1) send(1, bot.seq);
  else if (p.op === 7) ws.close(4000);   // Discord asks for a reconnect
  else if (p.op === 9) { if (!p.d) { bot.session = null; bot.seq = null; } setTimeout(() => ws.close(4000), 1000 + Math.random() * 4000); }   // invalid session
  else if (p.op === 0) dispatch(p.t, p.d).catch((e) => console.error(`[discord] ${p.t}:`, e.message));
}
function beat(ws) {
  if (ws !== bot.ws) return;
  if (!bot.acked) return ws.terminate();   // the last heartbeat got no answer: the connection is dead, reconnect
  bot.acked = false; send(1, bot.seq);
}
const FATAL = { 4004: 'DISCORD_BOT_TOKEN is wrong', 4010: 'bad shard', 4011: 'sharding required', 4012: 'bad API version', 4013: 'bad intents',
  4014: 'switch on "Message Content Intent" for the bot (Discord Developer Portal → your app → Bot → Privileged Gateway Intents)' };
function onClose(code, ws) {
  if (ws !== bot.ws) return;
  clearInterval(bot.beat);
  if (FATAL[code]) return console.error(`[discord] stopped: ${FATAL[code]}`);
  if (code === 4007 || code === 4009) { bot.session = null; bot.seq = null; }   // a session that can't be picked up again
  const wait = bot.backoff; bot.backoff = Math.min(60_000, bot.backoff * 2);
  setTimeout(() => connect(!!bot.session), wait);
}
function cacheGuild(g) {
  const old = bot.guilds.get(g.id) || { channels: new Map(), roles: new Map() };
  bot.guilds.set(g.id, { name: g.name ?? old.name, channels: g.channels ? new Map(g.channels.map((c) => [c.id, c.name])) : old.channels, roles: g.roles ? new Map(g.roles.map((r) => [r.id, r.name])) : old.roles });
}
async function dispatch(t, d) {
  switch (t) {
    case 'READY':
      Object.assign(bot, { session: d.session_id, resumeUrl: d.resume_gateway_url, appId: d.application.id, backoff: 1000 });
      console.log(`[discord] connected as ${d.user.username}`);
      await registerCommands().catch((e) => console.error('[discord] could not set up the slash commands:', e.message));
      return catchUp();
    case 'RESUMED': bot.backoff = 1000; return;
    case 'GUILD_CREATE': case 'GUILD_UPDATE': return cacheGuild(d);
    case 'GUILD_DELETE': if (!d.unavailable) for (const [id, l] of Object.entries(links())) if (l.guildId === d.id) unlinkChannel(id, { why: 'the Orata bot was removed from the Discord server' }); return;
    case 'CHANNEL_CREATE': case 'CHANNEL_UPDATE': bot.guilds.get(d.guild_id)?.channels.set(d.id, d.name); return;
    case 'CHANNEL_DELETE': { const [id] = linkOf(d.id); if (id) unlinkChannel(id, { why: 'the Discord channel was deleted' }); return; }
    case 'GUILD_ROLE_CREATE': case 'GUILD_ROLE_UPDATE': bot.guilds.get(d.guild_id)?.roles.set(d.role.id, d.role.name); return;
    case 'INTERACTION_CREATE': return onCommand(d);
    case 'MESSAGE_CREATE': return fromDiscordCreate(d);
    case 'MESSAGE_UPDATE': return fromDiscordEdit(d);
    case 'MESSAGE_DELETE': return fromDiscordDelete(d.channel_id, [d.id]);
    case 'MESSAGE_DELETE_BULK': return fromDiscordDelete(d.channel_id, d.ids);
    case 'MESSAGE_POLL_VOTE_ADD': return pollVote(d, true);
    case 'MESSAGE_POLL_VOTE_REMOVE': return pollVote(d, false);
  }
}

/* ---------------------------------------------------------------- linking */
const COMMANDS = [
  { name: 'orata-link', description: 'Link this channel with an Orata channel', options: [{ type: 3, name: 'code', description: 'The code Orbit gives you when you type /link in the Orata channel', required: true }] },
  { name: 'orata-unlink', description: 'Stop mirroring this channel with Orata' },
].map((c) => ({ ...c, type: 1, default_member_permissions: String(MANAGE_GUILD), contexts: [0] }));   // only people who can manage the server see them, only in servers
async function registerCommands() {
  const have = await rest('GET', `/applications/${bot.appId}/commands`);
  const same = have.length === COMMANDS.length && COMMANDS.every((c) => have.some((x) => x.name === c.name && x.description === c.description && x.default_member_permissions === c.default_member_permissions && (x.options || []).length === (c.options || []).length));
  if (!same) await rest('PUT', `/applications/${bot.appId}/commands`, COMMANDS);
}

/** /link in Orata: a one-time code (10 minutes) for /orata-link in the Discord channel. Returns what Orbit tells the person.
 *  `site` is Orata's public address (PUBLIC_URL, or the one /link was typed at): Discord loads Orata people's pictures from it. */
export function linkCode(s, ch, userId, site) {
  if (!TOKEN) throw bad('Discord linking isn’t set up on this Orata server yet: it needs DISCORD_BOT_TOKEN (README → “Discord bridge”).');
  if (ch.type !== 'text') throw bad('Only text channels can be linked with Discord.');
  if (links()[ch.id]) throw bad('This channel is already linked with Discord. Type /unlink first.');
  for (const [k, v] of codes) if (v.channelId === ch.id || Date.now() - v.at > CODE_TTL) codes.delete(k);
  const code = Array.from(crypto.randomBytes(8), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
  codes.set(code, { channelId: ch.id, userId, site, at: Date.now() });
  const invite = bot.appId && `https://discord.com/oauth2/authorize?client_id=${bot.appId}&permissions=${BOT_PERMISSIONS}&scope=bot%20applications.commands`;
  return `In the Discord channel you want to link, type:\n\`/orata-link code:${code.slice(0, 4)}-${code.slice(4)}\`\nThe code works for 10 minutes.${invite ? `\nIs the Orata bot not in your Discord server yet? [Add it here](${invite}) first.` : ''}`;
}

/** Ends a link: Orbit says so here (and, when ended from Orata, the webhook says so on Discord), then the webhook is deleted. False when it wasn't linked. */
export async function unlinkChannel(chId, { why = '', fromOrata = false, actor = null, discordUser = null } = {}) {
  const l = links()[chId]; if (!l) return false;
  delete links()[chId]; save();
  const ch = db.channels[chId]; const s = ch && db.servers[ch.serverId];
  if (s) audit(s, actor, 'discord_unlink', { channel: ch.name, ...(discordUser ? { discordUser } : {}), ...(why ? { why } : {}) });
  if (ch && orbitOf(s)) postMessage(ch, orbitOf(s), { content: `🔗 This channel is no longer linked with Discord${why ? ` (${why})` : ''}.` });
  queue(chId, async () => {
    if (fromOrata) await rest('POST', hookUrl(l, '?wait=true'), { content: '🔗 This channel is no longer linked with Orata.', username: 'Orbit', avatar_url: avatarUrl(null, l), allowed_mentions: { parse: [] } }).catch(() => {});
    await rest('DELETE', hookUrl(l)).catch(() => {});
  });
  return true;
}

/** /orata-link and /orata-unlink, typed in Discord. */
async function onCommand(i) {
  if (i.type !== 2 || !['orata-link', 'orata-unlink'].includes(i.data?.name)) return;
  const reply = (content, ephemeral = true) => rest('POST', `/interactions/${i.id}/${i.token}/callback`, { type: 4, data: { content, flags: ephemeral ? 64 : 0, allowed_mentions: { parse: [] } } });
  if (!(BigInt(i.member?.permissions || 0) & (MANAGE_GUILD | ADMINISTRATOR))) return reply('You need the **Manage Server** permission to do that.');
  const who = i.member.nick || i.member.user?.global_name || i.member.user?.username || 'A Discord admin';
  const [linkedId] = linkOf(i.channel_id);
  if (i.data.name === 'orata-unlink') {
    if (!linkedId) return reply('This channel isn’t linked with Orata.');
    await unlinkChannel(linkedId, { discordUser: who });
    return reply(`🔗 **${who}** unlinked this channel from Orata. Messages here no longer show up there.`, false);
  }
  if (linkedId) return reply(`This channel is already linked with **#${db.channels[linkedId]?.name || 'a channel'}** on Orata. Type /orata-unlink first.`);
  if (i.channel && ![0, 5].includes(i.channel.type)) return reply('Only text channels can be linked.');
  const code = String(i.data.options?.find((o) => o.name === 'code')?.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const c = codes.get(code);
  if (!c || Date.now() - c.at > CODE_TTL) return reply('That code isn’t valid or has run out. Type **/link** in the Orata channel to get a new one.');
  const ch = db.channels[c.channelId]; const s = ch && db.servers[ch.serverId];
  if (!ch || !orbitOf(s)) { codes.delete(code); return reply('That Orata channel is gone, or Orbit was removed from its server.'); }
  if (links()[ch.id]) { codes.delete(code); return reply('That Orata channel is already linked with another Discord channel.'); }
  try { await rest('GET', `/channels/${i.channel_id}/messages?limit=1`); }   // Discord only sends a bot the messages of channels it can read
  catch (e) { return reply(e.status === 403 ? 'I can’t read this channel. Give me (my role) **View Channel** and **Read Message History** here, then run the command again.' : 'Discord didn’t let me set up the link. Try again in a moment.'); }
  let hook;
  try { hook = await rest('POST', `/channels/${i.channel_id}/webhooks`, { name: 'Orata' }); }
  catch (e) { return reply(e.status === 403 ? 'I need the **Manage Webhooks** permission in this channel. Give it to me, then run the command again.' : 'Discord didn’t let me set up the link. Try again in a moment.'); }
  codes.delete(code);
  const g = bot.guilds.get(i.guild_id); const there = g?.channels.get(i.channel_id) || i.channel?.name || 'channel';
  links()[ch.id] = { guildId: i.guild_id, channelId: i.channel_id, webhookId: hook.id, webhookToken: hook.token, site: /^https:\/\//.test(c.site || '') ? c.site : null, by: c.userId, at: Date.now(), lastSeen: i.id, pairs: [] };
  audit(s, c.userId, 'discord_link', { channel: ch.name, discordChannel: there, guild: g?.name || null });
  save();
  await reply(`🔗 Linked with **#${ch.name}** in **${s.name}** on Orata.`);
  postMessage(ch, orbitOf(s), { content: `🔗 **#${ch.name}** on Orata and **#${there}** on Discord${g?.name ? ` (${g.name})` : ''} are now linked. Messages show up on both sides.` });   // goes to Discord too
}

/* ---------------------------------------------------------------- message pairs, in order */
const queues = new Map();   // per link: a promise chain, so messages, edits and deletes reach the other side in the order they happened
function queue(chId, fn) {
  const p = (queues.get(chId) || Promise.resolve()).then(fn).catch((e) => console.error('[discord]', e.message));
  queues.set(chId, p); return p;
}
function remember(l, pair) { l.pairs.push(pair); if (l.pairs.length > MAX_PAIRS) l.pairs.splice(0, l.pairs.length - MAX_PAIRS); save(); }
const pairOf = (l, id) => l.pairs.find((p) => p.o === id);   // { o: Orata message id, d: [Discord message ids], in: came from Discord }
const pairByDiscord = (l, id) => l.pairs.find((p) => p.d.includes(id));

/* ---------------------------------------------------------------- Orata → Discord */
const hookName = (s, u) => (s?.members[u?.id]?.nick || u?.displayName || 'Orata user').replace(/discord|clyde/gi, (w) => `${w.slice(0, 3)}​${w.slice(3)}`).slice(0, 80);   // Discord refuses webhook names with these words
function avatarUrl(u, l) {
  const a = u?.avatar || '';
  if (/^https:\/\//.test(a)) return a;
  const site = PUBLIC || l.site; if (!site) return undefined;   // Discord can't fetch pictures without a public address
  return site + (a.startsWith('/uploads/') ? a : '/img/icon-192.png');   // Discord can't draw Orata's gradient default pictures, so: the logo
}
/** An Orata message as Discord text. Mentions become plain names (they'd point at the wrong people on Discord), custom emoji :name:. */
function textFor(ch, m, pollText = true) {
  const s = db.servers[ch.serverId];
  const plain = (t) => String(t || '')
    .replace(/<@!?(\d{6,20})>/g, (_, id) => '@' + (s?.members[id]?.nick || db.users[id]?.displayName || 'someone'))
    .replace(/<@&(\d{6,20})>/g, (_, id) => '@' + (s?.roles.find((r) => r.id === id)?.name || 'role'))
    .replace(/<#(\d{6,20})>/g, (_, id) => '#' + (db.channels[id]?.name || 'channel'))
    .replace(/<a?:(\w{2,32}):\d{6,20}>/g, ':$1:');
  const lines = [];
  const ref = m.replyTo && (db.messages[ch.id] || []).find((x) => x.id === m.replyTo);
  if (ref) lines.push(`> ↪ **${ref.bridge?.name || s?.members[ref.authorId]?.nick || db.users[ref.authorId]?.displayName || 'Someone'}**: ${plain(ref.content).replace(/\s+/g, ' ').slice(0, 100) || '(attachment)'}`);
  if (m.forward) lines.push(`↪ *Forwarded from ${m.forward.from}*`, ...(m.forward.content ? plain(m.forward.content).split('\n').map((x) => `> ${x}`) : []));
  if (m.content) lines.push(plain(m.content));
  if (m.poll && pollText) lines.push(`📊 **${m.poll.question}**`, ...m.poll.answers.map((a) => `• ${a.emoji ? a.emoji + ' ' : ''}${a.text}`));
  if (m.theme) lines.push('🎨 *shared a theme on Orata*');
  for (const media of [m.gif, m.sticker, m.forward?.gif, m.forward?.sticker]) if (media) lines.push(media.gif || media.png || media.webp || media.url);
  return lines.join('\n');
}
/** Discord takes 2000 characters a message: longer text is cut at a line break where it can. */
function split(text, max = 2000) {
  const out = []; let t = text.trim();
  while (t.length > max) { let cut = t.lastIndexOf('\n', max); if (cut < max / 2) cut = max; out.push(t.slice(0, cut)); t = t.slice(cut).replace(/^\n/, ''); }
  if (t) out.push(t);
  return out;
}
async function sendToDiscord(ch, l, m) {
  if (links()[ch.id] !== l) return;
  const s = db.servers[ch.serverId]; const u = db.users[m.authorId];
  let text = textFor(ch, m, !m.poll); const files = [];
  for (const a of m.attachments || []) {
    const name = path.basename(a.url);
    if (a.size <= DISCORD_MAX_FILE && await restoreUpload(name)) files.push({ data: fs.readFileSync(path.join(UPLOAD_DIR, name)), type: a.type, name: (a.spoiler ? 'SPOILER_' : '') + a.name });
    else text += `\n${PUBLIC || l.site ? (PUBLIC || l.site) + a.url : a.name}`;   // too big for Discord: a link instead
  }
  const base = { username: hookName(s, u), avatar_url: avatarUrl(u, l), allowed_mentions: { parse: [] } };   // nothing from Orata can ping anyone on Discord
  if (m.poll) {   // a real Discord poll (votes on it count in Orata too); if Discord refuses it, it goes as text instead
    try { const r = await rest('POST', hookUrl(l, '?wait=true'), { ...base, content: text.slice(0, 2000), poll: discordPoll(m.poll) }, files); return remember(l, { o: m.id, d: [r.id] }); }
    catch (e) { if (e.status === 404) return unlinkChannel(ch.id, { why: 'its webhook was deleted on Discord' }); text = textFor(ch, m); }
  }
  const parts = split(text);
  if (!parts.length && !files.length) return;
  if (!parts.length) parts.push('');
  const sent = [];
  try {
    for (let k = 0; k < parts.length; k++) sent.push((await rest('POST', hookUrl(l, '?wait=true'), { ...base, content: parts[k] }, k === parts.length - 1 ? files : null)).id);
  } catch (e) { if (e.status === 404) return unlinkChannel(ch.id, { why: 'its webhook was deleted on Discord' }); throw e; }
  remember(l, { o: m.id, d: sent });
}
hooks.onMessage.push((ch, m) => { const l = links()[ch.id]; if (l && !m.bridge && m.type === 'default') queue(ch.id, () => sendToDiscord(ch, l, m)); });
hooks.onEdit.push((ch, m) => {
  const l = links()[ch.id]; if (!l || m.bridge) return;
  queue(ch.id, async () => { const p = pairOf(l, m.id); if (p && !p.in) await rest('PATCH', hookUrl(l, `/messages/${p.d[0]}`), { content: textFor(ch, m).slice(0, 2000), allowed_mentions: { parse: [] } }); });
});
hooks.onDelete.push((ch, ids) => {
  const l = links()[ch.id]; if (!l) return;
  queue(ch.id, async () => {
    for (const id of ids) {
      const p = pairOf(l, id); if (!p) continue;
      l.pairs.splice(l.pairs.indexOf(p), 1);
      if (!p.in) for (const d of p.d) await rest('DELETE', hookUrl(l, `/messages/${d}`)).catch(() => {});   // the bot can only delete its own copies, not Discord people's messages
    }
    save();
  });
});

/* ---------------------------------------------------------------- Discord → Orata */
const nameOf = (d) => d.member?.nick || d.author.global_name || d.author.username;
function avatarOf(d, gid) {
  const u = d.author; const ext = (h) => (h.startsWith('a_') ? 'gif' : 'png');
  if (d.member?.avatar) return `https://cdn.discordapp.com/guilds/${gid}/users/${u.id}/avatars/${d.member.avatar}.${ext(d.member.avatar)}?size=128`;
  if (u.avatar) return `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.${ext(u.avatar)}?size=128`;
  return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(u.id) >> 22n) % 6n)}.png`;
}
/** Discord text as Orata text: mentions become plain names, custom emoji plain :name:, timestamps a date. Formatting is the same on both. */
function fromDiscordText(d, gid) {
  const g = bot.guilds.get(gid); const people = new Map((d.mentions || []).map((u) => [u.id, u.member?.nick || u.global_name || u.username]));
  return String(d.content || '')
    .replace(/<@!?(\d+)>/g, (_, id) => '@' + (people.get(id) || 'someone'))
    .replace(/<@&(\d+)>/g, (_, id) => '@' + (g?.roles.get(id) || 'role'))
    .replace(/<#(\d+)>/g, (_, id) => '#' + (g?.channels.get(id) || 'channel'))
    .replace(/<a?:(\w{2,32}):\d+>/g, ':$1:')
    .replace(/<t:(-?\d+)(?::\w)?>/g, (_, t) => new Date(t * 1000).toUTCString().replace('GMT', 'UTC'))
    .replace(/<\/([\w -]+):\d+>/g, '/$1');
}
const fileOk = (url) => /^https:\/\/(cdn\.discordapp\.com\/|media\.discordapp\.net\/|discord\.com\/stickers\/)/.test(url) || (!!ENV.DISCORD_API && url.startsWith(new URL(API).origin + '/'));
/** Copies a Discord file into Orata's uploads (Discord's own links stop working after about a day). Null when it can't, or it's too big. */
async function download(a) {
  if (!fileOk(String(a.url)) || a.size > MAX_FILE) return null;
  try {
    const res = await fetch(a.url); if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer()); if (!buf.length || buf.length > MAX_FILE) return null;
    const ext = path.extname(String(a.filename || '')).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 10);
    const id = newId(); const type = String(a.content_type || 'application/octet-stream').split(';')[0].slice(0, 100);
    await storeUpload(id + ext, type, buf);
    return { id, url: `/uploads/${id}${ext}`, name: String(a.filename || 'file').replace(/^SPOILER_/, '').slice(0, 200), size: buf.length, type, ...(a.width ? { width: a.width, height: a.height } : {}), spoiler: /^SPOILER_/.test(a.filename || '') };
  } catch { return null; }
}
/** Discord's GIF picker sends a Tenor or Giphy link that Discord plays as a GIF (a "gifv" embed): here it becomes an Orata GIF. */
function gifOf(d) {
  const e = (d.embeds || []).find((x) => x.type === 'gifv' && x.video?.url);
  return e ? { id: '', title: e.provider?.name || 'GIF', url: e.thumbnail?.url || e.video.url, mp4: e.video.url, poster: e.thumbnail?.url, w: e.video.width || e.thumbnail?.width, h: e.video.height || e.thumbnail?.height, kind: 'gif', link: e.url } : null;
}
const STICKERS = ENV.DISCORD_API ? `${new URL(API).origin}/stickers` : null;   // the self-test's fake Discord serves them
/** A Discord sticker as an Orata sticker, copied into uploads: server stickers are pictures (PNG, APNG, GIF); Discord's own are Lottie animations. */
async function stickerOf(st) {
  const [host, ext, type] = st.format_type === 3 ? ['https://discord.com/stickers', 'json', 'application/json']
    : st.format_type === 4 ? ['https://media.discordapp.net/stickers', 'gif', 'image/gif'] : ['https://cdn.discordapp.com/stickers', 'png', 'image/png'];
  const f = await download({ url: `${STICKERS || host}/${st.id}.${ext}`, filename: `${st.name}.${ext}`, content_type: type });
  return f && { url: f.url, title: String(st.name || 'sticker').slice(0, 60), ...(ext === 'json' ? { lottie: true } : {}) };
}
/** A Discord poll as an Orata poll. Discord numbers the answers 1, 2, 3 … like Orata does, so votes line up both ways. */
const pollFrom = (dp) => ({
  question: String(dp.question?.text || 'Poll').slice(0, 300), multi: !!dp.allow_multiselect, expiresAt: Date.parse(dp.expiry) || null, votes: {}, closed: false,
  answers: (dp.answers || []).slice(0, 10).map((a) => ({ id: String(a.answer_id), text: String(a.poll_media?.text || '…').slice(0, 55), emoji: a.poll_media?.emoji?.name && !a.poll_media.emoji.id ? a.poll_media.emoji.name : null })),
});
/** An Orata poll as a Discord poll (Discord counts its length in hours: 1 to 768). */
const discordPoll = (p) => ({
  question: { text: p.question.slice(0, 300) }, allow_multiselect: !!p.multi, layout_type: 1,
  duration: Math.min(768, Math.max(1, Math.ceil(((p.expiresAt || Date.now() + 86400_000) - Date.now()) / 3600_000))),
  answers: p.answers.map((a) => ({ poll_media: { text: a.text.slice(0, 55), ...(a.emoji && !/[<:]/.test(a.emoji) ? { emoji: { name: a.emoji } } : {}) } })),
});
const mirrored = (d) => !d.webhook_id && !d.author?.bot && (d.type === 0 || d.type === 19);   // people's messages and replies; never bots (or our own webhook)
async function mirrorIn(chId, l, d) {
  if (links()[chId] !== l || pairByDiscord(l, d.id)) return;
  l.lastSeen = later(d.id, l.lastSeen);
  const ch = db.channels[chId]; const s = ch && db.servers[ch.serverId]; const orbit = orbitOf(s);
  if (!ch) return unlinkChannel(chId);
  if (!orbit) return save();   // Orbit was removed from the server: nothing is posted until it's back
  let content = fromDiscordText(d, l.guildId); const poll = d.poll ? pollFrom(d.poll) : null;
  try {   // the server's swearing protection can block it
    content = guard(ch, orbit, content);
    if (poll) { poll.question = guard(ch, orbit, poll.question); for (const a of poll.answers) a.text = guard(ch, orbit, a.text); }
  } catch { return save(); }
  const gif = gifOf(d); if (gif && content.trim() === gif.link) content = '';   // a GIF from Discord's GIF picker is only its link
  const attachments = [];
  for (const a of (d.attachments || []).slice(0, 10)) { const f = await download(a); if (f) attachments.push(f); else content += `\n${a.url}`; }
  const st = d.sticker_items?.[0]; const sticker = st ? await stickerOf(st) : null;
  if (st && !sticker) content += `\n[sticker: ${st.name}]`;
  if (links()[chId] !== l) return;   // unlinked while the files were downloading
  if (!content.trim() && !attachments.length && !gif && !sticker && !poll) return save();
  const ref = d.message_reference?.message_id && pairByDiscord(l, d.message_reference.message_id);
  const msg = postMessage(ch, orbit, { content: content.trim().slice(0, 4000), attachments, gif, sticker, poll, replyTo: ref?.o || null, bridge: { id: d.author.id, name: nameOf(d), avatar: avatarOf(d, l.guildId) } });
  remember(l, { o: msg.id, d: [d.id], in: true });
}
function fromDiscordCreate(d) {
  const [chId, l] = linkOf(d.channel_id); if (!l) return;
  if (mirrored(d)) queue(chId, () => mirrorIn(chId, l, d));
  else l.lastSeen = later(d.id, l.lastSeen);
}
function fromDiscordEdit(d) {
  const [chId, l] = linkOf(d.channel_id); if (!l) return;
  queue(chId, () => {
    const p = pairByDiscord(l, d.id); const ch = db.channels[chId]; const m = p?.in && ch && (db.messages[chId] || []).find((x) => x.id === p.o);
    if (!m) return;
    let changed = false;
    const gif = !m.gif && gifOf(d);   // Discord often adds the GIF a moment after the message (an update with only the embed)
    if (gif) { m.gif = gif; if (m.content.trim() === gif.link) m.content = ''; changed = true; }
    if (typeof d.content === 'string') {
      let content; try { content = guard(ch, m.authorId, fromDiscordText(d, l.guildId)).trim().slice(0, 4000); } catch { content = m.content; }
      if (m.gif && content === m.gif.link) content = '';
      if (content !== m.content && (content || m.attachments?.length || m.gif || m.sticker || m.poll)) { m.content = content; m.editedAt = Date.now(); changed = true; }
    }
    if (!changed) return;
    save(); emitTo(audienceOf(ch), 'message_update', { message: messageView(m) });
  });
}
/** Someone voted (or took a vote back) on Discord: it counts in the Orata copy of the poll (as "d:<their id>"). Orata votes can't reach Discord: a bot can't vote for people. */
function pollVote(d, add) {
  const [chId, l] = linkOf(d.channel_id); if (!l) return;
  queue(chId, () => {
    const p = pairByDiscord(l, d.message_id); const ch = db.channels[chId]; const m = p && ch && (db.messages[chId] || []).find((x) => x.id === p.o);
    const poll = m?.poll; const id = String(d.answer_id);
    if (!poll || poll.closed || !poll.answers.some((a) => a.id === id)) return;
    const k = `d:${d.user_id}`; const had = poll.votes[k] || [];
    const next = add ? (poll.multi ? [...new Set([...had, id])] : [id]) : had.filter((x) => x !== id);
    if (next.length) poll.votes[k] = next; else delete poll.votes[k];
    save(); emitTo(audienceOf(ch), 'message_update', { message: messageView(m) });
  });
}
function fromDiscordDelete(discordChannelId, ids) {
  const [chId, l] = linkOf(discordChannelId); if (!l) return;
  queue(chId, () => {
    const ch = db.channels[chId];
    for (const id of ids) {
      const p = pairByDiscord(l, id); if (!p) continue;
      l.pairs.splice(l.pairs.indexOf(p), 1);
      if (!p.in || !ch) continue;   // a copy of an Orata message deleted on Discord: the Orata message stays
      db.messages[chId] = (db.messages[chId] || []).filter((x) => x.id !== p.o);
      emitTo(audienceOf(ch), 'message_delete', { channelId: chId, messageId: p.o });
    }
    save();
  });
}
/** After a restart or a nap (Render's free plan sleeps), posts what was said on Discord in the meantime: up to 500 messages per channel. */
function catchUp() {
  for (const [chId, l] of Object.entries(links())) {
    queue(chId, async () => {
      for (let page = 0; page < 5 && links()[chId] === l; page++) {
        const list = (await rest('GET', `/channels/${l.channelId}/messages?after=${l.lastSeen}&limit=100`)).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
        for (const d of list) { if (mirrored(d)) await mirrorIn(chId, l, { ...d, channel_id: l.channelId }); else l.lastSeen = later(d.id, l.lastSeen); }
        save();
        if (list.length < 100) break;
      }
    });
  }
}

/** Called once by api.js: hands over the swearing protection and, with DISCORD_BOT_TOKEN set, connects to Discord. */
export function startDiscord({ guardText }) {
  guard = guardText;
  if (TOKEN) connect(false);
}
