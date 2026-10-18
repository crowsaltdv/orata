// Orate — music from SoundCloud: track search, an audio relay and the "Listening to" status.
//
// Setup (see README → "Music"): create an app at https://soundcloud.com/you/apps (or with the CLI on
// https://developers.soundcloud.com/docs/building-with-ai) and put its keys in .env:
//   SOUNDCLOUD_CLIENT_ID=…   SOUNDCLOUD_CLIENT_SECRET=…
// Orate signs in to SoundCloud itself ("client credentials", HTTP Basic auth, token cached until it nearly expires), so nobody needs a
// SoundCloud account and the secret never reaches a browser. Browsers play audio through /api/music/proxy: the stream links SoundCloud
// hands out are only valid together with the server's login, and an <audio> tag cannot send one. The proxy only talks to SoundCloud's
// own hosts and only for links this server signed (HMAC), so it cannot be used to fetch anything else.
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { ENV, db, save, emitTo, relatedUserIds, publicUser, selfUser, ApiError, bad, notFound } from './core.js';

const API = (ENV.SOUNDCLOUD_API_BASE || 'https://api.soundcloud.com').replace(/\/$/, '');
const AUTH_URL = ENV.SOUNDCLOUD_AUTH_URL || 'https://secure.soundcloud.com/oauth/token';
const EXTRA_HOSTS = String(ENV.SOUNDCLOUD_MEDIA_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);   // only for tests / mirrors
export const musicConfigured = () => !!(ENV.SOUNDCLOUD_CLIENT_ID && ENV.SOUNDCLOUD_CLIENT_SECRET);
const needConfigured = () => { if (!musicConfigured()) throw new ApiError(503, 'Music isn’t set up on this server yet. The admin needs to add SOUNDCLOUD_CLIENT_ID and SOUNDCLOUD_CLIENT_SECRET to .env.', 'music_not_configured'); };

const TRACK_ID = /^[A-Za-z0-9:_-]{1,80}$/;
const SC_HOST = /(^|\.)(soundcloud\.com|sndcdn\.com)$/i;
const httpsUrl = (v) => { try { const u = new URL(String(v)); return u.protocol === 'https:' ? u.href : null; } catch { return null; } };
const onSoundCloud = (v) => { const h = httpsUrl(v); return h && SC_HOST.test(new URL(h).hostname) ? h : null; };

/* ------------------------------------------------------------ SoundCloud API access */
let token = null; let tokenExp = 0; let pendingToken = null;
async function accessToken(force = false) {
  if (!force && token && Date.now() < tokenExp - 60_000) return token;
  if (pendingToken) return pendingToken;
  pendingToken = (async () => {
    const basic = Buffer.from(`${ENV.SOUNDCLOUD_CLIENT_ID}:${ENV.SOUNDCLOUD_CLIENT_SECRET}`).toString('base64');
    let res;
    try {
      res = await fetch(AUTH_URL, { method: 'POST', headers: { accept: 'application/json; charset=utf-8', 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${basic}` }, body: 'grant_type=client_credentials', signal: AbortSignal.timeout(12_000) });
    } catch { throw new ApiError(502, 'Could not reach SoundCloud. Try again in a moment.', 'music_upstream'); }
    if (!res.ok) throw new ApiError(502, res.status === 401 || res.status === 400 ? 'SoundCloud did not accept the Client ID / Secret in .env.' : res.status === 429 ? 'SoundCloud is limiting sign-ins right now. Try again later.' : `SoundCloud sign-in failed (${res.status}).`, 'music_auth');
    const j = await res.json().catch(() => ({}));
    if (!j.access_token) throw new ApiError(502, 'SoundCloud sign-in returned no token.', 'music_auth');
    token = j.access_token; tokenExp = Date.now() + (Number(j.expires_in) || 3600) * 1000;
    return token;
  })().finally(() => { pendingToken = null; });
  return pendingToken;
}
/** GET on the SoundCloud API with our token (renewed once if SoundCloud says it is no longer valid). */
async function scGet(pathname, params = {}) {
  const url = new URL(API + pathname);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try { res = await fetch(url, { headers: { accept: 'application/json; charset=utf-8', authorization: `OAuth ${await accessToken(attempt > 0)}` }, signal: AbortSignal.timeout(15_000) }); } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(502, 'Could not reach SoundCloud. Try again in a moment.', 'music_upstream');
    }
    if (res.status === 401 && attempt === 0) continue;
    if (res.status === 404) throw notFound('SoundCloud does not have that track');
    if (res.status === 429) throw new ApiError(429, 'SoundCloud is busy. Try again in a few seconds.', 'rate_limited');
    if (!res.ok) throw new ApiError(502, `SoundCloud answered with an error (${res.status}).`, 'music_upstream');
    return res.json();
  }
  throw new ApiError(502, 'SoundCloud refused our login.', 'music_auth');
}

const trackView = (t) => {
  if (!t || t.access === 'blocked' || t.streamable === false) return null;
  const id = String(t.urn || t.id || ''); if (!TRACK_ID.test(id)) return null;
  const art = onSoundCloud(t.artwork_url) || onSoundCloud(t.user?.avatar_url);
  return {
    id, title: String(t.title || 'Untitled').slice(0, 200), artist: String(t.user?.username || 'Unknown artist').slice(0, 100), artistUrl: onSoundCloud(t.user?.permalink_url),
    artwork: art ? art.replace('-large.', '-t300x300.') : null, url: onSoundCloud(t.permalink_url), duration: Math.max(0, Math.round(Number(t.duration) || 0)), preview: t.access === 'preview',
  };
};
const searchCache = new Map();
async function search(q) {
  const key = q.toLowerCase(); const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.tracks;
  const data = await scGet('/tracks', { q, access: 'playable,preview', limit: 24, linked_partitioning: 'true' });
  const tracks = (Array.isArray(data) ? data : data?.collection || []).map(trackView).filter(Boolean);
  if (searchCache.size > 200) searchCache.clear();
  searchCache.set(key, { at: Date.now(), tracks });
  return tracks;
}
const streamCache = new Map();
async function streamsOf(id) {
  const hit = streamCache.get(id);
  if (hit && Date.now() - hit.at < 4 * 60_000) return hit.streams;
  const streams = await scGet(`/tracks/${encodeURIComponent(id)}/streams`);
  if (streamCache.size > 200) streamCache.clear();
  streamCache.set(id, { at: Date.now(), streams });
  return streams;
}

/* ------------------------------------------------------------ the audio relay */
const KEY = crypto.randomBytes(32);   // links only live as long as this process; the player simply asks for a new one
const sign = (u, exp) => crypto.createHmac('sha256', KEY).update(`${exp}|${u}`).digest('base64url').slice(0, 40);
const proxied = (u, ttlMs = 4 * 3600_000) => { const exp = Date.now() + ttlMs; return `/api/music/proxy?u=${encodeURIComponent(u)}&exp=${exp}&sig=${sign(u, exp)}`; };
const allowedHost = (u) => (u.protocol === 'https:' && SC_HOST.test(u.hostname)) || EXTRA_HOSTS.includes(u.hostname.toLowerCase());

/** Playlists are rewritten so that every segment / key / sub-playlist is fetched through the relay too. */
function rewritePlaylist(text, base) {
  const abs = (ref) => { try { return proxied(new URL(ref, base).href); } catch { return ref; } };
  return text.split(/\r?\n/).map((line) => {
    if (!line.trim()) return line;
    if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, ref) => `URI="${abs(ref)}"`);
    return abs(line.trim());
  }).join('\n');
}

async function relay(startUrl, req, res) {
  const ac = new AbortController(); res.on('close', () => ac.abort());
  let url = startUrl; let resp = null;
  for (let hop = 0; hop < 5; hop++) {
    if (!allowedHost(url)) throw new ApiError(403, 'That link is not on SoundCloud.', 'music_forbidden');
    const headers = { accept: '*/*' };
    if (req.headers.range) headers.range = String(req.headers.range).slice(0, 80);
    if (url.origin === new URL(API).origin) headers.authorization = `OAuth ${await accessToken()}`;   // only SoundCloud's own API ever sees the token
    const timer = setTimeout(() => ac.abort(), 20_000);
    try { resp = await fetch(url, { headers, redirect: 'manual', signal: ac.signal }); } catch { throw new ApiError(502, 'SoundCloud did not answer.', 'music_upstream'); } finally { clearTimeout(timer); }
    if (resp.status >= 300 && resp.status < 400 && resp.headers.get('location')) { url = new URL(resp.headers.get('location'), url); continue; }
    break;
  }
  if (!resp || (resp.status >= 300 && resp.status < 400)) throw new ApiError(502, 'SoundCloud sent too many redirects.', 'music_upstream');
  if (!resp.ok && resp.status !== 206) throw new ApiError(resp.status === 404 ? 404 : 502, 'SoundCloud could not provide that audio.', 'music_upstream');
  const type = (resp.headers.get('content-type') || '').toLowerCase();
  if (/mpegurl/.test(type) || /\.m3u8$/i.test(url.pathname)) {
    const text = await resp.text();
    if (text.length > 1_000_000) throw new ApiError(502, 'Playlist too large.', 'music_upstream');
    res.set({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'private, max-age=30' }).send(rewritePlaylist(text, url));
    return;
  }
  res.status(resp.status);
  res.set({ 'Content-Type': type || 'audio/mpeg', 'Cache-Control': 'private, max-age=3600', 'Accept-Ranges': resp.headers.get('accept-ranges') || 'bytes', 'Cross-Origin-Resource-Policy': 'same-origin' });
  for (const h of ['content-length', 'content-range']) if (resp.headers.get(h)) res.set(h, resp.headers.get(h));
  Readable.fromWeb(resp.body).on('error', () => res.destroy()).pipe(res);
}

/* ------------------------------------------------------------ "Listening to" */
const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };
function cleanListening(body) {
  const t = body?.track || {};
  const id = String(t.id ?? ''); if (!TRACK_ID.test(id)) throw bad('Unknown track');
  const url = t.url ? onSoundCloud(t.url) : null; if (t.url && !url) throw bad('Track links must point to SoundCloud');
  const artwork = t.artwork ? onSoundCloud(t.artwork) : null; if (t.artwork && !artwork) throw bad('Invalid artwork');
  const duration = clamp(t.duration, 1000, 6 * 3600_000, 0); if (!duration) throw bad('Missing track length');
  const position = clamp(body.position, 0, duration, 0);
  const now = Date.now();
  return { id, title: String(t.title || 'Untitled').slice(0, 200), artist: String(t.artist || '').slice(0, 100), artwork, url, duration, startedAt: now - position, endsAt: now + (duration - position) };
}
export function setListening(u, value) {
  u.listening = value || null; save();
  emitTo(relatedUserIds(u.id), 'user_update', { user: publicUser(u) });
  emitTo([u.id], 'self_update', { user: selfUser(u) });
}

/* ------------------------------------------------------------ routes */
/** Before sign-in: the relay is authorised by its signature, not by a bearer token (an <audio> tag cannot send one). */
export function mountMusicPublic(r, { h, limit }) {
  r.get('/music/proxy', limit('musicproxy', 1500, 60_000), h(async (req, res) => {
    needConfigured();
    const u = String(req.query.u || ''); const exp = Number(req.query.exp); const sig = String(req.query.sig || '');
    const want = Buffer.from(sign(u, exp)); const got = Buffer.from(sig);
    if (!exp || exp < Date.now() || want.length !== got.length || !crypto.timingSafeEqual(want, got)) throw new ApiError(403, 'This audio link has expired.', 'music_expired');
    let url; try { url = new URL(u); } catch { throw bad('Bad link'); }
    await relay(url, req, res);
  }));
}
export function mountMusic(r, { h, limit }) {
  r.get('/music/search', limit('musicq', 40, 60_000, (req) => req.user.id), h(async (req, res) => {
    needConfigured();
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (!q) throw bad('Type something to search for');
    res.json({ tracks: await search(q) });
  }));
  // the player asks for a link right before playing; it is signed, and good for a few hours
  r.get('/music/tracks/:id/source', limit('musicsrc', 90, 60_000, (req) => req.user.id), h(async (req, res) => {
    needConfigured();
    const id = String(req.params.id); if (!TRACK_ID.test(id)) throw bad('Unknown track');
    const s = await streamsOf(id);
    const pick = s.http_mp3_128_url ? ['mp3', s.http_mp3_128_url, false] : s.hls_mp3_128_url ? ['hls', s.hls_mp3_128_url, false] : s.hls_aac_160_url ? ['hls', s.hls_aac_160_url, false] : s.preview_mp3_128_url ? ['mp3', s.preview_mp3_128_url, true] : null;
    if (!pick) throw new ApiError(404, 'This track can’t be streamed.', 'music_unavailable');
    res.json({ type: pick[0], url: proxied(pick[1]), preview: pick[2] });
  }));

  r.put('/me/listening', limit('listening', 40, 60_000, (req) => req.user.id), h(async (req, res) => {
    const value = cleanListening(req.body);
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
