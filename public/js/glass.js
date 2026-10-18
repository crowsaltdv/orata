// Orate — liquid glass for the whole interface (buttons, panels, menus, windows).
//
// Ported from jhnsnc's CodePen "[WebGL] Refraction cursor over video" (the Apple-style glass lens): the same signed-distance
// lens shape, the same `expImpulse` edge falloff that bends the image only near the rim, the same neutral base tint
// (albedo .4 @ alpha .15) and the same specular rim whose strength follows |dot(edge normal, direction to the light)|.
//
// In the CodePen the lens refracts a video texture. Here every glass button gets a small canvas behind its icon; one shared
// off-screen WebGL context renders the lens for each button from a texture of the user's wallpaper (sampled at the button's
// own screen position, so it really does bend what is "behind" it) and the result is copied into the button's canvas.
// Big surfaces (panels, menus, modals, toasts) get the same treatment as a glass "lip" around their edge: the wallpaper bends
// and brightens along the rim and fades out toward the middle, where the panel's own frosted background takes over.
// While you hover a button the highlight follows your cursor instead of the middle of the screen.
//
// (CSS backdrop-filter cannot do this inside our frosted panels: a panel is a "backdrop root", so a button inside it never
// sees the wallpaper at all — which is why the earlier SVG-filter version looked like nothing was happening.)

import { wallpaperCanvas } from '/js/wpcanvas.js';

const VERT = `attribute vec2 a_pos; void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;
const FRAG = `
precision highp float;
uniform vec2 u_size;        // lens size in device px
uniform float u_radius;     // corner radius in device px
uniform vec2 u_origin;      // lens top-left in viewport device px
uniform vec2 u_view;        // viewport size in device px
uniform sampler2D u_wall;   // wallpaper (sharp)
uniform sampler2D u_soft;   // wallpaper (blurred) for the frosted style
uniform float u_mode;       // 0 = liquid, 1 = frosted
uniform float u_k;          // intensity 0..1
uniform float u_hover;      // 0..1
uniform float u_press;      // 0..1
uniform vec3 u_tint;        // panel colour
uniform float u_tintAmt;
uniform vec4 u_dim;         // wallpaper dim overlay (rgb, alpha)
uniform vec2 u_light;       // normalised direction the light comes from (towards the cursor / screen centre)
uniform float u_dpr;
uniform float u_panel;      // 1 = large surface (glass lip + transparent middle), 0 = button
uniform vec3 u_ptr;         // panels: cursor in lens px (xy, y down) and how strongly it is felt (z)
uniform vec3 u_rip;         // panels: press ripple origin (xy) and progress (z; >= 1 means none)

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
// https://iquilezles.org/articles/functions/  (as modified in the CodePen: hard edge, never negative)
float expImpulse(float x, float k, float cut) {
  float h = k * (x + cut);
  if (x < 0.0) return 0.0;
  return h * exp(1.0 - h);
}
vec3 wall(vec2 px) {
  vec2 uv = clamp((u_origin + px) / u_view, 0.001, 0.999);
  vec3 sharp = texture2D(u_wall, uv).rgb;
  vec3 soft = texture2D(u_soft, uv).rgb;
  return mix(sharp, soft, max(u_mode, u_panel * 0.35));
}
void main() {
  vec2 frag = vec2(gl_FragCoord.x, u_size.y - gl_FragCoord.y);
  vec2 p = frag - 0.5 * u_size;
  vec2 half_ = 0.5 * u_size;
  float sd = sdRoundBox(p, half_, u_radius);                 // < 0 inside the lens
  // panels react to the cursor: a pool of light under it, and a ring that spreads out from where you press
  float glow = 0.0; float ring = 0.0;
  if (u_panel > 0.5) {
    float d = distance(frag, u_ptr.xy); float R = 220.0 * u_dpr;
    glow = u_ptr.z * exp(-(d * d) / (R * R));
    if (u_rip.z < 1.0) { float rd = distance(frag, u_rip.xy); float w = 26.0 * u_dpr; float t = (rd - u_rip.z * 760.0 * u_dpr) / w; ring = exp(-t * t) * (1.0 - u_rip.z); }
  }
  vec2 e = vec2(0.75, 0.0);
  vec2 n = vec2(sdRoundBox(p + e.xy, half_, u_radius) - sdRoundBox(p - e.xy, half_, u_radius),
                sdRoundBox(p + e.yx, half_, u_radius) - sdRoundBox(p - e.yx, half_, u_radius));
  n = normalize(n + vec2(1e-5));                              // outward normal
  float edge = mix(clamp(min(u_size.x, u_size.y) * 0.34, 6.0 * u_dpr, 20.0 * u_dpr), 30.0 * u_dpr, u_panel);
  // faux refraction: bend the sample point toward the middle of the lens, strongest just inside the rim
  float mag = expImpulse(-sd / edge, 4.0, 0.175) * (1.0 - u_mode * 0.8);
  float bend = (10.0 + 30.0 * u_k) * u_dpr * (1.0 + u_hover * 0.25 - u_press * 0.2) * mix(1.0, 1.3, u_panel) * (1.0 + glow * 0.9 + ring * 0.6);
  vec2 disp = -n * mag * bend;
  // a touch of chromatic dispersion at the rim, like real glass
  vec3 col = vec3(wall(frag + disp * 1.06).r, wall(frag + disp).g, wall(frag + disp * 0.94).b);
  col = mix(col, u_dim.rgb, u_dim.a);
  // neutral base tint (MOUSE_BASE_ALBEDO .4 / ALPHA .15 in the original) plus our panel tint so icons stay readable
  col = mix(col, vec3(0.4), 0.15);
  col = mix(col, u_tint, u_tintAmt);
  // soft inner light, strongest on the edges that face the light (and the opposite ones, as in the original)
  float facing = abs(dot(n, u_light));
  float inner = smoothstep(-edge, 0.0, sd);
  col += inner * facing * (0.10 + 0.16 * u_k + 0.12 * u_hover);
  col += inner * (glow * 0.30 + ring * 0.22);                // the lip lights up near the cursor
  col -= inner * (1.0 - facing) * 0.04;                       // a hint of depth on the shaded sides
  // specular rim line (MOUSE_SPECULAR_INTENSITY 5.0 → blown-out white, then clipped)
  float px1 = u_dpr;
  float line = smoothstep(-2.6 * px1, -1.0 * px1, sd) - smoothstep(-1.0 * px1, 0.2 * px1, sd);
  float spec = line * (facing * (0.55 + 0.9 * u_k + 0.7 * u_hover) + glow * 1.1 + ring * 0.9);
  col = mix(col, vec3(1.0), clamp(spec, 0.0, 1.0));
  col *= 1.0 + u_hover * 0.06 - u_press * 0.10;
  float mask = 1.0 - smoothstep(-0.75 * px1, 0.75 * px1, sd);
  float lip = smoothstep(-edge * 1.05, -edge * 0.04, sd);         // 1 on the rim, 0 toward the middle
  float aL = mask * mix(1.0, lip * 0.96, u_panel);
  float aS = mask * u_panel * (glow * 0.11 + ring * 0.18);       // light catching the glass away from the rim
  vec3 rgb = col * aL + vec3(1.0) * aS * (1.0 - aL);
  gl_FragColor = vec4(rgb, aL + aS * (1.0 - aL));
}`;

const SCOPES = ['panels', 'rail', 'nav', 'toolbar', 'buttons', 'composer'];
const TINT_AMT = { panels: 0.3, rail: 0.34, nav: 0.42, toolbar: 0.42, buttons: 0.42, composer: 0.58 };
// every large surface that should become glass without each component having to opt in
const PANEL_SEL = '.panel:not(.tpv):not(.s-preview), .modal, .ctx-menu, .pop-card, .toast, .call-ring';
const root = document.documentElement;

const S = {
  cfg: { style: 'off', intensity: 1, panels: true, rail: true, nav: true, toolbar: true, buttons: true, composer: true }, reduce: false,
  glc: null, gl: null, prog: null, u: {}, tex: { wall: null, soft: null }, ready: false, failed: false, texW: 0, texH: 0,
  entries: new Map(), epoch: 0, rendered: new WeakMap(), dirty: new Set(), raf: 0, poll: 0, mo: null, ro: null, scan: 0,
  source: null, bg: null, wallTimer: 0, tint: [0.08, 0.07, 0.12], dim: [0, 0, 0, 0.2], pointer: { x: 0, y: 0, el: null }, press: null, ptr: { x: -1e4, y: -1e4 },
};

function initGL() {
  if (S.gl || S.failed) return !!S.gl;
  try {
    const c = document.createElement('canvas'); c.width = 512; c.height = 128;
    const gl = c.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: false, powerPreference: 'low-power' });
    if (!gl) throw new Error('no webgl');
    const sh = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a_pos'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    for (const n of ['u_ptr', 'u_rip', 'u_panel', 'u_size', 'u_radius', 'u_origin', 'u_view', 'u_wall', 'u_soft', 'u_mode', 'u_k', 'u_hover', 'u_press', 'u_tint', 'u_tintAmt', 'u_dim', 'u_light', 'u_dpr']) S.u[n] = gl.getUniformLocation(prog, n);
    for (const [k, unit] of [['wall', 0], ['soft', 1]]) {
      const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
      for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, p, v);
      S.tex[k] = t;
    }
    gl.uniform1i(S.u.u_wall, 0); gl.uniform1i(S.u.u_soft, 1);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    c.addEventListener('webglcontextlost', (e) => { e.preventDefault(); S.gl = null; S.glc = null; S.ready = false; root.dataset.glassGl = '0'; });
    c.addEventListener('webglcontextrestored', () => { S.gl = null; S.failed = false; S.ready = false; setWallpaperNow(); });
    S.glc = c; S.gl = gl; S.prog = prog;
    return true;
  } catch (e) { console.warn('[glass] WebGL unavailable, using CSS glass:', e.message); S.failed = true; root.dataset.glassGl = '0'; return false; }
}

/* ------------------------------------------------------------------ wallpaper textures */
function setWallpaperNow() {
  if (!S.source || !S.bg || !initGL()) return;
  const gl = S.gl; const vw = innerWidth; const vh = innerHeight;
  const k = Math.min(1, 1400 / vw); const W = Math.max(64, Math.round(vw * k)); const H = Math.max(64, Math.round(vh * k));
  const sharp = wallpaperCanvas(S.source, S.bg, W, H);
  const soft = wallpaperCanvas(S.source, S.bg, Math.round(W / 4), Math.round(H / 4), { blur: 6 });
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, S.tex.wall); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sharp);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, S.tex.soft); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, soft);
  S.ready = true; root.dataset.glassGl = '1'; S.epoch++; scheduleAll();
}

/* ------------------------------------------------------------------ per-button lens */
function scopeOf(el) { for (const s of SCOPES) if (s !== 'panels' && el.classList.contains('glass-' + s)) return s; return el.classList.contains('glass') ? 'buttons' : 'panels'; }
function cornerRadius(el, w, h) {
  const cs = getComputedStyle(el); const v = cs.borderTopLeftRadius; let r = parseFloat(v) || 0;
  if (v.includes('%')) r = (r / 100) * Math.min(w, h);
  return Math.min(r, Math.min(w, h) / 2);
}
function hexRgb(c) { const m = /^#?([0-9a-f]{6})$/i.exec(c || ''); if (!m) return [0.08, 0.07, 0.12]; const n = parseInt(m[1], 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; }

function ensureEntry(el) {
  let e = S.entries.get(el);
  if (e) return e;
  const isPanel = !el.classList.contains('glass');
  if (isPanel && getComputedStyle(el).position === 'static') el.style.position = 'relative';   // the lens canvas is positioned against it
  const canvas = document.createElement('canvas'); canvas.className = 'glass-lens'; canvas.setAttribute('aria-hidden', 'true');
  el.appendChild(canvas);
  e = { el, canvas, ctx: canvas.getContext('2d'), key: '', hover: 0, hoverTarget: 0, press: 0, light: null, rect: null, epoch: -1, big: isPanel, rip: null, anim: false, tLast: 0 };
  S.entries.set(el, e); S.ro.observe(el);
  if (isPanel) return e;   // big surfaces follow the cursor through the global tracker in trackPanels()
  el.addEventListener('pointerenter', (ev) => { e.hoverTarget = 1; e.light = [ev.clientX, ev.clientY]; mark(e); });
  el.addEventListener('pointerleave', () => { e.hoverTarget = 0; e.light = null; e.press = 0; mark(e); });
  el.addEventListener('pointermove', (ev) => { e.light = [ev.clientX, ev.clientY]; mark(e); }, { passive: true });
  el.addEventListener('pointerdown', () => { e.press = 1; mark(e); });
  el.addEventListener('pointerup', () => { e.press = 0; mark(e); });
  return e;
}
function mark(e) { S.dirty.add(e); if (!S.raf) S.raf = requestAnimationFrame(flush); }
function scheduleAll() { for (const e of S.entries.values()) S.dirty.add(e); if (!S.raf) S.raf = requestAnimationFrame(flush); }

function flush() {
  S.raf = 0;
  const list = [...S.dirty]; S.dirty.clear();
  const now = performance.now();
  for (const e of list) {
    if (!e.el.isConnected) { drop(e); continue; }
    if (e.big && now - e.tLast < 30) { S.dirty.add(e); continue; }   // big lenses redraw at ~30 fps while you move the mouse
    e.anim = render(e); e.tLast = now;
    if (e.anim) S.dirty.add(e);
  }
  if (S.dirty.size && !S.raf) S.raf = requestAnimationFrame(flush);
}
function drop(e) { S.entries.delete(e.el); S.ro?.unobserve(e.el); e.canvas.remove(); }

/** Draws one lens. Returns true while it still needs frames (hover easing). */
function render(e) {
  const { el, canvas, ctx } = e;
  const scope = scopeOf(el); const on = S.cfg[scope] && S.cfg.style !== 'off' && S.ready;
  if (!on) { canvas.style.display = 'none'; return false; }
  const r = el.getBoundingClientRect(); const w = r.width; const h = r.height;
  const big = scope === 'panels';
  if (w < 8 || h < 8 || (!big && (w > 1500 || h > 500)) || (big && (w > innerWidth * 1.2 || h > innerHeight * 1.2)) || r.bottom < -50 || r.top > innerHeight + 50 || r.right < -50 || r.left > innerWidth + 50) { canvas.style.display = 'none'; return false; }
  canvas.style.display = '';
  const gl = S.gl; if (!gl) return false;
  const dpr = Math.min(window.devicePixelRatio || 1, big ? 1.25 : 2);
  const pw = Math.max(1, Math.round(w * dpr)); const ph = Math.max(1, Math.round(h * dpr));
  if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
  const glc = S.glc; if (glc.width < pw || glc.height < ph) { glc.width = Math.max(glc.width, pw); glc.height = Math.max(glc.height, ph); }
  // ease the hover amount
  if (S.reduce) e.hover = e.hoverTarget; else { e.hover += (e.hoverTarget - e.hover) * 0.28; if (Math.abs(e.hover - e.hoverTarget) < 0.02) e.hover = e.hoverTarget; }
  gl.viewport(0, 0, pw, ph);
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  // light: towards the cursor while hovering, otherwise towards the middle of the screen (the CodePen's light source)
  const cx = r.left + w / 2; const cy = r.top + h / 2;
  const tx = e.light ? e.light[0] : innerWidth / 2; const ty = e.light ? e.light[1] : innerHeight / 2;
  let lx = tx - cx; let ly = ty - cy; const ll = Math.hypot(lx, ly) || 1; lx /= ll; ly /= ll;
  const U = S.u; const tint = S.tint;
  gl.uniform1f(U.u_panel, big ? 1 : 0);
  let ripping = false;
  if (big) {
    const pl = e.hover > 0.001 ? [(S.ptr.x - r.left) * dpr, (S.ptr.y - r.top) * dpr] : [-1e4, -1e4];
    gl.uniform3f(U.u_ptr, pl[0], pl[1], e.hover);
    let rp = 1; let rx = -1e4; let ry = -1e4;
    if (e.rip) { rp = (performance.now() - e.rip.t0) / 900; if (rp >= 1 || S.reduce) { e.rip = null; rp = 1; } else { rx = e.rip.x * dpr; ry = e.rip.y * dpr; ripping = true; } }
    gl.uniform3f(U.u_rip, rx, ry, rp);
  }
  gl.uniform2f(U.u_size, pw, ph); gl.uniform1f(U.u_radius, cornerRadius(el, w, h) * dpr);
  gl.uniform2f(U.u_origin, r.left * dpr, r.top * dpr); gl.uniform2f(U.u_view, innerWidth * dpr, innerHeight * dpr);
  gl.uniform1f(U.u_mode, S.cfg.style === 'frosted' ? 1 : 0); gl.uniform1f(U.u_k, S.cfg.intensity);
  gl.uniform1f(U.u_hover, big ? 0 : e.hover); gl.uniform1f(U.u_press, e.press);
  gl.uniform3f(U.u_tint, tint[0], tint[1], tint[2]); gl.uniform1f(U.u_tintAmt, TINT_AMT[scope] * (1.15 - S.cfg.intensity * 0.3));
  gl.uniform4f(U.u_dim, S.dim[0], S.dim[1], S.dim[2], S.dim[3]); gl.uniform2f(U.u_light, lx, ly); gl.uniform1f(U.u_dpr, dpr);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  ctx.clearRect(0, 0, pw, ph);
  ctx.drawImage(glc, 0, glc.height - ph, pw, ph, 0, 0, pw, ph);
  e.epoch = S.epoch; e.rect = [r.left, r.top, w, h];
  return e.hover !== e.hoverTarget || ripping;
}

/* ------------------------------------------------------------------ panels follow the cursor */
const REACH = 80;   // px outside a panel within which its rim still glows
function trackPanels() {
  const onMove = (ev) => {
    if (S.cfg.style === 'off') return;
    S.ptr.x = ev.clientX; S.ptr.y = ev.clientY;
    const top = document.elementFromPoint(ev.clientX, ev.clientY);
    for (const e of S.entries.values()) {
      if (!e.big || !e.rect) continue;
      const [l, t, w, h] = e.rect;
      const dx = Math.max(l - ev.clientX, 0, ev.clientX - (l + w)); const dy = Math.max(t - ev.clientY, 0, ev.clientY - (t + h)); const dist = Math.hypot(dx, dy);
      const hovered = !!top && e.el.contains(top);
      const target = hovered ? 1 : dist < REACH ? 0.65 * (1 - dist / REACH) : 0;   // neighbours glow a little when you are close
      if (target === 0 && e.hover === 0 && e.hoverTarget === 0) continue;
      e.hoverTarget = target; e.light = target > 0 ? [ev.clientX, ev.clientY] : null; mark(e);
    }
  };
  const onLeave = () => { for (const e of S.entries.values()) if (e.big && (e.hoverTarget || e.hover)) { e.hoverTarget = 0; e.light = null; mark(e); } };
  const onDown = (ev) => {
    if (S.cfg.style === 'off' || S.reduce || ev.button > 0) return;
    const top = document.elementFromPoint(ev.clientX, ev.clientY);
    for (const e of S.entries.values()) if (e.big && e.rect && top && e.el.contains(top)) { e.rip = { x: ev.clientX - e.rect[0], y: ev.clientY - e.rect[1], t0: performance.now() }; mark(e); }
  };
  window.addEventListener('pointermove', onMove, { passive: true });
  window.addEventListener('pointerdown', onDown, { capture: true, passive: true });
  document.documentElement.addEventListener('pointerleave', onLeave);
  window.addEventListener('blur', onLeave);
}

/* ------------------------------------------------------------------ discovery + upkeep */
function scan() {
  S.scan = 0;
  if (S.cfg.style === 'off' || S.failed) { for (const e of [...S.entries.values()]) drop(e); return; }
  if (!S.ro) return;
  for (const el of document.querySelectorAll('.glass, ' + PANEL_SEL)) if (!S.entries.has(el)) mark(ensureEntry(el));
  for (const e of [...S.entries.values()]) if (!e.el.isConnected) drop(e);
}
const queueScan = () => { if (!S.scan) S.scan = setTimeout(scan, 30); };

function startObservers() {
  if (S.ro) return;
  S.ro = new ResizeObserver((entries) => { for (const en of entries) { const e = S.entries.get(en.target); if (e) mark(e); } });
  S.mo = new MutationObserver(queueScan); S.mo.observe(document.body, { childList: true, subtree: true });
  // elements move when lists scroll, panels slide or the window resizes: re-sample the wallpaper at the new position
  const moved = () => { for (const e of S.entries.values()) { const r = e.el.getBoundingClientRect(); if (!e.rect || Math.abs(r.left - e.rect[0]) > 0.5 || Math.abs(r.top - e.rect[1]) > 0.5) S.dirty.add(e); } if (S.dirty.size && !S.raf) S.raf = requestAnimationFrame(flush); };
  window.addEventListener('scroll', moved, { capture: true, passive: true });
  trackPanels();
  S.poll = setInterval(() => { if (!document.hidden && S.entries.size) moved(); }, 400);
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { setWallpaperNow(); }, 200); });
}

/** Called by the theme engine whenever the wallpaper (image, gradient, solid) or its tone/position/dim changes. */
function setWallpaper(source, bg, tint, dim) {
  S.source = source; S.bg = bg; S.tint = hexRgb(tint); S.dim = dim;
  clearTimeout(S.wallTimer); S.wallTimer = setTimeout(setWallpaperNow, 60);
}

export const glass = {
  state: S,   // exposed for debugging in the console
  setWallpaper,
  apply(g, reduce) {
    S.cfg = { ...S.cfg, ...g }; S.reduce = !!reduce;
    root.dataset.glass = g.style;
    root.style.setProperty('--glass-i', String(g.intensity));
    for (const k of SCOPES) root.dataset['glass' + k[0].toUpperCase() + k.slice(1)] = g[k] ? '1' : '0';
    if (g.style !== 'off') { startObservers(); initGL(); queueScan(); S.epoch++; scheduleAll(); } else { for (const e of S.entries.values()) e.canvas.style.display = 'none'; }
  },
};
