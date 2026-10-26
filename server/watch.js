// Orata — Watch: videos from YouTube, inside Orata. No API key and no login needed.
//
// The catalogue comes from YouTube.js (https://github.com/LuanRT/YouTube.js), a JavaScript client for YouTube's own web API: search, a video's details, related videos,
// comments and channels. It only finds things. The video itself plays in YouTube's embedded player in the browser (see public/js/watch.js), so Orata never touches
// the video stream. Results are cached, and Orata never sends more than WATCH_API_PER_MIN (default 60) requests a minute to YouTube however many people browse.
// WATCH=off turns the feature off for everybody; WATCH_CLIENT is a module standing in for youtubei.js (the self-tests use one, so they need no internet).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ENV, ROOT, ApiError, bad, notFound } from './core.js';

const PER_MIN = Math.max(1, Number(ENV.WATCH_API_PER_MIN) || 60);
/** Watch is on by default; WATCH=off turns it off for everybody. */
export const watchEnabled = () => !/^(off|false|0|no)$/i.test(String(ENV.WATCH || '').trim());
const needEnabled = () => { if (!watchEnabled()) throw new ApiError(503, 'Watch is turned off on this server.', 'watch_not_configured'); };

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const IMG_HOST = /(^|\.)(ytimg\.com|ggpht\.com|googleusercontent\.com)$/i;
const img = (u) => { try { const x = new URL(String(u).replace(/^\/\//, 'https://')); return x.protocol === 'https:' && IMG_HOST.test(x.hostname) ? x.href : null; } catch { return null; } };
const clamp = (v, lo, hi, d) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
/** YouTube.js text objects, strings and numbers → one tidy line of text. */
const str = (v, max = 200) => {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : typeof v.text === 'string' ? v.text : typeof v === 'number' ? String(v) : typeof v.toString === 'function' && v.toString !== Object.prototype.toString ? v.toString() : '';
  return s.replace(/\s+/g, ' ').trim().slice(0, max);
};
/** Like str, but keeps line breaks (a description). */
const block = (v, max) => String(typeof v === 'string' ? v : v?.text ?? '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);

/* ------------------------------------------------------------ YouTube.js */
let session = null;   // the YouTube.js session, created on first use (and again after a failure)
async function client() {
  session ||= (async () => {
    let lib;
    try { lib = ENV.WATCH_CLIENT ? await import(pathToFileURL(path.resolve(ROOT, ENV.WATCH_CLIENT)).href) : await import('youtubei.js'); }
    catch (e) { throw new ApiError(503, e?.code === 'ERR_MODULE_NOT_FOUND' ? 'Watch needs the youtubei.js library on the server. Run: npm install' : 'Watch could not start on this server.', 'watch_not_configured'); }
    lib.Log?.setLevel?.(lib.Log.Level.NONE);   // its parser logs a warning whenever YouTube changes how a page is laid out; those are not problems for Orata
    return lib.Innertube.create({ cache: new lib.UniversalCache(false), generate_session_locally: true, retrieve_player: false });
  })().catch((e) => { session = null; throw e; });
  return session;
}
const calls = [];   // when the last requests to YouTube were made
function takeSlot() {
  const now = Date.now(); while (calls.length && now - calls[0] > 60_000) calls.shift();
  if (calls.length >= PER_MIN) throw new ApiError(429, 'Watch is busy right now. Try again in a few seconds.', 'rate_limited');
  calls.push(now);
}
const GONE = /unavailable|not available|private|removed|does not exist|not found|terminated|no longer|deleted/i;
/** Runs `fn(youtube)` against YouTube with a time limit. `missing`: what to say (as a 404) when YouTube says the thing is gone. */
async function upstream(fn, missing) {
  const yt = await client(); takeSlot();
  let timer;
  try { return await Promise.race([fn(yt), new Promise((_, no) => { timer = setTimeout(() => no(new Error('YouTube took too long')), 25_000); })]); }
  catch (e) {
    if (e instanceof ApiError) throw e;
    if (missing && GONE.test(String(e?.message))) throw new ApiError(404, missing, 'watch_unavailable');
    throw new ApiError(502, 'Videos couldn’t be loaded right now. Try again in a moment.', 'watch_upstream');
  } finally { clearTimeout(timer); }
}

/* ------------------------------------------------------------ what the app shows */
const thumb = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
const clockSeconds = (clock) => { const p = String(clock || '').split(':').map(Number); return p.length && p.length <= 3 && p.every(Number.isFinite) ? p.reduce((a, n) => a * 60 + n, 0) : 0; };   // "1:02:03" → 3723
const avatarOf = (a) => img((Array.isArray(a) ? a : a?.thumbnails)?.[0]?.url);
const channelOf = (id, name, avatar) => (name || CHANNEL_ID.test(String(id)) ? { id: CHANNEL_ID.test(String(id)) ? String(id) : null, name: str(name, 100) || 'Unknown channel', avatar } : null);
/** One search result, related video or channel upload → a card, or null for anything that isn't a plain video (shorts, playlists, shelves ...). */
function card(n) {
  if (!n || typeof n !== 'object') return null;
  let id; let title; let channel = null; let views = ''; let published = ''; let duration = ''; let live = false;
  if (n.type === 'Video' || n.type === 'CompactVideo' || n.type === 'GridVideo') {
    id = n.id ?? n.video_id; title = str(n.title);
    channel = n.author ? channelOf(n.author.id, n.author.name, avatarOf(n.author)) : null;
    views = str(n.short_view_count) || str(n.view_count); published = str(n.published, 40); duration = str(n.duration, 12); live = n.is_live === true;
  } else if (n.type === 'LockupView' && n.content_type === 'VIDEO') {
    id = n.content_id; title = str(n.metadata?.title);
    const rows = (n.metadata?.metadata?.metadata_rows || []).map((r) => (r.metadata_parts || []).map((p) => str(p.text, 80)).filter(Boolean)).filter((r) => r.length);
    const [who, ...rest] = rows.length > 1 ? rows : [[], ...rows];   // an upload list has no channel row: it is all views and date
    views = rest.flat()[0] || ''; published = rest.flat()[1] || '';
    const who0 = who[0]; const avatar = img(n.metadata?.image?.avatar?.image?.[0]?.url);
    channel = who0 ? channelOf(n.metadata?.image?.renderer_context?.command_context?.on_tap?.payload?.browseId, who0, avatar) : null;
    const badges = (n.content_image?.overlays || []).flatMap((o) => o.badges || []).map((b) => str(b.text, 12));
    duration = badges.find((b) => /^(\d+:)?\d{1,2}:\d{2}$/.test(b)) || ''; live = badges.some((b) => /^live$/i.test(b));
  } else return null;
  if (!VIDEO_ID.test(String(id)) || !title) return null;
  if (/watching/i.test(views)) live = true;
  return { id: String(id), title, channel, views, published, duration: live ? '' : duration, seconds: live ? 0 : clockSeconds(duration), live, thumbnail: thumb(id) };
}
const known = new Map();   // id → card: every video Orata has shown, so "watch this together" can name a video without asking YouTube again
const remember = (c) => { known.delete(c.id); known.set(c.id, c); if (known.size > 6000) known.delete(known.keys().next().value); return c; };
const cardsOf = (nodes) => (Array.isArray(nodes) ? nodes : []).map(card).filter(Boolean).map(remember);
const channelCard = (n) => {
  if (!n || n.type !== 'Channel') return null;
  const id = String(n.id ?? n.author?.id ?? ''); if (!CHANNEL_ID.test(id)) return null;
  const texts = [n.subscriber_count, n.video_count, n.short_byline, n.long_byline].map((x) => str(x, 80)).filter(Boolean);   // YouTube shuffles which one holds the handle and which the subscribers
  return { id, name: str(n.author?.name, 100) || 'Unknown channel', avatar: avatarOf(n.author), handle: texts.find((x) => x.startsWith('@')) || null, subscribers: texts.find((x) => /subscribers?$/i.test(x)) || null, description: str(n.description_snippet, 160).replace(/^n\/a$/i, '') };
};

/* ------------------------------------------------------------ lists that grow a page at a time */
const cached = new Map();
async function memo(key, ttl, load) {
  const hit = cached.get(key); if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await load();
  if (cached.size > 300) cached.delete(cached.keys().next().value);
  cached.set(key, { at: Date.now(), value });
  return value;
}
const lists = new Map();   // key → { items, seen, feed, more, pages, at, busy }: what has been fetched of a search, chip, channel or comment list so far
/** The list `key`, grown until it holds `want` items (or runs out). `start(youtube)` gets the first page, `pick(page)` the items on it; later pages come from the page's own getContinuation(). */
async function grow(key, ttl, want, start, pick) {
  let L = lists.get(key);
  if (!L || Date.now() - L.at > ttl) { if (lists.size > 150) lists.delete(lists.keys().next().value); L = { items: [], seen: new Set(), feed: null, more: true, pages: 0, at: Date.now(), busy: null }; lists.set(key, L); }
  while (L.items.length < want && L.more) {
    L.busy ||= (async () => {
      const feed = L.feed ? await upstream(() => L.feed.getContinuation()) : await upstream(start);
      L.feed = feed; L.pages++;
      for (const it of pick(feed)) if (!L.seen.has(it.id)) { L.seen.add(it.id); L.items.push(it); }
      L.more = feed.has_continuation === true && L.pages < 30;
    })().finally(() => { L.busy = null; });
    await L.busy;
  }
  return L;
}
/** `?offset=&limit=` of a growing list → that page and whether there is more after it. The next page is fetched while this one is looked at. */
async function pageOf(req, load, size) {
  const offset = clamp(req.query.offset, 0, 3000, 0); const n = clamp(req.query.limit, 1, 60, size);
  const L = await load(offset + n);
  if (L.more && L.items.length < offset + 2 * n) load(offset + 2 * n).catch(() => {});
  return { items: L.items.slice(offset, offset + n), hasMore: L.items.length > offset + n || L.more };
}

/* ------------------------------------------------------------ home, search, suggestions */
/** The categories on the home page. YouTube hands a signed-out visitor no home feed, so each one is a search for what is popular right now. */
const WEEK = { upload_date: 'week', sort_by: 'view_count' };
const CHIPS = [
  { key: 'music', name: 'Music', q: 'music video', f: WEEK }, { key: 'gaming', name: 'Gaming', q: 'gaming', f: WEEK },
  { key: 'live', name: 'Live', q: 'live', f: { features: ['live'], sort_by: 'view_count' } }, { key: 'news', name: 'News', q: 'news', f: { upload_date: 'today' } },
  { key: 'movies', name: 'Movies & TV', q: 'movie trailer', f: { upload_date: 'month', sort_by: 'view_count' } }, { key: 'sports', name: 'Sports', q: 'sports highlights', f: WEEK },
  { key: 'comedy', name: 'Comedy', q: 'comedy', f: WEEK }, { key: 'learning', name: 'Learning', q: 'how it works explained', f: { upload_date: 'month', sort_by: 'view_count' } },
];
const chipList = (c, want) => grow(`h:${c.key}`, 30 * 60_000, want, (yt) => yt.search(c.q, { ...c.f, type: 'video' }), (feed) => cardsOf(feed.results));
/** "All": the first page of each category, taken in turns, so the home page is a mix. */
const mixed = () => memo('h:all', 30 * 60_000, async () => {
  const each = await Promise.all(CHIPS.filter((c) => c.key !== 'live').map((c) => chipList(c, 12).then((L) => L.items.slice(0, 12)).catch((e) => { if (e instanceof ApiError && e.code === 'watch_not_configured') throw e; return []; })));
  const out = []; const seen = new Set();
  for (let i = 0; i < 12; i++) for (const list of each) { const v = list[i]; if (v && !seen.has(v.id)) { seen.add(v.id); out.push(v); } }
  if (!out.length) throw new ApiError(502, 'Videos couldn’t be loaded right now. Try again in a moment.', 'watch_upstream');
  return { items: out, more: false };
});
const searchList = (q, want) => grow(`s:${q.toLowerCase()}`, 10 * 60_000, want, (yt) => yt.search(q, { type: 'video' }), (feed) => cardsOf(feed.results));
const searchChannels = (q) => memo(`sc:${q.toLowerCase()}`, 10 * 60_000, async () => ((await upstream((yt) => yt.search(q, { type: 'channel' }))).results || []).map(channelCard).filter(Boolean).slice(0, 1));   // just the best match, like YouTube's own results
const suggest = (q) => memo(`sg:${q.toLowerCase()}`, 10 * 60_000, async () => (await upstream((yt) => yt.getSearchSuggestions(q))).map((s) => str(s, 100)).filter(Boolean).slice(0, 10));

/* ------------------------------------------------------------ a video, its comments, a channel */
/** What the watch parties need to know about a video: its title, channel, length and picture, from what Orata already showed or else from YouTube. Throws when it isn't there. */
export async function videoMeta(id) {
  needEnabled();
  if (!VIDEO_ID.test(String(id))) throw bad('That isn’t a video');
  const hit = known.get(id); if (hit) return hit;
  const { video: v } = await video(id);
  return remember({ id, title: v.title, channel: v.channel, views: v.viewsText || '', published: v.published, duration: '', seconds: v.live ? 0 : v.duration, live: v.live, thumbnail: v.thumbnail });
}
async function video(id) {
  return memo(`v:${id}`, 10 * 60_000, async () => {
    const info = await upstream((yt) => yt.getInfo(id), 'That video isn’t available.');
    const b = info.basic_info || {}; const p = info.primary_info || {}; const owner = info.secondary_info?.owner;
    const title = str(b.title ?? p.title); if (!title) throw new ApiError(404, 'That video isn’t available.', 'watch_unavailable');
    const channelId = String(b.channel_id || owner?.author?.id || '');
    return {
      video: {
        id, title, description: block(info.secondary_info?.description ?? b.short_description, 6000),
        views: Number.isFinite(Number(b.view_count)) ? Number(b.view_count) : null, viewsText: str(p.view_count?.view_count, 60),
        likes: Number.isFinite(Number(b.like_count)) ? Number(b.like_count) : null,
        published: str(p.published, 40), ago: str(p.relative_date, 40), duration: Math.max(0, Math.round(Number(b.duration) || 0)), live: b.is_live === true,
        channel: { id: CHANNEL_ID.test(channelId) ? channelId : null, name: str(b.author ?? owner?.author?.name, 100) || 'Unknown channel', avatar: avatarOf(owner?.author), subscribers: str(owner?.subscriber_count, 60) || null },
        thumbnail: thumb(id),
      },
      related: cardsOf(info.watch_next_feed).filter((c) => c.id !== id).slice(0, 30),
    };
  });
}
const comments = (id, want) => grow(`c:${id}`, 10 * 60_000, want, (yt) => yt.getComments(id), (feed) => (feed.contents || []).map((t) => {
  const c = t?.comment; const cid = str(c?.comment_id, 80); if (!cid) return null;
  return { id: cid, text: block(c.content, 2000), author: { name: str(c.author?.name, 100) || 'Someone', avatar: img(c.author?.thumbnails?.[0]?.url) || img(c.creator_thumbnail_url), channelId: CHANNEL_ID.test(String(c.author?.id)) ? String(c.author.id) : null },
    published: str(c.published_time, 40), likes: str(c.like_count, 12) || '0', replies: str(c.reply_count, 12) || '0', pinned: c.is_pinned === true, hearted: c.is_hearted === true, owner: c.author_is_channel_owner === true };
}).filter(Boolean));
const channelObj = (id) => memo(`co:${id}`, 10 * 60_000, () => upstream((yt) => yt.getChannel(id), 'That channel isn’t available.'));
async function channel(id) {
  const c = await channelObj(id); const m = c.metadata || {};
  const parts = (c.header?.content?.metadata?.metadata_rows || []).flatMap((r) => (r.metadata_parts || []).map((p) => str(p.text, 80))).filter(Boolean);
  const name = str(m.title ?? c.header?.page_title, 100); if (!name) throw new ApiError(404, 'That channel isn’t available.', 'watch_unavailable');
  return { id, name, avatar: img(m.avatar?.[0]?.url), banner: img(c.header?.content?.banner?.image?.[0]?.url), description: block(m.description, 1000),
    handle: parts.find((x) => x.startsWith('@')) || null, subscribers: parts.find((x) => /subscribers?$/i.test(x)) || null, videoCount: parts.find((x) => /videos?$/i.test(x)) || null };
}
const channelVideos = (id, want) => grow(`cv:${id}`, 10 * 60_000, want, async () => (await channelObj(id)).getVideos(), (feed) => cardsOf(feed.videos));

/* ------------------------------------------------------------ routes (under /api, for signed-in people) */
/** Answers with `body`, and lets the browser keep it for `seconds` (a page that was just looked at then costs nothing to open again, and nothing from this server). */
const reply = (res, seconds, body) => res.set('Cache-Control', `private, max-age=${seconds}`).json(body);
export function mountWatch(r, { h, limit }) {
  const lim = (name, n) => limit(name, n, 60_000, (req) => req.user.id);
  r.get('/watch/home', lim('watchhome', 60), h(async (req, res) => {
    needEnabled();
    const key = String(req.query.chip || 'all'); const chip = CHIPS.find((c) => c.key === key);
    if (key !== 'all' && !chip) throw notFound('Unknown category');
    const page = await pageOf(req, chip ? (want) => chipList(chip, want) : mixed, 30);
    reply(res, 300, { chips: [{ key: 'all', name: 'All' }, ...CHIPS.map(({ key: k, name }) => ({ key: k, name }))], key, videos: page.items, hasMore: page.hasMore });
  }));
  r.get('/watch/search', lim('watchsearch', 60), h(async (req, res) => {
    needEnabled();
    const q = String(req.query.q || '').trim().slice(0, 100); if (!q) throw bad('Type something to search for');
    const first = !Number(req.query.offset);
    const [page, channels] = await Promise.all([pageOf(req, (want) => searchList(q, want), 24), first ? searchChannels(q).catch(() => []) : []]);   // channels are a bonus: a hiccup there never hides the videos
    reply(res, 300, { q, videos: page.items, channels, hasMore: page.hasMore });
  }));
  r.get('/watch/suggest', lim('watchsuggest', 120), h(async (req, res) => {
    needEnabled();
    const q = String(req.query.q || '').trim().slice(0, 100);
    const suggestions = q ? await suggest(q).catch(() => null) : [];
    if (suggestions === null) res.json({ suggestions: [] }); else reply(res, 600, { suggestions });   // (a hiccup isn't kept)
  }));
  r.get('/watch/videos/:id', lim('watchvideo', 60), h(async (req, res) => {
    needEnabled();
    const id = String(req.params.id); if (!VIDEO_ID.test(id)) throw bad('That isn’t a video');
    reply(res, 300, await video(id));
  }));
  r.get('/watch/videos/:id/comments', lim('watchcomments', 60), h(async (req, res) => {
    needEnabled();
    const id = String(req.params.id); if (!VIDEO_ID.test(id)) throw bad('That isn’t a video');
    const page = await pageOf(req, (want) => comments(id, want), 20);
    reply(res, 300, { comments: page.items, hasMore: page.hasMore });
  }));
  r.get('/watch/channels/:id', lim('watchchannel', 60), h(async (req, res) => {
    needEnabled();
    const id = String(req.params.id); if (!CHANNEL_ID.test(id)) throw bad('That isn’t a channel');
    reply(res, 300, { channel: await channel(id) });
  }));
  r.get('/watch/channels/:id/videos', lim('watchchannel', 60), h(async (req, res) => {
    needEnabled();
    const id = String(req.params.id); if (!CHANNEL_ID.test(id)) throw bad('That isn’t a channel');
    const page = await pageOf(req, (want) => channelVideos(id, want), 24);
    reply(res, 300, { videos: page.items, hasMore: page.hasMore });
  }));
}
