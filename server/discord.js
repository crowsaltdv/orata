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
import sharp from 'sharp';
import { db, save, ENV, UPLOAD_DIR, newId, emitTo, audienceOf, messageView, storeUpload, restoreUpload, removeUpload, audit, bad, can, serverView, serverAudience, sanitizeOverwrites } from './core.js';
import { hooks, postMessage } from './messages.js';

const TOKEN = (ENV.DISCORD_BOT_TOKEN || '').trim();
export const discordOn = !!TOKEN;
const TOKEN_APP = Buffer.from(TOKEN.split('.')[0] || '', 'base64').toString();   // a bot token starts with its app's id: the add-the-bot link works even before the bot connects
const APP_ID = /^\d{15,22}$/.test(TOKEN_APP) ? TOKEN_APP : null;
const API = (ENV.DISCORD_API || 'https://discord.com/api/v10').replace(/\/$/, '');   // both can point at the self-test's fake Discord
const GATEWAY = ENV.DISCORD_GATEWAY || 'wss://gateway.discord.gg/?v=10&encoding=json';
const PUBLIC = (ENV.PUBLIC_URL || '').trim().replace(/\/+$/, '');
const MAX_FILE = Number(ENV.MAX_UPLOAD_MB || 25) * 1024 * 1024;
const DISCORD_MAX_FILE = 10 * 1024 * 1024;   // the most Discord takes in one file from a webhook (without boosts)
const INTENTS = 1 | 512 | 32768;   // servers, server messages, message content (privileged: switched on in the Developer Portal)
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
const bot = { ws: null, seq: null, session: null, resumeUrl: null, appId: null, beat: null, acked: true, backoff: 1000, guilds: new Map(), online: false, error: null, since: null, lastCommand: null, lastProblem: null };
const problem = (msg) => { bot.lastProblem = { at: Date.now(), msg: String(msg).slice(0, 200) }; };   // shown to admins in /link-instructions
const inviteUrl = () => { const id = bot.appId || APP_ID; return id && `https://discord.com/oauth2/authorize?client_id=${id}&permissions=${BOT_PERMISSIONS}&scope=bot%20applications.commands`; };
/** A warning when the bot isn't connected to Discord right now (null when it is). */
const offline = () => (bot.error ? `⚠️ The Discord bot can’t log in right now: ${bot.error}.` : bot.online ? null : '⚠️ The Discord bot is still connecting to Discord, so Discord’s commands may not answer for a moment.');

/* ---------------------------------------------------------------- Discord's API */
async function rest(method, route, body, files) {
  for (let tries = 0; ; tries++) {
    const headers = { 'user-agent': 'DiscordBot (https://github.com/crowsaltdv/orata, 1.0)' };
    if (!/^\/(webhooks|interactions)\//.test(route)) headers.authorization = `Bot ${TOKEN}`;   // webhooks and interaction replies carry their own token in the address
    let payload;
    if (files?.length) { payload = new FormData(); payload.append('payload_json', JSON.stringify(body)); files.forEach((f, i) => payload.append(`files[${i}]`, new Blob([f.data], { type: f.type }), f.name)); }
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    let res;
    try { res = await fetch(API + route, { method, headers, body: payload, signal: AbortSignal.timeout(20_000) }); }   // one stuck request can't hold up a link
    catch (e) { problem(`${method} ${route.split('/').slice(0, 2).join('/')}: ${e.message}`); throw e; }
    if (res.status === 429) {   // Discord's own "slow down" says how long to wait; a block of this server's internet address (Cloudflare, common on shared hosts) has no JSON
      const j = await res.json().catch(() => null);
      if (!j) { const e = new Error(`Discord is blocking this server’s internet address for a while (Cloudflare 429 on ${method} ${route.split('/').slice(0, 2).join('/')})`); e.status = 429; problem(e.message); throw e; }
      if (tries < 4) { await sleep(Math.min(60, Number(j.retry_after) || 1) * 1000); continue; }
    }
    if (!res.ok) { const e = new Error(`Discord said ${res.status} to ${method} ${route.split('?')[0].replace(/\/[\w-]{40,}/g, '/…')}`); e.status = res.status; problem(e.message); throw e; }
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
  else if (p.op === 0) dispatch(p.t, p.d).catch((e) => { console.error(`[discord] ${p.t}:`, e.message); problem(`${p.t}: ${e.message}`); });
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
  clearInterval(bot.beat); bot.online = false;
  if (FATAL[code]) { bot.error = FATAL[code]; return console.error(`[discord] stopped: ${FATAL[code]}`); }
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
      Object.assign(bot, { session: d.session_id, resumeUrl: d.resume_gateway_url, appId: d.application.id, backoff: 1000, online: true, error: null, since: Date.now() });
      console.log(`[discord] connected as ${d.user.username}`);
      await registerCommands().catch((e) => console.error('[discord] could not set up the slash commands:', e.message));
      return catchUp();
    case 'RESUMED': Object.assign(bot, { backoff: 1000, online: true }); return;
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
  }
}

/* ---------------------------------------------------------------- linking */
const COMMANDS = [
  { name: 'orata-link', description: 'Link this channel with an Orata channel', options: [{ type: 3, name: 'code', description: 'The code Orbit gives you when you type /link in the Orata channel', required: true }] },
  { name: 'orata-unlink', description: 'Stop mirroring this channel with Orata' },
  { name: 'transfer', description: 'Move roles, channels and emoji from this server into Orata', options: [{ type: 3, name: 'code', description: 'The code Orbit gives you when you type /transfer in the Orata server', required: true }] },
].map((c) => ({ ...c, type: 1, default_member_permissions: String(MANAGE_GUILD), contexts: [0] }));   // only people who can manage the server see them, only in servers
async function registerCommands() {
  const have = await rest('GET', `/applications/${bot.appId}/commands`);
  const same = have.length === COMMANDS.length && COMMANDS.every((c) => have.some((x) => x.name === c.name && x.description === c.description && x.default_member_permissions === c.default_member_permissions
    && JSON.stringify((x.options || []).map((o) => [o.name, o.description])) === JSON.stringify((c.options || []).map((o) => [o.name, o.description]))));
  if (!same) await rest('PUT', `/applications/${bot.appId}/commands`, COMMANDS);
}

/** /link in Orata: a one-time code (10 minutes) for /orata-link in the Discord channel. Returns what Orbit tells the person.
 *  `site` is Orata's public address (PUBLIC_URL, or the one /link was typed at): Discord loads Orata people's pictures from it. */
export function linkCode(s, ch, userId, site) {
  if (!TOKEN) throw bad('Discord linking isn’t set up on this Orata server yet: it needs DISCORD_BOT_TOKEN (README → “Discord bridge”).');
  if (ch.type !== 'text') throw bad('Only text channels can be linked with Discord.');
  if (links()[ch.id]) throw bad('This channel is already linked with Discord. Type /unlink first.');
  if (bot.error) throw bad(`The Discord bot can’t log in right now: ${bot.error}.`);
  for (const [k, v] of codes) if (v.channelId === ch.id || Date.now() - v.at > CODE_TTL) codes.delete(k);
  const code = Array.from(crypto.randomBytes(8), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
  codes.set(code, { channelId: ch.id, userId, site, at: Date.now() });
  const invite = inviteUrl();
  return `In the Discord channel you want to link, type:\n\`/orata-link code:${code.slice(0, 4)}-${code.slice(4)}\`\nThe code works for 10 minutes.${invite ? `\nIs the Orata bot not in your Discord server yet? [Add it here](${invite}) first.` : ''}${offline() ? `\n${offline()}` : ''}`;
}

const ago = (t) => { const m = Math.round((Date.now() - t) / 60_000); return m < 1 ? 'just now' : m < 120 ? `${m} min ago` : `${Math.round(m / 60)} hours ago`; };
/** /link-instructions: whether this channel is linked, what a link carries, and how to set one up. Admins also see how the bot is doing. */
export function linkInstructions(ch, admin = false) {
  const l = links()[ch.id]; const g = l && bot.guilds.get(l.guildId);
  const invite = inviteUrl();
  return [
    '**🔗 Linking a channel with Discord**',
    ...(offline() ? [offline()] : []),
    l ? `This channel is linked with **#${g?.channels.get(l.channelId) || l.channelName || 'a channel'}**${g?.name || l.guildName ? ` in **${g?.name || l.guildName}**` : ''} on Discord.` : 'This channel isn’t linked with Discord yet.',
    '',
    '**What comes across, both ways:** messages with their formatting, replies, edits and deletes, pictures and files, GIFs and stickers (Discord’s own animated ones too). Everyone keeps their name and profile picture. Mentions become plain names, and custom Discord emoji show as `:name:`.',
    '**What doesn’t:** polls (an Orata poll shows on Discord as text), reactions, threads, voice, and messages from bots.',
    '',
    '**How to link** (each step needs the **Manage Server** permission):',
    `1. Add the Orata bot to your Discord server${invite ? ` ([add it here](${invite}))` : ''}. In the Discord channel it needs **View Channel**, **Read Message History**, **Send Messages**, **Attach Files** and **Manage Webhooks**.`,
    '2. Type `/link` in this channel. Orbit privately gives you a code that works for 10 minutes.',
    '3. In the Discord channel, type `/orata-link code:XXXX-XXXX` with that code.',
    '',
    'To stop, type `/unlink` here or `/orata-unlink` on Discord. A channel can be linked with one Discord channel at a time.',
    ...(admin ? ['', '**Bot status** (only admins see this):',
      `• Discord: ${bot.error ? `can’t log in (${bot.error})` : bot.online ? `connected ${ago(bot.since)}` : 'not connected right now'} · version ${String(ENV.RENDER_GIT_COMMIT || 'local').slice(0, 7)}`,
      `• Last Discord command: ${bot.lastCommand ? `/${bot.lastCommand.name}, ${ago(bot.lastCommand.at)}` : 'none since it started'}`,
      `• Last problem: ${bot.lastProblem ? `${bot.lastProblem.msg} (${ago(bot.lastProblem.at)})` : 'none'}`] : []),
  ].join('\n');
}

/** Remembers Orata's public https address for a link that doesn't know it yet (made before it was saved, or when /link didn't come over https):
 *  Discord loads Orata people's pictures from it. Called for every message sent in a channel. */
export function noteSite(chId, site) {
  const l = links()[chId];
  if (l && !l.site && /^https:\/\//.test(site)) { l.site = site; save(); }
}

/** Ends a link: Orbit says so here (and, when ended from Orata, the webhook says so on Discord), then the webhook is deleted. False when it wasn't linked. */
export async function unlinkChannel(chId, { why = '', fromOrata = false, actor = null, discordUser = null } = {}) {
  const l = links()[chId]; if (!l) return false;
  delete links()[chId]; save();
  const ch = db.channels[chId]; const s = ch && db.servers[ch.serverId];
  if (s) audit(s, actor, 'discord_unlink', { channel: ch.name, ...(discordUser ? { discordUser } : {}), ...(why ? { why } : {}) });
  if (ch && orbitOf(s)) postMessage(ch, orbitOf(s), { content: `🔗 This channel is no longer linked with Discord${why ? ` (${why})` : ''}.` });
  queue(chId, async () => {
    if (fromOrata) await rest('POST', hookUrl(l, '?wait=true'), { content: '🔗 This channel is no longer linked with Orata.', username: 'Orbit', avatar_url: await avatarUrl(null, l), allowed_mentions: { parse: [] } }).catch(() => {});
    await rest('DELETE', hookUrl(l)).catch(() => {});
  });
  return true;
}

/** /orata-link and /orata-unlink, typed in Discord (and /transfer with its form, further down). */
async function onCommand(i) {
  if (i.type === 2 && i.data?.name === 'transfer') return moveForm(i);
  if (i.type === 5 && String(i.data?.custom_id || '').startsWith('transfer:')) return moveSubmit(i);
  if (i.type !== 2 || !['orata-link', 'orata-unlink'].includes(i.data?.name)) return;
  bot.lastCommand = { at: Date.now(), name: i.data.name };
  const callback = (body) => rest('POST', `/interactions/${i.id}/${i.token}/callback`, body);
  if (!(BigInt(i.member?.permissions || 0) & (MANAGE_GUILD | ADMINISTRATOR))) return callback({ type: 4, data: { content: 'You need the **Manage Server** permission to do that.', flags: 64 } });
  // Discord gives up on an answer after 3 seconds, and a small free host can be slower than that: say "thinking…" at once, fill in the answer after
  const unlink = i.data.name === 'orata-unlink';
  const thinking = callback({ type: 5, data: { flags: unlink ? 0 : 64 } });   // unlinking is said to the whole channel, the rest only to whoever typed it
  const reply = async (content) => { await thinking; return rest('PATCH', `/webhooks/${i.application_id || bot.appId}/${i.token}/messages/@original`, { content, allowed_mentions: { parse: [] } }); };
  const who = i.member.nick || i.member.user?.global_name || i.member.user?.username || 'A Discord admin';
  const [linkedId] = linkOf(i.channel_id);
  if (unlink) {
    if (!linkedId) return reply('This channel isn’t linked with Orata.');
    await unlinkChannel(linkedId, { discordUser: who });
    return reply(`🔗 **${who}** unlinked this channel from Orata. Messages here no longer show up there.`);
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
  links()[ch.id] = { guildId: i.guild_id, channelId: i.channel_id, webhookId: hook.id, webhookToken: hook.token, site: /^https:\/\//.test(c.site || '') ? c.site : null, channelName: there, guildName: g?.name || null, by: c.userId, at: Date.now(), lastSeen: i.id, pairs: [] };
  audit(s, c.userId, 'discord_link', { channel: ch.name, discordChannel: there, guild: g?.name || null });
  save();
  await reply(`🔗 Linked with **#${ch.name}** in **${s.name}** on Orata.`);
  postMessage(ch, orbitOf(s), { content: `🔗 **#${ch.name}** on Orata and **#${there}** on Discord${g?.name ? ` (${g.name})` : ''} are now linked. Messages show up on both sides.` });   // goes to Discord too
}

/* ---------------------------------------------------------------- moving a Discord server into Orata
 * /transfer with Orbit (in the Orata server to move into) gives a one-time code; /transfer code:… in the Discord
 * server opens a form (whole server, or all / picked roles and channels, emoji, name and icon) and the bot copies what was picked. Channel
 * permissions only come across for roles that are moved too (or already exist here by the same name). Messages and members don't move. */
const moves = new Map();   // one-time transfer codes: code -> { serverId, userId, at }
const MOVE_TTL = 30 * 60_000;
// Orata permission -> Discord's bit for it (Send GIFs follows Embed Links)
const PERM_BITS = { ADMINISTRATOR: 3, MANAGE_SERVER: 5, MANAGE_CHANNELS: 4, MANAGE_ROLES: 28, MANAGE_MESSAGES: 13, KICK_MEMBERS: 1, BAN_MEMBERS: 2, CREATE_INVITE: 0, SEND_MESSAGES: 11, ATTACH_FILES: 15,
  ADD_REACTIONS: 6, MENTION_EVERYONE: 17, CONNECT: 20, SPEAK: 21, CHANGE_NICKNAME: 26, MANAGE_NICKNAMES: 27, VIEW_CHANNEL: 10, MODERATE_MEMBERS: 40, MANAGE_EXPRESSIONS: 30, SEND_GIFS: 14 };
const permsOfBits = (v) => { const n = BigInt(v || 0); const out = Object.keys(PERM_BITS).filter((p) => n & (1n << BigInt(PERM_BITS[p]))); if (out.includes('ADD_REACTIONS')) out.push('USE_REACTIONS'); return out; };   // (Discord has one reactions permission: both of Orata's follow it)
const CHANNEL_TYPES = { 0: 'text', 5: 'text', 2: 'voice', 13: 'stage', 4: 'category', 15: 'forum', 16: 'forum' };   // announcement -> text, media -> forum; threads stay behind
const CDN = ENV.DISCORD_API ? new URL(API).origin : 'https://cdn.discordapp.com';   // the self-test's fake Discord serves the pictures
const WHAT = [['all', 'Whole server', 'Every role, channel and emoji, plus the name and icon'], ['roles', 'All roles'], ['channels', 'All channels'], ['emojis', 'All emoji'], ['identity', 'Server name and icon']];

/** /transfer with Orbit: a one-time code (30 minutes) for /transfer in the Discord server. Returns what Orbit tells whoever asked. */
export function transferCode(s, userId) {
  if (!TOKEN) throw bad('Moving a Discord server needs the Discord bot: DISCORD_BOT_TOKEN isn’t set on this Orata server.');
  if (bot.error) throw bad(`The Discord bot can’t log in right now: ${bot.error}.`);
  for (const [k, v] of moves) if (v.serverId === s.id || Date.now() - v.at > MOVE_TTL) moves.delete(k);
  const code = Array.from(crypto.randomBytes(8), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
  moves.set(code, { serverId: s.id, userId, at: Date.now() });
  const invite = inviteUrl();
  return [`**🚚 Move a Discord server into ${s.name}**`,
    `In the Discord server, type \`/transfer code:${code.slice(0, 4)}-${code.slice(4)}\` (it needs the **Manage Server** permission there). A form opens where you pick what to move: the whole server, or roles, channels, emoji and the name and icon.`,
    'Channel permissions for custom roles only come across if you move those roles too. Messages and members don’t move.',
    'The code works once, for 30 minutes.', ...(invite ? [`Is the Orata bot not in that Discord server yet? [Add it here](${invite}) first.`] : []), ...(offline() ? [offline()] : [])].join('\n');
}

/** /transfer code:… on Discord: opens the form (or says why not). A form has to be Discord's first answer, so nothing slow happens before it. */
async function moveForm(i) {
  bot.lastCommand = { at: Date.now(), name: 'transfer' };
  const callback = (body) => rest('POST', `/interactions/${i.id}/${i.token}/callback`, body);
  const no = (content) => callback({ type: 4, data: { content, flags: 64 } });
  if (!(BigInt(i.member?.permissions || 0) & (MANAGE_GUILD | ADMINISTRATOR))) return no('You need the **Manage Server** permission to do that.');
  const code = String(i.data.options?.find((o) => o.name === 'code')?.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = moves.get(code); const s = m && db.servers[m.serverId];
  if (!s || Date.now() - m.at > MOVE_TTL) return no('That code isn’t valid or has run out. Get one by typing **/transfer** with Orbit in the Orata server to move into.');
  const intro = { type: 10, content: `Moving into **${s.name}** on Orata. Pick **Whole server**, or what to bring and (if not all) which ones.\n-# Channel permissions for custom roles only come across if you move those roles too. Messages and members don’t move.` };
  try {
    await callback({ type: 9, data: { custom_id: `transfer:${code}`, title: 'Move this server to Orata', components: [intro,
      { type: 18, label: 'What to move', component: { type: 3, custom_id: 'what', required: false, min_values: 0, max_values: WHAT.length, options: WHAT.map(([value, label, description]) => ({ value, label, ...(description ? { description } : {}) })) } },
      { type: 18, label: 'Roles to move (if not all)', component: { type: 6, custom_id: 'roles', required: false, min_values: 0, max_values: 25 } },
      { type: 18, label: 'Channels to move (if not all)', description: 'A category brings its channels, and a channel brings its category', component: { type: 8, custom_id: 'channels', required: false, min_values: 0, max_values: 25, channel_types: [0, 2, 4, 5, 13, 15, 16] } }] } });
  } catch (e) {   // a Discord app too old for lists in forms: the same questions as typed answers
    if (e.status !== 400) throw e;
    const row = (custom_id, label, placeholder) => ({ type: 1, components: [{ type: 4, custom_id, label, style: 1, required: false, max_length: 1000, placeholder }] });
    await callback({ type: 9, data: { custom_id: `transfer:${code}`, title: 'Move this server to Orata', components: [
      row('what', 'What to move', 'whole server, or: roles, channels, emoji, name'), row('roles', 'Roles to move (if not all)', 'Role names, separated by commas'), row('channels', 'Channels to move (if not all)', 'Channel names, separated by commas')] } });
  }
}

/** The form was sent: check the code again, then move what was picked and say how it went. */
async function moveSubmit(i) {
  const callback = (body) => rest('POST', `/interactions/${i.id}/${i.token}/callback`, body);
  const thinking = callback({ type: 5, data: { flags: 64 } });
  const reply = async (content) => { await thinking; return rest('PATCH', `/webhooks/${i.application_id || bot.appId}/${i.token}/messages/@original`, { content, allowed_mentions: { parse: [] } }); };
  if (!(BigInt(i.member?.permissions || 0) & (MANAGE_GUILD | ADMINISTRATOR))) return reply('You need the **Manage Server** permission to do that.');
  const code = i.data.custom_id.slice('transfer:'.length); const m = moves.get(code); const s = m && db.servers[m.serverId]; const dev = m && db.users[m.userId];
  if (!s || Date.now() - m.at > MOVE_TTL) return reply('That code ran out or was already used. Ask for a new one with **/transfer** in Orata.');
  if (!dev || !can(s, dev.id, 'MANAGE_SERVER')) return reply('Whoever made that code can’t manage that Orata server any more.');
  moves.delete(code);   // one use
  const picked = {};
  for (const c of i.data.components || []) { const x = c.component || c.components?.[0]; if (x?.custom_id) picked[x.custom_id] = x.values ?? x.value ?? []; }
  try { return await reply(await moveIn(i.guild_id, s, picked, dev.id)); }
  catch (e) { console.error('[discord] transfer:', e); return reply(`Something went wrong part way: ${e.message}. Whatever was already moved stays in Orata.`); }
}

/** A picture from Discord's CDN, saved as an Orata upload; its address, or null. */
async function savePicture(url, max) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) }); if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer()); if (!buf.length || buf.length > max) return null;
    const type = String(res.headers.get('content-type') || 'image/png').split(';')[0]; const ext = type === 'image/gif' ? '.gif' : type === 'image/webp' ? '.webp' : type === 'image/jpeg' ? '.jpg' : '.png';
    const id = newId(); await storeUpload(id + ext, type, buf); return `/uploads/${id}${ext}`;
  } catch { return null; }
}
const words = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,\n]/)).map((x) => String(x).trim()).filter(Boolean);
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/** Copies what was picked from Discord server `gid` into Orata server `s`. Lists come as ids (from the form's lists) or typed names. Returns a summary. */
async function moveIn(gid, s, picked, actorId) {
  const [g, chans] = await Promise.all([rest('GET', `/guilds/${gid}`), rest('GET', `/guilds/${gid}/channels`)]);
  const what = new Set(words(picked.what).map((w) => { w = w.toLowerCase(); return /whole|all|every/.test(w) && !/role|channel|emoji/.test(w) ? 'all' : /role/.test(w) ? 'roles' : /channel/.test(w) ? 'channels' : /emoji/.test(w) ? 'emojis' : /name|icon|identity/.test(w) ? 'identity' : w; }));
  const all = what.has('all'); const has = (k) => all || what.has(k);
  const idsOf = (v, list) => words(v).flatMap((x) => (list.some((o) => o.id === x) ? [x] : list.filter((o) => o.name.toLowerCase() === x.replace(/^[#@]/, '').toLowerCase()).map((o) => o.id)));
  const done = { roles: 0, channels: 0, emojis: 0 }; const left = { roleRules: new Set(), memberRules: 0, emojis: 0, full: 0, existing: 0 };

  // roles (not @everyone, nor bot or booster roles), lowest first so they keep their order; one already here by the same name is used as it is
  const movable = (g.roles || []).filter((r) => r.id !== gid && !r.managed).sort((a, b) => a.position - b.position);
  const roleMap = new Map([[gid, s.id]]);
  for (const r of movable) { const here = s.roles.find((x) => x.id !== s.id && x.name === r.name); if (here) roleMap.set(r.id, here.id); }
  const wantRoles = has('roles') ? movable : movable.filter((r) => idsOf(picked.roles, movable).includes(r.id));
  if (has('roles')) { const ev = s.roles.find((r) => r.id === s.id); const er = (g.roles || []).find((r) => r.id === gid); if (ev && er) ev.permissions = permsOfBits(er.permissions); }
  let pos = Math.max(0, ...s.roles.map((r) => r.position || 0));
  for (const r of wantRoles) {
    if (roleMap.has(r.id)) { left.existing++; continue; }
    if (s.roles.length >= 50) { left.full++; continue; }
    const role = { id: newId(), name: String(r.name).slice(0, 100), color: r.color ? `#${r.color.toString(16).padStart(6, '0')}` : null, position: ++pos, permissions: permsOfBits(r.permissions), hoist: !!r.hoist };
    s.roles.push(role); roleMap.set(r.id, role.id); done.roles++;
  }

  // channels: a picked category brings its channels, a picked channel its category; categories first
  const kept = (chans || []).filter((c) => CHANNEL_TYPES[c.type]);
  let want = kept;
  if (!has('channels')) {
    const ids = new Set(idsOf(picked.channels, kept));
    for (const c of kept) if (c.parent_id && ids.has(c.parent_id)) ids.add(c.id);
    for (const c of kept) if (ids.has(c.id) && c.parent_id) ids.add(c.parent_id);
    want = kept.filter((c) => ids.has(c.id));
  }
  const rules = (c) => sanitizeOverwrites(s, (c.permission_overwrites || []).flatMap((o) => {
    if (o.type === 1) { left.memberRules++; return []; }   // members don't move
    const id = roleMap.get(o.id); if (!id) { left.roleRules.add(o.id); return []; }
    return [{ type: 'role', id, allow: permsOfBits(o.allow), deny: permsOfBits(o.deny) }];
  }));
  const norm = (l) => JSON.stringify((l || []).map((o) => [o.type, o.id, [...o.allow].sort(), [...o.deny].sort()]).sort());
  const catMap = new Map(); let count = Object.values(db.channels).filter((c) => c.serverId === s.id).length;
  for (const c of [...want].sort((a, b) => (b.type === 4) - (a.type === 4) || (a.position || 0) - (b.position || 0))) {
    if (count >= 200) { left.full++; continue; }
    const type = CHANNEL_TYPES[c.type]; const id = newId(); const parentId = type !== 'category' && c.parent_id ? catMap.get(c.parent_id) || null : null;
    const ch = { id, serverId: s.id, type, name: (type === 'text' || type === 'forum' ? String(c.name).toLowerCase().replace(/\s+/g, '-') : String(c.name)).slice(0, 100) || 'channel',
      parentId, position: c.position || 0, topic: String(c.topic || '').slice(0, 1024), nsfw: !!c.nsfw, slowmode: Math.min(21600, Math.max(0, c.rate_limit_per_user || 0)), ...(type === 'forum' ? { tags: [], requireTag: false } : {}) };
    const ows = rules(c);
    if (!parentId) { if (ows.length) ch.overwrites = ows; }
    else if (norm(ows) !== norm(db.channels[parentId].overwrites)) { ch.overwrites = ows; ch.synced = false; }   // same rules as its category: it stays synced
    db.channels[id] = ch; db.messages[id] = []; count++; done.channels++;
    if (type === 'category') catMap.set(c.id, id);
  }

  // emoji (at most 50 in a server, 512 KB each) and the server's name and icon
  if (has('emojis')) {
    const list = (s.emojis ||= []);
    for (const e of g.emojis || []) {
      if (list.length >= 50) { left.full++; continue; }
      if (!/^[A-Za-z0-9_]{2,32}$/.test(e.name || '') || list.some((x) => x.name.toLowerCase() === e.name.toLowerCase())) { left.emojis++; continue; }
      const url = await savePicture(`${CDN}/emojis/${e.id}.${e.animated ? 'gif' : 'png'}`, 512 * 1024);
      if (!url) { left.emojis++; continue; }
      list.push({ id: newId(), name: e.name, url, animated: !!e.animated, by: actorId, at: Date.now() }); done.emojis++;
    }
  }
  if (has('identity')) {
    if (String(g.name || '').trim().length >= 2) s.name = String(g.name).trim().slice(0, 100);
    if (g.icon) { const url = await savePicture(`${CDN}/icons/${gid}/${g.icon}.${g.icon.startsWith('a_') ? 'gif' : 'png'}`, 4 * 1024 * 1024); if (url) s.icon = url; }
  }

  audit(s, actorId, 'discord_transfer', { guild: g.name || null, roles: done.roles, channels: done.channels, emojis: done.emojis, identity: has('identity') });
  save();
  for (const uid of serverAudience(s)) emitTo([uid], 'server_update', { server: serverView(s, uid) });
  const moved = [done.roles && plural(done.roles, 'role'), done.channels && plural(done.channels, 'channel'), done.emojis && plural(done.emojis, 'emoji', 'emoji'), has('identity') && 'the name and icon'].filter(Boolean);
  const notMoved = [left.roleRules.size && `channel permissions for ${plural(left.roleRules.size, 'role')} you didn’t move (move those roles too to keep them)`,
    left.memberRules && `${plural(left.memberRules, 'permission rule')} for single members (members don’t move)`, left.existing && `${plural(left.existing, 'role')} already in Orata by that name (used as they are)`,
    left.emojis && `${plural(left.emojis, 'emoji', 'emoji')} whose name was taken or couldn’t be read`, left.full && `${plural(left.full, 'thing')} over Orata’s limits (50 roles, 200 channels, 50 emoji)`].filter(Boolean);
  if (!moved.length) return `Nothing was moved. Pick **Whole server** or an “All …” option, or choose some roles or channels.${notMoved.length ? `\n${notMoved.join('; ')}.` : ''}`;
  return `✅ Moved into **${s.name}** on Orata: ${moved.join(', ')}.${notMoved.length ? `\n**Not moved:** ${notMoved.join('; ')}.` : ''}`;
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
async function avatarUrl(u, l) {
  const a = u?.avatar || '';
  if (/^https:\/\//.test(a)) return a;
  const site = PUBLIC || l.site; if (!site) return undefined;   // Discord can't fetch pictures without a public address
  if (!a.startsWith('/uploads/')) return `${site}/img/icon-192.png`;   // Discord can't draw Orata's gradient default pictures, so: the logo
  if (!/\.webp$/i.test(a)) return site + a;
  return site + (await pngCopy(u) || '/img/icon-192.png');
}
/** Discord doesn't show WebP profile pictures, and Orata saves cropped pictures as WebP: a PNG copy is made once per picture (remembered on the account). */
async function pngCopy(u) {
  if (u.avatarPng?.from === u.avatar) return u.avatarPng.url;
  try {
    const name = path.basename(u.avatar); if (!await restoreUpload(name)) return null;
    const out = `${newId()}.png`; await storeUpload(out, 'image/png', await sharp(path.join(UPLOAD_DIR, name)).png().toBuffer());
    if (u.avatarPng) removeUpload(path.basename(u.avatarPng.url));
    u.avatarPng = { from: u.avatar, url: `/uploads/${out}` }; save();
    return u.avatarPng.url;
  } catch (e) { console.error('[discord] could not make a PNG of a profile picture:', e.message); return null; }
}
/** An Orata message as Discord text. Mentions become plain names (they'd point at the wrong people on Discord), custom emoji :name:. */
function textFor(ch, m, l) {
  const s = db.servers[ch.serverId]; const site = PUBLIC || l.site || '';
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
  if (m.poll) lines.push(`📊 **${m.poll.question}**`, ...m.poll.answers.map((a) => `• ${a.emoji ? a.emoji + ' ' : ''}${a.text}`));
  if (m.theme) lines.push('🎨 *shared a theme on Orata*');
  for (const media of [m.gif, m.sticker, m.forward?.gif, m.forward?.sticker]) if (media) { const url = media.gif || media.png || media.webp || media.url; lines.push(url.startsWith('/') ? site + url : url); }   // the server's own stickers are files here
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
  let text = textFor(ch, m, l); const files = [];
  for (const a of m.attachments || []) {
    const name = path.basename(a.url);
    if (a.size <= DISCORD_MAX_FILE && await restoreUpload(name)) files.push({ data: fs.readFileSync(path.join(UPLOAD_DIR, name)), type: a.type, name: (a.spoiler ? 'SPOILER_' : '') + a.name });
    else text += `\n${PUBLIC || l.site ? (PUBLIC || l.site) + a.url : a.name}`;   // too big for Discord: a link instead
  }
  const base = { username: hookName(s, u), avatar_url: await avatarUrl(u, l), allowed_mentions: { parse: [] } };   // nothing from Orata can ping anyone on Discord
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
  queue(ch.id, async () => { const p = pairOf(l, m.id); if (p && !p.in) await rest('PATCH', hookUrl(l, `/messages/${p.d[0]}`), { content: textFor(ch, m, l).slice(0, 2000), allowed_mentions: { parse: [] } }); });
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
    const res = await fetch(a.url, { signal: AbortSignal.timeout(30_000) }); if (!res.ok) return null;
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
const mirrored = (d) => !d.webhook_id && !d.author?.bot && (d.type === 0 || d.type === 19);   // people's messages and replies; never bots (or our own webhook)
async function mirrorIn(chId, l, d) {
  if (links()[chId] !== l || pairByDiscord(l, d.id)) return;
  l.lastSeen = later(d.id, l.lastSeen);
  const ch = db.channels[chId]; const s = ch && db.servers[ch.serverId]; const orbit = orbitOf(s);
  if (!ch) return unlinkChannel(chId);
  if (!orbit) return save();   // Orbit was removed from the server: nothing is posted until it's back
  let content = fromDiscordText(d, l.guildId);
  try { content = guard(ch, orbit, content); } catch { return save(); }   // the server's swearing protection blocks it
  const gif = gifOf(d); if (gif && content.trim() === gif.link) content = '';   // a GIF from Discord's GIF picker is only its link
  const attachments = [];
  for (const a of (d.attachments || []).slice(0, 10)) { const f = await download(a); if (f) attachments.push(f); else content += `\n${a.url}`; }
  const st = d.sticker_items?.[0]; const sticker = st ? await stickerOf(st) : null;
  if (st && !sticker) content += `\n[sticker: ${st.name}]`;
  if (links()[chId] !== l) return;   // unlinked while the files were downloading
  if (!content.trim() && !attachments.length && !gif && !sticker) return save();   // polls aren't mirrored
  const ref = d.message_reference?.message_id && pairByDiscord(l, d.message_reference.message_id);
  const msg = postMessage(ch, orbit, { content: content.trim().slice(0, 4000), attachments, gif, sticker, replyTo: ref?.o || null, bridge: { id: d.author.id, name: nameOf(d), avatar: avatarOf(d, l.guildId) } });
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
      if (content !== m.content && (content || m.attachments?.length || m.gif || m.sticker)) { m.content = content; m.editedAt = Date.now(); changed = true; }
    }
    if (!changed) return;
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
function catchUp(only = null) {
  for (const [chId, l] of Object.entries(links())) {
    if (only && only !== chId) continue;
    queue(chId, async () => {
      try {
        for (let page = 0; page < 5 && links()[chId] === l; page++) {
          const list = (await rest('GET', `/channels/${l.channelId}/messages?after=${l.lastSeen}&limit=100`)).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
          for (const d of list) { if (mirrored(d)) await mirrorIn(chId, l, { ...d, channel_id: l.channelId }); else l.lastSeen = later(d.id, l.lastSeen); }
          save();
          if (list.length < 100) break;
        }
      } catch (e) {
        if (e.status === 429) setTimeout(() => catchUp(chId), 60_000);   // rate limited (right after a restart, often): try this channel again in a minute
        throw e;
      }
    });
  }
}

/** Called once by api.js: hands over the swearing protection and, with DISCORD_BOT_TOKEN set, connects to Discord. */
export function startDiscord({ guardText }) {
  guard = guardText;
  if (!TOKEN) return;
  connect(false);
  // Hosts that sleep when nobody visits (Render's free plan, after 15 minutes) take the bot offline with them. KEEP_AWAKE=1 visits Orata's own
  // address every 10 minutes so it stays up. ponytail: uses the host's free hours around the clock (Render gives 750 a month for all free services).
  if (/^(1|true|on|yes)$/i.test(ENV.KEEP_AWAKE || '')) setInterval(() => {
    const site = PUBLIC || Object.values(links()).find((l) => l.site)?.site;
    if (site) fetch(`${site}/api/config`, { signal: AbortSignal.timeout(20_000) }).catch(() => {});
  }, 10 * 60_000).unref();
}
