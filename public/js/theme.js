// Orate — theme engine: turns settings into CSS variables, wallpaper layers, fonts, glass and rain.
import { state, subscribe, toast } from '/js/store.js';
import { hexToRgb, luminance, mixHex, readableOn, ls } from '/js/lib.js';
import { MESH_WALLPAPERS, PHOTO_WALLPAPERS } from '/js/defaults.js';
import { rain } from '/js/rain.js';
import { glass } from '/js/glass.js';

const root = document.documentElement;
const $ = (s) => document.querySelector(s);

/* ------------------------------------------------------------------ fonts */
const loadedFonts = new Set();
export const SYSTEM_FONTS = { 'System UI': 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' };
export function fontUrl(family, { weights = '400,500,600,700', text = null } = {}) {
  const fam = encodeURIComponent(family).replace(/%20/g, '+');
  return `https://fonts.googleapis.com/css?family=${fam}${text ? '' : ':' + weights}${text ? '&text=' + encodeURIComponent(text) : ''}&display=swap`;
}
export function loadFont(family) {
  if (!family || SYSTEM_FONTS[family] || loadedFonts.has(family)) return;
  loadedFonts.add(family);
  const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = fontUrl(family); l.dataset.font = family;
  l.onerror = () => loadedFonts.delete(family);
  document.head.appendChild(l);
}
const stack = (family, kind) => {
  if (!family) return null;
  if (SYSTEM_FONTS[family]) return SYSTEM_FONTS[family];
  const fall = kind === 'code' ? 'ui-monospace, "Cascadia Code", Consolas, monospace' : 'system-ui, "Segoe UI", sans-serif';
  return `"${family}", ${fall}`;
};

/* ------------------------------------------------------------------ wallpapers */
export const proxied = (url) => (/^https?:\/\//i.test(url) && !url.startsWith(location.origin) ? `/api/img?url=${encodeURIComponent(url)}` : url);
export function meshCss(def) {
  const layers = def.blobs.map(([x, y, r, c]) => `radial-gradient(${r * 1.25}% ${r * 1.25}% at ${x}% ${y}%, ${c} 0%, ${c}00 100%)`);
  return `${layers.join(',')}, ${def.base}`;
}
export function drawMesh(ctx, w, h, def) {
  ctx.fillStyle = def.base; ctx.fillRect(0, 0, w, h);
  for (const [x, y, r, c] of def.blobs) {
    const rad = (r / 100) * Math.max(w, h) * 1.25; const cx = (x / 100) * w; const cy = (y / 100) * h;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad); g.addColorStop(0, c); g.addColorStop(1, c + '00');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  }
}
export function wallpaperSource(bg = state.settings.bg) {
  switch (bg.type) {
    case 'mesh': { const def = MESH_WALLPAPERS.find((m) => m.id === bg.mesh) || MESH_WALLPAPERS[0]; return { kind: 'mesh', def, css: meshCss(def), key: 'mesh:' + def.id }; }
    case 'photo': { const p = PHOTO_WALLPAPERS.find((x) => x.id === bg.photo) || PHOTO_WALLPAPERS[0]; return { kind: 'image', url: proxied(p.url), key: 'img:' + p.url }; }
    case 'image': return bg.image ? { kind: 'image', url: proxied(bg.image), key: 'img:' + bg.image } : { kind: 'solid', css: bg.color, color: bg.color, key: 'solid' };
    case 'gradient': { const g = bg.gradient; return { kind: 'gradient', g, css: `linear-gradient(${g.angle}deg, ${g.c1}, ${g.c2})`, key: `grad:${g.c1}${g.c2}${g.angle}` }; }
    default: return { kind: 'solid', css: bg.color, color: bg.color, key: 'solid:' + bg.color };
  }
}

const layers = () => [$('.wp-a'), $('.wp-b')];
let activeLayer = 1; let lastBgKey = ''; let loadToken = 0; let currentImg = null;
function savePreview(key, im) {
  try { const c = document.createElement('canvas'); c.width = 32; c.height = 18; c.getContext('2d').drawImage(im, 0, 0, 32, 18); localStorage.setItem('orate:wpPreview', JSON.stringify({ key, url: c.toDataURL('image/jpeg', 0.7) })); } catch { /* tainted or storage full */ }
}
function bootPreview() {
  try {
    const p = JSON.parse(localStorage.getItem('orate:wpPreview') || 'null'); const src = wallpaperSource(state.settings.bg);
    if (p && src.kind === 'image' && p.key === src.key) { const b = layers()[1]; b.style.backgroundImage = `url("${p.url}")`; b.classList.add('on'); }
  } catch { /* ignore */ }
}

function applyWallpaper(s) {
  const src = wallpaperSource(s.bg);
  const sigImg = src.key;
  const [a, b] = layers();
  const bgFilter = `blur(${s.bg.blur}px) brightness(${s.bg.brightness}) saturate(${s.bg.saturate})`;
  const light = isLightMode();
  root.style.setProperty('--wp-filter', bgFilter);
  root.style.setProperty('--wp-dim', String(s.bg.dim));
  root.style.setProperty('--wp-dim-rgb', light ? '255,255,255' : '0,0,0');
  root.style.setProperty('--wp-pos', `${s.bg.posX}% ${s.bg.posY}%`);
  root.style.setProperty('--wp-zoom', String(s.bg.zoom));
  const wp = $('#wallpaper'); wp.dataset.parallax = s.bg.parallax && !s.motion.reduce ? '1' : '0';
  $('.wp-base').style.background = s.bg.type === 'solid' ? s.bg.color : '#07060d';

  if (sigImg !== lastBgKey) {
    lastBgKey = sigImg; const token = ++loadToken; currentImg = null; wp.classList.remove('rain-fallback');
    const show = (css, isImg) => {
      activeLayer = 1 - activeLayer; const target = layers()[activeLayer]; const other = layers()[1 - activeLayer];
      if (isImg) { target.style.background = ''; target.style.backgroundImage = `url("${css}")`; } else { target.style.backgroundImage = ''; target.style.background = css; }
      target.classList.add('on'); other.classList.remove('on');
    };
    if (src.kind === 'image') {
      const loadImg = (url, cors, ok, bad) => { const im = new Image(); if (cors) im.crossOrigin = 'anonymous'; im.onload = () => ok(im); im.onerror = bad; im.src = url; };
      const publish = (im, cssUrl) => { if (token !== loadToken) return; currentImg = im; show(cssUrl, true); syncRain(); savePreview(src.key, im); };
      loadImg(src.url, true, (img) => {
        if (token !== loadToken) return;
        // huge originals are downscaled once so the compositor/GPU holds a screen-sized texture, not a 7000px bitmap
        if (img.naturalWidth > 2600) {
          const w = 2560; const h = Math.round((img.naturalHeight / img.naturalWidth) * w); const c = document.createElement('canvas'); c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          c.toBlob((blob) => { if (!blob || token !== loadToken) return; const u = URL.createObjectURL(blob); loadImg(u, false, (small) => publish(small, u), () => publish(img, src.url)); }, 'image/jpeg', 0.88);
        } else publish(img, src.url);
      }, () => {
        if (token !== loadToken) return;
        // the proxy can't reach some hosts (bot protection) — show the original directly; WebGL effects need CORS so rain is skipped
        const direct = src.url.startsWith('/api/img?url=') ? decodeURIComponent(src.url.slice('/api/img?url='.length)) : null;
        if (direct) loadImg(direct, false, (img) => { if (token !== loadToken) return; currentImg = null; show(direct, true); $('#wallpaper').classList.add('rain-fallback'); if (state.settings.rain.enabled) toast('This wallpaper’s host blocks WebGL access, so the rain effect can’t use it. Pick another wallpaper for rain.', 'info', 6000); void img; }, () => { show(meshCss(MESH_WALLPAPERS[0]), false); syncRain(); });
        else { show(meshCss(MESH_WALLPAPERS[0]), false); syncRain(); }
      });
    } else if (src.kind === 'solid') { const t = layers()[1 - activeLayer]; activeLayer = 1 - activeLayer; t.style.backgroundImage = 'none'; t.style.backgroundColor = src.css; t.classList.add('on'); layers()[1 - activeLayer].classList.remove('on'); syncRain(); }
    else { show(src.css, false); syncRain(); }
  }
  void a; void b;
}

function sourceFor(src) {
  if (src.kind === 'image') return currentImg ? { type: 'image', img: currentImg } : null;
  return { type: 'draw', draw: (ctx, w, h) => {
    if (src.kind === 'mesh') drawMesh(ctx, w, h, src.def);
    else if (src.kind === 'gradient') { const g = ctx.createLinearGradient(0, 0, w, h); g.addColorStop(0, src.g.c1); g.addColorStop(1, src.g.c2); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); }
    else { ctx.fillStyle = src.color || '#0b0a14'; ctx.fillRect(0, 0, w, h); }
  } };
}

/** Feeds the liquid-glass lenses the same wallpaper the user sees (they refract it). */
let glassSig = '';
function syncGlass() {
  const s = state.settings; const src = wallpaperSource(s.bg); const source = sourceFor(src);
  if (!source) return;
  const light = isLightMode();
  const sig = JSON.stringify([src.key, !!currentImg, s.bg.brightness, s.bg.saturate, s.bg.posX, s.bg.posY, s.bg.zoom, s.bg.dim, s.theme.panelColor, light]);
  if (sig === glassSig) return; glassSig = sig;
  glass.setWallpaper(source, s.bg, s.theme.panelColor, light ? [1, 1, 1, s.bg.dim] : [0, 0, 0, s.bg.dim]);
}

let rainSig = '';
function syncRain() {
  const s = state.settings; const src = wallpaperSource(s.bg);
  const wp = $('#wallpaper');
  const on = s.rain.enabled && !s.motion.reduce;
  wp.classList.toggle('rain-on', on);
  syncGlass();
  if (on && src.kind === 'image' && !currentImg) { rain.stop(); rainSig = ''; return; }   // wait for the wallpaper to finish loading
  const sig = JSON.stringify([on, src.key, !!currentImg, s.rain, s.bg.blur, s.bg.brightness, s.bg.saturate, s.bg.posX, s.bg.posY, s.bg.zoom]);
  if (sig === rainSig) return; rainSig = sig;
  if (!on) { rain.stop(); return; }
  rain.start({ key: src.key, settings: s.rain, bg: s.bg, reduce: s.motion.reduce, source: sourceFor(src) });
}

/* ------------------------------------------------------------------ colours */
function isLightMode() {
  const t = state.settings.theme;
  let mode = t.mode; if (mode === 'auto') mode = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  const panelLum = luminance(t.panelColor);
  if (mode !== 'light' && panelLum > 0.62 && t.panelOpacity > 0.4) return true;
  if (mode === 'light' && panelLum < 0.12 && t.panelOpacity > 0.4) return false;
  return mode === 'light';
}
function applyColors(s) {
  const t = s.theme; const light = isLightMode();
  root.dataset.mode = light ? 'light' : 'dark';
  const [r, g, b] = hexToRgb(t.panelColor);
  root.style.setProperty('--panel-rgb', `${r} ${g} ${b}`);
  const a = t.panelOpacity;
  if (t.panelType === 'gradient') {
    const [r2, g2, b2] = hexToRgb(t.panelColor2);
    root.style.setProperty('--panel-bg', `linear-gradient(${t.panelAngle}deg, rgb(${r} ${g} ${b} / ${a}), rgb(${r2} ${g2} ${b2} / ${a}))`);
  } else root.style.setProperty('--panel-bg', `rgb(${r} ${g} ${b} / ${a})`);
  // slightly different tint for nested surfaces
  root.style.setProperty('--surface-rgb', light ? '0 0 0' : '255 255 255');
  const text = t.textColor || (light ? '#1a1530' : '#f4f2ff');
  root.style.setProperty('--text', text);
  const [tr, tg, tb] = hexToRgb(text);
  root.style.setProperty('--text-rgb', `${tr} ${tg} ${tb}`);
  // accent
  const solid = t.accentType === 'solid';
  const a1 = t.accent; const a2 = solid ? t.accent : t.accent2;
  root.style.setProperty('--accent', a1); root.style.setProperty('--accent-2', a2);
  root.style.setProperty('--accent-grad', solid ? a1 : `linear-gradient(135deg, ${a1}, ${a2})`);
  root.style.setProperty('--accent-rgb', hexToRgb(a1).join(' '));
  root.style.setProperty('--on-accent', readableOn(mixHex(a1, a2, 0.5)));
  root.style.setProperty('--accent-soft', `rgb(${hexToRgb(a1).join(' ')} / .18)`);
  root.style.setProperty('--link', light ? mixHex(a1, '#000000', 0.25) : mixHex(a1, '#ffffff', 0.45));
  root.style.setProperty('--radius', t.radius + 'px');
  root.style.setProperty('--radius-lg', Math.round(t.radius * 1.25) + 'px');
  root.style.setProperty('--radius-sm', Math.max(4, Math.round(t.radius * 0.55)) + 'px');
  root.style.setProperty('--gap', t.gap + 'px');
  // the rain lives on the wallpaper layer behind the panels, so frosted glass would smear the drops: keep it light while it rains
  const raining = s.rain.enabled && !s.motion.reduce;
  root.style.setProperty('--panel-blur', (raining ? Math.min(t.panelBlur, 3) : t.panelBlur) + 'px');
  root.style.setProperty('--panel-sat', String(t.saturation));
  root.style.setProperty('--meta-color', t.panelColor);
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', t.panelColor);
}

function applyFonts(s) {
  const f = s.fonts;
  for (const fam of [f.ui, f.chat, f.code]) loadFont(fam);
  root.style.setProperty('--font-ui', stack(f.ui, 'ui') || SYSTEM_FONTS['System UI']);
  root.style.setProperty('--font-chat', stack(f.chat || f.ui, 'ui') || SYSTEM_FONTS['System UI']);
  root.style.setProperty('--font-code', stack(f.code, 'code') || 'ui-monospace, Consolas, monospace');
  root.style.setProperty('--font-size', f.size + 'px');
  root.style.setProperty('--font-weight', String(f.weight));
  root.style.setProperty('--line-height', String(f.lineHeight));
  root.style.setProperty('--letter-spacing', (f.letterSpacing || 0) + 'em');
}

function applyMisc(s) {
  root.dataset.motion = s.motion.reduce ? 'reduce' : 'full';
  root.style.setProperty('--m', String(s.motion.reduce ? 0.01 : 1 / Math.max(0.25, s.motion.speed)));
  root.dataset.contrast = s.access.highContrast ? 'high' : 'normal';
  root.dataset.links = s.access.underlineLinks ? 'underline' : '';
  root.dataset.density = s.chat.compact ? 'compact' : 'cozy';
  root.style.setProperty('--msg-gap', s.chat.spacing + 'px');
  root.lang = s.lang || 'en';
  glass.apply(s.glass, s.motion.reduce);
}

/* ------------------------------------------------------------------ main */
let last = null; let raf = 0;
export function applyTheme(force) {
  const s = state.settings;
  if (!force && s === last) return;
  const prev = last; last = s;
  applyColors(s);
  if (!prev || prev.fonts !== s.fonts) applyFonts(s);
  if (!prev || prev.bg !== s.bg || prev.theme !== s.theme || prev.motion !== s.motion) applyWallpaper(s);
  applyMisc(s);
  if (prev && (prev.rain !== s.rain || prev.bg !== s.bg || prev.motion !== s.motion)) syncRain();
  else if (prev && prev.theme !== s.theme) syncGlass();
}
export function initTheme() {
  bootPreview();
  applyTheme(true);
  subscribe(() => { if (state.settings !== last) { clearTimeout(raf); raf = setTimeout(() => applyTheme(), 12); } });
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (state.settings.theme.mode === 'auto') applyTheme(true); });
  // gentle parallax on the wallpaper
  let tx = 0; let ty = 0; let cx = 0; let cy = 0; let running = false;
  const tick = () => {
    cx += (tx - cx) * 0.06; cy += (ty - cy) * 0.06;
    root.style.setProperty('--px', cx.toFixed(2) + 'px'); root.style.setProperty('--py', cy.toFixed(2) + 'px');
    if (Math.abs(tx - cx) > 0.05 || Math.abs(ty - cy) > 0.05) requestAnimationFrame(tick); else running = false;
  };
  window.addEventListener('pointermove', (e) => {
    if ($('#wallpaper').dataset.parallax !== '1') return;
    tx = -((e.clientX / innerWidth) - 0.5) * 22; ty = -((e.clientY / innerHeight) - 0.5) * 14;
    if (!running) { running = true; requestAnimationFrame(tick); }
  }, { passive: true });
  void ls;
}
