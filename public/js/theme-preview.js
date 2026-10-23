// Orata — the preview picture of a theme, drawn right here in the browser from the theme itself (no screenshot service, nothing fetched from anywhere else).
// A site theme is a picture of Orata with the theme on: the wallpaper (blur, dim, rain), frosted / glass panels, the rail, channel list, a few messages and the
// message box, in the theme's colors and fonts. A profile theme is a profile card for a grayed-out "User", styled with the theme. The picture is uploaded when a
// theme is saved (themes.js) and is what Theme Discovery shows above the name.
import { loadFont, drawMesh } from '/js/theme.js';
import { MESH_WALLPAPERS, PHOTO_WALLPAPERS } from '/js/defaults.js';
import { hexToRgb, luminance } from '/js/lib.js';
import { fontFamily, sanitizeProfileStyle } from '/js/profile-data.js';
import { sanitizeSiteLook } from '/js/theme-data.js';

export const PREVIEW_W = 960; export const PREVIEW_H = 540;
const TAU = Math.PI * 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rgba = (hex, a) => { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; };
const num = (v, d) => (Number.isFinite(v) ? v : d);
/** The same "random" every time, so a theme always gets the same drops and sparkles. */
const seeded = (seed) => { let x = seed >>> 0 || 1; return () => { x = (x + 0x6D2B79F5) >>> 0; let t = x; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

function roundRect(c, x, y, w, h, r, begin = true) {
  const k = Math.max(0, Math.min(r, w / 2, h / 2));
  if (begin) c.beginPath();
  c.moveTo(x + k, y); c.arcTo(x + w, y, x + w, y + h, k); c.arcTo(x + w, y + h, x, y + h, k); c.arcTo(x, y + h, x, y, k); c.arcTo(x, y, x + w, y, k); c.closePath();
}
/** A CSS-style linear gradient (0° = up, 90° = right) across a box. */
function linear(c, x, y, w, h, angle, stops) {
  const a = (angle * Math.PI) / 180; const dx = Math.sin(a); const dy = -Math.cos(a); const len = Math.abs(w * dx) + Math.abs(h * dy);
  const cx = x + w / 2; const cy = y + h / 2; const g = c.createLinearGradient(cx - (dx * len) / 2, cy - (dy * len) / 2, cx + (dx * len) / 2, cy + (dy * len) / 2);
  stops.forEach((s, i) => g.addColorStop(stops.length === 1 ? 0 : i / (stops.length - 1), s));
  return g;
}
const RAINBOW = ['#ff4d6d', '#ffb703', '#5ee07a', '#3b9bff', '#b565ff'];

/* ------------------------------------------------------------------ loading */
function loadImage(url) {
  return new Promise((res) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => res(im); im.onerror = () => res(null); im.src = url; setTimeout(() => res(null), 8000); });
}
const linkOf = (family) => document.querySelector(`link[data-font="${family.replace(/"/g, '')}"]`);
/** Makes sure a Google font is ready to draw with (a few seconds at most: without it the preview just uses a similar system font). */
async function ensureFont(family, weights = [400]) {
  if (!family || family === 'System UI') return;
  loadFont(family);
  const link = linkOf(family);
  if (link && !link.sheet) await Promise.race([new Promise((res) => { link.addEventListener('load', res, { once: true }); link.addEventListener('error', res, { once: true }); }), sleep(3000)]);
  await Promise.race([Promise.all(weights.map((w) => document.fonts.load(`${w} 16px "${family}"`, 'Aa User'))), sleep(2500)]).catch(() => {});
}
const stack = (family, kind) => (family && family !== 'System UI' ? `"${family}", ${kind === 'code' ? 'ui-monospace, Consolas, monospace' : 'system-ui, "Segoe UI", sans-serif'}` : kind === 'code' ? 'ui-monospace, Consolas, monospace' : 'system-ui, "Segoe UI", sans-serif');
const toBlob = (canvas) => new Promise((res, rej) => { try { canvas.toBlob((b) => (b ? res(b) : rej(new Error('no picture'))), 'image/webp', 0.9); } catch (e) { rej(e); } });

/* ------------------------------------------------------------------ site themes */
const lightMode = (t) => {
  let mode = t.mode; if (mode === 'auto') mode = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  const lum = luminance(t.panelColor);
  if (mode !== 'light' && lum > 0.62 && t.panelOpacity > 0.4) return true;
  if (mode === 'light' && lum < 0.12 && t.panelOpacity > 0.4) return false;
  return mode === 'light';
};
/** The wallpaper layer as the app shows it (picture / gradient, blur, brightness, dim and rain), drawn at W × H. */
function wallpaperLayer(look, img, W, H, light) {
  const bg = look.bg; const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const c = cv.getContext('2d');
  const photoFilter = `blur(${bg.blur}px) brightness(${bg.brightness}) saturate(${bg.saturate})`;
  c.fillStyle = bg.type === 'solid' ? bg.color : '#07060d'; c.fillRect(0, 0, W, H);
  c.save(); c.filter = photoFilter;
  if (img) {
    const k = Math.max(W / img.width, H / img.height) * bg.zoom; const w = img.width * k; const h = img.height * k;
    c.drawImage(img, (W - w) * (bg.posX / 100), (H - h) * (bg.posY / 100), w, h);
  } else if (bg.type === 'mesh' || bg.type === 'photo' || bg.type === 'image') drawMesh(c, W, H, MESH_WALLPAPERS.find((m) => m.id === bg.mesh) || MESH_WALLPAPERS[0]);
  else if (bg.type === 'gradient') { c.fillStyle = linear(c, 0, 0, W, H, bg.gradient.angle, [bg.gradient.c1, bg.gradient.c2]); c.fillRect(0, 0, W, H); }
  else { c.fillStyle = bg.color; c.fillRect(0, 0, W, H); }
  c.restore();
  c.fillStyle = light ? `rgba(255,255,255,${bg.dim})` : `rgba(0,0,0,${bg.dim})`; c.fillRect(0, 0, W, H);
  if (look.rain.enabled) rainDrops(c, look.rain, W, H);
  return cv;
}
/** Rain on glass: a mist, wet trails and round drops that bend the light. */
function rainDrops(c, rain, W, H) {
  const r = seeded(7); const n = Math.round(14 + rain.amount * 90 + rain.droplets * 0.5);
  if (rain.mist > 0) { c.fillStyle = `rgba(255,255,255,${Math.min(0.22, rain.mist / 200)})`; c.fillRect(0, 0, W, H); }
  for (let i = 0; i < n; i++) {
    const big = r() < 0.18; const rad = (big ? 9 + r() * 12 : 2 + r() * 4.5) * rain.size; const x = r() * W; const y = r() * H;
    if (big && rain.trails > 0.2) { const len = (30 + r() * 90) * rain.trails; const g = c.createLinearGradient(x, y - len, x, y); g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(255,255,255,.16)'); c.fillStyle = g; c.fillRect(x - rad * 0.28, y - len, rad * 0.56, len); }
    const g = c.createRadialGradient(x - rad * 0.25, y - rad * 0.3, rad * 0.1, x, y, rad);
    g.addColorStop(0, 'rgba(255,255,255,.04)'); g.addColorStop(0.7, 'rgba(255,255,255,.10)'); g.addColorStop(1, `rgba(0,0,0,${0.22 * rain.refraction})`);
    c.fillStyle = g; c.beginPath(); c.ellipse(x, y, rad, rad * 1.12, 0, 0, TAU); c.fill();
    c.strokeStyle = `rgba(255,255,255,${0.32 * Math.min(1.3, rain.refraction)})`; c.lineWidth = 1; c.beginPath(); c.arc(x, y, rad * 0.98, Math.PI * 0.95, Math.PI * 1.55); c.stroke();
    c.fillStyle = 'rgba(255,255,255,.7)'; c.beginPath(); c.arc(x - rad * 0.38, y - rad * 0.45, Math.max(0.8, rad * 0.14), 0, TAU); c.fill();
  }
}

async function drawSite(c, look, images) {
  const t = look.theme; const light = lightMode(t); const S = 0.75;   // the picture is Orata at 1280 × 720, shown at 75%
  const W = 1280; const H = 720;
  const uiFam = look.fonts.ui; const chatFam = look.fonts.chat || look.fonts.ui; const codeFam = look.fonts.code;
  await Promise.all([ensureFont(uiFam, [look.fonts.weight, 700]), ensureFont(chatFam, [look.fonts.weight, 700]), ensureFont(codeFam, [400])]);
  const UI = stack(uiFam); const CHAT = stack(chatFam); const CODE = stack(codeFam, 'code');
  let img = null;
  if (images) {
    const url = look.bg.type === 'photo' ? (() => { const p = PHOTO_WALLPAPERS.find((x) => x.id === look.bg.photo) || PHOTO_WALLPAPERS[0]; return p.local || (/^https?:\/\//i.test(p.url) ? `/api/img?url=${encodeURIComponent(p.url)}` : p.url); })()
      : look.bg.type === 'image' && look.bg.image ? (/^https?:\/\//i.test(look.bg.image) ? `/api/img?url=${encodeURIComponent(look.bg.image)}` : look.bg.image) : null;
    if (url) img = await loadImage(url);
  }
  const wall = wallpaperLayer(look, img, W, H, light);
  const text = t.textColor || (light ? '#1a1530' : '#f4f2ff'); const t2 = rgba(text, 0.72); const t3 = rgba(text, 0.5);
  const a1 = t.accent; const a2 = t.accentType === 'solid' ? t.accent : t.accent2; const accent = (x, y, w, h) => linear(c, x, y, w, h, 135, [a1, a2]);
  const onAccent = luminance(a1) > 0.45 ? '#111' : '#fff';
  const [pr, pg, pb] = hexToRgb(t.panelColor); const [pr2, pg2, pb2] = hexToRgb(t.panelColor2);
  const blur = look.rain.enabled ? Math.min(t.panelBlur, 3) : t.panelBlur; const glassOn = look.glass.style !== 'off'; const gk = look.glass.intensity;
  const gap = Math.max(4, t.gap); const R = t.radius;
  const surface = light ? '0,0,0' : '255,255,255';

  c.save(); c.scale(S, S);
  c.drawImage(wall, 0, 0);

  const glassSheen = (x, y, w, h, r, k = 1) => {
    c.save(); roundRect(c, x, y, w, h, r); c.clip();
    c.fillStyle = linear(c, x, y, w, h, 135, [`rgba(255,255,255,${0.26 * gk * k})`, `rgba(255,255,255,${0.05 * gk * k})`, 'rgba(255,255,255,0)', `rgba(255,255,255,${0.1 * gk * k})`]); c.fillRect(x, y, w, h);
    c.restore();
    c.save(); roundRect(c, x + 0.75, y + 0.75, w - 1.5, h - 1.5, Math.max(0, r - 0.75)); c.strokeStyle = `rgba(255,255,255,${0.5 * gk * k})`; c.lineWidth = 1.5; c.stroke(); c.restore();
  };
  const panel = (x, y, w, h, glass) => {
    c.save(); roundRect(c, x, y, w, h, R); c.clip();
    c.filter = `blur(${blur}px) saturate(${t.saturation})`; c.drawImage(wall, 0, 0); c.filter = 'none';
    c.fillStyle = t.panelType === 'gradient' ? linear(c, x, y, w, h, t.panelAngle, [`rgba(${pr},${pg},${pb},${t.panelOpacity})`, `rgba(${pr2},${pg2},${pb2},${t.panelOpacity})`]) : `rgba(${pr},${pg},${pb},${t.panelOpacity})`;
    c.fillRect(x, y, w, h); c.restore();
    c.save(); roundRect(c, x + 0.5, y + 0.5, w - 1, h - 1, R); c.strokeStyle = `rgba(${surface},.12)`; c.lineWidth = 1; c.stroke(); c.restore();
    if (glassOn && glass) glassSheen(x, y, w, h, R);
  };
  const font = (weight, size, fam = UI) => { c.font = `${weight} ${size}px ${fam}`; };
  const spacing = look.fonts.letterSpacing; const tracked = (v) => { try { c.letterSpacing = `${v * 16}px`; } catch { /* older browsers: no letter spacing */ } };
  const words = (str, max) => { const out = []; let line = ''; for (const w of str.split(' ')) { const next = line ? `${line} ${w}` : w; if (c.measureText(next).width > max && line) { out.push(line); line = w; } else line = next; } if (line) out.push(line); return out; };

  // ---- panels
  const railW = 72; const sideW = 244;
  const rx = gap; const ry = gap; const rh = H - gap * 2;
  const sx = rx + railW + gap; const mx = sx + sideW + gap; const mw = W - mx - gap;
  panel(rx, ry, railW, rh, look.glass.panels);
  panel(sx, ry, sideW, rh, look.glass.panels);
  panel(mx, ry, mw, rh, look.glass.panels);

  // ---- rail
  const icon = (cx, cy, size, active, label, fill) => {
    const rad = active ? size * 0.32 : size / 2;
    roundRect(c, cx - size / 2, cy - size / 2, size, size, rad); c.fillStyle = active ? accent(cx - size / 2, cy - size / 2, size, size) : fill || `rgba(${surface},.12)`; c.fill();
    if (glassOn && look.glass.rail) glassSheen(cx - size / 2, cy - size / 2, size, size, rad, 0.8);
    if (label) { font(700, 17); tracked(0); c.fillStyle = active ? onAccent : text; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(label, cx, cy + 1); c.textAlign = 'left'; }
  };
  const cx0 = rx + railW / 2;
  icon(cx0, ry + 42, 48, false, '♪'); icon(cx0, ry + 100, 48, true, 'O');
  c.fillStyle = `rgba(${surface},.18)`; c.fillRect(cx0 - 16, ry + 140, 32, 2);
  [['G', '#4f46e5'], ['M', '#0d9488'], ['R', '#db2777']].forEach(([l, col], i) => icon(cx0, ry + 180 + i * 58, 48, false, l, rgba(col, 0.55)));
  icon(cx0, ry + 180 + 3 * 58, 48, false, '+', 'rgba(67,209,139,.22)');
  c.fillStyle = a1; roundRect(c, rx + 2, ry + 82, 5, 36, 3); c.fill();

  // ---- channel list
  font(700, 16); tracked(spacing); c.fillStyle = text; c.textBaseline = 'middle'; c.fillText('Orata Club', sx + 18, ry + 30);
  c.fillStyle = `rgba(${surface},.12)`; c.fillRect(sx, ry + 58, sideW, 1);
  const chan = (y, name, sel, unread) => {
    if (sel) { roundRect(c, sx + 10, y - 17, sideW - 20, 34, Math.max(6, R * 0.55)); c.fillStyle = `rgba(${hexToRgb(a1).join(',')},.22)`; c.fill(); }
    font(sel || unread ? 600 : 500, 15); tracked(spacing); c.fillStyle = sel ? text : unread ? t2 : t3; c.fillText(`#  ${name}`, sx + 24, y + 1);
  };
  font(700, 11); tracked(0.06); c.fillStyle = t3; c.fillText('TEXT CHANNELS', sx + 22, ry + 86);
  chan(ry + 116, 'general', true); chan(ry + 152, 'memes', false, true); chan(ry + 188, 'media', false); chan(ry + 224, 'showcase', false);
  font(700, 11); tracked(0.06); c.fillStyle = t3; c.fillText('VOICE', sx + 22, ry + 272);
  chan(ry + 302, 'lounge', false);
  const uy = ry + rh - 60; c.fillStyle = `rgba(${surface},.1)`; roundRect(c, sx + 10, uy, sideW - 20, 48, Math.max(8, R * 0.6)); c.fill();
  c.fillStyle = accent(sx + 18, uy + 7, 34, 34); c.beginPath(); c.arc(sx + 35, uy + 24, 17, 0, TAU); c.fill();
  font(700, 14); c.fillStyle = onAccent; c.textAlign = 'center'; c.fillText('Y', sx + 35, uy + 25); c.textAlign = 'left';
  font(600, 14); tracked(spacing); c.fillStyle = text; c.fillText('You', sx + 62, uy + 18); font(500, 12); c.fillStyle = t3; c.fillText('Online', sx + 62, uy + 34);
  c.fillStyle = '#3ba55d'; c.beginPath(); c.arc(sx + 48, uy + 36, 5, 0, TAU); c.fill();

  // ---- chat
  font(700, 17); tracked(spacing); c.fillStyle = text; c.fillText('#  general', mx + 24, ry + 30);
  font(500, 13); tracked(0); c.fillStyle = t3; c.fillText('Where the new look gets tested', mx + 128, ry + 31);
  c.fillStyle = `rgba(${surface},.12)`; c.fillRect(mx, ry + 58, mw, 1);
  const cs = look.fonts.size; const lh = Math.round(cs * look.fonts.lineHeight); const compact = look.chat.compact; const avatars = look.chat.showAvatars; const groupGap = look.chat.spacing + (compact ? 4 : 12);
  const left = mx + 24; const textX = left + (avatars ? 54 : 0); const maxW = mw - 48 - (avatars ? 54 : 0);
  let y = ry + 84;
  const message = (name, time, lines, hue, extra) => {
    const top = y;
    if (avatars) { c.fillStyle = hue; c.beginPath(); c.arc(left + 20, top + 20, 20, 0, TAU); c.fill(); font(700, 17); c.fillStyle = '#fff'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(name[0], left + 20, top + 21); c.textAlign = 'left'; }
    font(700, cs, CHAT); tracked(spacing); c.textBaseline = 'alphabetic'; c.fillStyle = text; c.fillText(name, textX, top + cs); const nw = c.measureText(name).width;
    font(500, Math.max(11, cs * 0.75), CHAT); tracked(0); c.fillStyle = t3; c.fillText(time, textX + nw + 10, top + cs);
    let ty = top + cs + lh * 0.9;
    font(look.fonts.weight, cs, CHAT); tracked(spacing);
    for (const line of lines) { for (const l of words(line, maxW)) { c.fillStyle = text; c.fillText(l, textX, ty); ty += lh; } }
    if (extra) ty = extra(ty);
    y = Math.max(ty, top + (avatars ? 44 : 0)) + groupGap;
  };
  message('Aria', 'Today at 9:41 PM', ['Welcome to the new look. Rain, glass and fonts, all in one theme.'], '#7c3aed', (ty) => {
    font(look.fonts.weight, cs, CHAT); tracked(spacing); const label = '@kai'; const w = c.measureText(label).width + 12;
    roundRect(c, textX, ty - lh * 0.8, w, lh * 0.95, 5); c.fillStyle = `rgba(${hexToRgb(a1).join(',')},.28)`; c.fill(); c.fillStyle = light ? '#1a1530' : '#fff'; c.fillText(label, textX + 6, ty - lh * 0.12);
    return ty + lh * 0.5;
  });
  message('Kai', 'Today at 9:42 PM', ['Love it! The panels really pop against this wallpaper.'], '#0d9488', (ty) => {
    font(400, Math.max(12, cs - 2), CODE); tracked(0); const code = 'theme.apply("calm");'; const w = c.measureText(code).width + 20;
    roundRect(c, textX, ty - lh * 0.4, w, lh * 1.15, 6); c.fillStyle = `rgba(${surface},.12)`; c.fill(); c.fillStyle = t2; c.fillText(code, textX + 10, ty + lh * 0.3);
    ty += lh * 1.1;
    const pill = (px, label, mine) => { font(600, 13); const pw = c.measureText(label).width + 22; roundRect(c, px, ty + 4, pw, 26, 13); c.fillStyle = mine ? `rgba(${hexToRgb(a1).join(',')},.25)` : `rgba(${surface},.1)`; c.fill(); if (mine) { c.strokeStyle = a1; c.lineWidth = 1.5; c.stroke(); } c.fillStyle = text; c.textBaseline = 'middle'; c.fillText(label, px + 11, ty + 18); c.textBaseline = 'alphabetic'; return pw; };
    const w1 = pill(textX, '★  4', true); pill(textX + w1 + 8, '♥  2', false);
    return ty + 36;
  });
  // message box
  const bh = 54; const by = ry + rh - bh - 18; const bx = mx + 20; const bw = mw - 40;
  roundRect(c, bx, by, bw, bh, Math.max(10, R)); c.fillStyle = `rgba(${surface},.1)`; c.fill();
  if (glassOn && look.glass.composer) glassSheen(bx, by, bw, bh, Math.max(10, R), 0.9);
  font(look.fonts.weight, 15, CHAT); tracked(spacing); c.fillStyle = t3; c.textBaseline = 'middle'; c.fillText('Message #general', bx + 20, by + bh / 2 + 1);
  const sbx = bx + bw - 48; roundRect(c, sbx, by + 9, 36, 36, Math.max(8, R * 0.6)); c.fillStyle = accent(sbx, by + 9, 36, 36); c.fill();
  if (glassOn && look.glass.buttons) glassSheen(sbx, by + 9, 36, 36, Math.max(8, R * 0.6), 0.8);
  c.strokeStyle = onAccent; c.lineWidth = 2.2; c.lineCap = 'round'; c.lineJoin = 'round'; c.beginPath(); c.moveTo(sbx + 11, by + 27); c.lineTo(sbx + 25, by + 27); c.moveTo(sbx + 20, by + 21); c.lineTo(sbx + 26, by + 27); c.lineTo(sbx + 20, by + 33); c.stroke();
  c.restore();
}

/* ------------------------------------------------------------------ profile themes */
const CARD_W = 340; const CARD_H = 440;
/** A person's grayed-out picture: a round gray disc with a plain head and shoulders. */
function grayAvatar(c, cx, cy, r) {
  c.save(); c.beginPath(); c.arc(cx, cy, r, 0, TAU); c.clip();
  c.fillStyle = linear(c, cx - r, cy - r, r * 2, r * 2, 160, ['#8d919b', '#6a6e78']); c.fillRect(cx - r, cy - r, r * 2, r * 2);
  c.fillStyle = '#c9ccd3'; c.beginPath(); c.arc(cx, cy - r * 0.18, r * 0.34, 0, TAU); c.fill(); c.beginPath(); c.ellipse(cx, cy + r * 0.95, r * 0.7, r * 0.62, 0, 0, TAU); c.fill();
  c.restore();
}
async function drawProfile(c, style, images) {
  const p = style; const nameFam = fontFamily(p.fonts?.name); const textFam = fontFamily(p.fonts?.text);
  await Promise.all([ensureFont(nameFam, [400]), ensureFont(textFam, [400, 600, 800]), ensureFont('Montserrat', [500, 700, 800])]);
  const UI = stack('Montserrat'); const TEXT = textFam ? stack(textFam) : UI;
  let pic = null; if (images && p.colors?.mode === 'image' && p.colors.image) pic = await loadImage(p.colors.image);
  let fx = null;
  if (p.effect) {
    try {
      const m = await import('/js/profile-effects.js'); const cv = document.createElement('canvas'); const eff = p.effect.rainbow ? { ...p.effect, color: '#ff3b5c', color2: '#3b9bff' } : p.effect;
      m.startEffect(cv, eff, { reduce: true, size: { width: CARD_W, height: CARD_H } })(); fx = cv;
    } catch { fx = null; }
  }
  const W = PREVIEW_W; const H = PREVIEW_H;
  c.fillStyle = linear(c, 0, 0, W, H, 160, ['#1c1a27', '#0d0c13']); c.fillRect(0, 0, W, H);
  const k = (H - 40) / CARD_H;
  c.save(); c.translate((W - CARD_W * k) / 2, 20); c.scale(k, k);
  const R = 20; const base = '#15131f';
  const fillOf = (f, x, y, w, h) => (f.rainbow ? linear(c, x, y, w, h, f.angle ?? 90, RAINBOW) : f.mode === 'gradient' ? linear(c, x, y, w, h, f.angle, [f.a, f.b]) : f.a);
  // glow outside the card
  if (p.shadow) {
    const s = p.shadow; c.save(); c.shadowColor = s.rainbow ? 'rgba(255,90,140,' + s.alpha + ')' : rgba(s.color, s.alpha); c.shadowBlur = s.blur; c.shadowOffsetX = s.x; c.shadowOffsetY = s.y;
    roundRect(c, -s.spread / 2, -s.spread / 2, CARD_W + s.spread, CARD_H + s.spread, R); c.fillStyle = base; c.fill(); c.restore();
  }
  roundRect(c, 0, 0, CARD_W, CARD_H, R); c.fillStyle = base; c.fill();
  c.save(); roundRect(c, 0, 0, CARD_W, CARD_H, R); c.clip();
  // the card's tint (colors, gradient or picture)
  if (p.colors) {
    const col = p.colors;
    if (pic) { const kk = Math.max(CARD_W / pic.width, CARD_H / pic.height); const w = pic.width * kk; const h = pic.height * kk; c.globalAlpha = col.imageOpacity ?? 0.6; c.drawImage(pic, (CARD_W - w) / 2, (CARD_H - h) / 2, w, h); c.globalAlpha = 1; }
    else if (col.mode !== 'image') {
      c.globalAlpha = col.tint; c.fillStyle = col.rainbow ? linear(c, 0, 0, CARD_W, CARD_H, col.angle, RAINBOW) : col.mode === 'gradient' ? linear(c, 0, 0, CARD_W, CARD_H, col.angle, [col.a, col.b]) : col.a;
      c.fillRect(0, 0, CARD_W, CARD_H); c.globalAlpha = 1;
    }
  }
  // banner: gray, like the avatar
  c.fillStyle = linear(c, 0, 0, CARD_W, 98, 120, ['#5a5e69', '#7a7e89']); c.fillRect(0, 0, CARD_W, 98);
  // the body
  const body = (weight, size, fam = TEXT) => { c.font = `${weight} ${size}px ${fam}`; };
  const wrapText = (str, max) => { const out = []; let line = ''; for (const w of str.split(' ')) { const next = line ? `${line} ${w}` : w; if (c.measureText(next).width > max && line) { out.push(line); line = w; } else line = next; } if (line) out.push(line); return out; };
  // name: its font, fill (color / gradient / rainbow), outline and shadow
  const name = 'User'; const size = 26; const nx = 16; const ny = 98 + 76;
  c.textBaseline = 'alphabetic';
  c.font = nameFam ? `400 ${size}px ${stack(nameFam)}` : `800 ${size}px ${UI}`;
  const nw = c.measureText(name).width; const box = [nx, ny - size, nw, size * 1.2];
  const sh = p.nameShadow; const ol = p.nameOutline; const nf = p.nameColor;
  const shadowOn = () => { if (!sh) return; const a = (sh.angle * Math.PI) / 180; c.shadowColor = sh.rainbow ? '#ff5577' : sh.color; c.shadowOffsetX = Math.cos(a) * sh.distance; c.shadowOffsetY = Math.sin(a) * sh.distance; c.shadowBlur = sh.blur; };
  const shadowOff = () => { c.shadowColor = 'transparent'; c.shadowBlur = 0; c.shadowOffsetX = 0; c.shadowOffsetY = 0; };
  c.lineJoin = 'round';
  if (ol) { c.save(); shadowOn(); c.lineWidth = ol.width * 2; c.strokeStyle = fillOf(ol, ...box); c.strokeText(name, nx, ny); c.restore(); }
  c.save(); if (!ol) shadowOn(); c.fillStyle = nf ? fillOf(nf, ...box) : '#f4f2ff'; c.fillText(name, nx, ny); c.restore();
  body(500, 14); c.fillStyle = 'rgba(244,242,255,.7)'; c.fillText('user', nx, ny + 22);
  // sections
  const section = (y, h, title, lines) => {
    roundRect(c, 16, y, CARD_W - 32, h, 14); c.fillStyle = 'rgba(0,0,0,.17)'; c.fill();
    body(800, 11.5, UI); c.fillStyle = 'rgba(244,242,255,.7)'; c.save(); try { c.letterSpacing = '0.6px'; } catch { /* no letter spacing */ } c.fillText(title, 30, y + 24); c.restore();
    body(400, 14); c.fillStyle = '#f4f2ff'; let ty = y + 46; for (const l of lines) { c.fillText(l, 30, ty); ty += 20; }
  };
  body(400, 14); const about = wrapText('This is how your profile looks.', CARD_W - 60).slice(0, 2);
  const aboutH = 22 + 20 + about.length * 20 + 6; const aboutY = ny + 34;
  section(aboutY, aboutH, 'ABOUT ME', about);
  section(aboutY + aboutH + 10, 62, 'ORATA MEMBER SINCE', ['Jan 1, 2025']);
  roundRect(c, 16, CARD_H - 52, CARD_W - 32, 36, 10); c.fillStyle = 'rgba(255,255,255,.08)'; c.fill(); body(700, 13.5, UI); c.fillStyle = '#f4f2ff'; c.textAlign = 'center'; c.fillText('View Full Profile', CARD_W / 2, CARD_H - 29); c.textAlign = 'left';
  // the avatar rides over the banner's edge
  c.beginPath(); c.arc(16 + 40, 98, 46, 0, TAU); c.fillStyle = base; c.fill(); grayAvatar(c, 16 + 40, 98, 40);
  // effect on top
  if (fx) { c.globalAlpha = p.effect.opacity ?? 1; if (p.effect.rainbow) { try { c.filter = 'hue-rotate(40deg)'; } catch { /* no filters */ } } c.drawImage(fx, 0, 0, CARD_W, CARD_H); c.filter = 'none'; c.globalAlpha = 1; }
  // the glow inside the card
  if (p.shadow) {
    const s = p.shadow; c.save(); roundRect(c, 0, 0, CARD_W, CARD_H, R); c.clip();
    c.shadowColor = s.rainbow ? 'rgba(255,90,140,' + s.alpha * 0.55 + ')' : rgba(s.color, s.alpha * 0.55); c.shadowBlur = Math.round(s.blur * 0.7);
    c.beginPath(); c.rect(-300, -300, CARD_W + 600, CARD_H + 600); roundRect(c, -s.spread / 2, -s.spread / 2, CARD_W + s.spread, CARD_H + s.spread, R, false); c.fillStyle = '#000'; c.fill('evenodd'); c.restore();
  }
  c.restore();
  // the outline
  if (p.outline) {
    const o = p.outline; const w = o.width; c.save(); c.strokeStyle = o.rainbow ? linear(c, 0, 0, CARD_W, CARD_H, 135, RAINBOW) : o.color2 && o.style === 'solid' ? linear(c, 0, 0, CARD_W, CARD_H, 135, [o.color, o.color2]) : o.color;
    c.lineWidth = o.style === 'double' ? Math.max(1, w / 3) : w;
    if (o.style === 'dashed') c.setLineDash([w * 3, w * 2]); else if (o.style === 'dotted') { c.setLineDash([0.01, w * 2]); c.lineCap = 'round'; c.lineWidth = w; }
    roundRect(c, w / 2, w / 2, CARD_W - w, CARD_H - w, R); c.stroke();
    if (o.style === 'double') { c.lineWidth = Math.max(1, w / 3); roundRect(c, w - c.lineWidth / 2, w - c.lineWidth / 2, CARD_W - 2 * w + c.lineWidth, CARD_H - 2 * w + c.lineWidth, Math.max(2, R - w)); c.stroke(); }
    c.restore();
  }
  c.restore();
}

/* ------------------------------------------------------------------ the picture */
/** Draws the preview picture of a theme and resolves it as an image Blob (WebP, or PNG where that isn't supported). Never throws for a theme that can be saved:
 *  if a picture of the theme can't be read into the canvas (a wallpaper that blocks it), the preview is drawn without that picture. */
export async function renderThemePreview(kind, data) {
  const look = kind === 'site' ? sanitizeSiteLook(data) : sanitizeProfileStyle(data);
  if (!look) throw new Error('There is nothing to draw');
  for (const images of [true, false]) {
    const cv = document.createElement('canvas'); cv.width = PREVIEW_W; cv.height = PREVIEW_H; const c = cv.getContext('2d');
    try {
      if (kind === 'site') await drawSite(c, look, images); else await drawProfile(c, look, images);
      return await toBlob(cv);
    } catch (e) { if (!images) throw e; }
  }
  throw new Error('Could not draw the preview');
}
void num;
