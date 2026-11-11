// Orata — the copy of a row that follows the pointer while you drag it: a channel or category (channel-dnd.js), a server or folder (rail-dnd.js).
// It is lifted a little (a bigger, glowing copy) and it hangs from the spot you took hold of it by like a pendulum: shake or move the mouse and it swings left and right,
// and settles back when you stop. Dropping it glides it into its place (or fades it out where the row has gone). Reduced motion: no swing, no lift, it just follows.
// The copy is drawn with ONE transform (move, then swing, then grow) around the spot you hold it by, so the spot stays exactly under the pointer however far it swings.

const motionK = () => { const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--m')); return Number.isFinite(v) ? v : 1; };   // the app's own speed / reduced-motion multiplier
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const SPRING = 160;     // how hard it swings back to hanging straight (about two swings a second)
const DAMPING = 5.5;    // how quickly the swinging dies down, per second
const PUSH = 1 / 340;   // how much the pointer speeding up or slowing down (px/s²) throws it
const LEAN = 0.00009;   // how far it leans into a steady movement (radians per px/s)
const MAX_SWING = 0.62; // radians (about 35°)

/** `source`: the row to copy. `x`, `y`: the pointer; `dx`, `dy`: where in the row it was taken hold of. `className`: extra classes for the copy ('rail-ghost'); `grow`: how much bigger it is lifted. */
export function createGhost(source, { x, y, dx, dy, className = '', grow = 1.05 }) {
  const rect = source.getBoundingClientRect(); const el = source.cloneNode(true);
  for (const a of ['data-dnd', 'data-rail', 'data-flip', 'data-folder', 'tabindex', 'role', 'id', 'draggable']) el.removeAttribute(a);
  for (const n of el.querySelectorAll('[id], [data-tip], [data-flip], [data-rail]')) { n.removeAttribute('id'); n.removeAttribute('data-tip'); n.removeAttribute('data-flip'); n.removeAttribute('data-rail'); }
  el.setAttribute('aria-hidden', 'true'); el.classList.add('dnd-ghost'); if (className) el.classList.add(...className.split(' '));
  el.style.width = `${rect.width}px`; el.style.height = `${rect.height}px`; el.style.transformOrigin = `${dx}px ${dy}px`;
  const g = { px: x - dx, py: y - dy, tx: x - dx, ty: y - dy, ang: 0, vel: 0, lift: 0, vx: 0, lastX: x - dx, lastVx: 0, landing: false, ms: 240, t: performance.now(), raf: 0, gone: false };
  const draw = () => { el.style.transform = `translate3d(${g.px}px, ${g.py}px, 0) rotate(${g.ang}rad) scale(${1 + (grow - 1) * g.lift})`; };
  draw(); document.body.appendChild(el); void el.offsetWidth; el.classList.add('lifted');

  function frame(now) {
    if (g.gone) return;
    g.raf = requestAnimationFrame(frame);
    const dt = clamp((now - g.t) / 1000, 0.001, 0.033); g.t = now; const m = motionK(); const calm = m < 0.2;
    if (g.landing) { const k = 1 - Math.exp(-dt / Math.max(0.01, 0.06 * m)); g.px += (g.tx - g.px) * k; g.py += (g.ty - g.py) * k; }   // gliding into its place
    else { g.px = g.tx; g.py = g.ty; }   // glued to the pointer
    if (calm) { g.ang = 0; g.vel = 0; g.lift = g.landing ? 0 : 1; draw(); return; }
    // the pendulum: the pointer's speed and how it is changing push the copy sideways around the spot it is held by
    const vx = (g.px - g.lastX) / dt; g.lastX = g.px;
    g.vx += (vx - g.vx) * Math.min(1, dt * 30); const ax = (g.vx - g.lastVx) / dt; g.lastVx = g.vx;
    const rest = g.landing ? 0 : clamp(g.vx * LEAN, -0.14, 0.14) - 0.021 * g.lift;   // (a little tilt while it is lifted, leaning into the way it moves)
    g.vel += (-SPRING * (g.ang - rest) - DAMPING * g.vel - PUSH * ax * Math.cos(g.ang)) * dt; g.ang += g.vel * dt;
    if (Math.abs(g.ang) > MAX_SWING) { g.ang = Math.sign(g.ang) * MAX_SWING; g.vel = 0; }
    g.lift += ((g.landing ? 0 : 1) - g.lift) * (1 - Math.exp(-dt / 0.08));
    draw();
  }
  g.raf = requestAnimationFrame(frame);

  return {
    el,
    /** The pointer is at (x, y). */
    move(px, py) { g.tx = px - dx; g.ty = py - dy; },
    /** Let go: glide into `to` (a DOMRect: the slot's corner) — or, with `hidden`, fade out where it is (the row it belongs to is gone or out of sight). `ms`: how long. */
    land(to, { hidden = false, ms = 240 } = {}) {
      g.landing = true; g.ms = ms; el.classList.remove('lifted'); el.classList.add('landing');
      if (to) { g.tx = to.left; g.ty = to.top; }
      if (hidden || !to) el.style.opacity = '0';
    },
    destroy() { g.gone = true; cancelAnimationFrame(g.raf); el.remove(); },
  };
}
