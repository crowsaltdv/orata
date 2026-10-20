// Orate — profile styling: every option you can pick, and the one function that checks them.
// The server runs sanitizeProfileStyle() on what it is sent and the browser runs it on what it receives, so both always agree.
// No browser or server APIs in here on purpose.

/** Fonts for names and text on a profile: [id, Google Fonts family, kind]. */
export const PROFILE_FONTS = [
  ['pacifico', 'Pacifico', 'script'], ['lobster', 'Lobster', 'script'], ['dancing', 'Dancing Script', 'script'], ['satisfy', 'Satisfy', 'script'], ['caveat', 'Caveat', 'hand'], ['marker', 'Permanent Marker', 'hand'],
  ['bangers', 'Bangers', 'display'], ['righteous', 'Righteous', 'display'], ['bebas', 'Bebas Neue', 'display'], ['abril', 'Abril Fatface', 'display'], ['fredoka', 'Fredoka', 'display'], ['creepster', 'Creepster', 'display'],
  ['orbitron', 'Orbitron', 'tech'], ['audiowide', 'Audiowide', 'tech'], ['pressstart', 'Press Start 2P', 'tech'], ['monoton', 'Monoton', 'tech'], ['specialelite', 'Special Elite', 'tech'],
  ['cinzel', 'Cinzel', 'serif'], ['playfair', 'Playfair Display', 'serif'], ['lora', 'Lora', 'serif'], ['merriweather', 'Merriweather', 'serif'], ['nunito', 'Nunito', 'clean'], ['poppins', 'Poppins', 'clean'], ['jetbrains', 'JetBrains Mono', 'mono'],
  ['unbounded', 'Unbounded', 'display'], ['chewy', 'Chewy', 'display'], ['rubikglitch', 'Rubik Glitch', 'tech'], ['shadows', 'Shadows Into Light', 'hand'],
];
export const fontFamily = (id) => PROFILE_FONTS.find((f) => f[0] === id)?.[1] || null;

/** Animated effects drawn over a profile card: [id, name]. Each id has an engine in profile-effects.js. */
export const EFFECTS = [
  ['rays', 'Solar rays'], ['ocean', 'Ocean'], ['ambient', 'Ambient lights'], ['aurora', 'Aurora'], ['sparkles', 'Sparkles'], ['glitter', 'Glitter'], ['stars', 'Stars'], ['starfield', 'Warp speed'], ['galaxy', 'Galaxy'],
  ['meteors', 'Shooting stars'], ['snow', 'Snow'], ['rain', 'Rain'], ['lightning', 'Lightning'], ['clouds', 'Clouds'], ['fog', 'Mist'], ['embers', 'Embers'], ['fire', 'Fire'], ['smoke', 'Smoke'],
  ['hearts', 'Hearts'], ['bubbles', 'Bubbles'], ['bokeh', 'Bokeh'], ['lava', 'Lava lamp'], ['confetti', 'Confetti'], ['fireworks', 'Fireworks'], ['fireflies', 'Fireflies'], ['butterflies', 'Butterflies'],
  ['petals', 'Petals'], ['leaves', 'Autumn leaves'], ['lanterns', 'Lanterns'], ['balloons', 'Balloons'], ['ripples', 'Ripples'], ['caustics', 'Underwater'], ['disco', 'Disco'], ['spotlight', 'Spotlights'],
  ['vaporwave', 'Vaporwave'], ['equalizer', 'Equalizer'], ['plasma', 'Plasma'], ['scanlines', 'Retro CRT'], ['matrix', 'Matrix'], ['pixels', 'Pixels'], ['dust', 'Dust motes'],
];
/** A good-looking starting palette for each effect: [color, second color]. Used for the previews and when an effect is first picked. */
const EFFECT_COLORS = {
  rays: ['#ffd966', '#ff9f43'], ocean: ['#1e90ff', '#00e5ff'], ambient: ['#a78bfa', '#38bdf8'], aurora: ['#34d399', '#a78bfa'], sparkles: ['#ffffff', '#ffe9a8'], glitter: ['#f9a8d4', '#fde68a'], stars: ['#fde68a', '#ffffff'],
  starfield: ['#ffffff', '#93c5fd'], galaxy: ['#a78bfa', '#f472b6'], meteors: ['#ffffff', '#93c5fd'], snow: ['#ffffff', '#bfdbfe'], rain: ['#60a5fa', '#93c5fd'], lightning: ['#c4b5fd', '#ffffff'], clouds: ['#ffffff', '#bfdbfe'],
  fog: ['#94a3b8', '#cbd5e1'], embers: ['#ff7a1a', '#ffb703'], fire: ['#ff5a1f', '#ffb703'], smoke: ['#9ca3af', '#d1d5db'], hearts: ['#f43f5e', '#fb7185'], bubbles: ['#7dd3fc', '#a5f3fc'], bokeh: ['#fcd34d', '#f9a8d4'],
  lava: ['#ff4d6d', '#ff9f1c'], confetti: ['#f43f5e', '#facc15'], fireworks: ['#ff6b6b', '#ffd93d'], fireflies: ['#d9f99d', '#fde047'], butterflies: ['#f472b6', '#60a5fa'], petals: ['#f9a8d4', '#fbcfe8'], leaves: ['#f97316', '#b45309'],
  lanterns: ['#ffb347', '#ff7f50'], balloons: ['#f43f5e', '#3b82f6'], ripples: ['#7dd3fc', '#ffffff'], caustics: ['#38bdf8', '#a7f3d0'], disco: ['#f472b6', '#60a5fa'], spotlight: ['#fde68a', '#ffffff'], vaporwave: ['#ff71ce', '#01cdfe'],
  equalizer: ['#22d3ee', '#a78bfa'], plasma: ['#6d28d9', '#ec4899'], scanlines: ['#22c55e', '#a7f3d0'], matrix: ['#22c55e', '#86efac'], pixels: ['#60a5fa', '#f472b6'], dust: ['#fde68a', '#ffffff'],
};
export const effectColors = (id) => { const [color, color2] = EFFECT_COLORS[id] || ['#ffffff', null]; return { color, color2 }; };
export const OUTLINE_STYLES = ['solid', 'dashed', 'dotted', 'double'];

const HEX = /^#[0-9a-f]{6}$/i;
const UPLOAD = /^\/uploads\/[A-Za-z0-9_.-]{1,120}$/;   // a card picture is always one of this server's own uploads: a link to anywhere else would let its owner watch who opens the profile
const hex = (v, fallback = null) => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : fallback);
const num = (v, lo, hi, fallback) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n * 100) / 100)) : fallback; };
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const oneOf = (list, v) => (list.some((x) => (Array.isArray(x) ? x[0] : x) === v) ? v : null);

/** What a new section starts with in the editor. */
export const PROFILE_DEFAULTS = {
  colors: { mode: 'gradient', a: '#8b5cf6', b: '#ec4899', angle: 150, tint: 0.35, image: null, imageOpacity: 0.6 },
  outline: { color: '#8b5cf6', color2: null, width: 2, style: 'solid' },
  shadow: { color: '#8b5cf6', blur: 30, spread: 0, x: 0, y: 8, alpha: 0.55 },
  fonts: { name: null, text: null },
  nameColor: { mode: 'gradient', a: '#fde047', b: '#22c55e', angle: 90 },
  nameOutline: { mode: 'solid', a: '#14532d', b: '#052e16', angle: 90, width: 2 },
  nameShadow: { color: '#14532d', angle: 45, distance: 4, blur: 0 },   // 0° = to the right, 90° = down, so 45° falls to the bottom-right
  effect: { id: 'sparkles', color: '#ffffff', color2: null, density: 0.6, speed: 1, opacity: 1 },
};

const fill = (o, withWidth) => {
  if (!isObj(o) || !hex(o.a)) return null;
  const mode = o.mode === 'gradient' ? 'gradient' : 'solid';
  const out = { mode, a: hex(o.a), b: hex(o.b, hex(o.a)), angle: num(o.angle, 0, 360, 90) };
  if (withWidth) out.width = num(o.width, 1, 6, 2);
  if (o.rainbow === true) out.rainbow = true;
  return out;
};

/** Takes anything and returns a clean profile style (or null when nothing usable is left). Unknown or invalid parts are dropped, numbers are clamped. */
export function sanitizeProfileStyle(p) {
  if (!isObj(p)) return null;
  const out = {};
  const c = p.colors;
  if (isObj(c) && (c.mode === 'solid' || c.mode === 'gradient' || c.mode === 'image') && hex(c.a)) {
    const image = typeof c.image === 'string' && UPLOAD.test(c.image) ? c.image : null;
    out.colors = { mode: c.mode === 'image' && !image ? 'gradient' : c.mode, a: hex(c.a), b: hex(c.b, hex(c.a)), angle: num(c.angle, 0, 360, 150), tint: num(c.tint, 0.05, 1, 0.35) };
    if (image) { out.colors.image = image; out.colors.imageOpacity = num(c.imageOpacity, 0.05, 1, 0.6); }
    if (c.rainbow === true) out.colors.rainbow = true;
  }
  const o = p.outline;
  if (isObj(o) && hex(o.color)) {
    out.outline = { color: hex(o.color), color2: hex(o.color2), width: num(o.width, 1, 8, 2), style: oneOf(OUTLINE_STYLES, o.style) || 'solid' };
    if (o.rainbow === true) out.outline.rainbow = true;
  }
  const s = p.shadow;
  if (isObj(s) && hex(s.color)) {
    out.shadow = { color: hex(s.color), blur: num(s.blur, 0, 80, 30), spread: num(s.spread, 0, 30, 0), x: num(s.x, -40, 40, 0), y: num(s.y, -40, 40, 8), alpha: num(s.alpha, 0.05, 1, 0.55) };
    if (s.rainbow === true) out.shadow.rainbow = true;
  }
  const f = p.fonts;
  if (isObj(f)) {
    const fonts = { name: oneOf(PROFILE_FONTS, f.name), text: oneOf(PROFILE_FONTS, f.text) };
    if (fonts.name || fonts.text) out.fonts = fonts;
  }
  const nc = fill(p.nameColor, false); if (nc) out.nameColor = nc;
  const no = fill(p.nameOutline, true); if (no) out.nameOutline = no;
  const ns = p.nameShadow;
  if (isObj(ns) && hex(ns.color)) out.nameShadow = { color: hex(ns.color), angle: num(ns.angle, 0, 360, 135), distance: num(ns.distance, 0, 24, 4), blur: num(ns.blur, 0, 30, 0) };
  if (out.nameShadow && ns.rainbow === true) out.nameShadow.rainbow = true;
  const e = p.effect;
  if (isObj(e) && oneOf(EFFECTS, e.id)) {
    out.effect = { id: e.id, color: hex(e.color, '#ffffff'), color2: hex(e.color2), density: num(e.density, 0.1, 1, 0.6), speed: num(e.speed, 0.3, 2.5, 1), opacity: num(e.opacity, 0.1, 1, 1) };
    if (e.rainbow === true) out.effect.rainbow = true;
  }
  return Object.keys(out).length ? out : null;
}
