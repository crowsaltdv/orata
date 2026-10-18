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

function Video({ stream, muted, mirror, screen }) {
  const ref = useRef(null);
  useEffect(() => { const el = ref.current; if (el && el.srcObject !== stream) { el.srcObject = stream; el.play?.().catch(() => {}); } }, [stream]);
  return html`<video ref=${ref} autoplay playsinline muted=${muted} class=${cx(mirror && 'mirror', screen && 'screen')}></video>`;
}

function Tile({ uid, kind, stream, expanded, onExpand }) {
  const u = useSel((s) => s.users[uid]);
  const st = useSel((s) => { for (const room of Object.values(s.voice.states)) if (room[uid]) return room[uid]; return null; });
  const speaking = useSel((s) => !!s.voice.speaking?.[uid]);
  const mirror = uid === state.me.id && kind === 'camera' && state.local.voice.mirrorVideo;
  const hasVideo = !!stream && stream.getVideoTracks().some((t) => t.readyState === 'live');
  const name = u?.displayName || '…';
  const menu = (e) => { e.preventDefault(); if (uid === state.me.id) return; openContext(e, [{ type: 'custom', render: () => html`<div class="vol-ctx"><small>${t('User volume')}</small><${Slider} value=${Math.round(getUserVolume(uid) * 100)} min=${0} max=${100} onChange=${(v) => setUserVolume(uid, v / 100)} format=${(v) => v + '%'} /></div>` }, { type: 'sep' }, { label: t('Profile'), icon: 'user', onClick: () => openProfile(uid) }]); void userMenu; };
  return html`<div class=${cx('tile', speaking && !st?.muted && kind !== 'screen' && 'speaking', expanded && 'expand')} onDblClick=${onExpand} onContextMenu=${menu}>
    ${hasVideo ? html`<${Video} stream=${stream} muted=${uid === state.me.id} mirror=${mirror} screen=${kind === 'screen'} />` : html`<${Avatar} user=${u} size=${expanded ? 120 : 84} />`}
    <span class="tile-name">${kind === 'screen' ? html`<${Icon} name="monitor" size=${14} />` : null}${kind === 'screen' ? `${name}${t('’s screen')}` : name}${st?.muted && kind !== 'screen' ? html`<${Icon} name=${st.deafened ? 'headphones-off' : 'mic-off'} size=${14} />` : null}</span>
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

function Grid({ chId }) {
  const room = useSel((s) => s.voice.states[chId]); useSel((s) => s.voice.rev);
  const [big, setBig] = useState(null);
  const ids = Object.keys(room || {});
  const tiles = [];
  for (const uid of ids) {
    const e = streamStore.byUser.get(uid) || {};
    if (e.screen) tiles.push({ key: uid + ':screen', uid, kind: 'screen', stream: e.screen });
    tiles.push({ key: uid + ':cam', uid, kind: 'camera', stream: e.camera });
  }
  if (!tiles.length) return null;
  const hasScreen = tiles.some((x) => x.kind === 'screen');
  return html`<div class=${cx('stage-grid', (big || hasScreen) && 'focus')}>${tiles.map((x) => html`<${Tile} key=${x.key} uid=${x.uid} kind=${x.kind} stream=${x.stream} expanded=${big ? big === x.key : x.kind === 'screen'} onExpand=${() => setBig(big === x.key ? null : x.key)} />`)}</div>`;
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
