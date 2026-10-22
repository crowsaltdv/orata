// Orata — music: the Music page (/music, opened from the note icon above Home) with YouTube Music search, top-song categories and a full-song player, a mini player, and the "Listening to" card shown on profiles.
// The server talks to YouTube Music (see server/music.js); songs play in YouTube's embedded player.
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
// Songs play in YouTube's official embedded player, driven over its postMessage interface (the same one the IFrame API script uses, so no
// third-party script runs on Orata's page). The player is one iframe that lives for the whole session: on the Music page it sits in the
// Now-playing card; elsewhere it floats in a small window in the corner. Moving it is done with CSS only, so playback never restarts.
const YT = 'https://www.youtube.com';
let host = null; let frame = null; let ready = false; let pending = []; let handshake = 0; let ytState = null; let dockEl = null; let raf = 0;
let reqId = 0; let lastSync = 0; let loadedAt = 0;
const trackSeconds = (track) => Math.round((track?.duration || 0) / 1000) || 210;   // until the player knows the real length
// The server fills in the title, artist and artwork itself (from what YouTube Music told it); the player only says which song, how long and where it is.
const listeningBody = (m) => ({ track: { id: m.track.id }, duration: Math.round(Math.max(1, m.duration || trackSeconds(m.track)) * 1000), position: Math.round((m.position || 0) * 1000) });
/** Tells the server what is playing (it shows on the profile) — never when Activity Status is off. */
function syncListening(force = false) {
  const m = state.music;
  if (!m.track || !state.token || state.settings.privacy?.showActivity === false) return;
  if (!force && Date.now() - lastSync < 2000) return;
  lastSync = Date.now();
  api.put('/me/listening', listeningBody(m)).catch(() => {});
}
function clearListening() { lastSync = 0; if (state.token) api.del('/me/listening').catch(() => {}); }

const svg = (d) => `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
function ensureHost() {
  if (host) return host;
  host = document.createElement('div'); host.className = 'yt-host'; host.hidden = true;
  host.innerHTML = `<div class="yt-bar"><button type="button" class="yt-btn" data-act="open" title="${t('Open music')}" aria-label="${t('Open music')}">${svg('<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>')}</button>
    <button type="button" class="yt-btn" data-act="stop" title="${t('Stop')}" aria-label="${t('Stop')}">${svg('<path d="M18 6 6 18M6 6l12 12"/>')}</button></div><div class="yt-slot"></div>`;
  host.addEventListener('click', (e) => { const act = e.target.closest('[data-act]')?.dataset.act; if (act === 'open') openMusic(); else if (act === 'stop') music.stop(); });
  document.body.appendChild(host);
  return host;
}
const post = (msg) => frame?.contentWindow?.postMessage(JSON.stringify({ ...msg, id: 1, channel: 'widget' }), YT);
/** Sends a player command; until the player has said it is ready, commands wait. */
function send(func, ...args) { if (ready) post({ event: 'command', func, args }); else pending.push([func, args]); }
function makeFrame(videoId) {
  ensureHost(); frame?.remove(); ready = false; pending = []; ytState = null; clearInterval(handshake);
  frame = document.createElement('iframe');
  frame.src = `${YT}/embed/${encodeURIComponent(videoId)}?enablejsapi=1&autoplay=1&playsinline=1&rel=0&iv_load_policy=3&origin=${encodeURIComponent(location.origin)}`;
  frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen'; frame.title = t('YouTube Music player');
  frame.referrerPolicy = 'strict-origin-when-cross-origin';   // the embed needs to know which site it is on (Orata itself sends no referrer)
  frame.addEventListener('load', () => {   // "listening" asks the player to report to us; repeated until it answers
    let n = 0; clearInterval(handshake);
    handshake = setInterval(() => { if (ready || ++n > 40) { clearInterval(handshake); return; } post({ event: 'listening' }); }, 250);
  });
  host.querySelector('.yt-slot').appendChild(frame);
  place();
}
function killFrame() { clearInterval(handshake); frame?.remove(); frame = null; ready = false; pending = []; ytState = null; place(); }

function onState(s) {
  if (s === 0 && Date.now() - loadedAt < 1500) return;   // a late "ended" from the song before
  if (s === ytState) return; ytState = s;
  if (s === 1) { setMusic({ playing: true, loading: false, error: null }); syncListening(true); }   // playing
  else if (s === 2) { if (state.music.track) { setMusic({ playing: false, loading: false }); clearListening(); } }   // paused
  else if (s === 3) setMusic({ loading: true });   // buffering
  else if (s === 0) next(true);   // ended
  else if (s === 5) setMusic({ loading: false });   // cued: the browser didn't allow autoplay — the play button (or the video itself) starts it
}
function onInfo(info) {
  const m = state.music; const patch = {};
  if (Number.isFinite(info.duration) && info.duration > 0 && Math.abs(info.duration - m.duration) > 0.5) patch.duration = info.duration;
  if (Number.isFinite(info.currentTime) && Math.abs(info.currentTime - m.position) >= 0.25) patch.position = info.currentTime;
  if (Object.keys(patch).length) setMusic(patch);
  if (Number.isInteger(info.playerState)) onState(info.playerState);
}
window.addEventListener('message', (e) => {
  if (e.origin !== YT || !frame || e.source !== frame.contentWindow) return;
  let d; try { d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
  if (!d || typeof d !== 'object') return;
  if (d.event === 'onReady' && !ready) {
    ready = true; clearInterval(handshake);
    post({ event: 'command', func: 'addEventListener', args: ['onStateChange'] }); post({ event: 'command', func: 'addEventListener', args: ['onError'] });
    post({ event: 'command', func: 'setVolume', args: [Math.round(state.music.volume * 100)] });
    for (const [func, args] of pending.splice(0)) post({ event: 'command', func, args });
  } else if (d.event === 'infoDelivery' && d.info) onInfo(d.info);
  else if (d.event === 'onStateChange') onState(Number(d.info));
  else if (d.event === 'onError') {   // 2: bad id, 5: player problem, 100: removed or private, 101/150: the owner doesn't allow playing it on other sites
    const id = reqId;
    fail(Number(d.info) === 101 || Number(d.info) === 150 ? t('This song can’t be played outside YouTube. Skipping…') : t('Couldn’t play this track.'));
    setTimeout(() => id === reqId && next(true), 1500);
  }
});

/** Where the player is shown: over `dockEl` (the Now-playing card) when there is one, otherwise floating in the corner. */
function place() {
  cancelAnimationFrame(raf);
  if (!host) return;
  host.hidden = !frame || !state.music.track;
  const docked = !!(dockEl?.isConnected && !host.hidden);
  host.classList.toggle('docked', docked); host.classList.toggle('floating', !docked);
  if (!docked) { host.style.cssText = ''; return; }
  const r = dockEl.getBoundingClientRect(); const clip = dockEl.closest('.mpg-scroll')?.getBoundingClientRect();
  const top = clip ? Math.max(0, clip.top - r.top) : 0; const bottom = clip ? Math.max(0, r.bottom - clip.bottom) : 0;
  host.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;clip-path:inset(${top}px 0 ${bottom}px 0 round 14px);${top + bottom >= r.height ? 'visibility:hidden;' : ''}`;
  raf = requestAnimationFrame(place);   // follows the card while the page scrolls or resizes
}
/** The Now-playing card registers its video slot here. */
export function dockPlayer(el) { dockEl = el; place(); }

function fail(message) {
  setMusic({ playing: false, loading: false, error: message }); clearListening();
  toast(message, 'error', 4000);
}
function load(track, queue, index) {
  reqId++;
  setMusic({ track, queue: queue || state.music.queue, index: index ?? state.music.index, loading: true, playing: false, position: 0, duration: trackSeconds(track), error: null });
  pushRecent(track);
  ytState = null; loadedAt = Date.now();
  if (!frame) makeFrame(track.id); else { send('loadVideoById', { videoId: track.id, startSeconds: 0 }); place(); }
}
export const music = {
  play(track, queue) { const q = queue || [track]; load(track, q, Math.max(0, q.findIndex((x) => x.id === track.id))); },
  toggle() { const m = state.music; if (!m.track) return; if (!frame) load(m.track, m.queue, m.index); else if (m.playing) send('pauseVideo'); else send('playVideo'); },
  next: () => next(false),
  prev() { const m = state.music; if (m.position > 3) return music.seek(0); if (m.index > 0) load(m.queue[m.index - 1], m.queue, m.index - 1); else music.seek(0); },
  seek(sec) { const s = Math.max(0, sec); send('seekTo', s, true); setMusic({ position: s }); syncListening(true); },
  volume(v) { const x = Math.min(1, Math.max(0, v)); send('setVolume', Math.round(x * 100)); ls('musicVolume', null, x); setMusic({ volume: x }); },
  stop({ silent = false } = {}) {
    reqId++; killFrame();
    if (!silent) clearListening();
    setMusic({ track: null, queue: [], index: -1, playing: false, loading: false, position: 0, duration: 0, error: null });
    place();
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
  return html`<span class=${cx('m-art', playing && 'on')} style=${{ width: size + 'px', height: size + 'px' }}>${src && !broken ? html`<img src=${size <= 64 ? src.replace(/=w\d+-h\d+/, '=w120-h120') : src} alt="" decoding="async" referrerpolicy="no-referrer" draggable=${false} onError=${() => setBroken(true)} />` : html`<${Icon} name="music" size=${Math.round(size * 0.45)} />`}${playing ? html`<span class="eq sm"><i></i><i></i><i></i><i></i></span>` : null}</span>`;
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

/** Where the player docks on the Music page (the iframe itself lives outside the page so it never reloads). */
function VideoSlot() {
  const ref = useRef(null);
  useEffect(() => { dockPlayer(ref.current); return () => dockPlayer(null); }, []);
  return html`<div class="mpg-hero-art video" ref=${ref}></div>`;
}

/** What is playing, big, with the controls. Shown above everything else on the page. */
function Hero() {
  const track = useSel((s) => s.music.track); const playing = useSel((s) => s.music.playing); const volume = useSel((s) => s.music.volume);
  const show = useSel((s) => s.settings.privacy?.showActivity !== false);
  if (!track) return html`<section class="mpg-hero empty"><span class="mpg-hero-ico"><${Icon} name="music" size=${34} sw=${1.6} /></span>
    <div><h1>${t('Music')}</h1><p>${t('Search YouTube Music or pick a category below and play full songs. What you play can show on your profile.')}</p></div></section>`;
  return html`<section class="mpg-hero" style=${track.artwork ? { '--cover': `url("${track.artwork}")` } : null}>
    <${VideoSlot} />
    <div class="mpg-now">
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
      ${track.url ? html`<div class="m-credit"><a href=${track.url} target="_blank" rel="noopener noreferrer">${t('Open in')} YouTube Music <${Icon} name="external" size=${12} /></a></div>` : null}
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
      <div class="m-topic">${t('via')} <a href="https://music.youtube.com" target="_blank" rel="noopener noreferrer">YouTube Music</a></div>
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

/** "Listening on YouTube Music" on a profile. `listening` = { title, artist, artwork, url, duration, startedAt, endsAt } (milliseconds). */
export function ListeningCard({ listening: l }) {
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(id); }, []);
  if (!l || l.endsAt < Date.now()) return null;
  const pos = Math.min(l.duration, Math.max(0, Date.now() - l.startedAt));
  return html`<div class="listening-card">
    <h5><${Icon} name="music" size=${13} /> ${t('Listening on YouTube Music')}</h5>
    <div class="lc-row"><${Art} src=${l.artwork} size=${60} playing=${true} />
      <div class="lc-text">${l.url ? html`<a class="lc-title" href=${l.url} target="_blank" rel="noopener noreferrer" title=${l.title}>${l.title}</a>` : html`<b class="lc-title">${l.title}</b>`}<small>${l.artist}</small>
        <div class="lc-bar"><span>${clock(pos / 1000)}</span><i><b style=${{ width: `${(pos / l.duration) * 100}%` }}></b></i><span>${clock(l.duration / 1000)}</span></div></div></div>
  </div>`;
}
/** What the signed-in user is playing right now, shaped like a `listening` status (their own is never hidden from themselves). */
export function myListening() {
  const m = state.music; if (!m?.playing || !m.track) return null;
  const now = Date.now(); const pos = m.position * 1000; const dur = Math.max(1, m.duration || trackSeconds(m.track)) * 1000;
  return { id: m.track.id, title: m.track.title, artist: m.track.artist, artwork: m.track.artwork, url: m.track.url, duration: dur, startedAt: now - pos, endsAt: now + (dur - pos) };
}
