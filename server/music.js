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
import { ENV, ROOT, db, save, emitTo, relatedUserIds, publicUser, selfUser, ApiError, bad, notFound, newId } from './core.js';

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
const REF_ID = /^[A-Za-z0-9_-]{8,40}$/;   // an artist or album id
const artistRefs = (list) => (Array.isArray(list) ? list : []).filter((a) => a && typeof a.name === 'string' && a.name).slice(0, 6).map((a) => ({ name: a.name.slice(0, 60), id: typeof a.id === 'string' && REF_ID.test(a.id) ? a.id : null }));
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
    albumId: typeof d.albumId === 'string' && REF_ID.test(d.albumId) ? d.albumId : null,   // what links to the artist's and the album's page in Orata
    artists: artistRefs(d.artists).length ? artistRefs(d.artists) : [{ name: String(d.artist || 'Unknown artist').slice(0, 60), id: null }],
    artwork: artUrl(d.artwork), url: `https://music.youtube.com/watch?v=${id}`,
    duration: Math.max(0, Math.round(Number(d.duration) || 0)), explicit: d.explicit === true,
  };
};
const known = new Map();   // id → song: what the server itself got from YouTube Music (what is shown as "listening to" comes from here, never from a client)
const remember = (t) => { known.delete(t.id); known.set(t.id, t); if (known.size > 8000) known.delete(known.keys().next().value); return t; };
const views = (list) => (Array.isArray(list) ? list : []).map(songView).filter(Boolean).map(remember);

const cached = new Map();
async function memo(key, ttl, load) {
  const hit = cached.get(key); if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await load();
  if (cached.size > 400) cached.clear();
  cached.set(key, { at: Date.now(), value });
  return value;
}
/* Long lists, a page at a time: what has been fetched of a chart or a search so far is kept, and only asking past its end fetches more.
 * Songs already in the list are dropped, so pages never repeat one. */
const lists = new Map();   // key → { tracks, seen, more, page, at, busy }
async function grow(key, ttl, want, fetchPage) {
  let L = lists.get(key);
  if (!L || Date.now() - L.at > ttl) { if (lists.size > 80) lists.delete(lists.keys().next().value); L = { tracks: [], seen: new Set(), more: true, page: 0, at: Date.now(), busy: null }; lists.set(key, L); }
  while (L.tracks.length < want && L.more) {
    L.busy ||= fetchPage(L.page).then(({ tracks, more }) => {
      for (const t of views(tracks)) if (!L.seen.has(t.id)) { L.seen.add(t.id); L.tracks.push(t); }
      L.page++; L.more = !!more && L.page < 50;
    }).finally(() => { L.busy = null; });
    await L.busy;
  }
  return L;
}
const SEARCH_TIERS = [40, 200];   // YouTube Music has no "next page" for a search: the second ask is a longer one (the repeats are dropped)
const searchList = (q, want) => grow(`s:${q.toLowerCase()}`, 10 * 60_000, want, async (page) => {
  const found = await upstream('search', { q, limit: SEARCH_TIERS[page] });
  return { tracks: found, more: page + 1 < SEARCH_TIERS.length && found.length >= SEARCH_TIERS[page] * 0.8 };
});
const searchArtists = (q) => memo(`sa:${q.toLowerCase()}`, 10 * 60_000, async () => (await upstream('artists', { q })).filter((a) => a && REF_ID.test(String(a.id))).slice(0, 5).map((a) => ({ id: String(a.id), name: String(a.name || '').slice(0, 100), avatar: artUrl(a.avatar) })));
const KEY = /^[a-z0-9-]{1,60}$/;
const categories = () => memo('categories', 6 * 3600_000, async () => (await upstream('categories')).filter((c) => c && KEY.test(c.key)).map((c) => ({ key: c.key, name: String(c.name || c.key).slice(0, 40), group: c.group === 'genre' || c.group === 'mood' ? c.group : 'chart' })));
function chartList(key, want) {
  if (!KEY.test(key)) throw notFound('Unknown category');
  return grow(`c:${key}`, 30 * 60_000, want, async (page) => { const r = await upstream('category', { key, page }); return Array.isArray(r) ? { tracks: r, more: false } : { tracks: r?.tracks, more: !!r?.more }; });
}
/** `?offset=&limit=` of a growing list → the page, and whether there is more after it. */
async function pageOf(req, load, size) {
  const offset = clamp(req.query.offset, 0, 5000, 0); const n = clamp(req.query.limit, 1, 100, size);
  const L = await load(offset + n);
  if (L.more && L.tracks.length < offset + 2 * n) load(offset + 2 * n).catch(() => {});   // the next page, fetched while this one is looked at, so scrolling on doesn't wait
  return { tracks: L.tracks.slice(offset, offset + n), hasMore: L.tracks.length > offset + n || L.more };
}
async function trackInfo(id) {
  if (known.has(id)) return known.get(id);
  const t = songView(await upstream('song', { videoId: id }));
  if (!t) throw new ApiError(404, 'That song isn’t available.', 'music_unavailable');
  return remember(t);
}

/* ------------------------------------------------------------ artist and album pages */
const text = (v, max) => String(v ?? '').slice(0, max);
const albumCard = (c) => (c && REF_ID.test(String(c.id)) ? { id: String(c.id), title: text(c.title || 'Untitled', 120), year: /^\d{4}$/.test(String(c.year)) ? String(c.year) : null, type: text(c.type || 'Album', 20), artwork: artUrl(c.artwork) } : null);
/** The helper's artist page → what the app shows. The songs are remembered like any other list, so adding one to a playlist later needs no lookup. */
const artistView = (d) => (!d || !REF_ID.test(String(d.id)) ? null : {
  id: String(d.id), name: text(d.name || 'Unknown artist', 100), description: text(d.description, 700), subscribers: text(d.subscribers, 20) || null, listeners: text(d.listeners, 30) || null,
  avatar: artUrl(d.avatar), banner: artUrl(d.banner), songs: views(d.songs),
  albums: (Array.isArray(d.albums) ? d.albums : []).map(albumCard).filter(Boolean), singles: (Array.isArray(d.singles) ? d.singles : []).map(albumCard).filter(Boolean),
});
const albumView = (d) => (!d || !REF_ID.test(String(d.id)) ? null : {
  id: String(d.id), title: text(d.title || 'Album', 120), type: text(d.type || 'Album', 20), year: /^\d{4}$/.test(String(d.year)) ? String(d.year) : null,
  artists: artistRefs(d.artists), artwork: artUrl(d.artwork), duration: Math.max(0, Math.round(Number(d.duration) || 0)), tracks: views(d.tracks),
});
const artist = (id) => memo(`artist:${id}`, 30 * 60_000, async () => {
  const v = artistView(await upstream('artist', { browseId: id })); if (!v) throw new ApiError(404, 'That artist isn’t available.', 'music_unavailable'); return v;
});
const album = (id) => memo(`album:${id}`, 30 * 60_000, async () => {
  const v = albumView(await upstream('album', { browseId: id })); if (!v) throw new ApiError(404, 'That album isn’t available.', 'music_unavailable'); return v;
});

/* ------------------------------------------------------------ playlists (private to their owner, kept with the account) */
const MAX_PLAYLISTS = 50; const MAX_PLAYLIST_TRACKS = 500;
const playlistsOf = (u) => (u.playlists ||= []);
const playlistName = (v) => { const n = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 60); if (!n) throw bad('Give the playlist a name'); return n; };
const findPlaylist = (u, id) => { const p = playlistsOf(u).find((x) => x.id === String(id)); if (!p) throw notFound('That playlist doesn’t exist'); return p; };
const playlistSummary = (p) => ({ id: p.id, name: p.name, count: p.tracks.length, duration: p.tracks.reduce((n, t) => n + (t.duration || 0), 0), covers: p.tracks.map((t) => t.artwork).filter(Boolean).slice(0, 4), image: p.image || null, updatedAt: p.updatedAt });   // image: a picture of its own, in place of the covers
/** What a song shared in a chat shows (/song): the server's own details of it (from YouTube Music), never what the client says. */
export async function songCard(id) {
  const tid = String(id ?? ''); if (!TRACK_ID.test(tid)) throw bad('Unknown track');
  needEnabled();
  const { title, artist, artists, album, albumId, artwork, duration, url } = await trackInfo(tid);
  return { id: tid, title, artist, artists, album, albumId, artwork, duration, url };
}
/** What a playlist shared in a chat shows (a snapshot; opening it loads the playlist as it is now, through the message). */
export function playlistCard(u, id) {
  const p = playlistsOf(u).find((x) => x.id === String(id ?? '')); if (!p) throw notFound('That playlist doesn’t exist');
  if (!p.tracks.length) throw bad('That playlist is empty');
  return { ...playlistSummary(p), ownerId: u.id, preview: p.tracks.slice(0, 3).map(({ id: tid, title, artist, artwork, duration }) => ({ id: tid, title, artist, artwork, duration })) };
}
/** A playlist keeps its own copy of each song's details (from the server's own lookup, never from the client), so it shows without asking YouTube again. */
const keep = ({ id, title, artist, artists, album, albumId, artwork, duration, explicit }) => ({ id, title, artist, artists, album, albumId, artwork, duration, explicit });
async function addToPlaylist(p, trackId) {
  const id = String(trackId ?? ''); if (!TRACK_ID.test(id)) throw bad('Unknown track');
  if (p.tracks.some((t) => t.id === id)) return false;
  if (p.tracks.length >= MAX_PLAYLIST_TRACKS) throw bad(`A playlist holds up to ${MAX_PLAYLIST_TRACKS} songs`);
  p.tracks.push(keep(await trackInfo(id))); p.updatedAt = Date.now();
  return true;
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
  return { id, title: t.title, artist: t.artist, artistId: t.artists?.[0]?.id || null, albumId: t.albumId || null, artwork: t.artwork, url: t.url, duration, startedAt: now - position, endsAt: now + (duration - position) };
}
export function setListening(u, value) {
  u.listening = value || null; save();
  emitTo(relatedUserIds(u.id), 'user_update', { user: publicUser(u) });
  emitTo([u.id], 'self_update', { user: selfUser(u) });
}

/* ------------------------------------------------------------ routes */
/* ------------------------------------------------------------ Song guess (like Songspot): name a song from a split second of it
 * A round is a random song for the genre, era and artist picked (any of them may be left open), from the part
 * of the list the difficulty asks for: searches and charts come most popular first, so Easy takes the top of the list and Impossible goes deep. */
export const GUESS = {
  genres: ['Pop', 'Rock', 'Hip-Hop', 'R&B', 'Teen Pop', 'Vocal', 'Country', 'Latin', 'Electronic', 'K-Pop', 'Indie', 'Alternative', 'Metal', 'Phonk', 'Reggaeton', 'Jazz'],
  eras: ['1960s', '1970s', '1980s', '1990s', '2000s', '2010s', '2020s', 'Classic'],
  artists: ['Taylor Swift', 'Michael Jackson', 'Bad Bunny', 'Katy Perry', 'Drake', 'The Weeknd', 'Billie Eilish', 'Ed Sheeran', 'Ariana Grande', 'Queen', 'Eminem', 'Rihanna', 'Bruno Mars', 'Olivia Rodrigo', 'Dua Lipa', 'Coldplay', 'Adele', 'Harry Styles', 'Kendrick Lamar', 'BTS'],
  difficulties: ['easy', 'medium', 'hard', 'expert', 'impossible'],
};
const DEPTH = { easy: [0, 10], medium: [5, 25], hard: [15, 50], expert: [30, 100], impossible: [60, 200] };   // which songs of the list, most popular first
const guessed = new Map();   // user id → the songs they got lately, so the same one doesn't come back for a while
/** The song search a round falls back on: an artist's songs (in an era), the hits of a genre and/or an era, or none (the top chart) when everything is open. */
function guessQuery({ genre, era, artist }) {
  if (artist) return `${artist}${era ? ` ${era}` : ''} songs`;
  return genre || era ? `${genre ? `${genre} ` : ''}${era ? `${era} ` : ''}hits` : null;
}
/** The songs of the best playlist YouTube Music has for a search (a genre and/or an era keep to their topic there). Kept for half an hour. */
const playlistSongs = (q) => memo(`ps:${q.toLowerCase()}`, 30 * 60_000, async () => views(await upstream('playlist_songs', { q, limit: 200 })));
/** The songs a round draws from, most popular first: an artist's own list of their songs, YouTube Music's own playlists of a genre, the best playlist for
 *  the genre and/or era ("Phonk 2020s"), else a song search (or the top chart when everything is open). */
async function guessPool(pick, want) {
  if (pick.artist) {
    const a = (await searchArtists(pick.artist).catch(() => []))[0];
    const songs = a ? (await artist(a.id).catch(() => null))?.songs || [] : [];
    if (songs.length) return songs;
  }
  if (pick.genre && !pick.era) {
    const g = pick.genre.toLowerCase(); const genres = (await categories().catch(() => [])).filter((c) => c.group === 'genre');
    const c = genres.find((x) => x.name.toLowerCase() === g) || genres.find((x) => x.name.toLowerCase().startsWith(g)) || genres.find((x) => x.name.toLowerCase().includes(g));
    const songs = c ? (await chartList(c.key, want).catch(() => null))?.tracks || [] : [];
    if (songs.length) return songs;
  }
  if (pick.genre || pick.era) {
    const songs = await playlistSongs(pick.genre ? `${pick.genre}${pick.era ? ` ${pick.era}` : ''}` : `${pick.era} hits`).catch(() => []);
    if (songs.length >= 10) return songs;
  }
  const q = guessQuery(pick);
  return (q ? await searchList(q, want) : await chartList('top', want)).tracks;
}
/** Where the part of a song people replay most starts, from YouTube's "Most replayed" heat map in the page of its video (`html`): the busiest stretch,
 *  leaving out the first 8 % (everyone replays the start) and the last 15 s. Seconds, or null when the page has no heat map. */
export function heatmapHighlight(html) {
  const m = [...String(html).matchAll(/\{"startMillis":"(\d+)","durationMillis":"(\d+)","intensityScoreNormalized":([\d.e-]+)\}/g)].map((x) => ({ s: Number(x[1]) / 1000, v: Number(x[3]) }));
  if (m.length < 10) return null;
  const total = m[m.length - 1].s + (m[1].s - m[0].s); let best = null;
  for (let i = 1; i < m.length - 1; i++) {
    if (m[i].s < total * 0.08 || m[i].s > total - 15) continue;
    const v = m[i - 1].v + m[i].v + m[i + 1].v; if (!best || v > best.v) best = { s: m[i].s, v };
  }
  return best ? Math.round(best.s) : null;
}
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
/** The second a round plays from: the song's most replayed part, or about a third of the way in when YouTube has no heat map for it. Kept for a day.
 *  (GUESS_PAGE_URL: where video pages come from instead of YouTube, for the tests.) */
const highlightOf = (t) => memo(`hl:${t.id}`, 24 * 3600_000, async () => {
  let at = null;
  try { const r = await fetch(`${ENV.GUESS_PAGE_URL || 'https://www.youtube.com/watch?hl=en&v='}${t.id}`, { headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(6000) }); if (r.ok) at = heatmapHighlight(await r.text()); } catch { /* no heat map then */ }
  const secs = Math.floor((t.duration || 0) / 1000);
  return at ?? (secs >= 60 ? Math.min(secs - 30, Math.max(15, Math.round(secs * 0.3))) : 0);
});

export function mountMusic(r, { h, limit, getChannel }) {
  r.get('/music/search', limit('musicq', 60, 60_000, (req) => req.user.id), h(async (req, res) => {
    needEnabled();
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (!q) throw bad('Type something to search for');
    const first = !Number(req.query.offset);
    const [page, artists] = await Promise.all([pageOf(req, (want) => searchList(q, want), 30), first ? searchArtists(q).catch(() => []) : []]);   // artists are a bonus: a hiccup there never hides the songs
    res.json({ ...page, artists });
  }));
  r.get('/music/charts', h(async (req, res) => { needEnabled(); res.json({ genres: await categories() }); }));
  r.get('/music/guess', h(async (req, res) => { needEnabled(); res.json(GUESS); }));
  r.post('/music/guess/round', limit('musicguess', 60, 60_000, (req) => req.user.id), h(async (req, res) => {
    needEnabled();
    const b = req.body || {};
    const choice = (list, v) => { if (v == null || v === '') return null; if (!list.includes(v)) throw bad('Pick from the list'); return v; };
    const pick = { genre: choice(GUESS.genres, b.genre), era: choice(GUESS.eras, b.era), artist: choice(GUESS.artists, b.artist) };
    const [from, to] = DEPTH[choice(GUESS.difficulties, b.difficulty) || 'easy'];
    const pool = (await guessPool(pick, to)).filter((t) => !t.duration || t.duration >= 30_000);   // (not too short to guess)
    let part = pool.slice(from, to); if (part.length < 5) part = pool.slice(-Math.min(pool.length, to - from));   // a short list: its deepest end
    const recent = guessed.get(req.user.id) || []; const fresh = part.filter((t) => !recent.includes(t.id));
    const choices = fresh.length ? fresh : part;
    if (!choices.length) throw new ApiError(404, 'No songs found for that mix. Try other choices.', 'guess_empty');
    const t = choices[Math.floor(Math.random() * choices.length)];
    guessed.set(req.user.id, [t.id, ...recent].slice(0, 40));
    res.json({ song: { id: t.id, title: t.title, artist: t.artist, artists: t.artists, artwork: t.artwork, duration: t.duration }, start: await highlightOf(t) });
  }));
  r.get('/music/charts/:key', limit('musicchart', 40, 60_000, (req) => req.user.id), h(async (req, res) => {
    needEnabled();
    const key = String(req.params.key);
    if (key !== 'top' && key !== 'trending' && !(await categories()).some((c) => c.key === key)) throw notFound('Unknown category');
    res.json({ key, ...await pageOf(req, (want) => chartList(key, want), 60) });
  }));
  r.get('/music/artists/:id', limit('musicpage', 60, 60_000, (req) => req.user.id), h(async (req, res) => {
    needEnabled();
    const id = String(req.params.id); if (!REF_ID.test(id)) throw bad('Unknown artist');
    res.json({ artist: await artist(id) });
  }));
  r.get('/music/albums/:id', limit('musicpage', 60, 60_000, (req) => req.user.id), h(async (req, res) => {
    needEnabled();
    const id = String(req.params.id); if (!REF_ID.test(id)) throw bad('Unknown album');
    res.json({ album: await album(id) });
  }));

  /* ---- your playlists */
  const lim = limit('playlists', 120, 60_000, (req) => req.user.id);
  r.get('/me/playlists', h(async (req, res) => { res.json({ playlists: playlistsOf(req.user).map(playlistSummary) }); }));
  /** Every song in your playlists once (what "Shuffle library" plays from). */
  r.get('/me/library', h(async (req, res) => {
    const all = new Map(); for (const p of playlistsOf(req.user)) for (const t of p.tracks) if (!all.has(t.id)) all.set(t.id, t);
    res.json({ tracks: [...all.values()].slice(0, 3000).map(songView).filter(Boolean) });
  }));
  r.post('/me/playlists', lim, h(async (req, res) => {
    const list = playlistsOf(req.user); if (list.length >= MAX_PLAYLISTS) throw bad(`You can have up to ${MAX_PLAYLISTS} playlists`);
    const p = { id: newId(), name: playlistName(req.body?.name), tracks: [], createdAt: Date.now(), updatedAt: Date.now() };
    if (req.body?.trackId !== undefined) await addToPlaylist(p, req.body.trackId);   // "New playlist" from a song's + button starts with that song
    list.push(p); save();
    res.json({ playlist: playlistSummary(p) });
  }));
  r.get('/me/playlists/:id', h(async (req, res) => {
    const p = findPlaylist(req.user, req.params.id);
    res.json({ playlist: { ...playlistSummary(p), tracks: p.tracks.map(songView).filter(Boolean) } });
  }));
  r.patch('/me/playlists/:id', lim, h(async (req, res) => {   // { name } renames it, { image } sets its picture (an upload; null takes it off)
    const p = findPlaylist(req.user, req.params.id); const b = req.body || {};
    if (b.image !== undefined && b.image !== null && !/^\/uploads\/[A-Za-z0-9_.-]+\.(png|jpe?g|webp|gif)$/i.test(String(b.image))) throw bad('That isn’t a picture you uploaded');
    if (b.name !== undefined || b.image === undefined) p.name = playlistName(b.name);
    if (b.image !== undefined) p.image = b.image || undefined;
    p.updatedAt = Date.now(); save();
    res.json({ playlist: playlistSummary(p) });
  }));
  r.delete('/me/playlists/:id', lim, h(async (req, res) => {
    const list = playlistsOf(req.user); const p = findPlaylist(req.user, req.params.id);
    list.splice(list.indexOf(p), 1); save();
    res.json({ ok: true });
  }));
  r.post('/me/playlists/:id/tracks', lim, h(async (req, res) => {
    const p = findPlaylist(req.user, req.params.id);
    const added = await addToPlaylist(p, req.body?.trackId); if (added) save();
    res.json({ added, playlist: playlistSummary(p) });
  }));
  r.put('/me/playlists/:id/order', lim, h(async (req, res) => {   // drag and drop: the same songs in a new order
    const p = findPlaylist(req.user, req.params.id); const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    const byId = new Map(p.tracks.map((t) => [t.id, t]));
    if (ids.length !== p.tracks.length || new Set(ids).size !== ids.length || !ids.every((id) => byId.has(id))) throw bad('That isn’t this playlist’s songs');
    p.tracks = ids.map((id) => byId.get(id)); p.updatedAt = Date.now(); save();
    res.json({ playlist: playlistSummary(p) });
  }));
  /* ---- playlists shared in a chat (/playlist): anyone who can see the message can open, play or copy it, never change it */
  const shared = (req) => {
    const ch = getChannel(req, req.params.id); const m = (db.messages[ch.id] || []).find((x) => x.id === String(req.params.mid));
    const owner = m?.playlist && db.users[m.playlist.ownerId]; const p = owner && playlistsOf(owner).find((x) => x.id === m.playlist.id);
    if (!p) throw new ApiError(404, 'This playlist was deleted or isn’t available anymore.', 'playlist_gone');
    return { p, owner };
  };
  r.get('/channels/:id/messages/:mid/playlist', h(async (req, res) => {
    const { p, owner } = shared(req);
    res.json({ playlist: { ...playlistSummary(p), ownerId: owner.id, tracks: p.tracks.map(songView).filter(Boolean) }, users: [publicUser(owner)] });
  }));
  r.post('/channels/:id/messages/:mid/playlist/save', lim, h(async (req, res) => {   // your own copy: changing it never touches theirs
    const { p, owner } = shared(req);
    const list = playlistsOf(req.user); if (list.length >= MAX_PLAYLISTS) throw bad(`You can have up to ${MAX_PLAYLISTS} playlists`);
    const copy = { id: newId(), name: p.name, image: p.image, tracks: p.tracks.map((t) => ({ ...t })), createdAt: Date.now(), updatedAt: Date.now(), savedFrom: owner.id === req.user.id ? undefined : { ownerId: owner.id, playlistId: p.id } };
    list.push(copy); save();
    res.json({ playlist: playlistSummary(copy) });
  }));
  r.delete('/me/playlists/:id/tracks/:trackId', lim, h(async (req, res) => {
    const p = findPlaylist(req.user, req.params.id); const before = p.tracks.length;
    p.tracks = p.tracks.filter((t) => t.id !== String(req.params.trackId));
    if (p.tracks.length !== before) { p.updatedAt = Date.now(); save(); }
    res.json({ playlist: playlistSummary(p) });
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
