// Orata — profile badges. A badge is { id, name, icon (one of the browser's icon names) or emoji, color }; a person's are `user.badges` (ids).
// The catalog lives in db.badges: the built-in ones below (rewritten on every start, so they follow this file) and custom ones the developers make.
// Whoever holds the "dev" badge is a developer: they can give and take anyone's badges and create or delete custom ones — except the staff and
// dev badges themselves, which only the two founders (oratedev and Orate_dev) can hand out or take away.
import { db, save, newId, bad, forbidden, notFound, byUsername, emitTo, relatedUserIds, publicUser, ORATE_DEV_ID } from './core.js';
import { isFounder } from './names.js';

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
}
