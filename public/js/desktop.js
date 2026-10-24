// Orata — the desktop app: the first-visit "website or app?" screen and the Desktop App page in Settings.
// The installer itself is served by the server (server/desktop.js); this only offers it. Nothing is shown when the server has none to hand out.
import { html, useState, useEffect, ls } from '/js/lib.js';
import { Icon, Logo } from '/js/icons.js';
import { Spinner, Section } from '/js/ui.js';
import { t } from '/js/i18n.js';

const UA = navigator.userAgent || '';
const inApp = /Electron\//i.test(UA);       // this already is the desktop app
const onWindows = /Windows NT/i.test(UA);   // the installer is for Windows
const meta = (info) => [info.version && `${t('Version')} ${info.version}`, info.size && `${Math.max(1, Math.round(info.size / 1048576))} MB`, t('Windows 10 or newer')].filter(Boolean).join(' · ');

let asked = null;   // the server's answer, asked once per page load: { version, size, url } or null
/** undefined while loading, null when this server has no installer to offer. */
function useDesktopInfo() {
  const [info, setInfo] = useState(undefined);
  useEffect(() => {
    let live = true;
    (asked ||= fetch('/api/config').then((r) => r.json()).then((c) => c.desktop || null).catch(() => null)).then((d) => { if (live) setInfo(d); });
    return () => { live = false; };
  }, []);
  return info;
}
const Download = ({ info, label, onClick }) => html`<a class="btn btn-primary" href=${info.url} download rel="noopener" onClick=${onClick}><${Icon} name="download" size=${17} /><span class="btn-label">${label}</span></a>`;
const SmartScreen = () => html`<p class="dp-note"><${Icon} name="info" size=${15} /><span>${t('Windows may say it “protected your PC”, because the app isn’t signed with a paid publisher certificate yet. Choose “More info”, then “Run anyway”.')}</span></p>`;

/** The first time someone opens Orata on Windows without being signed in: use the website, or get the app. Shown once; their choice is remembered in this browser. */
export function DesktopPrompt() {
  const [open, setOpen] = useState(() => !inApp && onWindows && !ls('desktopPrompt', null));
  const [started, setStarted] = useState(false);
  const info = useDesktopInfo();
  const close = () => { ls('desktopPrompt', null, started ? 'downloaded' : 'website'); setOpen(false); };
  useEffect(() => {
    if (!open || !info) return undefined;
    const key = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [open, info, started]);
  if (!open || !info) return null;
  const begin = () => { ls('desktopPrompt', null, 'downloaded'); setStarted(true); };
  return html`<div class="dp-backdrop" role="dialog" aria-modal="true" aria-label=${t('Welcome to Orata')}>
    <div class="dp-card panel pop-in"><${Logo} size=${56} />
      ${started ? html`<h1>${t('Your download has started')}</h1><p>${t('When it finishes, open the file to install Orata.')}</p><${SmartScreen} />
        <div class="dp-actions"><button type="button" class="btn btn-primary" onClick=${close}><span class="btn-label">${t('Continue to website')}</span></button></div>`
        : html`<h1>${t('Welcome to Orata')}</h1><p>${t('Chat right here in your browser, or install the desktop app for Windows.')}</p>
          <div class="dp-actions"><button type="button" class="btn btn-secondary" onClick=${close}><span class="btn-label">${t('Continue to website')}</span></button>
            <${Download} info=${info} label=${t('Download desktop app')} onClick=${begin} /></div>
          <small class="dp-meta">${meta(info)}</small>`}
    </div></div>`;
}

/** Settings → Desktop App: what the app is, and the download. */
export function DesktopPage() {
  const info = useDesktopInfo();
  return html`<div class="s-page desk">
    <section class="desk-hero"><${Logo} size=${64} />
      <div><h3>${t('Orata for desktop')}</h3><p>${t('Orata in its own window. It’s the same Orata as the website — the same account, servers, friends and messages — but it opens from your Start menu and taskbar instead of a browser tab.')}</p></div></section>
    <ul class="desk-points">
      <li><${Icon} name="check-circle" size=${17} /><span>${t('Its own window and taskbar icon, apart from your browser tabs')}</span></li>
      <li><${Icon} name="check-circle" size=${17} /><span>${t('Sign in with your usual account — nothing to move or set up')}</span></li>
    </ul>
    <${Section} title=${t('Download')}>
      ${info === undefined ? html`<div class="pk-center"><${Spinner} /></div>`
        : !info ? html`<p class="desk-none">${t('The desktop app isn’t available to download from this server right now.')}</p>`
          : html`<div class="desk-dl"><div class="meta"><b>${t('Orata for Windows')}</b><small>${meta(info)}</small></div><${Download} info=${info} label=${t('Download for Windows')} /></div>
            ${inApp ? html`<p class="dp-note"><${Icon} name="check" size=${15} /><span>${t('You’re using the desktop app right now.')}</span></p>` : null}
            ${!onWindows && !inApp ? html`<p class="dp-note"><${Icon} name="info" size=${15} /><span>${t('The desktop app is for Windows. On other systems, use Orata in your browser.')}</span></p>` : null}
            <${SmartScreen} />`}
    <//>
  </div>`;
}
