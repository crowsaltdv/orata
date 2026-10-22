// Orata — music: the Music page (/music, opened from the note icon above Home) with search, categories and a full-song player, a mini player, and the "Listening to" card shown on profiles.
// The server finds the songs (see server/music.js); the browser plays them in an embedded player that is kept out of sight (see youtube-player.js).
import { html, useState, useEffect, useRef, cx, ls } from '/js/lib.js';
import { state, set, useSel, toast, setSetting, go, closePopover } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { Spinner, IconBtn, Toggle } from '/js/ui.js';
import { api } from '/js/api.js';
import { t } from '/js/i18n.js';
import { createPlayer } from '/js/youtube-player.js';
import { ArtistLinks, AlbumLink, ArtistView, AlbumView, PlaylistView, PlaylistsSection, openAddMenu, openArtist, back } from '/js/music-pages.js';

const setMusic = (patch) => set({ music: { ...state.music, ...patch } });
export const openMusic = () => go('/music');
/** The last tracks you played, newest first (kept in this browser). */
function pushRecent(track) {
  const recent = [track, ...(state.music.recent || []).filter((x) => x.id !== track.id)].slice(0, 20);
  setMusic({ recent }); ls('musicRecentYT', null, recent);
}

/* ------------------------------------------------------------------ player */
let player = null; let reqId = 0; let lastSync = 0; let idle = true; let watchdog = 0; let failedFor = 0; let skipRun = 0;   // skipRun: songs in a row that could not be played   // idle: nothing is loaded in the player (never started, stopped, or the queue ended)
// The server fills in the title, artist and artwork itself (from what the catalogue told it); the player only says which track, how long and where it is.
/** YouTube refuses to play inside pages whose address is a bare IP number (http://192.168.1.5:3000, 127.0.0.1): it needs localhost or a domain name. */
const numericHost = /^(\d{1,3}\.){3}\d{1,3}$|^\[[0-9a-f:]+\]$/i.test(location.hostname);
const listeningBody = (m) => ({ track: { id: m.track.id }, duration: Math.round(Math.max(1, m.duration || 180) * 1000), position: Math.round((m.position || 0) * 1000) });
/** Tells the server what is playing (it shows on the profile) — never when Activity Status is off. */
function syncListening(force = false) {
  const m = state.music;
  if (!m.track || !state.token || state.settings.privacy?.showActivity === false) return;
  if (!force && Date.now() - lastSync < 2000) return;
  lastSync = Date.now();
  api.put('/me/listening', listeningBody(m)).catch(() => {});
}
function clearListening() { lastSync = 0; if (state.token) api.del('/me/listening').catch(() => {}); }

function yt() {
  if (player) return player;
  player = createPlayer({
    onState(code) {
      if (!state.music.track || idle) return;
      if (code === 1) { clearTimeout(watchdog); skipRun = 0; setMusic({ playing: true, loading: false }); syncListening(); }
      else if (code === 3) { clearTimeout(watchdog); setMusic({ loading: true }); }
      else if (code === 2) { setMusic({ playing: false, loading: false }); clearListening(); }
      else if (code === 0) next(true);
    },
    onTime(sec, dur) {
      const m = state.music; if (!m.track || idle) return;
      if (Math.abs(sec - m.position) >= 0.25 || (dur > 0 && Math.abs(dur - m.duration) >= 0.5)) setMusic({ position: sec, duration: dur > 0 ? dur : m.duration });
    },
    onError(code) {   // 100 removed or private, 101 / 150 / 153: the uploader does not allow it to be played outside YouTube
      if (!state.music.track || idle || failedFor === reqId) return;   // YouTube repeats an error with every update: once per song is enough
      const id = failedFor = reqId; const blocked = code === 100 || code === 101 || code === 150 || code === 153;
      if (blocked && numericHost) return fail(t('Music can’t play on a page whose address is just numbers. Open Orata at localhost or a domain name instead.'), 12_000);
      if (blocked && ++skipRun > 3) return fail(t('Several songs in a row couldn’t be played here, so playback may be blocked on this connection.'), 9000);
      fail(blocked ? t('This song can’t be played here.') : t('Couldn’t play this track.'));
      if (blocked) setTimeout(() => id === reqId && next(true), 1500);   // a song that can't be played is skipped; other problems are not retried down the list
    },
  });
  player.volume(state.music.volume);
  return player;
}
function fail(message, ms = 4000) {
  clearTimeout(watchdog);
  setMusic({ playing: false, loading: false, error: message }); clearListening();
  toast(message, 'error', ms);
}
function load(track, queue, index) {
  const id = ++reqId; idle = false;
  setMusic({ track, queue: queue || state.music.queue, index: index ?? state.music.index, loading: true, playing: false, position: 0, duration: (track.duration || 0) / 1000, error: null });
  pushRecent(track);
  yt().load(track.id);
  clearTimeout(watchdog);
  watchdog = setTimeout(() => { if (id === reqId && !state.music.playing) fail(t('The player didn’t respond. Check your connection or ad blocker.')); }, 15_000);
}
export const music = {
  play(track, queue) { const q = queue || [track]; load(track, q, Math.max(0, q.findIndex((x) => x.id === track.id))); },
  toggle() {
    const m = state.music; if (!m.track) return;
    if (idle) load(m.track, m.queue, m.index); else if (m.playing) yt().pause(); else yt().play();
  },
  next: () => next(false),
  prev() { const m = state.music; if (m.position > 3) return music.seek(0); if (m.index > 0) load(m.queue[m.index - 1], m.queue, m.index - 1); else music.seek(0); },
  seek(sec) { if (idle) return; yt().seek(sec); setMusic({ position: Math.max(0, sec) }); syncListening(true); },
  volume(v) { const x = Math.min(1, Math.max(0, v)); if (player) player.volume(x); ls('musicVolume', null, x); setMusic({ volume: x }); },
  stop({ silent = false } = {}) {
    reqId++; idle = true; clearTimeout(watchdog); player?.stop();
    if (!silent) clearListening();
    setMusic({ track: null, queue: [], index: -1, playing: false, loading: false, position: 0, duration: 0, error: null });
  },
  async loadGenres() {
    if (state.music.genres) return;
    try { setMusic({ genres: (await api.get('/music/charts')).genres }); } catch { /* the page still works with just "Top Songs" */ }
  },
  async openChart(key, retry = false) {
    setMusic({ category: key });
    if (state.music.charts[key] && !retry) return;
    setMusic({ chartLoading: true, chartError: null });
    try { const r = await api.get(`/music/charts/${encodeURIComponent(key)}`); setMusic({ charts: { ...state.music.charts, [key]: r.tracks }, chartLoading: state.music.category === key ? false : state.music.chartLoading }); }
    catch (e) { if (state.music.category === key) setMusic({ chartLoading: false, chartError: e.message }); }
  },
  async search(q) {
    const query = q.trim(); setMusic({ query });
    if (!query) { setMusic({ results: null, artists: [], error: null }); return; }
    setMusic({ searching: true, error: null });
    try { const r = await api.get(`/music/search?q=${encodeURIComponent(query)}`); if (state.music.query === query) setMusic({ results: r.tracks, artists: r.artists || [], searching: false }); } catch (e) { if (state.music.query === query) setMusic({ results: [], searching: false, error: e.message }); }
  },
};
function next(auto) {
  const m = state.music;
  if (m.index + 1 < m.queue.length) load(m.queue[m.index + 1], m.queue, m.index + 1);
  else if (auto) { idle = true; setMusic({ playing: false, loading: false, position: 0 }); clearListening(); } else music.seek(0);
}
export const stopMusic = (opts) => music.stop(opts);
// a track that finished while the tab was asleep, or Activity Status switched back on mid-song
setInterval(() => { if (state.music?.playing) syncListening(); }, 20_000);

/* ------------------------------------------------------------------ pieces */
export const clock = (s) => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
export function Art({ src, size = 44, playing }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  return html`<span class=${cx('m-art', playing && 'on')} style=${{ width: size + 'px', height: size + 'px' }}>${src && !broken ? html`<img src=${size <= 64 ? src.replace('=w400-h400', '=w120-h120') : src} alt="" decoding="async" referrerpolicy="no-referrer" draggable=${false} onError=${() => setBroken(true)} />` : html`<${Icon} name="music" size=${Math.round(size * 0.45)} />`}${playing ? html`<span class="eq sm"><i></i><i></i><i></i><i></i></span>` : null}</span>`;
}
function Progress() {
  const pos = useSel((s) => s.music.position); const dur = useSel((s) => s.music.duration);
  const [drag, setDrag] = useState(null);
  const shown = drag ?? pos;
  return html`<div class="m-progress"><span>${clock(shown)}</span>
    <input type="range" min="0" max=${Math.max(1, dur)} step="0.5" value=${shown} style=${{ '--p': `${Math.min(100, (shown / Math.max(1, dur)) * 100)}%` }} aria-label=${t('Seek')}
      onInput=${(e) => setDrag(Number(e.target.value))} onChange=${(e) => { music.seek(Number(e.target.value)); setDrag(null); }} />
    <span>${clock(dur)}</span></div>`;
}
function Controls({ big }) {
  const playing = useSel((s) => s.music.playing); const loading = useSel((s) => s.music.loading);
  return html`<div class=${cx('m-controls', big && 'big')}>
    <${IconBtn} icon="skip-back" label=${t('Previous')} size=${big ? 22 : 18} glass=${null} onClick=${music.prev} />
    <button type="button" class="m-play" aria-label=${playing ? t('Pause') : t('Play')} onClick=${music.toggle}>${loading && !playing ? html`<${Spinner} size=${big ? 20 : 16} />` : html`<${Icon} name=${playing ? 'pause' : 'play'} size=${big ? 24 : 18} fill=${true} sw=${1} />`}</button>
    <${IconBtn} icon="skip-forward" label=${t('Next')} size=${big ? 22 : 18} glass=${null} onClick=${music.next} />
  </div>`;
}

/** A square cover that scales with its grid cell. */
export function Cover({ src, playing }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  return html`<span class=${cx('m-art cover', playing && 'on')}>${src && !broken ? html`<img src=${src} alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" draggable=${false} onError=${() => setBroken(true)} />` : html`<${Icon} name="music" size=${34} />`}${playing ? html`<span class="eq"><i></i><i></i><i></i><i></i></span>` : null}</span>`;
}

/** What is playing, big, with the controls. Shown above everything else on the page. */
function Hero() {
  const track = useSel((s) => s.music.track); const playing = useSel((s) => s.music.playing); const volume = useSel((s) => s.music.volume);
  const show = useSel((s) => s.settings.privacy?.showActivity !== false);
  if (!track) return html`<section class="mpg-hero empty"><span class="mpg-hero-ico"><${Icon} name="music" size=${34} sw=${1.6} /></span>
    <div><h1>${t('Music')}</h1><p>${t('Search for songs or pick a category below and play them in full. What you play can show on your profile.')}</p></div></section>`;
  return html`<section class="mpg-hero" style=${track.artwork ? { '--cover': `url("${track.artwork}")` } : null}>
    <div class="mpg-hero-art"><${Cover} src=${track.artwork} playing=${playing} /></div>
    <div class="mpg-now">
      <h2 title=${track.title}>${track.title}</h2>
      <div class="mpg-artist"><${ArtistLinks} track=${track} /></div>
      ${track.album ? html`<small class="mpg-album"><${AlbumLink} track=${track} /></small>` : null}
      <${Progress} />
      <${Controls} big=${true} />
      <div class="m-extra">
        <label class="m-vol"><${Icon} name=${volume === 0 ? 'volume-x' : volume < 0.5 ? 'volume-1' : 'volume'} size=${18} />
          <input type="range" min="0" max="1" step="0.01" value=${volume} style=${{ '--p': `${volume * 100}%` }} aria-label=${t('Volume')} onInput=${(e) => music.volume(Number(e.target.value))} /></label>
        <label class="m-share" data-tip=${t('Show what you’re listening to on your profile')}><span>${t('Show on my profile')}</span><${Toggle} checked=${show} onChange=${(v) => { setSetting('privacy.showActivity', v); if (v) setTimeout(() => syncListening(true), 50); }} /></label>
        <button type="button" class="m-addpl" onClick=${(e) => openAddMenu(e, track)}><${Icon} name="plus" size=${16} sw=${2.4} /> ${t('Add to playlist')}</button>
      </div>
    </div>
  </section>`;
}

/** Songs as a grid of covers; clicking one plays it (and queues the rest of the grid after it). */
function TrackGrid({ tracks }) {
  const cur = useSel((s) => s.music.track?.id); const playing = useSel((s) => s.music.playing);
  return html`<div class="mpg-grid">${tracks.map((tr) => html`<div class="mpg-cell" key=${tr.id}>
    <button type="button" class=${cx('mpg-card', cur === tr.id && 'cur')} onClick=${() => (cur === tr.id ? music.toggle() : music.play(tr, tracks))} title=${`${tr.title} — ${tr.artist}`}>
      <span class="mpg-cover"><${Cover} src=${tr.artwork} playing=${cur === tr.id && playing} /><span class="mpg-play"><${Icon} name=${cur === tr.id && playing ? 'pause' : 'play'} size=${20} fill=${true} sw=${1} /></span></span>
      <b>${tr.title}</b><small>${tr.artist}</small></button>
    <button type="button" class="mpg-add" data-tip=${t('Add to playlist')} aria-label=${t('Add to playlist')} onClick=${(e) => openAddMenu(e, tr)}><${Icon} name="plus" size=${16} sw=${2.6} /></button>
  </div>`)}</div>`;
}

function Categories() {
  const genres = useSel((s) => s.music.genres); const cat = useSel((s) => s.music.category);
  const [all, setAll] = useState(false);
  const list = genres || [{ key: 'top', name: 'Top Songs' }];
  const FIRST = 14;   // there are about 40 genres and moods: the popular ones show, the rest are behind "More" (the open one always shows)
  const long = list.length > FIRST + 2;
  const shown = all || !long ? list : [...list.slice(0, FIRST), ...list.slice(FIRST).filter((g) => g.key === cat)];
  return html`<div class="mpg-chips" role="tablist" aria-label=${t('Categories')}>${shown.map((g) => html`<button type="button" role="tab" key=${g.key} aria-selected=${cat === g.key} class=${cx('mpg-chip', cat === g.key && 'on')} onClick=${() => music.openChart(g.key)}>${g.name}</button>`)}
    ${long ? html`<button type="button" class="mpg-chip" onClick=${() => setAll(!all)}>${all ? t('Fewer') : `${t('More')} (${list.length - shown.length})`}</button>` : null}</div>`;
}

function Chart() {
  const cat = useSel((s) => s.music.category); const genres = useSel((s) => s.music.genres); const tracks = useSel((s) => s.music.charts[s.music.category]);
  const loading = useSel((s) => s.music.chartLoading); const error = useSel((s) => s.music.chartError);
  const name = genres?.find((g) => g.key === cat)?.name || t('Top Songs');
  return html`<section class="mpg-section"><h3>${cat === 'top' ? name : `${t('Top')} ${name}`}</h3>
    ${tracks?.length ? html`<${TrackGrid} tracks=${tracks} />` : loading || !error ? html`<div class="pk-center"><${Spinner} /></div>` : html`<div class="m-empty"><${Icon} name="alert-circle" size=${28} /><p>${error}</p><button type="button" class="link-btn" onClick=${() => music.openChart(cat, true)}>${t('Try again')}</button></div>`}
  </section>`;
}

function Recent() {
  const recent = useSel((s) => s.music.recent);
  if (!recent?.length) return null;
  return html`<section class="mpg-section"><h3>${t('Recently played')}</h3><${TrackGrid} tracks=${recent.slice(0, 12)} /></section>`;
}

function SearchResults() {
  const results = useSel((s) => s.music.results); const artists = useSel((s) => s.music.artists); const searching = useSel((s) => s.music.searching); const error = useSel((s) => s.music.error); const query = useSel((s) => s.music.query);
  return html`<section class="mpg-section"><h3>${t('Results for')} “${query}”</h3>
    ${artists?.length ? html`<div class="mpg-artists">${artists.map((a) => html`<button type="button" key=${a.id} class="mpg-artist-card" onClick=${() => openArtist(a.id)} title=${a.name}>
      <span class="ar-mini">${a.avatar ? html`<img src=${a.avatar} alt="" loading="lazy" referrerpolicy="no-referrer" draggable=${false} />` : html`<${Icon} name="user" size=${26} />`}</span><b>${a.name}</b><small>${t('Artist')}</small></button>`)}</div>` : null}
    ${searching && !results ? html`<div class="pk-center"><${Spinner} /></div>`
      : error && !results?.length ? html`<div class="m-empty"><${Icon} name="alert-circle" size=${28} /><p>${error}</p></div>`
        : !results?.length ? html`<div class="m-empty"><p>${t('Nothing found. Try another search.')}</p></div>`
          : html`<${TrackGrid} tracks=${results} />`}
  </section>`;
}

/** The Music page (`/music`): search, what is playing, your playlists, categories of top songs and what you played recently — or, deeper in, an artist's, an album's or a playlist's page. */
export function MusicPage() {
  const ok = useSel((s) => s.musicOk); const why = useSel((s) => s.musicWhy); const query = useSel((s) => s.music.query);
  const view = useSel((s) => s.route.musicView); const vid = useSel((s) => s.route.musicId);
  const [q, setQ] = useState(query); const timer = useRef(null); const scroller = useRef(null);
  useEffect(() => { if (ok !== false) { music.loadGenres(); music.openChart(state.music.category || 'top'); } }, [ok]);
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = 0; }, [view, vid]);
  const typing = (v) => { setQ(v); clearTimeout(timer.current); timer.current = setTimeout(() => music.search(v), 450); };
  const searching = !!query.trim(); const sub = ok !== false && !!view && !!vid;
  return html`<main class="main panel music-page view-anim">
    <header class="m-header">
      <button type="button" class="mobile-only icon-btn" onClick=${() => set({ mobileNav: true })} aria-label=${t('Menu')}><${Icon} name="menu" size=${22} /></button>
      ${sub ? html`<button type="button" class="icon-btn m-back" onClick=${back} aria-label=${t('Back')} data-tip=${t('Back')}><${Icon} name="arrow-left" size=${20} /></button>` : null}
      <div class="m-title"><${Icon} name="music" size=${23} /><span class="name">${t('Music')}</span></div>
    </header>
    <div class="mpg-scroll" ref=${scroller}>
      ${ok === false ? html`<div class="m-empty setup"><${Icon} name="music" size=${34} sw=${1.5} /><b>${why ? t('Music isn’t set up on this server yet') : t('Music is turned off on this server')}</b><p>${why || t('The server admin switched the music player off.')}</p></div>`
        : sub ? (view === 'artist' ? html`<${ArtistView} key=${vid} id=${vid} />` : view === 'album' ? html`<${AlbumView} key=${vid} id=${vid} />` : html`<${PlaylistView} key=${vid} id=${vid} />`) : html`
        <div class="mpg-search"><div class="input-wrap"><${Icon} name="search" size=${18} /><input class="input" placeholder=${t('Search songs and artists…')} value=${q} onInput=${(e) => typing(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') { clearTimeout(timer.current); music.search(q); } }} />
          ${q ? html`<button type="button" class="mpg-clear" aria-label=${t('Clear')} onClick=${() => { setQ(''); clearTimeout(timer.current); music.search(''); }}><${Icon} name="x" size=${16} /></button>` : null}</div></div>
        <${Hero} />
        ${searching ? html`<${SearchResults} />` : html`<${PlaylistsSection} /><${Categories} /><${Chart} /><${Recent} />`}`}
    </div>
  </main>`;
}

/** The small player above the user bar while something is loaded. */
export function MiniPlayer() {
  const track = useSel((s) => s.music.track); const playing = useSel((s) => s.music.playing);
  if (!track) return null;
  return html`<div class="mini-player">
    <button type="button" class="mp-open" onClick=${openMusic} aria-label=${t('Open music')}><${Art} src=${track.artwork} size=${34} playing=${playing} />
      <span class="mp-text"><b>${track.title}</b><small>${track.artist}</small></span></button>
    <${Controls} />
    <${IconBtn} icon="x" label=${t('Stop')} size=${16} glass=${null} onClick=${() => music.stop()} />
  </div>`;
}

/** "Listening to music" on a profile. `listening` = { title, artist, artwork, url, duration, startedAt, endsAt } (milliseconds). */
export function ListeningCard({ listening: l }) {
  const [, tick] = useState(0);
  const toArtist = (e) => { e.preventDefault(); closePopover(); if (state.modals.length) set({ modals: [] }); openArtist(l.artistId); };
  useEffect(() => { const id = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(id); }, []);
  if (!l || l.endsAt < Date.now()) return null;
  const pos = Math.min(l.duration, Math.max(0, Date.now() - l.startedAt));
  return html`<div class="listening-card">
    <h5><${Icon} name="music" size=${13} /> ${t('Listening to music')}</h5>
    <div class="lc-row"><${Art} src=${l.artwork} size=${60} playing=${true} />
      <div class="lc-text"><b class="lc-title" title=${l.title}>${l.title}</b><small>${l.artistId ? html`<a class="m-link" href=${`/music/artist/${l.artistId}`} onClick=${toArtist}>${l.artist}</a>` : l.artist}</small>
        <div class="lc-bar"><span>${clock(pos / 1000)}</span><i><b style=${{ width: `${(pos / l.duration) * 100}%` }}></b></i><span>${clock(l.duration / 1000)}</span></div></div></div>
  </div>`;
}
/** What the signed-in user is playing right now, shaped like a `listening` status (their own is never hidden from themselves). */
export function myListening() {
  const m = state.music; if (!m?.playing || !m.track) return null;
  const now = Date.now(); const pos = m.position * 1000; const dur = Math.max(1, m.duration || 180) * 1000;
  return { id: m.track.id, title: m.track.title, artist: m.track.artist, artistId: m.track.artists?.[0]?.id || null, artwork: m.track.artwork, url: m.track.url, duration: dur, startedAt: now - pos, endsAt: now + (dur - pos) };
}
