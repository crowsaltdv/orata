// Orata — joining a server. A server either lets anyone with an invite in (joinMode 'invite', the default) or asks people to apply first
// ('apply'): they write a message, it lands as a card in the server's applications channel, and anyone with Access Applications accepts or
// rejects it there. That channel is seen only by people with that permission (core.js permsIn), and while applying is on nobody can rename or
// delete it (api.js). Turning applying off lets everyone who was still waiting in. Applicants hear back from Orbit in their DMs.
// Also here: the server preview behind a worn server tag, from which people can join (or apply) without an invite.
import { db, save, newId, emitTo, audienceOf, publicUser, messageView, channelView, effectiveStatus, channelsOfServer, ensureBot, audit, permsOf, isOwner, bad, forbidden, notFound, ApiError } from './core.js';
import { postMessage } from './messages.js';

const KEEP = 300;   // decided applications kept per server (pending ones always stay)
const RETRY = 24 * 3600_000;   // after a rejection, someone can apply again a day later
export const canReview = (s, uid) => isOwner(s, uid) || permsOf(s, uid).has('ADMINISTRATOR') || permsOf(s, uid).has('ACCESS_APPLICATIONS');
const pendingOf = (s, uid) => Object.values(s.applications || {}).find((a) => a.userId === uid && a.status === 'pending') || null;
const lastOf = (s, uid) => Object.values(s.applications || {}).filter((a) => a.userId === uid).sort((a, b) => b.at - a.at)[0] || null;

/** What anyone may see of a server before joining (invite page, server tag popup), and where `uid` stands with it. */
export function publicServerInfo(s, uid) {
  const ids = Object.keys(s.members); const mine = lastOf(s, uid);
  return {
    id: s.id, name: s.name, icon: s.icon || null, banner: s.banner || null, accent: s.accent || null, createdAt: s.createdAt, description: s.description || '',
    memberCount: ids.length, onlineCount: ids.filter((i) => effectiveStatus(db.users[i]) !== 'offline').length,
    tag: s.tag || null, joinMode: s.joinMode || 'invite', applyQuestion: s.applyQuestion || '', member: !!s.members[uid],
    application: mine ? { status: mine.status, at: mine.at, reason: mine.status === 'rejected' ? mine.reason || '' : undefined, again: mine.status === 'rejected' ? mine.decidedAt + RETRY : undefined } : null,
  };
}

/** Orbit tells `uid` something in their DM with it (opening the DM again if they had closed it). */
export function orbitTells(uid, content) {
  const bot = ensureBot();
  let dm = Object.values(db.channels).find((c) => c.type === 'dm' && c.recipients?.length === 2 && c.recipients.includes(bot.id) && c.recipients.includes(uid));
  if (!dm) {
    const id = newId(); dm = db.channels[id] = { id, serverId: null, type: 'dm', recipients: [bot.id, uid], createdAt: Date.now() }; db.messages[id] = [];
    emitTo([uid], 'dm_open', { channel: channelView(dm, uid), users: [publicUser(bot), publicUser(db.users[uid])] });
  }
  postMessage(dm, bot.id, { content });
}

export function mountApplications(r, { h, getServer, findInvite, isBannedFrom, joinServer, pushChannelEvent }) {
  /** The applications channel: made when applying is switched on (or again if it was deleted while it was off). */
  function ensureChannel(s, actorId) {
    const old = db.channels[s.applicationsChannelId];
    if (old?.serverId === s.id) { old.applications = true; return old; }
    const siblings = channelsOfServer(s.id).filter((c) => !c.parentId && c.type !== 'category');
    const id = newId();
    const ch = db.channels[id] = { id, serverId: s.id, type: 'text', name: 'applications', emoji: '📝', applications: true, parentId: null, position: Math.max(0, ...siblings.map((c) => c.position || 0)) + 1, topic: 'People asking to join. Accept or reject them here.' };
    db.messages[id] = []; s.applicationsChannelId = id;
    audit(s, actorId, 'channel_create', { target: id, name: ch.name, type: 'text' });
    pushChannelEvent('channel_create', ch);
    return ch;
  }
  /** `user` asks to join `s` with `message`: a card in the applications channel. */
  function apply(s, user, message, req) {
    if (s.members[user.id]) throw bad('You are already in this server');
    if ((s.joinMode || 'invite') !== 'apply') throw bad('This server doesn’t take applications: join it with an invite');
    if (isBannedFrom(s, user, req)) throw forbidden('You are banned from this server');
    if (pendingOf(s, user.id)) throw bad('You already applied. The server’s team will get back to you.', 'already_applied');
    const last = lastOf(s, user.id);
    if (last?.status === 'rejected' && Date.now() - last.decidedAt < RETRY) throw bad('Your last application was rejected. You can apply again a day after that.', 'apply_wait');
    const text = String(message || '').trim().slice(0, 1000); if (!text) throw bad('Write a few words about why you want to join');
    const ch = ensureChannel(s, null);
    const app = { id: newId(), userId: user.id, message: text, at: Date.now(), status: 'pending' };
    (s.applications ||= {})[app.id] = app;
    const decided = Object.values(s.applications).filter((a) => a.status !== 'pending').sort((a, b) => a.at - b.at);
    for (const a of decided.slice(0, Math.max(0, decided.length - KEEP))) delete s.applications[a.id];
    app.messageId = postMessage(ch, user.id, { type: 'application', application: app.id }).id; save();
    return app;
  }
  /** Accepts or rejects an application (`by` null: accepted because applying was switched off). */
  function decide(s, app, accept, by, reason = '') {
    const user = db.users[app.userId];
    app.status = accept ? 'accepted' : 'rejected'; app.by = by; app.decidedAt = Date.now(); if (!accept) app.reason = String(reason || '').trim().slice(0, 300);
    if (accept && user && !user.deleted && !s.members[user.id]) joinServer(s, user, null);
    audit(s, by, accept ? 'application_accept' : 'application_reject', { target: app.userId, ...(app.reason ? { reason: app.reason } : {}) });
    const ch = db.channels[s.applicationsChannelId]; const msg = ch && (db.messages[ch.id] || []).find((m) => m.id === app.messageId);
    if (msg) emitTo(audienceOf(ch), 'message_update', { message: messageView(msg) });
    if (user) orbitTells(user.id, accept ? `✅ Your application to **${s.name}** was accepted. Welcome in!` : `Your application to **${s.name}** wasn’t accepted.${app.reason ? ` Reason: ${app.reason}` : ''}`);
    save();
  }
  /** Applying was switched off: everyone still waiting gets in. */
  function acceptAll(s, by) { for (const a of Object.values(s.applications || {})) if (a.status === 'pending') decide(s, a, true, by); }

  const appOf = (s, id) => { const a = s.applications?.[id]; if (!a) throw notFound('Unknown application'); if (a.status !== 'pending') throw bad(`That application was already ${a.status}`); return a; };
  r.post('/servers/:id/applications/:aid/accept', h(async (req, res) => {
    const s = getServer(req, req.params.id); if (!canReview(s, req.user.id)) throw forbidden('You need the Access Applications permission');
    decide(s, appOf(s, req.params.aid), true, req.user.id); res.json({ ok: true });
  }));
  r.post('/servers/:id/applications/:aid/reject', h(async (req, res) => {
    const s = getServer(req, req.params.id); if (!canReview(s, req.user.id)) throw forbidden('You need the Access Applications permission');
    decide(s, appOf(s, req.params.aid), false, req.user.id, req.body?.reason); res.json({ ok: true });
  }));

  r.post('/invites/:code/apply', h(async (req, res) => {
    const inv = findInvite(String(req.params.code)); const s = inv && db.servers[inv.serverId];
    if (!s || (inv.expiresAt && inv.expiresAt < Date.now())) throw notFound('This invite is invalid or has expired');
    apply(s, req.user, req.body?.message, req); res.json(publicServerInfo(s, req.user.id));
  }));
  // a worn server tag shows its server: anyone can see it, join it (when it takes anyone with an invite) or apply to it
  const tagged = (id) => { const s = db.servers[String(id)]; if (!s || !s.tag) throw notFound('That server isn’t showing itself'); return s; };
  r.get('/servers/:id/preview', h(async (req, res) => res.json(publicServerInfo(tagged(req.params.id), req.user.id))));
  r.post('/servers/:id/join', h(async (req, res) => {
    const s = tagged(req.params.id);
    if ((s.joinMode || 'invite') === 'apply') throw new ApiError(403, 'This server asks people to apply first', 'apply_required');
    if (isBannedFrom(s, req.user, req)) throw forbidden('You are banned from this server');
    if (!s.members[req.user.id]) joinServer(s, req.user, req);
    res.json({ id: s.id, name: s.name });
  }));
  r.post('/servers/:id/apply', h(async (req, res) => { const s = tagged(req.params.id); apply(s, req.user, req.body?.message, req); res.json(publicServerInfo(s, req.user.id)); }));

  return { ensureChannel, acceptAll };
}
