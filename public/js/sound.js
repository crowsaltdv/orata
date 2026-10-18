// Orate — tiny synthesized UI sounds (no audio files needed).
import { state } from '/js/store.js';

let ctx = null;
function ac() {
  if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; } }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}
function tone(freq, start, dur, { type = 'sine', gain = 0.18, slideTo = null } = {}) {
  const c = ac(); if (!c) return;
  const t0 = c.currentTime + start; const o = c.createOscillator(); const g = c.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t0);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  const vol = gain * (state.settings.notif.volume ?? 0.5) * 2;
  g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(c.destination); o.start(t0); o.stop(t0 + dur + 0.05);
}
const SOUNDS = {
  message: () => { tone(660, 0, 0.14, { gain: 0.14 }); tone(880, 0.09, 0.2, { gain: 0.12 }); },
  mention: () => { tone(784, 0, 0.16, { type: 'triangle' }); tone(1175, 0.1, 0.28, { type: 'triangle' }); },
  send: () => tone(520, 0, 0.09, { gain: 0.08, slideTo: 760 }),
  join: () => { tone(440, 0, 0.12, { type: 'triangle' }); tone(660, 0.1, 0.2, { type: 'triangle' }); },
  leave: () => { tone(660, 0, 0.12, { type: 'triangle' }); tone(392, 0.1, 0.22, { type: 'triangle' }); },
  mute: () => tone(300, 0, 0.14, { type: 'square', gain: 0.07, slideTo: 200 }),
  unmute: () => tone(300, 0, 0.14, { type: 'square', gain: 0.07, slideTo: 450 }),
  deafen: () => { tone(380, 0, 0.12, { type: 'square', gain: 0.06, slideTo: 220 }); },
  undeafen: () => { tone(260, 0, 0.12, { type: 'square', gain: 0.06, slideTo: 420 }); },
  call: () => { tone(523, 0, 0.18, { type: 'triangle' }); tone(659, 0.2, 0.18, { type: 'triangle' }); tone(784, 0.4, 0.3, { type: 'triangle' }); },
  error: () => { tone(220, 0, 0.18, { type: 'sawtooth', gain: 0.07 }); },
  test: () => { tone(700, 0, 0.2, { type: 'triangle' }); tone(900, 0.15, 0.3, { type: 'triangle' }); },
};
export function playSound(name, { force = false } = {}) {
  if (!force && !state.settings.notif.sounds) return;
  try { SOUNDS[name]?.(); } catch { /* audio blocked */ }
}
let ringTimer = null;
export function startRing() { stopRing(); playSound('call', { force: true }); ringTimer = setInterval(() => playSound('call', { force: true }), 2600); }
export function stopRing() { clearInterval(ringTimer); ringTimer = null; }
// browsers only allow audio after a gesture
window.addEventListener('pointerdown', () => ac(), { once: true });
