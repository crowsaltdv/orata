// Orata — application root: shell layout, routing, hotkeys, document title.
import { html, useEffect, useState, cx, ls, lsRemove } from '/js/lib.js';
import { state, set, useSel, go, openModal, closeModal, unreadInfo, getChannel, dmName } from '/js/store.js';
import { AuthScreen, Splash } from '/js/auth.js';
import { DesktopPrompt } from '/js/desktop.js';
import { ModalHost, ContextMenu, PopoverHost, ToastHost, SaveBarHost, Btn } from '/js/ui.js';
import { Icon } from '/js/icons.js';
import { t } from '/js/i18n.js';
import { LITE, MODE_OWNER, preferredMode, setMode, modeChosenThisVisit } from '/js/lite.js';
import { ServerRail } from '/js/rail.js';
import { DmSidebar, ChannelSidebar } from '/js/sidebar.js';
import { UserBar } from '/js/userbar.js';
import { FriendsView, ActiveNow } from '/js/friends.js';
import { ChatView, RightPanel } from '/js/chat.js';
import { QuickSwitcher, Lightbox } from '/js/overlays.js';
import { VoiceChannelView } from '/js/voiceview.js';
import { StageChannelView } from '/js/stageview.js';
import { CallOverlay } from '/js/callui.js';
import '/js/modals.js';
import '/js/pickers.js';
import '/js/voice.js';
import { markAllRead, ackChannel } from '/js/actions.js';
import { VerifyScreen, VerifyGate, VerifyBanner } from '/js/verify.js';
import { MusicPage } from '/js/music.js';
import { StaffPage } from '/js/staff.js';
import { ThemesPage, ThemePreviewBar } from '/js/themes.js';
import { ForumView } from '/js/forum.js';
import '/js/polls.js';

function MainView() {
  const view = useSel((s) => s.route.view);
  const chId = useSel((s) => s.route.channelId);
  const chType = useSel((s) => getChannel(s.route.channelId)?.type);
  const isVoice = chType === 'voice';
  switch (view) {
    case 'friends': return html`<${FriendsView} />`;
    case 'music': return html`<${MusicPage} />`;
    case 'staff': return html`<${StaffPage} />`;
    case 'themes': return html`<${ThemesPage} />`;
    case 'dm': return html`<${ChatView} key=${chId} />`;
    case 'channel': return chId ? (isVoice ? html`<${VoiceChannelView} key=${chId} />` : chType === 'stage' ? html`<${StageChannelView} key=${chId} />` : chType === 'forum' ? html`<${ForumView} key=${chId} />` : html`<${ChatView} key=${chId} />`) : html`<main class="main panel"></main>`;
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
  const chName = useSel((s) => { const c = getChannel(s.route.channelId); return c ? (c.serverId ? (c.type === 'post' ? c.name : `#${c.name}`) : dmName(c)) : view === 'friends' ? 'Friends' : view === 'music' ? 'Music' : view === 'themes' ? 'Discovery' : ''; });
  useEffect(() => { document.title = `${totalUnread ? `(${totalUnread}) ` : anyUnread ? '• ' : ''}${chName ? chName + ' | ' : ''}Orata`; }, [totalUnread, anyUnread, chName]);

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
    ${view === 'friends' ? html`<${ActiveNow} />` : view === 'music' || view === 'staff' || view === 'themes' ? null : html`<${RightPanel} />`}
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

/** A screen whose code loads only once it's first needed (and then stays). */
function later(load, name, needed) {
  let C = null; let p = null;
  return function Later() {
    const want = useSel(needed); const [, bump] = useState(0);
    if (C) return html`<${C} />`;
    if (want) (p ||= load().then((m) => { C = m[name]; })).then(() => bump((n) => n + 1));
    return null;
  };
}
const SettingsHost = later(() => import('/js/settings.js'), 'SettingsHost', (s) => !!s.settingsPage);
const ServerSettingsHost = later(() => import('/js/server-settings.js'), 'ServerSettingsHost', (s) => !!s.serverSettings);

// what each mode has, listed on its card: [feature, what Lite mode says instead, in red with an ✕ (none: Lite has it too)]
const MODE_FEATURES = [['Chats, servers, DMs, voice and video'], ['Themes, colors and animations'], ['Profile effects'], ['Rain and liquid glass', 'No rain or liquid glass'],
  ['Wallpaper pictures and blur', 'No wallpaper pictures or blur'], ['Custom fonts', 'No custom fonts'], ['Link previews', 'No link previews'], ['Full-quality GIFs and pictures', 'Smaller GIFs and pictures']];
const Feature = ({ name, no }) => html`<span class=${cx('mf', no && 'no')}><${Icon} name=${no ? 'x' : 'check'} size=${15} sw=${3} />${t(no || name)}</span>`;

/** The launch screen: Normal or Lite mode (lite.js), every time Orata opens, until "Don't show again" makes the pick the mode it opens in.
 *  Only orata_dev sees it, for now. */
function ModeChooser() {
  const mine = useSel((s) => s.me?.username === MODE_OWNER);
  const [open, setOpen] = useState(() => preferredMode() === 'ask' && !modeChosenThisVisit());
  const [keep, setKeep] = useState(false); const [picked, setPicked] = useState(null);
  if (!mine || !open) return null;
  const pick = (mode) => { if (keep) setPicked(mode); else { setOpen(false); setMode(mode); } };
  const card = (mode, icon, title, desc, boost) => html`<button type="button" class=${cx('mode-card', (mode === 'lite') === LITE && 'current')} onClick=${() => pick(mode)}>
    <${Icon} name=${icon} size=${28} /><b>${title}</b>${boost ? html`<em class="mode-boost">${boost}</em>` : null}<span>${desc}</span>${(mode === 'lite') === LITE ? html`<small>${t('Running now')}</small>` : null}
    <span class="mode-list">${MODE_FEATURES.map(([name, lite]) => html`<${Feature} name=${name} no=${mode === 'lite' ? lite : null} />`)}</span></button>`;
  return html`<div class="mode-screen" role="dialog" aria-label=${t('Choose a mode')}><div class="mode-box">
    ${picked ? html`<h2>${t('Got it')}</h2>
        <p>${t('Orata will open in')} <b>${picked === 'lite' ? t('Lite mode') : t('Normal mode')}</b> ${t('from now on. You can switch modes, and change the mode Orata opens in, any time in Settings → Advanced.')}</p>
        <${Btn} variant="primary" onClick=${() => { setOpen(false); setMode(picked, picked); }}>${t('OK')}<//>`
      : html`<h2>${t('How should Orata run?')}</h2>
        <div class="mode-cards">${card('lite', 'bolt', t('Lite mode'), t('Runs smoothly on older and low-power computers. The same chats, servers and calls, without the heavy effects.'), t('2× the speed and performance of Normal'))}${card('normal', 'sparkles', t('Normal mode'), t('Everything Orata has: rain, glass, wallpapers and every effect.'))}</div>        <label class="check-row mode-keep"><input type="checkbox" checked=${keep} onChange=${(e) => setKeep(e.target.checked)} /><span class="box"><${Icon} name="check" size=${13} sw=${3.5} /></span><span>${t('Don’t show this again')}</span></label>`}
  </div></div>`;
}

export function App() {
  const phase = useSel((s) => s.phase);
  const lang = useSel((s) => s.settings.lang); const i18nVer = useSel((s) => s.i18nVer || 0);
  // Normal mode fetches the settings screens quietly once it's up, so they still open at once; Lite mode waits until they're opened
  useEffect(() => { if (phase !== 'ready' || LITE) return undefined; const id = setTimeout(() => { import('/js/settings.js'); import('/js/server-settings.js'); }, 4000); return () => clearTimeout(id); }, [phase]);
  const gated = useSel((s) => s.gated);
  const verifying = useSel((s) => s.route.view === 'verify');
  useEffect(() => { if (phase !== 'ready') document.title = 'Orata'; }, [phase]);
  return html`<div class="app-root" key=${`${lang}:${i18nVer}`}>
    ${verifying ? html`<${VerifyScreen} />` : phase === 'auth' ? html`<${AuthScreen} /><${DesktopPrompt} />` : phase === 'ready' ? (gated ? html`<${VerifyGate} />` : html`<${Shell} />`) : html`<${Splash} />`}
    ${phase === 'ready' && !gated && !verifying ? html`<${CallOverlay} /><${QuickSwitcher} /><${SettingsHost} /><${ServerSettingsHost} /><${SaveBarHost} /><${ThemePreviewBar} /><${VerifyBanner} />` : null}
    ${phase === 'ready' && !gated && !verifying ? html`<${ModeChooser} />` : null}
    <${Lightbox} /><${ModalHost} /><${ContextMenu} /><${PopoverHost} /><${ToastHost} />
  </div>`;
}
void cx; void closeModal;
