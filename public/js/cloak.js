// Orate — tab cloak: make this tab look like another site (its title and its icon), and open Orate inside an about:blank tab.
// The choice is kept on this device only (localStorage) and applied as soon as the page loads, before anyone has signed in.
import { html, useState, cx } from '/js/lib.js';
import { Btn, Field, TextInput, Section, SettingRow, Dropdown } from '/js/ui.js';
import { toast } from '/js/store.js';
import { t } from '/js/i18n.js';

const P = (id, name, title, url) => ({ id, name, title, url });
/** The sites you can look like: id, name, tab title and a page on that site (its icon comes from there, and "send this tab to" goes there). */
export const CLOAKS = [
  P('google', 'Google', 'Google', 'https://www.google.com/'),
  P('drive', 'Google Drive', 'My Drive - Google Drive', 'https://drive.google.com/drive/my-drive'),
  P('gmail', 'Gmail', 'Inbox - Gmail', 'https://mail.google.com/mail/u/0/'),
  P('docs', 'Google Docs', 'Untitled document - Google Docs', 'https://docs.google.com/document/'),
  P('sheets', 'Google Sheets', 'Untitled spreadsheet - Google Sheets', 'https://docs.google.com/spreadsheets/'),
  P('slides', 'Google Slides', 'Untitled presentation - Google Slides', 'https://docs.google.com/presentation/'),
  P('classroom', 'Google Classroom', 'Classroom', 'https://classroom.google.com/'),
  P('calendar', 'Google Calendar', 'Google Calendar', 'https://calendar.google.com/calendar/'),
  P('meet', 'Google Meet', 'Meet', 'https://meet.google.com/'),
  P('translate', 'Google Translate', 'Google Translate', 'https://translate.google.com/'),
  P('maps', 'Google Maps', 'Google Maps', 'https://maps.google.com/'),
  P('youtube', 'YouTube', 'YouTube', 'https://www.youtube.com/'),
  P('wikipedia', 'Wikipedia', 'Wikipedia, the free encyclopedia', 'https://www.wikipedia.org/'),
  P('khan', 'Khan Academy', 'Khan Academy', 'https://www.khanacademy.org/'),
  P('desmos', 'Desmos', 'Desmos | Graphing Calculator', 'https://www.desmos.com/calculator'),
  P('canvas', 'Canvas', 'Dashboard', 'https://www.instructure.com/canvas'),
  P('schoology', 'Schoology', 'Home | Schoology', 'https://www.schoology.com/'),
  P('clever', 'Clever', 'Clever | Portal', 'https://clever.com/'),
  P('quizlet', 'Quizlet', 'Quizlet', 'https://quizlet.com/'),
  P('kahoot', 'Kahoot!', 'Kahoot!', 'https://kahoot.it/'),
  P('outlook', 'Outlook', 'Mail - Outlook', 'https://outlook.office.com/mail/'),
  P('teams', 'Microsoft Teams', 'Microsoft Teams', 'https://teams.microsoft.com/'),
  P('zoom', 'Zoom', 'Zoom', 'https://zoom.us/'),
  P('powerschool', 'PowerSchool', 'PowerSchool Student and Parent Sign In', 'https://www.powerschool.com/'),
  P('ixl', 'IXL', 'IXL | Math, Language Arts, Science, Social Studies, and Spanish', 'https://www.ixl.com/'),
  P('github', 'GitHub', 'GitHub', 'https://github.com/'),
];
/** A site's icon, fetched once by this server (so the browser never contacts the other site) and cached. */
export const iconFor = (pageUrl) => `/api/img?url=${encodeURIComponent(`https://www.google.com/s2/favicons?domain_url=${encodeURIComponent(pageUrl)}&sz=64`)}`;
const proxied = (url) => `/api/img?url=${encodeURIComponent(url)}`;

const KEY = 'orate:cloak';
export function getCloak() {
  try { const c = JSON.parse(localStorage.getItem(KEY) || 'null'); return c && typeof c.title === 'string' && typeof c.icon === 'string' ? c : null; } catch { return null; }
}
let original = null; let watcher = null;
const iconLinks = () => [...document.querySelectorAll('link[rel~="icon"], link[rel~="apple-touch-icon"]')];
/** Puts the cloak on this tab (or takes it off when `c` is null). Safe to call as often as you like. */
export function applyCloak(c = getCloak()) {
  const links = iconLinks();
  if (!original) original = { title: document.title, links: links.map((l) => ({ l, href: l.getAttribute('href'), type: l.getAttribute('type') })) };
  if (!c) {
    watcher?.disconnect(); watcher = null;
    for (const o of original.links) { o.l.setAttribute('href', o.href); if (o.type) o.l.setAttribute('type', o.type); }
    document.title = original.title || 'Orate'; return;
  }
  for (const o of original.links) { o.l.setAttribute('href', c.icon); o.l.removeAttribute('type'); }
  document.title = c.title;
  if (!watcher && document.querySelector('title')) {   // the app keeps rewriting the title (unread counts, channel names): put the cloak's back
    watcher = new MutationObserver(() => { const now = getCloak(); if (now && document.title !== now.title) document.title = now.title; });
    watcher.observe(document.querySelector('title'), { childList: true, characterData: true, subtree: true });
  }
}
export function setCloak(c) {
  try { if (c) localStorage.setItem(KEY, JSON.stringify(c)); else localStorage.removeItem(KEY); } catch { /* storage blocked: the cloak lasts until the page is closed */ }
  applyCloak(c);
}
export function initCloak() { applyCloak(); window.addEventListener('storage', (e) => { if (e.key === KEY) applyCloak(); }); }

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/**
 * Opens Orate inside a blank tab (about:blank): the address bar shows nothing and the tab wears the cloak. Optionally sends this tab to another site.
 * Returns 'blocked' when the browser stopped the pop-up.
 */
export function openAboutBlank(redirectTo = '') {
  const c = getCloak(); const title = c?.title || 'Orate'; const icon = new URL(c?.icon || '/img/favicon.png', location.origin).href;
  const w = window.open('about:blank', '_blank'); if (!w) return 'blocked';
  const doc = w.document; doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><link rel="icon" href="${esc(icon)}"><style>html,body{margin:0;height:100%;overflow:hidden;background:#0b0b10}iframe{display:block;border:0;width:100vw;height:100vh}</style></head><body><iframe src="${esc(location.href)}" allow="microphone; camera; display-capture; autoplay; clipboard-write; fullscreen" allowfullscreen></iframe></body></html>`);
  doc.close();
  if (/^https:\/\//i.test(redirectTo)) setTimeout(() => location.replace(redirectTo), 200);
  return 'ok';
}

/* ------------------------------------------------------------------ the settings page */
function TabPreview({ title, icon }) {
  return html`<div class="cloak-tab" aria-hidden="true"><img src=${icon} alt="" /><span>${title}</span><i>×</i></div>`;
}
export function CloakPage() {
  const [cur, setCur] = useState(getCloak());
  const [custom, setCustom] = useState({ title: cur?.id === 'custom' ? cur.title : '', icon: cur?.id === 'custom' ? cur.rawIcon || '' : '' });
  const [redirect, setRedirect] = useState('');
  const choose = (p) => { const c = p ? { id: p.id, title: p.title, icon: iconFor(p.url) } : null; setCloak(c); setCur(c); };
  const applyCustom = () => {
    const title = custom.title.trim().slice(0, 80); const raw = custom.icon.trim();
    if (!title) { toast(t('Type a tab title first'), 'error'); return; }
    if (raw && !/^https?:\/\//i.test(raw)) { toast(t('The icon must be a link to an image (https://…)'), 'error'); return; }
    const c = { id: 'custom', title, icon: raw ? proxied(raw) : '/img/favicon.png', rawIcon: raw }; setCloak(c); setCur(c);
  };
  const open = () => { const r = openAboutBlank(redirect); if (r === 'blocked') toast(t('Your browser blocked the new tab. Allow pop-ups for this site and try again.'), 'error', 5000); };
  const redirects = [{ value: '', label: t('Stay here') }, ...CLOAKS.map((p) => ({ value: p.url, label: p.name }))];
  return html`<div class="s-page">
    <${Section} title=${t('Tab cloak')} desc=${t('Change how this browser tab looks — its title and its icon — so it looks like another site. It only changes this device and is remembered.')}>
      <div class="cloak-now"><span class="ps-label">${t('This tab now')}</span><${TabPreview} title=${cur?.title || 'Orate'} icon=${cur?.icon || '/img/favicon.png'} /></div>
      <div class="cloak-grid">
        <button type="button" class=${cx('cloak-card', !cur && 'on')} onClick=${() => choose(null)}><img src="/img/favicon.png" alt="" /><span><b>Orate</b><small>${t('No cloak')}</small></span></button>
        ${CLOAKS.map((p) => html`<button type="button" key=${p.id} class=${cx('cloak-card', cur?.id === p.id && 'on')} onClick=${() => choose(p)} title=${p.title}><img src=${iconFor(p.url)} alt="" loading="lazy" /><span><b>${p.name}</b><small>${p.title}</small></span></button>`)}
      </div>
    <//>
    <${Section} title=${t('Your own')} desc=${t('Any title, and optionally the link to an image to use as the icon.')}>
      <div class="two-col-set"><${Field} label=${t('Tab title')}><${TextInput} value=${custom.title} onInput=${(v) => setCustom({ ...custom, title: v })} maxlength="80" placeholder="Homework" /><//>
        <${Field} label=${t('Icon (image link)')}><${TextInput} value=${custom.icon} onInput=${(v) => setCustom({ ...custom, icon: v })} maxlength="500" placeholder="https://…/icon.png" /><//></div>
      <div class="pe-btns"><${Btn} variant="primary" onClick=${applyCustom}>${t('Apply')}<//></div>
    <//>
    <${Section} title=${t('Open in about:blank')} desc=${t('Opens Orate inside a blank tab, so the address bar shows about:blank instead of this site. The new tab uses your cloak above.')}>
      <${SettingRow} title=${t('Then send this tab to')} desc=${t('After opening, this tab can jump to another site so it is not showing Orate.')}><${Dropdown} width=${220} value=${redirect} options=${redirects} onChange=${setRedirect} /><//>
      <div class="pe-btns"><${Btn} variant="primary" icon="external" onClick=${open}>${t('Open in about:blank')}<//></div>
      <p class="text-muted" style="font-size:13px;margin:10px 0 0">${t('If nothing opens, your browser blocked the pop-up — allow pop-ups for this site and press the button again.')}</p>
    <//>
  </div>`;
}
