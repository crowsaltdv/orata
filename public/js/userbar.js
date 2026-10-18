// Orate — user bar (avatar, mute/deafen, settings) + voice connection panel.
import { html, cx, useState } from '/js/lib.js';
import { state, useSel, go, goChannel, updateSettings, openContext, openPopover, toast, getChannel, dmName, set, closePopover } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { Avatar, IconBtn, POPOVERS, Btn, TextInput, Modal } from '/js/ui.js';
import { openSettings, act } from '/js/actions.js';
import { api } from '/js/api.js';
import { voice } from '/js/voice.js';
import { logout } from '/js/events.js';
import { STATUS_META } from '/js/defaults.js';
import { copyText } from '/js/lib.js';
import { t } from '/js/i18n.js';

export async function setStatus(status) { await act(api.patch('/me', { status })); }

POPOVERS['user-menu'] = function UserMenu({ close }) {
  const me = useSel((s) => s.me);
  const cs = me.customStatus;
  const item = (icon, label, onClick, cls) => html`<button type="button" class=${cx('um-item', cls)} onClick=${() => { close(); onClick(); }}><${Icon} name=${icon} size=${17} /><span>${label}</span></button>`;
  return html`<div class="pop-card user-menu">
    <div class="um-head"><${Avatar} user=${me} size=${44} status=${me.status} /><div><b>${me.displayName}</b><span>@${me.username}</span></div></div>
    <button type="button" class="um-custom" onClick=${() => { close(); import('/js/store.js').then((m) => m.openModal('custom-status')); }}>
      <${Icon} name="smile-plus" size=${17} /><span>${cs ? `${cs.emoji || ''} ${cs.text}`.trim() : t('Set a custom status')}</span>${cs ? html`<span class="um-x" onClick=${(e) => { e.stopPropagation(); act(api.patch('/me', { customStatus: null })); }}><${Icon} name="x" size=${14} /></span>` : null}</button>
    <div class="ctx-sep"></div>
    ${['online', 'idle', 'dnd', 'invisible'].map((s) => html`<button type="button" class=${cx('um-item', me.status === s && 'sel')} onClick=${() => { close(); setStatus(s); }}>
      <span class="um-dot" style=${{ background: STATUS_META[s].color }}></span><span>${t(STATUS_META[s].label)}</span>${s === 'idle' ? html`<small>${t('Auto')}</small>` : s === 'invisible' ? html`<small>${t('Appear offline')}</small>` : s === 'dnd' ? html`<small>${t('Mutes notifications')}</small>` : null}</button>`)}
    <div class="ctx-sep"></div>
    ${item('user', t('Edit Profile'), () => openSettings('profile'))}
    ${item('copy', t('Copy My ID'), async () => { await copyText(me.id); toast('ID copied', 'success', 1500); })}
    ${item('log-out', t('Log Out'), () => logout(), 'danger')}
  </div>`;
};

import { MODALS } from '/js/ui.js';
const EMOJI_QUICK = ['😀', '😎', '🎧', '💻', '🎮', '📚', '🌧️', '☕', '🔥', '💤', '🎉', '🎵'];
MODALS['custom-status'] = function CustomStatus({ id }) {
  const me = state.me; const cs = me.customStatus;
  const [text, setText] = useState(cs?.text || ''); const [emoji, setEmoji] = useState(cs?.emoji || '😀'); const [clear, setClear] = useState('never');
  const close = () => import('/js/store.js').then((m) => m.closeModal(id));
  const save = async () => {
    const mins = { never: 0, '30': 30, '60': 60, '240': 240, today: Math.ceil((new Date().setHours(23, 59, 59, 999) - Date.now()) / 60000) }[clear];
    await act(api.patch('/me', { customStatus: text.trim() || emoji ? { emoji, text: text.trim(), expiresAt: mins ? Date.now() + mins * 60000 : null } : null })); close();
  };
  return html`<${Modal} title=${t('Set a custom status')} width=${440} onClose=${close} footer=${html`<${Btn} variant="ghost" onClick=${close}>Cancel<//><${Btn} variant="primary" onClick=${save}>Save<//>`}>
    <div class="cs-row"><div class="cs-emoji"><span>${emoji}</span></div><${TextInput} value=${text} onInput=${setText} placeholder="What's cookin', good lookin'?" maxlength="128" autofocus onKeyDown=${(e) => e.key === 'Enter' && save()} /></div>
    <div class="cs-quick">${EMOJI_QUICK.map((e) => html`<button type="button" class=${cx(e === emoji && 'sel')} onClick=${() => setEmoji(e)}>${e}</button>`)}</div>
    <label class="field"><span class="field-label">Clear after</span><select class="select" value=${clear} onChange=${(e) => setClear(e.target.value)}><option value="never">Don't clear</option><option value="30">30 minutes</option><option value="60">1 hour</option><option value="240">4 hours</option><option value="today">Today</option></select></label>
  <//>`;
};

export function UserBar() {
  const me = useSel((s) => s.me);
  const conn = useSel((s) => s.voice.conn);
  const ch = useSel((s) => (s.voice.conn ? getChannel(s.voice.conn.channelId) : null));
  const server = useSel((s) => (ch?.serverId ? s.servers[ch.serverId] : null));
  const joinMuted = useSel((s) => s.local.voice.joinMuted);
  const muted = conn ? conn.muted || conn.deafened : joinMuted; const deaf = !!conn?.deafened;
  const [bump, setBump] = useState(0);
  const status = me.status === 'invisible' ? 'invisible' : me.status;
  return html`<div class="userbar panel">
    ${conn ? html`<div class="vc-panel">
      <div class="vc-row"><div class="vc-status"><b><${Icon} name="wifi" size=${15} />${conn.status === 'connecting' ? t('Connecting…') : t('Voice Connected')}</b><span>${ch ? (ch.serverId ? `${ch.name} / ${server?.name}` : dmName(ch)) : ''}</span></div>
        <${IconBtn} icon="phone-off" label=${t('Disconnect')} class="leave" onClick=${() => voice.leave()} glass=${null} /></div>
      <div class="vc-btns">
        <${IconBtn} icon=${conn.video ? 'video' : 'video-off'} label=${conn.video ? t('Turn Off Camera') : t('Turn On Camera')} active=${conn.video} onClick=${() => voice.toggleCamera()} glass="buttons" />
        <${IconBtn} icon="monitor" label=${conn.screen ? t('Stop Sharing') : t('Share Your Screen')} active=${conn.screen} onClick=${() => voice.toggleScreen()} glass="buttons" />
        <${IconBtn} icon="grid" label=${t('Open voice view')} onClick=${() => ch && (ch.serverId ? goChannel(ch.serverId, ch.id) : go(`/channels/@me/${ch.id}`))} glass="buttons" />
      </div></div>` : null}
    <div class="ub-row">
      <button type="button" class="ub-user" onClick=${(e) => openPopover(e.currentTarget, 'user-menu', {}, { placement: 'top-start' })} data-popover-anchor>
        <${Avatar} user=${me} size=${38} status=${status} />
        <span class="ub-text"><span class="ub-name">${me.displayName}</span><span class="ub-status">${me.customStatus ? `${me.customStatus.emoji || ''} ${me.customStatus.text}`.trim() : t(STATUS_META[status]?.label || 'Online')}</span></span>
      </button>
      <div class="ub-icons">
        <${IconBtn} icon=${muted ? 'mic-off' : 'mic'} label=${muted ? t('Unmute') : t('Mute')} class=${muted ? 'muted-state' : ''} onClick=${() => { voice.toggleMute(); setBump(bump + 1); }} onContextMenu=${(e) => { e.preventDefault(); openSettings('voice'); }} pos="top" glass="buttons" />
        <${IconBtn} icon=${deaf ? 'headphones-off' : 'headphones'} label=${deaf ? t('Undeafen') : t('Deafen')} class=${deaf ? 'muted-state' : ''} onClick=${() => voice.toggleDeafen()} pos="top" glass="buttons" />
        <${IconBtn} icon="settings" label=${t('User Settings')} onClick=${() => openSettings('account')} pos="top" glass="buttons" />
      </div>
    </div>
  </div>`;
}
void updateSettings; void set; void closePopover; void toast;
