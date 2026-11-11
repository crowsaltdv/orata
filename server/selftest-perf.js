// Orata self-test for the Performance options (public/js/perf-data.js, Settings → Performance): the options and quick picks, what is switched on right now (the Battery
// saver lets itself in while the battery is low), and what each option does to the look that gets drawn — never to the saved settings. No server needed.  Runs with the other suites:  npm test
import { PERF_GROUPS, PERF_KEYS, DEFAULT_PERF, PERF_PRESETS, presetValues, presetOf, effectivePerf, perfOf, reducedMotion, applyPerfToLook } from '../public/js/perf-data.js';
import { DEFAULT_SETTINGS, DEFAULT_LOCAL, deepMerge } from '../public/js/defaults.js';

let pass = 0; let fail = 0;
const ok = (c, name, extra = '') => { if (c) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('The options');
ok(PERF_KEYS.length === new Set(PERF_KEYS).size && PERF_KEYS.length >= 14, 'every option has its own key');
ok(PERF_GROUPS.every((g) => g.title && g.desc && g.options.every((o) => o.key && o.title && o.desc)), 'each one has a title and says what it does');
ok(Object.keys(DEFAULT_PERF).length === PERF_KEYS.length + 1 && PERF_KEYS.every((k) => DEFAULT_PERF[k] === false) && DEFAULT_PERF.auto === false, 'they all start off (Orata exactly as the theme draws it)');
ok(DEFAULT_LOCAL.perf && same(DEFAULT_LOCAL.perf, DEFAULT_PERF) && DEFAULT_LOCAL.perf !== DEFAULT_PERF, 'this device starts with a copy of them');
ok(!('perf' in DEFAULT_SETTINGS), 'they are not part of the synced settings, so no theme carries them to another device');
const saved = deepMerge(DEFAULT_LOCAL, { perf: { rain: true } });
ok(saved.perf.rain === true && saved.perf.glass === false && saved.perf.auto === false, 'options saved by an older version fill in from the defaults');

console.log('\nQuick picks');
ok(PERF_KEYS.every((k) => presetValues('full')[k] === false), 'Full quality has everything off');
ok(Object.keys(PERF_PRESETS.balanced).every((k) => PERF_KEYS.includes(k)) && Object.keys(PERF_PRESETS.saver).every((k) => PERF_KEYS.includes(k)), 'picks only name real options');
ok(Object.keys(PERF_PRESETS.balanced).every((k) => PERF_PRESETS.saver[k]), 'Battery saver includes everything Balanced does');
ok(!PERF_PRESETS.balanced.rain && PERF_PRESETS.saver.rain && !PERF_PRESETS.saver.plainBg && !PERF_PRESETS.saver.fonts && !PERF_PRESETS.saver.previews, 'Balanced keeps the rain, and even Battery saver leaves the wallpaper, fonts and link previews to you');
ok(presetOf(DEFAULT_PERF) === 'full' && presetOf(presetValues('balanced')) === 'balanced' && presetOf(presetValues('saver')) === 'saver', 'the options say which pick they match');
ok(presetOf({ ...presetValues('balanced'), rain: true }) === 'custom' && presetOf(undefined) === 'full', 'one change makes it Custom; no options at all is Full quality');
ok(presetOf({ ...presetValues('saver'), auto: true }) === 'saver', 'the battery switch isn’t part of what a pick is');
ok(presetValues('saver').auto === undefined, 'picking one leaves the battery switch as it was');

console.log('\nWhat is on right now');
const none = effectivePerf(DEFAULT_PERF, false);
ok(PERF_KEYS.every((k) => none[k] === false) && !none.any && !none.battery, 'nothing chosen: nothing on');
ok(effectivePerf(DEFAULT_PERF, false) === none && effectivePerf(DEFAULT_PERF, 0) === none, 'the same object comes back while nothing changes (the page re-draws only on a change)');
const perf = { ...DEFAULT_PERF, rain: true, thumbs: true };
const e1 = effectivePerf(perf, false);
ok(e1.rain && e1.thumbs && !e1.glass && e1.any, 'what was chosen is on');
const low = effectivePerf(perf, true);
ok(low.rain && !low.glass && !low.battery, 'a low battery changes nothing unless the switch is on');
const auto = { ...perf, auto: true };
const eLow = effectivePerf(auto, true);
ok(PERF_KEYS.every((k) => eLow[k] === !!PERF_PRESETS.saver[k] || eLow[k] === !!perf[k]) && eLow.battery && eLow.glass && eLow.motion && eLow.thumbs, 'with the switch on, a low battery brings in the Battery saver (and keeps what was chosen)');
ok(!effectivePerf(auto, false).glass && !effectivePerf(auto, false).battery, '… and plugging in takes it away again');
ok(Object.isFrozen(eLow), 'what comes back can’t be changed by accident');
ok(perfOf({ local: { perf }, batteryLow: false }) === effectivePerf(perf, false) && !perfOf({}).any && !perfOf(null).any, 'it is read from the state, whatever the state has');
ok(reducedMotion({ settings: { motion: { reduce: true } } }) && reducedMotion({ settings: { motion: {} }, local: { perf: { ...DEFAULT_PERF, motion: true } } }) && !reducedMotion({ settings: { motion: {} }, local: { perf: DEFAULT_PERF } }), 'reduced motion comes from Reduce motion or from the option');

console.log('\nWhat they do to the look');
const S = structuredClone(DEFAULT_SETTINGS); S.rain.enabled = true; S.rain.fps = 60; S.glass.style = 'liquid'; S.bg.parallax = true; S.bg.type = 'photo'; S.theme.panelBlur = 17; S.theme.panelOpacity = 0.4;
const look = (o, plain) => applyPerfToLook(S, effectivePerf({ ...DEFAULT_PERF, ...o }, false), plain ? { plain } : undefined);
ok(look({}) === S, 'with nothing on, the very same settings come back');
let L = look({ rain: true }); ok(L.rain.enabled === false && L.rain.amount === S.rain.amount && S.rain.enabled === true, 'no rain: switched off, the rest of its settings kept, the saved ones untouched');
L = look({ rainFps: true }); ok(L.rain.fps === 30 && L.rain.enabled === true, '30 frames a second slows the rain without stopping it');
L = look({ rain: true, rainFps: true }); ok(L.rain.enabled === false && L.rain.fps === 60, '… and with no rain there is nothing to slow');
L = look({ glass: true }); ok(L.glass.style === 'off' && L.glass.intensity === S.glass.intensity && S.glass.style === 'liquid', 'no liquid glass');
L = look({ blur: true }); ok(L.theme.panelBlur === 0 && L.theme.panelOpacity === 0.82 && S.theme.panelBlur === 17, 'no blur: panels get more solid so the text stays readable');
ok(applyPerfToLook({ ...S, theme: { ...S.theme, panelOpacity: 0.95 } }, effectivePerf({ ...DEFAULT_PERF, blur: true })).theme.panelOpacity === 0.95, '… but never less solid than they already are');
L = look({ motion: true }); ok(L.motion.reduce === true && S.motion.reduce !== true, 'reduce animations turns Reduce motion on for the drawing');
L = look({ plainBg: true }, '#223344'); ok(L.bg.type === 'solid' && L.bg.color === '#223344' && L.bg.parallax === false && L.bg.blur === 0 && S.bg.type === 'photo', 'a plain colour replaces the picture (the colour comes from the caller)');
L = look({ parallax: true }); ok(L.bg.parallax === false && L.bg.type === 'photo', 'a still wallpaper only stops the drift');
L = look({ fonts: true }); ok(L.fonts.ui === 'System UI' && L.fonts.chat === null && L.fonts.code === null && L.fonts.size === S.fonts.size, 'system fonts, sizes kept');
L = look({ bursts: true, profileFx: true, gifs: true }); ok(L !== S && same({ ...L }, { ...S }), 'options that act elsewhere (sparkles, profile effects, GIFs…) leave the look alone but still make a new object, so the page notices');
L = look({ rain: true, glass: true, blur: true, plainBg: true, fonts: true, motion: true });
ok(L.rain.enabled === false && L.glass.style === 'off' && L.theme.panelBlur === 0 && L.bg.type === 'solid' && L.fonts.ui === 'System UI' && L.motion.reduce, 'they combine');
ok(S.rain.enabled && S.glass.style === 'liquid' && S.theme.panelBlur === 17 && S.bg.type === 'photo' && S.fonts.ui !== 'System UI', 'and after all that the saved settings are exactly as they were');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
