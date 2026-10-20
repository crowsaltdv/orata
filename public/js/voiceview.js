// Orate — voice channel view, DM call stage, participant tiles and call controls.
import { html, useEffect, useRef, useState, cx } from '/js/lib.js';
import { state, set, useSel, getChannel, dmName, openContext, go, goDm } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { Avatar, Btn, IconBtn, Slider } from '/js/ui.js';
import { voice, streamStore, setUserVolume, getUserVolume } from '/js/voice.js';
import { MessageList } from '/js/messagelist.js';
import { Composer } from '/js/composer.js';
import { openProfile } from '/js/sidebar.js';
import { userMenu } from '/js/profile.js';
import { t } from '/js/i18n.js';
import { UserName } from '/js/profile-style.js';

function Video({ stream, muted, mirror, screen }) {
  const ref = useRef(null);
  useEffect(() => { const el = ref.current; if (el && el.srcObject !== stream) { el.srcObject = stream; el.play?.().catch(() => {}); } }, [stream]);
  return html`<video ref=${ref} autoplay playsinline muted=${muted} class=${cx(mirror && 'mirror', screen && 'screen')}></video>`;
}

export function Tile({ uid, kind, stream, expanded, onExpand, avatarSize = 84 }) {
  const u = useSel((s) => s.users[uid]);
  const st = useSel((s) => { for (const room of Object.values(s.voice.states)) if (room[uid]) return room[uid]; return null; });
  const speaking = useSel((s) => !!s.voice.speaking?.[uid]);
  const link = useSel((s) => (uid === s.me.id || kind === 'screen' ? null : s.voice.links?.[uid] || null));
  const mirror = uid === state.me.id && kind === 'camera' && state.local.voice.mirrorVideo;
  const hasVideo = !!stream && stream.getVideoTracks().some((t) => t.readyState === 'live');
  const name = u?.displayName || '…';
  const menu = (e) => { e.preventDefault(); if (uid === state.me.id) return; const stage = voice.stageMenu(uid); openContext(e, [{ type: 'custom', render: () => html`<div class="vol-ctx"><small>${t('User volume')}</small><${Slider} value=${Math.round(getUserVolume(uid) * 100)} min=${0} max=${100} onChange=${(v) => setUserVolume(uid, v / 100)} format=${(v) => v + '%'} /></div>` }, { type: 'sep' }, { label: t('Profile'), icon: 'user', onClick: () => openProfile(uid) }, ...(stage.length ? [{ type: 'sep' }, ...stage] : [])]); void userMenu; };
  return html`<div class=${cx('tile', speaking && !st?.muted && kind !== 'screen' && 'speaking', expanded && 'expand')} onDblClick=${onExpand} onContextMenu=${menu}>
    ${hasVideo ? html`<${Video} stream=${stream} muted=${uid === state.me.id} mirror=${mirror} screen=${kind === 'screen'} />` : html`<${Avatar} user=${u} size=${avatarSize} />`}
    <span class="tile-name">${kind === 'screen' ? html`<${Icon} name="monitor" size=${14} />` : null}${kind === 'screen' ? `${name}${t('’s screen')}` : html`<${UserName} user=${u} text=${name} />`}${st?.muted && kind !== 'screen' ? html`<${Icon} name=${st.deafened ? 'headphones-off' : 'mic-off'} size=${14} />` : null}</span>
    ${link && link !== 'connected' ? html`<span class=${cx('tile-link', link)} title=${link === 'failed' ? t('A direct link to this person isn’t possible on your networks — a TURN relay is needed.') : t('Setting up the audio and video link…')}>${link === 'failed' ? html`<${Icon} name="wifi" size=${13} /> ${t('Can’t connect')}` : html`<span class="spinner sm"></span> ${link === 'slow' ? t('Still connecting…') : t('Connecting…')}`}</span>` : null}
    ${kind !== 'screen' && st?.muted ? html`<span class="tile-muted"><${Icon} name=${st.deafened ? 'headphones-off' : 'mic-off'} size=${15} /></span>` : null}
  </div>`;
}

export function Controls({ compact }) {
  const c = useSel((s) => s.voice.conn);
  if (!c) return null;
  const muted = c.muted || c.deafened;
  const btn = (icon, label, fn, cls) => html`<button type="button" class=${cx('ctl', cls)} data-tip=${label} data-tip-pos="top" aria-label=${label} onClick=${fn}><${Icon} name=${icon} size=${22} /></button>`;
  return html`<div class="stage-controls">
    ${btn(muted ? 'mic-off' : 'mic', muted ? t('Unmute') : t('Mute'), () => voice.toggleMute(), muted ? 'bad' : '')}
    ${btn(c.deafened ? 'headphones-off' : 'headphones', c.deafened ? t('Undeafen') : t('Deafen'), () => voice.toggleDeafen(), c.deafened ? 'bad' : '')}
    ${btn(c.video ? 'video' : 'video-off', c.video ? t('Turn Off Camera') : t('Turn On Camera'), () => voice.toggleCamera(), c.video ? 'on' : '')}
    ${btn('monitor', c.screen ? t('Stop Sharing') : t('Share Your Screen'), () => voice.toggleScreen(), c.screen ? 'on' : '')}
    <button type="button" class="ctl hang" data-tip=${t('Disconnect')} data-tip-pos="top" aria-label="Disconnect" onClick=${() => voice.leave()}><${Icon} name="phone-off" size=${22} /></button>
    ${compact ? null : null}
  </div>`;
}

/**
 * The best number of columns and rows for `n` tiles in a w×h area: the arrangement whose tiles come out biggest while staying close to 16:9.
 * Tiles then fill the area and change shape as people join or leave — nothing scrolls.
 */
export function fitGrid(n, w, h, gap = 12) {
  if (n <= 1 || w < 40 || h < 40) return { cols: 1, rows: Math.max(1, n) };
  const target = 16 / 9; let best = null; let fallback = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols); const tw = (w - gap * (cols - 1)) / cols; const th = (h - gap * (rows - 1)) / rows;
    const ar = tw / th; const closeness = Math.min(ar / target, target / ar);
    const score = Math.min(tw, th * target) * (0.55 + 0.45 * closeness);
    if (!fallback || score > fallback.score) fallback = { score, cols, rows };
    if (tw >= 90 && th >= 64 && (!best || score > best.score)) best = { score, cols, rows };
  }
  return best || fallback;
}

/** Lays `tiles` out with fitGrid() in whatever space its container gets. */
function FitGrid({ tiles, big, setBig, className }) {
  const ref = useRef(null); const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current; if (!el) return undefined;
    const ro = new ResizeObserver(() => { const r = el.getBoundingClientRect(); setBox((b) => (Math.abs(b.w - r.width) < 1 && Math.abs(b.h - r.height) < 1 ? b : { w: r.width, h: r.height })); });
    ro.observe(el); return () => ro.disconnect();
  }, []);
  const gap = 12; const { cols, rows } = fitGrid(tiles.length, box.w, box.h, gap);
  const tw = (box.w - gap * (cols - 1)) / cols; const th = (box.h - gap * (rows - 1)) / rows;
  const avatar = Math.round(Math.max(40, Math.min(150, Math.min(tw, th) * 0.4)) || 84);
  return html`<div class=${cx('fit-grid', className)} ref=${ref} style=${{ '--cols': cols, '--rows': rows, '--gap': gap + 'px' }}>${tiles.map((x) => html`<${Tile} key=${x.key} uid=${x.uid} kind=${x.kind} stream=${x.stream} avatarSize=${avatar} expanded=${big === x.key} onExpand=${() => setBig(big === x.key ? null : x.key)} />`)}</div>`;
}

/** The tiles of a room (or, with `uids`, of just those people — the speakers of a stage). */
export function Grid({ chId, uids }) {
  const room = useSel((s) => s.voice.states[chId]); useSel((s) => s.voice.rev);
  const [big, setBig] = useState(null);
  const ids = uids || Object.keys(room || {});
  const tiles = [];
  for (const uid of ids) {
    const e = streamStore.byUser.get(uid) || {};
    if (e.screen) tiles.push({ key: uid + ':screen', uid, kind: 'screen', stream: e.screen });
    tiles.push({ key: uid + ':cam', uid, kind: 'camera', stream: e.camera });
  }
  if (!tiles.length) return null;
  // a shared screen (or a tile you double-clicked) takes the big area; everybody else sits in a strip below it
  const main = big ? tiles.filter((x) => x.key === big) : tiles.filter((x) => x.kind === 'screen');
  if (main.length) {
    const rest = tiles.filter((x) => !main.includes(x));
    return html`<div class="stage-grid focus"><${FitGrid} tiles=${main} big=${big} setBig=${setBig} className="fg-main" />
      ${rest.length ? html`<div class="stage-strip">${rest.map((x) => html`<${Tile} key=${x.key} uid=${x.uid} kind=${x.kind} stream=${x.stream} avatarSize=${40} onExpand=${() => setBig(x.key)} />`)}</div>` : null}</div>`;
  }
  return html`<div class="stage-grid"><${FitGrid} tiles=${tiles} big=${big} setBig=${setBig} /></div>`;
}

/** Inline stage above the messages of a DM / group DM while a call is active. */
export function CallStage({ chId }) {
  const conn = useSel((s) => s.voice.conn); const room = useSel((s) => s.voice.states[chId]);
  const joined = conn?.channelId === chId; const n = Object.keys(room || {}).length;
  if (!n && !joined) return null;
  return html`<div class="call-stage">
    ${n ? html`<${Grid} chId=${chId} />` : null}
    ${joined ? html`<${Controls} />` : html`<div class="stage-controls"><${Btn} variant="success" icon="phone" onClick=${() => voice.join(chId)}>${t('Join Call')}<//></div>`}
  </div>`;
}

export function VoiceChannelView() {
  const chId = useSel((s) => s.route.channelId); const ch = useSel((s) => getChannel(s.route.channelId));
  const server = useSel((s) => (ch ? s.servers[ch.serverId] : null));
  const conn = useSel((s) => s.voice.conn); const room = useSel((s) => s.voice.states[chId]); const users = useSel((s) => s.users);
  const [chat, setChat] = useState(false);
  if (!ch) return html`<main class="main panel"></main>`;
  const joined = conn?.channelId === chId; const ids = Object.keys(room || {});
  return html`<main class="main panel chat view-anim" style="flex-direction:row">
    <div class="vc-main" style="flex:1;min-width:0;display:flex;flex-direction:column">
      <header class="m-header">
        <button type="button" class="mobile-only icon-btn" onClick=${() => set({ mobileNav: true })} aria-label="Menu"><${Icon} name="menu" size=${22} /></button>
        <div class="m-title"><${Icon} name="volume" size=${23} /><span class="name">${ch.name}</span></div><div class="m-topic">${server?.name}</div>
        <div class="m-actions"><${IconBtn} icon="message" label=${chat ? t('Hide Chat') : t('Show Chat')} active=${chat} onClick=${() => setChat(!chat)} /></div>
      </header>
      <div class="vc-view">
        ${!joined ? html`<div class="vc-empty">
          <div class="icon-big"><${Icon} name="volume" size=${44} sw=${1.8} /></div>
          <h2>${ch.name}</h2>
          <p>${ids.length ? `${ids.length} ${ids.length === 1 ? t('person is') : t('people are')} ${t('in this voice channel.')}` : t('No one is here yet. Be the first!')}</p>
          ${ids.length ? html`<div class="vc-faces">${ids.slice(0, 8).map((id) => html`<${Avatar} user=${users[id]} size=${44} key=${id} />`)}</div>` : null}
          <${Btn} variant="primary" size="lg" icon="phone" onClick=${() => voice.join(chId)}>${t('Join Voice')}<//>
        </div>` : html`<${Grid} chId=${chId} /><${Controls} />`}
      </div>
    </div>
    ${chat ? html`<div class="vc-chat slide-left"><div class="chat-col"><${MessageList} chId=${chId} key=${chId} /><${Composer} chId=${chId} /></div></div>` : null}
  </main>`;
}
void dmName; void go; void goDm;
