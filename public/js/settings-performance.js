// Orata — Settings → Performance: switch off what costs the most battery and processing power. Everything here is saved on THIS device only (a phone and a desktop
// don't need the same) and never changes the saved theme: it only overrides how the theme is drawn, so switching an option off brings the theme's own look straight back
// (perf-data.js has the options and what each one does to the look; theme.js, fx.js, visualizer.js and the others read them).
import { html, useState, cx } from '/js/lib.js';
import { useSel, updateLocal } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { Btn, Section, SettingRow, Toggle, Segmented } from '/js/ui.js';
import { t } from '/js/i18n.js';
import { LITE } from '/js/lite.js';
import { measureFps } from '/js/perf.js';
import { PERF_GROUPS, PERF_KEYS, DEFAULT_PERF, PRESET_LABELS, presetValues, presetOf, effectivePerf } from '/js/perf-data.js';

const setPerf = (patch) => updateLocal({ perf: patch });
const hasBattery = () => typeof navigator !== 'undefined' && typeof navigator.getBattery === 'function';

/** "Test this device": how many frames a second Orata is drawing right now, and which quick setting to try. */
function SpeedTest() {
  const [fps, setFps] = useState(undefined); const [busy, setBusy] = useState(false);
  const run = async () => { setBusy(true); setFps(undefined); const v = await measureFps(); setFps(v); setBusy(false); };
  return html`<div class="perf-test"><${Btn} icon="bolt" loading=${busy} onClick=${run}>${t('Test this device')}<//>
    ${busy ? html`<span>${t('Measuring for three seconds…')}</span>`
      : fps === undefined ? html`<span>${t('Measures how smoothly Orata is drawing right now.')}</span>`
        : fps === null ? html`<span>${t('Couldn’t measure: Orata has to stay on screen while it does.')}</span>`
          : html`<span><b>${fps} ${t('frames a second')}</b> — ${fps >= 55 ? t('Smooth. Nothing to change.') : fps >= 40 ? t('Mostly smooth. Balanced would help.') : t('Choppy. Try Battery saver.')}</span>`}</div>`;
}

export function PerformancePage() {
  const perf = useSel((s) => s.local.perf); const battery = useSel((s) => s.battery); const low = useSel((s) => s.batteryLow);
  const preset = presetOf(perf); const count = PERF_KEYS.filter((k) => perf[k]).length; const eff = effectivePerf(perf, low);
  const options = [...['full', 'balanced', 'saver'].map((v) => ({ value: v, label: t(PRESET_LABELS[v]) })), ...(preset === 'custom' ? [{ value: 'custom', label: t(PRESET_LABELS.custom) }] : [])];
  return html`<div class="s-page">
    ${LITE ? html`<div class="perf-note"><${Icon} name="bolt" size=${16} /><span>${t('Lite mode is on, which already leaves out the rain, glass, blur, wallpaper picture and downloaded fonts. The rest of these options still help.')}</span></div>` : null}
    ${eff.battery ? html`<div class="perf-note"><${Icon} name="bolt" size=${16} /><span>${t('Your battery is low, so the Battery saver is on until you plug in.')}</span></div>` : null}
    <${Section} title=${t('Battery & speed')} desc=${t('Switch off the parts of Orata that use the most battery and processing power. These options are saved on this device only, and your theme is never changed: switch one off again and the theme’s own look comes straight back.')}>
      <${SettingRow} title=${t('Quick settings')} desc=${t('Full quality is Orata exactly as your theme draws it. Balanced keeps the look and drops what costs the most for the least. Battery saver switches off nearly everything that moves.')} stack>
        <div class="perf-presets"><${Segmented} options=${options} value=${preset} onChange=${(v) => { if (v !== 'custom') setPerf(presetValues(v)); }} /><small>${count ? `${count} ${t(count === 1 ? 'option on' : 'options on')}` : t('Everything on')}</small></div><//>
      <${SettingRow} title=${t('Switch to the Battery saver when the battery is low')} desc=${hasBattery() ? t('When the battery drops under 20% and the device isn’t charging, Orata uses the Battery saver settings by itself. It goes back as soon as you plug in or charge it up.') : t('This browser doesn’t tell Orata how much battery is left (Chrome and Edge do), so this can’t switch on by itself here.')}>
        <${Toggle} checked=${!!perf.auto && hasBattery()} disabled=${!hasBattery()} onChange=${(v) => setPerf({ auto: v })} /><//>
      ${battery ? html`<div class=${cx('perf-batt', low && 'low')}><${Icon} name="bolt" size=${15} />${battery.level}% · ${battery.charging ? t('charging') : t('on battery')}</div>` : null}
      <${SettingRow} title=${t('Check this device')} desc=${t('Not sure what to switch off? Measure how smoothly Orata runs right now.')} stack><${SpeedTest} /><//>
    <//>
    ${PERF_GROUPS.map((g) => html`<${Section} key=${g.id} title=${t(g.title)} desc=${t(g.desc)}>
      ${g.options.map((o) => html`<${SettingRow} key=${o.key} title=${t(o.title)} desc=${t(o.desc)}><${Toggle} checked=${!!perf[o.key]} onChange=${(v) => setPerf({ [o.key]: v })} /><//>`)}
    <//>`)}
    <div class="reset-row"><${Btn} variant="ghost" icon="rotate-cw" onClick=${() => setPerf({ ...DEFAULT_PERF })}>${t('Reset performance options')}<//></div>
  </div>`;
}
