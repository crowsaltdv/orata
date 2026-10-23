// Orata — what Discord servers add third-party bots for, built into Orbit: a counting channel, welcome and goodbye messages, a role for everyone
// who joins, levels (XP, /rank, /leaderboard, level-up roles), giveaways, a starboard, tickets, warnings, saved replies (/tag), suggestions,
// a member-count channel and /slowmode. Settings live in `server.orbit` (next to the roles each command is narrowed to, orbit.js); warnings in
// `server.warnings`; running giveaways in `db.giveaways`. orbit.js runs the commands through plusCommand(); the rest reacts to messages,
// reactions and people joining or leaving (hooks in messages.js).
import crypto from 'node:crypto';
import { db, save, newId, emitTo, audienceOf, messageView, channelView, listedFor, serverAudience, memberView, sanitizeOverwrites, can, isOwner, topRolePos, audit, bad, forbidden } from './core.js';
import { hooks, postMessage } from './messages.js';
import { parseDuration, formatDuration } from '../public/js/orbit-commands.js';

const hasOrbit = (s) => !!(s?.orbitId && s.members[s.orbitId] && db.users[s.orbitId]);
const humans = (s) => Object.keys(s.members).filter((id) => !db.users[id]?.bot);
const levelOf = (xp) => Math.floor(Math.sqrt(xp / 100));   // level 1 at 100 XP, 2 at 400, 5 at 2,500, 10 at 10,000
const XP_GAP = 60_000;   // one rewarded message a minute, so spamming earns nothing

/** Orbit adds its own reaction (✅, 🎉, 👍…) to a message. */
function orbitReact(ch, m, emoji) {
  const s = db.servers[ch.serverId]; m.reactions ||= {};
  if (!(m.reactions[emoji] || []).includes(s.orbitId)) m.reactions[emoji] = [...(m.reactions[emoji] || []), s.orbitId];
  save(); emitTo(audienceOf(ch), 'message_update', { message: messageView(m) });
}
/** Tells everyone in the server about a channel that was made, changed or removed (each sees it only if they may). */
function pushChannel(s, ch, op) {
  for (const uid of serverAudience(s)) {
    if (op === 'channel_delete' || !listedFor(uid, ch)) emitTo([uid], 'channel_delete', { serverId: s.id, channelId: ch.id });
    else emitTo([uid], op, { channel: channelView(ch, uid) });
  }
}
function makeChannel(s, fields) {
  if (Object.values(db.channels).filter((c) => c.serverId === s.id).length >= 200) throw bad('This server already has 200 channels');
  const ch = { id: newId(), serverId: s.id, parentId: null, position: 0, topic: '', ...fields };
  db.channels[ch.id] = ch; db.messages[ch.id] = []; save(); pushChannel(s, ch, 'channel_create');
  return ch;
}
function removeChannel(s, ch) { delete db.channels[ch.id]; delete db.messages[ch.id]; save(); pushChannel(s, ch, 'channel_delete'); }
/** A role Orbit may hand out for `uid`: not an admin role, and below their own top role (owners may give any). */
function checkRole(s, uid, role) {
  if (role.permissions.includes('ADMINISTRATOR')) throw bad(`${role.name} has Administrator, so Orbit won’t hand it out`);
  if (!isOwner(s, uid) && role.position >= topRolePos(s, uid)) throw forbidden(`${role.name} is at or above your highest role`);
}
export function giveRole(s, uid, rid) {
  const m = s.members[uid]; const role = s.roles.find((r) => r.id === rid);
  if (!m || !role || role.permissions.includes('ADMINISTRATOR') || m.roles.includes(rid)) return null;
  m.roles.push(rid); save(); emitTo(serverAudience(s), 'member_update', { serverId: s.id, member: memberView(uid, m) });
  return role;
}
/** "#name", "<#id>" or an id → a channel of this server (plain words are never channels). */
function channelArg(s, token) {
  const t = String(token || '').trim(); const id = (/^<#(\d+)>$/.exec(t) || /^(\d{6,20})$/.exec(t))?.[1];
  const list = Object.values(db.channels).filter((c) => c.serverId === s.id && !['category', 'post'].includes(c.type));
  if (id) return list.find((c) => c.id === id) || null;
  return t.startsWith('#') ? list.find((c) => c.name.toLowerCase() === t.slice(1).toLowerCase()) || null : null;
}
/** "@Name", "<@&id>", a role's name or its id → one of this server's roles (not @everyone). */
function roleArg(s, text) {
  const t = String(text || '').trim(); const id = (/^<@&(\d+)>$/.exec(t) || /^(\d{6,20})$/.exec(t))?.[1];
  return s.roles.find((r) => r.id !== s.id && (id ? r.id === id : r.name.toLowerCase() === t.replace(/^@/, '').toLowerCase())) || null;
}
const fill = (text, s, uid, mention) => String(text).replace(/\{user\}/g, mention ? `<@${uid}>` : `**${db.users[uid]?.displayName || 'Someone'}**`).replace(/\{name\}/g, db.users[uid]?.displayName || 'Someone')
  .replace(/\{server\}/g, s.name).replace(/\{count\}/g, String(humans(s).length));
const countName = (s) => `👥 Members: ${humans(s).length}`;
function updateCount(s) {
  const c = db.channels[s.orbit?.memberCount]; if (!c) return;
  const name = countName(s); if (c.name !== name) { c.name = name; save(); pushChannel(s, c, 'channel_update'); }
}
const shuffle = (list) => { const a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };

/* ---------------------------------------------------------------- messages: counting and levels */
hooks.onMessage.push((ch, m) => {
  const s = ch.serverId && db.servers[ch.serverId];
  if (!s || !hasOrbit(s) || m.type !== 'default' || db.users[m.authorId]?.bot) return;
  const c = s.orbit?.counting;
  if (c?.channelId === ch.id && /^\d{1,9}$/.test(String(m.content || '').trim())) {   // in the counting channel, anything that isn't a number is just chat
    const n = Number(m.content.trim()); const twice = m.authorId === c.last && n === c.count + 1;   // the right number, but they counted the one before too
    if (n === c.count + 1 && m.authorId !== c.last) { c.count = n; c.last = m.authorId; c.best = Math.max(c.best || 0, n); save(); orbitReact(ch, m, '✅'); }
    else {
      const was = c.count; c.count = 0; c.last = null; save(); orbitReact(ch, m, '❌');
      postMessage(ch, s.orbitId, { content: `❌ <@${m.authorId}> ruined it at **${was}**! ${twice ? 'You can’t count twice in a row.' : `The next number was **${was + 1}**.`} Start again from **1**. (Best so far: ${c.best || 0})` });
    }
  }
  const L = s.orbit?.levels;
  if (L?.on) {
    const me = ((s.orbit.xp ||= {})[m.authorId] ||= { xp: 0, at: 0 });
    if (Date.now() - me.at < XP_GAP) return;
    const before = levelOf(me.xp); me.xp += 15 + crypto.randomInt(11); me.at = Date.now(); save();
    const after = levelOf(me.xp); if (after <= before) return;
    const rid = L.rewards?.[after]; const role = rid && giveRole(s, m.authorId, rid);
    const where = (L.channelId && db.channels[L.channelId]?.serverId === s.id && db.channels[L.channelId]) || ch;
    postMessage(where, s.orbitId, { content: `🎉 <@${m.authorId}> reached **level ${after}**!${role ? ` You got the **${role.name}** role.` : ''}` });
  }
});

/* ---------------------------------------------------------------- joining and leaving: welcome, goodbye, a role for newcomers, the member count */
hooks.onJoin.push((s, uid) => {
  if (!hasOrbit(s) || db.users[uid]?.bot) return;
  const o = s.orbit || {};
  if (o.autorole) giveRole(s, uid, o.autorole);
  const ch = o.welcome && db.channels[o.welcome.channelId];
  if (ch?.serverId === s.id) postMessage(ch, s.orbitId, { content: fill(o.welcome.text, s, uid, true) });
  updateCount(s);
});
hooks.onLeave.push((s, uid) => {
  if (!hasOrbit(s) || db.users[uid]?.bot) return;
  const o = s.orbit || {}; const ch = o.goodbye && db.channels[o.goodbye.channelId];
  if (ch?.serverId === s.id) postMessage(ch, s.orbitId, { content: fill(o.goodbye.text, s, uid, false) });
  if (o.tickets?.open) for (const [cid, owner] of Object.entries(o.tickets.open)) if (owner === uid) delete o.tickets.open[cid];   // their ticket stays for staff to close
  updateCount(s);
});

/* ---------------------------------------------------------------- reactions: the starboard */
hooks.onReact.push((ch, m, emoji, uid, add) => {
  const s = ch.serverId && db.servers[ch.serverId]; const sb = s?.orbit?.starboard;
  if (!add || emoji !== '⭐' || !sb || !hasOrbit(s) || ch.id === sb.channelId || (m.type && m.type !== 'default')) return;
  const stars = (m.reactions?.['⭐'] || []).length; const board = db.channels[sb.channelId];
  if (stars < sb.stars || !board || (sb.posted ||= []).includes(m.id)) return;
  sb.posted.push(m.id); if (sb.posted.length > 500) sb.posted.splice(0, sb.posted.length - 500); save();
  const author = db.users[m.authorId];
  postMessage(board, s.orbitId, { content: `⭐ **${stars}** in <#${ch.id}>`, forward: { messageId: m.id, channelId: ch.id, serverId: s.id, authorId: m.authorId, authorName: m.bridge?.name || s.members[m.authorId]?.nick || author?.displayName || 'Someone',
    from: `#${ch.name} · ${s.name}`, content: m.content || '', attachments: (m.attachments || []).filter((a) => !a.voice), gif: m.gif || null, sticker: m.sticker || null, createdAt: m.createdAt } });
});

/* ---------------------------------------------------------------- giveaways: ended by the clock (or /giveaway end) */
function endGiveaway(g) {
  db.giveaways = (db.giveaways || []).filter((x) => x.id !== g.id);
  const ch = db.channels[g.channelId]; const s = ch && db.servers[ch.serverId]; const m = ch && (db.messages[ch.id] || []).find((x) => x.id === g.messageId);
  if (s && hasOrbit(s)) {
    const winners = shuffle([...new Set(m?.reactions?.['🎉'] || [])].filter((id) => s.members[id] && !db.users[id]?.bot)).slice(0, g.winners);
    postMessage(ch, s.orbitId, { content: winners.length ? `🎉 Congratulations ${winners.map((w) => `<@${w}>`).join(', ')}! You won **${g.prize}**.` : `🎉 The giveaway for **${g.prize}** is over, but nobody entered.`, replyTo: m?.id || null, replyPing: false });
  }
  save();
}
function sweepGiveaways() { const now = Date.now(); for (const g of (db.giveaways || []).filter((x) => x.endsAt <= now)) endGiveaway(g); }
setTimeout(sweepGiveaways, 3000).unref();
setInterval(sweepGiveaways, 15_000).unref();

/* ---------------------------------------------------------------- the commands */
/** Runs one of these commands for orbit.js (which has already checked the person may use it). Returns the answer, or null for another command.
 *  x: { s, ch, me, args, first, rest, who, text (AutoMod + swearing protection), post (Orbit posts it), only (only they see it), member (a member from "@name") } */
export function plusCommand(name, x) {
  const { s, ch, me, args, first, rest, who, text, post, only } = x;
  const o = (s.orbit ||= {}); const off = /^off$/i.test(args);
  const after1 = args.replace(/^\S+\s*/, '');   // everything after the first word, line breaks kept
  const nameIn = (uid) => s.members[uid]?.nick || db.users[uid]?.displayName || 'Someone';
  switch (name) {
    case 'counting': {
      if (off) { delete o.counting; save(); return only('🔢 Counting is off.'); }
      const where = args ? channelArg(s, first) : ch;
      if (!where || where.type !== 'text') throw bad('Pick a text channel: /counting #channel (or /counting off)');
      o.counting = { channelId: where.id, count: 0, last: null, best: o.counting?.best || 0 }; save();
      postMessage(where, s.orbitId, { content: '🔢 **Counting starts here!** Count up one number at a time, starting at **1**. Nobody counts twice in a row, and a wrong number starts it over.' });
      return only(`🔢 Counting is on in <#${where.id}>.`);
    }
    case 'welcome': case 'goodbye': {
      const label = name === 'welcome' ? '👋 Welcome' : '🚪 Goodbye';
      if (off) { delete o[name]; save(); return only(`${label} messages are off.`); }
      const picked = channelArg(s, first); const where = picked || ch; let msg = (picked ? after1 : args).trim();
      if (where.type !== 'text') throw bad(`${label} messages need a text channel`);
      if (!msg) msg = name === 'welcome' ? 'Welcome to **{server}**, {user}! You’re member number {count}.' : '**{name}** left the server. See you around!';
      o[name] = { channelId: where.id, text: text(msg).slice(0, 1000) }; save();
      return only(`${label} messages are on in <#${where.id}>. Like this:\n> ${fill(o[name].text, s, me, name === 'welcome').replace(/\n/g, '\n> ')}\nYou can use {user}, {name}, {server} and {count}. Turn it off with /${name} off.`);
    }
    case 'autorole': {
      if (off) { delete o.autorole; save(); return only('Newcomers don’t get a role any more.'); }
      const role = roleArg(s, args); if (!role) throw bad('Name a role: /autorole @role (or /autorole off)');
      checkRole(s, me, role); o.autorole = role.id; save();
      return only(`Everyone who joins from now on gets **${role.name}**.`);
    }
    case 'levels': {
      const L = (o.levels ||= { on: false, rewards: {} }); L.rewards ||= {}; const sub = first.toLowerCase();
      if (sub === 'on' || sub === 'off') { L.on = sub === 'on'; save(); return only(L.on ? '⭐ Levels are on. People earn XP for chatting (once a minute) and I announce level-ups. /rank and /leaderboard show where everyone stands.' : '⭐ Levels are off. Everyone keeps their XP.'); }
      if (sub === 'channel') {
        const where = /^(here|off)?$/i.test(rest[0] || '') ? null : channelArg(s, rest[0]);
        if (rest[0] && !/^(here|off)$/i.test(rest[0]) && !where) throw bad('Pick a channel: /levels channel #channel (or /levels channel here)');
        L.channelId = where?.id || null; save(); return only(where ? `Level-ups are announced in <#${where.id}>.` : 'Level-ups are announced wherever someone levels up.');
      }
      if (sub === 'reward') {
        const lvl = Number(rest[0]); if (!Number.isInteger(lvl) || lvl < 1 || lvl > 100) throw bad('Say the level and the role: /levels reward 5 @role (or /levels reward 5 off)');
        const r = rest.slice(1).join(' ');
        if (/^off$/i.test(r)) { delete L.rewards[lvl]; save(); return only(`Level ${lvl} no longer gives a role.`); }
        const role = roleArg(s, r); if (!role) throw bad('Name a role: /levels reward 5 @role');
        checkRole(s, me, role); L.rewards[lvl] = role.id; save(); return only(`Reaching level ${lvl} now gives **${role.name}**.`);
      }
      const rewards = Object.entries(L.rewards).map(([l, rid]) => `level ${l} → ${s.roles.find((r) => r.id === rid)?.name || 'a deleted role'}`);
      return only([`⭐ Levels are **${L.on ? 'on' : 'off'}**.${L.channelId && db.channels[L.channelId] ? ` Level-ups go to <#${L.channelId}>.` : ''}`, rewards.length ? `Roles: ${rewards.join(', ')}.` : 'No level roles yet.',
        '`/levels on` or `off` · `/levels channel #channel` · `/levels reward 5 @role`'].join('\n'));
    }
    case 'rank': {
      const uid = args ? x.member() : me; const all = Object.entries(o.xp || {}).filter(([id]) => s.members[id]).sort((a, b) => b[1].xp - a[1].xp);
      const xp = o.xp?.[uid]?.xp || 0; const lvl = levelOf(xp); const pos = all.findIndex(([id]) => id === uid) + 1;
      return only(`⭐ **${nameIn(uid)}** is level **${lvl}** with **${xp} XP** (${100 * (lvl + 1) ** 2 - xp} more for level ${lvl + 1}).${pos ? ` Rank **#${pos}** here.` : ''}${o.levels?.on ? '' : ' (Levels are off in this server.)'}`);
    }
    case 'leaderboard': {
      const top = Object.entries(o.xp || {}).filter(([id]) => s.members[id] && o.xp[id].xp > 0).sort((a, b) => b[1].xp - a[1].xp).slice(0, 10);
      if (!top.length) return only(`Nobody has any XP yet.${o.levels?.on ? '' : ' Turn levels on with /levels on.'}`);
      return post(`🏆 **${s.name} leaderboard**\n${top.map(([id, v], i) => `${['🥇', '🥈', '🥉'][i] || `**${i + 1}.**`} ${nameIn(id)}: level ${levelOf(v.xp)} · ${v.xp} XP`).join('\n')}`);
    }
    case 'giveaway': {
      if (first.toLowerCase() === 'end') {
        const g = [...(db.giveaways || [])].reverse().find((y) => y.channelId === ch.id); if (!g) throw bad('There’s no giveaway running in this channel.');
        endGiveaway(g); return { ok: true };
      }
      const ms = parseDuration(first); if (!ms || ms < 60_000 || ms > 30 * 86400_000) throw bad('Say how long, from 1 minute to 30 days: /giveaway 1h 1 Nitro (or /giveaway end)');
      let winners = 1; let words = rest;
      if (/^\d{1,2}$/.test(rest[0] || '')) { winners = Math.min(20, Math.max(1, Number(rest[0]))); words = rest.slice(1); }
      const prize = text(words.join(' ').trim()).slice(0, 200); if (!prize) throw bad('Say what the prize is: /giveaway 1h 1 Nitro');
      if ((db.giveaways || []).filter((g) => g.serverId === s.id).length >= 10) throw bad('This server already has 10 giveaways running');
      const m = postMessage(ch, s.orbitId, { content: `🎉 **GIVEAWAY: ${prize}**\nReact with 🎉 to enter! **${winners}** winner${winners === 1 ? '' : 's'}, picked in **${formatDuration(ms)}**.\nHosted by ${who}`, command: { name, by: me } });
      orbitReact(ch, m, '🎉');
      (db.giveaways ||= []).push({ id: newId(), serverId: s.id, channelId: ch.id, messageId: m.id, prize, winners, endsAt: Date.now() + ms, by: me });
      audit(s, me, 'orbit_command', { command: name, channel: ch.name }); save();
      return { ok: true };
    }
    case 'starboard': {
      if (off) { delete o.starboard; save(); return only('⭐ The starboard is off.'); }
      const words = args.split(/\s+/).filter(Boolean); const where = words.map((w) => channelArg(s, w)).find(Boolean) || ch;
      const stars = Number(words.find((w) => /^\d{1,2}$/.test(w)) || 3);
      if (where.type !== 'text' || stars < 1 || stars > 50) throw bad('Pick a text channel and how many stars (1–50): /starboard #starboard 3');
      o.starboard = { channelId: where.id, stars, posted: o.starboard?.posted || [] }; save();
      return only(`⭐ Messages that get **${stars}** ⭐ reactions are posted in <#${where.id}>.`);
    }
    case 'ticket': {
      const T = (o.tickets ||= { open: {} }); T.open ||= {};
      const mine = Object.entries(T.open).find(([cid, uid]) => uid === me && db.channels[cid]); if (mine) return only(`You already have a ticket open: <#${mine[0]}>`);
      const hidden = { type: 'role', id: s.id, allow: [], deny: ['VIEW_CHANNEL'] };
      let cat = db.channels[T.categoryId];
      if (cat?.serverId !== s.id) { cat = makeChannel(s, { type: 'category', name: 'Tickets', position: 999, overwrites: sanitizeOverwrites(s, [hidden]) }); T.categoryId = cat.id; }
      const staff = s.roles.filter((r) => r.id !== s.id && r.permissions.includes('MANAGE_MESSAGES') && !r.permissions.includes('ADMINISTRATOR'));
      const overwrites = sanitizeOverwrites(s, [hidden, { type: 'member', id: me, allow: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'ATTACH_FILES'], deny: [] }, { type: 'member', id: s.orbitId, allow: ['VIEW_CHANNEL', 'SEND_MESSAGES'], deny: [] },
        ...staff.map((r) => ({ type: 'role', id: r.id, allow: ['VIEW_CHANNEL', 'SEND_MESSAGES'], deny: [] }))]);
      const topic = text(args).slice(0, 200);
      const t = makeChannel(s, { type: 'text', name: `ticket-${db.users[me].username}`.slice(0, 100), parentId: cat.id, synced: false, overwrites, topic });
      T.open[t.id] = me; save();
      postMessage(t, s.orbitId, { content: `🎫 **Ticket opened by <@${me}>**${topic ? `: ${topic}` : ''}\nOnly you and the server’s staff can see this channel. Type **/close** when you’re done.` });
      return only(`🎫 Your ticket is open: <#${t.id}>`);
    }
    case 'close': {
      const owner = o.tickets?.open?.[ch.id] ?? (ch.parentId && ch.parentId === o.tickets?.categoryId ? null : undefined);
      if (owner === undefined) throw bad('/close only works in a ticket channel.');
      if (owner !== me && !can(s, me, 'MANAGE_MESSAGES')) throw forbidden('Only whoever opened this ticket, or the server’s staff, can close it.');
      delete o.tickets.open[ch.id]; removeChannel(s, ch); audit(s, me, 'ticket_close', { ...(owner ? { target: owner } : {}), channel: ch.name });
      return { ok: true };
    }
    case 'warn': {
      const uid = x.member(); if (uid === me) throw bad('You can’t warn yourself'); if (db.users[uid]?.bot) throw bad('Bots can’t be warned');
      if (!isOwner(s, me) && topRolePos(s, uid) >= topRolePos(s, me)) throw forbidden('You can’t warn someone whose role is as high as yours');
      const why = text(after1.trim()).slice(0, 300); const list = ((s.warnings ||= {})[uid] ||= []);
      list.push({ at: Date.now(), by: me, reason: why }); if (list.length > 50) list.shift();
      audit(s, me, 'member_warn', { target: uid, reason: why }); save();
      return post(`⚠️ **${nameIn(uid)}** was warned by ${who}${why ? `: ${why}` : '.'} That’s warning **#${list.length}**.`);
    }
    case 'warnings': {
      const uid = x.member(); const list = s.warnings?.[uid] || [];
      if (!list.length) return only(`**${nameIn(uid)}** has no warnings here.`);
      return only(`⚠️ **${nameIn(uid)}** has ${list.length} warning${list.length === 1 ? '' : 's'}:\n${list.slice(-15).map((w, i) => `${i + 1}. ${new Date(w.at).toISOString().slice(0, 10)}, by ${nameIn(w.by)}${w.reason ? `: ${w.reason}` : ''}`).join('\n')}`);
    }
    case 'clearwarnings': {
      const uid = x.member(); const n = s.warnings?.[uid]?.length || 0;
      if (n) { delete s.warnings[uid]; audit(s, me, 'member_warnings_clear', { target: uid, count: n }); save(); }
      return only(n ? `Cleared ${n} warning${n === 1 ? '' : 's'} for **${nameIn(uid)}**.` : `**${nameIn(uid)}** had no warnings.`);
    }
    case 'tag': {
      const tags = (o.tags ||= {}); const sub = first.toLowerCase();
      if (!args) return only(Object.keys(tags).length ? `🏷️ Saved replies: ${Object.keys(tags).sort().map((k) => `\`${k}\``).join(', ')}\nPost one with /tag name.` : 'No saved replies yet. Someone with Manage Messages can add one: /tag add rules Be nice to each other!');
      if (sub === 'add' || sub === 'remove') {
        if (!can(s, me, 'MANAGE_MESSAGES')) throw forbidden('You need the Manage Messages permission to change saved replies.');
        const key = (rest[0] || '').toLowerCase(); if (!/^[a-z0-9_-]{1,32}$/.test(key)) throw bad('Give it a short name (letters, numbers, - or _): /tag add rules Be nice!');
        if (sub === 'remove') { if (!tags[key]) throw bad(`There’s no saved reply called “${key}”.`); delete tags[key]; save(); return only(`Removed \`${key}\`.`); }
        const body = text(after1.replace(/^\S+\s*/, '').trim()).slice(0, 2000); if (!body) throw bad('Add what it should say: /tag add rules Be nice!');
        if (!tags[key] && Object.keys(tags).length >= 100) throw bad('A server can have at most 100 saved replies');
        tags[key] = body; save(); return only(`Saved. Anyone can post it with \`/tag ${key}\`.`);
      }
      if (!tags[sub]) throw bad(`There’s no saved reply called “${first}”. /tag lists them.`);
      return post(tags[sub]);
    }
    case 'suggest': {
      if (!args) throw bad('Write your idea: /suggest a channel for memes');
      const where = (o.suggestions && db.channels[o.suggestions]?.serverId === s.id && db.channels[o.suggestions]) || ch;
      const m = postMessage(where, s.orbitId, { content: `💡 **Suggestion from ${nameIn(me)}**\n${text(args).slice(0, 1500)}`, command: { name, by: me } });
      orbitReact(where, m, '👍'); orbitReact(where, m, '👎');
      return where.id === ch.id ? { ok: true } : only(`💡 Posted in <#${where.id}>.`);
    }
    case 'suggestions': {
      if (off) { delete o.suggestions; save(); return only('Suggestions are posted wherever /suggest is used.'); }
      const where = args ? channelArg(s, first) : ch; if (!where || where.type !== 'text') throw bad('Pick a text channel: /suggestions #suggestions');
      o.suggestions = where.id; save(); return only(`💡 /suggest now posts in <#${where.id}>, with 👍 and 👎 to vote.`);
    }
    case 'membercount': {
      const old = db.channels[o.memberCount];
      if (off) { if (old) removeChannel(s, old); delete o.memberCount; save(); return only('Removed the member count channel.'); }
      if (old) { updateCount(s); return only(`The member count is already shown in <#${old.id}>.`); }
      const c = makeChannel(s, { type: 'voice', name: countName(s), position: -1, overwrites: sanitizeOverwrites(s, [{ type: 'role', id: s.id, allow: [], deny: ['CONNECT'] }]) });
      o.memberCount = c.id; save();
      return only(`👥 <#${c.id}> now shows how many members the server has, and keeps itself up to date.`);
    }
    case 'slowmode': {
      const stop = off || args === '0'; const ms = stop ? 0 : parseDuration(first);
      if (!stop && (!ms || ms > 21600_000)) throw bad('Say how long, up to 6 hours: /slowmode 10s (or /slowmode off)');
      ch.slowmode = Math.round(ms / 1000); save(); pushChannel(s, ch, 'channel_update');
      return only(stop ? '🐢 Slowmode is off here.' : `🐢 Slowmode: one message every **${formatDuration(ms)}** here. Moderators aren’t slowed down.`);
    }
    default: return null;
  }
}
