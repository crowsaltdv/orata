// Orata — Watch (/watch): videos in a layout like YouTube's. A search bar on top, categories and a grid of videos on the home page, a list of results for a search,
// a channel's page, and on a video's page the player with its title, channel, description and comments, and related videos beside it.
// The server finds the videos (see server/watch.js); the browser plays one in YouTube's embedded player. Nothing here sends you to another website, except links in a description.
import { html, useState, useEffect, useRef, cx, copyText } from '/js/lib.js';
import { state, set, useSel, go, toast } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { Spinner } from '/js/ui.js';
import { api } from '/js/api.js';
import { t } from '/js/i18n.js';
import { music } from '/js/music.js';
import { PartyPills } from '/js/party.js';

export const openWatch = () => go('/watch');
const openVideo = (id) => go(`/watch?v=${id}`);
const openChannel = (id) => go(`/watch/channel/${id}`);
const search = (q) => go(`/watch?q=${encodeURIComponent(q.trim())}`);
const fail = (e) => toast(e?.message || t('Something went wrong.'), 'error');
const compact = (n) => (Number.isFinite(n) ? new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n) : '');
const plainClick = (e) => !(e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey);   // a click that should stay inside Orata (the others open the link in a new tab)
const nav = (fn) => (e) => { if (plainClick(e)) { e.preventDefault(); e.stopPropagation(); fn(); } else e.stopPropagation(); };

/* ------------------------------------------------------------------ lists that load a page at a time (and are remembered, so Back is instant) */
const feeds = new Map();   // url → { items, hasMore, extra }
/** `url` gives the first page; `?offset=` asks for the next. Returns { items, hasMore, loading, error, more, extra }. */
function useFeed(url, pick) {
  const mk = () => feeds.get(url) || { items: [], hasMore: true, extra: null, started: false };
  const [feed, setFeed] = useState(mk); const [loading, setLoading] = useState(false); const [error, setError] = useState(null);
  const busy = useRef(false); const live = useRef(url);
  const load = (from) => {
    if (busy.current) return; busy.current = true; setLoading(true); setError(null);
    api.get(`${url}${url.includes('?') ? '&' : '?'}offset=${from.items.length}&limit=24`).then((r) => {
      if (live.current !== url) return;
      const seen = new Set(from.items.map((v) => v.id)); const items = [...from.items, ...pick(r).filter((v) => !seen.has(v.id))];
      const next = { items, hasMore: !!r.hasMore, extra: from.extra || r, started: true };
      feeds.set(url, next); if (feeds.size > 30) feeds.delete(feeds.keys().next().value); setFeed(next);
    }).catch((e) => { if (live.current === url) setError(e.message || t('Couldn’t load this.')); }).finally(() => { if (live.current === url) { busy.current = false; setLoading(false); } });
  };
  useEffect(() => { live.current = url; busy.current = false; setError(null); const f = mk(); setFeed(f); setLoading(false); if (!f.started) load(f); return () => { live.current = null; }; }, [url]);
  return { items: feed.items, hasMore: feed.hasMore, extra: feed.extra, loading, error, started: feed.started, more: () => { if (feed.hasMore && !loading) load(feed); } };
}
/** Asks for the next page when the bottom of the list scrolls into view. */
function Sentinel({ feed }) {
  const el = useRef(null);
  useEffect(() => {
    if (!el.current || !feed.hasMore || feed.error) return undefined;
    const io = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) feed.more(); }, { rootMargin: '600px' });
    io.observe(el.current); return () => io.disconnect();
  }, [feed.hasMore, feed.loading, feed.items.length, feed.error]);
  return html`<div class="wt-end" ref=${el}>${feed.loading ? html`<${Spinner} />` : feed.error ? html`<p class="wt-err">${feed.error} <button type="button" class="link-btn" onClick=${feed.more}>${t('Try again')}</button></p>` : null}</div>`;
}

/* ------------------------------------------------------------------ small pieces */
function Thumb({ v }) {
  return html`<span class="wt-thumb"><img src=${v.thumbnail} alt="" loading="lazy" referrerpolicy="no-referrer" draggable=${false} />
    ${v.live ? html`<i class="wt-badge live">${t('LIVE')}</i>` : v.duration ? html`<i class="wt-badge">${v.duration}</i>` : null}</span>`;
}
function ChannelAvatar({ c, size = 36 }) {
  return html`<span class="wt-av" style=${{ width: `${size}px`, height: `${size}px` }}>${c?.avatar ? html`<img src=${c.avatar} alt="" loading="lazy" referrerpolicy="no-referrer" draggable=${false} />` : html`<${Icon} name="user" size=${Math.round(size * 0.55)} />`}</span>`;
}
const ChannelName = ({ c }) => (c?.id ? html`<a class="wt-chan" href=${`/watch/channel/${c.id}`} onClick=${nav(() => openChannel(c.id))}>${c.name}</a>` : html`<span class="wt-chan">${c?.name || ''}</span>`);
const stats = (v) => [v.views, v.published].filter(Boolean).join(' • ');

/** A video in a grid: the thumbnail, then the channel's picture beside the title, the channel and how many have watched. */
function VideoCard({ v, bare }) {
  return html`<article class=${cx('wt-card', bare && 'bare')}>
    <a class="wt-link" href=${`/watch?v=${v.id}`} onClick=${nav(() => openVideo(v.id))} aria-label=${v.title}><${Thumb} v=${v} /></a>
    <div class="wt-info">${bare ? null : html`<a href=${v.channel?.id ? `/watch/channel/${v.channel.id}` : undefined} onClick=${v.channel?.id ? nav(() => openChannel(v.channel.id)) : null} tabindex="-1"><${ChannelAvatar} c=${v.channel} /></a>`}
      <div class="wt-text"><a class="wt-title" href=${`/watch?v=${v.id}`} onClick=${nav(() => openVideo(v.id))} title=${v.title}>${v.title}</a>
        ${bare ? null : html`<${ChannelName} c=${v.channel} />`}<small>${stats(v)}</small></div></div>
  </article>`;
}
/** A video in a list: a big thumbnail on the left and everything else beside it (search results, a channel's videos in a list). */
function VideoRow({ v, small }) {
  return html`<article class=${cx('wt-row', small && 'small')}>
    <a class="wt-link" href=${`/watch?v=${v.id}`} onClick=${nav(() => openVideo(v.id))} aria-label=${v.title}><${Thumb} v=${v} /></a>
    <div class="wt-text"><a class="wt-title" href=${`/watch?v=${v.id}`} onClick=${nav(() => openVideo(v.id))} title=${v.title}>${v.title}</a>
      ${small ? html`<${ChannelName} c=${v.channel} /><small>${stats(v)}</small>`
        : html`<small>${stats(v)}</small><span class="wt-by"><${ChannelAvatar} c=${v.channel} size=${24} /><${ChannelName} c=${v.channel} /></span>`}</div>
  </article>`;
}
function Grid({ feed, bare }) {
  return html`${feed.items.length ? html`<div class="wt-grid">${feed.items.map((v) => html`<${VideoCard} key=${v.id} v=${v} bare=${bare} />`)}</div>` : null}
    ${!feed.items.length && !feed.loading && feed.started && !feed.error ? html`<div class="wt-empty"><${Icon} name="film" size=${34} sw=${1.5} /><p>${t('No videos to show here.')}</p></div>` : null}
    ${!feed.items.length && feed.error ? html`<div class="wt-empty"><${Icon} name="alert-circle" size=${30} /><p>${feed.error}</p><button type="button" class="link-btn" onClick=${feed.more}>${t('Try again')}</button></div>` : null}
    <${Sentinel} feed=${feed} />`;
}

/* ------------------------------------------------------------------ the search bar, with what people usually search for as you type */
function SearchBar({ value }) {
  const [q, setQ] = useState(value || ''); const [list, setList] = useState([]); const [open, setOpen] = useState(false); const [at, setAt] = useState(-1);
  const timer = useRef(null); const wrap = useRef(null); const asked = useRef('');
  useEffect(() => { setQ(value || ''); setOpen(false); }, [value]);
  useEffect(() => {
    const off = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', off); return () => { document.removeEventListener('pointerdown', off); clearTimeout(timer.current); };
  }, []);
  const typing = (v) => {
    setQ(v); setAt(-1); clearTimeout(timer.current);
    if (!v.trim()) { setList([]); return; }
    timer.current = setTimeout(() => {
      asked.current = v; api.get(`/watch/suggest?q=${encodeURIComponent(v.trim())}`).then((r) => { if (asked.current === v) { setList(r.suggestions || []); setOpen(true); } }).catch(() => {});
    }, 200);
  };
  const submit = (text) => { const v = (text ?? q).trim(); if (!v) return; clearTimeout(timer.current); setOpen(false); setQ(v); search(v); };
  const key = (e) => {
    if (e.key === 'ArrowDown' && list.length) { e.preventDefault(); setOpen(true); const n = (at + 1) % list.length; setAt(n); setQ(list[n]); }
    else if (e.key === 'ArrowUp' && list.length) { e.preventDefault(); const n = (at - 1 + list.length) % list.length; setAt(n); setQ(list[n]); }
    else if (e.key === 'Enter') { e.preventDefault(); submit(); }
    else if (e.key === 'Escape') setOpen(false);
  };
  return html`<div class="wt-search" ref=${wrap} role="search">
    <div class="wt-sbox"><input class="wt-input" type="search" placeholder=${t('Search')} value=${q} aria-label=${t('Search videos')} autocomplete="off" spellcheck="false" maxlength="100"
        onInput=${(e) => typing(e.target.value)} onKeyDown=${key} onFocus=${() => list.length && setOpen(true)} />
      ${q ? html`<button type="button" class="wt-x" aria-label=${t('Clear')} onClick=${() => { setQ(''); setList([]); setOpen(false); }}><${Icon} name="x" size=${17} /></button>` : null}
      <button type="button" class="wt-go" aria-label=${t('Search')} data-tip=${t('Search')} onClick=${() => submit()}><${Icon} name="search" size=${20} /></button></div>
    ${open && list.length ? html`<ul class="wt-sugg" role="listbox">${list.map((s, i) => html`<li key=${s} role="option" aria-selected=${i === at}><button type="button" class=${cx(i === at && 'on')} onMouseDown=${(e) => e.preventDefault()} onClick=${() => submit(s)}><${Icon} name="search" size=${16} /><span>${s}</span></button></li>`)}</ul>` : null}
  </div>`;
}

/* ------------------------------------------------------------------ the home page */
function Home() {
  const [chip, setChip] = useState(() => state.watchChip || 'all');
  const feed = useFeed(`/watch/home?chip=${encodeURIComponent(chip)}`, (r) => r.videos);
  const chips = feed.extra?.chips || [{ key: 'all', name: 'All' }];
  const pick = (k) => { state.watchChip = k; setChip(k); };
  return html`<div class="wt-body">
    <div class="wt-chips" role="tablist">${chips.map((c) => html`<button type="button" key=${c.key} role="tab" aria-selected=${chip === c.key} class=${cx('wt-chip', chip === c.key && 'on')} onClick=${() => pick(c.key)}>${t(c.name)}</button>`)}</div>
    <${Grid} feed=${feed} />
  </div>`;
}

/* ------------------------------------------------------------------ search results */
function Results({ q }) {
  const feed = useFeed(`/watch/search?q=${encodeURIComponent(q)}`, (r) => r.videos);
  const channels = feed.extra?.channels || [];
  return html`<div class="wt-body narrow">
    ${channels.map((c) => html`<a key=${c.id} class="wt-chcard" href=${`/watch/channel/${c.id}`} onClick=${nav(() => openChannel(c.id))}><${ChannelAvatar} c=${c} size=${88} />
      <span class="wt-text"><b>${c.name}</b><small>${[c.handle, c.subscribers].filter(Boolean).join(' • ')}</small>${c.description ? html`<small class="dim">${c.description}</small>` : null}</span></a>`)}
    ${feed.items.map((v) => html`<${VideoRow} key=${v.id} v=${v} />`)}
    ${!feed.items.length && !feed.loading && feed.started && !feed.error ? html`<div class="wt-empty"><${Icon} name="search" size=${34} sw=${1.5} /><p>${t('No videos found for')} “${q}”.</p></div>` : null}
    ${!feed.items.length && feed.error ? html`<div class="wt-empty"><${Icon} name="alert-circle" size=${30} /><p>${feed.error}</p><button type="button" class="link-btn" onClick=${feed.more}>${t('Try again')}</button></div>` : null}
    <${Sentinel} feed=${feed} />
  </div>`;
}

/* ------------------------------------------------------------------ a channel */
function Channel({ id }) {
  const [data, setData] = useState(null); const [err, setErr] = useState(null); const [more, setMore] = useState(false);
  const feed = useFeed(`/watch/channels/${id}/videos`, (r) => r.videos);
  useEffect(() => { let on = true; setData(null); setErr(null); setMore(false); api.get(`/watch/channels/${id}`).then((r) => on && setData(r.channel), (e) => on && setErr(e.message || t('Couldn’t load this.'))); return () => { on = false; }; }, [id]);
  if (err) return html`<div class="wt-body"><div class="wt-empty"><${Icon} name="alert-circle" size=${30} /><p>${err}</p><button type="button" class="link-btn" onClick=${openWatch}>${t('Go to Watch')}</button></div></div>`;
  if (!data) return html`<div class="wt-body"><div class="wt-empty"><${Spinner} /></div></div>`;
  return html`<div class="wt-body">
    ${data.banner ? html`<div class="wt-banner"><img src=${data.banner} alt="" referrerpolicy="no-referrer" draggable=${false} /></div>` : null}
    <header class="wt-chhead"><${ChannelAvatar} c=${data} size=${112} />
      <div class="wt-text"><h1>${data.name}</h1><small>${[data.handle, data.subscribers, data.videoCount].filter(Boolean).join(' • ')}</small>
        ${data.description ? html`<p class=${cx('wt-about', more && 'open')} onClick=${() => setMore(!more)} title=${more ? '' : t('Show more')}>${data.description}</p>` : null}</div></header>
    <h2 class="wt-h">${t('Videos')}</h2>
    <${Grid} feed=${feed} bare=${true} />
  </div>`;
}

/* ------------------------------------------------------------------ a video */
const URL_RE = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g;
/** Description text with its web addresses made into links (they open in a new tab) and its line breaks kept. */
function Linked({ text }) {
  const parts = String(text).split(URL_RE);
  return html`${parts.map((p, i) => (i % 2 ? html`<a key=${i} href=${p} target="_blank" rel="noopener noreferrer nofollow">${p}</a>` : p))}`;
}
function Comments({ id }) {
  const feed = useFeed(`/watch/videos/${id}/comments`, (r) => r.comments);
  return html`<section class="wv-comments"><h2 class="wt-h">${feed.items.length || feed.started ? t('Comments') : ''}</h2>
    ${feed.items.map((c) => html`<div class="wv-c" key=${c.id}>
      <a href=${c.author.channelId ? `/watch/channel/${c.author.channelId}` : undefined} onClick=${c.author.channelId ? nav(() => openChannel(c.author.channelId)) : null} tabindex="-1"><${ChannelAvatar} c=${c.author} size=${40} /></a>
      <div class="wv-ct"><div class="wv-ch">${c.pinned ? html`<span class="wv-pin"><${Icon} name="pin" size=${12} /> ${t('Pinned')}</span>` : null}<b class=${cx(c.owner && 'owner')}>${c.author.name}</b><small>${c.published}</small></div>
        <p>${c.text}</p>
        <div class="wv-cf"><span><${Icon} name="thumbs-up" size=${15} /> ${c.likes && c.likes !== '0' ? c.likes : ''}</span>${c.hearted ? html`<span class="wv-heart" data-tip=${t('Liked by the creator')}><${Icon} name="heart" size=${14} fill=${true} sw=${1} /></span>` : null}${c.replies && c.replies !== '0' ? html`<small>${c.replies} ${Number(c.replies) === 1 ? t('reply') : t('replies')}</small>` : null}</div></div>
    </div>`)}
    ${!feed.items.length && feed.started && !feed.loading && !feed.error ? html`<p class="wt-dim">${t('No comments to show.')}</p>` : null}
    <${Sentinel} feed=${feed} /></section>`;
}
function VideoPage({ id }) {
  const [data, setData] = useState(null); const [err, setErr] = useState(null); const [full, setFull] = useState(false);
  useEffect(() => {
    let on = true; setData(null); setErr(null); setFull(false);
    music.pause();   // the music player and a video would talk over each other
    api.get(`/watch/videos/${id}`).then((r) => on && setData(r), (e) => on && setErr(e.message || t('Couldn’t load this.')));
    return () => { on = false; };
  }, [id]);
  const v = data?.video;
  const share = async () => { await copyText(`${location.origin}/watch?v=${id}`); toast(t('Link copied'), 'success', 1600); };
  return html`<div class="wv">
    <div class="wv-main">
      <div class="wv-player"><iframe key=${id} title=${v?.title || t('Video player')} src=${`https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&rel=0&playsinline=1`} allow="autoplay; encrypted-media; picture-in-picture; fullscreen; clipboard-write" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>
      ${err ? html`<div class="wt-empty"><${Icon} name="alert-circle" size=${30} /><p>${err}</p><button type="button" class="link-btn" onClick=${openWatch}>${t('Go to Watch')}</button></div>`
        : !v ? html`<div class="wt-empty"><${Spinner} /></div>` : html`
        <h1 class="wv-title">${v.title}</h1>
        <div class="wv-meta">
          <div class="wv-owner"><a href=${v.channel.id ? `/watch/channel/${v.channel.id}` : undefined} onClick=${v.channel.id ? nav(() => openChannel(v.channel.id)) : null}><${ChannelAvatar} c=${v.channel} size=${42} /></a>
            <div class="wt-text"><${ChannelName} c=${v.channel} />${v.channel.subscribers ? html`<small>${v.channel.subscribers}</small>` : null}</div></div>
          <div class="wv-actions">
            ${v.likes !== null ? html`<span class="wv-pill" data-tip=${t('Likes')}><${Icon} name="thumbs-up" size=${18} /> ${compact(v.likes)}</span>` : null}
            <${PartyPills} id=${id} /><button type="button" class="wv-pill btn-like" onClick=${share}><${Icon} name="link" size=${18} /> ${t('Share')}</button></div></div>
        <div class=${cx('wv-desc', full && 'open')} onClick=${(e) => { if (!full && e.target.tagName !== 'A') setFull(true); }}>
          <b>${[v.live ? v.viewsText : v.views !== null ? `${new Intl.NumberFormat().format(v.views)} ${t('views')}` : '', v.published || v.ago].filter(Boolean).join(' • ')}</b>
          ${v.description ? html`<p><${Linked} text=${v.description} /></p>` : null}
          ${v.description && !full ? html`<span class="wv-more">${t('Show more')}</span>` : null}
          ${full ? html`<button type="button" class="wv-less" onClick=${(e) => { e.stopPropagation(); setFull(false); }}>${t('Show less')}</button>` : null}</div>
        <${Comments} key=${id} id=${id} />`}
    </div>
    <aside class="wv-side">${data ? data.related.map((r) => html`<${VideoRow} key=${r.id} v=${r} small=${true} />`) : null}</aside>
  </div>`;
}

/* ------------------------------------------------------------------ the page */
export function WatchPage() {
  const ok = useSel((s) => s.watchOk); const view = useSel((s) => s.route.watchView); const id = useSel((s) => s.route.watchId); const q = useSel((s) => s.route.watchQuery);
  const scroller = useRef(null);
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = 0; }, [view, id, q]);
  return html`<main class="main panel watch-page view-anim">
    <header class="m-header wt-top">
      <button type="button" class="mobile-only icon-btn" onClick=${() => set({ mobileNav: true })} aria-label=${t('Menu')}><${Icon} name="menu" size=${22} /></button>
      <button type="button" class="m-title wt-brand" onClick=${openWatch} aria-label=${t('Watch')}><${Icon} name="play-circle" size=${24} /><span class="name">${t('Watch')}</span></button>
      ${ok === false ? null : html`<${SearchBar} value=${view === 'search' ? q : ''} />`}
      <span class="wt-spacer"></span>
    </header>
    <div class="wt-scroll" ref=${scroller}>
      ${ok === false ? html`<div class="wt-empty setup"><${Icon} name="film" size=${34} sw=${1.5} /><b>${t('Watch is turned off on this server')}</b><p>${t('The server admin switched videos off.')}</p></div>`
        : view === 'video' && id ? html`<${VideoPage} key=${id} id=${id} />` : view === 'channel' && id ? html`<${Channel} key=${id} id=${id} />` : view === 'search' && q ? html`<${Results} key=${q} q=${q} />` : html`<${Home} />`}
    </div>
  </main>`;
}
