// Orate — stage channel view: speakers on the stage, the audience below (raised hands first) and the controls for both.
import { html, cx } from '/js/lib.js';
import { state, set, useSel, getChannel, hasChannelPerm, openContext } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { Avatar, Btn } from '/js/ui.js';
import { voice, isStageMod } from '/js/voice.js';
import { Grid } from '/js/voiceview.js';
import { openProfile } from '/js/sidebar.js';
import { t } from '/js/i18n.js';

function Listener({ st, mod }) {
  const u = useSel((s) => s.users[st.userId]); const me = state.me.id;
  const menu = (e) => { e.preventDefault(); openContext(e, [{ label: t('Profile'), icon: 'user', onClick: () => openProfile(st.userId) }, ...(st.userId === me ? [] : voice.stageMenu(st.userId))]); };
  const open = (e) => openProfile(st.userId, e.currentTarget);
  return html`<div class=${cx('sch-aud', st.hand && 'hand')} role="button" tabindex="0" onClick=${open} onKeyDown=${(e) => e.key === 'Enter' && open(e)} onContextMenu=${menu}>
    <${Avatar} user=${u} size=${36} />
    <span class="sch-aud-name">${u?.displayName || '…'}</span>
    ${st.hand ? html`<span class="sch-hand" data-tip=${t('Hand raised')}><${Icon} name="hand" size=${15} /></span>` : null}
    ${mod && st.hand && st.userId !== me ? html`<button type="button" class="sch-invite" onClick=${(e) => { e.stopPropagation(); voice.setSpeaker(st.userId, true); }}>${t('Invite to Speak')}</button>` : null}
  </div>`;
}

function StageControls({ ch, conn, mine, mod }) {
  const speaker = !!mine?.speaker; const hand = !!mine?.hand; const muted = conn.muted || conn.deafened;
  const btn = (icon, label, fn, cls) => html`<button type="button" class=${cx('ctl', cls)} data-tip=${label} data-tip-pos="top" aria-label=${label} onClick=${fn}><${Icon} name=${icon} size=${22} /></button>`;
  return html`<div class="sch-controls">
    ${speaker ? html`
      ${btn(muted ? 'mic-off' : 'mic', muted ? t('Unmute') : t('Mute'), () => voice.toggleMute(), muted ? 'bad' : '')}
      ${btn(conn.video ? 'video' : 'video-off', conn.video ? t('Turn Off Camera') : t('Turn On Camera'), () => voice.toggleCamera(), conn.video ? 'on' : '')}
      ${btn('monitor', conn.screen ? t('Stop Sharing') : t('Share Your Screen'), () => voice.toggleScreen(), conn.screen ? 'on' : '')}
      <${Btn} icon="users" onClick=${() => voice.setSpeaker(state.me.id, false)}>${t('Move to Audience')}<//>`
    : html`
      <${Btn} variant=${hand ? 'secondary' : 'primary'} icon="hand" disabled=${!hasChannelPerm(ch, 'SPEAK')} onClick=${() => voice.toggleHand()}>${hand ? t('Lower Hand') : t('Raise Hand')}<//>
      ${mod ? html`<${Btn} icon="mic" onClick=${() => voice.setSpeaker(state.me.id, true)}>${t('Become a Speaker')}<//>` : null}`}
    ${btn(conn.deafened ? 'headphones-off' : 'headphones', conn.deafened ? t('Undeafen') : t('Deafen'), () => voice.toggleDeafen(), conn.deafened ? 'bad' : '')}
    <button type="button" class="ctl hang" data-tip=${t('Leave Stage')} data-tip-pos="top" aria-label=${t('Leave Stage')} onClick=${() => voice.leave()}><${Icon} name="phone-off" size=${22} /></button>
  </div>`;
}

export function StageChannelView() {
  const chId = useSel((s) => s.route.channelId); const ch = useSel((s) => getChannel(s.route.channelId));
  const server = useSel((s) => (ch ? s.servers[ch.serverId] : null));
  const conn = useSel((s) => s.voice.conn); const room = useSel((s) => s.voice.states[chId]); const users = useSel((s) => s.users);
  if (!ch) return html`<main class="main panel"></main>`;
  const joined = conn?.channelId === chId; const me = state.me.id;
  const all = Object.values(room || {});
  const speakers = all.filter((s) => s.speaker).sort((a, b) => a.joinedAt - b.joinedAt);
  const audience = all.filter((s) => !s.speaker).sort((a, b) => (b.hand ? 1 : 0) - (a.hand ? 1 : 0) || (a.handAt || 0) - (b.handAt || 0) || a.joinedAt - b.joinedAt);
  const mine = room?.[me]; const mod = isStageMod(ch);
  return html`<main class="main panel chat view-anim sch">
    <header class="m-header">
      <button type="button" class="mobile-only icon-btn" onClick=${() => set({ mobileNav: true })} aria-label="Menu"><${Icon} name="menu" size=${22} /></button>
      <div class="m-title"><${Icon} name="stage" size=${23} /><span class="name">${ch.name}</span></div><div class="m-topic">${ch.topic || server?.name}</div>
    </header>
    <div class="sch-body">
      ${!joined ? html`<div class="sch-hero">
        <div class="icon-big"><${Icon} name="stage" size=${44} sw=${1.8} /></div>
        <h2>${ch.name}</h2>
        ${ch.topic ? html`<p class="sch-topic">${ch.topic}</p>` : null}
        <p>${all.length ? `${speakers.length} ${t('on stage')} · ${audience.length} ${t('listening')}` : t('Nobody is here yet. Be the first!')}</p>
        ${speakers.length ? html`<div class="vc-faces">${speakers.slice(0, 8).map((s) => html`<${Avatar} user=${users[s.userId]} size=${44} key=${s.userId} />`)}</div>` : null}
        <${Btn} variant="primary" size="lg" icon="stage" onClick=${() => voice.join(chId)}>${t('Join Stage')}<//>
      </div>` : html`
        <section class="sch-stage" aria-label=${t('On stage')}>
          <div class="sch-label">${speakers.length ? html`<span class="sch-live">LIVE</span>` : null}${t('On stage')} · ${speakers.length}</div>
          ${speakers.length ? html`<${Grid} chId=${chId} uids=${speakers.map((s) => s.userId)} />` : html`<div class="sch-empty">
            <${Icon} name="stage" size=${38} sw=${1.6} />
            <b>${t('Nobody is on stage yet')}</b>
            <span>${mod ? t('Become a speaker to start the stage, or invite someone who raised their hand.') : t('Raise your hand and a moderator can invite you to speak.')}</span>
          </div>`}
        </section>
        <section class="sch-audience" aria-label=${t('Audience')}>
          <div class="sch-label">${t('Audience')} · ${audience.length}</div>
          <div class="sch-aud-grid">${audience.map((s) => html`<${Listener} key=${s.userId} st=${s} mod=${mod} />`)}</div>
        </section>
        <${StageControls} ch=${ch} conn=${conn} mine=${mine} mod=${mod} />`}
    </div>
  </main>`;
}
