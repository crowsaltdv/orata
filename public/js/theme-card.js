// Orate — shared themes: `/theme` posts your look as a card in chat; anyone can try it with one click and put things back with the same button.
import { html, useState, cx, hexToRgb } from '/js/lib.js';
import { state, useSel, updateSettings, toast } from '/js/store.js';
import { DEFAULT_SETTINGS, MESH_WALLPAPERS, PHOTO_WALLPAPERS, deepMerge } from '/js/defaults.js';
import { wallpaperSource } from '/js/theme.js';
import { Btn } from '/js/ui.js';
import { api } from '/js/api.js';
import { act } from '/js/actions.js';
import { t } from '/js/i18n.js';

const SECTIONS = ['theme', 'bg', 'rain', 'glass', 'fonts', 'motion', 'chat'];

/** What your look is made of: the same settings as Export theme, minus your saved wallpapers and your reduced-motion choice (those stay personal). */
function currentLook() {
  const s = state.settings; const out = {};
  for (const k of SECTIONS) out[k] = structuredClone(s[k] || {});
  delete out.bg.library; delete out.motion.reduce;
  return out;
}

/* ------------------------------------------------------------------ checking a shared look
 * Whatever arrives in a message is untrusted: every setting must exist, have the right kind of value and sit inside what the settings sliders allow. */
const RANGE = {
  'theme.panelAngle': [0, 360], 'theme.panelOpacity': [0.05, 1], 'theme.panelBlur': [0, 60], 'theme.radius': [0, 36], 'theme.gap': [0, 24], 'theme.saturation': [0.5, 2.2],
  'bg.blur': [0, 40], 'bg.dim': [0, 0.9], 'bg.brightness': [0.4, 1.6], 'bg.saturate': [0, 2.2], 'bg.posX': [0, 100], 'bg.posY': [0, 100], 'bg.zoom': [1, 2.5], 'bg.gradient.angle': [0, 360],
  'rain.amount': [0, 0.7], 'rain.size': [0.5, 1.8], 'rain.speed': [0.3, 2.2], 'rain.refraction': [0.3, 1.8], 'rain.mist': [0, 40], 'rain.trails': [0, 5], 'rain.droplets': [0, 120], 'rain.lightning': [0, 0.25],
  'glass.intensity': [0.1, 1], 'fonts.size': [12, 24], 'fonts.weight': [300, 600], 'fonts.lineHeight': [1.1, 2], 'fonts.letterSpacing': [-0.05, 0.2], 'motion.speed': [0.5, 2], 'chat.spacing': [0, 32],
};
const ENUM = {
  'theme.mode': ['dark', 'light', 'midnight', 'auto'], 'theme.accentType': ['solid', 'gradient'], 'theme.panelType': ['solid', 'gradient'],
  'bg.type': ['mesh', 'photo', 'image', 'gradient', 'solid'], 'bg.mesh': MESH_WALLPAPERS.map((m) => m.id), 'bg.photo': PHOTO_WALLPAPERS.map((p) => p.id),
  'rain.preset': ['rain', 'drizzle', 'storm', 'fallout', 'custom'], 'rain.fps': [30, 60], 'glass.style': ['off', 'liquid'],
};
const COLORS = new Set(['theme.accent', 'theme.accent2', 'theme.panelColor', 'theme.panelColor2', 'theme.textColor', 'bg.color', 'bg.gradient.c1', 'bg.gradient.c2']);
const HEX = /^#[0-9a-f]{6}$/i; const FONT = /^[\w .+-]{1,60}$/; const IMAGE = /^(\/uploads\/[\w.-]+|\/img\/[\w./-]+|https?:\/\/[^\s"'()\\]+)$/i;

function checkValue(path, v, def) {
  if (path in ENUM) return ENUM[path].includes(v) ? v : undefined;
  if (COLORS.has(path)) return v === null ? (def === null ? null : undefined) : (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : undefined);
  if (path === 'bg.image') return v === null || (typeof v === 'string' && IMAGE.test(v)) ? v : undefined;
  if (/^fonts\.(ui|chat|code)$/.test(path)) return v === null || (typeof v === 'string' && FONT.test(v)) ? v : undefined;
  if (typeof def === 'boolean') return typeof v === 'boolean' ? v : undefined;
  if (typeof def === 'number') { const r = RANGE[path]; return r && typeof v === 'number' && Number.isFinite(v) ? Math.min(r[1], Math.max(r[0], v)) : undefined; }
  return undefined;
}
export function checkedLook(data) {
  const out = {};
  for (const sec of SECTIONS) {
    const src = data?.[sec]; const def = DEFAULT_SETTINGS[sec]; if (!src || typeof src !== 'object') continue;
    const o = {};
    for (const [k, v] of Object.entries(src)) {
      if (!Object.hasOwn(def, k) || k === 'library' || (sec === 'motion' && k === 'reduce')) continue;
      if (def[k] && typeof def[k] === 'object') {   // bg.gradient
        const g = {};
        for (const [gk, gv] of Object.entries(v && typeof v === 'object' ? v : {})) { if (!Object.hasOwn(def[k], gk)) continue; const c = checkValue(`${sec}.${k}.${gk}`, gv, def[k][gk]); if (c !== undefined) g[gk] = c; }
        if (Object.keys(g).length) o[k] = g;
      } else { const c = checkValue(`${sec}.${k}`, v, def[k]); if (c !== undefined) o[k] = c; }
    }
    if (sec === 'bg' && o.type === 'image' && !o.image) delete o.type;   // "my own wallpaper" without a usable picture would just blank yours
    if (Object.keys(o).length) out[sec] = o;
  }
  return out;
}

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
  if (!Object.keys(look).length) return html`<div class="theme-embed bad"><div class="ie-head">${t('A theme that can’t be used')}</div><div class="ie-sub">${t('This shared theme has nothing Orate can apply.')}</div></div>`;
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
