// Orata — performance watchdog: if the device can't keep up with liquid glass / rain, quietly step the effects down once.
import { state, set, updateSettings, toast, subscribe } from '/js/store.js';
import { LITE } from '/js/lite.js';

/** Watches the device's battery (Chrome and Edge say how full it is; Safari and Firefox don't, and then nothing here ever turns itself on). `state.battery` is what
 *  Settings → Performance shows; `state.batteryLow` (under 20 %, not charging) is what lets "Switch to the Battery saver when the battery is low" do its job. */
export function startBatteryWatch() {
  if (typeof navigator.getBattery !== 'function') return;
  navigator.getBattery().then((b) => {
    const update = () => {
      const level = Math.round(b.level * 100); const charging = !!b.charging; const low = !charging && level <= 20;
      const cur = state.battery;
      if (!cur || cur.level !== level || cur.charging !== charging || state.batteryLow !== low) set({ battery: { level, charging }, batteryLow: low });
    };
    b.addEventListener('levelchange', update); b.addEventListener('chargingchange', update); update();
  }).catch(() => { /* blocked: no battery saver of its own */ });
}

let started = false;
/** How smoothly this device draws right now: the median time between frames over `ms` (about 3 s), as frames a second. `null` when nothing could be measured (the tab is hidden). */
export async function measureFps(ms = 3000) {
  const s = await sample(ms);
  return s.n >= 10 && s.median > 0 ? Math.min(240, Math.round(1000 / s.median)) : null;
}
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
  if (LITE) return;   // no rain or glass running, and these are Normal mode's settings
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
