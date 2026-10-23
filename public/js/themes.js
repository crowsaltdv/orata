// Orata — themes: the Themes page (the paintbrush in the server rail, like Music): Theme Discovery (themes other people made) and your theme library
// (up to 25 profile + 25 site themes, kept on your account). Each has a Profile themes and a Site themes tab and a Random / Alphabetical sort. Saving the look
// you have now, applying a saved theme, renaming, deleting; people with the Creator badge publish a theme of their own; everyone installs from Discovery into
// their library. What a theme holds is public/js/theme-data.js; the picture each one shows is drawn by theme-preview.js; the server side is server/themes.js.
import { html, useState, useEffect, useMemo, useRef, cx, ls } from '/js/lib.js';
import { state, set, useSel, go, closeModal, openModal, openContext, updateSettings, toast } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { Modal, Btn, IconBtn, Segmented, Dropdown, Spinner, Empty, Field, TextInput, MODALS, confirmDialog } from '/js/ui.js';
import { api } from '/js/api.js';
import { act, errMsg, closeSettings } from '/js/actions.js';
import { t } from '/js/i18n.js';
import { sanitizeProfileStyle } from '/js/profile-data.js';
import { LIBRARY_LIMIT, sanitizeSiteLook, siteLookOf } from '/js/theme-data.js';
import { isStaffMe } from '/js/staff.js';

const KINDS = [{ value: 'profile', label: 'Profile themes' }, { value: 'site', label: 'Site themes' }];
const NOUN = { profile: 'profile theme', site: 'site theme' };
export const isCreator = (u) => !!u?.badges?.some((b) => b.id === 'creator');

/* ------------------------------------------------------------------ the look you have now, and wearing a theme */
/** The theme your look is right now: your whole site look, or your saved profile style (null when you haven't styled your profile). */
export const currentLook = (kind) => (kind === 'site' ? sanitizeSiteLook(siteLookOf(state.settings)) : sanitizeProfileStyle(state.me?.profile));
const sameLook = (a, b) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b);
export const isWorn = (th) => sameLook(th.kind === 'site' ? sanitizeSiteLook(th.data) : sanitizeProfileStyle(th.data), currentLook(th.kind));

let undo = null;   // the look before the last theme was applied, for the Undo button
let kindNow = ls('themesKind', 'site');   // the tab you were on
const subs = new Set(); const changed = () => subs.forEach((f) => f());
const setUndo = (v) => { undo = v; changed(); };
const setKindNow = (k) => { kindNow = k; ls('themesKind', null, k); changed(); };
/** Puts a theme on: a site theme becomes your whole site look (your wallpapers, Reduce motion and accessibility switches stay yours), a profile theme your profile style. */
export async function applyTheme(th) {
  const before = { kind: th.kind, data: currentLook(th.kind) };
  if (th.kind === 'site') {
    const look = sanitizeSiteLook(th.data); if (!look) { toast(t('That theme can’t be applied'), 'error'); return false; }
    const img = look.bg.image && !/^https?:/i.test(look.bg.image) ? look.bg.image : null;
    updateSettings({ ...look, bg: { ...look.bg, ...(img ? { library: [img, ...state.settings.bg.library.filter((x) => x !== img)].slice(0, 8) } : {}) } });   // (a wallpaper of its own also joins your Wallpaper page)
    toast(t('Theme applied'), 'success', 2200);
  } else {
    const style = sanitizeProfileStyle(th.data); if (!style) { toast(t('That theme can’t be applied'), 'error'); return false; }
    if (!await act(api.patch('/me', { profile: style }), { success: t('Profile theme applied') })) return false;
  }
  setUndo(before); return true;
}
async function undoApply() {
  const u = undo; if (!u) return;
  if (u.kind === 'site') updateSettings(u.data || {}); else if (!await act(api.patch('/me', { profile: u.data }))) return;
  setUndo(null); toast(t('Your previous look is back'), 'success', 2200);
}

/* ------------------------------------------------------------------ the library (server) */
/** Draws the preview picture of a theme and stores it with the theme. Resolves the theme (with `preview`), or the theme as it was when that failed. */
export async function ensurePreview(th) {
  try {
    const { renderThemePreview } = await import('/js/theme-preview.js');
    return await api.put(`/themes/library/${th.id}/preview`, await renderThemePreview(th.kind, th.data));
  } catch { return th; }
}
/** Saves a theme to your library (and draws its preview). Resolves the theme, or null (the reason is shown). */
export async function saveToLibrary(kind, data, name) {
  const th = await act(api.post('/themes/library', { kind, name, data }));
  if (!th) return null;
  const done = await ensurePreview(th);
  if (!done.preview) toast(t('Saved, but its preview picture couldn’t be made. It will be tried again when you open your library.'), 'info', 4500);
  else toast(t('Saved to your library'), 'success', 2200);
  set({ themesRev: state.themesRev + 1 }); return done;
}
/** Asks for a name, then saves the look you have now as a theme. `kind` is 'site' or 'profile'; `data` defaults to the look you have now. */
export async function saveCurrentLook(kind, data = currentLook(kind)) {
  if (!data) { toast(kind === 'profile' ? t('You haven’t styled your profile yet. Style it in Settings → Profile first.') : t('There is nothing to save yet'), 'info', 4000); return null; }
  const count = (await act(api.get('/themes/library'), { silent: true }))?.themes.filter((x) => x.kind === kind).length ?? 0;
  if (count >= LIBRARY_LIMIT) { toast(t(`Your ${NOUN[kind]} library is full (${LIBRARY_LIMIT} of ${LIBRARY_LIMIT}). Delete one from your library to make room.`), 'error', 5000); return null; }
  const name = await askName({ title: t('Save to your library'), label: t('Theme name'), value: kind === 'site' ? t('My site theme') : t('My profile theme'), confirm: t('Save') });
  return name ? saveToLibrary(kind, data, name) : null;
}
function askName(props) { return new Promise((resolve) => openModal('theme-name', { ...props, resolve })); }
MODALS['theme-name'] = function ThemeName({ id, title, label, value, confirm, note, resolve }) {
  const [v, setV] = useState(value || '');
  const done = (x) => { closeModal(id); resolve(x); };
  return html`<${Modal} title=${title} width=${420} onClose=${() => done(null)} footer=${html`<${Btn} variant="ghost" onClick=${() => done(null)}>${t('Cancel')}<//><${Btn} variant="primary" disabled=${!v.trim()} onClick=${() => done(v.trim())}>${confirm}<//>`}>
    <${Field} label=${label}><${TextInput} value=${v} onInput=${setV} maxlength="40" autofocus onKeyDown=${(e) => e.key === 'Enter' && v.trim() && done(v.trim())} /><//>
    ${note ? html`<p class="text-muted" style="font-size:13px;margin:0">${note}</p>` : null}
  <//>`;
};

/** Goes to the Themes page: `view` is 'discover' or 'library', `kind` the tab ('site' or 'profile'). */
export function openThemes(view = 'discover', kind) {
  if (kind) setKindNow(kind);
  if (state.settingsPage) closeSettings();
  go(view === 'library' ? '/themes/library' : '/themes');
}

/* ------------------------------------------------------------------ the cards */
function Picture({ src, busy, children }) {
  return html`<div class="tcard-prev">${src ? html`<img src=${src} alt="" loading="lazy" draggable=${false} />` : html`<div class="tcard-none">${busy ? html`<${Spinner} size=${22} />` : html`<${Icon} name="image" size=${28} sw=${1.5} />`}</div>`}${children}</div>`;
}
/** The "…" in a card's corner: the things you do less often (rename, publish, delete) are in its menu, so a card shows only its main button. */
function More({ items }) {
  return html`<button type="button" class="tcard-more" aria-label=${t('More')} onClick=${(e) => openContext(e, items)}><${Icon} name="more-h" size=${18} /></button>`;
}
function DiscoverCard({ th, onInstall, onUnpublish }) {
  const [busy, setBusy] = useState(false);
  const menu = isStaffMe() && !th.mine ? [{ label: t('Take down (staff)'), icon: 'trash', danger: true, onClick: () => onUnpublish(th) }] : null;
  const install = async () => { setBusy(true); await onInstall(th); setBusy(false); };
  return html`<article class="tcard">
    <${Picture} src=${th.preview}>${menu ? html`<${More} items=${menu} />` : null}<//>
    <div class="tcard-meta"><b class="tcard-name" title=${th.name}>${th.name}</b><span class="tcard-by">${t('by')} ${th.author.displayName}</span></div>
    ${th.mine ? html`<${Btn} class="tcard-btn" onClick=${() => onUnpublish(th)}>${t('Unpublish')}<//>`
      : th.installed ? html`<${Btn} class="tcard-btn" icon="check" disabled=${true}>${t('Installed')}<//>`
        : html`<${Btn} class="tcard-btn" variant="primary" loading=${busy} onClick=${install}>${t('Install')}<//>`}
  </article>`;
}
function LibraryCard({ th, creator, worn, working, onApply, onRename, onDelete, onPublish, onUnpublish }) {
  const menu = [
    { label: t('Rename'), icon: 'edit', onClick: () => onRename(th) },
    creator && !th.from && (th.published ? { label: t('Unpublish from Discovery'), icon: 'paintbrush', onClick: () => onUnpublish(th) } : { label: t('Publish on Discovery'), icon: 'paintbrush', onClick: () => onPublish(th) }),
    { type: 'sep' },
    { label: t('Delete'), icon: 'trash', danger: true, onClick: () => onDelete(th) },
  ];
  return html`<article class=${cx('tcard', worn && 'worn')}>
    <${Picture} src=${th.preview} busy=${working}>${worn ? html`<span class="tcard-badge"><${Icon} name="check" size=${12} sw=${3} />${t('In use')}</span>` : null}<${More} items=${menu} /><//>
    <div class="tcard-meta"><b class="tcard-name" title=${th.name}>${th.name}</b>${th.published ? html`<span class="tcard-by"><${Icon} name="globe" size=${12} sw=${2.2} />${t('Published')}</span>` : th.from ? html`<span class="tcard-by">${t('From Discovery')}</span>` : null}</div>
    ${worn ? html`<${Btn} class="tcard-btn" disabled=${true}>${t('In use')}<//>` : html`<${Btn} class="tcard-btn" variant="primary" onClick=${() => onApply(th)}>${t('Apply')}<//>`}
  </article>`;
}

/* ------------------------------------------------------------------ the page */
const shuffle = (list, seed) => {
  let x = seed >>> 0 || 1; const rnd = () => { x = (x + 0x6D2B79F5) >>> 0; let q = x; q = Math.imul(q ^ (q >>> 15), q | 1); q ^= q + Math.imul(q ^ (q >>> 7), q | 61); return ((q ^ (q >>> 14)) >>> 0) / 4294967296; };
  const a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a;
};
const newSeed = () => Math.floor(Math.random() * 2147483647);

export function ThemesPage() {
  const me = useSel((s) => s.me); const rev = useSel((s) => s.themesRev); const view = useSel((s) => s.route.themesView || 'discover'); const settings = useSel((s) => s.settings); void settings;
  const [sorts, setSorts] = useState({ discover: 'random', library: 'alpha' }); const [seed, setSeed] = useState(newSeed);
  const [pub, setPub] = useState(null); const [pubMore, setPubMore] = useState(false); const [lib, setLib] = useState(null); const [error, setError] = useState(null);
  const [making, setMaking] = useState({}); const [, bump] = useState(0);
  const kind = kindNow; const sort = sorts[view]; const creator = isCreator(me); const closed = useRef(false); const asked = useRef(0); const tried = useRef(new Set()); const scroller = useRef(null);
  useEffect(() => { const f = () => bump((n) => n + 1); subs.add(f); return () => { subs.delete(f); closed.current = true; }; }, []);

  // Theme Discovery: one page of the kind and sort chosen, more on request
  const loadPub = async (more) => {
    const mine = ++asked.current;   // (an answer that comes after you picked another tab or sort is dropped)
    try {
      const r = await api.get(`/themes/discover?kind=${kind}&sort=${sort}&seed=${seed}&limit=48&offset=${more ? pub.themes.length : 0}`);
      if (closed.current || mine !== asked.current) return; setError(null); setPub(more ? { total: r.total, themes: [...pub.themes, ...r.themes] } : r);
    } catch (e) { if (!closed.current) setError(errMsg(e)); }
  };
  useEffect(() => { if (view !== 'discover') return; setPub(null); setPubMore(false); loadPub(false); }, [view, kind, sort, seed, rev]);
  // your library: everything at once (it is at most 50 themes); the pictures that are missing get drawn now
  const loadLib = async () => {
    try { const r = await api.get('/themes/library'); if (!closed.current) { setError(null); setLib(r.themes); } } catch (e) { if (!closed.current) setError(errMsg(e)); }
  };
  useEffect(() => { if (view === 'library') loadLib(); }, [view, rev]);
  useEffect(() => { scroller.current?.scrollTo({ top: 0 }); setError(null); }, [view, kind]);
  useEffect(() => {
    if (view !== 'library' || !lib) return;
    const todo = lib.filter((x) => x.kind === kind && !x.preview && !tried.current.has(x.id)).slice(0, 4); if (!todo.length) return;
    todo.forEach((x) => tried.current.add(x.id));   // each theme is tried once per visit, so a failure never loops
    setMaking((m) => ({ ...m, ...Object.fromEntries(todo.map((x) => [x.id, true])) }));
    (async () => {
      for (const x of todo) {
        const done = await ensurePreview(x); if (closed.current) return;
        setMaking((m) => { const n = { ...m }; delete n[x.id]; return n; });
        if (done.preview) setLib((l) => l.map((y) => (y.id === done.id ? done : y)));
      }
    })();
  }, [view, kind, lib]);

  const reload = () => { if (view === 'library') loadLib(); else loadPub(false); };
  const install = async (th) => {
    const r = await act(api.post(`/themes/discover/${th.id}/install`));
    if (r) { toast(r.already ? t('Already in your library') : t(`Installed. It’s in your ${NOUN[th.kind]} library now.`), 'success', 2600); setPub((p) => p && { ...p, themes: p.themes.map((x) => (x.id === th.id ? { ...x, installed: true } : x)) }); }
  };
  const unpublish = async (th) => {
    const theirs = th.mine === false;   // (a staff member taking someone else's theme down)
    if (!await confirmDialog({ title: `${theirs ? t('Take down') : t('Unpublish')} “${th.name}”?`, body: theirs ? t('It leaves Theme Discovery for everyone. People who already installed it keep their copy.') : t('It leaves Theme Discovery for everyone. People who already installed it keep their copy, and it stays in your library.'), confirmLabel: theirs ? t('Take down') : t('Unpublish'), danger: true })) return;
    if (await act(api.del(`/themes/discover/${th.published || th.id}`), { success: t('Unpublished') })) reload();
  };
  const publish = async (th) => {
    let cur = th;
    const name = await askName({ title: t('Publish on Theme Discovery'), label: t('Name everyone will see'), value: th.name, confirm: t('Publish'), note: t('Everyone can install it. People see the preview picture, its name and your display name.') });
    if (!name) return;
    if (!cur.preview) { setMaking((m) => ({ ...m, [th.id]: true })); cur = await ensurePreview(th); setMaking((m) => { const n = { ...m }; delete n[th.id]; return n; }); }
    if (await act(api.post('/themes/discover', { id: cur.id, name }), { success: t('Published on Theme Discovery') })) loadLib();
  };
  const rename = async (th) => {
    const name = await askName({ title: t('Rename theme'), label: t('Theme name'), value: th.name, confirm: t('Rename') });
    if (name && await act(api.patch(`/themes/library/${th.id}`, { name }))) setLib((l) => l.map((x) => (x.id === th.id ? { ...x, name } : x)));
  };
  const remove = async (th) => {
    if (!await confirmDialog({ title: `${t('Delete')} “${th.name}”?`, body: th.published ? t('It is removed from your library. It stays on Theme Discovery until you unpublish it.') : t('It is removed from your library.'), confirmLabel: t('Delete'), danger: true })) return;
    if (await act(api.del(`/themes/library/${th.id}`))) setLib((l) => l.filter((x) => x.id !== th.id));
  };
  const saveNow = async () => { if (await saveCurrentLook(kind)) loadLib(); };

  const mine = (lib || []).filter((x) => x.kind === kind); const counts = { profile: (lib || []).filter((x) => x.kind === 'profile').length, site: (lib || []).filter((x) => x.kind === 'site').length };
  const shownLib = useMemo(() => (sort === 'alpha' ? [...mine].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })) : shuffle(mine, seed)), [lib, kind, sort, seed]);
  const full = mine.length >= LIBRARY_LIMIT;
  const goView = (v) => go(v === 'library' ? '/themes/library' : '/themes');
  const tab = (v, icon, label) => html`<button type="button" class=${cx('staff-tab', view === v && 'on')} onClick=${() => goView(v)}><${Icon} name=${icon} size=${16} />${t(label)}</button>`;
  return html`<main class="main panel themes-page view-anim">
    <header class="m-header">
      <button type="button" class="mobile-only icon-btn" onClick=${() => set({ mobileNav: true })} aria-label=${t('Menu')}><${Icon} name="menu" size=${22} /></button>
      <div class="m-title"><${Icon} name="paintbrush" size=${23} /><span class="name">${t('Themes')}</span></div>
      <div class="staff-tabs">${tab('discover', 'compass', 'Discovery')}${tab('library', 'folder', 'My library')}</div>
      ${view === 'library' && undo ? html`<${Btn} class="th-undo" size="sm" variant="ghost" icon="refresh" onClick=${undoApply}>${t('Undo last theme')}<//>` : null}
    </header>
    <div class="themes-scroll" ref=${scroller}>
      <div class="themes-bar">
        <${Segmented} size="sm" options=${KINDS.map((k) => ({ value: k.value, label: `${t(k.label)}${view === 'library' && lib ? ` · ${counts[k.value]}/${LIBRARY_LIMIT}` : ''}` }))} value=${kind} onChange=${setKindNow} />
        <span class="grow"></span>
        ${sort === 'random' ? html`<${IconBtn} icon="refresh" label=${t('Shuffle')} size=${17} glass=${null} onClick=${() => setSeed(newSeed())} />` : null}
        <${Dropdown} width=${158} value=${sort} options=${[{ value: 'random', label: t('Random') }, { value: 'alpha', label: t('Alphabetical') }]} onChange=${(v) => setSorts((s) => ({ ...s, [view]: v }))} />
        ${view === 'library' ? html`<${Btn} variant="primary" icon="plus" disabled=${full} onClick=${saveNow}>${full ? t('Library full') : t('Save my current look')}<//>` : null}
      </div>
      ${error ? html`<${Empty} icon="alert-circle" title=${t('Couldn’t load themes')}>${error} <button type="button" class="link-btn" onClick=${reload}>${t('Try again')}</button><//>`
        : view === 'discover' ? (!pub ? html`<div class="pk-center"><${Spinner} /></div>` : !pub.themes.length
          ? html`<${Empty} icon="paintbrush" title=${t(`No ${NOUN[kind]}s here yet`)}>${creator ? t('Publish one of yours from My library.') : t('People with the Creator badge can publish their themes here.')}<//>`
          : html`<div class="theme-grid">${pub.themes.map((th) => html`<${DiscoverCard} key=${th.id} th=${th} onInstall=${install} onUnpublish=${unpublish} />`)}</div>
            ${pub.themes.length < pub.total ? html`<div class="themes-more"><${Btn} onClick=${async () => { setPubMore(true); await loadPub(true); setPubMore(false); }} loading=${pubMore}>${t('Show more')}<//></div>` : null}`)
          : !lib ? html`<div class="pk-center"><${Spinner} /></div>` : !shownLib.length
            ? html`<${Empty} icon="folder" title=${t(`No ${NOUN[kind]}s saved yet`)}>${t('Save the look you have now, or install one from Theme Discovery.')}<//>`
            : html`<div class="theme-grid">${shownLib.map((th) => html`<${LibraryCard} key=${th.id} th=${th} creator=${creator} worn=${isWorn(th)} working=${!!making[th.id] && !th.preview} onApply=${applyTheme} onRename=${rename} onDelete=${remove} onPublish=${publish} onUnpublish=${unpublish} />`)}</div>`}
    </div>
  </main>`;
}

/* ------------------------------------------------------------------ entrances in Settings */
/** The buttons at the top of the Theme settings: save the look you have now, open your library. */
export function ThemeLibraryBar({ kind = 'site' }) {
  return html`<div class="tlib-bar"><${Btn} variant="primary" icon="plus" onClick=${() => saveCurrentLook(kind)}>${t('Save my current look')}<//><${Btn} icon="folder" onClick=${() => openThemes('library', kind)}>${t('My theme library')}<//></div>`;
}
