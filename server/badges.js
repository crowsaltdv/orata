// Orata — profile badges. A badge is { id, name, icon (one of the browser's icon names) or emoji, color }; a person's are `user.badges` (ids).
// The catalog lives in db.badges: the built-in ones below (rewritten on every start, so they follow this file) and custom ones the developers make.
// Whoever holds the "dev" badge is a developer: they can give and take anyone's badges and create or delete custom ones — except the staff and
// dev badges themselves, which only the two founders (oratedev and Orate_dev) can hand out or take away.
import { db, save, newId, bad, forbidden, notFound, byUsername, emitTo, relatedUserIds, publicUser, ORATE_DEV_ID, afterLoad } from './core.js';
import { isFounder } from './names.js';
import { staffLog } from './staff.js';

const BUILTIN = [
  { id: 'dev', name: 'Orata Developer', icon: 'code', color: '#5865f2' },
  { id: 'staff', name: 'Orata Staff', icon: 'shield', color: '#3ba55d' },
  { id: 'mod', name: 'Moderator', icon: 'bolt', color: '#f59e0b' },
  { id: 'early', name: 'Early Supporter', icon: 'heart', color: '#f472b6' },
  { id: 'bug', name: 'Bug Hunter', icon: 'target', color: '#22c55e' },
  { id: 'verified', name: 'Verified', icon: 'check-circle', color: '#3b82f6' },
  { id: 'artist', name: 'Artist', icon: 'palette', color: '#f97316' },
  { id: 'partner', name: 'Partner', icon: 'award', color: '#a78bfa' },
];
/** The catalog and the one-time hand-outs. Runs at start and again whenever newer data is loaded from another instance (afterLoad in core.js). */
function seed() {
  const before = JSON.stringify(db.badges || null);
  db.badges ||= {};
  for (const b of BUILTIN) db.badges[b.id] = { ...b, builtin: true };
  let seeded = false;
  // The Creator badge is gone (anyone can send a theme to Discovery now, and Orata staff approve each one): off the catalog and off everyone who had it
  if (db.badges.creator?.builtin) delete db.badges.creator;
  for (const u of Object.values(db.users)) if (u.badges?.includes('creator') && !db.badges.creator) { u.badges = u.badges.filter((b) => b !== 'creator'); seeded = true; }
  if (!db.badgeSeedV1) {   // once: the first two developers
    for (const id of [byUsername.get('oratedev'), ORATE_DEV_ID]) { const u = db.users[id]; if (u && !u.badges?.includes('dev')) (u.badges ||= []).push('dev'); }
    db.badgeSeedV1 = true; seeded = true;
  }
  if (!db.earlySeedV1) {   // once: everyone with an account now is an Early Supporter (accounts made later don't get it by themselves)
    for (const u of Object.values(db.users)) if (!u.bot && !u.deleted && !u.badges?.includes('early')) (u.badges ||= []).push('early');
    db.earlySeedV1 = true; seeded = true;
  }
  if (seeded || JSON.stringify(db.badges) !== before) save();
}
afterLoad(seed);

export const isDev = (u) => !!u?.badges?.includes('dev');
const HEX = /^#[0-9a-fA-F]{6}$/;
const ICON = /^[a-z0-9-]{1,24}$/;
const tell = (u, ...also) => emitTo([...relatedUserIds(u.id), ...also], 'user_update', { user: publicUser(u) });

export function mountBadges(r, { h }) {
  const dev = (req) => { if (!isDev(req.user)) throw forbidden('Only Orata developers can do that'); };
  r.get('/badges', (req, res) => res.json(Object.values(db.badges)));
  r.post('/badges', h(async (req, res) => {
    dev(req); const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 32); if (!name) throw bad('Give the badge a name');
    const emoji = typeof b.emoji === 'string' && b.emoji.trim() ? b.emoji.trim().slice(0, 16) : null;
    const icon = !emoji && ICON.test(String(b.icon || '')) ? b.icon : null;
    if (!emoji && !icon) throw bad('Pick an icon or an emoji');
    if (!HEX.test(String(b.color || ''))) throw bad('Invalid color');
    const badge = { id: newId(), name, color: b.color.toLowerCase(), ...(emoji ? { emoji } : { icon }) };
    db.badges[badge.id] = badge; save(); res.json(badge);
  }));
  r.delete('/badges/:id', h(async (req, res) => {
    dev(req); const badge = db.badges[req.params.id]; if (!badge) throw notFound('Unknown badge');
    if (badge.builtin) throw bad('Built-in badges can’t be deleted');
    delete db.badges[badge.id];
    for (const u of Object.values(db.users)) if (u.badges?.includes(badge.id)) { u.badges = u.badges.filter((x) => x !== badge.id); tell(u); }
    save(); res.json({ ok: true });
  }));
  r.put('/users/:id/badges', h(async (req, res) => {
    dev(req); const u = db.users[req.params.id]; if (!u || u.deleted) throw notFound('Unknown user');
    const want = Array.isArray(req.body?.badges) ? [...new Set(req.body.badges.map(String))].filter((id) => db.badges[id]) : null;
    if (!want) throw bad('Send the list of badges');
    if (u.id === req.user.id && !want.includes('dev')) throw bad('You can’t take the developer badge from yourself');
    for (const id of ['staff', 'dev']) if (want.includes(id) !== !!u.badges?.includes(id) && !isFounder(req.user)) throw forbidden(`Only oratedev and Orate_dev can give or take the ${db.badges[id].name} badge`);
    u.badges = want; save(); tell(u, req.user.id);
    res.json(publicUser(u));
  }));
  /** Many people at once (Staff → Badges): everyone, or by join date (on or after / before, yyyy-mm-dd UTC), the members of a server, or
   *  whoever has another badge. `take` takes it away instead. `dryRun` only counts. */
  r.post('/badges/bulk', h(async (req, res) => {
    dev(req); const b = req.body || {}; const w = b.who || {}; const take = !!b.take;
    const badge = db.badges[String(b.badge || '')]; if (!badge) throw bad('Pick a badge');
    if (['staff', 'dev'].includes(badge.id) && !isFounder(req.user)) throw forbidden(`Only oratedev and Orate_dev can give or take the ${badge.name} badge`);
    const date = (v) => (v ? Date.parse(String(v)) : null); const after = date(w.joinedAfter); const before = date(w.joinedBefore);
    if (Number.isNaN(after) || Number.isNaN(before)) throw bad('Pick a valid date');
    const server = w.serverId ? db.servers[String(w.serverId)] : null; if (w.serverId && !server) throw notFound('Unknown server');
    const has = w.hasBadge ? String(w.hasBadge) : null; if (has && !db.badges[has]) throw bad('Unknown badge');
    const people = Object.values(db.users).filter((u) => !u.bot && !u.deleted && (after === null || (u.createdAt || 0) >= after) && (before === null || (u.createdAt || 0) < before)
      && (!server || server.members[u.id]) && (!has || u.badges?.includes(has)));
    const change = people.filter((u) => !!u.badges?.includes(badge.id) === take && !(take && badge.id === 'dev' && u.id === req.user.id));   // (never your own dev badge)
    if (!b.dryRun && change.length) {
      // ponytail: tells only each person's own sessions; everyone else sees the badge the next time they load the profile
      for (const u of change) { u.badges = take ? u.badges.filter((x) => x !== badge.id) : [...(u.badges || []), badge.id]; emitTo([u.id], 'user_update', { user: publicUser(u) }); }
      staffLog(req.user.id, take ? 'bulk_badge_take' : 'bulk_badge_give', null, '', { badge: badge.name, count: change.length });
      save();
    }
    res.json({ matched: people.length, changed: change.length });
  }));
}
