// Orata — a playlist shared in a chat (/playlist, or Share on a playlist page): its covers, name, owner, size, the first songs, and Play, Shuffle, Open and Save a copy.
// The card itself is what was shared; the buttons load the playlist as it is now through the message (server/music.js), so one that was deleted says so.
// The music player only loads when a button is pressed (this file is part of every chat).
import { html, useState, cx } from '/js/lib.js';
import { state, useSel } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { t } from '/js/i18n.js';

const pages = () => import('/js/music-pages.js'); const player = () => import('/js/music.js');
const clock = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const length = (ms) => { const m = Math.max(1, Math.round(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)} ${t('hr')} ${m % 60} ${t('min')}` : `${m} ${t('min')}`; };

export function PlaylistCard({ m }) {
  const p = m.playlist; const owner = useSel((s) => s.users[p.ownerId]);
  const [gone, setGone] = useState(false); const [busy, setBusy] = useState(null);
  const tracks = async () => { const list = await (await pages()).sharedTracks(m.channelId, m.id); if (!list) setGone(true); return list; };
  const play = async (shuffle) => { setBusy(shuffle ? 'shuffle' : 'play'); const list = await tracks(); setBusy(null); if (list?.length) (await player()).music.playAll(list, { shuffle }); };
  const open = async () => (await pages()).openShared(m.channelId, m.id);
  const save = async () => { setBusy('save'); const r = await (await pages()).savePlaylist(m.channelId, m.id); setBusy(null); if (!r) setGone(true); };
  const covers = p.covers || []; const four = covers.length >= 4;
  const btn = (key, icon, label, onClick, primary) => html`<button type="button" class=${cx('plc-btn', primary && 'primary')} disabled=${!!busy || gone} onClick=${onClick}><${Icon} name=${busy === key ? 'refresh' : icon} size=${15} fill=${icon === 'play'} sw=${icon === 'play' ? 1 : 2} />${label}</button>`;
  return html`<div class="pl-card">
    <button type="button" class=${cx('plc-art', four && 'four')} onClick=${open} aria-label=${`${t('Open')} ${p.name}`}>${covers.length ? (four ? covers.slice(0, 4) : covers.slice(0, 1)).map((c, i) => html`<img key=${i} src=${c} alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" draggable=${false} />`) : html`<${Icon} name="list-music" size=${36} />`}</button>
    <div class="plc-body">
      <small class="plc-kicker"><${Icon} name="list-music" size=${13} /> ${t('Playlist')}</small>
      <button type="button" class="plc-name" onClick=${open}>${p.name}</button>
      <span class="plc-meta">${owner ? html`${t('by')} <b>${owner.displayName}</b> · ` : null}${p.count} ${p.count === 1 ? t('song') : t('songs')}${p.duration ? ` · ${length(p.duration)}` : ''}</span>
      <ol class="plc-songs">${(p.preview || []).map((s) => html`<li key=${s.id}><span>${s.title}</span><small>${s.artist}</small><i>${s.duration ? clock(s.duration) : ''}</i></li>`)}${p.count > (p.preview || []).length ? html`<li class="plc-more">+ ${p.count - p.preview.length} ${t('more')}</li>` : null}</ol>
      ${gone ? html`<p class="plc-gone"><${Icon} name="alert-circle" size=${14} /> ${t('This playlist was deleted or isn’t available anymore.')}</p>`
        : html`<div class="plc-acts">${btn('play', 'play', t('Play'), () => play(false), true)}${btn('shuffle', 'shuffle', t('Shuffle'), () => play(true))}${btn('open', 'list', t('View playlist'), open)}${p.ownerId !== state.me?.id ? btn('save', 'plus', t('Save'), save) : null}</div>`}
    </div>
  </div>`;
}
