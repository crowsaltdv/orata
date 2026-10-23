// Orata — music shared in a chat. A song (/song): its cover, title, artist and length, with Play, Add to queue and Add to playlist.
// A playlist (/playlist, or Share on a playlist page): its covers, name, owner, size, the first songs, and Play, Shuffle, Open and Save a copy.
// The card itself is what was shared; the buttons load the playlist as it is now through the message (server/music.js), so one that was deleted says so.
// The music player only loads when a button is pressed (this file is part of every chat).
import { html, useState, cx } from '/js/lib.js';
import { state, useSel } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { t } from '/js/i18n.js';

const pages = () => import('/js/music-pages.js'); const player = () => import('/js/music.js');
const clock = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const length = (ms) => { const m = Math.max(1, Math.round(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)} ${t('hr')} ${m % 60} ${t('min')}` : `${m} ${t('min')}`; };

/** A song shared in a chat: plays here (or pauses, when it is the one playing), goes in the queue or a playlist. */
export function SongCard({ m }) {
  const s = m.song; const cur = useSel((st) => st.music?.track?.id === s.id); const playing = useSel((st) => !!st.music?.playing);
  const play = async () => { const { music } = await player(); if (cur) music.toggle(); else music.play(s); };
  const later = async () => (await player()).music.addToQueue(s);
  const add = async (e) => { const r = e.currentTarget.getBoundingClientRect(); (await pages()).openAddMenu({ currentTarget: { getBoundingClientRect: () => r }, stopPropagation() {} }, s); };
  const on = cur && playing;
  return html`<div class=${cx('song-card', cur && 'cur')}>
    <button type="button" class="sc-art" onClick=${play} aria-label=${on ? t('Pause') : `${t('Play')} ${s.title}`}>${s.artwork ? html`<img src=${s.artwork.replace('=w400-h400', '=w120-h120')} alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" draggable=${false} />` : html`<${Icon} name="music" size=${28} />`}
      <span class="sc-play"><${Icon} name=${on ? 'pause' : 'play'} size=${22} fill=${true} sw=${1} /></span></button>
    <div class="plc-body">
      <small class="plc-kicker"><${Icon} name="music" size=${13} /> ${t('Song')}</small>
      <b class="sc-title" title=${s.title}>${s.title}</b>
      <span class="plc-meta">${s.artist}${s.duration ? ` · ${clock(s.duration)}` : ''}</span>
      <div class="plc-acts">${html`<button type="button" class="plc-btn primary" onClick=${play}><${Icon} name=${on ? 'pause' : 'play'} size=${15} fill=${true} sw=${1} />${on ? t('Pause') : t('Play')}</button>`}
        <button type="button" class="plc-btn" onClick=${later}><${Icon} name="list-music" size=${15} />${t('Add to queue')}</button>
        <button type="button" class="plc-btn" onClick=${add}><${Icon} name="plus" size=${15} />${t('Add to playlist')}</button></div>
    </div>
  </div>`;
}

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
