// Orate — Orbit in a server: a server can add its own copy of Orbit (ticked when the server is made, or later in Server Settings) that answers
// slash commands. Each server's Orbit is its own bot account, so renaming it or changing its picture in /settings only changes it there.
// Who may use a command: its permission by default (see public/js/orbit-commands.js), narrowed to chosen roles in /settings; owners and admins always may.
import { db, save, newId, emitTo, publicUser, memberView, messageView, serverAudience, audienceOf, can, needIn, need, isOwner, topRolePos, audit, randomAvatarBg, bad, forbidden, ApiError } from './core.js';
import { postMessage } from './messages.js';
import { JOKES, BALL, rollDice } from './bot.js';
import { ORBIT_COMMANDS, orbitCommand, parseDuration, formatDuration } from '../public/js/orbit-commands.js';

const UPLOAD = /^\/uploads\/[A-Za-z0-9_.-]{1,120}$/;
const pickOne = (list) => list[Math.floor(Math.random() * list.length)];
export const hasOrbit = (s) => !!(s?.orbitId && s.members[s.orbitId] && db.users[s.orbitId]);

/** Puts this server's Orbit in it (making the bot account the first time); returns the bot. */
export function addOrbit(s) {
  let bot = db.users[s.orbitId];
  if (!bot) {
    const id = newId();
    bot = db.users[id] = { id, username: 'orbit', displayName: 'Orbit', email: null, bot: true, serverBot: s.id, avatarBg: randomAvatarBg(), status: 'online', createdAt: Date.now(), bio: 'This server’s helper. Type /help to see what I can do.', bannerColor: '#6d28d9', rel: {}, reads: {}, settings: {} };
    s.orbitId = id;
  }
  if (!s.members[bot.id]) s.members[bot.id] = { roles: [], joinedAt: Date.now() };
  save();
  return bot;
}

/** May `uid` use `cmd` here? */
export function mayUse(s, uid, cmd) {
  if (isOwner(s, uid) || can(s, uid, 'ADMINISTRATOR')) return true;
  if (cmd.perm && !can(s, uid, cmd.perm)) return false;
  const roles = s.orbit?.roles?.[cmd.name];
  return !roles?.length || roles.some((r) => s.members[uid]?.roles.includes(r));
}

/** Reacting to a reaction-roles message gives its role, taking the reaction back removes it. Returns the server when a member's roles changed. */
export function reactionRole(ch, msg, emoji, uid, add) {
  const rid = msg.reactionRoles?.[emoji]; const s = ch.serverId && db.servers[ch.serverId];
  if (!rid || !s || db.users[uid]?.bot) return null;
  const m = s.members[uid]; const role = s.roles.find((r) => r.id === rid);
  if (!m || !role || role.permissions.includes('ADMINISTRATOR') || add === m.roles.includes(rid)) return null;
  m.roles = add ? [...m.roles, rid] : m.roles.filter((x) => x !== rid);
  save(); return s;
}

/** "<@id>", "@username", a nickname or a bare id → a member's id (or null). */
function memberFrom(s, token) {
  const t = String(token || '').trim();
  const id = (/^<@!?(\d{6,20})>$/.exec(t) || /^(\d{6,20})$/.exec(t))?.[1];
  if (id) return s.members[id] ? id : null;
  const name = t.replace(/^@/, '').toLowerCase(); if (!name) return null;
  return Object.keys(s.members).find((mid) => db.users[mid]?.username === name || s.members[mid].nick?.toLowerCase() === name) || null;
}
const nameIn = (s, uid) => s.members[uid]?.nick || db.users[uid]?.displayName || 'Someone';

/* ---------------------------------------------------------------- reminders */
const MAX_REMIND = 7 * 86400_000;
function sweepReminders() {
  const now = Date.now(); const due = (db.reminders || []).filter((x) => x.at <= now); if (!due.length) return;
  db.reminders = db.reminders.filter((x) => x.at > now);
  for (const x of due) {
    const ch = db.channels[x.channelId]; const s = ch && db.servers[ch.serverId];
    if (s && hasOrbit(s) && s.members[x.userId]) postMessage(ch, s.orbitId, { content: `⏰ <@${x.userId}> reminder: ${x.text}` });
  }
  save();
}
setTimeout(sweepReminders, 2000).unref();
setInterval(sweepReminders, 15_000).unref();

/* ---------------------------------------------------------------- routes */
export function mountOrbit(r, { h, limit, getServer, getChannel, pushServerUpdate, guardText, automod, kickMember, banMember, timeoutMember }) {
  r.put('/servers/:id/orbit', h(async (req, res) => {
    const s = getServer(req, req.params.id); need(s, req.user.id, 'MANAGE_SERVER');
    const bot = addOrbit(s); audit(s, req.user.id, 'orbit_add');
    emitTo(serverAudience(s), 'member_add', { serverId: s.id, member: memberView(bot.id, s.members[bot.id]), user: publicUser(bot) });
    pushServerUpdate(s); res.json({ ok: true, user: publicUser(bot) });
  }));
  r.delete('/servers/:id/orbit', h(async (req, res) => {
    const s = getServer(req, req.params.id); need(s, req.user.id, 'MANAGE_SERVER');
    if (hasOrbit(s)) { delete s.members[s.orbitId]; audit(s, req.user.id, 'orbit_remove'); save(); emitTo(serverAudience(s), 'member_remove', { serverId: s.id, userId: s.orbitId }); pushServerUpdate(s); }
    res.json({ ok: true });
  }));
  // /settings: this server's Orbit's name, picture and bio, and the roles each command is narrowed to
  r.patch('/servers/:id/orbit', h(async (req, res) => {
    const s = getServer(req, req.params.id); const cmd = orbitCommand('settings');
    if (!hasOrbit(s)) throw bad('Orbit isn’t in this server');
    if (!mayUse(s, req.user.id, cmd)) throw forbidden('You can’t change Orbit’s settings here');
    const b = req.body || {}; const bot = db.users[s.orbitId];
    if (b.displayName !== undefined) { const v = String(b.displayName).trim().slice(0, 32); if (!v) throw bad('Give Orbit a name'); bot.displayName = v; }
    if (b.bio !== undefined) bot.bio = String(b.bio).slice(0, 190);
    if (b.avatar !== undefined) { if (b.avatar !== null && !UPLOAD.test(String(b.avatar))) throw bad('Invalid picture'); bot.avatar = b.avatar; }
    if (b.roles !== undefined) {
      const roles = {};
      for (const c of ORBIT_COMMANDS) { const list = Array.isArray(b.roles?.[c.name]) ? b.roles[c.name].map(String).filter((id) => id !== s.id && s.roles.some((x) => x.id === id)) : []; if (list.length) roles[c.name] = [...new Set(list)]; }
      s.orbit = { ...(s.orbit || {}), roles };
    }
    audit(s, req.user.id, 'orbit_update', { fields: Object.keys(b).filter((k) => b[k] !== undefined) });
    save();
    emitTo(serverAudience(s), 'user_update', { user: publicUser(bot) }); pushServerUpdate(s);
    res.json({ user: publicUser(bot), roles: s.orbit?.roles || {} });
  }));

  // /reactionroles: Orbit posts a message with one reaction per role; reacting gives the role (see reactionRole)
  r.post('/channels/:id/reaction-roles', h(async (req, res) => {
    const ch = getChannel(req, req.params.id); const s = ch.serverId && db.servers[ch.serverId];
    if (!s || !hasOrbit(s)) throw bad('Orbit isn’t in this server');
    if (!mayUse(s, req.user.id, orbitCommand('reactionroles'))) throw forbidden('You can’t set up reaction roles here');
    needIn(req.user.id, ch, 'SEND_MESSAGES');
    const map = {};
    for (const p of (Array.isArray(req.body?.pairs) ? req.body.pairs : []).slice(0, 10)) {
      const emoji = String(p?.emoji || '').trim(); const role = s.roles.find((x) => x.id === String(p?.roleId || ''));
      if (!emoji || emoji.length > 64 || /[<>]/.test(emoji) && !/^<a?:[A-Za-z0-9_]{2,32}:\d{6,20}>$/.test(emoji) || !role || role.id === s.id) continue;
      if (role.permissions.includes('ADMINISTRATOR')) throw bad(`${role.name} can’t be handed out with a reaction`);
      if (!isOwner(s, req.user.id) && role.position >= topRolePos(s, req.user.id)) throw forbidden(`${role.name} is at or above your highest role`);
      map[emoji] = role.id;
    }
    if (!Object.keys(map).length) throw bad('Add at least one emoji with a role');
    const intro = guardText(ch, req.user.id, String(req.body?.content || '').trim().slice(0, 1500)) || 'React to get a role:';
    const lines = Object.entries(map).map(([e, rid]) => `${e} → **${s.roles.find((x) => x.id === rid).name}**`);
    const msg = postMessage(ch, s.orbitId, { content: `${intro}\n\n${lines.join('\n')}` });
    msg.reactionRoles = map; msg.reactions = Object.fromEntries(Object.keys(map).map((e) => [e, [s.orbitId]]));   // Orbit reacts first, so everyone just clicks
    audit(s, req.user.id, 'reaction_roles_create', { channel: ch.name, count: lines.length });
    save(); emitTo(audienceOf(ch), 'message_update', { message: messageView(msg) });
    res.json(messageView(msg));
  }));

  r.post('/channels/:id/command', limit('orbit', 12, 10_000, (req) => req.user.id), h(async (req, res) => {
    const ch = getChannel(req, req.params.id); const s = ch.serverId && db.servers[ch.serverId];
    if (!s || !hasOrbit(s)) throw bad('Orbit isn’t in this server');
    needIn(req.user.id, ch, 'SEND_MESSAGES');
    const cmd = orbitCommand(req.body?.name); if (!cmd) throw bad('Orbit doesn’t know that command. Type /help to see them all.');
    if (!mayUse(s, req.user.id, cmd)) throw forbidden(`You can’t use /${cmd.name} in this server.`);
    const args = String(req.body?.args || '').trim().slice(0, 2000);
    const me = req.user.id; const who = `**${nameIn(s, me)}**`;
    const text = (v) => { automod(ch, me, v); return guardText(ch, me, v); };   // AutoMod and swearing protection apply to what Orbit repeats for you
    const post = (content) => { postMessage(ch, s.orbitId, { content }); return { ok: true }; };
    const only = (content) => ({ ephemeral: content });
    const [first = '', ...rest] = args.split(/\s+/); const tail = rest.join(' ').trim();
    const target = () => { const id = memberFrom(s, first); if (!id) throw bad(`Tell Orbit who: /${cmd.name} @member${cmd.name === 'timeout' ? ' 10m' : ''} (or their ID)`); return id; };
    switch (cmd.name) {
      case 'help': {
        const lines = ORBIT_COMMANDS.filter((c) => mayUse(s, me, c)).map((c) => `\`/${c.name}${c.arg ? ' ' + c.arg : ''}\` — ${c.desc}`);
        return res.json(only(`**Hi, I’m ${db.users[s.orbitId].displayName}!** Here’s what you can do:\n${lines.join('\n')}`));
      }
      case 'ping': return res.json(only('Pong! 🏓'));
      case 'roll': return res.json(post(`${rollDice(args)} — rolled by ${who}`));
      case 'flip': return res.json(post(`🪙 ${who} flipped **${Math.random() < 0.5 ? 'heads' : 'tails'}**`));
      case 'joke': return res.json(post(pickOne(JOKES)));
      case '8ball': {
        if (!args) throw bad('Ask a question: /8ball will it rain?');
        return res.json(post(`🎱 ${who} asked: ${text(args)}\n**${pickOne(BALL)}**`));
      }
      case 'choose': {
        const opts = args.split(/\s*[|,]\s*/).filter(Boolean);
        if (opts.length < 2) throw bad('Give Orbit at least two choices: /choose pizza | tacos');
        return res.json(post(`🤔 ${who}, I pick **${text(pickOne(opts))}**`));
      }
      case 'say': {
        if (!args) throw bad('What should Orbit say? /say hello everyone');
        return res.json(post(text(args)));
      }
      case 'remind': {
        const ms = parseDuration(first);
        if (!ms || ms < 60_000 || ms > MAX_REMIND) throw bad('Say when, from 1 minute to 7 days: /remind 10m stretch');
        if ((db.reminders || []).filter((x) => x.userId === me).length >= 10) throw bad('You already have 10 reminders waiting');
        (db.reminders ||= []).push({ id: newId(), channelId: ch.id, userId: me, at: Date.now() + ms, text: text(tail || 'this').slice(0, 300) });
        save();
        return res.json(only(`⏰ Okay! I’ll remind you here in **${formatDuration(ms)}**.`));
      }
      case 'kick': {
        const uid = target(); const name = nameIn(s, uid); const why = text(tail);
        kickMember(req, s, uid, why);
        return res.json(post(`👢 **${name}** was kicked by ${who}.${why ? ` Reason: ${why}` : ''}`));
      }
      case 'ban': {
        const uid = target(); const name = nameIn(s, uid); const why = text(tail);
        const alts = banMember(req, s, uid, { reason: why });
        return res.json(post(`🔨 **${name}** was banned by ${who}.${why ? ` Reason: ${why}` : ''}${alts.length ? ` (${alts.length} other account${alts.length === 1 ? '' : 's'} of theirs too)` : ''}`));
      }
      case 'timeout': {
        const uid = target(); const [dur = '', ...why0] = rest; const ms = parseDuration(dur);
        if (!ms) throw bad('Give a duration: /timeout @member 10m (s, m, h, d or w — up to 28 days)');
        const minutes = Math.min(28 * 1440, Math.max(1, Math.ceil(ms / 60_000))); const why = text(why0.join(' ').trim());
        timeoutMember(req, s, uid, minutes, why);
        return res.json(post(`⏳ **${nameIn(s, uid)}** was timed out for **${formatDuration(minutes * 60_000)}** by ${who}.${why ? ` Reason: ${why}` : ''}`));
      }
      case 'settings': return res.json(only('Type /settings in the message box to open Orbit’s settings.'));
      case 'reactionroles': return res.json(only('Type /reactionroles in the message box to set up a reaction-roles message.'));
      default: throw new ApiError(400, 'Unknown command');
    }
  }));
}
