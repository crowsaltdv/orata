// Orata — music from YouTube Music: search, charts, genre pages and the "Listening to" status. No API key and no login needed.
//
// The catalogue comes from ytmusicapi (https://github.com/sigma67/ytmusicapi), a Python library, so the server starts a small helper
// (music-service/service.py) and talks to it over its stdin/stdout, one JSON line per request. ytmusicapi only returns metadata:
// YouTube's audio links need its own player to decode, so the server never touches audio. A track id is a YouTube video id and the
// browser plays it in YouTube's embedded player (see public/js/music.js). Without Python and `pip install -r music-service/requirements.txt`
// everything else in Orata works and the Music page says what is missing.
//
// Searches and charts are cached, and Orata never sends more than MUSIC_API_PER_MIN (default 40) requests a minute to YouTube however many people search.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { ENV, ROOT, db, save, emitTo, relatedUserIds, publicUser, selfUser, ApiError, bad, notFound } from './core.js';

const COUNTRY = (String(ENV.MUSIC_COUNTRY || 'US').trim().toUpperCase().match(/^[A-Z]{2}$/) || ['US'])[0];
const PER_MIN = Math.max(1, Number(ENV.MUSIC_API_PER_MIN) || 40);
/** Music is on by default; MUSIC=off turns the player off for everybody. */
const enabled = () => !/^(off|false|0|no)$/i.test(String(ENV.MUSIC || '').trim());
/** Why music can't run right now (no Python, ytmusicapi missing ...), or null. Retried every minute, so installing it needs no restart. */
let problem = null; let problemAt = 0;
export const musicProblem = () => (enabled() ? problem : null);
const needEnabled = () => {
  if (!enabled()) throw new ApiError(503, 'Music is turned off on this server.', 'music_not_configured');
  if (problem && Date.now() - problemAt < 60_000) throw new ApiError(503, problem, 'music_not_configured');
};

const TRACK_ID = /^[A-Za-z0-9_-]{11}$/;   // a YouTube video id
const ART_HOST = /(^|\.)(googleusercontent\.com|ggpht\.com|ytimg\.com)$/i;
const artUrl = (v) => { try { const u = new URL(String(v)); return u.protocol === 'https:' && ART_HOST.test(u.hostname) && !net.isIP(u.hostname) ? u.href : null; } catch { return null; } };

/* ------------------------------------------------------------ the helper process */
/** What to start: MUSIC_HELPER (a JSON array or a command, for tests), else the first Python that works: the one `npm install` set up (music-service/.python), MUSIC_PYTHON, music-service/.venv, then the system's. */
function candidates() {
  if (ENV.MUSIC_HELPER) {
    let cmd; try { cmd = JSON.parse(ENV.MUSIC_HELPER); } catch { cmd = String(ENV.MUSIC_HELPER).split(/\s+/); }
    return [cmd];
  }
  const dir = path.join(ROOT, 'music-service'); const script = path.join(dir, 'service.py'); const pys = [];
  try { const marked = JSON.parse(fs.readFileSync(path.join(dir, '.python'), 'utf8')); if (Array.isArray(marked) && marked.length) pys.push(marked); } catch { /* not installed by npm install */ }
  if (ENV.MUSIC_PYTHON) pys.push([ENV.MUSIC_PYTHON]);
  for (const rel of ['.venv/bin/python', '.venv/Scripts/python.exe']) if (fs.existsSync(path.join(dir, rel))) pys.push([path.join(dir, rel)]);
  pys.push(...(process.platform === 'win32' ? [['python'], ['py']] : [['python3'], ['python']]));
  return pys.map((py) => [...py, script]);
}

let helper = null;   // { child, version } while it runs
let starting = null;
const pending = new Map();   // request id → { resolve, reject, timer }
let seq = 0;

function onReply(m) {
  const p = pending.get(m.id); if (!p) return;
  pending.delete(m.id); clearTimeout(p.timer);
  if (m.ok) return p.resolve(m.result);
  p.reject(m.code === 'bad_request' ? new ApiError(400, m.error, 'bad_request')
    : m.code === 'not_found' ? new ApiError(404, m.error, 'not_found')
      : m.code === 'unavailable' ? new ApiError(404, m.error, 'music_unavailable')
        : new ApiError(502, 'Music couldn’t be loaded right now. Try again in a moment.', 'music_upstream'));
}
function onExit(child) {
  if (helper?.child === child) helper = null;
  for (const [id, p] of pending) { pending.delete(id); clearTimeout(p.timer); p.reject(new ApiError(502, 'The music helper stopped. Try again.', 'music_upstream')); }
}
function launch([cmd, ...args]) {
  return new Promise((resolve, reject) => {
    let child; let phase = 'starting'; let buf = ''; let tail = '';   // starting → running (it said it is ready) or failed
    const fail = (err) => { if (phase !== 'starting') return; phase = 'failed'; clearTimeout(timer); try { child?.kill(); } catch { /* already gone */ } reject(err); };
    const timer = setTimeout(() => fail(new Error('it did not start within 20 seconds')), 20_000);
    try { child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, MUSIC_COUNTRY: COUNTRY, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' } }); } catch (e) { clearTimeout(timer); return reject(e); }
    child.on('error', (e) => fail(new Error(e.code === 'ENOENT' ? `${cmd} was not found` : e.message)));
    child.stderr.on('data', (d) => { tail = (tail + d).slice(-400); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (phase === 'starting') { if (m.ready === true) { phase = 'running'; clearTimeout(timer); resolve({ child, version: m.version }); } else fail(new Error(m.error || 'the helper did not start')); }
        else if (phase === 'running') onReply(m);
      }
    });
    child.on('exit', (code) => { if (phase === 'starting') fail(new Error(tail.trim() || `it exited with code ${code}`)); else if (phase === 'running') onExit(child); });
  });
}
async function ensure() {
  if (helper) return helper;
  starting ||= (async () => {
    let first = null; let library = null;
    for (const cmd of candidates()) {
      try { helper = await launch(cmd); problem = null; return helper; } catch (e) { const msg = `${cmd[0]}: ${e.message}`; first ||= msg; if (/ytmusicapi/.test(e.message)) library ||= e.message; }
    }
    problemAt = Date.now();
    problem = library ? `Music needs the ytmusicapi Python library on the server. Run: npm install` : `Music needs Python 3.10 or newer on the server (${first || 'none found'}). Install Python, then run: npm install`;
    throw new ApiError(503, problem, 'music_not_configured');
  })().finally(() => { starting = null; });
  return starting;
}
process.on('exit', () => { try { helper?.child.kill(); } catch { /* ignore */ } });
/** Is music usable? A problem found earlier is looked at again once a minute, so installing Python or the library needs no restart. */
export async function musicReady() {
  if (!enabled()) return false;
  if (!helper && (!problem || Date.now() - problemAt >= 60_000)) await ensure().catch(() => {});
  return !problem;
}
/** Starts the helper now (the server does this at launch) and says how it went. */
export async function musicStatus() {
  if (!enabled()) return 'off (MUSIC=off)';
  try { const h = await ensure(); return `ready (ytmusicapi ${h.version && h.version !== '?' ? h.version : ''})`.replace(' )', ')') + ' — MUSIC=off in .env turns it off'; } catch { return `OFF — ${problem}`; }
}

async function ask(op, params = {}, timeoutMs = 25_000) {
  const h = await ensure();
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new ApiError(504, 'Music took too long to load. Try again.', 'music_upstream')); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try { h.child.stdin.write(`${JSON.stringify({ ...params, id, op })}\n`); } catch { pending.delete(id); clearTimeout(timer); reject(new ApiError(502, 'The music helper stopped. Try again.', 'music_upstream')); }
  });
}
const calls = [];   // when the last requests to YouTube were made
function takeSlot() {
  const now = Date.now(); while (calls.length && now - calls[0] > 60_000) calls.shift();
  if (calls.length >= PER_MIN) throw new ApiError(429, 'Music is busy right now. Try again in a few seconds.', 'rate_limited');
  calls.push(now);
}
const upstream = (op, params) => { takeSlot(); return ask(op, params); };

/* ------------------------------------------------------------ tracks */
/** One helper result → what the app shows. */
const songView = (d) => {
  if (!d || typeof d !== 'object') return null;
  const id = String(d.id ?? ''); if (!TRACK_ID.test(id)) return null;
  return {
    id, title: String(d.title || 'Untitled').slice(0, 200), artist: String(d.artist || 'Unknown artist').slice(0, 100), album: String(d.album || '').slice(0, 120) || null,
    artwork: artUrl(d.artwork), url: `https://music.youtube.com/watch?v=${id}`,
    duration: Math.max(0, Math.round(Number(d.duration) || 0)), explicit: d.explicit === true,
  };
};
const known = new Map();   // id → song: what the server itself got from YouTube Music (what is shown as "listening to" comes from here, never from a client)
const remember = (t) => { known.delete(t.id); known.set(t.id, t); if (known.size > 1500) known.delete(known.keys().next().value); return t; };
const views = (list) => (Array.isArray(list) ? list : []).map(songView).filter(Boolean).map(remember);

const cached = new Map();
async function memo(key, ttl, load) {
  const hit = cached.get(key); if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await load();
  if (cached.size > 400) cached.clear();
  cached.set(key, { at: Date.now(), value });
  return value;
}
const search = (q) => memo(`s:${q.toLowerCase()}`, 10 * 60_000, async () => views(await upstream('search', { q, limit: 24 })));
const KEY = /^[a-z0-9-]{1,60}$/;
const categories = () => memo('categories', 6 * 3600_000, async () => (await upstream('categories')).filter((c) => c && KEY.test(c.key)).map((c) => ({ key: c.key, name: String(c.name || c.key).slice(0, 40), group: c.group === 'genre' || c.group === 'mood' ? c.group : 'chart' })));
async function chart(key) {
  if (!KEY.test(key)) throw notFound('Unknown category');
  return memo(`c:${key}`, 30 * 60_000, async () => views(await upstream('category', { key })));
}
async function trackInfo(id) {
  if (known.has(id)) return known.get(id);
  const t = songView(await upstream('song', { videoId: id }));
  if (!t) throw new ApiError(404, 'That song isn’t available.', 'music_unavailable');
  return remember(t);
}

/* ------------------------------------------------------------ "Listening to" */
const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };
/** The player reports which track, how long it is and where it is; title, artist, artwork and link are YouTube Music's, via the server. */
async function cleanListening(body) {
  const id = String(body?.track?.id ?? ''); if (!TRACK_ID.test(id)) throw bad('Unknown track');
  needEnabled();
  const t = await trackInfo(id);
  const duration = clamp(body.duration, 1000, 6 * 3600_000, t.duration || 180_000);
  const position = clamp(body.position, 0, duration, 0);
  const now = Date.now();
  return { id, title: t.title, artist: t.artist, artwork: t.artwork, url: t.url, duration, startedAt: now - position, endsAt: now + (duration - position) };
}
export function setListening(u, value) {
  u.listening = value || null; save();
  emitTo(relatedUserIds(u.id), 'user_update', { user: publicUser(u) });
  emitTo([u.id], 'self_update', { user: selfUser(u) });
}

/* ------------------------------------------------------------ routes */
export function mountMusic(r, { h, limit }) {
  r.get('/music/search', limit('musicq', 40, 60_000, (req) => req.user.id), h(async (req, res) => {
    needEnabled();
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (!q) throw bad('Type something to search for');
    res.json({ tracks: await search(q) });
  }));
  r.get('/music/charts', h(async (req, res) => { needEnabled(); res.json({ genres: await categories() }); }));
  r.get('/music/charts/:key', limit('musicchart', 40, 60_000, (req) => req.user.id), h(async (req, res) => {
    needEnabled();
    const key = String(req.params.key);
    if (key !== 'top' && key !== 'trending' && !(await categories()).some((c) => c.key === key)) throw notFound('Unknown category');
    res.json({ key, tracks: await chart(key) });
  }));
  r.put('/me/listening', limit('listening', 40, 60_000, (req) => req.user.id), h(async (req, res) => {
    const value = await cleanListening(req.body);
    setListening(req.user, value);
    res.json({ listening: value });
  }));
  r.delete('/me/listening', h(async (req, res) => {
    if (req.user.listening) setListening(req.user, null);
    res.json({ ok: true });
  }));
}
/** Called every so often: statuses of tracks that must have finished are removed. */
export function expireListening() {
  const now = Date.now();
  for (const u of Object.values(db.users)) if (u.listening && u.listening.endsAt < now) setListening(u, null);
}
