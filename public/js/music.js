// Orata — music: the Music page (/music, opened from the note icon above Home) with search, categories and a full-song player, a mini player, and the "Listening to" card shown on profiles.
// The server finds the songs (see server/music.js); the browser plays them in an embedded player that is kept out of sight (see youtube-player.js).
// Long lists (a genre, a search) come a page at a time as you scroll. The library shows as List (three columns of song cards, the default) or Grid
// (covers), your pick kept with your account (settings.music.view).
import { html, useState, useEffect, useRef, cx, ls } from '/js/lib.js';
import { state, set, useSel, toast, setSetting, updateSettings, go, closePopover, openContext } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { Spinner, IconBtn, Toggle } from '/js/ui.js';
import { api } from '/js/api.js';
import { t } from '/js/i18n.js';
import { createPlayer } from '/js/youtube-player.js';
import { ArtistLinks, AlbumLink, ArtistView, AlbumView, PlaylistView, SharedPlaylistView, PlaylistsSection, openAddMenu, openSongMenu, openArtist, back } from '/js/music-pages.js';
import { GuessView } from '/js/song-guess.js';
import { canVisualize, openVisualizer } from '/js/visualizer.js';

const setMusic = (patch) => set({ music: { ...state.music, ...patch } });
export const openMusic = () => go('/music');
/** The last tracks you played, newest first (kept in this browser). */
function pushRecent(track) {
  const recent = [track, ...(state.music.recent || []).filter((x) => x.id !== track.id)].slice(0, 20);
  setMusic({ recent }); ls('musicRecentYT', null, recent);
}
const uniq = (list) => { const seen = new Set(); return list.filter((x) => x && !seen.has(x.id) && seen.add(x.id)); };
/** `list` in a random order (Fisher–Yates), `first` (when given) staying first. */
const shuffleOrder = (list, first) => {
  const rest = list.filter((x) => x.id !== first?.id);
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  return first ? [first, ...rest] : rest;
};

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
  player.volume(state.music.muted ? 0 : state.music.volume);
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
/** Every song in your playlists plus what you played lately: what "Shuffle library" picks from. */
async function libraryTracks() {
  let lib = []; try { lib = (await api.get('/me/library')).tracks; } catch { /* the recent songs still work */ }
  return uniq([...lib, ...(state.music.recent || [])]);
}
// The queue is the order songs play in. `orig` is the list it came from, in its own order, so turning shuffle off puts it back.
export const music = {
  play(track, list) {
    const m = state.music; const orig = list || [track];
    const queue = m.shuffle === 'off' ? orig : shuffleOrder(m.shuffle === 'library' && m.library?.length ? uniq([...orig, ...m.library]) : orig, track);
    setMusic({ orig }); load(track, queue, Math.max(0, queue.findIndex((x) => x.id === track.id)));
  },
  /** A whole list from its start, or shuffled. */
  playAll(list, { shuffle = false } = {}) {
    if (!list?.length) return;
    if (shuffle && state.music.shuffle === 'off') { ls('musicShuffle', null, 'playlist'); setMusic({ shuffle: 'playlist' }); }
    music.play(shuffle ? list[Math.floor(Math.random() * list.length)] : list[0], list);
  },
  toggle() {
    const m = state.music; if (!m.track) return;
    if (idle) load(m.track, m.queue, m.index); else if (m.playing) yt().pause(); else yt().play();
  },
  pause() { if (state.music.playing) yt().pause(); },
  resume() { const m = state.music; if (m.track && !m.playing) music.toggle(); },
  next: () => next(false),
  prev() {
    const m = state.music; if (m.position > 3) return music.seek(0);
    if (m.index > 0) load(m.queue[m.index - 1], m.queue, m.index - 1);
    else if (m.repeat === 'all' && m.queue.length > 1) load(m.queue[m.queue.length - 1], m.queue, m.queue.length - 1);
    else music.seek(0);
  },
  seek(sec) { if (idle) return; yt().seek(sec); setMusic({ position: Math.max(0, sec) }); syncListening(true); },
  volume(v) { const x = Math.min(1, Math.max(0, v)); if (player) player.volume(x); ls('musicVolume', null, x); setMusic({ volume: x, muted: false }); },
  toggleMute() { const m = state.music; const muted = !m.muted; player?.volume(muted ? 0 : m.volume); setMusic({ muted }); },
  /** 'off' (the list's own order), 'playlist' (the list in a random order) or 'library' (random songs from everything in your playlists). */
  async setShuffle(mode) {
    const library = mode === 'library' ? await libraryTracks() : state.music.library;
    if (mode === 'library' && !library.length) { toast(t('Add songs to a playlist first: library shuffle plays from them.'), 'info', 4000); return; }
    ls('musicShuffle', null, mode); setMusic({ shuffle: mode, library });
    const m = state.music; const cur = m.track; if (!cur) return;
    const orig = m.orig?.length ? m.orig : m.queue;
    const queue = mode === 'off' ? orig : shuffleOrder(mode === 'library' ? uniq([...orig, ...library]) : orig, cur);
    const index = queue.findIndex((x) => x.id === cur.id);
    setMusic(index < 0 ? { queue: [cur, ...queue], index: 0 } : { queue, index });
  },
  cycleRepeat() { const r = { off: 'all', all: 'one', one: 'off' }[state.music.repeat] || 'off'; ls('musicRepeat', null, r); setMusic({ repeat: r }); },
  /** Plays `track` right after the current one (or now, when nothing is playing). */
  playNext(track) {
    const m = state.music; if (!m.track) return music.play(track);
    if (track.id === m.track.id) return;
    const queue = m.queue.filter((x, i) => i <= m.index || x.id !== track.id); queue.splice(m.index + 1, 0, track);
    setMusic({ queue, orig: uniq([...(m.orig || []), track]) }); toast(`${t('Playing next:')} ${track.title}`, 'success', 1800);
  },
  addToQueue(track) {
    const m = state.music; if (!m.track) return music.play(track);
    if (!m.queue.some((x, i) => i > m.index && x.id === track.id)) setMusic({ queue: [...m.queue, track], orig: uniq([...(m.orig || []), track]) });
    toast(`${t('Added to the queue:')} ${track.title}`, 'success', 1800);
  },
  removeFromQueue(i) { const m = state.music; if (i === m.index || i < 0 || i >= m.queue.length) return; setMusic({ queue: m.queue.filter((_, j) => j !== i), index: i < m.index ? m.index - 1 : m.index }); },
  jumpTo(i) { const m = state.music; if (m.queue[i]) load(m.queue[i], m.queue, i); },
  clearQueue() { const m = state.music; if (m.track) setMusic({ queue: [m.track], index: 0, orig: [m.track] }); },
  stop({ silent = false } = {}) {
    reqId++; idle = true; clearTimeout(watchdog); player?.stop();
    if (!silent) clearListening();
    setMusic({ track: null, queue: [], orig: [], index: -1, playing: false, loading: false, position: 0, duration: 0, error: null });
  },
  async loadGenres() {
    if (state.music.genres) return;
    try { setMusic({ genres: (await api.get('/music/charts')).genres }); } catch { /* the page still works with just "Top Songs" */ }
  },
  async openChart(key, retry = false) {
    setMusic({ category: key });
    if (state.music.charts[key] && !retry) return;
    setMusic({ chartLoading: true, chartError: null });
    try {
      const r = await api.get(`/music/charts/${encodeURIComponent(key)}?limit=60`);
      setMusic({ charts: { ...state.music.charts, [key]: r.tracks }, chartMore: { ...state.music.chartMore, [key]: !!r.hasMore }, chartLoading: state.music.category === key ? false : state.music.chartLoading });
    } catch (e) { if (state.music.category === key) setMusic({ chartLoading: false, chartError: e.message }); }
  },
  /** The next page of a category, when you scroll near the end of it. */
  async moreChart(key) {
    const m = state.music; if (!m.chartMore?.[key] || busy.has(`c:${key}`)) return;
    busy.add(`c:${key}`); setMusic({ loadingMore: true });
    try {
      const have = m.charts[key] || []; const r = await api.get(`/music/charts/${encodeURIComponent(key)}?offset=${have.length}&limit=60`);
      setMusic({ charts: { ...state.music.charts, [key]: uniq([...(state.music.charts[key] || []), ...r.tracks]) }, chartMore: { ...state.music.chartMore, [key]: !!r.hasMore } });
    } catch (e) { toast(e.message, 'error'); } finally { busy.delete(`c:${key}`); setMusic({ loadingMore: false }); }
  },
  async search(q) {
    const query = q.trim(); setMusic({ query });
    if (!query) { setMusic({ results: null, resultsMore: false, artists: [], error: null }); return; }
    setMusic({ searching: true, error: null });
    try { const r = await api.get(`/music/search?q=${encodeURIComponent(query)}`); if (state.music.query === query) setMusic({ results: r.tracks, resultsMore: !!r.hasMore, artists: r.artists || [], searching: false }); }
    catch (e) { if (state.music.query === query) setMusic({ results: [], resultsMore: false, searching: false, error: e.message }); }
  },
  /** More results for the current search (the whole catalogue, not just what loaded first). */
  async moreSearch() {
    const m = state.music; const query = m.query; if (!m.resultsMore || !query || busy.has('search')) return;
    busy.add('search'); setMusic({ loadingMore: true });
    try {
      const r = await api.get(`/music/search?q=${encodeURIComponent(query)}&offset=${(m.results || []).length}`);
      if (state.music.query === query) setMusic({ results: uniq([...(state.music.results || []), ...r.tracks]), resultsMore: !!r.hasMore });
    } catch (e) { toast(e.message, 'error'); } finally { busy.delete('search'); setMusic({ loadingMore: false }); }
  },
};
const busy = new Set();   // pages being fetched right now
function next(auto) {
  const m = state.music;
  if (auto && m.repeat === 'one') { yt().seek(0); yt().play(); return; }
  if (m.index + 1 < m.queue.length) return load(m.queue[m.index + 1], m.queue, m.index + 1);
  if (m.repeat === 'all' && m.queue.length) { const queue = m.shuffle === 'off' ? m.queue : shuffleOrder(m.queue); return load(queue[0], queue, 0); }
  if (auto) { idle = true; setMusic({ playing: false, loading: false, position: 0 }); clearListening(); } else music.seek(0);
}
export const stopMusic = (opts) => music.stop(opts);
// a track that finished while the tab was asleep, or Activity Status switched back on mid-song
setInterval(() => { if (state.music?.playing) syncListening(); }, 20_000);

/* ------------------------------------------------------------------ pieces */
export const clock = (s) => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
/** A colour of its own for a song without a cover, so a list of them isn't a wall of grey. */
const hue = (id = '') => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
export function Art({ src, size = 44, playing, seed }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  const bare = !src || broken;
  return html`<span class=${cx('m-art', playing && 'on')} style=${{ width: size + 'px', height: size + 'px', ...(bare && seed ? { background: `linear-gradient(135deg, hsl(${hue(seed)} 45% 38%), hsl(${(hue(seed) + 50) % 360} 50% 22%))`, color: 'rgb(255 255 255 / .8)' } : null) }}>${!bare ? html`<img src=${size <= 64 ? src.replace('=w400-h400', '=w120-h120') : src} alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" draggable=${false} onError=${() => setBroken(true)} />` : html`<${Icon} name="music" size=${Math.round(size * 0.45)} />`}${playing ? html`<span class="eq sm"><i></i><i></i><i></i><i></i></span>` : null}</span>`;
}
/** Where the song playing is: the time, a bar to seek with and its length (the big player and the row of the song playing in a list). */
export function Progress() {
  const pos = useSel((s) => s.music.position); const dur = useSel((s) => s.music.duration);
  const [drag, setDrag] = useState(null);
  const shown = drag ?? pos;
  return html`<div class="m-progress"><span>${clock(shown)}</span>
    <input type="range" min="0" max=${Math.max(1, dur)} step="0.5" value=${shown} style=${{ '--p': `${Math.min(100, (shown / Math.max(1, dur)) * 100)}%` }} aria-label=${t('Seek')}
      onInput=${(e) => setDrag(Number(e.target.value))} onChange=${(e) => { music.seek(Number(e.target.value)); setDrag(null); }} />
    <span>${clock(dur)}</span></div>`;
}
const SHUFFLE = { off: 'Shuffle off', playlist: 'Shuffle playlist', library: 'Shuffle library' };
function shuffleMenu(e) {
  const r = e.currentTarget.getBoundingClientRect(); const cur = state.music.shuffle;
  openContext({ clientX: r.left, clientY: r.bottom + 4, preventDefault() {}, stopPropagation() {} }, Object.entries(SHUFFLE).map(([k, label]) => ({ label: t(label), icon: cur === k ? 'check' : k === 'off' ? 'x' : 'shuffle', onClick: () => music.setShuffle(k) })));
}
function Controls({ big }) {
  const playing = useSel((s) => s.music.playing); const loading = useSel((s) => s.music.loading);
  const shuffle = useSel((s) => s.music.shuffle); const repeat = useSel((s) => s.music.repeat);
  const sz = big ? 22 : 18;
  return html`<div class=${cx('m-controls', big && 'big')}>
    ${big ? html`<${IconBtn} icon="shuffle" class=${cx('m-mode', shuffle !== 'off' && 'on')} label=${`${t(SHUFFLE[shuffle] || 'Shuffle off')} · ${t('click to change')}`} size=${18} glass=${null} onClick=${shuffleMenu} />` : null}
    <${IconBtn} icon="skip-back" label=${t('Previous')} size=${sz} glass=${null} onClick=${music.prev} />
    <button type="button" class="m-play" aria-label=${playing ? t('Pause') : t('Play')} onClick=${music.toggle}>${loading && !playing ? html`<${Spinner} size=${big ? 20 : 16} />` : html`<${Icon} name=${playing ? 'pause' : 'play'} size=${big ? 24 : 18} fill=${true} sw=${1} />`}</button>
    <${IconBtn} icon="skip-forward" label=${t('Next')} size=${sz} glass=${null} onClick=${music.next} />
    ${big ? html`<${IconBtn} icon=${repeat === 'one' ? 'repeat-1' : 'repeat'} class=${cx('m-mode', repeat !== 'off' && 'on')} label=${repeat === 'one' ? t('Repeating this song') : repeat === 'all' ? t('Repeating the list') : t('Repeat off')} size=${18} glass=${null} onClick=${music.cycleRepeat} />` : null}
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
  const track = useSel((s) => s.music.track); const playing = useSel((s) => s.music.playing); const volume = useSel((s) => s.music.volume); const muted = useSel((s) => s.music.muted);
  const show = useSel((s) => s.settings.privacy?.showActivity !== false); const queueOpen = useSel((s) => s.music.showQueue); const me = useSel((s) => s.me);
  if (!track) return html`<section class="mpg-hero empty"><span class="mpg-hero-ico"><${Icon} name="music" size=${34} sw=${1.6} /></span>
    <div><h1>${t('Music')}</h1><p>${t('Search for songs or pick a category below and play them in full. What you play can show on your profile.')}</p></div></section>`;
  const vol = muted ? 0 : volume;
  return html`<section class="mpg-hero" style=${track.artwork ? { '--cover': `url("${track.artwork}")` } : null}>
    <div class="mpg-hero-art"><${Cover} src=${track.artwork} playing=${playing} /></div>
    <div class="mpg-now">
      <h2 title=${track.title}>${track.title}</h2>
      <div class="mpg-artist"><${ArtistLinks} track=${track} /></div>
      ${track.album ? html`<small class="mpg-album"><${AlbumLink} track=${track} /></small>` : null}
      <${Progress} />
      <${Controls} big=${true} />
      <div class="m-extra">
        <span class="m-vol"><button type="button" class="m-mute" aria-label=${muted ? t('Unmute') : t('Mute')} data-tip=${muted ? t('Unmute') : t('Mute')} onClick=${music.toggleMute}><${Icon} name=${vol === 0 ? 'volume-x' : vol < 0.5 ? 'volume-1' : 'volume'} size=${18} /></button>
          <input type="range" min="0" max="1" step="0.01" value=${vol} style=${{ '--p': `${vol * 100}%` }} aria-label=${t('Volume')} onInput=${(e) => music.volume(Number(e.target.value))} /></span>
        <button type="button" class=${cx('m-addpl', queueOpen && 'on')} onClick=${() => setMusic({ showQueue: !queueOpen })}><${Icon} name="list-music" size=${16} /> ${t('Queue')}</button>
        <button type="button" class="m-addpl" onClick=${(e) => openAddMenu(e, track)}><${Icon} name="plus" size=${16} sw=${2.4} /> ${t('Add to playlist')}</button>
        ${canVisualize(me) ? html`<button type="button" class="m-addpl" onClick=${openVisualizer}><${Icon} name="sparkles" size=${16} /> ${t('Visualizer')}</button>` : null}
        <label class="m-share" data-tip=${t('Show what you’re listening to on your profile')}><span>${t('Show on my profile')}</span><${Toggle} checked=${show} onChange=${(v) => { setSetting('privacy.showActivity', v); if (v) setTimeout(() => syncListening(true), 50); }} /></label>
      </div>
    </div>
  </section>`;
}

/** What plays next: jump to a song, take one out, or clear it. */
function QueuePanel() {
  const queue = useSel((s) => s.music.queue); const index = useSel((s) => s.music.index); const shuffle = useSel((s) => s.music.shuffle);
  const upNext = queue.slice(index + 1, index + 101);
  return html`<section class="mpg-section mpg-queue slide-down"><h3 class="mpg-h"><span>${t('Up next')}${shuffle !== 'off' ? html` <small class="mpg-tag">${t(SHUFFLE[shuffle])}</small>` : null}</span>
      ${upNext.length ? html`<button type="button" class="link-btn" onClick=${music.clearQueue}>${t('Clear queue')}</button>` : null}</h3>
    ${upNext.length ? html`<div class="mpg-rows">${upNext.map((tr, k) => html`<div key=${`${tr.id}:${k}`} class="mpg-row" role="button" tabindex="0" onClick=${() => music.jumpTo(index + 1 + k)} onKeyDown=${(e) => { if (e.key === 'Enter') music.jumpTo(index + 1 + k); }}>
        <span class="mpg-n"><span class="num">${k + 1}</span><${Icon} name="play" size=${14} fill=${true} sw=${1} /></span><${Art} src=${tr.artwork} size=${40} seed=${tr.id} />
        <span class="mpg-rt"><b>${tr.title}</b><small>${tr.artist}</small></span><span class="mpg-rd">${tr.duration ? clock(tr.duration / 1000) : ''}</span>
        <button type="button" class="mpg-ib" data-tip=${t('Remove from the queue')} aria-label=${t('Remove from the queue')} onClick=${(e) => { e.stopPropagation(); music.removeFromQueue(index + 1 + k); }}><${Icon} name="x" size=${16} /></button></div>`)}
      ${queue.length - index - 1 > upNext.length ? html`<p class="mpg-hint">+ ${queue.length - index - 1 - upNext.length} ${t('more')}</p>` : null}</div>`
      : html`<p class="mpg-hint">${t('Nothing is lined up. Use “Play next” or “Add to queue” on any song.')}</p>`}
  </section>`;
}

/* ------------------------------------------------------------------ the library: List (three columns of song cards) or Grid (covers) */
const useLayout = () => useSel((s) => (s.settings.music?.view === 'covers' ? 'covers' : 'cards'));
function LayoutSwitch() {
  const layout = useLayout();
  const opt = (v, icon, label) => html`<button type="button" role="radio" aria-checked=${layout === v} class=${cx(layout === v && 'on')} onClick=${() => updateSettings({ music: { view: v } })} data-tip=${label} aria-label=${label}><${Icon} name=${icon} size=${16} /><span>${label}</span></button>`;
  return html`<div class=${cx('lay-switch', layout === 'covers' && 'second')} role="radiogroup" aria-label=${t('Layout')}><span class="lay-thumb" aria-hidden="true"></span>${opt('cards', 'list', t('List'))}${opt('covers', 'grid', t('Grid'))}</div>`;
}
/** List: a card per song in three columns, cover on the left, title and artist, length on the right. */
function TrackCard({ tr, list, cur, playing }) {
  const play = () => (cur ? music.toggle() : music.play(tr, list));
  return html`<div class=${cx('trk', cur && 'cur')} role="button" tabindex="0" onClick=${play} onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); play(); } }} onContextMenu=${(e) => { e.preventDefault(); openSongMenu(e, tr); }} title=${`${tr.title} — ${tr.artist}`}>
    <span class="trk-art"><${Art} src=${tr.artwork} size=${56} playing=${playing} seed=${tr.id} /><span class="trk-play"><${Icon} name=${playing ? 'pause' : 'play'} size=${18} fill=${true} sw=${1} /></span></span>
    <span class="trk-text"><b>${tr.title}</b><small>${tr.explicit ? html`<i class="mpg-e">E</i>` : null}${tr.artist}</small></span>
    <span class="trk-dur">${tr.duration ? clock(tr.duration / 1000) : ''}</span>
    <button type="button" class="trk-more" aria-label=${t('More options')} onClick=${(e) => { e.stopPropagation(); openSongMenu(e, tr); }}><${Icon} name="more-h" size=${18} /></button>
  </div>`;
}
/** Grid: the covers the library always had; clicking one plays it (and queues the rest after it). */
function TrackGrid({ tracks, cur, playing }) {
  return html`<div class="mpg-grid">${tracks.map((tr) => html`<div class="mpg-cell" key=${tr.id}>
    <button type="button" class=${cx('mpg-card', cur === tr.id && 'cur')} onClick=${() => (cur === tr.id ? music.toggle() : music.play(tr, tracks))} onContextMenu=${(e) => { e.preventDefault(); openSongMenu(e, tr); }} title=${`${tr.title} — ${tr.artist}`}>
      <span class="mpg-cover"><${Cover} src=${tr.artwork} playing=${cur === tr.id && playing} /><span class="mpg-play"><${Icon} name=${cur === tr.id && playing ? 'pause' : 'play'} size=${20} fill=${true} sw=${1} /></span></span>
      <b>${tr.title}</b><small>${tr.artist}</small></button>
    <button type="button" class="mpg-add" data-tip=${t('More options')} aria-label=${t('More options')} onClick=${(e) => openSongMenu(e, tr)}><${Icon} name="more-h" size=${16} sw=${2.6} /></button>
  </div>`)}</div>`;
}
function Skeletons({ layout, n = 6 }) {
  return html`<div class=${layout === 'cards' ? 'mpg-cards' : 'mpg-grid'} aria-hidden="true">${Array.from({ length: n }, (_, i) => (layout === 'cards'
    ? html`<div key=${i} class="trk skel"><span class="sk-art"></span><span class="sk-lines"><i></i><i></i></span></div>`
    : html`<div key=${i} class="mpg-card skel"><span class="sk-art"></span><span class="sk-lines"><i></i><i></i></span></div>`))}</div>`;
}
/** Songs in the chosen layout. Near the end of the list the next page loads (`onMore`), with placeholders while it does. */
function Tracks({ tracks, hasMore, loading, onMore }) {
  const layout = useLayout(); const end = useRef(null);
  const cur = useSel((s) => s.music.track?.id); const playing = useSel((s) => s.music.playing);
  useEffect(() => {
    if (!hasMore || !end.current || !onMore) return undefined;
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) onMore(); }, { root: end.current.closest('.mpg-scroll'), rootMargin: '700px 0px' });
    io.observe(end.current); return () => io.disconnect();
  }, [hasMore, tracks.length]);
  return html`${layout === 'cards' ? html`<div class="mpg-cards">${tracks.map((tr) => html`<${TrackCard} key=${tr.id} tr=${tr} list=${tracks} cur=${cur === tr.id} playing=${cur === tr.id && playing} />`)}</div>`
    : html`<${TrackGrid} tracks=${tracks} cur=${cur} playing=${playing} />`}
    ${loading ? html`<${Skeletons} layout=${layout} />` : null}
    ${hasMore ? html`<div class="mpg-end" ref=${end}></div>` : null}`;
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
  const loading = useSel((s) => s.music.chartLoading); const error = useSel((s) => s.music.chartError); const more = useSel((s) => !!s.music.chartMore?.[s.music.category]);
  const loadingMore = useSel((s) => s.music.loadingMore); const layout = useLayout();
  const name = genres?.find((g) => g.key === cat)?.name || t('Top Songs');
  return html`<section class="mpg-section"><h3 class="mpg-h"><span>${cat === 'top' ? name : `${t('Top')} ${name}`}</span>${tracks?.length ? html`<small class="mpg-count">${tracks.length}${more ? '+' : ''} ${t('songs')}</small>` : null}</h3>
    ${tracks?.length ? html`<${Tracks} key=${cat} tracks=${tracks} hasMore=${more} loading=${loadingMore} onMore=${() => music.moreChart(cat)} />`
      : loading || !error ? html`<${Skeletons} layout=${layout} n=${9} />`
        : html`<div class="m-empty"><${Icon} name="alert-circle" size=${28} /><p>${error}</p><button type="button" class="link-btn" onClick=${() => music.openChart(cat, true)}>${t('Try again')}</button></div>`}
  </section>`;
}

function Recent() {
  const recent = useSel((s) => s.music.recent);
  if (!recent?.length) return null;
  return html`<section class="mpg-section"><h3>${t('Recently played')}</h3><${Tracks} tracks=${recent.slice(0, 12)} /></section>`;
}

function SearchResults() {
  const results = useSel((s) => s.music.results); const artists = useSel((s) => s.music.artists); const searching = useSel((s) => s.music.searching); const error = useSel((s) => s.music.error); const query = useSel((s) => s.music.query);
  const more = useSel((s) => s.music.resultsMore); const loadingMore = useSel((s) => s.music.loadingMore); const layout = useLayout();
  return html`<section class="mpg-section"><h3>${t('Results for')} “${query}”</h3>
    ${artists?.length ? html`<div class="mpg-artists">${artists.map((a) => html`<button type="button" key=${a.id} class="mpg-artist-card" onClick=${() => openArtist(a.id)} title=${a.name}>
      <span class="ar-mini">${a.avatar ? html`<img src=${a.avatar} alt="" loading="lazy" referrerpolicy="no-referrer" draggable=${false} />` : html`<${Icon} name="user" size=${26} />`}</span><b>${a.name}</b><small>${t('Artist')}</small></button>`)}</div>` : null}
    ${searching && !results ? html`<${Skeletons} layout=${layout} n=${9} />`
      : error && !results?.length ? html`<div class="m-empty"><${Icon} name="alert-circle" size=${28} /><p>${error}</p></div>`
        : !results?.length ? html`<div class="m-empty"><p>${t('Nothing found. Try another search.')}</p></div>`
          : html`<${Tracks} tracks=${results} hasMore=${more} loading=${loadingMore} onMore=${music.moreSearch} />`}
  </section>`;
}

/** The Music page (`/music`): search, what is playing, your playlists, categories of top songs and what you played recently — or, deeper in, an artist's, an album's or a playlist's page. */
export function MusicPage() {
  const ok = useSel((s) => s.musicOk); const why = useSel((s) => s.musicWhy); const query = useSel((s) => s.music.query); const queueOpen = useSel((s) => s.music.showQueue && !!s.music.track);
  const view = useSel((s) => s.route.musicView); const vid = useSel((s) => s.route.musicId);
  const [q, setQ] = useState(query); const timer = useRef(null); const scroller = useRef(null);
  useEffect(() => { if (ok !== false) { music.loadGenres(); music.openChart(state.music.category || 'top'); } }, [ok]);
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = 0; }, [view, vid]);
  const typing = (v) => { setQ(v); clearTimeout(timer.current); timer.current = setTimeout(() => music.search(v), 450); };
  const searching = !!query.trim(); const sub = ok !== false && !!view && !!vid;
  const page = view === 'guess' ? html`<${GuessView} />` : view === 'artist' ? html`<${ArtistView} key=${vid} id=${vid} />` : view === 'album' ? html`<${AlbumView} key=${vid} id=${vid} />` : view === 'shared' ? html`<${SharedPlaylistView} key=${vid} id=${vid} />` : html`<${PlaylistView} key=${vid} id=${vid} />`;
  return html`<main class="main panel music-page view-anim">
    <header class="m-header">
      <button type="button" class="mobile-only icon-btn" onClick=${() => set({ mobileNav: true })} aria-label=${t('Menu')}><${Icon} name="menu" size=${22} /></button>
      ${sub ? html`<button type="button" class="icon-btn m-back" onClick=${back} aria-label=${t('Back')} data-tip=${t('Back')}><${Icon} name="arrow-left" size=${20} /></button>` : null}
      <div class="m-title"><${Icon} name="music" size=${23} /><span class="name">${t('Music')}</span></div>
    </header>
    <div class="mpg-scroll" ref=${scroller}>
      ${ok === false ? html`<div class="m-empty setup"><${Icon} name="music" size=${34} sw=${1.5} /><b>${why ? t('Music isn’t set up on this server yet') : t('Music is turned off on this server')}</b><p>${why || t('The server admin switched the music player off.')}</p></div>`
        : sub ? page : html`
        <div class="mpg-top"><div class="mpg-search"><div class="input-wrap"><${Icon} name="search" size=${18} /><input class="input" placeholder=${t('Search songs and artists…')} value=${q} onInput=${(e) => typing(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') { clearTimeout(timer.current); music.search(q); } }} />
          ${q ? html`<button type="button" class="mpg-clear" aria-label=${t('Clear')} onClick=${() => { setQ(''); clearTimeout(timer.current); music.search(''); }}><${Icon} name="x" size=${16} /></button>` : null}</div></div><${LayoutSwitch} /></div>
        <${Hero} />
        <button type="button" class="gs-entry" onClick=${() => go('/music/guess')}><${Icon} name="music" size=${22} /><span><b>${t('Song guess')}</b><small>${t('Name the song from a split second of it, from Easy to Impossible.')}</small></span><${Icon} name="arrow-right" size=${18} /></button>
        ${queueOpen ? html`<${QueuePanel} />` : null}
        ${searching ? html`<${SearchResults} />` : html`<${PlaylistsSection} /><${Categories} /><${Chart} /><${Recent} />`}`}
    </div>
  </main>`;
}

/** The small player above the user bar while something is loaded. It stays while you move around Orata. */
export function MiniPlayer() {
  const track = useSel((s) => s.music.track); const playing = useSel((s) => s.music.playing);
  const pos = useSel((s) => Math.round(s.music.position)); const dur = useSel((s) => s.music.duration);
  if (!track) return null;
  return html`<div class="mini-player">
    <button type="button" class="mp-open" onClick=${openMusic} aria-label=${t('Open music')}><${Art} src=${track.artwork} size=${34} playing=${playing} seed=${track.id} />
      <span class="mp-text"><b>${track.title}</b><small>${track.artist}</small></span></button>
    <${Controls} />
    <${IconBtn} icon="x" label=${t('Stop')} size=${16} glass=${null} onClick=${() => music.stop()} />
    <i class="mp-bar" style=${{ width: `${dur ? Math.min(100, (pos / dur) * 100) : 0}%` }} aria-hidden="true"></i>
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
