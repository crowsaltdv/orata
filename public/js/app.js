// Orate — application root: shell layout, routing, hotkeys, document title.
import { html, useEffect, cx, ls, lsRemove } from '/js/lib.js';
import { state, set, useSel, go, openModal, closeModal, unreadInfo, getChannel, dmName } from '/js/store.js';
import { AuthScreen, Splash } from '/js/auth.js';
import { ModalHost, ContextMenu, PopoverHost, ToastHost } from '/js/ui.js';
import { ServerRail } from '/js/rail.js';
import { DmSidebar, ChannelSidebar } from '/js/sidebar.js';
import { UserBar } from '/js/userbar.js';
import { FriendsView, ActiveNow } from '/js/friends.js';
import { ChatView, RightPanel } from '/js/chat.js';
import { QuickSwitcher, Lightbox } from '/js/overlays.js';
import { SettingsHost } from '/js/settings.js';
import { ServerSettingsHost } from '/js/server-settings.js';
import { VoiceChannelView } from '/js/voiceview.js';
import { CallOverlay } from '/js/callui.js';
import '/js/modals.js';
import '/js/pickers.js';
import '/js/voice.js';
import { markAllRead, ackChannel } from '/js/actions.js';
import { VerifyScreen, VerifyGate, VerifyBanner } from '/js/verify.js';
import { MusicPanel } from '/js/music.js';
import { ForumView } from '/js/forum.js';
import '/js/polls.js';

function MainView() {
  const view = useSel((s) => s.route.view);
  const chId = useSel((s) => s.route.channelId);
  const chType = useSel((s) => getChannel(s.route.channelId)?.type);
  const isVoice = chType === 'voice';
  switch (view) {
    case 'friends': return html`<${FriendsView} />`;
    case 'dm': return html`<${ChatView} key=${chId} />`;
    case 'channel': return chId ? (isVoice ? html`<${VoiceChannelView} key=${chId} />` : chType === 'forum' ? html`<${ForumView} key=${chId} />` : html`<${ChatView} key=${chId} />`) : html`<main class="main panel"></main>`;
    default: return html`<${FriendsView} />`;
  }
}

function Shell() {
  const serverId = useSel((s) => s.route.serverId); const view = useSel((s) => s.route.view);
  const nav = useSel((s) => s.mobileNav);
  const behind = useSel((s) => !!s.settingsPage || !!s.serverSettings);
  const totalUnread = useSel((s) => {
    let n = 0; for (const id of Object.keys(s.reads)) n += s.reads[id].mentions || 0; return n;
  });
  const anyUnread = useSel((s) => Object.keys(s.lastMsg).some((id) => { const c = s.channelIndex[id]; return c && (c.type === 'text' || c.type === 'dm' || c.type === 'group') && unreadInfo(id).unread && !s.settings.mutedChannels[id] && !(s.settings.mutedServers[c.serverId]); }));
  const chName = useSel((s) => { const c = getChannel(s.route.channelId); return c ? (c.serverId ? (c.type === 'post' ? c.name : `#${c.name}`) : dmName(c)) : view === 'friends' ? 'Friends' : ''; });
  useEffect(() => { document.title = `${totalUnread ? `(${totalUnread}) ` : anyUnread ? '• ' : ''}${chName ? chName + ' | ' : ''}Orate`; }, [totalUnread, anyUnread, chName]);

  // pending invite after login
  useEffect(() => {
    const code = ls('pendingInvite', null) || (state.route.view === 'invite' ? state.route.param : null);
    if (code) { lsRemove('pendingInvite'); openModal('invite-accept', { code }); if (state.route.view === 'invite') go('/channels/@me', { replace: true }); }
  }, []);
  // global hotkeys
  useEffect(() => {
    const h = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); set({ quick: !state.quick }); }
      else if (mod && e.key === '/') { e.preventDefault(); openModal('shortcuts'); }
      else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); cycle(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey); }
      else if (e.key === 'Escape' && !state.modals.length && !state.ctx && !state.popover && !state.quick && !state.settingsPage && !state.serverSettings && !state.lightbox) {
        if (state.replyTo) set({ replyTo: null });
        else if (state.panel === 'pins' || state.panel === 'search') set({ panel: state.local.panel, searchQuery: '' });
        else if (e.shiftKey) markAllRead();
        else if (state.route.channelId && unreadInfo(state.route.channelId).unread) ackChannel(state.route.channelId);
      }
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);
  return html`<div class="shell" data-nav=${nav ? 'open' : 'closed'} data-behind=${behind ? '1' : '0'}>
    ${nav ? html`<div class="nav-scrim" onClick=${() => set({ mobileNav: false })}></div>` : null}
    <div class="left-col">
      <div class="left-top"><${ServerRail} />${serverId === '@me' ? html`<${DmSidebar} />` : html`<${ChannelSidebar} key=${serverId} />`}</div>
      <${UserBar} />
    </div>
    <${MainView} />
    ${view === 'friends' ? html`<${ActiveNow} />` : html`<${RightPanel} />`}
    <${MusicPanel} />
  </div>`;
}
function cycle(dir, unreadOnly) {
  const { serverId } = state.route; const list = [];
  if (serverId === '@me') for (const d of Object.values(state.dms)) list.push({ id: d.id, go: () => go({ view: 'dm', serverId: '@me', channelId: d.id }) });
  else for (const c of state.servers[serverId]?.channels || []) if (c.type === 'text') list.push({ id: c.id, go: () => go({ view: 'channel', serverId, channelId: c.id }) });
  const cand = unreadOnly ? list.filter((x) => unreadInfo(x.id).unread || x.id === state.route.channelId) : list;
  const i = cand.findIndex((x) => x.id === state.route.channelId); const n = cand[(i + dir + cand.length) % cand.length];
  n?.go();
}

export function App() {
  const phase = useSel((s) => s.phase);
  const lang = useSel((s) => s.settings.lang);
  const gated = useSel((s) => s.gated);
  const verifying = useSel((s) => s.route.view === 'verify');
  useEffect(() => { if (phase !== 'ready') document.title = 'Orate'; }, [phase]);
  return html`<div class="app-root" key=${lang}>
    ${verifying ? html`<${VerifyScreen} />` : phase === 'auth' ? html`<${AuthScreen} />` : phase === 'ready' ? (gated ? html`<${VerifyGate} />` : html`<${Shell} />`) : html`<${Splash} />`}
    ${phase === 'ready' && !gated && !verifying ? html`<${CallOverlay} /><${QuickSwitcher} /><${SettingsHost} /><${ServerSettingsHost} /><${VerifyBanner} />` : null}
    <${Lightbox} /><${ModalHost} /><${ContextMenu} /><${PopoverHost} /><${ToastHost} />
  </div>`;
}
void cx; void closeModal;
