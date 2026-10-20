// Orate — music: the Music page (/music, opened from the note icon above Home) with Apple Music search, top-song categories and a preview player, a mini player, and the "Listening to" card shown on profiles.
// The server talks to Apple Music (see server/music.js); the browser only plays the 30-second previews from our own /api/music/play links.
import { html, useState, useEffect, useRef, cx, ls } from '/js/lib.js';
import { state, set, useSel, toast, setSetting, go } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { Spinner, IconBtn, Toggle } from '/js/ui.js';
import { api } from '/js/api.js';
import { t } from '/js/i18n.js';

const setMusic = (patch) => set({ music: { ...state.music, ...patch } });
export const openMusic = () => go('/music');
/** The last tracks you played, newest first (kept in this browser). */
function pushRecent(track) {
  const recent = [track, ...(state.music.recent || []).filter((x) => x.id !== track.id)].slice(0, 20);
  setMusic({ recent }); ls('musicRecent', null, recent);
}

/* ------------------------------------------------------------------ player */
let audio = null; let reqId = 0; let lastSync = 0;
const PREVIEW_SECONDS = 30;   // every Apple Music preview is about this long; used until the player knows the real length
// The server fills in the title, artist and artwork itself (from what Apple Music told it); the player only says which track, how long and where it is.
const listeningBody = (m) => ({ track: { id: m.track.id }, duration: Math.round(Math.max(1, m.duration || PREVIEW_SECONDS) * 1000), position: Math.round((audio?.currentTime || 0) * 1000) });
/** Tells the server what is playing (it shows on the profile) — never when Activity Status is off. */
function syncListening(force = false) {
  const m = state.music;
  if (!m.track || !state.token || state.settings.privacy?.showActivity === false) return;
  if (!force && Date.now() - lastSync < 2000) return;
  lastSync = Date.now();
  api.put('/me/listening', listeningBody(m)).catch(() => {});
}
function clearListening() { lastSync = 0; if (state.token) api.del('/me/listening').catch(() => {}); }

function el() {
  if (audio) return audio;
  audio = new Audio(); audio.preload = 'auto'; audio.volume = state.music.volume;
  audio.addEventListener('timeupdate', () => {
    const m = state.music; const d = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : m.duration;
    if (Math.abs(audio.currentTime - m.position) >= 0.25 || d !== m.duration) setMusic({ position: audio.currentTime, duration: d });
  });
  audio.addEventListener('loadedmetadata', () => { if (Number.isFinite(audio.duration) && audio.duration > 0) setMusic({ duration: audio.duration }); });
  audio.addEventListener('playing', () => { setMusic({ playing: true, loading: false }); syncListening(); });
  audio.addEventListener('waiting', () => setMusic({ loading: true }));
  audio.addEventListener('pause', () => { if (audio.ended || !state.music.track) return; setMusic({ playing: false }); clearListening(); });
  audio.addEventListener('ended', () => next(true));
  audio.addEventListener('error', () => { if (state.music.track && audio.getAttribute('src')) fail(t('Couldn’t play this track.')); });
  return audio;
}
function teardown() {
  if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
}
function fail(message) {
  setMusic({ playing: false, loading: false, error: message }); clearListening();
  toast(message, 'error', 4000);
}
async function load(track, queue, index) {
  const id = ++reqId;
  teardown();
  setMusic({ track, queue: queue || state.music.queue, index: index ?? state.music.index, loading: true, playing: false, position: 0, duration: PREVIEW_SECONDS, error: null });
  pushRecent(track);
  let src;
  try { src = await api.get(`/music/tracks/${encodeURIComponent(track.id)}/source`); } catch (e) { if (id === reqId) { fail(e.message); if (e.code === 'music_unavailable') setTimeout(() => id === reqId && next(true), 1500); } return; }   // a track Audiomack can't play is skipped; real problems (keys, network) are not retried down the list
  if (id !== reqId) return;
  const a = el();
  try {
    a.src = src.url;
    await a.play();
  } catch (e) { if (id === reqId && e.name !== 'AbortError') fail(e.message || t('Couldn’t play this track.')); }
}
export const music = {
  play(track, queue) { const q = queue || [track]; load(track, q, Math.max(0, q.findIndex((x) => x.id === track.id))); },
  toggle() { const m = state.music; if (!m.track) return; const a = el(); if (a.paused) { if (!a.getAttribute('src')) load(m.track, m.queue, m.index); else a.play().catch(() => {}); } else a.pause(); },
  next: () => next(false),
  prev() { const m = state.music; if (audio && audio.currentTime > 3) return music.seek(0); if (m.index > 0) load(m.queue[m.index - 1], m.queue, m.index - 1); else music.seek(0); },
  seek(sec) { const a = el(); a.currentTime = Math.max(0, sec); setMusic({ position: a.currentTime }); syncListening(true); },
  volume(v) { const x = Math.min(1, Math.max(0, v)); if (audio) audio.volume = x; ls('musicVolume', null, x); setMusic({ volume: x }); },
  stop({ silent = false } = {}) {
    reqId++; teardown();
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
    if (!query) { setMusic({ results: null, error: null }); return; }
    setMusic({ searching: true, error: null });
    try { const r = await api.get(`/music/search?q=${encodeURIComponent(query)}`); if (state.music.query === query) setMusic({ results: r.tracks, searching: false }); } catch (e) { if (state.music.query === query) setMusic({ results: [], searching: false, error: e.message }); }
  },
};
function next(auto) {
  const m = state.music;
  if (m.index + 1 < m.queue.length) load(m.queue[m.index + 1], m.queue, m.index + 1);
  else if (auto) { setMusic({ playing: false, position: 0 }); clearListening(); } else music.seek(0);
}
export const stopMusic = (opts) => music.stop(opts);
// a track that finished while the tab was asleep, or Activity Status switched back on mid-song
setInterval(() => { if (state.music?.playing) syncListening(); }, 20_000);

/* ------------------------------------------------------------------ pieces */
const clock = (s) => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
function Art({ src, size = 44, playing }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  return html`<span class=${cx('m-art', playing && 'on')} style=${{ width: size + 'px', height: size + 'px' }}>${src && !broken ? html`<img src=${size <= 64 ? src.replace('/300x300bb.', '/100x100bb.') : src} alt="" decoding="async" referrerpolicy="no-referrer" draggable=${false} onError=${() => setBroken(true)} />` : html`<${Icon} name="music" size=${Math.round(size * 0.45)} />`}${playing ? html`<span class="eq sm"><i></i><i></i><i></i><i></i></span>` : null}</span>`;
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
function Cover({ src, playing }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  return html`<span class=${cx('m-art cover', playing && 'on')}>${src && !broken ? html`<img src=${src} alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" draggable=${false} onError=${() => setBroken(true)} />` : html`<${Icon} name="music" size=${34} />`}${playing ? html`<span class="eq"><i></i><i></i><i></i><i></i></span>` : null}</span>`;
}

/** What is playing, big, with the controls. Shown above everything else on the page. */
function Hero() {
  const track = useSel((s) => s.music.track); const playing = useSel((s) => s.music.playing); const volume = useSel((s) => s.music.volume);
  const show = useSel((s) => s.settings.privacy?.showActivity !== false);
  if (!track) return html`<section class="mpg-hero empty"><span class="mpg-hero-ico"><${Icon} name="music" size=${34} sw=${1.6} /></span>
    <div><h1>${t('Music')}</h1><p>${t('Search Apple Music or pick a category below and hear a 30-second preview. What you play can show on your profile.')}</p></div></section>`;
  return html`<section class="mpg-hero" style=${track.artwork ? { '--cover': `url("${track.artwork}")` } : null}>
    <div class="mpg-hero-art"><${Cover} src=${track.artwork} playing=${playing} /></div>
    <div class="mpg-now">
      <span class="m-chip">${t('30-second preview')}</span>
      <h2 title=${track.title}>${track.title}</h2>
      <a class="mpg-artist" href=${track.artistUrl || track.url} target="_blank" rel="noopener noreferrer">${track.artist}</a>
      ${track.album ? html`<small class="mpg-album">${track.album}</small>` : null}
      <${Progress} />
      <${Controls} big=${true} />
      <div class="m-extra">
        <label class="m-vol"><${Icon} name=${volume === 0 ? 'volume-x' : volume < 0.5 ? 'volume-1' : 'volume'} size=${18} />
          <input type="range" min="0" max="1" step="0.01" value=${volume} style=${{ '--p': `${volume * 100}%` }} aria-label=${t('Volume')} onInput=${(e) => music.volume(Number(e.target.value))} /></label>
        <label class="m-share" data-tip=${t('Show what you’re listening to on your profile')}><span>${t('Show on my profile')}</span><${Toggle} checked=${show} onChange=${(v) => { setSetting('privacy.showActivity', v); if (v) setTimeout(() => syncListening(true), 50); }} /></label>
      </div>
      ${track.url ? html`<div class="m-credit"><a href=${track.url} target="_blank" rel="noopener noreferrer">${t('Get the full track on')} Apple Music <${Icon} name="external" size=${12} /></a></div>` : null}
    </div>
  </section>`;
}

/** Songs as a grid of covers; clicking one plays it (and queues the rest of the grid after it). */
function TrackGrid({ tracks }) {
  const cur = useSel((s) => s.music.track?.id); const playing = useSel((s) => s.music.playing);
  return html`<div class="mpg-grid">${tracks.map((tr) => html`<button type="button" key=${tr.id} class=${cx('mpg-card', cur === tr.id && 'cur')} onClick=${() => (cur === tr.id ? music.toggle() : music.play(tr, tracks))} title=${`${tr.title} — ${tr.artist}`}>
    <span class="mpg-cover"><${Cover} src=${tr.artwork} playing=${cur === tr.id && playing} /><span class="mpg-play"><${Icon} name=${cur === tr.id && playing ? 'pause' : 'play'} size=${20} fill=${true} sw=${1} /></span></span>
    <b>${tr.title}</b><small>${tr.artist}</small></button>`)}</div>`;
}

function Categories() {
  const genres = useSel((s) => s.music.genres); const cat = useSel((s) => s.music.category);
  const list = genres || [{ key: 'top', name: 'Top Songs' }];
  return html`<div class="mpg-chips" role="tablist" aria-label=${t('Categories')}>${list.map((g) => html`<button type="button" role="tab" key=${g.key} aria-selected=${cat === g.key} class=${cx('mpg-chip', cat === g.key && 'on')} onClick=${() => music.openChart(g.key)}>${g.name}</button>`)}</div>`;
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
  const results = useSel((s) => s.music.results); const searching = useSel((s) => s.music.searching); const error = useSel((s) => s.music.error); const query = useSel((s) => s.music.query);
  return html`<section class="mpg-section"><h3>${t('Results for')} “${query}”</h3>
    ${searching && !results ? html`<div class="pk-center"><${Spinner} /></div>`
      : error && !results?.length ? html`<div class="m-empty"><${Icon} name="alert-circle" size=${28} /><p>${error}</p></div>`
        : !results?.length ? html`<div class="m-empty"><p>${t('Nothing found. Try another search.')}</p></div>`
          : html`<${TrackGrid} tracks=${results} />`}
  </section>`;
}

/** The Music page (`/music`): search, what is playing, categories of top songs and what you played recently. */
export function MusicPage() {
  const ok = useSel((s) => s.musicOk); const query = useSel((s) => s.music.query);
  const [q, setQ] = useState(query); const timer = useRef(null);
  useEffect(() => { if (ok !== false) { music.loadGenres(); music.openChart(state.music.category || 'top'); } }, [ok]);
  const typing = (v) => { setQ(v); clearTimeout(timer.current); timer.current = setTimeout(() => music.search(v), 450); };
  const searching = !!query.trim();
  return html`<main class="main panel music-page view-anim">
    <header class="m-header">
      <button type="button" class="mobile-only icon-btn" onClick=${() => set({ mobileNav: true })} aria-label=${t('Menu')}><${Icon} name="menu" size=${22} /></button>
      <div class="m-title"><${Icon} name="music" size=${23} /><span class="name">${t('Music')}</span></div>
      <div class="m-topic">${t('via')} <a href="https://music.apple.com" target="_blank" rel="noopener noreferrer">Apple Music</a></div>
    </header>
    <div class="mpg-scroll">
      ${ok === false ? html`<div class="m-empty setup"><${Icon} name="music" size=${34} sw=${1.5} /><b>${t('Music is turned off on this server')}</b><p>${t('The server admin switched the music player off.')}</p></div>` : html`
        <div class="mpg-search"><div class="input-wrap"><${Icon} name="search" size=${18} /><input class="input" placeholder=${t('Search songs and artists…')} value=${q} onInput=${(e) => typing(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') { clearTimeout(timer.current); music.search(q); } }} />
          ${q ? html`<button type="button" class="mpg-clear" aria-label=${t('Clear')} onClick=${() => { setQ(''); clearTimeout(timer.current); music.search(''); }}><${Icon} name="x" size=${16} /></button>` : null}</div></div>
        <${Hero} />
        ${searching ? html`<${SearchResults} />` : html`<${Categories} /><${Chart} /><${Recent} />`}`}
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

/** "Listening on Apple Music" on a profile. `listening` = { title, artist, artwork, url, duration, startedAt, endsAt } (milliseconds). */
export function ListeningCard({ listening: l }) {
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(id); }, []);
  if (!l || l.endsAt < Date.now()) return null;
  const pos = Math.min(l.duration, Math.max(0, Date.now() - l.startedAt));
  return html`<div class="listening-card">
    <h5><${Icon} name="music" size=${13} /> ${t('Listening on Apple Music')}</h5>
    <div class="lc-row"><${Art} src=${l.artwork} size=${60} playing=${true} />
      <div class="lc-text">${l.url ? html`<a class="lc-title" href=${l.url} target="_blank" rel="noopener noreferrer" title=${l.title}>${l.title}</a>` : html`<b class="lc-title">${l.title}</b>`}<small>${l.artist}</small>
        <div class="lc-bar"><span>${clock(pos / 1000)}</span><i><b style=${{ width: `${(pos / l.duration) * 100}%` }}></b></i><span>${clock(l.duration / 1000)}</span></div></div></div>
  </div>`;
}
/** What the signed-in user is playing right now, shaped like a `listening` status (their own is never hidden from themselves). */
export function myListening() {
  const m = state.music; if (!m?.playing || !m.track) return null;
  const now = Date.now(); const pos = m.position * 1000; const dur = Math.max(1, m.duration || PREVIEW_SECONDS) * 1000;
  return { id: m.track.id, title: m.track.title, artist: m.track.artist, artwork: m.track.artwork, url: m.track.url, duration: dur, startedAt: now - pos, endsAt: now + (dur - pos) };
}
