// Orate — user settings overlay (account, profile, appearance, voice, notifications, language …).
import { html, useState, useEffect, useRef, cx, copyText, formatMemberSince, relTime, ls } from '/js/lib.js';
import { state, set, useSel, closeModal, openModal, closePopover, setSetting, updateSettings, resetSettings, toast, updateLocal } from '/js/store.js';
import { Icon, Logo } from '/js/icons.js';
import { Btn, Field, TextInput, Toggle, SettingRow, Section, Segmented, Modal, MODALS, Avatar, ColorSwatch, Empty, confirmDialog, Dropdown, useEscape, useSaveBar } from '/js/ui.js';
import { api } from '/js/api.js';
import { act, errMsg, closeSettings, openSettings } from '/js/actions.js';
import { logout } from '/js/events.js';
import { chooseAndUploadImage, uploadGifFrom } from '/js/imageutil.js';
import { openPicker } from '/js/pickers.js';
import { ProfileCard, Banner } from '/js/profile.js';
import { ProfileStyleEditor } from '/js/profile-style.js';
import { CloakPage } from '/js/cloak.js';
import { ThemePage, WallpaperPage, EffectsPage, FontsPage, ChatPage, SToggle, SSlider } from '/js/settings-appearance.js';
import { VoicePage } from '/js/settings-voice.js';
import { LANGUAGES, t } from '/js/i18n.js';
import { resendVerification } from '/js/verify.js';
import { playSound } from '/js/sound.js';
import { DEFAULT_SETTINGS } from '/js/defaults.js';

/* ------------------------------------------------------------------ account */
MODALS['account-edit'] = function AccountEdit({ id, field }) {
  const me = state.me; const [v, setV] = useState(field === 'username' ? me.username : field === 'email' ? (me.email || '') : '');
  const [pw, setPw] = useState(''); const [pw2, setPw2] = useState(''); const [cur, setCur] = useState(''); const [err, setErr] = useState(null); const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      if (field === 'password') { if (pw !== pw2) throw new Error('Passwords do not match'); await api.post('/me/password', { current: cur, password: pw }); toast('Password changed. Other devices were signed out.', 'success', 4000); }
      else { await api.patch('/me', { [field]: v, password: cur }); toast(`${field === 'email' ? 'Email' : 'Username'} updated`, 'success'); }
      closeModal(id);
    } catch (e) { setErr(errMsg(e)); setBusy(false); }
  };
  const title = { username: 'Change your username', email: me.email ? 'Change your email' : 'Add an email', password: 'Update your password' }[field];
  return html`<${Modal} title=${title} subtitle=${field === 'password' ? 'Enter your current password and a new one.' : 'Enter a new value and your current password.'} width=${440} onClose=${() => closeModal(id)} footer=${html`<${Btn} variant="ghost" onClick=${() => closeModal(id)}>Cancel<//><${Btn} variant="primary" loading=${busy} disabled=${!cur || (field === 'username' && !v) || (field === 'password' && (!pw || !pw2))} onClick=${save}>Done<//>`}>
    ${field !== 'password' ? html`<${Field} label=${field === 'email' ? 'Email' : 'Username'}><${TextInput} value=${v} onInput=${setV} autofocus type=${field === 'email' ? 'email' : 'text'} onKeyDown=${(e) => e.key === 'Enter' && save()} /><//>` : html`<${Field} label="New password"><${TextInput} type="password" value=${pw} onInput=${setPw} autofocus /><//><${Field} label="Confirm new password"><${TextInput} type="password" value=${pw2} onInput=${setPw2} /><//>`}
    <${Field} label="Current password" error=${err}><${TextInput} type="password" value=${cur} onInput=${setCur} onKeyDown=${(e) => e.key === 'Enter' && save()} /><//>
  <//>`;
};
MODALS['delete-account'] = function DeleteAccount({ id }) {
  const [pw, setPw] = useState(''); const [err, setErr] = useState(null); const [busy, setBusy] = useState(false);
  const del = async () => { setBusy(true); try { await api.del('/me', { password: pw }); closeModal(id); closeSettings(); logout({ silent: true }); } catch (e) { setErr(errMsg(e)); setBusy(false); } };
  return html`<${Modal} title="Delete your account" subtitle="This is permanent. Your servers are deleted, your messages stay as “Deleted User”." width=${440} onClose=${() => closeModal(id)} footer=${html`<${Btn} variant="ghost" onClick=${() => closeModal(id)}>Cancel<//><${Btn} variant="danger" loading=${busy} disabled=${!pw} onClick=${del}>Delete Account<//>`}>
    <${Field} label="Confirm with your password" error=${err}><${TextInput} type="password" value=${pw} onInput=${setPw} autofocus /><//><//>`;
};

function Sessions() {
  const [list, setList] = useState(null);
  const load = () => api.get('/me/sessions').then(setList).catch(() => setList([]));
  useEffect(() => { load(); }, []);
  const label = (ua) => { const b = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser'; const o = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : ''; return `${b}${o ? ' on ' + o : ''}`; };
  if (!list) return null;
  return html`<div class="session-list">${list.map((s) => html`<div class="session-row" key=${s.id}><span class="ss-ic"><${Icon} name=${/Android|iPhone/.test(s.ua) ? 'phone' : 'monitor'} size=${22} /></span><div><b>${label(s.ua)}${s.current ? html`<em class="here">${t('This device')}</em>` : null}</b><small>${t('Last active')} ${relTime(s.lastUsed)}</small></div>${!s.current ? html`<${Btn} size="sm" variant="ghost" onClick=${async () => { await act(api.del(`/me/sessions/${s.id}`)); load(); }}>${t('Log out')}<//>` : null}</div>`)}</div>`;
}
function AccountPage() {
  const me = useSel((s) => s.me); const [reveal, setReveal] = useState(false);
  const masked = me.email ? me.email.replace(/^(.).*(@.*)$/, (_, a, b) => a + '•'.repeat(7) + b) : t('Not set');
  const row = (label, val, action, btn) => html`<div class="acct-row"><div><small>${label}</small><b>${val}</b></div>${action ? html`<${Btn} size="sm" onClick=${action}>${btn || t('Edit')}<//>` : null}</div>`;
  return html`<div class="s-page">
    <div class="acct-card panel"><${Banner} user=${me} height=${100} /><div class="acct-head"><${Avatar} user=${me} size=${84} status=${me.status} class="acct-av" /><div class="acct-name"><b>${me.displayName}</b><span>@${me.username}</span></div><${Btn} variant="primary" icon="edit" onClick=${() => openSettings('profile')}>${t('Edit User Profile')}<//></div>
      <div class="acct-rows">${row(t('Display name'), me.displayName, () => openSettings('profile'))}${row(t('Username'), me.username, () => openModal('account-edit', { field: 'username' }))}${row(t('Email'), reveal ? (me.email || t('Not set')) : masked, () => openModal('account-edit', { field: 'email' }), me.email ? t('Edit') : t('Add'))}${me.email ? html`<button type="button" class="link-btn reveal" onClick=${() => setReveal(!reveal)}>${reveal ? t('Hide') : t('Reveal')} ${t('email')}</button>` : null}${me.email && me.emailVerified === false && state.emailVerif.enabled ? html`<div class="note-chip"><${Icon} name="alert-circle" size=${14} /> ${t('Your email isn’t verified yet.')} <button type="button" class="link-btn" onClick=${() => resendVerification()}>${t('Resend link')}</button></div>` : me.email && me.emailVerified === true && state.emailVerif.enabled ? html`<div class="note-chip ok"><${Icon} name="check" size=${14} /> ${t('Email verified')}</div>` : null}</div></div>
    <${Section} title=${t('Password & devices')}>
      <${SettingRow} title=${t('Password')} desc=${t('Changing your password signs you out of every other device.')}><${Btn} onClick=${() => openModal('account-edit', { field: 'password' })}>${t('Change Password')}<//><//>
      <h4 class="s-sub">${t('Where you’re signed in')}</h4><${Sessions} />
    <//>
    <${Section} title=${t('Account removal')} desc=${t('Disabling isn’t supported — deleting is permanent.')}>
      <div class="danger-zone"><${Btn} variant="danger" icon="trash" onClick=${() => openModal('delete-account')}>${t('Delete Account')}<//></div>
    <//>
  </div>`;
}

/* ------------------------------------------------------------------ profile */
function ProfilePage() {
  const me = useSel((s) => s.me);
  const orig = { displayName: me.displayName, pronouns: me.pronouns || '', bio: me.bio || '', avatar: me.avatar, banner: me.banner, bannerColor: me.bannerColor || '#6d28d9', accentColor: me.accentColor || null, profile: me.profile || null };
  const [d, setD] = useState(orig); const [busy, setBusy] = useState(false); const [up, setUp] = useState(null);
  const dirty = JSON.stringify(d) !== JSON.stringify(orig);
  const up1 = (k, v) => setD((p) => ({ ...p, [k]: v }));
  const img = async (key, opts) => { setUp(key); try { const u = await chooseAndUploadImage(opts); if (u) up1(key, u); } catch (e) { toast(errMsg(e), 'error'); } setUp(null); };
  // a GIF from KLIPY becomes the avatar: fetched through the image proxy, stored on this server like any other upload
  const gifAvatar = (anchor) => openPicker(anchor, {
    onGif: async (item) => {
      closePopover(); setUp('avatar');
      try { const u = await uploadGifFrom(item.preview?.gif || item.full?.gif || item.preview?.url, 'avatar.gif', { aspect: 1, out: 256, round: true, title: 'Avatar' }); if (u) up1('avatar', u); } catch (e) { toast(errMsg(e), 'error'); }
      setUp(null);
    },
  }, { gifOnly: true, tab: 'gif', placement: 'bottom-start' });
  const gifBanner = (anchor) => openPicker(anchor, {
    onGif: async (item) => {
      closePopover(); setUp('banner');
      try { const u = await uploadGifFrom(item.full?.gif || item.preview?.gif || item.preview?.url, 'banner.gif', { aspect: 3, out: 960, title: 'Banner' }); if (u) up1('banner', u); } catch (e) { toast(errMsg(e), 'error'); }
      setUp(null);
    },
  }, { gifOnly: true, tab: 'gif', placement: 'bottom-start' });
  const changeProfile = (fn) => setD((p) => ({ ...p, profile: fn(p.profile || null) }));
  const save = async () => { setBusy(true); const r = await act(api.patch('/me', { displayName: d.displayName.trim() || me.displayName, pronouns: d.pronouns, bio: d.bio, avatar: d.avatar, banner: d.banner, bannerColor: d.bannerColor, accentColor: d.accentColor, profile: d.profile }), { success: 'Profile saved' }); setBusy(false); if (r) set({}); };
  const preview = { ...me, ...d };
  useSaveBar(dirty, { save, reset: () => setD(orig), busy });
  return html`<div class="s-page profile-edit">
    <div class="pe-form">
      <${Section} title=${t('Profile')} desc=${t('How you appear to everyone on Orate.')}>
        <${Field} label=${t('Display name')}><${TextInput} value=${d.displayName} onInput=${(v) => up1('displayName', v)} maxlength="32" /><//>
        <${Field} label=${t('Pronouns')}><${TextInput} value=${d.pronouns} onInput=${(v) => up1('pronouns', v)} maxlength="40" placeholder="they/them" /><//>
        <${Field} label=${t('About me')} hint=${`${d.bio.length}/400 — ${t('supports markdown')}`}><textarea class="textarea" rows="4" maxlength="400" value=${d.bio} onInput=${(e) => up1('bio', e.target.value)} placeholder=${t('Tell everyone a little about yourself')}></textarea><//>
      <//>
      <${Section} title=${t('Avatar')}>
        <div class="pe-media"><${Avatar} user=${preview} size=${72} /><div class="pe-btns"><${Btn} variant="primary" loading=${up === 'avatar'} icon="upload" onClick=${() => img('avatar', { aspect: 1, out: 256, round: true, title: 'Avatar', allowGif: true })}>${t('Change Avatar')}<//>${state.gifOk !== false ? html`<${Btn} icon="sticker" disabled=${up === 'avatar'} onClick=${(e) => gifAvatar(e.currentTarget)}>${t('Choose a GIF')}<//>` : null}${d.avatar ? html`<${Btn} variant="ghost" onClick=${() => up1('avatar', null)}>${t('Remove')}<//>` : html`<${Btn} icon="refresh" onClick=${() => act(api.patch('/me', { avatarBg: 'random' }))}>${t('Shuffle color')}<//>`}</div></div>
        <p class="text-muted" style="font-size:13px;margin:10px 0 0">${t('Upload a GIF or pick one from KLIPY — animated avatars play everywhere.')}</p>
      <//>
      <${Section} title=${t('Banner')}>
        <div class="pe-banner"><${Banner} user=${preview} height=${96} /></div>
        <div class="pe-btns"><${Btn} variant="primary" loading=${up === 'banner'} icon="image" onClick=${() => img('banner', { aspect: 3, out: 960, title: 'Banner', allowGif: true })}>${t('Change Banner')}<//>${state.gifOk !== false ? html`<${Btn} icon="sticker" disabled=${up === 'banner'} onClick=${(e) => gifBanner(e.currentTarget)}>${t('Choose a GIF')}<//>` : null}${d.banner ? html`<${Btn} variant="ghost" onClick=${() => up1('banner', null)}>${t('Remove')}<//>` : null}<span class="pe-color"><${ColorSwatch} value=${d.bannerColor} onChange=${(c) => up1('bannerColor', c)} label=${t('First banner color')} size=${34} /><small>${t('First color')}</small></span><span class="pe-color"><${ColorSwatch} value=${d.accentColor || '#ec4899'} onChange=${(c) => up1('accentColor', c)} label=${t('Second banner color')} size=${34} /><small>${t('Second color')}</small>${d.accentColor ? html`<button type="button" class="link-btn" onClick=${() => up1('accentColor', null)}>${t('Reset')}</button>` : null}</span></div>
        <p class="text-muted" style="font-size:13px;margin:10px 0 0">${t('Upload a GIF or pick one from KLIPY — animated banners play everywhere.')}</p>
      <//>
      <${Section} title=${t('Profile style')} desc=${t('Colors, outline, fonts, name style and effects for your profile. The preview updates as you go.')}>
        <${ProfileStyleEditor} value=${d.profile} change=${changeProfile} me=${me} />
      <//>
    </div>
    <div class="pe-preview"><h4 class="s-sub">${t('Preview')}</h4><div class="pop-card profile-pop"><${ProfileCard} userId=${me.id} userOverride=${preview} mode="modal" /></div></div>
  </div>`;
}

/* ------------------------------------------------------------------ smaller pages */
function AccessPage() {
  return html`<div class="s-page">
    <${Section} title=${t('Accessibility')}>
      <${SettingRow} title=${t('Reduce motion')} desc=${t('Minimizes animation and disables rain.')}><${SToggle} path="motion.reduce" /><//>
      <${SettingRow} title=${t('High contrast text')} desc=${t('Brighter secondary text and stronger borders.')}><${SToggle} path="access.highContrast" /><//>
      <${SettingRow} title=${t('Always underline links')}><${SToggle} path="access.underlineLinks" /><//>
      <${SettingRow} title=${t('Show tooltips')}><${SToggle} path="access.tooltips" /><//>
      <${SettingRow} title=${t('Chat font size')} stack><${SSlider} path="fonts.size" min=${12} max=${24} format=${(v) => v + 'px'} /><//>
      <${SettingRow} title=${t('Glass saturation')} desc=${t('Reduce for less color bleed from the wallpaper.')} stack><${SSlider} path="theme.saturation" scale=${100} min=${50} max=${220} format=${(v) => v + '%'} /><//>
    <//></div>`;
}
function NotificationsPage() {
  const n = useSel((s) => s.settings.notif); const [perm, setPerm] = useState('Notification' in window ? Notification.permission : 'unsupported');
  const ask = async () => { const r = await Notification.requestPermission(); setPerm(r); if (r === 'granted') { setSetting('notif.desktop', true); new Notification('Orate notifications are on', { body: 'You’ll be notified of DMs and mentions while Orate is in the background.', icon: '/img/icon-192.png' }); } };
  const muted = useSel((s) => s.settings.mutedServers); const servers = useSel((s) => s.servers);
  return html`<div class="s-page">
    <${Section} title=${t('Desktop notifications')}>
      ${perm === 'unsupported' ? html`<div class="note-chip">${t('This browser does not support notifications.')}</div>` : perm === 'granted' ? html`<${SettingRow} title=${t('Enable desktop notifications')} desc=${t('Shown when Orate is in the background.')}><${SToggle} path="notif.desktop" /><//>`
        : html`<${SettingRow} title=${t('Enable desktop notifications')} desc=${perm === 'denied' ? t('Blocked by your browser — allow notifications for this site in its settings.') : t('Get alerted about DMs and mentions in the background.')}><${Btn} variant="primary" disabled=${perm === 'denied'} onClick=${ask}>${t('Enable')}<//><//>`}
      <${SettingRow} title=${t('Flash tab title for unread')}><${SToggle} path="notif.flash" /><//>
    <//>
    <${Section} title=${t('Sounds')}>
      <${SettingRow} title=${t('Play notification sounds')}><${SToggle} path="notif.sounds" /><//>
      <${SettingRow} title=${t('Volume')} stack><div class="vol-row"><${SSlider} path="notif.volume" scale=${100} min=${0} max=${100} format=${(v) => v + '%'} /><${Btn} size="sm" icon="volume" onClick=${() => playSound('mention', { force: true })}>${t('Test')}<//></div><//>
    <//>
    <${Section} title=${t('What to notify about')}>
      <${SettingRow} title=${t('Only direct mentions in DMs')} desc=${t('In servers you’re always notified of @mentions and replies.')}><${SToggle} path="notif.mentionsOnly" /><//>
    <//>
    <${Section} title=${t('Server notifications')} desc=${t('Muted servers never show unread badges or sounds.')}>
      ${Object.values(servers).length ? Object.values(servers).map((s) => html`<${SettingRow} title=${s.name}><${Toggle} checked=${!muted[s.id]} onChange=${(on) => updateSettings({ mutedServers: { [s.id]: !on } })} /><//>`) : html`<div class="muted-note">${t('You aren’t in any servers yet.')}</div>`}
    <//></div>`;
}
function LanguagePage() {
  const lang = useSel((s) => s.settings.lang);
  return html`<div class="s-page">
    <${Section} title=${t('Language')} desc=${t('Core interface text is translated. Anything not translated yet stays in English.')}>
      <div class="lang-grid">${LANGUAGES.map((l) => html`<button type="button" class=${cx('lang-card', lang === l.code && 'sel')} onClick=${() => setSetting('lang', l.code)}><b>${l.native}</b><small>${l.name}</small>${lang === l.code ? html`<span class="lang-check"><${Icon} name="check" size=${14} sw=${3.5} /></span>` : null}</button>`)}</div>
    <//>
    <${Section} title=${t('Time')}><${SettingRow} title=${t('24-hour time')}><${SToggle} path="chat.hour24" /><//><//></div>`;
}
const SHORTCUTS = [
  ['Ctrl K', 'Quick switcher — jump to any chat'], ['Ctrl /', 'Show keyboard shortcuts'], ['Alt ↑ / ↓', 'Previous / next channel'], ['Alt Shift ↑ / ↓', 'Previous / next unread channel'],
  ['Enter', 'Send message'], ['Shift Enter', 'New line'], ['↑ (empty box)', 'Edit your last message'], ['Esc', 'Cancel reply / close panel'],
  ['Ctrl B / I / U', 'Bold / italic / underline selection'], ['@ # :', 'Autocomplete mentions, channels and emoji'], ['/', 'Slash commands'], ['Right-click', 'Context menu on almost anything'],
];
export function Shortcuts() { return html`<div class="shortcut-grid">${SHORTCUTS.map(([k, d]) => html`<div class="sc-row"><span class="keys">${k.split(' ').map((x) => (x === '/' && k.includes('Ctrl') ? html`<span class="kbd">/</span>` : html`<span class="kbd">${x}</span>`))}</span><span>${d}</span></div>`)}</div>`; }
MODALS.shortcuts = function ShortcutsModal({ id }) { return html`<${Modal} title="Keyboard shortcuts" width=${560} onClose=${() => closeModal(id)}><${Shortcuts} /><//>`; };
function KeybindsPage() { return html`<div class="s-page"><${Section} title=${t('Keybinds')} desc=${t('Orate’s built-in shortcuts. Push-to-talk can be set under Voice & Video.')}><${Shortcuts} /><//></div>`; }
function PrivacyPage() {
  const rel = useSel((s) => s.relationships); const users = useSel((s) => s.users);
  const blocked = Object.keys(rel).filter((id) => rel[id] === 'blocked' && users[id]);
  return html`<div class="s-page">
    <${Section} title=${t('Privacy')}>
      <${SettingRow} title=${t('Allow direct messages from server members')} desc=${t('You can always message friends.')}><${SToggle} path="privacy.dmFromServers" /><//>
      <${SettingRow} title=${t('Allow friend requests')}><${SToggle} path="privacy.friendRequests" /><//>
      <${SettingRow} title=${t('Show my status to everyone')} desc=${t('Includes the song you’re listening to. Use Invisible from your user menu to appear offline.')}><${SToggle} path="privacy.showActivity" /><//>
    <//>
    <${Section} title=${t('Blocked users')}>
      ${blocked.length ? blocked.map((id) => html`<div class="friend-row" key=${id}><${Avatar} user=${users[id]} size=${36} /><div class="fr-text"><div class="fr-name"><b>${users[id].displayName}</b><span class="fr-user" style="opacity:1">${users[id].username}</span></div></div><${Btn} size="sm" onClick=${() => act(api.del(`/relationships/${id}`))}>${t('Unblock')}<//></div>`) : html`<${Empty} icon="ban" title=${t('No one is blocked')} />`}
    <//></div>`;
}
MODALS['theme-io'] = function ThemeIO({ id, mode }) {
  const [txt, setTxt] = useState(() => (mode === 'export' ? JSON.stringify(exportTheme(), null, 2) : '')); const [err, setErr] = useState(null);
  const apply = () => { try { const j = JSON.parse(txt); const out = {}; for (const k of ['theme', 'bg', 'rain', 'glass', 'fonts', 'motion', 'chat']) if (j[k] && typeof j[k] === 'object') out[k] = j[k]; if (!Object.keys(out).length) throw new Error('No theme data found'); updateSettings(out); toast('Theme imported', 'success'); closeModal(id); } catch (e) { setErr(e.message); } };
  return html`<${Modal} title=${mode === 'export' ? 'Export theme' : 'Import theme'} subtitle=${mode === 'export' ? 'Copy this JSON to share your look with a friend.' : 'Paste a theme JSON exported from Orate.'} width=${560} onClose=${() => closeModal(id)} footer=${mode === 'export' ? html`<${Btn} variant="primary" icon="copy" onClick=${async () => { await copyText(txt); toast('Copied', 'success', 1400); }}>Copy<//>` : html`<${Btn} variant="ghost" onClick=${() => closeModal(id)}>Cancel<//><${Btn} variant="primary" onClick=${apply}>Import<//>`}>
    <textarea class="textarea code-area" rows="12" spellcheck="false" readonly=${mode === 'export'} value=${txt} onInput=${(e) => { setTxt(e.target.value); setErr(null); }} placeholder='{ "theme": { … } }'></textarea>${err ? html`<div class="auth-error">${err}</div>` : null}<//>`;
};
export function exportTheme() { const s = state.settings; return { app: 'Orate', version: 1, theme: s.theme, bg: { ...s.bg, library: [] }, rain: s.rain, glass: s.glass, fonts: s.fonts, motion: s.motion, chat: s.chat }; }
function AdvancedPage() {
  const conn = useSel((s) => s.connection);
  return html`<div class="s-page">
    <${Section} title=${t('Advanced')}>
      <${SettingRow} title=${t('Developer mode')} desc=${t('Adds “Copy ID” to context menus.')}><${SToggle} path="advanced.devMode" /><//>
    <//>
    <${Section} title=${t('Share your look')} desc=${t('Themes include colors, wallpaper choice, effects and fonts.')}>
      <div class="btn-row"><${Btn} icon="copy" onClick=${() => openModal('theme-io', { mode: 'export' })}>${t('Export theme')}<//><${Btn} icon="download" onClick=${() => openModal('theme-io', { mode: 'import' })}>${t('Import theme')}<//></div>
    <//>
    <${Section} title=${t('Reset')}>
      <div class="btn-row"><${Btn} variant="danger" icon="rotate-cw" onClick=${async () => { if (await confirmDialog({ title: 'Reset all settings?', body: 'Every appearance, notification and voice setting returns to its default.', confirmLabel: 'Reset everything', danger: true })) { updateSettings(structuredClone({ ...DEFAULT_SETTINGS, mutedServers: state.settings.mutedServers, mutedChannels: state.settings.mutedChannels, quests: state.settings.quests })); toast('Settings reset', 'success'); } }}>${t('Reset all settings')}<//>
        <${Btn} onClick=${() => { ls('x', null, null); localStorage.removeItem('orate:local'); toast('Cleared local device data', 'success'); }}>${t('Clear device preferences')}<//></div>
    <//>
    <${Section} title=${t('About')}>
      <div class="about"><${Logo} size=${46} /><div><b>Orate 1.0</b><small>${t('Connection')}: ${conn} · ${location.host}</small></div></div>
    <//></div>`;
}

/* ------------------------------------------------------------------ shell */
const NAV = [
  { group: 'User Settings', items: [['account', 'user', 'My Account'], ['profile', 'smile', 'Profile']] },
  { group: 'Appearance', items: [['appearance', 'palette', 'Theme'], ['wallpaper', 'image', 'Wallpaper'], ['effects', 'cloud-rain', 'Rain & Glass'], ['fonts', 'type', 'Fonts'], ['chat', 'message', 'Chat']] },
  { group: 'App Settings', items: [['access', 'eye', 'Accessibility'], ['voice', 'mic', 'Voice & Video'], ['notifications', 'bell', 'Notifications'], ['language', 'globe', 'Language & Time'], ['keybinds', 'keyboard', 'Keybinds'], ['privacy', 'shield', 'Privacy & Safety'], ['cloak', 'monitor', 'Cloak'], ['advanced', 'sliders', 'Advanced']] },
];
const PAGES = { account: AccountPage, profile: ProfilePage, appearance: ThemePage, wallpaper: WallpaperPage, effects: EffectsPage, fonts: FontsPage, chat: ChatPage, access: AccessPage, voice: VoicePage, notifications: NotificationsPage, language: LanguagePage, keybinds: KeybindsPage, privacy: PrivacyPage, cloak: CloakPage, advanced: AdvancedPage };

export function SettingsHost() {
  const page = useSel((s) => s.settingsPage);
  const [shown, setShown] = useState(null); const [closing, setClosing] = useState(false); const body = useRef(null);
  useEffect(() => { if (page) { setShown(page); setClosing(false); } else if (shown) { setClosing(true); const id = setTimeout(() => { setShown(null); setClosing(false); }, 200); return () => clearTimeout(id); } return undefined; }, [page]);
  useEscape(() => { if (!state.modals.length && !state.popover && !state.ctx) closeSettings(); }, !!page);
  useEffect(() => { body.current?.scrollTo({ top: 0 }); }, [shown]);
  if (!shown) return null;
  const Page = PAGES[shown] || AccountPage; const label = NAV.flatMap((g) => g.items).find((i) => i[0] === shown)?.[2] || '';
  const compactBg = ['appearance', 'wallpaper', 'effects', 'fonts'].includes(shown);
  return html`<div class=${cx('settings', closing && 'closing', compactBg && 'live')} role="dialog" aria-label="Settings">
    <nav class="settings-nav panel">
      <div class="sn-scroll">${NAV.map((g) => html`<div class="sn-group" key=${g.group}><h5>${t(g.group)}</h5>${g.items.map(([k, ic, l]) => html`<button type="button" class=${cx('sn-item', shown === k && 'on')} onClick=${() => openSettings(k)}><${Icon} name=${ic} size=${18} /><span>${t(l)}</span></button>`)}</div>`)}
        <div class="sn-group"><button type="button" class="sn-item danger" onClick=${async () => { if (await confirmDialog({ title: 'Log out', body: 'Are you sure you want to log out?', confirmLabel: 'Log Out', danger: true })) { closeSettings(); logout(); } }}><${Icon} name="log-out" size=${18} /><span>${t('Log Out')}</span></button></div>
        <div class="sn-foot"><${Logo} size=${22} /> Orate 1.0</div></div>
    </nav>
    <section class="settings-body panel">
      <header class="sb-title"><h2 key=${shown}>${t(label)}</h2><button type="button" class="settings-close" onClick=${closeSettings} aria-label="Close settings"><span><${Icon} name="x" size=${20} /></span><small>ESC</small></button></header>
      <div class="settings-scroll" ref=${body}><div class="s-wrap" key=${shown}><${Page} /></div></div>
    </section>
  </div>`;
}
void Segmented; void updateLocal; void resetSettings; void formatMemberSince; void Dropdown;
