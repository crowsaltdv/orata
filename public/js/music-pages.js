// Orata — the library side of the Music page: artist pages (their picture, songs and albums), album pages (the songs sorted into the album), your own playlists, and the
// "add to playlist" menu. Playlists belong to your account and are private; the server keeps them (server/music.js). Nothing here opens a page on another website.
import { html, useState, useEffect, useRef, cx } from '/js/lib.js';
import { state, set, useSel, toast, go, openContext, openModal, closeModal } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { Spinner, Btn, Field, Modal, MODALS, confirmDialog } from '/js/ui.js';
import { api } from '/js/api.js';
import { t } from '/js/i18n.js';
import { music, Cover, Art, clock } from '/js/music.js';

const setMusic = (patch) => set({ music: { ...state.music, ...patch } });
const fail = (e) => toast(e?.message || t('Something went wrong.'), 'error');
const span = (ms) => { const m = Math.max(1, Math.round(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)} ${t('hr')} ${m % 60} ${t('min')}` : `${m} ${t('min')}`; };

/* ------------------------------------------------------------------ moving around */
let trail = 0;   // how many pages deep we are inside the app, so Back can use the browser's history without ever leaving Orata
export const openArtist = (id) => { trail++; go(`/music/artist/${id}`); };
export const openAlbum = (id) => { trail++; go(`/music/album/${id}`); };
export const openPlaylist = (id) => { trail++; go(`/music/playlist/${id}`); };
export function back() { if (trail > 0) { trail--; history.back(); } else go('/music'); }

/** Artist names that open that artist's page here (names without a page stay plain text). */
export function ArtistLinks({ track }) {
  const list = track.artists?.length ? track.artists : [{ name: track.artist, id: null }];
  return html`${list.map((a, i) => html`${i ? ', ' : ''}${a.id ? html`<a class="m-link" href=${`/music/artist/${a.id}`} onClick=${(e) => { e.preventDefault(); e.stopPropagation(); openArtist(a.id); }}>${a.name}</a>` : a.name}`)}`;
}
export function AlbumLink({ track }) {
  return track.album && track.albumId ? html`<a class="m-link" href=${`/music/album/${track.albumId}`} onClick=${(e) => { e.preventDefault(); e.stopPropagation(); openAlbum(track.albumId); }}>${track.album}</a>` : track.album || null;
}

/* ------------------------------------------------------------------ your playlists (the list is kept in state.music.playlists) */
let loadingLists = null;
export function ensurePlaylists(force = false) {
  if (state.music.playlists && !force) return Promise.resolve(state.music.playlists);
  loadingLists ||= api.get('/me/playlists').then((r) => { setMusic({ playlists: r.playlists }); return r.playlists; }).catch((e) => { fail(e); return state.music.playlists || []; }).finally(() => { loadingLists = null; });
  return loadingLists;
}
const upsert = (p) => { const list = state.music.playlists || []; setMusic({ playlists: list.some((x) => x.id === p.id) ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p] }); };
const byRecent = (list) => [...list].sort((a, b) => b.updatedAt - a.updatedAt);

MODALS['playlist-name'] = function PlaylistName({ id, title, value, confirmLabel, resolve }) {
  const [v, setV] = useState(value || ''); const input = useRef(null);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);   // (the autofocus attribute only works once per page load)
  const done = (val) => { closeModal(id); resolve(val); };
  return html`<${Modal} title=${title} width=${420} onClose=${() => done(null)}
    footer=${html`<${Btn} variant="ghost" onClick=${() => done(null)}>${t('Cancel')}<//><${Btn} variant="primary" disabled=${!v.trim()} onClick=${() => done(v.trim())}>${confirmLabel}<//>`}>
    <${Field} label=${t('Name')}><div class="input-wrap"><input ref=${input} class="input" value=${v} maxlength="60" placeholder=${t('My playlist')} onInput=${(e) => setV(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter' && v.trim()) done(v.trim()); }} /></div><//>
  <//>`;
};
const askName = ({ title, value = '', confirmLabel }) => new Promise((resolve) => openModal('playlist-name', { title, value, confirmLabel, resolve }));

/** Makes a playlist (starting with `track` when given). */
export async function newPlaylist(track) {
  const name = await askName({ title: t('New playlist'), confirmLabel: t('Create') }); if (!name) return null;
  try {
    const r = await api.post('/me/playlists', { name, ...(track ? { trackId: track.id } : {}) });
    upsert(r.playlist); toast(track ? `${t('Created')} “${r.playlist.name}” ${t('with')} ${track.title}` : `${t('Created')} “${r.playlist.name}”`, 'success', 2600);
    return r.playlist;
  } catch (e) { fail(e); return null; }
}
async function addTo(p, track) {
  try {
    const r = await api.post(`/me/playlists/${p.id}/tracks`, { trackId: track.id });
    upsert(r.playlist); toast(`${r.added ? t('Added to') : t('Already in')} “${p.name}”`, r.added ? 'success' : 'info', 2200);
  } catch (e) { fail(e); }
}
/** The "+" on a song: a menu of your playlists, and a way to start a new one with this song. */
export async function openAddMenu(e, track) {
  e.stopPropagation?.();
  const r = e.currentTarget.getBoundingClientRect(); const at = { clientX: r.left, clientY: r.bottom + 4, preventDefault() {}, stopPropagation() {} };
  const lists = byRecent(await ensurePlaylists());
  openContext(at, [{ label: t('New playlist…'), icon: 'plus', onClick: () => newPlaylist(track) }, ...(lists.length ? [{ type: 'sep' }] : []), ...lists.map((p) => ({ label: p.name, icon: 'list', onClick: () => addTo(p, track) }))]);
}

function Mosaic({ covers }) {
  const four = covers.length >= 4;
  return html`<span class=${cx('pl-mosaic', four && 'four')}>${covers.length ? (four ? covers.slice(0, 4) : covers.slice(0, 1)).map((c, i) => html`<img key=${i} src=${c} alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" draggable=${false} />`) : html`<${Icon} name="list" size=${36} sw=${1.5} />`}</span>`;
}

/** "Your playlists" on the Music page. */
export function PlaylistsSection() {
  const lists = useSel((s) => s.music.playlists);
  useEffect(() => { ensurePlaylists(); }, []);
  return html`<section class="mpg-section"><h3 class="mpg-h"><span>${t('Your playlists')}</span><button type="button" class="link-btn" onClick=${() => newPlaylist()}><${Icon} name="plus" size=${15} sw=${2.4} /> ${t('New playlist')}</button></h3>
    ${lists === null ? html`<div class="pk-center"><${Spinner} /></div>` : !lists.length ? html`<p class="mpg-hint">${t('Make a playlist, then add songs to it with the + on any song.')}</p>`
      : html`<div class="mpg-grid">${byRecent(lists).map((p) => html`<button type="button" key=${p.id} class="mpg-card" onClick=${() => openPlaylist(p.id)} title=${p.name}>
        <span class="mpg-cover"><${Mosaic} covers=${p.covers} /></span><b>${p.name}</b><small>${p.count} ${p.count === 1 ? t('song') : t('songs')}</small></button>`)}</div>`}
  </section>`;
}

/* ------------------------------------------------------------------ lists of songs */
/** Songs as rows: number or play button, cover, title, artists, album, length, "+" (and "×" on your own playlist). */
export function Rows({ tracks, numbered = true, showAlbum = true, onRemove }) {
  const cur = useSel((s) => s.music.track?.id); const playing = useSel((s) => s.music.playing);
  const play = (tr) => (cur === tr.id ? music.toggle() : music.play(tr, tracks));
  return html`<div class="mpg-rows">${tracks.map((tr, i) => html`<div key=${`${tr.id}:${i}`} class=${cx('mpg-row', cur === tr.id && 'cur')} role="button" tabindex="0" onClick=${() => play(tr)} onKeyDown=${(e) => { if (e.key === 'Enter') play(tr); }}>
    <span class="mpg-n">${cur === tr.id && playing ? html`<span class="eq sm"><i></i><i></i><i></i><i></i></span>` : html`<span class="num">${numbered ? i + 1 : ''}</span><${Icon} name="play" size=${14} fill=${true} sw=${1} />`}</span>
    <${Art} src=${tr.artwork} size=${40} />
    <span class="mpg-rt"><b title=${tr.title}>${tr.title}</b><small>${tr.explicit ? html`<i class="mpg-e">E</i>` : null}<${ArtistLinks} track=${tr} /></small></span>
    ${showAlbum ? html`<span class="mpg-ra"><${AlbumLink} track=${tr} /></span>` : null}
    <span class="mpg-rd">${tr.duration ? clock(tr.duration / 1000) : ''}</span>
    <button type="button" class="mpg-ib" data-tip=${t('Add to playlist')} aria-label=${t('Add to playlist')} onClick=${(e) => openAddMenu(e, tr)}><${Icon} name="plus" size=${17} /></button>
    ${onRemove ? html`<button type="button" class="mpg-ib" data-tip=${t('Remove from this playlist')} aria-label=${t('Remove from this playlist')} onClick=${(e) => { e.stopPropagation(); onRemove(tr); }}><${Icon} name="x" size=${16} /></button>` : null}
  </div>`)}</div>`;
}

function AlbumGrid({ items }) {
  return html`<div class="mpg-grid">${items.map((a) => html`<button type="button" key=${a.id} class="mpg-card" onClick=${() => openAlbum(a.id)} title=${a.title}>
    <span class="mpg-cover"><${Cover} src=${a.artwork} /></span><b>${a.title}</b><small>${[a.year, a.type].filter(Boolean).join(' · ')}</small></button>`)}</div>`;
}

/* ------------------------------------------------------------------ pages */
const pages = new Map();   // artist and album pages already opened, so going back to one is instant
function usePage(key, load) {
  const [data, setData] = useState(() => pages.get(key) || null); const [err, setErr] = useState(null);
  useEffect(() => {
    let live = true; setErr(null); const hit = pages.get(key); setData(hit || null);
    if (!hit) load().then((d) => { pages.set(key, d); if (pages.size > 40) pages.delete(pages.keys().next().value); if (live) setData(d); }, (e) => { if (live) setErr(e.message || t('Couldn’t load this.')); });
    return () => { live = false; };
  }, [key]);
  return [data, err];
}
function Status({ err }) {
  return err ? html`<div class="m-empty"><${Icon} name="alert-circle" size=${28} /><p>${err}</p><button type="button" class="link-btn" onClick=${back}>${t('Go back')}</button></div>` : html`<div class="pk-center"><${Spinner} /></div>`;
}

/** An artist: picture, numbers, their songs, and their albums, singles and EPs (each opens its own page). */
export function ArtistView({ id }) {
  const [data, err] = usePage(`artist:${id}`, () => api.get(`/music/artists/${encodeURIComponent(id)}`).then((r) => r.artist));
  const [all, setAll] = useState(false); const [more, setMore] = useState(false);
  useEffect(() => { setAll(false); setMore(false); }, [id]);
  if (!data) return html`<${Status} err=${err} />`;
  const songs = all ? data.songs : data.songs.slice(0, 8);
  const stats = [data.listeners && `${data.listeners} ${t('monthly listeners')}`, data.subscribers && `${data.subscribers} ${t('subscribers')}`].filter(Boolean).join(' · ');
  return html`<div class="ar">
    <header class="ar-head" style=${data.banner ? { '--banner': `url("${data.banner}")` } : null}>
      <span class="ar-avatar">${data.avatar ? html`<img src=${data.avatar} alt="" referrerpolicy="no-referrer" draggable=${false} />` : html`<${Icon} name="user" size=${54} sw=${1.4} />`}</span>
      <div class="ar-info"><small class="m-kicker">${t('Artist')}</small><h1>${data.name}</h1>${stats ? html`<div class="ar-stats">${stats}</div>` : null}
        <div class="ar-actions"><${Btn} variant="primary" icon="play" disabled=${!data.songs.length} onClick=${() => music.play(data.songs[0], data.songs)}>${t('Play')}<//></div></div>
    </header>
    ${data.description ? html`<p class=${cx('ar-bio', more && 'open')} onClick=${() => setMore(!more)} title=${more ? '' : t('Show more')}>${data.description}</p>` : null}
    ${data.songs.length ? html`<section class="mpg-section"><h3>${t('Songs')}</h3><${Rows} tracks=${songs} numbered=${false} />
      ${data.songs.length > 8 ? html`<button type="button" class="link-btn mpg-more" onClick=${() => setAll(!all)}>${all ? t('Show fewer') : `${t('Show all')} (${data.songs.length})`}</button>` : null}</section>` : null}
    ${data.albums.length ? html`<section class="mpg-section"><h3>${t('Albums')}</h3><${AlbumGrid} items=${data.albums} /></section>` : null}
    ${data.singles.length ? html`<section class="mpg-section"><h3>${t('Singles & EPs')}</h3><${AlbumGrid} items=${data.singles} /></section>` : null}
    ${!data.songs.length && !data.albums.length && !data.singles.length ? html`<div class="m-empty"><p>${t('Nothing to show for this artist yet.')}</p></div>` : null}
  </div>`;
}

/** An album: its cover, year, who made it, and its songs in order. */
export function AlbumView({ id }) {
  const [data, err] = usePage(`album:${id}`, () => api.get(`/music/albums/${encodeURIComponent(id)}`).then((r) => r.album));
  if (!data) return html`<${Status} err=${err} />`;
  const meta = [data.year, `${data.tracks.length} ${data.tracks.length === 1 ? t('song') : t('songs')}`, data.duration ? span(data.duration) : null].filter(Boolean).join(' · ');
  return html`<div class="al" style=${data.artwork ? { '--cover': `url("${data.artwork}")` } : null}>
    <header class="al-head"><div class="al-cover"><${Cover} src=${data.artwork} /></div>
      <div class="ar-info"><small class="m-kicker">${data.type}</small><h1>${data.title}</h1>
        <div class="ar-stats"><${ArtistLinks} track=${{ artists: data.artists, artist: data.artists[0]?.name || '' }} /> · ${meta}</div>
        <div class="ar-actions"><${Btn} variant="primary" icon="play" disabled=${!data.tracks.length} onClick=${() => music.play(data.tracks[0], data.tracks)}>${t('Play')}<//></div></div>
    </header>
    ${data.tracks.length ? html`<${Rows} tracks=${data.tracks} showAlbum=${false} />` : html`<div class="m-empty"><p>${t('No songs to play on this album.')}</p></div>`}
  </div>`;
}

/** One of your playlists: play it, rename it, delete it, take songs out. */
export function PlaylistView({ id }) {
  const [data, setData] = useState(null); const [err, setErr] = useState(null);
  useEffect(() => { let live = true; setData(null); setErr(null); api.get(`/me/playlists/${encodeURIComponent(id)}`).then((r) => { if (live) setData(r.playlist); }, (e) => { if (live) setErr(e.message); }); return () => { live = false; }; }, [id]);
  if (!data) return html`<${Status} err=${err} />`;
  const remove = async (tr) => { try { const r = await api.del(`/me/playlists/${id}/tracks/${encodeURIComponent(tr.id)}`); setData({ ...data, ...r.playlist, tracks: data.tracks.filter((x) => x.id !== tr.id) }); upsert(r.playlist); } catch (e) { fail(e); } };
  const rename = async () => {
    const name = await askName({ title: t('Rename playlist'), value: data.name, confirmLabel: t('Save') }); if (!name || name === data.name) return;
    try { const r = await api.patch(`/me/playlists/${id}`, { name }); setData({ ...data, name: r.playlist.name }); upsert(r.playlist); } catch (e) { fail(e); }
  };
  const del = async () => {
    if (!(await confirmDialog({ title: t('Delete playlist'), body: `${t('Delete')} “${data.name}”? ${t('This can’t be undone.')}`, confirmLabel: t('Delete'), danger: true }))) return;
    try { await api.del(`/me/playlists/${id}`); setMusic({ playlists: (state.music.playlists || []).filter((x) => x.id !== id) }); back(); } catch (e) { fail(e); }
  };
  const total = data.tracks.reduce((n, x) => n + (x.duration || 0), 0);
  const meta = [`${data.tracks.length} ${data.tracks.length === 1 ? t('song') : t('songs')}`, total ? span(total) : null].filter(Boolean).join(' · ');
  return html`<div class="al">
    <header class="al-head"><div class="al-cover"><${Mosaic} covers=${data.tracks.map((x) => x.artwork).filter(Boolean)} /></div>
      <div class="ar-info"><small class="m-kicker">${t('Playlist')}</small><h1>${data.name}</h1><div class="ar-stats">${meta}</div>
        <div class="ar-actions"><${Btn} variant="primary" icon="play" disabled=${!data.tracks.length} onClick=${() => music.play(data.tracks[0], data.tracks)}>${t('Play')}<//>
          <${Btn} icon="edit" onClick=${rename}>${t('Rename')}<//><${Btn} variant="danger" icon="trash" onClick=${del}>${t('Delete')}<//></div></div>
    </header>
    ${data.tracks.length ? html`<${Rows} tracks=${data.tracks} onRemove=${remove} />` : html`<div class="m-empty"><b>${t('This playlist is empty')}</b><p>${t('Add songs with the + on any song.')}</p></div>`}
  </div>`;
}
