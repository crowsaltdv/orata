// A stand-in for the youtubei.js library (YouTube.js) in the self-tests: the same calls Orata makes (search, getInfo, getComments, getChannel, getSearchSuggestions),
// canned answers shaped like the real library's, and a log of what it was asked (FAKE_WATCH_LOG). The server loads it through WATCH_CLIENT, so the tests need no internet.
import fs from 'node:fs';

const log = (o) => { if (process.env.FAKE_WATCH_LOG) fs.appendFileSync(process.env.FAKE_WATCH_LOG, `${JSON.stringify(o)}\n`); };
const text = (s) => ({ text: s, toString: () => s });
const CHAN = 'UCtestchannel00000000001';        // "UC" + 22 characters, like a real channel id
const GONE_CHAN = 'UCgonegonegonegonegone00';
const vid = (n) => `v${String(n).padStart(10, '0')}`;   // 11 characters, like a real video id
const author = (id, name, avatar = 'https://yt3.ggpht.com/test=s88-c-k') => ({ id, name, thumbnails: [{ url: avatar }] });
const video = (n, title, extra = {}) => ({ type: 'Video', id: vid(n), title: text(title), author: author(CHAN, 'Test Channel'), short_view_count: text('1.2M views'), published: text('2 days ago'), duration: { text: '3:33', seconds: 213 }, is_live: false, ...extra });
const lockup = (n, title, { channel = 'Related Channel', badges = [{ text: '12:34' }], playlist = false } = {}) => ({
  type: 'LockupView', content_type: playlist ? 'PLAYLIST' : 'VIDEO', content_id: playlist ? `PL${vid(n)}` : vid(n),
  metadata: { title: text(title),
    metadata: { metadata_rows: [...(channel ? [{ metadata_parts: [{ text: text(channel) }] }] : []), { metadata_parts: [{ text: text('55K views') }, { text: text('3 weeks ago') }] }] },
    image: { avatar: { image: [{ url: 'https://yt3.ggpht.com/related=s68' }] }, renderer_context: { command_context: { on_tap: { payload: { browseId: CHAN } } } } } },
  content_image: { overlays: [{ badges }] },
});

const salt = (q) => ([...q].reduce((a, c) => a + c.charCodeAt(0) * 7, 0) % 997) * 100;   // different searches find different videos
/** A page of search results: ten videos, the last of the page before repeated at the top, and things Orata must leave out. */
function searchPage(q, f, p) {
  const results = [];
  for (let i = 0; i < 10; i++) { const n = p * 9 + i + 1; results.push(video(salt(q) + n, `${q} result ${n}${f.features ? ' (live)' : ''}`, f.features ? { is_live: true, short_view_count: text('8.1K watching'), duration: { seconds: 0 } } : {})); }
  if (p === 0 && q.startsWith('agecheck')) results.splice(3, 0, video(777, 'An age-restricted one', { id: 'agerestrict' }));
  if (p === 0) results.push({ type: 'Shelf' }, { type: 'ReelShelf' }, video(900, ''), video(901, 'Broken id', { id: 'short' }), video(902, 'Stranger avatar', { author: author(CHAN, 'Stranger', 'https://evil.example/pixel.png') }));
  return { results, has_continuation: p < 2, getContinuation: async () => { log({ op: 'continue', q, page: p + 1 }); return searchPage(q, f, p + 1); } };
}
const commentPage = (id, p) => ({
  header: { comments_count: text('2.4M') },
  contents: Array.from({ length: 8 }, (_, i) => ({ comment: { comment_id: `c-${p}-${i}`, content: text(`comment ${p}.${i}\nsecond line`), author: { id: i === 0 ? CHAN : 'not-a-channel-id', name: `@person${i}`, thumbnails: [{ url: 'https://yt3.ggpht.com/c=s88' }] },
    published_time: '2 days ago', like_count: '1.5K', reply_count: i === 1 ? '3' : '0', is_pinned: p === 0 && i === 0, is_hearted: i === 2, author_is_channel_owner: i === 0 } })),
  has_continuation: p < 1, getContinuation: async () => { log({ op: 'continue-comments', id, page: p + 1 }); return commentPage(id, p + 1); },
});
const uploads = (p) => ({ videos: Array.from({ length: 12 }, (_, i) => lockup(500 + p * 12 + i, `Upload ${p * 12 + i}`, { channel: null })), has_continuation: p < 1, getContinuation: async () => uploads(p + 1) });

class Innertube {
  static async create() { log({ op: 'create' }); return new Innertube(); }
  async search(q, f = {}) {
    log({ op: 'search', q, f });
    if (q === 'explode') throw new Error('network exploded');
    if (f.type === 'channel') return { results: [{ type: 'Channel', id: CHAN, author: author(CHAN, 'Test Channel'), subscriber_count: text('@testchannel'), video_count: text('1.2M subscribers'), description_snippet: text('N/A') }, { type: 'Channel', id: 'nope', author: author('nope', 'Not a real channel') }] };
    return searchPage(q, f, 0);
  }
  async getSearchSuggestions(q) { log({ op: 'suggest', q }); return [`${q} one`, '', `${q} two`]; }
  async getInfo(id) {
    log({ op: 'info', id });
    if (id === 'gone0000000') throw new Error('This video is unavailable');
    if (id === 'boom0000000') throw new Error('network exploded');
    const playability_status = id === 'agerestrict' ? { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm your age', embeddable: false }
      : id === 'embedoffxxx' ? { status: 'OK', embeddable: false }
        : id === 'botcheckxxx' ? { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you’re not a bot', embeddable: false }
          : id === 'bogusunplay' ? { status: 'UNPLAYABLE', reason: 'Video unavailable', embeddable: false }   // (what YouTube says about plenty of normal videos to a server)
            : { status: 'OK', embeddable: true };
    return {
      playability_status,
      basic_info: { title: `Video ${id}`, channel_id: CHAN, author: 'Test Channel', view_count: 1234567, like_count: 4321, duration: 213, is_live: false, short_description: 'short' },
      primary_info: { published: text('Oct 25, 2009'), relative_date: text('17 years ago'), view_count: { view_count: text('1,234,567 views') } },
      secondary_info: { owner: { author: author(CHAN, 'Test Channel'), subscriber_count: text('4.55M subscribers') }, description: text('line one\n\n\n\nline two https://example.com/page') },
      watch_next_feed: [lockup(1, 'Related one'), lockup(2, 'Related playlist', { playlist: true }), video(3, 'Related video'), lockup(4, 'Related live', { badges: [{ text: 'LIVE' }] }), video(Number(id.slice(1)) || 7, 'This very video')],
    };
  }
  async getComments(id) { log({ op: 'comments', id }); return commentPage(id, 0); }
  async getChannel(id) {
    log({ op: 'channel', id });
    if (id === GONE_CHAN) throw new Error('This channel does not exist');
    return {
      metadata: { title: 'Test Channel', description: 'About this channel', avatar: [{ url: 'https://yt3.googleusercontent.com/avatar=s900' }] },
      header: { page_title: 'Test Channel', content: { metadata: { metadata_rows: [{ metadata_parts: [{ text: text('@testchannel') }] }, { metadata_parts: [{ text: text('4.55M subscribers') }, { text: text('437 videos') }] }] }, banner: { image: [{ url: 'https://yt3.googleusercontent.com/banner=w2560' }] } } },
      getVideos: async () => { log({ op: 'channel-videos', id }); return uploads(0); },
    };
  }
}
class UniversalCache {}
const Log = { setLevel() {}, Level: { NONE: 0 } };
export { Innertube, UniversalCache, Log };
