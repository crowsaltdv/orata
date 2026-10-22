// Orata — music from YouTube Music: search, top-song categories, full-length playback and the "Listening to" status. No API key needed.
//
// The server speaks YouTube Music's own web API (InnerTube, `POST https://music.youtube.com/youtubei/v1/<endpoint>`) the way the
// ytmusicapi library does (https://github.com/sigma67/ytmusicapi): the same unauthenticated WEB_REMIX client context, visitor id,
// search filter params, chart browse ids and response parsers, ported to JavaScript so Orata stays a single Node service.
// Only the public, signed-out catalogue is used: search (songs filter), the charts page (FEmusic_charts), chart playlists and the
// `player` endpoint's video details for looking a song up by id.
//
// Playback happens in the browser through YouTube's official embedded player (see public/js/music.js) — full songs, no audio
// passes through this server. The server only hands out metadata and is the source of truth for the "listening to" status:
// what others see always comes from YouTube Music via the server, never from a client.
//
// YouTube doesn't publish limits for this API, so results are cached and Orata sends at most MUSIC_API_PER_MIN (default 60)
// requests a minute however many people search.
import { ENV, db, save, emitTo, relatedUserIds, publicUser, selfUser, ApiError, bad, notFound } from './core.js';

const API = String(ENV.MUSIC_API_BASE || 'https://music.youtube.com').replace(/\/$/, '');
const ORIGIN = 'https://music.youtube.com';
const COUNTRY = (String(ENV.MUSIC_COUNTRY || 'US').trim().toUpperCase().match(/^[A-Z]{2}$/) || ['US'])[0];
const PER_MIN = Math.max(1, Number(ENV.MUSIC_API_PER_MIN) || 60);
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:88.0) Gecko/20100101 Firefox/88.0';   // ytmusicapi's
/** Music is on by default; MUSIC=off turns the player off for everybody. */
export const musicConfigured = () => !/^(off|false|0|no)$/i.test(String(ENV.MUSIC || '').trim());
const needEnabled = () => { if (!musicConfigured()) throw new ApiError(503, 'Music is turned off on this server.', 'music_not_configured'); };

const TRACK_ID = /^[\w-]{11}$/;   // a YouTube video id
const watchUrl = (id) => `https://music.youtube.com/watch?v=${id}`;
const channelUrl = (id) => (id && /^UC[\w-]{10,40}$/.test(id) ? `https://music.youtube.com/channel/${id}` : null);
/** Cover art: https on Google's image hosts only; googleusercontent links are resized to `size` px. */
const artUrl = (v, size = 300) => {
  let u; try { u = new URL(String(v)); } catch { return null; }
  if (u.protocol !== 'https:' || !/(^|\.)(googleusercontent\.com|ggpht\.com|ytimg\.com)$/i.test(u.hostname)) return null;
  return u.href.replace(/=w\d+-h\d+/, `=w${size}-h${size}`);
};

/* ------------------------------------------------------------ talking to YouTube Music (ytmusicapi: helpers.py, ytmusic.py) */
const calls = [];   // when the last requests were made
function takeSlot() {
  const now = Date.now(); while (calls.length && now - calls[0] > 60_000) calls.shift();
  if (calls.length >= PER_MIN) throw new ApiError(429, 'Music search is busy right now. Try again in a few seconds.', 'rate_limited');
  calls.push(now);
}
const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');
const context = () => ({ client: { clientName: 'WEB_REMIX', clientVersion: `1.${today()}.01.00`, hl: 'en', gl: COUNTRY }, user: {} });
// YouTube Music gives signed-out visitors an id on its home page (`ytcfg.set({... "VISITOR_DATA": ...})`); requests carry it like the web app does.
let visitor = { id: '', at: 0, pending: null };
async function visitorId() {
  if (visitor.id && Date.now() - visitor.at < 6 * 3600_000) return visitor.id;
  if (Date.now() - visitor.at < 60_000) return visitor.id;   // the last attempt just failed — don't hammer the home page
  visitor.pending ||= (async () => {
    try {
      const res = await fetch(API + '/', { headers: { 'user-agent': USER_AGENT, accept: 'text/html' }, signal: AbortSignal.timeout(10_000) });
      const m = /ytcfg\.set\s*\(\s*({.+?})\s*\)\s*;/.exec(await res.text());
      visitor.id = String((m && JSON.parse(m[1]).VISITOR_DATA) || '');
    } catch { /* requests still work without one */ }
    visitor.at = Date.now(); visitor.pending = null;
    return visitor.id;
  })();
  return visitor.pending;
}
async function ytm(endpoint, body) {
  takeSlot();
  const vid = await visitorId();
  let res;
  try {
    res = await fetch(`${API}/youtubei/v1/${endpoint}?alt=json`, {
      method: 'POST',
      headers: { 'user-agent': USER_AGENT, accept: '*/*', 'content-type': 'application/json', origin: ORIGIN, ...(vid ? { 'x-goog-visitor-id': vid } : {}) },
      body: JSON.stringify({ ...body, context: context() }), signal: AbortSignal.timeout(15_000),
    });
  } catch { throw new ApiError(502, 'Could not reach YouTube Music. Try again in a moment.', 'music_upstream'); }
  if (res.status === 429) throw new ApiError(429, 'YouTube Music is limiting requests right now. Try again in a minute.', 'rate_limited');
  if (!res.ok) throw new ApiError(502, `YouTube Music answered with an error (${res.status}).`, 'music_upstream');
  try { return await res.json(); } catch { throw new ApiError(502, 'YouTube Music sent an answer Orata could not read.', 'music_upstream'); }
}

/* ------------------------------------------------------------ parsing (ytmusicapi: navigation.py, parsers/_utils.py, parsers/songs.py) */
const nav = (root, path) => { let x = root; for (const k of path) { if (x == null) return null; x = x[k]; } return x ?? null; };
const MRLIR = 'musicResponsiveListItemRenderer';
const PLAY_VIDEO_ID = ['overlay', 'musicItemThumbnailOverlayRenderer', 'content', 'musicPlayButtonRenderer', 'playNavigationEndpoint', 'watchEndpoint', 'videoId'];
const PAGE_TYPE = ['browseEndpoint', 'browseEndpointContextSupportedConfigs', 'browseEndpointContextMusicConfig', 'pageType'];
const flexColumn = (item, i) => { const c = nav(item, ['flexColumns', i, 'musicResponsiveListItemFlexColumnRenderer']); return c?.text?.runs ? c : null; };
const itemText = (item, i, run = 0) => nav(flexColumn(item, i), ['text', 'runs', run, 'text']);
const isSeparator = (r) => r?.text === ' • ' && !r.navigationEndpoint;
const parseDuration = (s) => { const p = String(s || '').trim().split(':'); if (!p[0] || p.some((x) => !/^\d+$/.test(x))) return null; return p.reverse().reduce((t, x, i) => t + Number(x) * [1, 60, 3600][i], 0); };
function songRun(run) {
  const text = String(run?.text ?? '');
  if (run?.navigationEndpoint) {
    const id = nav(run, ['navigationEndpoint', 'browseEndpoint', 'browseId']);
    return id && (id.startsWith('MPRE') || id.includes('release_detail')) ? { type: 'album', data: { name: text, id } } : { type: 'artist', data: { name: text, id } };
  }
  if (/^(\d+:)*\d+:\d+$/.test(text)) return { type: 'duration', data: text };
  if (/^\d{4}$/.test(text)) return { type: 'year', data: text };
  if (/^\d/.test(text) && text.includes(' ')) return { type: 'views', data: text.split(' ')[0] };   // "1.2B plays"
  return { type: 'artist', data: { name: text, id: null } };
}
/** "Song • Artist & Artist • Album • 3:21" → { artists, album, duration, year }. */
function songRuns(runs, skipTypeSpec = false) {
  if (skipTypeSpec && runs.length > 2 && !runs[0].navigationEndpoint && songRun(runs[0]).type === 'artist' && isSeparator(runs[1]) && ['artist', 'duration', 'views', 'year'].includes(songRun(runs[2]).type)) runs = runs.slice(2);
  const out = { artists: [] };
  runs.forEach((run, i) => {
    if (i % 2) return;   // odd runs are separators (" • ", " & ")
    const { type, data } = songRun(run);
    if (type === 'artist') out.artists.push(data); else if (type === 'album') out.album = data;
    else if (type === 'duration') out.duration = parseDuration(data); else if (type === 'year') out.year = data;
  });
  return out;
}
const bestThumb = (list) => { const l = [].concat(list || []).filter((x) => x?.url); return l.length ? l.reduce((a, b) => ((b.width || 0) >= (a.width || 0) ? b : a)).url : null; };
const thumbsOf = (data) => nav(data, ['thumbnail', 'musicThumbnailRenderer', 'thumbnail', 'thumbnails']);
const available = (data) => data.musicItemRendererDisplayPolicy !== 'MUSIC_ITEM_RENDERER_DISPLAY_POLICY_GREY_OUT';
const explicitOf = (data) => !!nav(data, ['badges', 0, 'musicInlineBadgeRenderer', 'accessibilityData', 'accessibilityData', 'label']);

/** A song as the app sees it. */
function songView({ id, title, artists, album, thumbs, duration, explicit }) {
  if (!TRACK_ID.test(String(id || ''))) return null;
  const names = (artists || []).map((a) => a?.name).filter((n) => n && n.trim() && !/^(song|video)$/i.test(n.trim()));
  return {
    id, title: String(title || 'Untitled').slice(0, 200), artist: (names.join(', ') || 'Unknown artist').slice(0, 100), artistUrl: channelUrl(artists?.find((a) => a?.id)?.id),
    album: album?.name ? String(album.name).slice(0, 120) : null, artwork: artUrl(bestThumb(thumbs)), url: watchUrl(id),
    duration: Math.max(0, Math.round((Number(duration) || 0) * 1000)), explicit: !!explicit,
  };
}
/** One row of a search shelf (parsers/search.py parse_search_result, result type "song"). */
function searchSong(data) {
  if (!data || !available(data)) return null;
  const id = nav(data, PLAY_VIDEO_ID) || nav(flexColumn(data, 0), ['text', 'runs', 0, 'navigationEndpoint', 'watchEndpoint', 'videoId']);
  const runs = [...(nav(flexColumn(data, 1), ['text', 'runs']) || [])];
  const more = nav(flexColumn(data, 2), ['text', 'runs']); if (more) runs.push({ text: '' }, ...more);   // the first is a dummy separator
  const info = songRuns(runs, true);
  return songView({ id, title: itemText(data, 0), artists: info.artists, album: info.album, thumbs: thumbsOf(data), duration: info.duration, explicit: explicitOf(data) });
}
/** One row of a playlist (parsers/playlists.py parse_playlist_item): columns are recognised by where they link to. */
function playlistSong(data) {
  if (!data) return null;
  const ok = available(data);
  let title = ok ? null : 0; let artist = ok ? null : 1; let album = ok ? null : 2; let unrecognised = null; const channels = [];
  for (let i = 0; i < (data.flexColumns || []).length; i++) {
    const col = flexColumn(data, i); const end = nav(col, ['text', 'runs', 0, 'navigationEndpoint']);
    if (!end) { if (col?.text?.runs?.[0]?.text && songRun(col.text.runs[0]).type !== 'duration') unrecognised ??= i; continue; }
    if (end.watchEndpoint) title = i;
    else if (end.browseEndpoint) {
      const page = nav(end, PAGE_TYPE);
      if (page === 'MUSIC_PAGE_TYPE_ARTIST' || page === 'MUSIC_PAGE_TYPE_UNKNOWN') artist = i;
      else if (page === 'MUSIC_PAGE_TYPE_ALBUM' || page === 'MUSIC_PAGE_TYPE_AUDIOBOOK') album = i;
      else if (page === 'MUSIC_PAGE_TYPE_USER_CHANNEL') channels.push(i);
      else if (page === 'MUSIC_PAGE_TYPE_NON_MUSIC_AUDIO_TRACK_PAGE') title = i;
    }
  }
  if (artist == null) artist = unrecognised ?? channels.at(-1) ?? null;
  const name = title != null ? itemText(data, title) : null; if (!ok || name === 'Song deleted') return null;
  const artists = artist != null ? songRuns(nav(flexColumn(data, artist), ['text', 'runs']) || []).artists : [];
  const albumCol = album != null ? flexColumn(data, album) : null;
  const fixed = nav(data, ['fixedColumns', 0, 'musicResponsiveListItemFixedColumnRenderer', 'text']);
  return songView({
    id: nav(data, PLAY_VIDEO_ID), title: name, artists, album: albumCol ? { name: nav(albumCol, ['text', 'runs', 0, 'text']) } : null, thumbs: thumbsOf(data),
    duration: parseDuration(fixed?.simpleText ?? nav(fixed, ['runs', 0, 'text'])), explicit: explicitOf(data),
  });
}

/* ------------------------------------------------------------ what the app asks for */
const known = new Map();   // id → song the server itself got from YouTube Music (the "listening to" status is built from these, never from a client)
const remember = (t) => { known.delete(t.id); known.set(t.id, t); if (known.size > 1500) known.delete(known.keys().next().value); return t; };
const uniq = (tracks) => { const seen = new Set(); return tracks.filter((t) => t && !seen.has(t.id) && seen.add(t.id)); };

// mixins/search.py: the "songs" filter (parsers/search.py get_search_params: EgWKAQ + II + AWoMEA4QChADEAQQCRAF)
const SONGS_FILTER = 'EgWKAQIIAWoMEA4QChADEAQQCRAF';
async function searchSongs(q) {
  const res = await ytm('search', { query: q, params: SONGS_FILTER });
  const tabs = nav(res, ['contents', 'tabbedSearchResultsRenderer', 'tabs']);
  const sections = nav(tabs ? tabs[0] : res.contents, tabs ? ['tabRenderer', 'content', 'sectionListRenderer', 'contents'] : ['sectionListRenderer', 'contents']) || [];
  const rows = sections.flatMap((s) => [].concat(nav(s, ['musicShelfRenderer', 'contents']) || []));
  return uniq(rows.map((r) => searchSong(r[MRLIR]))).slice(0, 24).map(remember);
}
const searchCache = new Map();
async function search(q) {
  const key = q.toLowerCase(); const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.tracks;
  const tracks = await searchSongs(q);
  if (searchCache.size > 300) searchCache.clear();
  searchCache.set(key, { at: Date.now(), tracks });
  return tracks;
}

/* ------------------------------------------------------------ categories (the Music page's chips) */
// "Top Songs" is YouTube Music's own chart (mixins/charts.py get_charts → the first chart playlist). In the US the charts page also lists
// genre charts; a category uses its genre chart when there is one and otherwise YouTube Music's best matching songs.
const GENRES = [['top', 'Top Songs', null, 'top hits'], ['pop', 'Pop', /\bpop\b/i, 'pop hits'], ['hiphop', 'Hip-Hop / Rap', /hip[- ]?hop|\brap\b/i, 'hip hop hits'], ['rnb', 'R&B / Soul', /r&b|\bsoul\b/i, 'r&b soul hits'],
  ['rock', 'Rock', /\brock\b/i, 'rock hits'], ['alt', 'Alternative', /alternative/i, 'alternative hits'], ['electronic', 'Electronic', /electronic|\bedm\b/i, 'electronic hits'], ['dance', 'Dance', /\bdance\b/i, 'dance hits'],
  ['country', 'Country', /country/i, 'country hits'], ['latin', 'Latin', /latin|latino|reggaet/i, 'latin hits'], ['kpop', 'K-Pop', /k-?pop/i, 'k-pop hits'], ['jpop', 'J-Pop', /j-?pop/i, 'j-pop hits'],
  ['jazz', 'Jazz', /\bjazz\b/i, 'jazz classics'], ['classical', 'Classical', /classical/i, 'classical music'], ['metal', 'Metal', /\bmetal\b/i, 'metal hits'], ['reggae', 'Reggae', /\breggae\b/i, 'reggae hits'],
  ['singer', 'Singer / Songwriter', /singer|songwriter|acoustic/i, 'singer songwriter acoustic'], ['soundtrack', 'Soundtracks', /soundtrack/i, 'movie soundtrack songs'], ['blues', 'Blues', /\bblues\b/i, 'blues classics'], ['gospel', 'Christian & Gospel', /gospel|christian/i, 'christian gospel hits']];

let chartsPage = { at: 0, lists: null };
/** The charts page's playlists: [{ title, playlistId }], the overall chart first. */
async function chartPlaylists() {
  if (chartsPage.lists && Date.now() - chartsPage.at < 60 * 60_000) return chartsPage.lists;
  const res = await ytm('browse', { browseId: 'FEmusic_charts', formData: { selectedValues: [COUNTRY] } });
  const sections = nav(res, ['contents', 'singleColumnBrowseResultsRenderer', 'tabs', 0, 'tabRenderer', 'content', 'sectionListRenderer', 'contents']) || [];
  const lists = [];
  for (const s of sections.slice(1)) for (const it of nav(s, ['musicCarouselShelfRenderer', 'contents']) || []) {
    const r = it.musicTwoRowItemRenderer; const browseId = nav(r, ['title', 'runs', 0, 'navigationEndpoint', 'browseEndpoint', 'browseId']);
    if (browseId?.startsWith('VL')) lists.push({ title: String(nav(r, ['title', 'runs', 0, 'text']) || ''), playlistId: browseId.slice(2) });
  }
  chartsPage = { at: Date.now(), lists };
  return lists;
}
/** A playlist's first page of songs (mixins/playlists.py get_playlist, without continuations). */
async function playlistSongs(playlistId) {
  const res = await ytm('browse', { browseId: 'VL' + playlistId });
  const rows = nav(res, ['contents', 'twoColumnBrowseResultsRenderer', 'secondaryContents', 'sectionListRenderer', 'contents', 0, 'musicPlaylistShelfRenderer', 'contents'])
    || nav(res, ['contents', 'singleColumnBrowseResultsRenderer', 'tabs', 0, 'tabRenderer', 'content', 'sectionListRenderer', 'contents', 0, 'musicPlaylistShelfRenderer', 'contents']) || [];
  return uniq(rows.map((r) => playlistSong(r[MRLIR])));
}
const chartCache = new Map();
async function chart(key) {
  const g = GENRES.find((x) => x[0] === key); if (!g) throw notFound('Unknown category');
  const hit = chartCache.get(key); if (hit && Date.now() - hit.at < 30 * 60_000) return hit.tracks;
  let tracks = [];
  try {
    const lists = await chartPlaylists();
    const pick = g[2] ? lists.find((l) => g[2].test(l.title)) : lists[0];
    if (pick) tracks = await playlistSongs(pick.playlistId);
  } catch (e) { if (e?.code === 'rate_limited') throw e; }   // a changed charts page falls back to search below
  if (!tracks.length) tracks = await searchSongs(g[3]);
  tracks = tracks.slice(0, 30).map(remember);
  chartCache.set(key, { at: Date.now(), tracks });
  return tracks;
}
/** A song by id (mixins/browsing.py get_song → the player endpoint's videoDetails). */
async function trackInfo(id) {
  if (known.has(id)) return known.get(id);
  const days = Math.floor(Date.now() / 86_400_000);
  const res = await ytm('player', { videoId: id, playbackContext: { contentPlaybackContext: { signatureTimestamp: days - 1 } } });
  const d = res?.videoDetails;
  if (!d || d.videoId !== id || res?.playabilityStatus?.status === 'ERROR') throw new ApiError(404, 'YouTube Music has no song with that id.', 'music_unavailable');
  const t = songView({ id, title: d.title, artists: [{ name: String(d.author || '').replace(/ - Topic$/, ''), id: d.channelId }], thumbs: nav(d, ['thumbnail', 'thumbnails']), duration: Number(d.lengthSeconds) || 0 });
  if (!t) throw new ApiError(404, 'YouTube Music has no song with that id.', 'music_unavailable');
  return remember(t);
}

/* ------------------------------------------------------------ "Listening to" */
const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };
/** The player reports which song, how long it lasts and where it is; title, artist, artwork and link are YouTube Music's, via the server. */
async function cleanListening(body) {
  const id = String(body?.track?.id ?? ''); if (!TRACK_ID.test(id)) throw bad('Unknown track');
  needEnabled();
  const t = await trackInfo(id);
  const duration = clamp(body.duration, 1000, 6 * 3600_000, t.duration || 210_000);
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
  r.get('/music/charts', h(async (req, res) => { needEnabled(); res.json({ genres: GENRES.map(([key, name]) => ({ key, name })) }); }));
  r.get('/music/charts/:key', limit('musicchart', 40, 60_000, (req) => req.user.id), h(async (req, res) => {
    needEnabled();
    res.json({ key: String(req.params.key), tracks: await chart(String(req.params.key)) });
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
/** Called every so often: statuses of songs that must have finished are removed. */
export function expireListening() {
  const now = Date.now();
  for (const u of Object.values(db.users)) if (u.listening && u.listening.endsAt < now) setListening(u, null);
}
