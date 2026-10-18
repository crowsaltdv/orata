// Orate — default settings and built-in presets (wallpapers, colour palettes).

export const PHOTO_WALLPAPERS = [
  { id: 'photo-1', name: 'Misty Dawn', url: 'https://t4.ftcdn.net/jpg/12/93/55/89/360_F_1293558974_ILjrwntCvlZe1rWFZvbIpnb69nvrgBS9.jpg' },
  { id: 'photo-2', name: 'Mirror Lake', url: 'https://images.unsplash.com/photo-1580137189272-c9379f8864fd?q=80&w=1740&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=NHwxMjA3fDA%3D' },
  { id: 'photo-3', name: 'Snow Peaks', url: 'https://images.pexels.com/photos/32574837/pexels-photo-32574837.jpeg?cs=srgb&dl=pexels-raulling-32574837.jpg&fm=jpg', local: '/img/wallpapers/snow-peaks.jpg' },   // the default theme's wallpaper ships with Orate (1920px copy) so the login screen shows it instantly
  { id: 'photo-4', name: 'Starry Pines', url: 'https://wallpapercave.com/wp/wp3946493.jpg' },
  { id: 'photo-5', name: 'Durdle Door', url: 'https://c4.wallpaperflare.com/wallpaper/149/190/473/nature-4k-computer-desktop-backgrounds-wallpaper-preview.jpg' },
  { id: 'photo-6', name: 'Turquoise Lake', url: 'https://i.pinimg.com/736x/8a/80/99/8a8099c1b53399dc2f22bc0ce3f940e4.jpg' },
];

// Offline-safe "mesh" wallpapers: a base colour plus soft radial blobs (x%, y%, radius%, colour).
export const MESH_WALLPAPERS = [
  { id: 'aurora', name: 'Aurora', base: '#0b0a1a', blobs: [[18, 12, 55, '#7c3aed'], [85, 20, 50, '#ec4899'], [60, 95, 60, '#0ea5e9'], [5, 90, 45, '#10b981']] },
  { id: 'sunset', name: 'Sunset', base: '#1a0b1f', blobs: [[80, 10, 55, '#f97316'], [15, 25, 50, '#e11d48'], [50, 100, 70, '#6d28d9'], [95, 85, 40, '#facc15']] },
  { id: 'ocean', name: 'Deep Ocean', base: '#04121f', blobs: [[20, 15, 60, '#0369a1'], [90, 40, 50, '#0d9488'], [40, 100, 60, '#1d4ed8'], [100, 0, 30, '#22d3ee']] },
  { id: 'nebula', name: 'Nebula', base: '#0a0614', blobs: [[30, 30, 50, '#9333ea'], [75, 70, 55, '#db2777'], [10, 85, 45, '#2563eb'], [90, 5, 35, '#a78bfa']] },
  { id: 'forest', name: 'Forest', base: '#06120c', blobs: [[15, 20, 55, '#15803d'], [85, 35, 45, '#0f766e'], [55, 100, 60, '#65a30d'], [100, 100, 40, '#064e3b']] },
  { id: 'rose', name: 'Rosé', base: '#1c0a14', blobs: [[25, 15, 55, '#f472b6'], [85, 50, 50, '#be185d'], [40, 100, 55, '#fb7185'], [0, 70, 35, '#fda4af']] },
  { id: 'graphite', name: 'Graphite', base: '#0c0d10', blobs: [[20, 10, 50, '#334155'], [90, 60, 55, '#1e293b'], [50, 105, 60, '#475569']] },
  { id: 'ember', name: 'Ember', base: '#140703', blobs: [[75, 15, 55, '#dc2626'], [20, 80, 55, '#ea580c'], [60, 60, 40, '#7c2d12'], [5, 5, 30, '#f59e0b']] },
];

export const ACCENT_PRESETS = [
  ['#8b5cf6', '#ec4899'], ['#6366f1', '#06b6d4'], ['#f97316', '#ec4899'], ['#10b981', '#06b6d4'],
  ['#3b82f6', '#8b5cf6'], ['#ef4444', '#f97316'], ['#eab308', '#f97316'], ['#ec4899', '#f43f5e'],
  ['#14b8a6', '#84cc16'], ['#a855f7', '#6366f1'], ['#0ea5e9', '#22d3ee'], ['#64748b', '#94a3b8'],
];
export const PANEL_PRESETS = [
  ['#15121f', 'Violet Night'], ['#0b0b10', 'Obsidian'], ['#101826', 'Navy'], ['#14201a', 'Pine'], ['#241420', 'Plum'],
  ['#1f1a14', 'Mocha'], ['#ffffff', 'Snow'], ['#f3ecff', 'Lavender'], ['#e8f4ff', 'Sky'], ['#fff1f2', 'Blush'],
];

export const SETTINGS_VERSION = 5;
export const DEFAULT_SETTINGS = {
  v: SETTINGS_VERSION,
  theme: {
    mode: 'dark', accentType: 'gradient', accent: '#64748b', accent2: '#94a3b8',
    panelType: 'solid', panelColor: '#0b0b10', panelColor2: '#241238', panelAngle: 160, panelOpacity: 0.58, panelBlur: 17,
    radius: 18, gap: 10, textColor: null, saturation: 1.15,
  },
  bg: {
    type: 'photo', mesh: 'sunset', image: null, photo: 'photo-3', color: '#0b0a14', gradient: { c1: '#1e1b4b', c2: '#7c3aed', angle: 135 },
    blur: 0, dim: 0.22, brightness: 1, saturate: 1.1, posX: 50, posY: 50, zoom: 1, parallax: true, library: [],
  },
  rain: { enabled: true, preset: 'rain', amount: 0.7, size: 0.88, speed: 1, refraction: 1, mist: 3, trails: 1, droplets: 50, lightning: 0, fps: 60 },
  glass: { style: 'off', last: 'liquid', intensity: 1, rail: true, nav: true, toolbar: true, buttons: true, composer: true, panels: true },
  fx: { particles: true, ripples: true, amount: 1 },
  fonts: { ui: 'Montserrat', chat: null, code: 'JetBrains Mono', size: 16, weight: 400, lineHeight: 1.45, letterSpacing: 0 },
  motion: { reduce: typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches, speed: 1, parallaxHover: true },
  chat: { compact: true, hour24: false, linkPreviews: true, inlineMedia: true, jumbo: true, showAvatars: true, spacing: 16, gifAutoplay: true, spoilerOnHover: false },
  notif: { desktop: true, sounds: true, volume: 0.5, mentionsOnly: false, flash: true },
  lang: 'en',
  privacy: { dmFromServers: true, friendRequests: true, showActivity: true },
  access: { highContrast: false, underlineLinks: false, saturation: 1, tooltips: true },
  mutedServers: {}, mutedChannels: {}, serverOrder: [], serverFolders: [], collapsed: {}, lastChannel: {}, skinTone: 0,
  advanced: { devMode: false },
};

export const DEFAULT_LOCAL = {
  voice: {
    inputDevice: 'default', outputDevice: 'default', cameraDevice: 'default', inputVolume: 100, outputVolume: 100,
    noiseSuppression: true, echoCancellation: true, autoGain: true, sensitivity: 30, autoSensitivity: true,
    pushToTalk: false, pttKey: 'KeyV', videoQuality: '720', mirrorVideo: true, joinMuted: false,
  },
  panel: 'members', frequentEmoji: {}, sidebarW: 248,
};

/** Upgrades settings saved by older versions (new defaults for blur/panels, the rewritten rain, removed quests). */
export function migrateSettings(saved) {
  if (!saved || typeof saved !== 'object' || (saved.v || 0) >= SETTINGS_VERSION) return saved;
  const s = structuredClone(saved);
  if ((s.v || 0) < 2) {
    if (s.bg && s.bg.blur === 6) s.bg.blur = DEFAULT_SETTINGS.bg.blur;
    if (s.bg && s.bg.dim === 0.28) s.bg.dim = DEFAULT_SETTINGS.bg.dim;
    if (s.theme && s.theme.panelBlur === 26) s.theme.panelBlur = DEFAULT_SETTINGS.theme.panelBlur;
    if (s.theme && s.theme.panelOpacity === 0.58) s.theme.panelOpacity = DEFAULT_SETTINGS.theme.panelOpacity;
  }
  if ((s.v || 0) < 4) { delete s.rain; delete s.quests; delete s.shopEquipped; }   // v3/v4: rain is now the original Codrops effect with new options (lighter default mist)
  if ((s.v || 0) < 5) { delete s.quests; delete s.shopEquipped; if (s.glass) s.glass.style = 'off'; }   // v5: glass is opt-in (off by default) and now covers the whole UI
  s.v = SETTINGS_VERSION;
  return s;
}

export function deepMerge(base, over) {
  if (over == null || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(over)) {
    const b = base?.[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) && over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) ? deepMerge(b, over[k]) : over[k];
  }
  return out;
}

export const STATUS_META = {
  online: { label: 'Online', color: '#3ba55d' },
  idle: { label: 'Idle', color: '#f0b232' },
  dnd: { label: 'Do Not Disturb', color: '#f23f5d' },
  invisible: { label: 'Invisible', color: '#80848e' },
  offline: { label: 'Offline', color: '#80848e' },
};
