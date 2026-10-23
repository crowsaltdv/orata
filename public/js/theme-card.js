// Orata — shared themes: `/theme` posts your look as a card in chat; anyone can try it with one click and put things back with the same button.
import { html, useState, cx, hexToRgb } from '/js/lib.js';
import { state, useSel, updateSettings, toast } from '/js/store.js';
import { DEFAULT_SETTINGS, MESH_WALLPAPERS, PHOTO_WALLPAPERS, deepMerge } from '/js/defaults.js';
import { wallpaperSource } from '/js/theme.js';
import { Btn } from '/js/ui.js';
import { api } from '/js/api.js';
import { act } from '/js/actions.js';
import { t } from '/js/i18n.js';
import { checkLook, CARD_SECTIONS } from '/js/theme-data.js';


/** What your look is made of: the same settings as Export theme, minus your saved wallpapers and your reduced-motion choice (those stay personal). */
function currentLook() {
  const s = state.settings; const out = {};
  for (const k of CARD_SECTIONS) out[k] = structuredClone(s[k] || {});
  delete out.bg.library; delete out.motion.reduce;
  return out;
}

/* ------------------------------------------------------------------ checking a shared look
 * Whatever arrives in a message is untrusted: every setting must exist, have the right kind of value and sit inside what the settings sliders allow (theme-data.js). */
export const checkedLook = (data) => checkLook(data, { sections: CARD_SECTIONS });

/* ------------------------------------------------------------------ apply / undo */
const same = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-6 : JSON.stringify(a) === JSON.stringify(b));
const isApplied = (look) => { const s = state.settings; return Object.keys(look).length > 0 && Object.entries(look).every(([sec, o]) => Object.entries(o).every(([k, v]) => same(s[sec]?.[k], v))); };
/** The values your settings have now for exactly the settings a look would change — what Undo puts back. */
const snapshotFor = (look) => { const s = state.settings; const out = {}; for (const [sec, o] of Object.entries(look)) { out[sec] = {}; for (const k of Object.keys(o)) out[sec][k] = structuredClone(s[sec]?.[k] ?? null); } return out; };

const UNDO_KEY = 'orate:themeUndo';
const undoKey = (m) => `${state.me?.id}:${m.id}`;
const readUndo = () => { try { return JSON.parse(localStorage.getItem(UNDO_KEY) || '{}'); } catch { return {}; } };
const writeUndo = (o) => { try { const keys = Object.keys(o); while (keys.length > 40) delete o[keys.shift()]; localStorage.setItem(UNDO_KEY, JSON.stringify(o)); } catch { /* storage unavailable: Undo just won't survive a reload */ } };

/** `/theme [name]` — posts your current look as a card in this conversation. */
export async function shareTheme(channelId, name) {
  const r = await act(api.post(`/channels/${channelId}/messages`, { theme: { name: (name || '').trim().slice(0, 40) || undefined, data: currentLook() } }));
  return r;
}

const MODE = { dark: 'Dark', light: 'Light', midnight: 'Midnight', auto: 'Automatic' };
function describe(look) {
  const all = deepMerge(DEFAULT_SETTINGS, look); const bg = all.bg; const parts = [t(MODE[all.theme.mode] || 'Dark')];
  parts.push(bg.type === 'photo' ? PHOTO_WALLPAPERS.find((p) => p.id === bg.photo)?.name : bg.type === 'mesh' ? MESH_WALLPAPERS.find((m) => m.id === bg.mesh)?.name : bg.type === 'image' && bg.image ? t('Custom wallpaper') : bg.type === 'gradient' ? t('Gradient wallpaper') : t('Solid wallpaper'));
  if (all.rain.enabled) parts.push(t('Rain'));
  if (all.glass.style !== 'off') parts.push(t('Liquid glass'));
  if (all.fonts.ui) parts.push(all.fonts.ui);
  return parts.filter(Boolean).join(' · ');
}

function Preview({ look }) {
  const all = deepMerge(DEFAULT_SETTINGS, look); const th = all.theme; const src = wallpaperSource(all.bg);
  const wall = src.kind === 'image' ? { backgroundImage: `url("${src.url}")` } : { background: src.css };
  const rgb = hexToRgb(th.panelColor) || [11, 11, 16];
  const accent = th.accentType === 'gradient' ? `linear-gradient(135deg, ${th.accent}, ${th.accent2})` : th.accent;
  return html`<div class="tc-preview" style=${wall} aria-hidden="true">
    <div class="tc-dim" style=${{ opacity: all.bg.dim }}></div>
    <div class="tc-panel" style=${{ background: `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]} / ${Math.max(0.35, th.panelOpacity)})`, borderRadius: Math.max(4, Math.round(th.radius / 3)) }}><i class="tc-line"></i><i class="tc-line short"></i><b class="tc-accent" style=${{ background: accent }}></b></div>
  </div>`;
}

export function ThemeCard({ m }) {
  const me = state.me.id; const mine = m.authorId === me;
  const author = useSel((s) => s.users[m.authorId]);
  const settings = useSel((s) => s.settings);   // re-render when the look changes so "applied" stays true to what you see
  const look = checkedLook(m.theme.data);
  const [, bump] = useState(0);
  const hasUndo = !!readUndo()[undoKey(m)];
  const applied = isApplied(look); void settings;
  const name = m.theme.name || `${author?.displayName || t('Someone')}${t('’s theme')}`;
  if (!Object.keys(look).length) return html`<div class="theme-embed bad"><div class="ie-head">${t('A theme that can’t be used')}</div><div class="ie-sub">${t('This shared theme has nothing Orata can apply.')}</div></div>`;
  const apply = () => {
    const undo = readUndo(); undo[undoKey(m)] = snapshotFor(look); writeUndo(undo);
    updateSettings(look); bump((n) => n + 1); toast(t('Theme applied — press Undo to go back'), 'success', 2600);
  };
  const undoIt = () => {
    const undo = readUndo(); const snap = undo[undoKey(m)]; if (!snap) return;
    delete undo[undoKey(m)]; writeUndo(undo);
    updateSettings(snap); bump((n) => n + 1); toast(t('Your previous look is back'), 'success', 2200);
  };
  return html`<div class=${cx('theme-embed', applied && 'applied')}>
    <div class="ie-head">${mine ? t('You shared a theme') : t('Shared a theme')}</div>
    <div class="ie-row">
      <${Preview} look=${look} />
      <div class="ie-info"><b class="ie-name" title=${name}>${name}</b><div class="ie-sub">${describe(look)}</div></div>
      ${hasUndo ? html`<${Btn} class="ie-btn" icon="refresh" onClick=${undoIt}>${t('Undo')}<//>`
        : applied ? html`<${Btn} class="ie-btn" icon="check" disabled=${true}>${t('Applied')}<//>`
          : html`<${Btn} class="ie-btn" variant="primary" onClick=${apply}>${t('Apply Theme')}<//>`}
    </div>
  </div>`;
}
