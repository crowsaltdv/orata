// Orate — chat view (channel / DM header + message list + composer) and right-panel routing.
import { html, useEffect, useState, cx, copyText } from '/js/lib.js';
import { state, set, useSel, getChannel, dmName, dmUserId, openModal, updateSettings, updateLocal, hasPerm, isMuted, toast, go } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { Avatar, IconBtn, Modal, MODALS } from '/js/ui.js';
import { MessageList } from '/js/messagelist.js';
import { Composer, composerApi } from '/js/composer.js';
import { MembersPanel, DmProfilePanel, PinsPanel, SearchPanel } from '/js/panels.js';
import { TagChip } from '/js/sidebar.js';
import { voice } from '/js/voice.js';
import { closeModal } from '/js/store.js';
import { t } from '/js/i18n.js';

export function effectivePanel(view, ch, panel) {
  if (!ch) return null;
  if (panel === 'pins' || panel === 'search') return panel;
  if (view === 'dm' && ch.type === 'dm') return panel ? 'profile' : null;
  if (panel === 'profile' && ch.type !== 'dm') return 'members';
  return panel;
}
function togglePanel(name) {
  const cur = state.panel === name || (name === 'members' && state.panel === 'profile');
  const next = cur ? null : name; set({ panel: next }); if (name === 'members' || name === 'profile') updateLocal({ panel: next });
}
export function RightPanel() {
  const view = useSel((s) => s.route.view); const chId = useSel((s) => s.route.channelId); const ch = useSel((s) => getChannel(s.route.channelId));
  const panel = useSel((s) => s.panel);
  const width = useSel((s) => s.width);
  const p = effectivePanel(view, ch, panel);
  if (!p || (view !== 'dm' && view !== 'channel') || !ch || ch.type === 'voice' && p === 'members') return null;
  if (width < 1100) return null;
  return html`<aside class=${cx('right panel right-enter', p === 'profile' && 'wide')} key=${p + chId}>
    ${p === 'members' ? html`<${MembersPanel} chId=${chId} />` : p === 'profile' ? html`<${DmProfilePanel} chId=${chId} />` : p === 'pins' ? html`<${PinsPanel} chId=${chId} />` : html`<${SearchPanel} chId=${chId} />`}
  </aside>`;
}

MODALS.topic = function TopicModal({ id, channelId }) {
  const ch = getChannel(channelId);
  return html`<${Modal} title=${`#${ch?.name}`} width=${480} onClose=${() => closeModal(id)}><p style="white-space:pre-wrap;line-height:1.5">${ch?.topic || 'No topic set.'}</p><//>`;
};

export function ChatView() {
  const chId = useSel((s) => s.route.channelId); const view = useSel((s) => s.route.view);
  const ch = useSel((s) => getChannel(s.route.channelId));
  const panel = useSel((s) => s.panel);
  const other = useSel((s) => (ch?.type === 'dm' ? s.users[dmUserId(ch)] : null));
  const muted = useSel((s) => (ch ? isMuted(ch) : false));
  const conn = useSel((s) => s.voice.conn);
  const connected = useSel((s) => !!ch && s.voice.conn?.channelId === ch.id);
  const roomCount = useSel((s) => (ch ? Object.keys(s.voice.states[ch.id] || {}).length : 0));
  const connection = useSel((s) => s.connection);
  const query = useSel((s) => s.searchQuery);
  const [Stage, setStage] = useState(null);
  useEffect(() => { if (ch && !ch.serverId && roomCount) import('/js/voiceview.js').then((m) => setStage(() => m.CallStage)); }, [ch?.id, roomCount]);
  // type anywhere to focus the composer
  useEffect(() => {
    const h = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
      const a = document.activeElement; if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable || a.tagName === 'SELECT')) return;
      if (state.modals.length || state.settingsPage || state.quick) return;
      composerApi.focus();
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);
  if (!ch) return html`<main class="main panel"></main>`;
  const isDm = !ch.serverId; const isGroup = ch.type === 'group';
  const inRoom = roomCount > 0;
  const showStage = isDm && (connected || inRoom) && Stage;
  const startCall = (video) => { voice.join(ch.id); if (video) setTimeout(() => voice.toggleCamera(), 600); };
  const pinsOn = panel === 'pins';
  const hasPanel = effectivePanel(view, ch, panel);
  return html`<main class="main panel chat view-anim" key=${ch.id}>
    ${connection !== 'online' ? html`<div class=${cx('conn-banner', connection === 'offline' && 'off')}>${connection === 'connecting' ? t('Reconnecting…') : t('Connection lost — retrying…')}</div>` : null}
    <header class="m-header">
      <button type="button" class="mobile-only icon-btn" onClick=${() => set({ mobileNav: true })} aria-label="Menu"><${Icon} name="menu" size=${22} /></button>
      <div class="m-title">
        ${isDm ? (isGroup ? html`<span class="group-av sm"><${Icon} name="users" size=${15} /></span>` : html`<${Avatar} user=${other} size=${28} status=${other?.status || 'offline'} />`) : html`<${Icon} name=${ch.private ? 'hash-lock' : 'hash'} size=${23} />`}
        <span class="name">${isDm ? dmName(ch, 5) : ch.name}</span>${other?.tag ? html`<${TagChip} tag=${other.tag} />` : null}
        ${isDm && !isGroup && other?.customStatus ? html`<span class="m-topic" style="border:0;padding:0">${other.customStatus.emoji} ${other.customStatus.text}</span>` : null}
      </div>
      ${!isDm && ch.topic ? html`<div class="m-topic" onClick=${() => openModal('topic', { channelId: ch.id })} title=${ch.topic}>${ch.topic}</div>` : null}
      <div class="m-actions">
        ${isDm ? html`<${IconBtn} icon="phone" label=${connected ? t('In call') : t('Start Voice Call')} active=${connected} onClick=${() => (connected ? null : startCall(false))} />
          <${IconBtn} icon="video" label=${t('Start Video Call')} onClick=${() => startCall(true)} />` : null}
        ${!isDm ? html`<${IconBtn} icon=${muted ? 'bell-off' : 'bell'} label=${muted ? t('Unmute Channel') : t('Mute Channel')} active=${muted} onClick=${() => updateSettings({ mutedChannels: { [ch.id]: !muted } })} />` : null}
        <${IconBtn} icon="pin" class="hide-sm hide-narrow" label=${t('Pinned Messages')} active=${pinsOn} onClick=${() => set({ panel: pinsOn ? state.local.panel : 'pins' })} />
        ${isDm ? html`<${IconBtn} icon="user-plus" class="hide-sm hide-narrow" label=${isGroup ? t('Add Friends to DM') : t('Create Group DM')} onClick=${() => openModal('create-dm', { fromChannel: ch.id })} />` : null}
        <${IconBtn} icon=${isDm && !isGroup ? 'user' : 'users'} label=${isDm && !isGroup ? t('Show User Profile') : t('Member List')} active=${hasPanel === 'members' || hasPanel === 'profile'} onClick=${() => togglePanel(isDm && !isGroup ? 'profile' : 'members')} />
        <label class="m-search"><${Icon} name="search" size=${15} /><input placeholder=${isDm ? `${t('Search')}` : `${t('Search')} ${state.servers[ch.serverId]?.name || ''}`} value=${query} onFocus=${() => set({ panel: 'search' })} onInput=${(e) => set({ searchQuery: e.target.value, panel: 'search' })} /></label>
      </div>
    </header>
    ${showStage ? html`<${Stage} chId=${ch.id} />` : null}
    <div class="chat-col"><${MessageList} chId=${ch.id} key=${ch.id} /><${Composer} chId=${ch.id} /></div>
  </main>`;
}
void go; void hasPerm; void toast; void copyText;
