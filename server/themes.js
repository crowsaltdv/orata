// Orata — the theme library and Discovery. The screens are public/js/themes.js; what a theme is (and how it is checked) is public/js/theme-data.js.
// Library: every account keeps its own themes on the server (so they follow you to other devices): up to 25 profile themes and 25 site themes.
// Discovery: people with the "creator" badge (and Orata staff and developers) post a theme of their own there; anyone installs one, which copies it into their library,
// and anyone can upvote one (the most upvoted are shown first, "Featured").
// Pictures (and GIFs): a theme's wallpaper, card picture and banner are copied into files the theme owns (th_<id>.<ext> in the uploads, checked to be a real
// picture), so they keep working after the original upload is replaced; a wallpaper that is a web link is fetched and kept too (when the link can't be fetched
// the theme keeps the link). A sweep removes theme files nothing uses any more. Every theme also has a preview picture the browser draws
// from the theme itself (public/js/theme-preview.js) and uploads here.
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import sharp from 'sharp';
import { db, save, newId, cmpId, publicUser, ENV, UPLOAD_DIR, pg, ApiError, bad, forbidden, notFound, conns, emitTo, storeUpload, restoreUpload, removeUpload } from './core.js';
import { isSafeFileName } from './storage.js';
import { isStaff } from './names.js';
import { hasProfanity } from './profanity.js';
import { staffLog } from './staff.js';
import { THEME_KINDS, LIBRARY_LIMIT, sanitizeTheme, cleanThemeName, themeFiles, mapThemeFiles } from '../public/js/theme-data.js';

db.themes ||= {};        // Discovery: id -> { id, kind, name, data, preview, authorId, createdAt, installs }
db.themeCopies ||= {};   // an upload's name -> the theme file that is its copy (so saving one wallpaper in many themes keeps one copy)

const FILE = /^th_(\d+)\.[a-z0-9]+$/;
const FORMATS = { png: 'png', jpeg: 'jpg', webp: 'webp', gif: 'gif', heif: 'avif' };
const BIG_BYTES = 3 * 1024 * 1024; const BIG_PIXELS = 2600; const MAX_ANIMATED = 15 * 1024 * 1024; const MAX_REMOTE = 25 * 1024 * 1024; const MAX_DATA = 12_000;
const kindName = (k) => (k === 'site' ? 'site' : 'profile');
export const hasCreator = (u) => !!u?.badges?.includes('creator');
/** Who may post a theme on Discovery: people with the creator badge, and Orata staff and developers. */
export const canPost = (u) => hasCreator(u) || isStaff(u);
const votesOf = (t) => (Array.isArray(t.votes) ? t.votes.length : 0);

/** Checks a picture (a real PNG, JPEG, WebP, GIF or AVIF; a GIF may move) and keeps it as a file the theme owns. Resolves the new file name. */
async function keepPicture(buf) {
  let meta;
  try { meta = await sharp(buf, { limitInputPixels: 80_000_000, animated: true }).metadata(); } catch { throw bad('A picture in this theme isn’t a picture Orata can use.', 'picture_bad'); }
  let ext = FORMATS[meta.format]; if (!ext) throw bad('A picture in this theme is in a format Orata can’t use (PNG, JPEG, WebP, GIF and AVIF work).', 'picture_bad');
  const animated = (meta.pages || 1) > 1;
  if (animated && buf.length > MAX_ANIMATED) throw bad(`An animated picture (GIF) in a theme can be ${MAX_ANIMATED / 1048576} MB at most.`, 'picture_big');
  if (!animated && (buf.length > BIG_BYTES || (meta.width || 0) > BIG_PIXELS)) {   // wallpapers are shown at screen size: no need to keep a 20 MB original
    buf = await sharp(buf, { limitInputPixels: 80_000_000 }).rotate().resize({ width: 2560, withoutEnlargement: true }).webp({ quality: 88 }).toBuffer(); ext = 'webp';
  }
  const file = `th_${newId()}.${ext}`;
  try { await storeUpload(file, `image/${ext === 'jpg' ? 'jpeg' : ext}`, buf); } catch (e) { throw e.code === 'QUOTA' ? new ApiError(507, e.message, 'storage_full') : new ApiError(503, 'Could not save the picture right now. Try again in a moment.', 'storage_error'); }
  return file;
}
/** An upload of this server (a wallpaper, card picture or banner), copied into a file of its own. Resolves the new file name. */
async function ownCopy(name) {
  if (FILE.test(name)) return name;   // already a theme's
  const known = db.themeCopies[name];
  if (known && await restoreUpload(known)) return known;
  if (!isSafeFileName(name) || !await restoreUpload(name)) throw bad('A picture in this theme can’t be found any more. Pick it again and save once more.', 'picture_missing');
  const file = await keepPicture(fs.readFileSync(path.join(UPLOAD_DIR, name)));
  db.themeCopies[name] = file;
  return file;
}
let fetchImage = null;   // the server's address-checked fetch (api.js), which never reaches into the server's own network
/** A wallpaper that is a web link, fetched and kept like an upload. Resolves its new /uploads address, or null when it can't be fetched or isn't a picture (the theme then keeps the link). */
async function copyRemote(url) {
  if (!fetchImage) return null;
  const known = db.themeCopies[url];
  if (known && await restoreUpload(known)) return `/uploads/${known}`;
  try {
    const { resp } = await fetchImage(url, { image: true });
    const type = (resp.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (!resp.ok || !/^image\/(png|jpe?g|webp|gif|avif)$/.test(type) || Number(resp.headers.get('content-length') || 0) > MAX_REMOTE) { resp.body?.cancel().catch(() => {}); return null; }
    const chunks = []; let total = 0;
    for await (const c of resp.body) { total += c.length; if (total > MAX_REMOTE) return null; chunks.push(c); }
    const file = await keepPicture(Buffer.concat(chunks));
    db.themeCopies[url] = file;
    return `/uploads/${file}`;
  } catch (e) { if (e instanceof ApiError && e.status >= 500) throw e; return null; }
}

/** Checks `data` for a theme of `kind` and gives the theme its own copies of its pictures. */
async function readyTheme(kind, data) {
  const clean = sanitizeTheme(kind, data);
  if (!clean) throw bad('There is nothing in that theme to save.', 'empty_theme');
  const own = await mapThemeFiles(kind, clean, ownCopy);
  if (kind === 'site' && /^https?:\/\//i.test(own.bg?.image || '')) own.bg.image = await copyRemote(own.bg.image) || own.bg.image;
  if (JSON.stringify(own).length > MAX_DATA) throw bad('That theme is too large.', 'theme_big');
  return own;
}

const filesOf = (t) => [...themeFiles(t.kind, t.data), ...(FILE.test(path.basename(String(t.preview || ''))) ? [path.basename(t.preview)] : [])];
/** Every theme file something still uses: library and Discovery themes, and the wallpaper / card picture people are wearing right now. */
function inUse() {
  const keep = new Set(); const ref = (v) => { if (typeof v === 'string' && v.startsWith('/uploads/')) keep.add(v.slice(9)); };
  for (const u of Object.values(db.users)) {
    ref(u.avatar); ref(u.banner); ref(u.profile?.colors?.image); ref(u.settings?.bg?.image); for (const x of u.settings?.bg?.library || []) ref(x);
    for (const t of u.themes || []) for (const f of filesOf(t)) keep.add(f);
  }
  for (const t of Object.values(db.themes)) for (const f of filesOf(t)) keep.add(f);
  return keep;
}
/** Removes theme files nothing uses (and that are older than a day, so a picture just saved is never caught between two requests). Resolves how many went. */
export async function sweepThemeFiles(graceMs = Number(ENV.THEME_FILE_GRACE_MS ?? 24 * 3600_000)) {
  const names = (pg ? (await pg.listFiles()).map((f) => f.name) : fs.readdirSync(UPLOAD_DIR)).filter((n) => FILE.test(n));
  const keep = inUse(); const live = new Set(names); let n = 0;
  for (const name of names) {
    if (keep.has(name) || Date.now() - Number(FILE.exec(name)[1]) / 1000 < graceMs) continue;
    removeUpload(name); live.delete(name); n++;
  }
  for (const [src, copy] of Object.entries(db.themeCopies)) if (!live.has(copy)) delete db.themeCopies[src];
  if (n) save();
  return n;
}
setTimeout(() => sweepThemeFiles().catch((e) => console.error('[orata] theme file sweep failed:', e.message)), Number(ENV.THEME_SWEEP_FIRST_MS ?? 90_000)).unref();
setInterval(() => sweepThemeFiles().catch((e) => console.error('[orata] theme file sweep failed:', e.message)), 6 * 3600_000).unref();

/** An account that is deleted takes its published themes with it. */
export function dropUserThemes(userId) {
  for (const t of Object.values(db.themes)) if (t.authorId === userId) delete db.themes[t.id];
}

const libView = (t) => ({ id: t.id, kind: t.kind, name: t.name, data: t.data, preview: t.preview || null, createdAt: t.createdAt, from: t.from || null, published: t.published && db.themes[t.published] ? t.published : null });
const alive = (t) => { const a = db.users[t.authorId]; return !!a && !a.deleted && !a.terminated; };
function pubView(t, viewer) {
  const a = db.users[t.authorId];
  return { id: t.id, kind: t.kind, name: t.name, preview: t.preview || null, createdAt: t.createdAt, installs: t.installs || 0, votes: votesOf(t), voted: !!t.votes?.includes(viewer.id),
    author: publicUser(a),   // (name, picture and style: what clicking their name on a card shows as their profile)
    mine: t.authorId === viewer.id, installed: (viewer.themes || []).some((x) => x.from === t.id) };
}
/** The same shuffle for the same seed (so scrolling through a random order doesn't reshuffle between pages). */
function shuffled(list, seed) {
  let x = (Number(seed) >>> 0) || 1; const rnd = () => { x = (x + 0x6D2B79F5) >>> 0; let t = x; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const a = [...list].sort((p, q) => cmpId(p.id, q.id));
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export function mountThemes(r, { h, limit, fetchImage: fetcher }) {
  fetchImage = ENV.THEME_TEST_FETCH_ANY === '1' ? async (u) => ({ resp: await fetch(u) }) : fetcher;   // (THEME_TEST_FETCH_ANY is for the self-test only: its picture server is on this computer)
  const mine = (req) => (req.user.themes ||= []);
  const find = (req) => { const t = mine(req).find((x) => x.id === req.params.id); if (!t) throw notFound('Unknown theme'); return t; };
  const full = (kind) => bad(`Your ${kindName(kind)} theme library is full (${LIBRARY_LIMIT} of ${LIBRARY_LIMIT}). Delete one from your library to make room.`, 'library_full');
  const changed = (userId, req) => emitTo([userId], 'themes_update', {}, req && [...(conns.get(userId) || [])].find((c) => c.id === req.headers['x-conn']));   // their other devices reload the library
  const pace = limit('themes', 60, 60_000, (req) => req.user.id);

  /* ---- your library ---- */
  r.get('/themes/library', (req, res) => res.json({ limit: LIBRARY_LIMIT, themes: mine(req).map(libView) }));
  r.post('/themes/library', pace, h(async (req, res) => {
    const b = req.body || {}; const kind = b.kind;
    if (!THEME_KINDS.includes(kind)) throw bad('Say whether this is a profile theme or a site theme');
    const name = cleanThemeName(b.name) || (kind === 'site' ? 'My site theme' : 'My profile theme');
    if (mine(req).filter((x) => x.kind === kind).length >= LIBRARY_LIMIT) throw full(kind);
    const data = await readyTheme(kind, b.data);
    if (mine(req).filter((x) => x.kind === kind).length >= LIBRARY_LIMIT) throw full(kind);   // (again: another save may have landed while the pictures were copied)
    const t = { id: newId(), kind, name, data, preview: null, createdAt: Date.now(), from: null, published: null };
    mine(req).push(t); save(); changed(req.user.id, req);
    res.json(libView(t));
  }));
  r.patch('/themes/library/:id', pace, h(async (req, res) => {
    const t = find(req); const name = cleanThemeName(req.body?.name); if (!name) throw bad('Give the theme a name');
    t.name = name; save(); changed(req.user.id, req); res.json(libView(t));
  }));
  r.delete('/themes/library/:id', pace, h(async (req, res) => {
    const t = find(req); req.user.themes = mine(req).filter((x) => x !== t); save(); changed(req.user.id, req);
    res.json({ ok: true });
  }));
  /** The preview picture (drawn by the browser): checked to be a real picture, cut down to 720 pixels wide and kept as WebP. */
  r.put('/themes/library/:id/preview', limit('themeprev', 40, 60_000, (req) => req.user.id), express.raw({ type: () => true, limit: '3mb' }), h(async (req, res) => {
    const t = find(req);
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw bad('There is no picture in that request');
    let meta; try { meta = await sharp(req.body, { limitInputPixels: 20_000_000 }).metadata(); } catch { throw bad('That isn’t a picture', 'picture_bad'); }
    if (!['png', 'jpeg', 'webp'].includes(meta.format) || (meta.pages || 1) > 1 || (meta.width || 0) < 120 || (meta.height || 0) < 120 || meta.width > 2400 || meta.height > 2400) throw bad('A theme preview must be a PNG, JPEG or WebP picture between 120 and 2400 pixels', 'picture_bad');
    const out = await sharp(req.body).resize({ width: 720, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
    const file = `th_${newId()}.webp`;
    try { await storeUpload(file, 'image/webp', out); } catch (e) { throw e.code === 'QUOTA' ? new ApiError(507, e.message, 'storage_full') : new ApiError(503, 'Could not save the picture right now. Try again in a moment.', 'storage_error'); }
    t.preview = `/uploads/${file}`; save(); changed(req.user.id, req);
    res.json(libView(t));
  }));

  /* ---- Discovery ---- */
  r.get('/themes/discover', h(async (req, res) => {
    const kind = THEME_KINDS.includes(req.query.kind) ? req.query.kind : 'site';
    let list = Object.values(db.themes).filter((t) => t.kind === kind && alive(t));
    // Featured (the default): the most upvoted first, newest first among equals; Most downloaded (installed); alphabetical; or a shuffle
    list = req.query.sort === 'alpha' ? list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || cmpId(a.id, b.id))
      : req.query.sort === 'random' ? shuffled(list, req.query.seed)
        : req.query.sort === 'downloads' ? list.sort((a, b) => (b.installs || 0) - (a.installs || 0) || votesOf(b) - votesOf(a) || cmpId(b.id, a.id))
          : list.sort((a, b) => votesOf(b) - votesOf(a) || cmpId(b.id, a.id));
    const off = Math.max(0, Math.floor(Number(req.query.offset)) || 0); const lim = Math.min(100, Math.max(1, Math.floor(Number(req.query.limit)) || 48));
    res.json({ total: list.length, themes: list.slice(off, off + lim).map((t) => pubView(t, req.user)) });
  }));
  /** Post one of your own library themes. Only people with the creator badge, and Orata staff and developers; a theme you installed from someone else can't be posted again. */
  r.post('/themes/discover', limit('themepub', 20, 60_000, (req) => req.user.id), h(async (req, res) => {
    if (!canPost(req.user)) throw forbidden('Only creators and Orata staff can post themes.');
    const t = find({ ...req, params: { id: String(req.body?.id || '') } });
    if (t.from) throw bad('You can only post themes you made yourself, not ones you installed.', 'not_yours');
    if (t.published && db.themes[t.published]) throw bad('This theme is already posted. Remove it from Discovery first to post it again.', 'already_published');
    if (!t.preview) throw bad('This theme has no preview picture yet. Open it in your library and try again.', 'no_preview');
    const name = cleanThemeName(req.body?.name ?? t.name); if (!name) throw bad('Give the theme a name');
    if (hasProfanity(name)) throw bad('That name isn’t allowed.', 'name');
    const pub = { id: newId(), kind: t.kind, name, data: structuredClone(t.data), preview: t.preview, authorId: req.user.id, createdAt: Date.now(), installs: 0 };
    db.themes[pub.id] = pub; t.published = pub.id; save(); changed(req.user.id, req);
    res.json(pubView(pub, req.user));
  }));
  /** Unpublish: its author can; so can Orata staff (a theme that breaks the Community Guidelines). People who installed it keep their copy. */
  r.delete('/themes/discover/:id', h(async (req, res) => {
    const t = db.themes[req.params.id]; if (!t) throw notFound('That theme isn’t on Discovery');
    if (t.authorId !== req.user.id && !isStaff(req.user)) throw forbidden('Only the theme’s author can unpublish it.');
    delete db.themes[t.id];
    for (const x of db.users[t.authorId]?.themes || []) if (x.published === t.id) x.published = null;
    if (t.authorId !== req.user.id) staffLog(req.user.id, 'unpublish_theme', t.authorId, '', { theme: t.name });
    save(); changed(t.authorId, req);
    res.json({ ok: true });
  }));
  /** Upvote a theme (or take your upvote back): { vote: true | false }. Not your own. Resolves the theme's votes and whether you voted. */
  r.put('/themes/discover/:id/vote', limit('themevote', 60, 60_000, (req) => req.user.id), h(async (req, res) => {
    const t = db.themes[req.params.id]; if (!t || !alive(t)) throw notFound('That theme isn’t on Discovery any more');
    if (typeof req.body?.vote !== 'boolean') throw bad('Say whether to upvote or take the upvote back');
    if (t.authorId === req.user.id) throw bad('You can’t upvote your own theme.', 'own_theme');
    const votes = (t.votes ||= []); const at = votes.indexOf(req.user.id);
    if (req.body.vote && at < 0) votes.push(req.user.id); else if (!req.body.vote && at >= 0) votes.splice(at, 1);
    save(); res.json({ votes: votes.length, voted: votes.includes(req.user.id) });
  }));
  /** Copies a posted theme into your library, if there is room for it. */
  r.post('/themes/discover/:id/install', pace, h(async (req, res) => {
    const pub = db.themes[req.params.id]; if (!pub || !alive(pub)) throw notFound('That theme isn’t on Discovery any more');
    const have = mine(req).find((x) => x.from === pub.id);
    if (have) return res.json({ already: true, theme: libView(have) });
    if (mine(req).filter((x) => x.kind === pub.kind).length >= LIBRARY_LIMIT) throw full(pub.kind);
    const t = { id: newId(), kind: pub.kind, name: pub.name, data: structuredClone(pub.data), preview: pub.preview, createdAt: Date.now(), from: pub.id, published: null };
    mine(req).push(t); pub.installs = (pub.installs || 0) + 1; save(); changed(req.user.id, req);
    res.json({ already: false, theme: libView(t) });
  }));
}
