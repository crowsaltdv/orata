// Orata — the music visualizer: a phonk-style "audio spectrum" screen. The song's cover sits in the middle, its sound is drawn around it (wings, an outline,
// bars or a ring), particles float about, and the screen shakes on the beat — hard for phonk, gently for calm songs, which also get a more colourful
// background. YouTube's player keeps its sound to itself, so by default the beat follows the song's energy (guessed from its title and artist, or picked in
// the settings); "Use the real sound" has Chrome share this tab's audio, and then everything follows the music itself. Settings stay on this device.
// Only orata_dev and oratedev see it for now.
import { html, useState, useEffect, useRef, cx, ls } from '/js/lib.js';
import { state, set, useSel, toast } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { t } from '/js/i18n.js';

export const canVisualize = (me) => ['orata_dev', 'oratedev'].includes(me?.username);
export const openVisualizer = () => set({ visualizer: true });
const DEFAULTS = { style: 'wings', particles: 'bokeh', amount: 60, shake: 'auto', background: 'auto', energy: 'auto', time: true, alwaysReal: false };
const N = 48;   // bands of the spectrum (low to high)
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
      const ac = new AudioContext(); const an = ac.createAnalyser(); an.fftSize = 2048; an.smoothingTimeConstant = 0.35; an.minDecibels = -90; an.maxDecibels = -20;   // (quick, and the whole loudness range)
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
    const fit = () => { dpr = Math.min(2, window.devicePixelRatio || 1); W = window.innerWidth; H = window.innerHeight; cv.width = W * dpr; cv.height = H * dpr; };
    fit(); window.addEventListener('resize', fit);
    const bands = new Float32Array(N); const raw = new Float32Array(N); const cam = { x: 0, y: 0, rot: 0, kick: 0 }; let parts = []; let sparks = []; let bass = 0; let level = 0.5; let lastPh = 0;
    let cover = { img: null, colors: ['#e0303a', '#7c3aed', '#0ea5e9'], grey: true }; let coverFor = null; let blurred = null;
    const prepare = async (tr) => {
      coverFor = tr?.id || null; cover = await loadCover(tr?.artwork); if (coverFor !== (tr?.id || null)) return;
      blurred = null;
      if (cover.img) {   // the blurred, darkened cover behind everything, drawn once
        const b = document.createElement('canvas'); b.width = 320; b.height = 320; const bg = b.getContext('2d');
        bg.filter = 'blur(14px) saturate(1.2)'; bg.drawImage(cover.img, -30, -30, 380, 380); bg.filter = 'none';
        bg.fillStyle = 'rgba(0,0,0,.55)'; bg.fillRect(0, 0, 320, 320); blurred = b;
      }
    };
    const seed = (kind, n) => Array.from({ length: n }, () => ({ x: rnd(0, 1), y: rnd(0, 1), z: rnd(0.2, 1), a: rnd(0, Math.PI * 2), s: rnd(0.4, 1), v: rnd(0.3, 1) }));
    let partKind = null; let partN = 0;
    const t0 = performance.now();
    const frame = () => {
      if (!alive) return;
      const { opts: o, playing: on, track: tr, reduce: still } = sim.current;
      if ((tr?.id || null) !== coverFor) prepare(tr);
      const now = performance.now(); const tt = (now - t0) / 1000;
      const want = o.particles === 'none' ? 0 : Math.round((o.amount / 100) * (o.particles === 'squares' ? 26 : o.particles === 'stars' ? 90 : 140));
      if (partKind !== o.particles || partN !== want) { partKind = o.particles; partN = want; parts = seed(o.particles, want); }
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
        for (let i = 0; i < N; i++) { const v = Math.min(1, (raw[i] / l.gain) ** 1.5); bands[i] += (v - bands[i]) * (v > bands[i] ? 0.8 : 0.35); }
        // the beat: a sudden jump in the low end (how much the bass bins rose since the last frame) well above its usual
        let lo = 0; let flux = 0; for (let k = 1; k < 8; k++) { lo += d[k]; flux += Math.max(0, d[k] - l.prev[k]); l.prev[k] = d[k]; } lo /= 7 * 255; flux /= 7 * 255;
        if (flux > l.flux * 1.8 + 0.025 && lo > 0.25 && now - l.last > 170) { beat = true; l.last = now; }
        l.flux = l.flux * 0.9 + flux * 0.1; l.avg = l.avg * 0.97 + lo * 0.03;
        bass += (Math.min(1, lo / Math.max(0.3, l.avg * 1.5)) - bass) * 0.5; level += (Math.min(1, l.avg * 1.5) - level) * 0.02;
      } else {
        const e = guessEnergy(tr, o.energy); level += (e - level) * 0.05;
        const bpm = level > 0.66 ? 140 : level > 0.33 ? 112 : 84; const len = 60 / bpm; const ph = (tt % len) / len;
        if (on && ph < lastPh) beat = true; lastPh = ph;
        const kick = on ? Math.exp(-ph * 7) : 0; const hat = on && level > 0.5 ? Math.exp(-(((tt + len / 2) % len) / len) * 12) : 0;
        for (let i = 0; i < N; i++) {
          const f = i / N; const wob = 0.5 + 0.5 * Math.sin(tt * (2.1 + f * 4.7) + i * 1.7) * Math.sin(tt * (0.9 + f * 1.3) + i * 0.61);
          const body = (0.35 + 0.4 * level) * wob * (1 - f * 0.45);
          const v = on ? Math.min(1, kick * Math.max(0, 1 - f * 1.8) * (0.7 + 0.3 * level) + body * (0.5 + 0.5 * kick) + hat * f * 0.45) : 0;
          bands[i] += (v - bands[i]) * (v > bands[i] ? 0.6 : 0.18);
        }
        bass += (kick * (0.4 + 0.6 * level) - bass) * 0.4;
      }
      // the shake: a kick on each beat, as hard as the song (or the setting) says, settling quickly
      const strength = still ? 0 : o.shake === 'off' ? 0 : o.shake === 'low' ? 6 : o.shake === 'medium' ? 14 : o.shake === 'high' ? 28 : 4 + 26 * level ** 1.6;
      if (beat && strength) { cam.x += rnd(-1, 1) * strength; cam.y += rnd(-1, 1) * strength; cam.rot += rnd(-1, 1) * strength * 0.0016; cam.kick = Math.min(1, cam.kick + 0.5 + level * 0.5); }
      cam.x *= 0.84; cam.y *= 0.84; cam.rot *= 0.86; cam.kick *= 0.88;
      if (beat && o.particles === 'sparks') for (let i = 0; i < 8 + level * 18; i++) sparks.push({ a: rnd(0, Math.PI * 2), d: 0, v: rnd(4, 11) * (0.6 + level), life: 1 });

      // ---------------------------------------------------------------- draw
      const R = Math.min(W, H) * 0.15; const cx0 = W / 2; const cy0 = H * 0.46;
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.globalCompositeOperation = 'source-over';
      g.save();
      const zoom = 1 + cam.kick * 0.035 * (strength ? 1 : 0);
      g.translate(W / 2 + cam.x, H / 2 + cam.y); g.rotate(cam.rot); g.scale(zoom, zoom); g.translate(-W / 2, -H / 2);
      const bgKind = o.background === 'auto' ? (level > 0.66 ? 'smoke' : level < 0.34 ? 'colorful' : 'cover') : o.background;
      const [c1, c2, c3] = cover.colors; const smokeColor = cover.grey ? (level > 0.6 ? '#d6283a' : '#9aa4b8') : c1;
      const pad = 60;
      if (bgKind === 'cover' && blurred) g.drawImage(blurred, -pad, -pad, W + pad * 2, H + pad * 2);
      else if (bgKind === 'colorful') {   // a slowly turning rainbow that starts from the cover's colour
        const h0 = (hueOf(c1) + tt * 9) % 360; const grd = g.createLinearGradient(0, 0, W, H); const sh = (Math.sin(tt * 0.15) + 1) / 2;
        grd.addColorStop(0, `hsl(${h0} 75% 46%)`); grd.addColorStop(0.45 + sh * 0.2, `hsl(${(h0 + 70) % 360} 72% 42%)`); grd.addColorStop(1, `hsl(${(h0 + 160) % 360} 70% 40%)`);
        g.fillStyle = grd; g.fillRect(-pad, -pad, W + pad * 2, H + pad * 2); g.fillStyle = 'rgba(8,8,20,.28)'; g.fillRect(-pad, -pad, W + pad * 2, H + pad * 2);
      } else { g.fillStyle = '#050506'; g.fillRect(-pad, -pad, W + pad * 2, H + pad * 2); }
      if (bgKind === 'smoke' || bgKind === 'colorful' || (bgKind === 'cover' && !blurred)) {   // slow clouds of colour, brighter with the bass
        g.globalCompositeOperation = 'lighter';
        for (let i = 0; i < 6; i++) {
          const x = W * (0.5 + 0.42 * Math.sin(tt * (0.07 + i * 0.013) + i * 2.1)); const y = H * (0.5 + 0.4 * Math.cos(tt * (0.05 + i * 0.011) + i * 1.3)); const r = Math.max(W, H) * (0.28 + 0.06 * Math.sin(tt * 0.3 + i));
          const rg = g.createRadialGradient(x, y, 0, x, y, r); const col = bgKind === 'smoke' ? smokeColor : [c1, c2, c3][i % 3];
          rg.addColorStop(0, `${col}${Math.round((bgKind === 'smoke' ? 0.16 : 0.12 + bass * 0.12) * 255).toString(16).padStart(2, '0')}`); rg.addColorStop(1, `${col}00`);
          g.fillStyle = rg; g.fillRect(x - r, y - r, r * 2, r * 2);
        }
        g.globalCompositeOperation = 'source-over';
      }
      // particles
      const hi = bands.slice(N * 0.6).reduce((a, b) => a + b, 0) / (N * 0.4);
      for (const p of parts) {
        if (partKind === 'bokeh') {
          p.y -= (0.0006 + p.v * 0.0012) * (1 + bass * 2.5); p.x += Math.sin(tt * p.v + p.a) * 0.0004; if (p.y < -0.05) { p.y = 1.05; p.x = rnd(0, 1); }
          g.fillStyle = `rgba(255,255,255,${(0.15 + 0.55 * p.z) * (0.6 + 0.4 * Math.sin(tt * 2 * p.v + p.a))})`; g.beginPath(); g.arc(p.x * W, p.y * H, 1 + p.z * 3.2 * p.s, 0, Math.PI * 2); g.fill();
        } else if (partKind === 'stars') {
          const a = Math.max(0, Math.sin(tt * (1 + p.v * 2) + p.a)) * (0.3 + hi * 1.6); const s = 2 + p.z * 4; const x = p.x * W; const y = p.y * H;
          g.strokeStyle = `rgba(255,255,255,${Math.min(1, a)})`; g.lineWidth = 1.2; g.beginPath(); g.moveTo(x - s, y); g.lineTo(x + s, y); g.moveTo(x, y - s); g.lineTo(x, y + s); g.stroke();
        } else if (partKind === 'squares') {
          p.y -= 0.00025 * p.v; p.a += 0.002 * p.v; if (p.y < -0.1) { p.y = 1.1; p.x = rnd(0, 1); }
          const s = 18 + p.z * 34; g.save(); g.translate(p.x * W, p.y * H); g.rotate(p.a); g.strokeStyle = `rgba(255,255,255,${0.08 + 0.18 * p.z + bass * 0.15})`; g.lineWidth = 1.4; g.strokeRect(-s / 2, -s / 2, s, s); g.restore();
        } else if (partKind === 'sparks') {   // a few drifting embers between the bursts
          p.y -= 0.0005 * p.v; if (p.y < -0.05) { p.y = 1.05; p.x = rnd(0, 1); }
          g.fillStyle = `rgba(255,${level > 0.6 ? 120 : 220},${level > 0.6 ? 110 : 255},${0.2 + 0.4 * p.z})`; g.fillRect(p.x * W, p.y * H, 1.6, 1.6);
        }
      }
      if (sparks.length) {
        g.lineCap = 'round';
        sparks = sparks.filter((s) => (s.life -= 0.022) > 0);
        for (const s of sparks) { s.d += s.v; const r0 = R * 1.05 + s.d; const r1 = r0 + 10 + s.v * 2; g.strokeStyle = `rgba(255,${level > 0.6 ? 90 : 230},${level > 0.6 ? 90 : 255},${s.life})`; g.lineWidth = 1.6; g.beginPath(); g.moveTo(cx0 + Math.cos(s.a) * r0, cy0 + Math.sin(s.a) * r0); g.lineTo(cx0 + Math.cos(s.a) * r1, cy0 + Math.sin(s.a) * r1); g.stroke(); }
      }
      // the sound around the cover
      const val = (k) => bands[Math.max(0, Math.min(N - 1, Math.floor(k)))];
      const white = 'rgba(255,255,255,.92)';
      if (o.style === 'wings') {   // bars fanning out to both sides, the bass in the middle
        g.strokeStyle = 'rgba(235,235,240,.8)'; g.lineWidth = Math.max(1.5, R * 0.018);
        const M = 64;
        for (let i = 0; i < M; i++) {
          const a = -Math.PI / 2 + ((i + 0.5) / M) * Math.PI; const v = val(Math.abs(i - (M - 1) / 2) / (M / 2) * N * 0.9);
          const len = 6 + v * R * 1.6 * (0.45 + 0.55 * Math.cos(a) ** 0.6);
          for (const side of [1, -1]) { const ca = Math.cos(a) * side; const sa = Math.sin(a); g.beginPath(); g.moveTo(cx0 + ca * R * 1.04, cy0 + sa * R * 1.04); g.lineTo(cx0 + ca * (R * 1.04 + len), cy0 + sa * (R * 1.04 + len)); g.stroke(); }
        }
      } else if (o.style === 'outline') {   // smooth mirrored shapes that stretch out with the sound, the bass at the top ("horns")
        const K = 18; const avg = (a, b) => { let s = 0; for (let k = a; k < b; k++) s += bands[k]; return s / Math.max(1, b - a); };
        for (const [scale, alpha, wdt] of [[1.3, 0.35, 2], [1, 0.95, 3.4]]) {
          const pts = [];
          for (let i = 0; i < K * 2; i++) {   // the right half from the top down, then mirrored for the left
            const j = i < K ? i : K * 2 - 1 - i; const f = j / (K - 1); const v = avg(Math.floor(f * N * 0.9), Math.floor(f * N * 0.9) + 3);
            const a = -Math.PI / 2 + (i < K ? (j + 0.5) / K : -(j + 0.5) / K) * Math.PI; const r = R * 1.06 + v * R * (2.1 - f * 1.1) * scale;
            pts.push([cx0 + Math.cos(a) * r, cy0 + Math.sin(a) * r]);
          }
          g.beginPath(); const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]; const m0 = mid(pts[pts.length - 1], pts[0]); g.moveTo(m0[0], m0[1]);
          for (let i = 0; i < pts.length; i++) { const p = pts[i]; const q = mid(p, pts[(i + 1) % pts.length]); g.quadraticCurveTo(p[0], p[1], q[0], q[1]); }
          g.closePath(); g.strokeStyle = `rgba(255,255,255,${alpha})`; g.lineWidth = wdt; g.shadowColor = smokeColor; g.shadowBlur = 20; g.stroke(); g.shadowBlur = 0;
        }
      } else if (o.style === 'bars') {   // bars all the way round, in the cover's colours
        const M = 96; g.lineWidth = Math.max(2, (Math.PI * 2 * R) / M * 0.55); g.lineCap = 'round';
        for (let i = 0; i < M; i++) { const a = (i / M) * Math.PI * 2 - Math.PI / 2; const v = val((i < M / 2 ? i : M - i) / (M / 2) * N * 0.95); const len = 4 + v * R * 1.35; g.strokeStyle = i % 2 ? c1 : c2; g.beginPath(); g.moveTo(cx0 + Math.cos(a) * R * 1.08, cy0 + Math.sin(a) * R * 1.08); g.lineTo(cx0 + Math.cos(a) * (R * 1.08 + len), cy0 + Math.sin(a) * (R * 1.08 + len)); g.stroke(); }
      } else if (o.style === 'ring') {   // a wobbling ring, a little looser on every beat
        for (const [k, alpha] of [[0, 0.9], [1, 0.4], [2, 0.2]]) {
          g.beginPath();
          for (let i = 0; i <= 90; i++) { const a = (i / 90) * Math.PI * 2; const r = R * (1.08 + k * 0.07) + Math.sin(a * 5 + tt * 1.4 + k) * (3 + bass * R * 0.2) + Math.sin(a * 9 - tt * 2.1) * (2 + val(i / 90 * N) * R * 0.18); const x = cx0 + Math.cos(a) * r; const y = cy0 + Math.sin(a) * r; if (i) g.lineTo(x, y); else g.moveTo(x, y); }
          g.closePath(); g.strokeStyle = `rgba(255,255,255,${alpha})`; g.lineWidth = 2; g.stroke();
        }
      }
      // the cover, a little bigger on the bass
      const rr = R * (1 + bass * 0.07);
      g.save(); g.beginPath(); g.arc(cx0, cy0, rr, 0, Math.PI * 2); g.closePath();
      g.shadowColor = smokeColor; g.shadowBlur = 30 + bass * 40; g.fillStyle = '#111'; g.fill(); g.shadowBlur = 0; g.clip();
      if (cover.img) { const iw = cover.img.naturalWidth; const ih = cover.img.naturalHeight; const s = (rr * 2) / Math.min(iw, ih); g.drawImage(cover.img, cx0 - (iw * s) / 2, cy0 - (ih * s) / 2, iw * s, ih * s); }
      g.restore();
      g.beginPath(); g.arc(cx0, cy0, rr, 0, Math.PI * 2); g.strokeStyle = white; g.lineWidth = Math.max(2, R * 0.03); g.stroke();
      if (o.time && tr) { const pos = state.music.position || 0; g.font = `800 ${Math.round(R * 0.26)}px "Montserrat", system-ui, sans-serif`; g.textAlign = 'center'; g.fillStyle = 'rgba(255,255,255,.85)'; g.fillText(clock(pos), cx0, cy0 + R * (o.style === 'none' ? 1.62 : 2.5)); }
      g.restore();
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { alive = false; cancelAnimationFrame(raf); window.removeEventListener('resize', fit); };
  }, []);

  const opt = (key, value, label) => html`<button type="button" class=${cx('viz-chip', opts[key] === value && 'on')} onClick=${() => put(key, value)}>${t(label)}</button>`;
  const toggle = async () => (await import('/js/music.js')).music.toggle();
  return html`<div class="viz" role="dialog" aria-label=${t('Visualizer')}>
    <canvas ref=${canvas} class="viz-canvas"></canvas>
    <div class="viz-top">
      <button type="button" class=${cx('viz-btn', liveOn && 'on')} onClick=${startLive} data-tip=${liveOn ? t('Following the real sound (click to stop)') : t('Follow the real sound: Chrome asks to share this tab with its audio')}><${Icon} name="headphones" size=${18} />${liveOn ? t('Real sound') : t('Use the real sound')}</button>
      <button type="button" class=${cx('viz-btn', panel && 'on')} onClick=${() => setPanel(!panel)} aria-label=${t('Visualizer settings')}><${Icon} name="sliders" size=${18} /></button>
      <button type="button" class="viz-btn" onClick=${close} aria-label=${t('Close')}><${Icon} name="x" size=${20} /></button>
    </div>
    ${track ? html`<div class="viz-info"><button type="button" class="viz-play" onClick=${toggle} aria-label=${playing ? t('Pause') : t('Play')}><${Icon} name=${playing ? 'pause' : 'play'} size=${22} fill=${true} sw=${1} /></button>
      <span><b>${track.title}</b><small>${track.artist}</small></span></div>` : html`<div class="viz-info"><span><b>${t('Nothing is playing')}</b><small>${t('Play a song and it shows up here.')}</small></span></div>`}
    ${panel ? html`<aside class="viz-panel">
      <h4>${t('Around the cover')}</h4><div class="viz-row">${opt('style', 'wings', 'Wings')}${opt('style', 'outline', 'Outline')}${opt('style', 'bars', 'Bars')}${opt('style', 'ring', 'Ring')}${opt('style', 'none', 'None')}</div>
      <h4>${t('Particles')}</h4><div class="viz-row">${opt('particles', 'bokeh', 'Bokeh')}${opt('particles', 'sparks', 'Sparks')}${opt('particles', 'stars', 'Stars')}${opt('particles', 'squares', 'Squares')}${opt('particles', 'none', 'None')}</div>
      ${opts.particles !== 'none' ? html`<label class="viz-range"><span>${t('How many')}</span><input type="range" min="10" max="100" value=${opts.amount} onInput=${(e) => put('amount', Number(e.target.value))} /></label>` : null}
      <h4>${t('Background')}</h4><div class="viz-row">${opt('background', 'auto', 'Auto')}${opt('background', 'cover', 'Cover')}${opt('background', 'smoke', 'Smoke')}${opt('background', 'colorful', 'Colorful')}</div>
      <h4>${t('Shake')}</h4><div class="viz-row">${opt('shake', 'auto', 'Auto')}${opt('shake', 'off', 'Off')}${opt('shake', 'low', 'Low')}${opt('shake', 'medium', 'Medium')}${opt('shake', 'high', 'High')}</div>
      ${liveOn ? html`<p class="viz-note">${t('Following the real sound: the beat and the energy come from the music itself.')}</p>`
        : html`<h4>${t('Energy')}</h4><div class="viz-row">${opt('energy', 'auto', 'Auto')}${opt('energy', 'calm', 'Calm')}${opt('energy', 'medium', 'Medium')}${opt('energy', 'intense', 'Intense')}</div>
          <p class="viz-note">${t('Without the real sound, the beat is estimated.')}</p>`}
      <label class="viz-check"><input type="checkbox" checked=${opts.alwaysReal} onChange=${(e) => put('alwaysReal', e.target.checked)} /> ${t('Use the real sound every time it opens')}</label>
      <label class="viz-check"><input type="checkbox" checked=${opts.time} onChange=${(e) => put('time', e.target.checked)} /> ${t('Show the time under the cover')}</label>
    </aside>` : null}
  </div>`;
}
