// Orata — tools for Orata's own staff (the Staff page under the + in the server rail), for holders of the staff or dev badge (only the two
// founders hand those out, badges.js). Numbers about the whole of Orata; finding accounts; locking one for a while or terminating it for good
// (both undoable); and flags: messages and accounts Orata itself finds suspicious (spam bursts, mass pings, invite spam, scam links, many
// accounts on one browser, a day-old account messaging lots of people) plus what people report to staff. Server rules (NSFW channels and the
// like) are each server's business, not this. A DM can only be read from a flag or report about a message in it (and each look goes in the
// staff log); Orata checks DMs for scam links, and for the "messaging lots of people" check only who and how many are counted, never what.
// Every staff action goes in the staff log.
// Servers: every server, fishy ones first (reported, flagged messages, terminated members, a scam-looking name), and "ghosting" into a reported or
// flagged one to read it without joining (core.js ghosts: read only and invisible; each time goes in the staff log). DMs: every DM and group DM
// with a flagged or reported message, to read around that message.
import { db, save, newId, emitTo, audienceOf, effectiveStatus, publicUser, messageView, deviceHashesOf, canView, closeConns, serverView, ghosts, bad, forbidden, notFound } from './core.js';
import { hooks, messagesDeleted } from './messages.js';
import { endUserSessions } from './sessions.js';
import { isFounder, isStaff } from './names.js';
import { hasProfanity } from './profanity.js';

const KEEP_FLAGS = 1000; const KEEP_LOG = 1000;
const LOCKS = [1, 6, 24, 72, 168, 720];   // hours
// what people can report: things the Community Guidelines (public/guidelines.html) forbid
const REASONS = { hate: 'Hate speech', threats: 'Threats or violent extremism', 'self-harm': 'Self-harm or suicide', 'child-safety': 'Sexualizing minors', nonconsensual: 'Intimate images shared without consent',
  nsfw: 'Adult or gory content where it isn’t allowed', privacy: 'Sharing someone’s private info', scam: 'Scam, phishing or malware', impersonation: 'Pretending to be someone or Orata staff',
  'ban-evasion': 'Dodging a ban with another account', illegal: 'Illegal goods, services or piracy', misinformation: 'Harmful misinformation' };
const URGENT = new Set(['self-harm', 'child-safety', 'threats']);   // never hidden as a joke (someone may be in danger): one that looks like a joke is tagged and sorted last
// words a message reported for one of those would likely have; a short text message with none of them doesn't look like it's about that
const RELATED = {
  'child-safety': /\b(?:kids?|child(?:ren)?|minors?|under ?age|young|little|teens?|school|grade|\d{1,2} ?(?:yo|y\/o|years? old)|age|how old|nudes?|naked|pics?|photos?|send|sex\w*|hot|body|touch|private|snap|meet|cp|loli|baby|babe)\b/i,
  'self-harm': /\b(?:kill|die|dying|dead|suicid\w*|cut(?:ting)?|end it|kms|kys|hurt|harm|pills|overdose|jump|goodbye|no point|hate myself|worthless)\b/i,
  threats: /\b(?:kill|shoot|shot|gun|knife|stab|bomb|hurt|beat|attack|find you|address|swat|dox\w*|die|dead|murder|threat\w*)\b/i,
};
const JOKE = /^(?:(?:jk|j\/k|lol+|lmf?ao+|rofl|(?:ha)+h?|(?:he)+h?|xd+|test(?:ing)?|just kidding|kidding|for fun|bruh+|idk|nothing|no reason|cuz|bc|because|random|joke|trolling|troll|meme|sus)\s*)+$/i;
const HARMLESS = new Set('hi hello hey heya hiya yo sup gm gn ok okay k kk yes yeah yep ya no nope nah lol lmao haha thanks thank you ty thx np bye cya cool nice good great morning night what why how who when where wow same true facts bruh hmm oh ah ye'.split(' '));
/** Why a report is obviously a joke or fake, so staff aren't shown it (they can still look), or null. Only the plain cases:
 *  a note that just says it's a joke (or is keyboard mashing), a report of an everyday message ("hi"), or a third report of the same person in a day. */
function fakeWhy({ reason, note, reporter, userId, m }) {
  const words = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}/\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const said = words(note); const flat = said.join('');
  if (said.length && JOKE.test(said.join(' '))) return 'the note says it’s a joke';
  if (!said.length && /[😂🤣💀😭🤡]/u.test(note)) return 'the note is only laughing emoji';
  if (flat.length >= 5 && /^[a-z]+$/.test(flat) && (/^(.)\1+$/.test(flat) || /^[^aeiouy]+$/.test(flat) || /asdf|qwer|zxcv|hjkl|sdfg|dfgh|fghj/.test(flat))) return 'the note is keyboard mashing';
  if (m && !m.attachments?.length && !m.gif && !m.sticker && !m.forward && !m.poll) {
    const w = words(m.content);
    if (w.length && w.length <= 4 && w.every((x) => HARMLESS.has(x) || /^\d+$/.test(x)) && !hasProfanity(m.content)) return `it’s an everyday message (“${String(m.content).trim().slice(0, 30)}”)`;
    if (RELATED[reason] && w.length <= 8 && !m.embeds?.length && !/https?:\/\//i.test(m.content || '') && !RELATED[reason].test(m.content || '')) return 'the message doesn’t seem to have anything to do with that';
  }
  const today = (db.flags || []).filter((f) => f.reportedBy === reporter && f.userId === userId && f.at > Date.now() - 86400_000).length;
  if (today >= 2) return 'the same person already reported them twice today';
  return null;
}
const INVITE = /\/invite\/[A-Za-z0-9-]{3,}|discord(?:app)?\.(?:gg|com\/invite)\/\S+/i;
const SCAM = /free\s*nitro|nitro\s*(?:giveaway|for\s*free)|discord-?(?:gift|nitro)s?\.(?!com\b)[a-z]{2,}|steam\s*(?:gift|giveaway)|airdrop|claim\s+your\s+(?:prize|reward|gift)|crypto\s*(?:giveaway|doubl)|grabify|iplogger|2no\.co|blasze|yip\.su|ps3cfw|bit\.ly\/[a-z0-9]+.*(?:nitro|gift)/i;
const LABEL = { spam: 'Spam burst', invite_spam: 'Invite spam', mass_mentions: 'Mass mentions', scam: 'Scam-looking link', dm_fanout: 'Messaging lots of people', alts: 'Many accounts on one browser' };

/** Why `u` can't use Orata right now (terminated, or locked until a time), or null. */
export function accountBlock(u) {
  if (u?.terminated) return `This account was terminated by Orata staff.${u.terminated.reason ? ` Reason: ${u.terminated.reason}` : ''}`;
  if (u?.lockedUntil > Date.now()) return `This account is locked by Orata staff until ${new Date(u.lockedUntil).toUTCString().replace('GMT', 'UTC')}.${u.lockReason ? ` Reason: ${u.lockReason}` : ''}`;
  return null;
}
function log(by, action, target, reason = '', details = {}) {
  (db.staffLog ||= []).push({ id: newId(), at: Date.now(), by, action, target, reason, ...details });
  if (db.staffLog.length > KEEP_LOG) db.staffLog.splice(0, db.staffLog.length - KEEP_LOG);
}
/** Adds a flag, unless the same one is already open from the last hour. */
function flag(f) {
  const flags = (db.flags ||= []); const hour = Date.now() - 3600_000;
  if (!f.reportedBy && flags.some((x) => x.status === 'open' && x.reason === f.reason && x.userId === f.userId && (x.messageId || null) === (f.messageId || null) && x.at > hour)) return;
  flags.push({ id: newId(), at: Date.now(), status: 'open', ...f });
  if (flags.length > KEEP_FLAGS) { const drop = flags.findIndex((x) => x.status !== 'open'); flags.splice(drop >= 0 ? drop : 0, 1); }
  save();
}
const excerptOf = (m) => [String(m.content || '').slice(0, 500), m.attachments?.length ? `[${m.attachments.length} file${m.attachments.length === 1 ? '' : 's'}]` : '', m.gif ? '[GIF]' : '', m.sticker ? '[sticker]' : ''].filter(Boolean).join(' ');
const flagMessage = (m, ch, reason, detail) => flag({ kind: 'message', reason, detail, userId: m.authorId, messageId: m.id, channelId: ch.id, serverId: ch.serverId || null, excerpt: excerptOf(m) });
const flagAccount = (uid, reason, detail) => flag({ kind: 'account', reason, detail, userId: uid });
const sameBrowser = (u) => { const mine = deviceHashesOf(u); return mine.size ? Object.values(db.users).filter((x) => x.id !== u.id && !x.bot && !x.deleted && [...deviceHashesOf(x)].some((h) => mine.has(h))) : []; };

/** A new account: four or more on one browser gets flagged. */
export function noteNewAccount(u) { const others = sameBrowser(u); if (others.length >= 3) flagAccount(u.id, 'alts', `${others.length + 1} accounts on one browser`); }

const recent = new Map();   // user id -> [{ at, serverId, invite }] (server messages, last 10 minutes)
const dms = new Map();   // user id -> [{ at, to }] (DMs of accounts under a day old: who, never what)
setInterval(() => { const old = Date.now() - 600_000; for (const map of [recent, dms]) for (const [k, list] of map) if (!list.some((x) => x.at > old)) map.delete(k); }, 300_000).unref();
hooks.onMessage.push((ch, m) => {
  const u = db.users[m.authorId]; if (!u || u.bot || m.bridge || m.type !== 'default') return;
  const now = Date.now();
  if (!ch.serverId) {
    if (SCAM.test(m.content || '')) flagMessage(m, ch, 'scam', 'looks like a scam or IP-grabber link');
    if (now - (u.createdAt || 0) > 86400_000) return;
    const list = (dms.get(u.id) || []).filter((x) => now - x.at < 600_000); for (const to of ch.recipients || []) if (to !== u.id) list.push({ at: now, to });
    dms.set(u.id, list.slice(-100)); const people = new Set(list.map((x) => x.to)).size;
    if (people >= 8) flagAccount(u.id, 'dm_fanout', `a day-old account messaged ${people} people in 10 minutes`);
    return;
  }
  const list = (recent.get(u.id) || []).filter((x) => now - x.at < 600_000); list.push({ at: now, serverId: ch.serverId, invite: INVITE.test(m.content || '') }); recent.set(u.id, list.slice(-60));
  if (list.filter((x) => now - x.at < 10_000).length >= 10) flagAccount(u.id, 'spam', '10 or more messages in 10 seconds');
  const inviteServers = new Set(list.filter((x) => x.invite).map((x) => x.serverId)).size;
  if (inviteServers >= 3) flagAccount(u.id, 'invite_spam', `invite links in ${inviteServers} servers within 10 minutes`);
  const pings = (m.mentions?.length || 0) + (m.mentionRoles?.length || 0);
  if (pings >= 8) flagMessage(m, ch, 'mass_mentions', `${pings} mentions in one message`);
  if (SCAM.test(m.content || '')) flagMessage(m, ch, 'scam', 'looks like a scam or IP-grabber link');
});

export function mountStaff(r, { h, limit, removeMember }) {
  // anyone: report a message, an account or a server to Orata staff
  r.post('/reports', limit('report', 10, 600_000, (req) => req.user.id), h(async (req, res) => {
    const b = req.body || {}; const reason = Object.hasOwn(REASONS, String(b.reason)) ? String(b.reason) : null; if (!reason) throw bad('Pick which guideline it breaks');
    const note = String(b.note || '').trim().slice(0, 500); const base = { reason, detail: 'reported', note, reportedBy: req.user.id };
    let f; let m = null;
    if (b.messageId) {
      const ch = db.channels[String(b.channelId)]; m = ch && (db.messages[ch.id] || []).find((x) => x.id === String(b.messageId));
      if (!m || !canView(req.user.id, ch)) throw notFound('Unknown message');
      if (m.authorId === req.user.id) throw bad('You can’t report your own message');
      f = { kind: 'message', ...base, userId: m.authorId, messageId: m.id, channelId: ch.id, serverId: ch.serverId || null, excerpt: excerptOf(m) };
    } else if (b.serverId) {
      const s = db.servers[String(b.serverId)]; if (!s) throw notFound('Unknown server');
      if (s.ownerId === req.user.id) throw bad('You can’t report your own server');
      f = { kind: 'server', ...base, userId: s.ownerId, serverId: s.id };
    } else {
      const u = db.users[String(b.userId)]; if (!u || u.bot || u.deleted) throw notFound('Unknown user');
      if (u.id === req.user.id) throw bad('You can’t report yourself');
      f = { kind: 'account', ...base, userId: u.id };
    }
    // the same report twice is one report; an obvious joke is kept, but out of staff's way
    const same = (db.flags || []).some((x) => x.status === 'open' && x.reportedBy === req.user.id && x.kind === f.kind && x.userId === f.userId && (x.messageId || null) === (f.messageId || null) && (x.serverId || null) === (f.serverId || null) && x.reason === f.reason);
    if (!same) {
      const why = fakeWhy({ reason, note, reporter: req.user.id, userId: f.userId, m });
      if (why && URGENT.has(reason)) f.doubt = why; else if (why) f.hidden = why;   // a joke-looking report where someone may be in danger is still shown, just tagged and last
      flag(f);
    }
    res.json({ ok: true });
  }));

  // everything below: Orata staff only
  const staff = (req) => { if (!isStaff(req.user)) throw forbidden('Only Orata staff can do that'); };
  const target = (req) => {
    const u = db.users[String(req.params.id)]; if (!u || u.bot || u.deleted) throw notFound('Unknown user');
    if (u.id === req.user.id) throw bad('You can’t do that to your own account');
    if (isFounder(u)) throw forbidden('The founders’ accounts can’t be locked or terminated');
    if (isStaff(u) && !isFounder(req.user)) throw forbidden('Only oratedev and Orate_dev can lock or terminate staff');
    return u;
  };
  const stateOf = (u) => (u.terminated ? 'terminated' : u.lockedUntil > Date.now() ? 'locked' : 'active');
  const row = (u) => ({
    ...publicUser(u), createdAt: u.createdAt, state: stateOf(u), lockedUntil: u.lockedUntil > Date.now() ? u.lockedUntil : null, lockReason: u.lockReason || '',
    terminated: u.terminated || null, staff: isStaff(u), founder: isFounder(u), servers: Object.values(db.servers).filter((s) => s.members[u.id]).length,
    alts: sameBrowser(u).length, openFlags: (db.flags || []).filter((f) => f.status === 'open' && f.userId === u.id).length,
  });
  const shut = (u) => { endUserSessions(u.id).catch(() => {}); closeConns(u.id, 4004, 'account blocked'); emitTo([u.id], 'invalid_session', {}); };

  r.get('/staff/overview', h(async (req, res) => {
    staff(req); const now = Date.now(); const day = now - 86400_000;
    const people = Object.values(db.users).filter((u) => !u.bot && !u.deleted);
    const live = people.filter((u) => !u.terminated);
    const month = now - 30 * 86400_000; const acts = {};
    for (const e of db.staffLog || []) if (e.at > month) acts[e.by] = (acts[e.by] || 0) + 1;
    const flags = (db.flags || []).filter((f) => f.status === 'open' && !f.hidden);
    const why = new Map();   // user id -> what their open flags and reports are about
    for (const f of flags) why.set(f.userId, [...(why.get(f.userId) || []), flagView(f).label]);
    const locked = live.filter((u) => u.lockedUntil > now);
    res.json({
      stats: { accounts: live.length, online: live.filter((u) => effectiveStatus(u) !== 'offline').length, newToday: live.filter((u) => u.createdAt > day).length,
        locked: locked.length, terminated: people.length - live.length, servers: Object.keys(db.servers).length,
        openFlags: flags.filter((f) => !f.reportedBy).length, openReports: flags.filter((f) => f.reportedBy).length },
      // accounts with open flags or reports, most first; the newest sign-ups (raids, alt waves); who is locked right now
      attention: [...why].filter(([id]) => db.users[id] && !db.users[id].deleted && !db.users[id].terminated).map(([id, list]) => ({ ...row(db.users[id]), why: [...new Set(list)] }))
        .sort((a, b) => b.openFlags - a.openFlags).slice(0, 8),
      newest: [...live].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 8).map(row),
      locked: locked.sort((a, b) => a.lockedUntil - b.lockedUntil).map(row),
      team: people.filter((u) => isStaff(u)).map((u) => ({ ...publicUser(u), founder: isFounder(u), actions: acts[u.id] || 0 })),
    });
  }));
  r.get('/staff/users', h(async (req, res) => {
    staff(req); const q = String(req.query.q || '').trim().toLowerCase().replace(/^@/, '');
    const list = Object.values(db.users).filter((u) => !u.bot && !u.deleted && (!q || u.id === q || u.username.includes(q) || String(u.displayName || '').toLowerCase().includes(q)));
    res.json(list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 30).map(row));
  }));
  r.get('/staff/users/:id', h(async (req, res) => {
    staff(req); const u = db.users[String(req.params.id)]; if (!u || u.bot || u.deleted) throw notFound('Unknown user');
    res.json({ ...row(u), serverList: Object.values(db.servers).filter((s) => s.members[u.id]).map((s) => ({ id: s.id, name: s.name, owner: s.ownerId === u.id })),
      altList: sameBrowser(u).map(publicUser), flags: (db.flags || []).filter((f) => f.userId === u.id).slice(-20).reverse(), log: (db.staffLog || []).filter((e) => e.target === u.id).slice(-20).reverse() });
  }));
  r.post('/staff/users/:id/terminate', h(async (req, res) => {
    staff(req); const u = target(req); const reason = String(req.body?.reason || '').trim().slice(0, 300); if (!reason) throw bad('Say why');
    u.terminated = { at: Date.now(), by: req.user.id, reason };
    for (const s of Object.values(db.servers)) if (s.members[u.id] && s.ownerId !== u.id) removeMember(s, u.id);
    shut(u); log(req.user.id, 'terminate', u.id, reason); save(); emitTo([req.user.id], 'user_update', { user: publicUser(u) });
    res.json(row(u));
  }));
  r.post('/staff/users/:id/unterminate', h(async (req, res) => {
    staff(req); const u = target(req); if (!u.terminated) throw bad('That account isn’t terminated');
    delete u.terminated; log(req.user.id, 'unterminate', u.id, String(req.body?.reason || '').slice(0, 300)); save(); res.json(row(u));
  }));
  r.post('/staff/users/:id/lock', h(async (req, res) => {
    staff(req); const u = target(req); const hours = Number(req.body?.hours); if (!LOCKS.includes(hours)) throw bad('Pick how long');
    const reason = String(req.body?.reason || '').trim().slice(0, 300); if (!reason) throw bad('Say why');
    u.lockedUntil = Date.now() + hours * 3600_000; u.lockReason = reason; u.lockedBy = req.user.id;
    shut(u); log(req.user.id, 'lock', u.id, reason, { hours }); save(); res.json(row(u));
  }));
  r.post('/staff/users/:id/unlock', h(async (req, res) => {
    staff(req); const u = target(req); delete u.lockedUntil; delete u.lockReason; delete u.lockedBy;
    log(req.user.id, 'unlock', u.id); save(); res.json(row(u));
  }));

  /** What makes a server look fishy: open reports about it, open flags on messages in it, a scam-looking name (these three let staff ghost in),
   * and terminated members (only for sorting). */
  const fishy = (s, open = (db.flags || []).filter((f) => f.status === 'open' && !f.hidden && f.serverId === s.id)) => {
    const reports = open.filter((f) => f.kind === 'server' && f.serverId === s.id).length;
    const flagged = open.filter((f) => f.kind === 'message' && f.serverId === s.id).length;
    const terminated = Object.keys(s.members).filter((id) => db.users[id]?.terminated).length;
    const scamName = SCAM.test(`${s.name} ${s.description || ''}`);
    return { reports, flagged, terminated, scamName, canGhost: reports + flagged > 0 || scamName, score: reports * 3 + flagged + terminated * 2 + (scamName ? 3 : 0) };
  };
  /** Every server (or those matching ?q), fishiest first. */
  r.get('/staff/servers', h(async (req, res) => {
    staff(req); const q = String(req.query.q || '').trim().toLowerCase();
    const open = (db.flags || []).filter((f) => f.status === 'open' && !f.hidden && f.serverId);
    const list = Object.values(db.servers).filter((s) => !q || s.id === q || s.name.toLowerCase().includes(q)).map((s) => ({
      id: s.id, name: s.name, icon: s.icon || null, tag: s.tag || null, joinMode: s.joinMode || 'invite', createdAt: s.createdAt,
      members: Object.keys(s.members).filter((id) => !db.users[id]?.bot).length, owner: publicUser(db.users[s.ownerId]), ...fishy(s, open),
    }));
    res.json(list.sort((a, b) => b.score - a.score || b.members - a.members).slice(0, 100));
  }));
  r.post('/staff/servers/:id/ghost', h(async (req, res) => {
    staff(req); const s = db.servers[String(req.params.id)]; if (!s) throw notFound('Unknown server');
    if (s.members[req.user.id]) throw bad('You’re in this server already');
    if (!fishy(s).canGhost) throw forbidden('You can only look inside a server that was reported or flagged');
    ghosts.set(req.user.id, { serverId: s.id, at: Date.now() });
    log(req.user.id, 'ghost', s.ownerId, '', { server: s.id, serverName: s.name }); save();
    res.json({ server: serverView(s, req.user.id), users: Object.keys(s.members).map((id) => publicUser(db.users[id])).filter(Boolean) });
  }));
  r.delete('/staff/servers/:id/ghost', h(async (req, res) => {
    staff(req); if (ghosts.get(req.user.id)?.serverId === String(req.params.id)) ghosts.delete(req.user.id);
    res.json({ ok: true });
  }));

  /** A flag with what staff need to judge it: who, where, and (for messages) the words. */
  const flagView = (f) => {
    const ch = f.channelId && db.channels[f.channelId]; const s = f.serverId && db.servers[f.serverId];
    return { ...f, label: f.kind === 'server' ? `Server reported: ${REASONS[f.reason] || f.reason}` : f.reportedBy ? `Reported: ${REASONS[f.reason] || f.reason}` : LABEL[f.reason] || f.reason,
      where: f.kind === 'server' ? `the server ${s?.name || '(deleted)'}` : s ? `#${ch?.name || '?'} in ${s.name}` : ch?.type === 'group' ? 'a group DM' : f.channelId ? 'a DM' : null,
      gone: f.messageId ? !(db.messages[f.channelId] || []).some((m) => m.id === f.messageId) : false };
  };
  r.get('/staff/flags', h(async (req, res) => {
    staff(req); const all = req.query.status === 'all'; const hidden = req.query.hidden === '1';   // hidden=1: only the reports that look like jokes
    const list = (db.flags || []).filter((f) => (all || f.status === 'open') && !!f.hidden === hidden).slice(-200).reverse().map(flagView)
      .sort((a, b) => !!a.doubt - !!b.doubt);   // the ones that look like jokes go last
    const ids = new Set(list.flatMap((f) => [f.userId, f.reportedBy, f.handledBy]).filter(Boolean));
    res.json({ flags: list, users: [...ids].map((id) => db.users[id] && { ...publicUser(db.users[id]), state: stateOf(db.users[id]) }).filter(Boolean), hidden: (db.flags || []).filter((f) => f.status === 'open' && f.hidden).length });
  }));
  r.post('/staff/flags/:id', h(async (req, res) => {
    staff(req); const f = (db.flags || []).find((x) => x.id === req.params.id); if (!f) throw notFound('Unknown flag');
    const action = String(req.body?.action || '');
    if (action === 'delete') {   // takes the flagged message down, wherever it is
      const ch = db.channels[f.channelId]; const list = db.messages[f.channelId] || [];
      if (ch && list.some((m) => m.id === f.messageId)) {
        db.messages[f.channelId] = list.filter((m) => m.id !== f.messageId);
        emitTo(audienceOf(ch), 'message_delete', { channelId: ch.id, messageId: f.messageId }); messagesDeleted(ch, [f.messageId]);
      }
      f.status = 'done'; log(req.user.id, 'delete_message', f.userId, f.label || f.reason, { flag: f.id });
    } else if (action === 'dismiss') { f.status = 'dismissed'; log(req.user.id, 'dismiss_flag', f.userId, '', { flag: f.id }); } else if (action === 'reopen') f.status = 'open';
    else if (action === 'unhide') { delete f.hidden; delete f.doubt; log(req.user.id, 'unhide_flag', f.userId, '', { flag: f.id }); }   // "not a joke": it counts like any other report
    else throw bad('Unknown action');
    f.handledBy = req.user.id; f.handledAt = Date.now(); save();
    res.json(flagView(f));
  }));
  /** Every DM and group DM with a flagged or reported message: who is in it, how many flags are open, and the latest one (to read around it). */
  r.get('/staff/dms', h(async (req, res) => {
    staff(req); const by = new Map();
    for (const f of db.flags || []) { const ch = f.channelId && db.channels[f.channelId]; if (ch && !ch.serverId && !f.hidden) by.set(ch.id, [...(by.get(ch.id) || []), f]); }
    const list = [...by].map(([id, flags]) => {
      const ch = db.channels[id]; const last = flags[flags.length - 1];
      return { id, group: ch.type === 'group', name: ch.type === 'group' ? ch.name || null : null, recipients: (ch.recipients || []).map((u) => publicUser(db.users[u])).filter(Boolean),
        open: flags.filter((f) => f.status === 'open').length, total: flags.length, last: { ...flagView(last), excerpt: (last.excerpt || '').slice(0, 160) } };
    });
    res.json(list.sort((a, b) => (b.open > 0) - (a.open > 0) || b.last.at - a.last.at).slice(0, 100));
  }));
  // the DM a flagged or reported message is in, read only: the 50 messages before it and the 50 after. Only reachable from a flag; each look is logged
  r.get('/staff/flags/:id/conversation', h(async (req, res) => {
    staff(req); const f = (db.flags || []).find((x) => x.id === req.params.id); if (!f) throw notFound('Unknown flag');
    const ch = f.channelId && db.channels[f.channelId]; if (!ch || ch.serverId) throw bad('That flag isn’t about a DM');
    if (f.hidden) throw forbidden('That report looks like a joke. Mark it as not a joke first.');
    const list = db.messages[ch.id] || [];
    let i = list.findIndex((m) => m.id === f.messageId); if (i < 0) i = list.findIndex((m) => m.createdAt > f.at); if (i < 0) i = list.length - 1;
    const slice = list.slice(Math.max(0, i - 50), i + 51);
    log(req.user.id, 'view_dm', f.userId, '', { flag: f.id }); save();
    const ids = new Set([...(ch.recipients || []), ...slice.map((m) => m.authorId)]);
    res.json({ messages: slice.map(messageView), users: [...ids].map((id) => publicUser(db.users[id])).filter(Boolean), flagged: f.messageId || null, group: ch.type === 'group' });
  }));
  r.get('/staff/log', h(async (req, res) => {
    staff(req); const list = (db.staffLog || []).slice(-200).reverse();
    res.json({ log: list, users: [...new Set(list.flatMap((e) => [e.by, e.target]))].map((id) => publicUser(db.users[id])).filter(Boolean) });
  }));
}
