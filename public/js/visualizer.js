// Orata — the music visualizer: a phonk-style "audio spectrum" screen. The song's cover sits in the middle (a circle, a square, a spinning record), its
// sound is drawn around it (wings, an outline, bars, a ring, dots, layers, spikes, orbits, petals, shockwaves or lightning), particles float about, a
// background moves behind it all, and the screen shakes on the beat (a shake, a punch, a bounce, a tilt, a rumble or a glitch) — hard for phonk, gently
// for calm songs. YouTube's player keeps its sound to itself, so by default the beat follows the song's energy (guessed from its title and artist, or
// picked in the settings); "Use the real sound" has Chrome share this tab's audio, and then everything follows the music itself, with as little delay as
// the browser allows. Settings (and how sensitive it is) stay on this device.
import { html, useState, useEffect, useRef, cx, ls } from '/js/lib.js';
import { state, set, useSel, toast } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { t } from '/js/i18n.js';

export const openVisualizer = () => set({ visualizer: true });
const DEFAULTS = { style: 'wings', color: 'auto', shape: 'circle', particles: 'bokeh', amount: 60, shake: 'auto', shakeType: 'shake', background: 'auto', energy: 'auto', time: true, flash: false, alwaysReal: false, sensitivity: 1 };
/** Every choice in the settings, in order: [value, label]. */
const OPTIONS = {
  style: [['wings', 'Wings'], ['outline', 'Outline'], ['bars', 'Bars'], ['ring', 'Ring'], ['dots', 'Dots'], ['layers', 'Layers'], ['spikes', 'Spikes'], ['orbit', 'Orbit'], ['bloom', 'Bloom'], ['shockwave', 'Shockwave'], ['electric', 'Electric'], ['none', 'None']],
  color: [['auto', 'Auto'], ['white', 'White'], ['cover', 'Cover'], ['rainbow', 'Rainbow']],
  shape: [['circle', 'Circle'], ['square', 'Square'], ['vinyl', 'Vinyl'], ['spin', 'Spinning']],
  particles: [['bokeh', 'Bokeh'], ['sparks', 'Sparks'], ['stars', 'Stars'], ['squares', 'Squares'], ['warp', 'Warp'], ['embers', 'Embers'], ['fireflies', 'Fireflies'], ['snow', 'Snow'], ['petals', 'Petals'], ['hearts', 'Hearts'], ['confetti', 'Confetti'], ['bubbles', 'Bubbles'], ['notes', 'Notes'], ['none', 'None']],
  background: [['auto', 'Auto'], ['cover', 'Cover'], ['smoke', 'Smoke'], ['colorful', 'Colorful'], ['tunnel', 'Tunnel'], ['retro', 'Retro'], ['aurora', 'Aurora'], ['space', 'Space'], ['rays', 'Rays'], ['kaleido', 'Kaleidoscope'], ['black', 'Black']],
  shake: [['auto', 'Auto'], ['off', 'Off'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']],
  shakeType: [['shake', 'Shake'], ['punch', 'Punch'], ['bounce', 'Bounce'], ['tilt', 'Tilt'], ['rumble', 'Rumble'], ['glitch', 'Glitch']],
  energy: [['auto', 'Auto'], ['calm', 'Calm'], ['medium', 'Medium'], ['intense', 'Intense']],
};
const AUTO_COLOR = { bars: 'cover', layers: 'cover', bloom: 'cover', orbit: 'cover' };   // (the rest are white unless the settings say)
const PARTS = { bokeh: 140, sparks: 140, stars: 90, squares: 26, warp: 240, embers: 90, fireflies: 50, snow: 220, petals: 70, hearts: 36, confetti: 110, bubbles: 45, notes: 34 };   // (how many at 100%)
const N = 48;   // bands of the spectrum (low to high)
const HIST = 12;   // frames of the spectrum kept, for the shapes that trail behind
const P2 = Math.PI * 2;
const HARD = /phonk|montagem|funk|drift|brazil|bass ?boost|trap|drill|rage|hardstyle|dubstep|edm|metal|techno|hyperpop|kordhell|playamane|interworld|moondeity|dvrst|ghostface|sxmpra|mvdnes/i;
const CALM = /acoustic|piano|lo-?fi|chill|ballad|sleep|ambient|jazz|classical|lullaby|relax|soft|instrumental|calm|study/i;
/** How hard a song hits, 0 (calm) to 1 (phonk), from its title, artist and album — unless the settings say. */
function guessEnergy(tr, pick) {
  if (pick === 'calm') return 0.15; if (pick === 'medium') return 0.5; if (pick === 'intense') return 0.95;
  const text = `${tr?.title || ''} ${tr?.artist || ''} ${tr?.album || ''}`;
  const e = HARD.test(text) ? 0.95 : CALM.test(text) ? 0.15 : 0.5;
  return /slowed|reverb/i.test(text) ? Math.max(0.15, e - 0.25) : e;
}
/** The hue (0-360) of a #rrggbb colour. */
function hueOf(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255); const max = Math.max(r, g, b); const min = Math.min(r, g, b); const d = max - min;
  if (!d) return 0; const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4; return (h * 60 + 360) % 360;
}
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const rnd = (a, b) => a + Math.random() * (b - a);
const hex2 = (a) => Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0');   // (an alpha for the end of a #rrggbb)
const lift = (hex) => [1, 3, 5].map((i) => { const v = parseInt(hex.slice(i, i + 2), 16); return Math.round(v + (255 - v) * 0.25); });   // (a cover colour, a little lighter so it shows on the dark)

/** The cover through Orata's own image proxy (so its colours can be read), and three colours from it. */
function loadCover(url) {
  return new Promise((resolve) => {
    if (!url) return resolve({ img: null, colors: ['#e0303a', '#7c3aed', '#0ea5e9'], grey: true });
    const img = new Image(); img.decoding = 'async';
    img.onload = () => {
      try {
        const c = document.createElement('canvas'); c.width = 24; c.height = 24; const g = c.getContext('2d'); g.drawImage(img, 0, 0, 24, 24);
        const px = g.getImageData(0, 0, 24, 24).data; const picks = [];
        for (let i = 0; i < px.length; i += 4) { const [r, gg, b] = [px[i], px[i + 1], px[i + 2]]; const max = Math.max(r, gg, b); const min = Math.min(r, gg, b); picks.push({ r, g: gg, b, sat: max ? (max - min) / max : 0, light: max }); }
        const vivid = picks.filter((p) => p.sat > 0.3 && p.light > 60).sort((a, b) => b.sat * b.light - a.sat * a.light);
        const hex = (p) => `#${[p.r, p.g, p.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
        const colors = vivid.length >= 3 ? [vivid[0], vivid[Math.floor(vivid.length / 2)], vivid[vivid.length - 1]].map(hex) : ['#e0303a', '#7c3aed', '#0ea5e9'];
        resolve({ img, colors, grey: vivid.length < picks.length * 0.08 });
      } catch { resolve({ img, colors: ['#e0303a', '#7c3aed', '#0ea5e9'], grey: true }); }
    };
    img.onerror = () => resolve({ img: null, colors: ['#e0303a', '#7c3aed', '#0ea5e9'], grey: true });
    img.src = `/api/img?url=${encodeURIComponent(url)}`;
  });
}

/** The full-screen visualizer, while `state.visualizer` is on (app.js). */
export function VisualizerHost() {
  const open = useSel((s) => !!s.visualizer);
  return open ? html`<${Visualizer} />` : null;
}

function Visualizer() {
  const track = useSel((s) => s.music.track); const playing = useSel((s) => s.music.playing);
  const reduce = useSel((s) => !!s.settings.motion?.reduce);
  const [opts, setOpts] = useState(() => ({ ...DEFAULTS, ...(ls('visualizer', {}) || {}) }));
  const [panel, setPanel] = useState(false); const [liveOn, setLiveOn] = useState(false);
  const canvas = useRef(null); const live = useRef(null); const sim = useRef({ opts, playing, track, reduce });
  sim.current.opts = opts; sim.current.playing = playing; sim.current.track = track; sim.current.reduce = reduce;
  const put = (k, v) => setOpts((o) => { const n = { ...o, [k]: v }; ls('visualizer', null, n); return n; });
  const close = () => set({ visualizer: false });
  // a random look: any shape around the cover, colour, cover, particles, background and kind of shake
  const shuffle = () => setOpts((o) => {
    const n = { ...o };
    for (const k of ['style', 'color', 'shape', 'particles', 'background', 'shakeType']) { const c = OPTIONS[k].filter(([v]) => v !== 'none' && v !== 'auto'); n[k] = c[Math.floor(Math.random() * c.length)][0]; }
    ls('visualizer', null, n); return n;
  });

  useEffect(() => { const k = (e) => { if (e.key === 'Escape') close(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, []);
  useEffect(() => { if (opts.alwaysReal) startLive(); return () => stopLive(); }, []);   // (the click that opened it lets Chrome ask)
  function stopLive() { const l = live.current; live.current = null; setLiveOn(false); if (!l) return; l.stream.getTracks().forEach((x) => x.stop()); l.ac.close().catch(() => {}); }
  async function startLive() {
    if (live.current) { stopLive(); return; }
    try {
      if (!navigator.mediaDevices?.getDisplayMedia) throw new Error(t('This browser can’t share its sound. Try Chrome or Edge.'));
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: { suppressLocalAudioPlayback: false }, preferCurrentTab: true, selfBrowserSurface: 'include' });
      if (!stream.getAudioTracks().length) { stream.getTracks().forEach((x) => x.stop()); throw new Error(t('No sound was shared. Pick this tab and leave “Share tab audio” on.')); }
      stream.getVideoTracks().forEach((x) => x.stop());   // only the sound is used
      // as little delay as possible: a short window (about 21 ms), no smoothing of its own (the bars rise at once and fall a little slower), the whole loudness range
      const ac = new AudioContext({ latencyHint: 'interactive' }); const an = ac.createAnalyser(); an.fftSize = 1024; an.smoothingTimeConstant = 0; an.minDecibels = -90; an.maxDecibels = -20;
      ac.createMediaStreamSource(stream).connect(an);
      live.current = { ac, an, data: new Uint8Array(an.frequencyBinCount), stream, avg: 0, last: 0, gain: 0.5, prev: new Uint8Array(16), flux: 0 };
      stream.getAudioTracks()[0].addEventListener('ended', stopLive);
      setLiveOn(true);
    } catch (e) { if (e?.name !== 'NotAllowedError') toast(e?.message || String(e), 'error', 5000); else toast(t('Sharing the sound was cancelled.'), 'info', 3000); }
  }

  // the drawing: everything per frame, on one canvas
  useEffect(() => {
    const cv = canvas.current; const g = cv.getContext('2d'); let raf = 0; let alive = true;
    let W = 0; let H = 0; let dpr = 1;
    const fit = () => { dpr = Math.min(1.5, window.devicePixelRatio || 1);   // (sharp enough, and fast every frame)
      W = window.innerWidth; H = window.innerHeight; cv.width = W * dpr; cv.height = H * dpr; };
    fit(); window.addEventListener('resize', fit);
    const bands = new Float32Array(N); const raw = new Float32Array(N); const hist = Array.from({ length: HIST }, () => new Float32Array(N)); let h0 = 0;
    const cam = { x: 0, y: 0, rot: 0, kick: 0, by: 0, bv: 0, tr: 0, tv: 0, dir: 1, glitch: 0, flash: 0, lastFlash: 0 };
    let parts = []; let sparks = []; let bits = []; let waves = []; let bolts = []; let boltT = 0; let bass = 0; let level = 0.5; let lastPh = 0;
    let spin = 0; let tunnelZ = 0; let gridZ = 0; const orbitA = new Float32Array(6); let buf = null;
    const sky = Array.from({ length: 220 }, () => ({ x: rnd(0, 1), y: rnd(0, 1), z: rnd(0, 1), a: rnd(0, P2) }));   // the far stars of Space and Aurora
    let cover = { img: null, colors: ['#e0303a', '#7c3aed', '#0ea5e9'], grey: true }; let coverFor = null; let blurred = null; let small = null; let pal = cover.colors.map(lift);
    const prepare = async (tr) => {
      coverFor = tr?.id || null; cover = await loadCover(tr?.artwork); if (coverFor !== (tr?.id || null)) return;
      blurred = null; small = null; pal = cover.colors.map(lift);
      if (cover.img) {   // the blurred, darkened cover behind everything, and a small square one for the kaleidoscope, drawn once
        const b = document.createElement('canvas'); b.width = 320; b.height = 320; const bg = b.getContext('2d');
        bg.filter = 'blur(14px) saturate(1.2)'; bg.drawImage(cover.img, -30, -30, 380, 380); bg.filter = 'none';
        bg.fillStyle = 'rgba(0,0,0,.55)'; bg.fillRect(0, 0, 320, 320); blurred = b;
        const s = document.createElement('canvas'); s.width = 256; s.height = 256; const sg = s.getContext('2d'); const iw = cover.img.naturalWidth; const ih = cover.img.naturalHeight; const m = Math.min(iw, ih);
        sg.filter = 'saturate(1.3)'; sg.drawImage(cover.img, (iw - m) / 2, (ih - m) / 2, m, m, 0, 0, 256, 256); small = s;
      }
    };
    // a soft glowing dot in a colour, drawn once and then stamped (much faster than a blur)
    const sprites = new Map();
    const sprite = (col) => {
      let s = sprites.get(col); if (s) return s;
      s = document.createElement('canvas'); s.width = 64; s.height = 64; const x = s.getContext('2d'); const rg = x.createRadialGradient(32, 32, 0, 32, 32, 32);
      rg.addColorStop(0, '#ffffff'); rg.addColorStop(0.2, col); rg.addColorStop(1, `${col}00`); x.fillStyle = rg; x.fillRect(0, 0, 64, 64); sprites.set(col, s); return s;
    };
    const seed = (n) => Array.from({ length: n }, () => ({ x: rnd(0, 1), y: rnd(0, 1), z: rnd(0.2, 1), a: rnd(0, P2), s: rnd(0.4, 1), v: rnd(0.3, 1), c: Math.floor(rnd(0, 4)) }));
    let partKind = null; let partN = 0;
    const t0 = performance.now(); let lastNow = t0;
    const frame = () => {
      if (!alive) return;
      const { opts: o, playing: on, track: tr, reduce: still } = sim.current; const sens = Math.max(0.3, Math.min(3, Number(o.sensitivity) || 1));
      if ((tr?.id || null) !== coverFor) prepare(tr);
      const now = performance.now(); const tt = (now - t0) / 1000; const dt = Math.min(0.05, (now - lastNow) / 1000); lastNow = now;
      const want = o.particles === 'none' ? 0 : Math.round((o.amount / 100) * (PARTS[o.particles] || 100));
      if (partKind !== o.particles || partN !== want) { partKind = o.particles; partN = want; parts = seed(want); }
      // the sound: the real one (shared tab audio) or one made up from the song's energy
      let beat = false; const l = live.current;
      if (l) {   // the real sound: each band's peak, the whole spectrum scaled to its recent loudest (quiet and loud songs both fill it), the highs lifted a little
        l.an.getByteFrequencyData(l.data); const d = l.data; const top = Math.floor(d.length * 0.6); let max = 0;
        for (let i = 0; i < N; i++) {
          const a = Math.max(1, Math.floor(1.5 * (top / 1.5) ** (i / N))); const b = Math.max(a + 1, Math.floor(1.5 * (top / 1.5) ** ((i + 1) / N)));
          let pk = 0; for (let k = a; k < b; k++) if (d[k] > pk) pk = d[k];
          raw[i] = (pk / 255) * (1 + (i / N) * 0.9); if (raw[i] > max) max = raw[i];
        }
        l.gain = Math.max(max, l.gain * 0.996, 0.25);
        for (let i = 0; i < N; i++) { const v = Math.min(1, (raw[i] / l.gain) ** 1.5 * sens); bands[i] += (v - bands[i]) * (v > bands[i] ? 1 : 0.32); }
        // the beat: a sudden jump in the low end (how much the bass bins rose since the last frame) well above its usual
        let lo = 0; let flux = 0; for (let k = 1; k < 4; k++) { lo += d[k]; flux += Math.max(0, d[k] - l.prev[k]); l.prev[k] = d[k]; } lo /= 3 * 255; flux /= 3 * 255;   // (the kick drum: about 45-180 Hz)
        if (flux > l.flux * (1.8 / Math.sqrt(sens)) + 0.025 / sens && lo > 0.25 / Math.sqrt(sens) && now - l.last > 150) { beat = true; l.last = now; }
        l.flux = l.flux * 0.9 + flux * 0.1; l.avg = l.avg * 0.97 + lo * 0.03;
        bass += (Math.min(1, (lo / Math.max(0.3, l.avg * 1.5)) * sens) - bass) * 0.8; level += (Math.min(1, l.avg * 1.5) - level) * 0.02;
      } else {
        const e = guessEnergy(tr, o.energy); level += (e - level) * 0.05;
        const bpm = level > 0.66 ? 140 : level > 0.33 ? 112 : 84; const len = 60 / bpm; const ph = (tt % len) / len;
        if (on && ph < lastPh) beat = true; lastPh = ph;
        const kick = on ? Math.exp(-ph * 7) : 0; const hat = on && level > 0.5 ? Math.exp(-(((tt + len / 2) % len) / len) * 12) : 0;
        for (let i = 0; i < N; i++) {
          const f = i / N; const wob = 0.5 + 0.5 * Math.sin(tt * (2.1 + f * 4.7) + i * 1.7) * Math.sin(tt * (0.9 + f * 1.3) + i * 0.61);
          const body = (0.35 + 0.4 * level) * wob * (1 - f * 0.45);
          const v = on ? Math.min(1, kick * Math.max(0, 1 - f * 1.8) * (0.7 + 0.3 * level) + body * (0.5 + 0.5 * kick) + hat * f * 0.45) : 0;
          const w = Math.min(1, v * sens); bands[i] += (w - bands[i]) * (w > bands[i] ? 0.6 : 0.18);
        }
        bass += (kick * (0.4 + 0.6 * level) - bass) * 0.4;
      }
      h0 = (h0 + 1) % HIST; hist[h0].set(bands);
      const ago = (k) => hist[(h0 - k + HIST * 2) % HIST];
      // the shake, as hard as the song (or the setting) says, in its own way: a jolt, a zoom punch, a drop that springs back, a tilt from side to side,
      // a rumble that follows the bass all the time, or a glitch
      const strength = still ? 0 : o.shake === 'off' ? 0 : o.shake === 'low' ? 6 : o.shake === 'medium' ? 14 : o.shake === 'high' ? 28 : 4 + 26 * level ** 1.6;
      const st = o.shakeType || 'shake';
      if (beat && strength) {
        if (st === 'shake') { cam.x += rnd(-1, 1) * strength; cam.y += rnd(-1, 1) * strength; cam.rot += rnd(-1, 1) * strength * 0.0016; cam.kick = Math.min(1, cam.kick + 0.5 + level * 0.5); }
        else if (st === 'punch') cam.kick = Math.min(1.3, cam.kick + 0.8 + level * 0.5);
        else if (st === 'bounce') { cam.bv += strength * 0.6; cam.kick = Math.min(1, cam.kick + 0.25); }
        else if (st === 'tilt') { cam.dir = -cam.dir; cam.tv += cam.dir * strength * 0.0012; cam.kick = Math.min(1, cam.kick + 0.3); }
        else if (st === 'rumble') cam.kick = Math.min(1, cam.kick + 0.4);
        else if (st === 'glitch') { cam.glitch = 1; cam.x += rnd(-1, 1) * strength * 0.6; cam.kick = Math.min(1, cam.kick + 0.3); }
      }
      if (st === 'rumble' && strength) { const q = strength * (0.12 + bass * 0.6); cam.x = rnd(-1, 1) * q; cam.y = rnd(-1, 1) * q; cam.rot = rnd(-1, 1) * q * 0.0009; }
      else { cam.x *= 0.84; cam.y *= 0.84; cam.rot *= 0.86; }
      cam.kick *= 0.88; cam.bv += -cam.by * 0.2; cam.bv *= 0.74; cam.by += cam.bv; cam.tv += -cam.tr * 0.1; cam.tv *= 0.82; cam.tr += cam.tv;   // (the bounce and the tilt overshoot a little, like something hit)
      if (beat && o.flash && !still && now - cam.lastFlash > 340) { cam.flash = 1; cam.lastFlash = now; }   // (at most about three flashes a second)
      if (beat && o.particles === 'sparks') for (let i = 0; i < 8 + level * 18; i++) sparks.push({ a: rnd(0, P2), d: 0, v: rnd(4, 11) * (0.6 + level), life: 1 });
      if (on) spin += dt * (o.shape === 'vinyl' ? 3.49 : o.shape === 'spin' ? 0.5 + bass * 2.5 : 0);   // (a record turns at 33⅓)

      // ---------------------------------------------------------------- draw
      const R = Math.min(W, H) * 0.15; const cx0 = W / 2; const cy0 = H * 0.46; const far = Math.hypot(W, H);
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
      g.save();
      const zoom = 1 + cam.kick * (st === 'punch' ? 0.1 * Math.max(0.35, strength / 28) : 0.035) * (strength ? 1 : 0);
      g.translate(W / 2 + cam.x, H / 2 + cam.y + cam.by); g.rotate(cam.rot + cam.tr); g.scale(zoom, zoom); g.translate(-W / 2, -H / 2);
      let bgKind = o.background === 'auto' ? (level > 0.66 ? 'smoke' : level < 0.34 ? 'colorful' : 'cover') : o.background;
      if (bgKind === 'kaleido' && !small) bgKind = 'colorful';
      const [c1, c2, c3] = cover.colors; const smokeColor = cover.grey ? (level > 0.6 ? '#d6283a' : '#9aa4b8') : c1;
      const pad = 60; const fill = (col) => { g.fillStyle = col; g.fillRect(-pad, -pad, W + pad * 2, H + pad * 2); };
      const stars = (alpha) => { for (const s of sky) { g.fillStyle = `rgba(255,255,255,${alpha * (0.25 + 0.75 * s.z) * (0.6 + 0.4 * Math.sin(tt * (0.5 + s.z * 2) + s.a))})`; const w = s.z > 0.85 ? 2 : 1.2; g.fillRect(s.x * W, s.y * H, w, w); } };
      if (bgKind === 'cover' && blurred) g.drawImage(blurred, -pad, -pad, W + pad * 2, H + pad * 2);
      else if (bgKind === 'colorful') {   // a slowly turning rainbow that starts from the cover's colour
        const hh = (hueOf(c1) + tt * 9) % 360; const grd = g.createLinearGradient(0, 0, W, H); const sh = (Math.sin(tt * 0.15) + 1) / 2;
        grd.addColorStop(0, `hsl(${hh} 75% 46%)`); grd.addColorStop(0.45 + sh * 0.2, `hsl(${(hh + 70) % 360} 72% 42%)`); grd.addColorStop(1, `hsl(${(hh + 160) % 360} 70% 40%)`);
        fill(grd); fill('rgba(8,8,20,.28)');
      } else if (bgKind === 'tunnel') {   // rings rushing toward you, faster with the bass
        fill('#030306'); tunnelZ += 0.0035 + bass * 0.03 + level * 0.003; const hh = hueOf(c1);
        for (let k = 0; k < 16; k++) {
          const z = (k / 16 + tunnelZ) % 1; const r = 6 + far * 0.75 * z ** 2.4; const rot = tt * 0.25 + z * 1.6;
          g.beginPath(); for (let s = 0; s <= 6; s++) { const a = rot + (s / 6) * P2; const x = cx0 + Math.cos(a) * r; const y = cy0 + Math.sin(a) * r; if (s) g.lineTo(x, y); else g.moveTo(x, y); }
          g.strokeStyle = `hsla(${(hh + k * 14 + tt * 20) % 360},85%,60%,${Math.min(1, z * 1.4) * (0.35 + bass * 0.5)})`; g.lineWidth = 1 + z * 6; g.stroke();
        }
      } else if (bgKind === 'retro') {   // a synthwave sunset: a striped sun behind the cover, over a neon grid floor rolling toward you
        const hz = H * 0.66; const skyG = g.createLinearGradient(0, 0, 0, hz); skyG.addColorStop(0, '#07011a'); skyG.addColorStop(1, '#3a0b4f'); g.fillStyle = skyG; g.fillRect(-pad, -pad, W + pad * 2, hz + pad);
        const sr = Math.min(W, H) * 0.34 * (1 + bass * 0.04); const sy = hz - sr * 0.55; const sun = g.createLinearGradient(0, sy - sr, 0, sy + sr);
        sun.addColorStop(0, '#ffd23f'); sun.addColorStop(0.55, '#ff4f8b'); sun.addColorStop(1, '#a01aff');
        g.save(); g.beginPath(); g.arc(cx0, sy, sr, 0, P2); g.clip(); g.fillStyle = sun; g.fillRect(cx0 - sr, sy - sr, sr * 2, sr * 2);
        g.fillStyle = '#300a48'; for (let k = 0; k < 7; k++) g.fillRect(cx0 - sr, sy + sr * (0.08 + k * 0.13), sr * 2, 2 + k * 2.2);
        g.restore();
        g.fillStyle = '#0c0118'; g.fillRect(-pad, hz, W + pad * 2, H - hz + pad); gridZ = (gridZ + 0.008 + bass * 0.035) % 1;
        g.strokeStyle = `rgba(255,60,200,${0.5 + bass * 0.45})`; g.lineWidth = 1.5; g.beginPath();
        for (let k = 0; k < 14; k++) { const z = (k + gridZ) / 14; const y = hz + (H + pad - hz) * z * z; g.moveTo(-pad, y); g.lineTo(W + pad, y); }
        for (let i = -14; i <= 14; i++) { g.moveTo(cx0 + i * W * 0.012, hz); g.lineTo(cx0 + i * W * 0.16, H + pad); }
        g.stroke();
        const hg = g.createLinearGradient(0, hz - 26, 0, hz + 26); hg.addColorStop(0, 'rgba(255,80,200,0)'); hg.addColorStop(0.5, `rgba(255,90,210,${0.45 + bass * 0.4})`); hg.addColorStop(1, 'rgba(255,80,200,0)');
        g.fillStyle = hg; g.fillRect(-pad, hz - 26, W + pad * 2, 52);
      } else if (bgKind === 'aurora') {   // curtains of light drifting over a night sky
        const skyG = g.createLinearGradient(0, 0, 0, H); skyG.addColorStop(0, '#01030a'); skyG.addColorStop(1, '#0a1630'); fill(skyG); stars(0.6);
        g.globalCompositeOperation = 'lighter'; const cols = cover.grey ? ['#3dffa8', '#2bd4ff', '#a35bff'] : [c1, c2, c3];
        for (let k = 0; k < 3; k++) {
          const base = H * (0.2 + k * 0.14); const hgt = H * (0.2 + bass * 0.12); const ys = [];
          for (let x = -pad; x <= W + pad; x += 24) ys.push([x, base + Math.sin(x * 0.0035 + tt * (0.25 + k * 0.08) + k * 2) * H * 0.07 + Math.sin(x * 0.009 - tt * 0.4 + k) * H * 0.025]);
          const gr2 = g.createLinearGradient(0, base - H * 0.12, 0, base + hgt); gr2.addColorStop(0, `${cols[k]}00`); gr2.addColorStop(0.35, `${cols[k]}${hex2(0.3 + bass * 0.2)}`); gr2.addColorStop(1, `${cols[k]}00`);
          g.beginPath(); ys.forEach(([x, y], i) => (i ? g.lineTo(x, y - H * 0.1) : g.moveTo(x, y - H * 0.1))); for (let i = ys.length - 1; i >= 0; i--) g.lineTo(ys[i][0], ys[i][1] + hgt);
          g.closePath(); g.fillStyle = gr2; g.fill();
        }
        g.globalCompositeOperation = 'source-over';
      } else if (bgKind === 'space') { fill('#020208'); stars(1); }   // (its nebulae are the clouds below)
      else if (bgKind === 'rays') {   // beams of light turning slowly round the cover, flaring with the bass
        fill('#040406'); g.globalCompositeOperation = 'lighter';
        const beams = [c1, c2].map((col) => { const rg = g.createRadialGradient(cx0, cy0, R * 0.5, cx0, cy0, far * 0.7); rg.addColorStop(0, `${col}${hex2(0.3 + bass * 0.35)}`); rg.addColorStop(1, `${col}00`); return rg; });
        const wdt = 0.09 + bass * 0.06;
        for (let i = 0; i < 12; i++) { const a = tt * 0.1 + (i / 12) * P2; g.beginPath(); g.moveTo(cx0, cy0); g.arc(cx0, cy0, far, a - wdt, a + wdt); g.closePath(); g.fillStyle = beams[i % 2]; g.fill(); }
        g.globalCompositeOperation = 'source-over';
      } else if (bgKind === 'kaleido') {   // the cover, mirrored round into a slowly turning kaleidoscope
        fill('#050506'); const S = 10; const wa = P2 / S; const sz = far; const ox = Math.sin(tt * 0.13) * sz * 0.1; const oy = Math.cos(tt * 0.11) * sz * 0.1;   // (a corner is about far / 2 away)
        for (let i = 0; i < S; i++) {
          g.save(); g.translate(cx0, cy0); g.rotate((i + (i % 2)) * wa + tt * 0.06); if (i % 2) g.scale(1, -1);
          g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, far, -0.003, wa + 0.003); g.closePath(); g.clip(); g.drawImage(small, ox - sz * 0.15, oy - sz * 0.5, sz, sz); g.restore();
        }
        fill(`rgba(0,0,0,${0.5 - bass * 0.15})`);
      } else if (bgKind === 'black') fill('#000');
      else fill('#050506');
      if (bgKind === 'smoke' || bgKind === 'colorful' || bgKind === 'space' || (bgKind === 'cover' && !blurred)) {   // slow clouds of colour, brighter with the bass
        g.globalCompositeOperation = 'lighter';
        const alpha = bgKind === 'smoke' ? 0.16 : bgKind === 'space' ? 0.08 + bass * 0.06 : 0.12 + bass * 0.12;
        for (let i = 0; i < 6; i++) {
          const x = W * (0.5 + 0.42 * Math.sin(tt * (0.07 + i * 0.013) + i * 2.1)); const y = H * (0.5 + 0.4 * Math.cos(tt * (0.05 + i * 0.011) + i * 1.3)); const r = Math.max(W, H) * (0.28 + 0.06 * Math.sin(tt * 0.3 + i));
          const rg = g.createRadialGradient(x, y, 0, x, y, r); const col = bgKind === 'smoke' ? smokeColor : [c1, c2, c3][i % 3];
          rg.addColorStop(0, `${col}${hex2(alpha)}`); rg.addColorStop(1, `${col}00`);
          g.fillStyle = rg; g.fillRect(x - r, y - r, r * 2, r * 2);
        }
        g.globalCompositeOperation = 'source-over';
      }
      // particles
      const hi = bands.slice(N * 0.6).reduce((a, b) => a + b, 0) / (N * 0.4); const four = [c1, c2, c3, '#ffffff'];
      if (partKind === 'embers' || partKind === 'fireflies') g.globalCompositeOperation = 'lighter';
      if (partKind === 'notes') { g.textAlign = 'center'; g.textBaseline = 'middle'; }
      for (const p of parts) {
        if (partKind === 'bokeh') {
          p.y -= (0.0006 + p.v * 0.0012) * (1 + bass * 2.5); p.x += Math.sin(tt * p.v + p.a) * 0.0004; if (p.y < -0.05) { p.y = 1.05; p.x = rnd(0, 1); }
          g.fillStyle = `rgba(255,255,255,${(0.15 + 0.55 * p.z) * (0.6 + 0.4 * Math.sin(tt * 2 * p.v + p.a))})`; g.beginPath(); g.arc(p.x * W, p.y * H, 1 + p.z * 3.2 * p.s, 0, P2); g.fill();
        } else if (partKind === 'stars') {
          const a = Math.max(0, Math.sin(tt * (1 + p.v * 2) + p.a)) * (0.3 + hi * 1.6); const s = 2 + p.z * 4; const x = p.x * W; const y = p.y * H;
          g.strokeStyle = `rgba(255,255,255,${Math.min(1, a)})`; g.lineWidth = 1.2; g.beginPath(); g.moveTo(x - s, y); g.lineTo(x + s, y); g.moveTo(x, y - s); g.lineTo(x, y + s); g.stroke();
        } else if (partKind === 'squares') {
          p.y -= 0.00025 * p.v; p.a += 0.002 * p.v; if (p.y < -0.1) { p.y = 1.1; p.x = rnd(0, 1); }
          const s = 18 + p.z * 34; g.save(); g.translate(p.x * W, p.y * H); g.rotate(p.a); g.strokeStyle = `rgba(255,255,255,${0.08 + 0.18 * p.z + bass * 0.15})`; g.lineWidth = 1.4; g.strokeRect(-s / 2, -s / 2, s, s); g.restore();
        } else if (partKind === 'sparks') {   // a few drifting embers between the bursts
          p.y -= 0.0005 * p.v; if (p.y < -0.05) { p.y = 1.05; p.x = rnd(0, 1); }
          g.fillStyle = `rgba(255,${level > 0.6 ? 120 : 220},${level > 0.6 ? 110 : 255},${0.2 + 0.4 * p.z})`; g.fillRect(p.x * W, p.y * H, 1.6, 1.6);
        } else if (partKind === 'warp') {   // stars rushing out from the middle, faster with the bass
          const sp = (0.004 + p.v * 0.006) * (1 + bass * 5 + level); p.z += sp * (p.z + 0.08); if (p.z > 1.1) { p.z = rnd(0.02, 0.15); p.a = rnd(0, P2); }
          const r1 = p.z * far * 0.55; const r0 = Math.max(0, r1 - (6 + sp * far * 1.6)); const ca = Math.cos(p.a); const sa = Math.sin(p.a);
          g.strokeStyle = `rgba(255,255,255,${Math.min(1, p.z * 1.2) * 0.85})`; g.lineWidth = 0.6 + p.z * 2.2; g.beginPath(); g.moveTo(cx0 + ca * r0, cy0 + sa * r0); g.lineTo(cx0 + ca * r1, cy0 + sa * r1); g.stroke();
        } else if (partKind === 'embers') {   // glowing embers rising and flickering, brighter with the bass
          p.y -= (0.0008 + p.v * 0.0018) * (1 + bass * 2); p.x += Math.sin(tt * 1.7 * p.v + p.a) * 0.0009; if (p.y < -0.05) { p.y = 1.05; p.x = rnd(0, 1); }
          const s = (6 + p.z * 14) * (0.7 + 0.3 * Math.sin(tt * 9 * p.v + p.a)) * (1 + bass * 0.5); g.globalAlpha = 0.5 + 0.5 * p.z; g.drawImage(sprite(p.c % 2 ? '#ff7a2a' : '#ffb347'), p.x * W - s / 2, p.y * H - s / 2, s, s);
        } else if (partKind === 'fireflies') {   // soft lights wandering about and blinking
          p.a += rnd(-0.08, 0.08); p.x = (p.x + Math.cos(p.a) * 0.0006 * p.v + 1) % 1; p.y = (p.y + Math.sin(p.a) * 0.0006 * p.v + 1) % 1;
          const blink = 0.5 + 0.5 * Math.sin(tt * (1 + p.v * 2) + p.a * 3); const s = (14 + p.z * 22) * (0.4 + 0.6 * blink) * (1 + bass * 0.6);
          g.globalAlpha = 0.35 + 0.65 * blink; g.drawImage(sprite([c1, c2, '#eaff8f'][p.c % 3]), p.x * W - s / 2, p.y * H - s / 2, s, s);
        } else if (partKind === 'snow') {   // flakes drifting down
          p.y += (0.0006 + p.z * 0.0014) * (1 + bass * 0.8); p.x += Math.sin(tt * 0.8 * p.v + p.a) * 0.0005; if (p.y > 1.03) { p.y = -0.03; p.x = rnd(0, 1); }
          g.fillStyle = `rgba(255,255,255,${0.35 + 0.55 * p.z})`; g.beginPath(); g.arc(p.x * W, p.y * H, 1 + p.z * 2.6, 0, P2); g.fill();
        } else if (partKind === 'petals') {   // cherry-blossom petals tumbling down
          p.y += (0.0005 + p.z * 0.001) * (1 + bass); p.x += Math.sin(tt * 0.9 * p.v + p.a) * 0.0012 + 0.0004; p.a += 0.02 * p.v; if (p.y > 1.05) { p.y = -0.05; p.x = rnd(-0.1, 1); }
          const s = 5 + p.z * 7; g.save(); g.translate(p.x * W, p.y * H); g.rotate(p.a); g.scale(1, 0.35 + 0.65 * Math.abs(Math.sin(tt * 1.6 * p.v + p.a)));
          g.fillStyle = p.c % 2 ? `rgba(255,183,197,${0.55 + 0.4 * p.z})` : `rgba(255,214,224,${0.55 + 0.4 * p.z})`; g.beginPath(); g.ellipse(0, 0, s, s * 0.62, 0, 0, P2); g.fill(); g.restore();
        } else if (partKind === 'hearts') {   // hearts floating up, in the cover's colours
          p.y -= (0.0005 + p.v * 0.001) * (1 + bass * 1.5); p.x += Math.sin(tt * p.v + p.a) * 0.0006; if (p.y < -0.06) { p.y = 1.06; p.x = rnd(0, 1); }
          const s = (6 + p.z * 12) * (1 + bass * 0.4); g.save(); g.translate(p.x * W, p.y * H); g.rotate(Math.sin(tt * p.v + p.a) * 0.3);
          g.fillStyle = [c1, c2, '#ff4d8d'][p.c % 3]; g.globalAlpha = 0.45 + 0.45 * p.z; g.beginPath(); g.moveTo(0, s * 0.35);
          g.bezierCurveTo(-s * 1.1, -s * 0.35, -s * 0.45, -s * 1.05, 0, -s * 0.45); g.bezierCurveTo(s * 0.45, -s * 1.05, s * 1.1, -s * 0.35, 0, s * 0.35); g.fill(); g.restore();
        } else if (partKind === 'confetti') {   // confetti tumbling down, flipping over as it goes (and a burst on every beat, below)
          p.y += 0.0008 + p.z * 0.0012; p.x += Math.sin(tt * p.v + p.a) * 0.0006; p.a += 0.05 * p.v; if (p.y > 1.05) { p.y = -0.05; p.x = rnd(0, 1); }
          const s = 4 + p.z * 5; g.save(); g.translate(p.x * W, p.y * H); g.rotate(p.a); g.scale(Math.cos(tt * 3 * p.v + p.a), 1); g.fillStyle = four[p.c]; g.globalAlpha = 0.85; g.fillRect(-s, -s * 0.45, s * 2, s * 0.9); g.restore();
        } else if (partKind === 'bubbles') {   // bubbles rising and wobbling
          p.y -= (0.0006 + p.v * 0.0012) * (1 + bass); p.x += Math.sin(tt * 1.3 * p.v + p.a) * 0.0006; if (p.y < -0.06) { p.y = 1.06; p.x = rnd(0, 1); }
          const r = (6 + p.z * 18) * (1 + bass * 0.25); const x = p.x * W; const y = p.y * H;
          g.strokeStyle = `rgba(255,255,255,${0.15 + p.z * 0.35})`; g.lineWidth = 1.2; g.beginPath(); g.arc(x, y, r, 0, P2); g.stroke();
          g.fillStyle = `rgba(255,255,255,${0.2 + p.z * 0.3})`; g.beginPath(); g.arc(x - r * 0.38, y - r * 0.38, r * 0.2, 0, P2); g.fill();
        } else if (partKind === 'notes') {   // music notes floating up
          p.y -= (0.0005 + p.v * 0.0009) * (1 + bass * 1.5); p.x += Math.sin(tt * p.v + p.a) * 0.0005; if (p.y < -0.06) { p.y = 1.06; p.x = rnd(0, 1); }
          g.font = `700 ${Math.round((14 + p.z * 22) * (1 + bass * 0.3))}px system-ui, sans-serif`; g.fillStyle = `rgba(255,255,255,${0.3 + 0.55 * p.z})`; g.fillText(['♪', '♫', '♩', '♬'][p.c], p.x * W, p.y * H);
        }
      }
      g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
      if (sparks.length) {
        g.lineCap = 'round';
        sparks = sparks.filter((s) => (s.life -= 0.022) > 0);
        for (const s of sparks) { s.d += s.v; const r0 = R * 1.05 + s.d; const r1 = r0 + 10 + s.v * 2; g.strokeStyle = `rgba(255,${level > 0.6 ? 90 : 230},${level > 0.6 ? 90 : 255},${s.life})`; g.lineWidth = 1.6; g.beginPath(); g.moveTo(cx0 + Math.cos(s.a) * r0, cy0 + Math.sin(s.a) * r0); g.lineTo(cx0 + Math.cos(s.a) * r1, cy0 + Math.sin(s.a) * r1); g.stroke(); }
      }
      if (beat && partKind === 'confetti') for (let i = 0; i < 10 + level * 20; i++) { const a = rnd(0, P2); const v = rnd(3, 10) * (0.6 + level); bits.push({ x: cx0 + Math.cos(a) * R, y: cy0 + Math.sin(a) * R, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 2, a: rnd(0, P2), c: Math.floor(rnd(0, 4)), life: 1 }); }
      if (bits.length) {   // the confetti burst: thrown out of the cover, then falling
        bits = bits.filter((b) => (b.life -= 0.012) > 0 && partKind === 'confetti');
        for (const b of bits) { b.x += b.vx; b.y += b.vy; b.vx *= 0.985; b.vy += 0.22; b.a += 0.15; g.save(); g.translate(b.x, b.y); g.rotate(b.a); g.globalAlpha = b.life; g.fillStyle = four[b.c]; g.fillRect(-4, -2, 8, 4); g.restore(); }
        g.globalAlpha = 1;
      }
      // a dark edge round the screen, so the middle stands out
      const vg = g.createRadialGradient(cx0, cy0, Math.min(W, H) * 0.35, cx0, cy0, far * 0.6); vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.55)'); fill(vg);
      // the sound around the cover, in white, the cover's colours or a rainbow
      const val = (k) => bands[Math.max(0, Math.min(N - 1, Math.floor(k)))];
      const avg = (a, b) => { let s = 0; for (let k = a; k < b; k++) s += bands[k]; return s / Math.max(1, b - a); };
      const mirror = (i, M) => (i < M / 2 ? i : M - i) / (M / 2);   // (round the circle, the bass at the top and the highs at the bottom, both sides alike)
      const ink0 = o.color === 'auto' || !o.color ? AUTO_COLOR[o.style] || 'white' : o.color;
      const ink = (f, a) => {
        if (ink0 === 'rainbow') return `hsla(${(f * 300 + tt * 50) % 360},95%,66%,${a})`;
        if (ink0 === 'cover') { const [p, q] = pal; return `rgba(${Math.round(p[0] + (q[0] - p[0]) * f)},${Math.round(p[1] + (q[1] - p[1]) * f)},${Math.round(p[2] + (q[2] - p[2]) * f)},${a})`; }
        return `rgba(255,255,255,${a})`;
      };
      const loop = (pts) => {   // a smooth closed curve through the points
        const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]; const m0 = mid(pts[pts.length - 1], pts[0]); g.beginPath(); g.moveTo(m0[0], m0[1]);
        for (let i = 0; i < pts.length; i++) { const p = pts[i]; const q = mid(p, pts[(i + 1) % pts.length]); g.quadraticCurveTo(p[0], p[1], q[0], q[1]); }
        g.closePath();
      };
      const white = 'rgba(255,255,255,.92)';
      g.lineCap = 'butt';
      if (o.style === 'wings') {   // bars fanning out to both sides, the bass in the middle
        g.lineWidth = Math.max(1.5, R * 0.018);
        const M = 64;
        for (let i = 0; i < M; i++) {
          const a = -Math.PI / 2 + ((i + 0.5) / M) * Math.PI; const f = Math.abs(i - (M - 1) / 2) / (M / 2); const v = val(f * N * 0.9);
          const len = 6 + v * R * 1.6 * (0.45 + 0.55 * Math.cos(a) ** 0.6); g.strokeStyle = ink(i / M, 0.82);
          for (const side of [1, -1]) { const ca = Math.cos(a) * side; const sa = Math.sin(a); g.beginPath(); g.moveTo(cx0 + ca * R * 1.04, cy0 + sa * R * 1.04); g.lineTo(cx0 + ca * (R * 1.04 + len), cy0 + sa * (R * 1.04 + len)); g.stroke(); }
        }
      } else if (o.style === 'outline') {   // smooth mirrored shapes that stretch out with the sound, the bass at the top ("horns")
        const K = 18;
        for (const [scale, alpha, wdt] of [[1.3, 0.35, 2], [1, 0.95, 3.4]]) {
          const pts = [];
          for (let i = 0; i < K * 2; i++) {   // the right half from the top down, then mirrored for the left
            const j = i < K ? i : K * 2 - 1 - i; const f = j / (K - 1); const v = avg(Math.floor(f * N * 0.9), Math.floor(f * N * 0.9) + 3);
            const a = -Math.PI / 2 + (i < K ? (j + 0.5) / K : -(j + 0.5) / K) * Math.PI; const r = R * 1.06 + v * R * (2.1 - f * 1.1) * scale;
            pts.push([cx0 + Math.cos(a) * r, cy0 + Math.sin(a) * r]);
          }
          loop(pts); g.strokeStyle = `${smokeColor}40`; g.lineWidth = wdt + 8; g.stroke(); g.strokeStyle = ink(0.5, alpha); g.lineWidth = wdt; g.stroke();
        }
      } else if (o.style === 'bars') {   // bars all the way round, in the cover's colours
        const M = 96; g.lineWidth = Math.max(2, (P2 * R) / M * 0.55); g.lineCap = 'round';
        for (let i = 0; i < M; i++) { const a = (i / M) * P2 - Math.PI / 2; const f = mirror(i, M); const len = 4 + val(f * N * 0.95) * R * 1.35; g.strokeStyle = ink(f, 1); g.beginPath(); g.moveTo(cx0 + Math.cos(a) * R * 1.08, cy0 + Math.sin(a) * R * 1.08); g.lineTo(cx0 + Math.cos(a) * (R * 1.08 + len), cy0 + Math.sin(a) * (R * 1.08 + len)); g.stroke(); }
      } else if (o.style === 'ring') {   // a wobbling ring, a little looser on every beat
        for (const [k, alpha] of [[0, 0.9], [1, 0.4], [2, 0.2]]) {
          g.beginPath();
          for (let i = 0; i <= 90; i++) { const a = (i / 90) * P2; const r = R * (1.08 + k * 0.07) + Math.sin(a * 5 + tt * 1.4 + k) * (3 + bass * R * 0.2) + Math.sin(a * 9 - tt * 2.1) * (2 + val(i / 90 * N) * R * 0.18); const x = cx0 + Math.cos(a) * r; const y = cy0 + Math.sin(a) * r; if (i) g.lineTo(x, y); else g.moveTo(x, y); }
          g.closePath(); g.strokeStyle = ink(k / 3, alpha); g.lineWidth = 2; g.stroke();
        }
      } else if (o.style === 'dots') {   // columns of dots all the way round, like a round LED meter
        const M = 72; const dr = Math.max(1.4, R * 0.02);
        for (let i = 0; i < M; i++) {
          const a = (i / M) * P2 - Math.PI / 2; const f = mirror(i, M); const n = Math.round(val(f * N * 0.95) * 9); if (!n) continue; const ca = Math.cos(a); const sa = Math.sin(a);
          g.beginPath(); for (let k = 0; k < n; k++) { const r = R * 1.12 + k * R * 0.085; const x = cx0 + ca * r; const y = cy0 + sa * r; const d = dr * (1 - k * 0.05); g.moveTo(x + d, y); g.arc(x, y, d, 0, P2); }
          g.fillStyle = ink(f, 0.9); g.fill();
        }
      } else if (o.style === 'layers') {   // stacked rings of the spectrum, each a moment behind the one under it and a little bigger: the "trap" look
        const K = 72;
        for (let k = 4; k >= 0; k--) {
          const d = ago(k * 2); const amp = R * (0.75 + k * 0.28); const pts = [];
          for (let i = 0; i < K; i++) { const a = (i / K) * P2 - Math.PI / 2; const r = R * 1.02 + d[Math.min(N - 1, Math.floor(mirror(i, K) * N * 0.9))] * amp; pts.push([cx0 + Math.cos(a) * r, cy0 + Math.sin(a) * r]); }
          loop(pts);
          if (!k) g.fillStyle = 'rgba(255,255,255,.95)';
          else if (ink0 === 'rainbow') g.fillStyle = `hsla(${(k * 70 + tt * 40) % 360},90%,60%,.85)`;
          else if (ink0 === 'cover') { const p = pal[(k - 1) % 3]; g.fillStyle = `rgba(${p[0]},${p[1]},${p[2]},.85)`; }
          else g.fillStyle = `rgba(255,255,255,${0.1 + (4 - k) * 0.12})`;
          g.fill();
        }
      } else if (o.style === 'spikes') {   // a sharp star, every band a spike, with a fainter one a moment behind
        const M = 56;
        for (const [k, alpha, grow] of [[5, 0.35, 1.25], [0, 1, 1]]) {
          const d = ago(k); g.beginPath();
          for (let i = 0; i < M * 2; i++) {
            const f = mirror(i >> 1, M); const a = (i / (M * 2)) * P2 - Math.PI / 2 + (k ? Math.PI / M : 0); const r = i % 2 ? R * 1.05 : R * 1.05 + 5 + d[Math.min(N - 1, Math.floor(f * N * 0.95))] * R * 1.45 * grow;
            const x = cx0 + Math.cos(a) * r; const y = cy0 + Math.sin(a) * r; if (i) g.lineTo(x, y); else g.moveTo(x, y);
          }
          g.closePath(); g.fillStyle = ink(0.3, 0.14 * alpha); g.fill(); g.strokeStyle = ink(0.7, 0.95 * alpha); g.lineWidth = k ? 1 : 1.8; g.stroke();
        }
      } else if (o.style === 'orbit') {   // arcs circling the cover at their own speeds: the bass, the middle and the highs each turn two rings
        const e3 = [avg(0, 6), avg(6, 20), avg(20, N)]; g.lineCap = 'round';
        for (let k = 0; k < 6; k++) {
          const e = e3[k % 3]; orbitA[k] += (0.004 + e * 0.05) * (k % 2 ? -1 : 1) * (1 + k * 0.15); const r = R * (1.16 + k * 0.15 + e * 0.08);
          const arcs = 2 + (k % 3); const len = 0.25 + e * 1.1; g.strokeStyle = ink(k / 5, 0.35 + e * 0.6); g.lineWidth = 1.5 + e * R * 0.05;
          g.beginPath(); for (let j = 0; j < arcs; j++) { const a = orbitA[k] + (j / arcs) * P2; g.moveTo(cx0 + Math.cos(a) * r, cy0 + Math.sin(a) * r); g.arc(cx0, cy0, r, a, a + len); } g.stroke();
          const sa = orbitA[k] * -1.6 + k; g.fillStyle = ink(k / 5, 0.95); g.beginPath(); g.arc(cx0 + Math.cos(sa) * r, cy0 + Math.sin(sa) * r, 2 + e * 5, 0, P2); g.fill();
        }
      } else if (o.style === 'bloom') {   // petals that open with the sound, two layers turning opposite ways
        const M = 20;
        for (let layer = 1; layer >= 0; layer--) {
          for (let i = 0; i < M; i++) {
            const a = tt * 0.12 * (layer ? -1 : 1) + ((i + layer * 0.5) / M) * P2; const f = mirror(i, M); const v = val(f * N * 0.9);
            const len = R * (0.3 + v * (layer ? 1.6 : 1.15)); const w = R * (0.1 + v * 0.1) * (layer ? 1.3 : 1); const ca = Math.cos(a); const sa = Math.sin(a);
            const mx = cx0 + ca * (R + len * 0.5); const my = cy0 + sa * (R + len * 0.5);
            g.beginPath(); g.moveTo(cx0 + ca * R, cy0 + sa * R); g.quadraticCurveTo(mx - sa * w, my + ca * w, cx0 + ca * (R + len), cy0 + sa * (R + len)); g.quadraticCurveTo(mx + sa * w, my - ca * w, cx0 + ca * R, cy0 + sa * R);
            g.fillStyle = ink(f, layer ? 0.15 + v * 0.25 : 0.3 + v * 0.45); g.fill(); if (!layer) { g.strokeStyle = ink(f, 0.9); g.lineWidth = 1.2; g.stroke(); }
          }
        }
      } else if (o.style === 'shockwave') {   // rings bursting out of the cover on every beat, over a thin circle that bends with the sound
        if (beat) { waves.push({ r: R * 1.08, life: 1, w: 2 + bass * 7 }); if (waves.length > 14) waves.shift(); }
        waves = waves.filter((w) => (w.life -= 0.014) > 0);
        for (const w of waves) { w.r += 2.5 + level * 4 + w.life * 7; g.beginPath(); g.arc(cx0, cy0, w.r, 0, P2); g.strokeStyle = ink(1 - w.life, w.life * 0.85); g.lineWidth = 1 + w.w * w.life; g.stroke(); }
        g.beginPath();
        for (let i = 0; i < 120; i++) { const a = (i / 120) * P2 - Math.PI / 2; const r = R * 1.1 + val(mirror(i, 120) * N * 0.9) * R * 0.45; const x = cx0 + Math.cos(a) * r; const y = cy0 + Math.sin(a) * r; if (i) g.lineTo(x, y); else g.moveTo(x, y); }
        g.closePath(); g.strokeStyle = ink(0.5, 0.95); g.lineWidth = 2.5; g.stroke();
      } else if (o.style === 'electric') {   // lightning crackling round the cover, wilder with the bass, with bolts flying out on the beat
        if (now - boltT > 55 || beat) {
          boltT = now; bolts = []; const n = 4 + Math.round(bass * 6 + level * 2);
          for (let b = 0; b < n; b++) { const a0 = rnd(0, P2); const span = rnd(0.6, 1.6); const pts = []; for (let s = 0; s <= 14; s++) { const a = a0 + (span * s) / 14; const r = R * 1.15 + rnd(-1, 1) * R * (0.06 + bass * 0.2) + val((((a % P2) + P2) % P2) / P2 * N) * R * 0.45; pts.push([Math.cos(a) * r, Math.sin(a) * r]); } bolts.push(pts); }
          if (beat) for (let b = 0; b < 2 + Math.round(bass * 4); b++) { const a = rnd(0, P2); const len = R * (0.5 + bass * 1.2); const pts = []; for (let s = 0; s <= 8; s++) { const r = R * 1.1 + (len * s) / 8; const aa = a + rnd(-0.08, 0.08); pts.push([Math.cos(aa) * r, Math.sin(aa) * r]); } bolts.push(pts); }
        }
        g.beginPath(); g.arc(cx0, cy0, R * 1.13, 0, P2); g.strokeStyle = ink(0.5, 0.25); g.lineWidth = 1.5; g.stroke(); g.lineJoin = 'round';
        const halo = ink0 === 'white' ? 'rgba(130,190,255,.35)' : ink(0.5, 0.35);
        for (const pts of bolts) {
          g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(cx0 + x, cy0 + y) : g.moveTo(cx0 + x, cy0 + y)));
          g.strokeStyle = halo; g.lineWidth = 10; g.stroke(); g.strokeStyle = ink0 === 'white' ? white : ink(0.5, 0.95); g.lineWidth = 2.2; g.stroke();
        }
        g.lineJoin = 'miter';
      }
      // the cover, a little bigger on the bass: a circle, a rounded square, a turning record with the cover as its label, or a spinning circle
      const rr = R * (1 + bass * 0.07);
      const gr = rr * (1.55 + bass * 0.35); const glow = g.createRadialGradient(cx0, cy0, rr * 0.92, cx0, cy0, gr); glow.addColorStop(0, `${smokeColor}aa`); glow.addColorStop(1, `${smokeColor}00`);
      g.fillStyle = glow; g.beginPath(); g.arc(cx0, cy0, gr, 0, P2); g.fill();
      const art = (size) => { if (!cover.img) return; const iw = cover.img.naturalWidth; const ih = cover.img.naturalHeight; const s = size / Math.min(iw, ih); g.drawImage(cover.img, (-iw * s) / 2, (-ih * s) / 2, iw * s, ih * s); };
      const outline = () => { g.beginPath(); if (o.shape === 'square') { const h = rr * 0.88; if (g.roundRect) g.roundRect(cx0 - h, cy0 - h, h * 2, h * 2, rr * 0.14); else g.rect(cx0 - h, cy0 - h, h * 2, h * 2); } else g.arc(cx0, cy0, rr, 0, P2); g.closePath(); };
      if (o.shape === 'vinyl') {
        g.fillStyle = '#0b0b0d'; g.beginPath(); g.arc(cx0, cy0, rr, 0, P2); g.fill();
        g.beginPath(); for (let k = 0; k < 14; k++) { const r = rr * (0.5 + k * 0.034); g.moveTo(cx0 + r, cy0); g.arc(cx0, cy0, r, 0, P2); } g.strokeStyle = 'rgba(255,255,255,.06)'; g.lineWidth = 1; g.stroke();
        g.save(); g.beginPath(); g.arc(cx0, cy0, rr, 0, P2); g.clip(); g.translate(cx0, cy0); g.rotate(-0.7);   // (the shine stays still while the record turns)
        const sh = g.createLinearGradient(-rr, 0, rr, 0); sh.addColorStop(0.3, 'rgba(255,255,255,0)'); sh.addColorStop(0.5, 'rgba(255,255,255,.13)'); sh.addColorStop(0.7, 'rgba(255,255,255,0)'); g.fillStyle = sh; g.fillRect(-rr, -rr, rr * 2, rr * 2);
        g.restore();
        g.save(); g.beginPath(); g.arc(cx0, cy0, rr * 0.42, 0, P2); g.clip(); g.translate(cx0, cy0); g.rotate(spin); g.fillStyle = '#222'; g.fillRect(-rr, -rr, rr * 2, rr * 2); art(rr * 0.84); g.restore();
        g.fillStyle = '#0b0b0d'; g.beginPath(); g.arc(cx0, cy0, rr * 0.035, 0, P2); g.fill();
        g.beginPath(); g.arc(cx0, cy0, rr, 0, P2); g.strokeStyle = 'rgba(255,255,255,.3)'; g.lineWidth = Math.max(1.5, R * 0.015); g.stroke();
      } else {
        g.save(); outline(); g.fillStyle = '#111'; g.fill(); g.clip(); g.translate(cx0, cy0); if (o.shape === 'spin') g.rotate(spin); art(rr * 2); g.restore();
        outline(); g.strokeStyle = white; g.lineWidth = Math.max(2, R * 0.03); g.stroke();
      }
      if (o.time && tr) { const pos = state.music.position || 0; g.font = `800 ${Math.round(R * 0.26)}px "Montserrat", system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.fillStyle = 'rgba(255,255,255,.85)'; g.fillText(clock(pos), cx0, cy0 + R * (o.style === 'none' ? 1.62 : 2.5)); }
      g.restore();
      // after the picture: the glitch (strips of the screen knocked sideways, and a ghost to each side) and the flash
      if (cam.glitch > 0.04) {
        if (!buf || buf.width !== cv.width || buf.height !== cv.height) { buf = document.createElement('canvas'); buf.width = cv.width; buf.height = cv.height; }
        buf.getContext('2d').drawImage(cv, 0, 0); g.setTransform(1, 0, 0, 1, 0, 0);
        for (let k = 0; k < 3 + cam.glitch * 7; k++) { const y = Math.random() * cv.height; const h = rnd(4, 40) * dpr; g.drawImage(buf, 0, y, cv.width, h, rnd(-1, 1) * 60 * dpr * cam.glitch, y, cv.width, h); }
        g.globalCompositeOperation = 'lighter'; g.globalAlpha = 0.16 * cam.glitch; g.drawImage(buf, 9 * dpr * cam.glitch, 0); g.drawImage(buf, -9 * dpr * cam.glitch, 0);
        g.globalCompositeOperation = 'screen'; g.globalAlpha = 0.35 * cam.glitch;
        for (let k = 0; k < 2; k++) { g.fillStyle = k ? c2 : c1; g.fillRect(0, Math.random() * cv.height, cv.width, rnd(2, 14) * dpr); }
        g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; cam.glitch *= 0.86;
      }
      if (cam.flash > 0.02) { g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = `rgba(255,255,255,${cam.flash * 0.2})`; g.fillRect(0, 0, cv.width, cv.height); cam.flash *= 0.8; }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { alive = false; cancelAnimationFrame(raf); window.removeEventListener('resize', fit); };
  }, []);

  const row = (key) => html`<div class="viz-row">${OPTIONS[key].map(([value, label]) => html`<button type="button" class=${cx('viz-chip', opts[key] === value && 'on')} onClick=${() => put(key, value)}>${t(label)}</button>`)}</div>`;
  const toggle = async () => (await import('/js/music.js')).music.toggle();
  return html`<div class="viz" role="dialog" aria-label=${t('Visualizer')}>
    <canvas ref=${canvas} class="viz-canvas"></canvas>
    <div class="viz-top">
      <button type="button" class=${cx('viz-btn', liveOn && 'on')} onClick=${startLive} data-tip=${liveOn ? t('Following the real sound (click to stop)') : t('Follow the real sound: Chrome asks to share this tab with its audio')}><${Icon} name="headphones" size=${18} />${liveOn ? t('Real sound') : t('Use the real sound')}</button>
      <button type="button" class="viz-btn" onClick=${shuffle} aria-label=${t('Shuffle the look')} data-tip=${t('Shuffle the look')}><${Icon} name="shuffle" size=${18} /></button>
      <button type="button" class=${cx('viz-btn', panel && 'on')} onClick=${() => setPanel(!panel)} aria-label=${t('Visualizer settings')}><${Icon} name="sliders" size=${18} /></button>
      <button type="button" class="viz-btn" onClick=${close} aria-label=${t('Close')}><${Icon} name="x" size=${20} /></button>
    </div>
    ${track ? html`<div class="viz-info"><button type="button" class="viz-play" onClick=${toggle} aria-label=${playing ? t('Pause') : t('Play')}><${Icon} name=${playing ? 'pause' : 'play'} size=${22} fill=${true} sw=${1} /></button>
      <span><b>${track.title}</b><small>${track.artist}</small></span></div>` : html`<div class="viz-info"><span><b>${t('Nothing is playing')}</b><small>${t('Play a song and it shows up here.')}</small></span></div>`}
    ${panel ? html`<aside class="viz-panel">
      <h4>${t('Around the cover')}</h4>${row('style')}
      <h4>${t('Color')}</h4>${row('color')}
      <h4>${t('Cover')}</h4>${row('shape')}
      <h4>${t('Particles')}</h4>${row('particles')}
      ${opts.particles !== 'none' ? html`<label class="viz-range"><span>${t('How many')}</span><input type="range" min="10" max="100" value=${opts.amount} onInput=${(e) => put('amount', Number(e.target.value))} /></label>` : null}
      <h4>${t('Sensitivity')}</h4><label class="viz-range"><input type="range" min="0.3" max="3" step="0.1" value=${opts.sensitivity} onInput=${(e) => put('sensitivity', Number(e.target.value))} /><b class="viz-val">${Number(opts.sensitivity).toFixed(1)}×</b></label>
      <h4>${t('Background')}</h4>${row('background')}
      <h4>${t('Shake')}</h4>${row('shake')}
      <h4>${t('Kind of shake')}</h4>${row('shakeType')}
      ${liveOn ? html`<p class="viz-note">${t('Following the real sound: the beat and the energy come from the music itself.')}</p>`
        : html`<h4>${t('Energy')}</h4>${row('energy')}
          <p class="viz-note">${t('Without the real sound, the beat is estimated.')}</p>`}
      <label class="viz-check"><input type="checkbox" checked=${opts.flash} onChange=${(e) => put('flash', e.target.checked)} /> ${t('Flash on the beat')}</label>
      <label class="viz-check"><input type="checkbox" checked=${opts.alwaysReal} onChange=${(e) => put('alwaysReal', e.target.checked)} /> ${t('Use the real sound every time it opens')}</label>
      <label class="viz-check"><input type="checkbox" checked=${opts.time} onChange=${(e) => put('time', e.target.checked)} /> ${t('Show the time under the cover')}</label>
    </aside>` : null}
  </div>`;
}
