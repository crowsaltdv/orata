// Orata — theme data: what a "site theme" (the whole look of the app) and a "profile theme" (your profile style) are made of, and the one checker for each.
// The server runs these on every theme it is sent (server/themes.js) and the browser on every theme it receives or applies, so both always agree.
// Like profile-data.js, no browser or server APIs in here on purpose.
import { DEFAULT_SETTINGS, MESH_WALLPAPERS, PHOTO_WALLPAPERS, deepMerge } from './defaults.js';
import { sanitizeProfileStyle } from './profile-data.js';

export const THEME_KINDS = ['profile', 'site'];
export const LIBRARY_LIMIT = 25;   // per kind: 25 profile themes + 25 site themes = 50 in all
export const THEME_NAME_MAX = 40;

/* ------------------------------------------------------------------ checking a look
 * Whatever arrives from outside is untrusted: every setting must exist, have the right kind of value and sit inside what the settings sliders allow. */
const RANGE = {
  'theme.panelAngle': [0, 360], 'theme.panelOpacity': [0.05, 1], 'theme.panelBlur': [0, 60], 'theme.radius': [0, 36], 'theme.gap': [0, 24], 'theme.saturation': [0.5, 2.2],
  'bg.blur': [0, 40], 'bg.dim': [0, 0.9], 'bg.brightness': [0.4, 1.6], 'bg.saturate': [0, 2.2], 'bg.posX': [0, 100], 'bg.posY': [0, 100], 'bg.zoom': [1, 2.5], 'bg.gradient.angle': [0, 360],
  'rain.amount': [0, 0.7], 'rain.size': [0.5, 1.8], 'rain.speed': [0.3, 2.2], 'rain.refraction': [0.3, 1.8], 'rain.mist': [0, 40], 'rain.trails': [0, 5], 'rain.droplets': [0, 120], 'rain.lightning': [0, 0.25],
  'glass.intensity': [0.1, 1], 'fx.amount': [0.3, 2], 'fonts.size': [12, 24], 'fonts.weight': [300, 600], 'fonts.lineHeight': [1.1, 2], 'fonts.letterSpacing': [-0.05, 0.2], 'motion.speed': [0.5, 2], 'chat.spacing': [0, 32],
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

/** The settings sections the /theme card carries. */
export const CARD_SECTIONS = ['theme', 'bg', 'rain', 'glass', 'fonts', 'motion', 'chat'];
/** A site theme: every appearance setting there is. Not saved in it: your saved wallpapers (bg.library), Reduce motion and the accessibility switches (yours alone),
 *  and the chat settings that are about what is fetched or shown rather than how it looks (link previews, GIF autoplay, 24-hour time …). */
export const SITE_SECTIONS = ['theme', 'bg', 'rain', 'glass', 'fx', 'fonts', 'motion', 'chat'];
export const SITE_ONLY = { motion: ['speed', 'parallaxHover'], chat: ['compact', 'showAvatars', 'spacing', 'jumbo'] };
const NEVER = new Set(['bg.library', 'motion.reduce']);

/** Keeps only valid settings of `data` (`sections`, and within a section only `only[section]` when given). Anything wrong is dropped, numbers are clamped. */
export function checkLook(data, { sections = CARD_SECTIONS, only = {} } = {}) {
  const out = {};
  for (const sec of sections) {
    const src = data?.[sec]; const def = DEFAULT_SETTINGS[sec]; if (!src || typeof src !== 'object') continue;
    const o = {};
    for (const [k, v] of Object.entries(src)) {
      if (!Object.hasOwn(def, k) || NEVER.has(`${sec}.${k}`) || (only[sec] && !only[sec].includes(k))) continue;
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

/* ------------------------------------------------------------------ site themes */
/** The default value of every setting a site theme holds. */
function siteDefaults() {
  const out = {};
  for (const sec of SITE_SECTIONS) {
    out[sec] = {};
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS[sec])) if (!NEVER.has(`${sec}.${k}`) && (!SITE_ONLY[sec] || SITE_ONLY[sec].includes(k))) out[sec][k] = structuredClone(v);
  }
  return out;
}
/** A clean site theme from anything: every setting checked, and every one a site theme holds present (the ones left out take Orata's defaults). Null when nothing usable is in it. */
export function sanitizeSiteLook(data) {
  const look = checkLook(data, { sections: SITE_SECTIONS, only: SITE_ONLY });
  return Object.keys(look).length ? deepMerge(siteDefaults(), look) : null;
}
/** The site theme your settings make right now (not yet checked: pass it through sanitizeSiteLook). */
export function siteLookOf(settings) {
  const out = {};
  for (const sec of SITE_SECTIONS) {
    const s = settings?.[sec]; if (!s || typeof s !== 'object') continue;
    out[sec] = {};
    for (const [k, v] of Object.entries(s)) if (!NEVER.has(`${sec}.${k}`) && (!SITE_ONLY[sec] || SITE_ONLY[sec].includes(k))) out[sec][k] = structuredClone(v);
  }
  return out;
}

/* ------------------------------------------------------------------ profile themes */
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const UPLOAD = /^\/uploads\/([A-Za-z0-9_][A-Za-z0-9_.-]{0,119})$/;
/** A profile theme is your profile style (`sanitizeProfileStyle`: it holds the card's picture or GIF) plus, when it has one, your banner: { image (a picture or GIF of this server's), color, color2 }. */
function sanitizeBanner(b) {
  if (!isObj(b)) return null;
  const hex = (v) => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : null);
  const out = { image: typeof b.image === 'string' && UPLOAD.test(b.image) ? b.image : null, color: hex(b.color), color2: hex(b.color2) };
  return out.image || out.color || out.color2 ? out : null;
}
/** A clean profile theme from anything: the profile style, and the banner if it has one. Null when nothing usable is in it. */
export function sanitizeProfileTheme(data) {
  const style = sanitizeProfileStyle(data); const banner = sanitizeBanner(data?.banner);
  return style || banner ? { ...(style || {}), ...(banner ? { banner } : {}) } : null;
}
/** The profile theme a profile makes: its style, its banner picture (or GIF) and the banner's colours (the account's `profile`, `banner`, `bannerColor` and `accentColor`). */
export const profileLookOf = ({ profile, banner, bannerColor, accentColor } = {}) => sanitizeProfileTheme({ ...(profile || {}), banner: { image: banner || null, color: bannerColor || null, color2: accentColor || null } });

/* ------------------------------------------------------------------ any theme */
/** A clean theme of `kind` ('site' or 'profile'), or null when nothing usable is in it. */
export const sanitizeTheme = (kind, data) => (kind === 'site' ? sanitizeSiteLook(data) : kind === 'profile' ? sanitizeProfileTheme(data) : null);
/** A theme's name: one line, at most THEME_NAME_MAX characters ('' when there is none). */
export const cleanThemeName = (name) => String(name ?? '').replace(/[\u0000-\u001f\u007f<>]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, THEME_NAME_MAX);

/** Where a theme keeps pictures of this server's: a site theme's wallpaper; a profile theme's card picture and banner. [{ get, set }] on the (cloned) data. */
function pictureSlots(kind, data) {
  if (kind === 'site') return isObj(data?.bg) ? [{ get: () => data.bg.image, set: (v) => { data.bg.image = v; } }] : [];
  const slots = [];
  if (isObj(data?.colors)) slots.push({ get: () => data.colors.image, set: (v) => { data.colors.image = v; } });
  if (isObj(data?.banner)) slots.push({ get: () => data.banner.image, set: (v) => { data.banner.image = v; } });
  return slots;
}
/** The file names (in /uploads) a theme's pictures are. */
export const themeFiles = (kind, data) => pictureSlots(kind, data).map((s) => UPLOAD.exec(String(s.get() ?? ''))?.[1]).filter(Boolean);
/** A copy of a theme with each of its /uploads pictures run through `fn(fileName)` (which gives the new file name). */
export async function mapThemeFiles(kind, data, fn) {
  const copy = structuredClone(data);
  for (const slot of pictureSlots(kind, copy)) { const name = UPLOAD.exec(String(slot.get() ?? ''))?.[1]; if (name) slot.set(`/uploads/${await fn(name)}`); }
  return copy;
}
