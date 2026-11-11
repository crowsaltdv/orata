// Orata — the Performance options (Settings → Performance): what to switch off to save battery and keep Orata smooth.
// They are saved per DEVICE (state.local.perf: what a phone can take is not what a desktop can) and they never change the saved theme: they only override how the
// theme is drawn on this device, so switching an option off again brings the theme's own look straight back. Every option is a switch that, when on, SAVES something.
// No browser APIs in here on purpose (server/selftest-perf.js runs it in Node); the pieces that touch the page live in theme.js, fx.js, perf.js and the components.

/** The options, in the order the settings page shows them (group → rows). `key` is the saved flag; `title` says what switching it on does. */
export const PERF_GROUPS = [
  { id: 'look', title: 'Wallpaper & glass', desc: 'What is drawn behind and around everything. Switching these off helps the most.', options: [
    { key: 'rain', title: 'Turn off the rain effect', desc: 'The raindrops are drawn on the graphics chip all the time. This is the biggest battery saver.' },
    { key: 'rainFps', title: 'Slow the rain to 30 frames a second', desc: 'Half the work and still smooth. Only matters while the rain is on.' },
    { key: 'glass', title: 'Turn off liquid glass', desc: 'No glassy highlights on buttons and panels.' },
    { key: 'blur', title: 'Turn off blur behind panels', desc: 'Every blurred panel is redrawn whenever anything behind it moves. Panels stay see-through but get a little more solid so text stays easy to read.' },
    { key: 'plainBg', title: 'Use a plain colour instead of the wallpaper picture', desc: 'No big picture to hold in memory and redraw. Your wallpaper comes back when you switch this off.' },
    { key: 'parallax', title: 'Keep the wallpaper still', desc: 'It no longer drifts when you move the mouse.' },
  ] },
  { id: 'motion', title: 'Animations', desc: 'Things that move.', options: [
    { key: 'motion', title: 'Reduce animations', desc: 'Skips most movement and transitions. This also stops the rain and the wallpaper drift.' },
    { key: 'bursts', title: 'Turn off sparkles and press ripples', desc: 'No particle bursts when you send, react or press a button.' },
    { key: 'profileFx', title: 'Stop animated profile effects', desc: 'Matrix rain, sparkles and rainbow colours on profile cards and names stand still.' },
    { key: 'visualizer', title: 'Lighten the music visualizer', desc: 'Drawn at 30 frames a second and at a lower resolution.' },
    { key: 'pause', title: 'Pause the effects while Orata is in the background', desc: 'The rain and every animation stop while another window is the one you are using, and carry on when you come back.' },
  ] },
  { id: 'data', title: 'Pictures & data', desc: 'Less to download, decode and play.', options: [
    { key: 'gifs', title: 'Play GIFs only when you open them', desc: 'They show a still picture first.' },
    { key: 'previews', title: 'Don’t load link previews', desc: 'Links stay plain links. No cards and no inline YouTube.' },
    { key: 'thumbs', title: 'Load smaller pictures and GIFs', desc: 'Pictures come as lighter copies; open one to see the full picture. Applies to pictures as they load.' },
    { key: 'fonts', title: 'Use the system font', desc: 'No fonts to download. Your chosen fonts come back when you switch this off.' },
    { key: 'video', title: 'Lower the video quality in calls', desc: 'Your camera is sent at 360p at the most, which is much easier on the processor and the battery.' },
  ] },
];
export const PERF_KEYS = PERF_GROUPS.flatMap((g) => g.options.map((o) => o.key));

/** Everything off: Orata exactly as the theme draws it. `auto` is not a saving itself: it lets the Battery saver switch itself on while the battery is low. */
export const DEFAULT_PERF = { ...Object.fromEntries(PERF_KEYS.map((k) => [k, false])), auto: false };

/** The quick picks. (Full quality is just every option off.) */
export const PERF_PRESETS = {
  full: {},
  balanced: { rainFps: true, glass: true, parallax: true, bursts: true, visualizer: true, pause: true },
  saver: { rain: true, rainFps: true, glass: true, blur: true, parallax: true, motion: true, bursts: true, profileFx: true, visualizer: true, pause: true, gifs: true, thumbs: true, video: true },
};
export const PRESET_LABELS = { full: 'Full quality', balanced: 'Balanced', saver: 'Battery saver', custom: 'Custom' };
/** The options a quick pick sets (all of them: the ones it doesn't mention go off). `auto` is left as it is. */
export const presetValues = (id) => ({ ...Object.fromEntries(PERF_KEYS.map((k) => [k, false])), ...(PERF_PRESETS[id] || {}) });

/** Which quick pick the options match ('custom' when none does). */
export function presetOf(perf) {
  for (const id of Object.keys(PERF_PRESETS)) { const v = presetValues(id); if (PERF_KEYS.every((k) => !!perf?.[k] === v[k])) return id; }
  return 'custom';
}

/** What is switched on right now: the options chosen, plus the Battery saver while the battery is low and `auto` is on. The same object comes back while nothing changed. */
let memo = { perf: null, low: null, out: null };
export function effectivePerf(perf, low = false) {
  const lowNow = !!low;
  if (memo.out && memo.perf === perf && memo.low === lowNow) return memo.out;
  const out = {};
  for (const k of PERF_KEYS) out[k] = !!perf?.[k] || (lowNow && !!perf?.auto && !!PERF_PRESETS.saver[k]);
  out.any = PERF_KEYS.some((k) => out[k]); out.auto = !!perf?.auto; out.battery = lowNow && !!perf?.auto;
  memo = { perf, low: lowNow, out: Object.freeze(out) };
  return memo.out;
}
/** The options in force for this state (what every part of the app asks). */
export const perfOf = (s) => effectivePerf(s?.local?.perf, s?.batteryLow);
/** Reduce motion, from either place it can be asked for: the setting, or the Performance option. */
export const reducedMotion = (s) => !!(s?.settings?.motion?.reduce || perfOf(s).motion);

/** The look to draw: the settings with the options laid over them (a copy; the saved settings are never touched). Without any option on, the very same settings come back.
 *  `plain`: the colour a plain background gets (the caller works it out from the theme, as Lite mode does). */
export function applyPerfToLook(s, f, { plain = '#16141f' } = {}) {
  if (!f?.any) return s;
  const out = { ...s };
  if (f.rain) out.rain = { ...s.rain, enabled: false };
  else if (f.rainFps && s.rain?.fps !== 30) out.rain = { ...s.rain, fps: 30 };
  if (f.glass && s.glass?.style !== 'off') out.glass = { ...s.glass, style: 'off' };
  if (f.blur) out.theme = { ...(out.theme || s.theme), panelBlur: 0, panelOpacity: Math.max(s.theme?.panelOpacity ?? 0.58, 0.82) };
  if (f.motion && !s.motion?.reduce) out.motion = { ...s.motion, reduce: true };
  if (f.plainBg) out.bg = { ...s.bg, type: 'solid', color: plain, parallax: false, blur: 0 };
  else if (f.parallax && s.bg?.parallax) out.bg = { ...s.bg, parallax: false };
  if (f.fonts) out.fonts = { ...s.fonts, ui: 'System UI', chat: null, code: null };
  return out;
}
