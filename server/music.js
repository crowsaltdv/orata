// Orata — music from Apple Music's public catalogue: search, 30-second previews and the "Listening to" status. No API key needed.
//
// Uses Apple's keyless iTunes Search API (https://performance-partners.apple.com/search-api — `GET https://itunes.apple.com/search` and `/lookup`).
// It is the same catalogue as Apple Music, with the same artwork, links and 30-second previews. (The Apple Music API proper,
// developer.apple.com/documentation/applemusicapi, needs a developer token signed with a paid Apple Developer account's key — that is the part
// this avoids.) Full-length playback is not possible without MusicKit and each listener's own Apple Music subscription, so previews play.
//
// The server does all the talking to Apple. A preview is downloaded when it is asked for (it is about 1 MB), kept in memory for a while and served
// to the <audio> tag from /api/music/play/<id> with Range support so the seek bar works. An <audio> tag can't send a bearer token, so that link is
// signed by this server (HMAC, short-lived) when a signed-in user asks for it. Apple allows roughly 20 searches a minute per IP address, so results
// are cached and Orata never sends more than MUSIC_API_PER_MIN (default 18) requests a minute, however many people search.
import crypto from 'node:crypto';
import net from 'node:net';
import { ENV, db, save, emitTo, relatedUserIds, publicUser, selfUser, ApiError, bad, notFound } from './core.js';

const API = String(ENV.MUSIC_API_BASE || 'https://itunes.apple.com').replace(/\/$/, '');
const COUNTRY = (String(ENV.MUSIC_COUNTRY || 'US').trim().toUpperCase().match(/^[A-Z]{2}$/) || ['US'])[0];
const PER_MIN = Math.max(1, Number(ENV.MUSIC_API_PER_MIN) || 18);
const EXTRA_HOSTS = String(ENV.MUSIC_MEDIA_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);   // tests / mirrors only
/** Music is on by default; MUSIC=off turns the player off for everybody. */
export const musicConfigured = () => !/^(off|false|0|no)$/i.test(String(ENV.MUSIC || '').trim());
const needEnabled = () => { if (!musicConfigured()) throw new ApiError(503, 'Music is turned off on this server.', 'music_not_configured'); };

const TRACK_ID = /^\d{1,14}$/;
const appleUrl = (v) => { try { const u = new URL(String(v)); return u.protocol === 'https:' && /(^|\.)(apple\.com|mzstatic\.com)$/i.test(u.hostname) ? u.href : null; } catch { return null; } };

/* ------------------------------------------------------------ Apple's search API */
const calls = [];   // when the last requests to Apple were made
function takeSlot() {
  const now = Date.now(); while (calls.length && now - calls[0] > 60_000) calls.shift();
  if (calls.length >= PER_MIN) throw new ApiError(429, 'Music search is busy right now (Apple limits searches per minute). Try again in a few seconds.', 'rate_limited');
  calls.push(now);
}
async function apiGet(pathname, params) {
  takeSlot();
  const url = new URL(API + pathname);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  let res;
  try { res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) }); } catch { throw new ApiError(502, 'Could not reach Apple Music. Try again in a moment.', 'music_upstream'); }
  if (res.status === 403 || res.status === 429) throw new ApiError(429, 'Apple is limiting music searches right now. Try again in a minute.', 'rate_limited');   // that is how Apple says "too many requests"
  if (!res.ok) throw new ApiError(502, `Apple Music answered with an error (${res.status}).`, 'music_upstream');
  try { return JSON.parse(await res.text()); } catch { throw new ApiError(502, 'Apple Music sent an answer Orata could not read.', 'music_upstream'); }   // it is served as text/javascript, so no res.json()
}

/* ------------------------------------------------------------ tracks */
const previewUrl = (v) => {   // previews live on Apple's CDN (audio-ssl.itunes.apple.com); https on Apple domains only (tests may add a host)
  let u; try { u = new URL(String(v)); } catch { return null; }
  if (EXTRA_HOSTS.includes(u.hostname.toLowerCase())) return u.href;
  return u.protocol === 'https:' && /(^|\.)(apple\.com|mzstatic\.com)$/i.test(u.hostname) && !net.isIP(u.hostname) ? u.href : null;
};
/** One search / lookup result → what the app shows. `_preview` stays on the server. */
const songView = (d) => {
  if (!d || typeof d !== 'object' || (d.wrapperType && d.wrapperType !== 'track') || (d.kind && d.kind !== 'song')) return null;
  const id = String(d.trackId ?? ''); if (!TRACK_ID.test(id)) return null;
  const preview = previewUrl(d.previewUrl); if (!preview) return null;   // no preview = nothing to play
  return {
    id, title: String(d.trackName || 'Untitled').slice(0, 200), artist: String(d.artistName || 'Unknown artist').slice(0, 100), album: String(d.collectionName || '').slice(0, 120) || null,
    artwork: appleUrl(String(d.artworkUrl100 || '').replace(/\/\d+x\d+bb\.(jpe?g|png)$/i, '/300x300bb.$1')), url: appleUrl(d.trackViewUrl),
    duration: Math.max(0, Math.round(Number(d.trackTimeMillis) || 0)), explicit: d.trackExplicitness === 'explicit', _preview: preview,
  };
};
const forClient = ({ _preview, ...t }) => t;
const known = new Map();   // id → song: what the server itself got from Apple (what is shown as "listening to" comes from here, never from a client)
const remember = (t) => { known.delete(t.id); known.set(t.id, t); if (known.size > 800) known.delete(known.keys().next().value); return t; };
const searchCache = new Map();
async function search(q) {
  const key = q.toLowerCase(); const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.tracks;
  const data = await apiGet('/search', { term: q, media: 'music', entity: 'song', limit: 24, country: COUNTRY });
  const tracks = (Array.isArray(data?.results) ? data.results : []).map(songView).filter(Boolean).map(remember).map(forClient);
  if (searchCache.size > 300) searchCache.clear();
  searchCache.set(key, { at: Date.now(), tracks });
  return tracks;
}
/* ------------------------------------------------------------ charts (the Music page's categories) */
// Apple's public top-songs feeds, per genre: `/<country>/rss/topsongs/limit=30/genre=<id>/json` (no key). Entries carry the track id, artwork and a 30-second preview.
const GENRES = [['top', 'Top Songs', null], ['pop', 'Pop', 14], ['hiphop', 'Hip-Hop / Rap', 18], ['rnb', 'R&B / Soul', 15], ['rock', 'Rock', 21], ['alt', 'Alternative', 20], ['electronic', 'Electronic', 7], ['dance', 'Dance', 17],
  ['country', 'Country', 6], ['latin', 'Latin', 12], ['kpop', 'K-Pop', 51], ['jpop', 'J-Pop', 27], ['jazz', 'Jazz', 11], ['classical', 'Classical', 5], ['metal', 'Metal', 1153], ['reggae', 'Reggae', 24],
  ['singer', 'Singer / Songwriter', 10], ['soundtrack', 'Soundtracks', 16], ['blues', 'Blues', 2], ['gospel', 'Christian & Gospel', 22]];
const chartCache = new Map();
const chartSong = (e) => {
  const links = [].concat(e?.link || []); const preview = links.find((l) => l?.attributes?.rel === 'enclosure')?.attributes?.href; const page = links.find((l) => l?.attributes?.rel === 'alternate')?.attributes?.href;
  const image = [].concat(e?.['im:image'] || []).slice(-1)[0]?.label;
  return songView({ wrapperType: 'track', kind: 'song', trackId: e?.id?.attributes?.['im:id'], trackName: e?.['im:name']?.label, artistName: e?.['im:artist']?.label, collectionName: e?.['im:collection']?.['im:name']?.label, artworkUrl100: image, trackViewUrl: page, previewUrl: preview });
};
async function chart(key) {
  const g = GENRES.find((x) => x[0] === key); if (!g) throw notFound('Unknown category');
  const hit = chartCache.get(key); if (hit && Date.now() - hit.at < 30 * 60_000) return hit.tracks;
  const data = await apiGet(`/${COUNTRY.toLowerCase()}/rss/topsongs/limit=30${g[2] ? `/genre=${g[2]}` : ''}/json`, {});
  const tracks = [].concat(data?.feed?.entry || []).map(chartSong).filter(Boolean).map(remember).map(forClient);
  chartCache.set(key, { at: Date.now(), tracks });
  return tracks;
}
async function trackInfo(id) {
  if (known.has(id)) return known.get(id);
  const t = songView((await apiGet('/lookup', { id, country: COUNTRY }))?.results?.[0]);
  if (!t) throw new ApiError(404, 'Apple Music has no playable preview of that track.', 'music_unavailable');
  return remember(t);
}

/* ------------------------------------------------------------ audio */
const audio = new Map();   // id → { buf, type, at }  (kept 30 minutes, within a memory budget)
const AUDIO_BUDGET = (Number(ENV.MUSIC_CACHE_MB) || 48) * 1024 * 1024; const MAX_CLIP = 12 * 1024 * 1024;
let audioBytes = 0; let downloads = 0; const inFlight = new Map();
const evict = () => { for (const [k, v] of audio) { if (audioBytes <= AUDIO_BUDGET && Date.now() - v.at < 30 * 60_000) break; audio.delete(k); audioBytes -= v.buf.length; } };
function getAudio(id) {
  const hit = audio.get(id);
  if (hit && Date.now() - hit.at < 30 * 60_000) return Promise.resolve(hit);
  if (!inFlight.has(id)) {
    if (downloads >= 6) return Promise.reject(new ApiError(429, 'Too many tracks are loading at once. Try again in a moment.', 'rate_limited'));
    downloads++;
    inFlight.set(id, downloadAudio(id).finally(() => { downloads--; inFlight.delete(id); }));
  }
  return inFlight.get(id);
}
async function downloadAudio(id) {
  const t = await trackInfo(id);
  let res;
  try { res = await fetch(t._preview, { redirect: 'follow', signal: AbortSignal.timeout(30_000) }); } catch { throw new ApiError(502, 'Could not download the preview from Apple Music.', 'music_upstream'); }
  if (!res.ok) throw new ApiError(res.status === 403 || res.status === 404 ? 404 : 502, 'Apple Music could not provide that preview.', res.status === 403 || res.status === 404 ? 'music_unavailable' : 'music_upstream');
  let type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type.startsWith('text/') || type.includes('json') || type.includes('html')) throw new ApiError(502, 'Apple Music did not send audio.', 'music_upstream');
  if (!/^audio\/(mpeg|mp3|mp4|aac|wav|x-wav|ogg|webm|flac)$/.test(type)) type = 'audio/mp4';   // previews are AAC in an .m4a file; Apple labels them audio/x-m4p, which browsers may not trust
  if (Number(res.headers.get('content-length')) > MAX_CLIP) throw new ApiError(502, 'That preview is unexpectedly large.', 'music_upstream');
  const chunks = []; let total = 0;
  for await (const c of res.body) { total += c.length; if (total > MAX_CLIP) throw new ApiError(502, 'That preview is unexpectedly large.', 'music_upstream'); chunks.push(c); }
  if (!total) throw new ApiError(502, 'Apple Music sent an empty file.', 'music_upstream');
  const entry = { buf: Buffer.concat(chunks, total), type, at: Date.now() };
  const old = audio.get(id); if (old) audioBytes -= old.buf.length;
  audio.set(id, entry); audioBytes += total; evict();
  return entry;
}

const KEY = crypto.randomBytes(32);   // play links only live as long as this process; the player simply asks for a new one
const sign = (id, exp) => crypto.createHmac('sha256', KEY).update(`${exp}|${id}`).digest('base64url').slice(0, 40);
const playLink = (id, ttlMs = 4 * 3600_000) => { const exp = Date.now() + ttlMs; return `/api/music/play/${id}?exp=${exp}&sig=${sign(id, exp)}`; };

/** Sends the audio, honouring Range requests (the audio element seeks with them). */
function sendAudio(req, res, clip) {
  const total = clip.buf.length; let start = 0; let end = total - 1; let status = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (m && (m[1] || m[2])) {
    if (m[1]) { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1; } else { start = Math.max(0, total - Number(m[2])); }   // "bytes=-500" = the last 500 bytes
    if (start > end || start >= total) { res.status(416).set('Content-Range', `bytes */${total}`).end(); return; }
    status = 206;
  }
  res.status(status).set({ 'Content-Type': clip.type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600', 'Cross-Origin-Resource-Policy': 'same-origin' });
  if (status === 206) res.set('Content-Range', `bytes ${start}-${end}/${total}`);
  res.end(clip.buf.subarray(start, end + 1));
}

/* ------------------------------------------------------------ "Listening to" */
const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };
/** The player reports which track, how long what it plays lasts (a preview: about 30 s) and where it is; title, artist, artwork and link are Apple's, via the server. */
async function cleanListening(body) {
  const id = String(body?.track?.id ?? ''); if (!TRACK_ID.test(id)) throw bad('Unknown track');
  needEnabled();
  const t = await trackInfo(id);
  const duration = clamp(body.duration, 1000, 6 * 3600_000, 30_000);
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
/** Before sign-in: the audio is authorised by its signature, not by a bearer token (an <audio> tag cannot send one). */
export function mountMusicPublic(r, { h, limit }) {
  r.get('/music/play/:id', limit('musicplay', 600, 60_000), h(async (req, res) => {
    needEnabled();
    const id = String(req.params.id); const exp = Number(req.query.exp); const sig = String(req.query.sig || '');
    if (!TRACK_ID.test(id)) throw bad('Unknown track');
    const want = Buffer.from(sign(id, exp)); const got = Buffer.from(sig);
    if (!exp || exp < Date.now() || want.length !== got.length || !crypto.timingSafeEqual(want, got)) throw new ApiError(403, 'This audio link has expired.', 'music_expired');
    sendAudio(req, res, await getAudio(id));
  }));
}
export function mountMusic(r, { h, limit }) {
  r.get('/music/search', limit('musicq', 40, 60_000, (req) => req.user.id), h(async (req, res) => {
    needEnabled();
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (!q) throw bad('Type something to search for');
    res.json({ tracks: await search(q) });
  }));
  r.get('/music/charts', h(async (req, res) => { needEnabled(); res.json({ genres: GENRES.map(([key, name]) => ({ key, name })) }); }));
  r.get('/music/charts/:key', limit('musicchart', 40, 60_000, (req) => req.user.id), h(async (req, res) => {
    needEnabled();
    res.json({ key: String(req.params.key), tracks: await chart(String(req.params.key)) });
  }));
  // the player asks right before playing; the preview is loaded now, so problems show up immediately and playback can start at once
  r.get('/music/tracks/:id/source', limit('musicsrc', 90, 60_000, (req) => req.user.id), h(async (req, res) => {
    needEnabled();
    const id = String(req.params.id); if (!TRACK_ID.test(id)) throw bad('Unknown track');
    const clip = await getAudio(id);
    res.json({ type: clip.type, url: playLink(id), preview: true, bytes: clip.buf.length });
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
void notFound;
