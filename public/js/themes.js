// Orata — themes: the Discovery page (the globe in the server rail, like Music): themes other people posted, and your theme library
// (up to 25 profile + 25 site themes, kept on your account). Each has a Profile themes and a Site themes tab and a sort (Discovery: Featured — the most upvoted
// first — Random or Alphabetical). Saving the look you have now, applying a saved theme, renaming, deleting; people with the Creator badge, and Orata staff and
// developers, post a theme of their own (the + in Discovery, or the + on a saved theme); everyone installs and upvotes. What a theme holds is
// public/js/theme-data.js; the picture each one shows is drawn by theme-preview.js; the server side is server/themes.js.
import { html, useState, useEffect, useMemo, useRef, cx, ls } from '/js/lib.js';
import { state, set, useSel, go, closeModal, openModal, openContext, updateSettings, toast } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { Modal, Btn, IconBtn, Avatar, Segmented, Dropdown, Spinner, Empty, Field, TextInput, MODALS, confirmDialog } from '/js/ui.js';
import { api } from '/js/api.js';
import { act, errMsg, closeSettings } from '/js/actions.js';
import { t } from '/js/i18n.js';
import { sanitizeProfileStyle } from '/js/profile-data.js';
import { LIBRARY_LIMIT, sanitizeSiteLook, siteLookOf } from '/js/theme-data.js';
import { isStaffMe } from '/js/staff.js';

const KINDS = [{ value: 'profile', label: 'Profile themes' }, { value: 'site', label: 'Site themes' }];
const NOUN = { profile: 'profile theme', site: 'site theme' };
/** Who may post a theme on Discovery: the Creator badge, and the Orata staff and developer badges (the server checks the same). */
export const canPost = (u) => !!u?.badges?.some((b) => b.id === 'creator' || b.id === 'staff' || b.id === 'dev');

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

/** Posts one of your saved themes on Discovery under `name` (its preview picture is drawn first when it has none). Resolves the posted theme, or nothing (the reason is shown). */
async function postTheme(th, name) {
  const cur = th.preview ? th : await ensurePreview(th);
  return act(api.post('/themes/discover', { id: cur.id, name }), { success: t('Posted to Discovery') });
}
const POST_NOTE = () => t('Everyone can install and upvote it. People see its preview picture, its title and your name and picture.');

/** The + in Discovery: pick one of your saved themes (or the look you have now), set the title, post it. */
MODALS['post-theme'] = function PostTheme({ id, kind, onDone }) {
  const [mine, setMine] = useState(null); const [pick, setPick] = useState(null); const [name, setName] = useState(''); const [busy, setBusy] = useState(false);
  const now = currentLook(kind); const fresh = kind === 'site' ? t('My site theme') : t('My profile theme');
  useEffect(() => {
    api.get('/themes/library').then((r) => {
      const own = r.themes.filter((x) => x.kind === kind && !x.from);   // only your own work (a theme you installed can't be posted again)
      setMine(own); const first = own.find((x) => !x.published); setPick(first ? first.id : now ? 'now' : null); setName(first ? first.name : fresh);
    }).catch(() => setMine([]));
  }, []);
  const choose = (key, label) => { setPick(key); setName(label); };
  const post = async () => {
    setBusy(true);
    const th = pick === 'now' ? await saveToLibrary(kind, now, name) : mine.find((x) => x.id === pick);
    if (th && await postTheme(th, name)) { closeModal(id); onDone?.(); } else setBusy(false);
  };
  const row = (key, preview, title, sub, disabled, label) => html`<label class=${cx('pick-row', pick === key && 'sel', disabled && 'disabled')} key=${key}>
    <span class="pt-thumb">${preview ? html`<img src=${preview} alt="" />` : html`<${Icon} name="image" size=${18} sw=${1.6} />`}</span>
    <span><b>${title}</b><small>${sub}</small></span>
    <input type="radio" name="post" checked=${pick === key} disabled=${disabled} onChange=${() => choose(key, label)} /><span class="box"><${Icon} name="check" size=${14} sw=${3} /></span></label>`;
  return html`<${Modal} title=${t('Post a theme')} subtitle=${t(`Pick one of your saved ${NOUN[kind]}s, or post the look you have now.`)} width=${460} onClose=${() => closeModal(id)}
    footer=${html`<${Btn} variant="ghost" onClick=${() => closeModal(id)}>${t('Cancel')}<//><${Btn} variant="primary" icon="plus" loading=${busy} disabled=${!pick || !name.trim()} onClick=${post}>${t('Post')}<//>`}>
    ${!mine ? html`<div class="pk-center"><${Spinner} /></div>` : html`
      <div class="pick-list pt-list">
        ${now ? row('now', null, t('The look I have now'), t('Saved to your library first'), false, fresh) : null}
        ${mine.map((x) => row(x.id, x.preview, x.name, x.published ? t('Already posted') : t('In your library'), !!x.published, x.name))}
        ${!now && !mine.length ? html`<p class="text-muted" style="padding:8px;margin:0">${kind === 'profile' ? t('Style your profile in Settings → Profile first, then post it here.') : t('You have nothing to post yet.')}</p>` : null}
      </div>
      <${Field} label=${t('Title')}><${TextInput} value=${name} onInput=${setName} maxlength="40" onKeyDown=${(e) => e.key === 'Enter' && pick && name.trim() && post()} /><//>
      <p class="text-muted" style="font-size:13px;margin:0">${POST_NOTE()}</p>`}
  <//>`;
};

/** Goes to the Discovery page: `view` is 'discover' or 'library', `kind` the tab ('site' or 'profile'). */
export function openThemes(view = 'discover', kind) {
  if (kind) setKindNow(kind);
  if (state.settingsPage) closeSettings();
  go(view === 'library' ? '/themes/library' : '/themes');
}

/* ------------------------------------------------------------------ the cards */
function Picture({ src, busy, children }) {
  return html`<div class="tcard-prev">${src ? html`<img src=${src} alt="" loading="lazy" draggable=${false} />` : html`<div class="tcard-none">${busy ? html`<${Spinner} size=${22} />` : html`<${Icon} name="image" size=${28} sw=${1.5} />`}</div>`}${children}</div>`;
}
/** The "…" in a card's corner: the things you do less often (rename, delete) are in its menu (the same one a right click opens), so a card shows only its main button. */
function More({ items }) {
  return html`<button type="button" class="tcard-more" aria-label=${t('More')} onClick=${(e) => openContext(e, items)}><${Icon} name="more-h" size=${18} /></button>`;
}
/** The poster: their picture and name, in gray. */
const Poster = ({ user }) => html`<span class="tcard-by"><${Avatar} user=${user} size=${20} /><span>${user.displayName}</span></span>`;
function DiscoverCard({ th, onInstall, onRemove, onVote }) {
  const [busy, setBusy] = useState(false);
  const menu = isStaffMe() && !th.mine ? [{ label: t('Take down (staff)'), icon: 'trash', danger: true, onClick: () => onRemove(th) }] : null;
  const install = async () => { setBusy(true); await onInstall(th); setBusy(false); };
  return html`<article class="tcard" onContextMenu=${menu ? (e) => openContext(e, menu) : null}>
    <${Picture} src=${th.preview}>${menu ? html`<${More} items=${menu} />` : null}<//>
    <div class="tcard-meta">
      <div class="tcard-top"><b class="tcard-name" title=${th.name}>${th.name}</b>
        <button type="button" class=${cx('tcard-vote', th.voted && 'on')} disabled=${th.mine} aria-pressed=${th.voted} data-tip=${th.mine ? t('Your own theme') : th.voted ? t('Take back your upvote') : t('Upvote')} aria-label=${t('Upvote')} onClick=${() => onVote(th)}><${Icon} name="arrow-up" size=${14} sw=${2.8} />${th.votes}</button></div>
      <${Poster} user=${th.author} />
    </div>
    ${th.mine ? html`<${Btn} class="tcard-btn" onClick=${() => onRemove(th)}>${t('Remove')}<//>`
      : th.installed ? html`<${Btn} class="tcard-btn" icon="check" disabled=${true}>${t('Installed')}<//>`
        : html`<${Btn} class="tcard-btn" variant="primary" loading=${busy} onClick=${install}>${t('Install')}<//>`}
  </article>`;
}
/** The first tile of Discovery for people who can post: a +. */
function PostTile({ onClick }) {
  return html`<button type="button" class="tcard tcard-add" onClick=${onClick} aria-label=${t('Post a theme')}>
    <div class="tcard-prev"><${Icon} name="plus" size=${40} sw=${1.8} /></div>
    <div class="tcard-meta"><b class="tcard-name">${t('Post a theme')}</b><span class="tcard-by">${t('Share one of yours')}</span></div></button>`;
}
function LibraryCard({ th, canPostNow, worn, working, onApply, onRename, onDelete, onPost, onRemove }) {
  const mayPost = canPostNow && !th.from;   // (a theme you installed isn't yours to post)
  const menu = [
    { label: t('Rename'), icon: 'edit', onClick: () => onRename(th) },
    mayPost && (th.published ? { label: t('Remove from Discovery'), icon: 'globe-grid', onClick: () => onRemove(th) } : { label: t('Post to Discovery'), icon: 'globe-grid', onClick: () => onPost(th) }),
    { type: 'sep' },
    { label: t('Delete'), icon: 'trash', danger: true, onClick: () => onDelete(th) },
  ];
  return html`<article class=${cx('tcard', worn && 'worn')} onContextMenu=${(e) => openContext(e, menu)}>
    <${Picture} src=${th.preview} busy=${working}>${worn ? html`<span class="tcard-badge"><${Icon} name="check" size=${12} sw=${3} />${t('In use')}</span>` : null}<${More} items=${menu} /><//>
    <div class="tcard-meta">
      <div class="tcard-top"><b class="tcard-name" title=${th.name}>${th.name}</b>
        ${mayPost && !th.published ? html`<button type="button" class="tcard-plus" data-tip=${t('Post to Discovery')} aria-label=${t('Post to Discovery')} onClick=${() => onPost(th)}><${Icon} name="plus" size=${16} sw=${2.6} /></button>` : null}</div>
      ${th.published ? html`<span class="tcard-by"><${Icon} name="globe-grid" size=${13} sw=${2.2} />${t('Posted')}</span>` : th.from ? html`<span class="tcard-by">${t('From Discovery')}</span>` : null}
    </div>
    ${worn ? html`<${Btn} class="tcard-btn" disabled=${true}>${t('In use')}<//>` : html`<${Btn} class="tcard-btn" variant="primary" onClick=${() => onApply(th)}>${t('Apply')}<//>`}
  </article>`;
}

/* ------------------------------------------------------------------ the page */
const shuffle = (list, seed) => {
  let x = seed >>> 0 || 1; const rnd = () => { x = (x + 0x6D2B79F5) >>> 0; let q = x; q = Math.imul(q ^ (q >>> 15), q | 1); q ^= q + Math.imul(q ^ (q >>> 7), q | 61); return ((q ^ (q >>> 14)) >>> 0) / 4294967296; };
  const a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a;
};
const newSeed = () => Math.floor(Math.random() * 2147483647);
const SORTS = { discover: [['featured', 'Featured'], ['random', 'Random'], ['alpha', 'Alphabetical']], library: [['alpha', 'Alphabetical'], ['random', 'Random']] };

export function ThemesPage() {
  const me = useSel((s) => s.me); const rev = useSel((s) => s.themesRev); const view = useSel((s) => s.route.themesView || 'discover'); const settings = useSel((s) => s.settings); void settings;
  const [sorts, setSorts] = useState({ discover: 'featured', library: 'alpha' }); const [seed, setSeed] = useState(newSeed);
  const [pub, setPub] = useState(null); const [pubMore, setPubMore] = useState(false); const [lib, setLib] = useState(null); const [error, setError] = useState(null);
  const [making, setMaking] = useState({}); const [, bump] = useState(0);
  const kind = kindNow; const sort = sorts[view]; const poster = canPost(me); const closed = useRef(false); const asked = useRef(0); const tried = useRef(new Set()); const scroller = useRef(null);
  useEffect(() => { const f = () => bump((n) => n + 1); subs.add(f); return () => { subs.delete(f); closed.current = true; }; }, []);

  // Discovery: one page of the kind and sort chosen, more on request
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
  const patchPub = (id, patch) => setPub((p) => p && { ...p, themes: p.themes.map((x) => (x.id === id ? { ...x, ...patch } : x)) });
  const install = async (th) => {
    const r = await act(api.post(`/themes/discover/${th.id}/install`));
    if (r) { toast(r.already ? t('Already in your library') : t(`Installed. It’s in your ${NOUN[th.kind]} library now.`), 'success', 2600); patchPub(th.id, { installed: true }); }
  };
  const vote = async (th) => {
    if (th.mine) return;
    const want = !th.voted; patchPub(th.id, { voted: want, votes: th.votes + (want ? 1 : -1) });   // (shown at once; the server's count replaces it)
    const r = await act(api.put(`/themes/discover/${th.id}/vote`, { vote: want }));
    patchPub(th.id, r ? { voted: r.voted, votes: r.votes } : { voted: th.voted, votes: th.votes });
  };
  const removeFromDiscovery = async (th) => {
    const theirs = th.mine === false;   // (a staff member taking someone else's theme down)
    if (!await confirmDialog({ title: `${theirs ? t('Take down') : t('Remove from Discovery')} “${th.name}”?`, body: theirs ? t('It leaves Discovery for everyone. People who already installed it keep their copy.') : t('It leaves Discovery for everyone. People who already installed it keep their copy, and it stays in your library.'), confirmLabel: theirs ? t('Take down') : t('Remove'), danger: true })) return;
    if (await act(api.del(`/themes/discover/${th.published || th.id}`), { success: t('Removed from Discovery') })) reload();
  };
  const post = async (th) => {   // the + on a saved theme: its title, then post
    const name = await askName({ title: t('Post to Discovery'), label: t('Title'), value: th.name, confirm: t('Post'), note: POST_NOTE() });
    if (!name) return;
    setMaking((m) => ({ ...m, [th.id]: true }));
    const done = await postTheme(th, name);
    setMaking((m) => { const n = { ...m }; delete n[th.id]; return n; });
    if (done) loadLib();
  };
  const openPost = () => openModal('post-theme', { kind, onDone: () => { if (view === 'discover') loadPub(false); else loadLib(); } });
  const rename = async (th) => {
    const name = await askName({ title: t('Rename theme'), label: t('Theme name'), value: th.name, confirm: t('Rename') });
    if (name && await act(api.patch(`/themes/library/${th.id}`, { name }))) setLib((l) => l.map((x) => (x.id === th.id ? { ...x, name } : x)));
  };
  const remove = async (th) => {
    if (!await confirmDialog({ title: `${t('Delete')} “${th.name}”?`, body: th.published ? t('It is removed from your library. It stays on Discovery until you remove it from there.') : t('It is removed from your library.'), confirmLabel: t('Delete'), danger: true })) return;
    if (await act(api.del(`/themes/library/${th.id}`))) setLib((l) => l.filter((x) => x.id !== th.id));
  };
  const saveNow = async () => { if (await saveCurrentLook(kind)) loadLib(); };

  const mine = (lib || []).filter((x) => x.kind === kind); const counts = { profile: (lib || []).filter((x) => x.kind === 'profile').length, site: (lib || []).filter((x) => x.kind === 'site').length };
  const shownLib = useMemo(() => (sort === 'alpha' ? [...mine].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })) : shuffle(mine, seed)), [lib, kind, sort, seed]);
  const full = mine.length >= LIBRARY_LIMIT;
  const goView = (v) => go(v === 'library' ? '/themes/library' : '/themes');
  const tab = (v, icon, label) => html`<button type="button" class=${cx('staff-tab', view === v && 'on')} onClick=${() => goView(v)}><${Icon} name=${icon} size=${16} />${t(label)}</button>`;
  const tile = poster ? html`<${PostTile} onClick=${openPost} />` : null;
  return html`<main class="main panel themes-page view-anim">
    <header class="m-header">
      <button type="button" class="mobile-only icon-btn" onClick=${() => set({ mobileNav: true })} aria-label=${t('Menu')}><${Icon} name="menu" size=${22} /></button>
      <div class="m-title"><${Icon} name="globe-grid" size=${23} /><span class="name">${t('Discovery')}</span></div>
      <div class="staff-tabs">${tab('discover', 'compass', 'Browse')}${tab('library', 'folder', 'My library')}</div>
      ${view === 'library' && undo ? html`<${Btn} class="th-undo" size="sm" variant="ghost" icon="refresh" onClick=${undoApply}>${t('Undo last theme')}<//>` : null}
    </header>
    <div class="themes-scroll" ref=${scroller}>
      <div class="themes-bar">
        <${Segmented} size="sm" options=${KINDS.map((k) => ({ value: k.value, label: `${t(k.label)}${view === 'library' && lib ? ` · ${counts[k.value]}/${LIBRARY_LIMIT}` : ''}` }))} value=${kind} onChange=${setKindNow} />
        <span class="grow"></span>
        ${sort === 'random' ? html`<${IconBtn} icon="refresh" label=${t('Shuffle')} size=${17} glass=${null} onClick=${() => setSeed(newSeed())} />` : null}
        <${Dropdown} width=${158} value=${sort} options=${SORTS[view].map(([value, label]) => ({ value, label: t(label) }))} onChange=${(v) => setSorts((s) => ({ ...s, [view]: v }))} />
        ${view === 'library' ? html`<${Btn} variant="primary" icon="plus" disabled=${full} onClick=${saveNow}>${full ? t('Library full') : t('Save my current look')}<//>` : null}
      </div>
      ${error ? html`<${Empty} icon="alert-circle" title=${t('Couldn’t load themes')}>${error} <button type="button" class="link-btn" onClick=${reload}>${t('Try again')}</button><//>`
        : view === 'discover' ? (!pub ? html`<div class="pk-center"><${Spinner} /></div>` : html`
          ${pub.themes.length || tile ? html`<div class="theme-grid">${tile}${pub.themes.map((th) => html`<${DiscoverCard} key=${th.id} th=${th} onInstall=${install} onRemove=${removeFromDiscovery} onVote=${vote} />`)}</div>` : null}
          ${!pub.themes.length ? html`<${Empty} icon="globe-grid" title=${t(`No ${NOUN[kind]}s here yet`)}>${poster ? t('Be the first: press the + to post one of yours.') : t('Creators and Orata staff can post their themes here.')}<//>` : null}
          ${pub.themes.length < pub.total ? html`<div class="themes-more"><${Btn} onClick=${async () => { setPubMore(true); await loadPub(true); setPubMore(false); }} loading=${pubMore}>${t('Show more')}<//></div>` : null}`)
          : !lib ? html`<div class="pk-center"><${Spinner} /></div>` : !shownLib.length
            ? html`<${Empty} icon="folder" title=${t(`No ${NOUN[kind]}s saved yet`)}>${t('Save the look you have now, or install one from Discovery.')}<//>`
            : html`<div class="theme-grid">${shownLib.map((th) => html`<${LibraryCard} key=${th.id} th=${th} canPostNow=${poster} worn=${isWorn(th)} working=${!!making[th.id] && !th.preview} onApply=${applyTheme} onRename=${rename} onDelete=${remove} onPost=${post} onRemove=${removeFromDiscovery} />`)}</div>`}
    </div>
  </main>`;
}

/* ------------------------------------------------------------------ entrances in Settings */
/** The buttons at the top of the Theme settings: save the look you have now, open your library. */
export function ThemeLibraryBar({ kind = 'site' }) {
  return html`<div class="tlib-bar"><${Btn} variant="primary" icon="plus" onClick=${() => saveCurrentLook(kind)}>${t('Save my current look')}<//><${Btn} icon="folder" onClick=${() => openThemes('library', kind)}>${t('My theme library')}<//></div>`;
}
