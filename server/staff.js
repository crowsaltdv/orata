// Orata — tools for Orata's own staff (the Staff page under the + in the server rail), for holders of the staff or dev badge (only the two
// founders hand those out, badges.js). Numbers about the whole of Orata; finding accounts; locking one for a while or terminating it for good
// (both undoable); and flags: messages and accounts Orata itself finds suspicious (spam bursts, mass pings, invite spam, scam links, many
// accounts on one browser, a day-old account messaging lots of people) plus what people report to staff. Server rules (NSFW channels and the
// like) are each server's business, not this. DMs are only seen here when someone in them reports a message; for the "messaging lots of
// people" check only who and how many are counted, never what. Every staff action goes in the staff log.
import { db, save, newId, emitTo, audienceOf, effectiveStatus, publicUser, deviceHashesOf, canView, closeConns, bad, forbidden, notFound } from './core.js';
import { hooks, messagesDeleted } from './messages.js';
import { endUserSessions } from './sessions.js';
import { isFounder, isStaff } from './names.js';

const KEEP_FLAGS = 1000; const KEEP_LOG = 1000;
const LOCKS = [1, 6, 24, 72, 168, 720];   // hours
const REASONS = ['spam', 'scam', 'harassment', 'hate', 'impersonation', 'self-harm', 'other'];
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
  // anyone: report a message or an account to Orata staff
  r.post('/reports', limit('report', 10, 600_000, (req) => req.user.id), h(async (req, res) => {
    const b = req.body || {}; const reason = REASONS.includes(b.reason) ? b.reason : null; if (!reason) throw bad('Pick what’s wrong');
    const note = String(b.note || '').trim().slice(0, 500);
    if (b.messageId) {
      const ch = db.channels[String(b.channelId)]; const m = ch && (db.messages[ch.id] || []).find((x) => x.id === String(b.messageId));
      if (!m || !canView(req.user.id, ch)) throw notFound('Unknown message');
      if (m.authorId === req.user.id) throw bad('You can’t report your own message');
      flag({ kind: 'message', reason, detail: 'reported', note, reportedBy: req.user.id, userId: m.authorId, messageId: m.id, channelId: ch.id, serverId: ch.serverId || null, excerpt: excerptOf(m) });
    } else {
      const u = db.users[String(b.userId)]; if (!u || u.bot || u.deleted) throw notFound('Unknown user');
      if (u.id === req.user.id) throw bad('You can’t report yourself');
      flag({ kind: 'account', reason, detail: 'reported', note, reportedBy: req.user.id, userId: u.id });
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
    const flags = (db.flags || []).filter((f) => f.status === 'open');
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

  /** A flag with what staff need to judge it: who, where, and (for messages) the words. */
  const flagView = (f) => {
    const ch = f.channelId && db.channels[f.channelId]; const s = f.serverId && db.servers[f.serverId];
    return { ...f, label: f.reportedBy ? `Reported: ${f.reason}` : LABEL[f.reason] || f.reason, where: s ? `#${ch?.name || '?'} in ${s.name}` : f.channelId ? 'a DM' : null,
      gone: f.messageId ? !(db.messages[f.channelId] || []).some((m) => m.id === f.messageId) : false };
  };
  r.get('/staff/flags', h(async (req, res) => {
    staff(req); const all = req.query.status === 'all';
    const list = (db.flags || []).filter((f) => all || f.status === 'open').slice(-200).reverse().map(flagView);
    const ids = new Set(list.flatMap((f) => [f.userId, f.reportedBy, f.handledBy]).filter(Boolean));
    res.json({ flags: list, users: [...ids].map((id) => db.users[id] && { ...publicUser(db.users[id]), state: stateOf(db.users[id]) }).filter(Boolean) });
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
    else throw bad('Unknown action');
    f.handledBy = req.user.id; f.handledAt = Date.now(); save();
    res.json(flagView(f));
  }));
  r.get('/staff/log', h(async (req, res) => {
    staff(req); const list = (db.staffLog || []).slice(-200).reverse();
    res.json({ log: list, users: [...new Set(list.flatMap((e) => [e.by, e.target]))].map((id) => publicUser(db.users[id])).filter(Boolean) });
  }));
}
