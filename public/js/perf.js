// Orata — performance watchdog: if the device can't keep up with liquid glass / rain, quietly step the effects down once.
import { state, updateSettings, toast, subscribe } from '/js/store.js';

let started = false;
function sample(ms = 3000) {
  return new Promise((resolve) => {
    const deltas = []; let last = performance.now(); const t0 = last;
    const tick = (now) => {
      deltas.push(now - last); last = now;
      if (now - t0 < ms) requestAnimationFrame(tick); else { deltas.sort((a, b) => a - b); resolve({ median: deltas[Math.floor(deltas.length / 2)] || 16, n: deltas.length }); }
    };
    requestAnimationFrame(tick);
    setTimeout(() => resolve({ median: 0, n: 0 }), ms + 2500); // hidden tab: rAF never fires
  });
}
export function startPerfWatchdog() {
  const unsub = subscribe(async () => {
    if (started || state.phase !== 'ready') return;
    started = true; unsub();
    try { if (sessionStorage.getItem('orate:perf')) return; } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 5000));
    if (document.hidden) return;
    const g = state.settings.glass; const r = state.settings.rain;
    if (g.style === 'off' && !r.enabled) return;
    const s = await sample();
    if (!s.n || s.n < 20) return;
    try { sessionStorage.setItem('orate:perf', '1'); } catch { /* ignore */ }
    if (s.median > 42) {
      if (g.style === 'liquid') { updateSettings({ glass: { style: 'off' } }); toast('Turned liquid glass off so Orata stays smooth on this device. You can switch it back on in Settings → Rain & Glass.', 'info', 8000); }
      else if (r.enabled && r.fps !== 30) { updateSettings({ rain: { fps: 30 } }); toast('Lowered the rain frame rate to keep things smooth.', 'info', 6000); }
    }
  });
}
