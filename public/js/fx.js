// Orate — button feedback: press ripples and particle bursts (sparkles, confetti, emoji) so every click feels good.
import { state } from '/js/store.js';

let canvas = null; let ctx = null; let dpr = 1; let raf = 0; let last = 0;
const parts = [];
const root = document.documentElement;

const on = () => !state.settings.motion.reduce && state.settings.fx?.particles !== false;
const amountK = () => state.settings.fx?.amount ?? 1;
const rnd = (a, b) => a + Math.random() * (b - a);

function ensureCanvas() {
  if (canvas) return;
  canvas = document.createElement('canvas'); canvas.id = 'fx'; canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:150';
  document.body.appendChild(canvas); ctx = canvas.getContext('2d'); resize();
  window.addEventListener('resize', resize);
}
function resize() { dpr = Math.min(window.devicePixelRatio || 1, 2); canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr; }
function palette(extra) {
  const cs = getComputedStyle(root);
  return [cs.getPropertyValue('--accent').trim() || '#8b5cf6', cs.getPropertyValue('--accent-2').trim() || '#ec4899', '#ffffff', ...(extra || [])];
}

/** Core emitter. */
function emit(x, y, { count = 14, colors, shapes = ['circle', 'star'], speed = 5, spread = Math.PI * 2, angle = -Math.PI / 2, gravity = 0.16, life = 700, size = [3, 7], emoji, ring = false, drag = 0.965, spin = 0.25 } = {}) {
  ensureCanvas();
  const cols = colors || palette();
  const n = Math.max(1, Math.round(count * amountK()));
  for (let i = 0; i < n; i++) {
    const a = angle + (Math.random() - 0.5) * spread; const v = speed * rnd(0.45, 1.15);
    parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: gravity, drag, life, max: life * rnd(0.75, 1.15), size: rnd(size[0], size[1]), rot: rnd(0, 6.28), vr: rnd(-spin, spin), color: cols[(Math.random() * cols.length) | 0], shape: emoji ? 'emoji' : shapes[(Math.random() * shapes.length) | 0], emoji });
  }
  if (ring) parts.push({ x, y, vx: 0, vy: 0, g: 0, drag: 1, life: 420, max: 420, size: ring, rot: 0, vr: 0, color: cols[0], shape: 'ring' });
  if (!raf) { last = performance.now(); raf = requestAnimationFrame(loop); }
}

function drawStar(c, r) { c.beginPath(); for (let i = 0; i < 8; i++) { const rad = i % 2 ? r * 0.28 : r; const a = (i * Math.PI) / 4; c.lineTo(Math.cos(a) * rad, Math.sin(a) * rad); } c.closePath(); c.fill(); }
function loop(now) {
  const dt = Math.min(2.2, (now - last) / 16.667); last = now;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.scale(dpr, dpr);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]; p.life -= 16.667 * dt;
    if (p.life <= 0) { parts.splice(i, 1); continue; }
    const t = 1 - p.life / p.max;
    p.vx *= Math.pow(p.drag, dt); p.vy = p.vy * Math.pow(p.drag, dt) + p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
    const alpha = t < 0.12 ? t / 0.12 : Math.max(0, 1 - Math.pow((t - 0.12) / 0.88, 1.6));
    ctx.save(); ctx.globalAlpha = alpha; ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.color; ctx.strokeStyle = p.color;
    if (p.shape === 'circle') { ctx.beginPath(); ctx.arc(0, 0, p.size * (1 - t * 0.5), 0, 6.283); ctx.fill(); }
    else if (p.shape === 'star') drawStar(ctx, p.size * 1.5 * (1 - t * 0.4));
    else if (p.shape === 'spark') { ctx.lineWidth = Math.max(1.5, p.size * 0.35); ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(-p.size, 0); ctx.lineTo(p.size, 0); ctx.stroke(); }
    else if (p.shape === 'confetti') { ctx.fillRect(-p.size, -p.size * 0.5, p.size * 2, p.size); }
    else if (p.shape === 'emoji') { ctx.font = `${p.size * 3.2}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(p.emoji, 0, 0); }
    else if (p.shape === 'ring') { ctx.rotate(-p.rot); ctx.lineWidth = 2.5 * (1 - t); ctx.beginPath(); ctx.arc(0, 0, p.size * (0.25 + t * 1.1), 0, 6.283); ctx.stroke(); }
    ctx.restore();
  }
  if (parts.length) raf = requestAnimationFrame(loop); else { raf = 0; ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); }
}

/* ------------------------------------------------------------------ public bursts */
const centerOf = (el) => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, r]; };
export const fx = {
  sparkle(x, y, extra) { if (on()) emit(x, y, { count: 12, speed: 4.2, shapes: ['star', 'circle', 'spark'], life: 620, ...extra }); },
  pop(x, y, color) { if (on()) emit(x, y, { count: 9, speed: 3.6, ring: 26, colors: color ? [color, '#fff'] : undefined, life: 560 }); },
  confetti(x = innerWidth / 2, y = innerHeight * 0.3, n = 60) { if (on()) emit(x, y, { count: n, speed: 11, spread: Math.PI * 1.1, angle: -Math.PI / 2, gravity: 0.3, life: 1500, shapes: ['confetti', 'confetti', 'circle', 'star'], size: [4, 8], colors: [...palette(), '#f59e0b', '#22d3ee', '#34d399'], spin: 0.4 }); },
  emoji(char, x, y) { if (on()) emit(x, y, { count: 7, speed: 4.5, emoji: char, gravity: -0.03, drag: 0.975, life: 950, size: [3.2, 5.2], spread: Math.PI * 0.9 }); },
  /** Message sent: the send button launches a trail of sparks and the arrow flies off. */
  send() {
    if (!on()) return;
    const btn = document.querySelector('.comp-btn.send'); if (!btn) return;
    const [x, y] = centerOf(btn);
    emit(x, y, { count: 20, speed: 7, angle: -Math.PI / 4, spread: Math.PI * 0.9, shapes: ['spark', 'star', 'circle'], gravity: 0.1, life: 640, ring: 30 });
    btn.classList.remove('sent'); void btn.offsetWidth; btn.classList.add('sent'); setTimeout(() => btn.classList.remove('sent'), 600);
  },
};

/* ------------------------------------------------------------------ delegated interaction effects */
const RIPPLE_SEL = '.btn, .icon-btn, .comp-btn, .rail-btn, .nav-item, .fr-btn, .ftab, .preset-chip, .choice, .tpl, .type-opt, .segmented button, .sb-search, .mode-card, .lang-card, .wp-tile, .picker-tabs button, .um-item, .dd-btn';
const PARTICLE_SEL = '.btn, .toggle, .reaction, .emoji-cell, .rail-btn, .grad-swatch, .panel-swatch, .preset-chip, .fr-btn, .segmented button, .mode-card, .lang-card, .wp-tile, .choice, .tpl, .gif-tile';

function ripple(el, e) {
  if (state.settings.fx?.ripples === false || state.settings.motion.reduce || el.disabled) return;
  const r = el.getBoundingClientRect(); const x = (e.clientX || r.left + r.width / 2) - r.left; const y = (e.clientY || r.top + r.height / 2) - r.top;
  if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
  const wrap = document.createElement('span'); wrap.className = 'fx-ripple-wrap'; wrap.setAttribute('aria-hidden', 'true');
  const dot = document.createElement('i'); const d = Math.max(r.width, r.height) * 2.4;
  Object.assign(dot.style, { left: x - d / 2 + 'px', top: y - d / 2 + 'px', width: d + 'px', height: d + 'px' });
  wrap.appendChild(dot); el.appendChild(wrap); setTimeout(() => wrap.remove(), 650);
}

export function initFx() {
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const el = e.target.closest?.(RIPPLE_SEL); if (el) ripple(el, e);
  }, true);
  document.addEventListener('click', (e) => {
    if (!on()) return;
    const el = e.target.closest?.(PARTICLE_SEL); if (!el || el.disabled || el.classList.contains('send')) return;
    const keyboard = e.detail === 0; const [cx, cy, r] = centerOf(el);
    const x = keyboard ? cx : e.clientX; const y = keyboard ? cy : e.clientY;
    if (el.classList.contains('toggle')) { if (el.getAttribute('aria-checked') === 'false') fx.pop(cx, cy); return; }
    if (el.classList.contains('reaction')) { if (!el.classList.contains('mine') && !el.classList.contains('add')) fx.emoji(el.querySelector('.r-emoji')?.textContent || '✨', cx, cy); return; }
    if (el.classList.contains('emoji-cell')) { fx.emoji(el.textContent, cx, cy); return; }
    if (el.classList.contains('grad-swatch') || el.classList.contains('panel-swatch')) { fx.sparkle(cx, cy, { colors: [getComputedStyle(el).backgroundColor, '#fff'] }); return; }
    if (el.classList.contains('rail-btn')) { fx.pop(cx, cy); return; }
    if (el.classList.contains('btn-primary')) { emit(x, y, { count: 16, speed: 5.2, shapes: ['star', 'circle', 'spark'], life: 700, ring: Math.min(40, r.height) }); return; }
    if (el.classList.contains('fr-btn') && el.classList.contains('ok')) { fx.confetti(cx, cy, 26); return; }
    if (el.classList.contains('btn-danger')) { emit(x, y, { count: 12, speed: 4, colors: ['#f04d6a', '#ff9db0', '#fff'], shapes: ['spark', 'circle'] }); return; }
    fx.sparkle(x, y, { count: 7, speed: 3.2, life: 520 });
  }, true);
}
