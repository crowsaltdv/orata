// Orate — appearance settings: theme colours, wallpaper, rain & glass effects, fonts, chat display.
import { html, useState, useEffect, cx } from '/js/lib.js';
import { state, set, useSel, setSetting, updateSettings, resetSettings, toast } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { Btn, Slider, Toggle, Segmented, SettingRow, Section, ColorSwatch, TextInput, Dropdown, Avatar } from '/js/ui.js';
import { DEFAULT_SETTINGS, ACCENT_PRESETS, PANEL_PRESETS, MESH_WALLPAPERS, PHOTO_WALLPAPERS } from '/js/defaults.js';
import { meshCss, proxied } from '/js/theme.js';
import { RAIN_PRESETS } from '/js/rain.js';
import { FontField } from '/js/fontpicker.js';
import { pickFile } from '/js/imageutil.js';
import { upload } from '/js/api.js';
import { errMsg } from '/js/actions.js';
import { t } from '/js/i18n.js';

const get = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
export const SSlider = ({ path, scale = 1, format, ...rest }) => { const v = useSel((s) => get(s.settings, path)); return html`<${Slider} value=${Math.round(v * scale * 100) / 100} onChange=${(x) => setSetting(path, x / scale)} format=${format} ...${rest} />`; };
export const SToggle = ({ path, onChange }) => { const v = useSel((s) => get(s.settings, path)); return html`<${Toggle} checked=${!!v} onChange=${(x) => { setSetting(path, x); onChange?.(x); }} />`; };
const pct = (v) => v + '%'; const px = (v) => v + 'px';

export function ThemePreview() {
  const me = useSel((s) => s.me);
  return html`<div class="tpv panel">
    <div class="tpv-rail"><i class="a"></i><i></i><i></i></div>
    <div class="tpv-side"><b>${t('Channels')}</b><span class="sel"># general</span><span># memes</span><span># media</span></div>
    <div class="tpv-main">
      <div class="tpv-msg"><${Avatar} user=${me} size=${34} /><div><b>${me.displayName}</b> <small>Today at 9:41 PM</small><p>This is how your messages look. <span class="mention">@orbit</span> <em>italic</em>, <strong>bold</strong> and <code class="inline-code">code</code>.</p><div class="reactions"><span class="reaction mine"><span class="r-emoji">🔥</span><span class="r-count">3</span></span><span class="reaction"><span class="r-emoji">🌧️</span><span class="r-count">1</span></span></div></div></div>
      <div class="tpv-bar"><span class="btn btn-primary btn-sm">${t('Send')}</span><span class="btn btn-sm">${t('Cancel')}</span></div>
    </div></div>`;
}

/* ------------------------------------------------------------------ theme */
const MODES = [['dark', 'Dark', '#15121f', '#f4f2ff'], ['light', 'Light', '#ffffff', '#1a1530'], ['midnight', 'Midnight', '#000000', '#f4f2ff'], ['auto', 'Sync with system', null, null]];
export function setMode(mode) {
  const base = { dark: ['#15121f', 0.58], light: ['#ffffff', 0.62], midnight: ['#000000', 0.55] }[mode];
  updateSettings({ theme: { mode, textColor: null, ...(base ? { panelColor: base[0], panelOpacity: base[1] } : {}) } });
}
export function ThemePage() {
  const th = useSel((s) => s.settings.theme);
  const setT = (k, v) => updateSettings({ theme: { [k]: v } });
  const gradient = th.accentType === 'gradient';
  return html`<div class="s-page">
    <${ThemePreview} />
    <${Section} title=${t('Theme')} desc=${t('Pick a base. Everything below fine-tunes it.')}>
      <div class="mode-grid">${MODES.map(([k, l, bg, fg]) => html`<button type="button" class=${cx('mode-card', th.mode === k && 'sel')} onClick=${() => setMode(k)}>
        <span class="mode-prev" style=${k === 'auto' ? { background: 'linear-gradient(105deg,#15121f 50%,#fff 50%)' } : { background: bg, color: fg }}><i></i><i></i></span><b>${t(l)}</b>${th.mode === k ? html`<span class="mode-check"><${Icon} name="check" size=${13} sw=${3.5} /></span>` : null}</button>`)}</div>
    <//>
    <${Section} title=${t('Accent color')} desc=${t('Used for buttons, highlights, selections and links.')} action=${html`<${Segmented} size="sm" options=${[{ value: 'solid', label: t('Solid') }, { value: 'gradient', label: t('Gradient') }]} value=${th.accentType} onChange=${(v) => setT('accentType', v)} />`}>
      <div class="swatch-row">${ACCENT_PRESETS.map(([a, b]) => { const sel = th.accent === a && (th.accentType === 'solid' || th.accent2 === b); return html`<button type="button" class=${cx('grad-swatch', sel && 'sel')} style=${{ background: gradient ? `linear-gradient(135deg, ${a}, ${b})` : a }} aria-label=${`${a} ${b}`} onClick=${() => updateSettings({ theme: { accent: a, accent2: b } })}>${sel ? html`<${Icon} name="check" size=${15} sw=${3.5} />` : null}</button>`; })}</div>
      <div class="color-row"><div class="cr-item"><${ColorSwatch} value=${th.accent} onChange=${(c) => setT('accent', c)} label=${t('Primary')} size=${40} /><span>${t('Primary')}<small>${th.accent}</small></span></div>
        ${gradient ? html`<div class="cr-item slide-right"><${ColorSwatch} value=${th.accent2} onChange=${(c) => setT('accent2', c)} label=${t('Secondary')} size=${40} /><span>${t('Secondary')}<small>${th.accent2}</small></span></div>` : null}
        <div class="grad-preview" style=${{ background: 'var(--accent-grad)' }}>${t('Preview')}</div></div>
    <//>
    <${Section} title=${t('Panels')} desc=${t('The rounded glass surfaces in front of your wallpaper.')} action=${html`<${Segmented} size="sm" options=${[{ value: 'solid', label: t('Solid') }, { value: 'gradient', label: t('Gradient') }]} value=${th.panelType} onChange=${(v) => setT('panelType', v)} />`}>
      <div class="swatch-row">${PANEL_PRESETS.map(([c, n]) => html`<button type="button" class=${cx('panel-swatch', th.panelColor.toLowerCase() === c && 'sel')} style=${{ background: c }} data-tip=${n} aria-label=${n} onClick=${() => updateSettings({ theme: { panelColor: c } })}>${th.panelColor.toLowerCase() === c ? html`<${Icon} name="check" size=${14} sw=${3.5} style=${{ color: c > '#888' ? '#111' : '#fff' }} />` : null}</button>`)}</div>
      <div class="color-row"><div class="cr-item"><${ColorSwatch} value=${th.panelColor} onChange=${(c) => setT('panelColor', c)} label=${t('Panel color')} size=${40} presets=${PANEL_PRESETS.map((p) => p[0])} /><span>${t('Panel color')}<small>${th.panelColor}</small></span></div>
        ${th.panelType === 'gradient' ? html`<div class="cr-item slide-right"><${ColorSwatch} value=${th.panelColor2} onChange=${(c) => setT('panelColor2', c)} label=${t('Second color')} size=${40} /><span>${t('Second color')}<small>${th.panelColor2}</small></span></div>` : null}</div>
      ${th.panelType === 'gradient' ? html`<${SettingRow} title=${t('Gradient angle')}><${SSlider} path="theme.panelAngle" min=${0} max=${360} format=${(v) => v + '°'} /><//>` : null}
      <${SettingRow} title=${t('Panel opacity')} desc=${t('Lower values let more wallpaper through.')} stack><${SSlider} path="theme.panelOpacity" scale=${100} min=${5} max=${100} format=${pct} /><//>
      <${SettingRow} title=${t('Panel blur')} desc=${t('Frosted-glass blur behind panels.')} stack><${SSlider} path="theme.panelBlur" min=${0} max=${60} format=${px} /><//>
      <${SettingRow} title=${t('Glass saturation')} stack><${SSlider} path="theme.saturation" scale=${100} min=${50} max=${220} format=${pct} /><//>
    <//>
    <${Section} title=${t('Shape & spacing')}>
      <${SettingRow} title=${t('Corner radius')} stack><${SSlider} path="theme.radius" min=${0} max=${36} format=${px} /><//>
      <${SettingRow} title=${t('Gap between panels')} stack><${SSlider} path="theme.gap" min=${0} max=${24} format=${px} /><//>
    <//>
    <${Section} title=${t('Text color')}>
      <${SettingRow} title=${t('Custom text color')} desc=${t('By default text adapts to light or dark surfaces.')}><${Toggle} checked=${!!th.textColor} onChange=${(on) => setT('textColor', on ? (th.mode === 'light' ? '#1a1530' : '#f4f2ff') : null)} />${th.textColor ? html`<${ColorSwatch} value=${th.textColor} onChange=${(c) => setT('textColor', c)} label=${t('Text color')} size=${34} />` : null}<//>
    <//>
    <div class="reset-row"><${Btn} variant="ghost" icon="rotate-cw" onClick=${() => resetSettings(['theme'])}>${t('Reset theme to defaults')}<//></div>
  </div>`;
}

/* ------------------------------------------------------------------ wallpaper */
function useWorkingSrc(url) {
  const proxy = proxied(url); const [src, setSrc] = useState(proxy);
  useEffect(() => { let live = true; setSrc(proxy); const im = new Image(); im.onerror = () => { if (live && proxy !== url) setSrc(url); }; im.src = proxy; return () => { live = false; }; }, [url]);
  return src;
}
function PhotoTile({ p, active, onClick }) {
  const src = useWorkingSrc(p.url);
  return html`<${Tile} active=${active} style=${{ backgroundImage: `url("${src}")` }} label=${p.name} onClick=${onClick} />`;
}
function Tile({ active, style, label, onClick, children, onRemove }) {
  return html`<div class="wp-tile-wrap"><button type="button" class=${cx('wp-tile', active && 'sel')} style=${style} onClick=${onClick} aria-label=${label}>${active ? html`<span class="wp-check"><${Icon} name="check" size=${14} sw=${3.5} /></span>` : null}${children}<span class="wp-label">${label}</span></button>${onRemove ? html`<button type="button" class="wp-x" aria-label="Remove" onClick=${onRemove}><${Icon} name="x" size=${12} sw=${3} /></button>` : null}</div>`;
}
export function WallpaperPage() {
  const bg = useSel((s) => s.settings.bg);
  const [url, setUrl] = useState(''); const [busy, setBusy] = useState(false);
  const setBg = (patch) => updateSettings({ bg: patch });
  const addImage = (u) => { const lib = [u, ...bg.library.filter((x) => x !== u)].slice(0, 8); setBg({ type: 'image', image: u, library: lib }); };
  const doUpload = async () => {
    const file = await pickFile('image/png,image/jpeg,image/webp,image/gif,image/avif'); if (!file) return;
    if (file.size > 25 * 1024 * 1024) { toast('Image is too large (25 MB max)', 'error'); return; }
    setBusy(true); try { const r = await upload(file); addImage(r.url); toast('Wallpaper added', 'success', 1800); } catch (e) { toast(errMsg(e), 'error'); } setBusy(false);
  };
  const applyUrl = async () => {
    const u = url.trim(); if (!/^https?:\/\//i.test(u)) { toast('Paste a full image link starting with https://', 'error'); return; }
    setBusy(true);
    const ok = await new Promise((res) => { const im = new Image(); im.onload = () => res(true); im.onerror = () => res(false); im.src = proxied(u); });
    setBusy(false); if (!ok) { toast('Couldn’t load that image. Check the link.', 'error'); return; } addImage(u); setUrl('');
  };
  return html`<div class="s-page">
    <${ThemePreview} />
    <${Section} title=${t('Wallpaper')} desc=${t('Choose what sits behind the glass. Everything updates live.')}>
      <h4 class="s-sub">${t('Gradients')}</h4>
      <div class="wp-grid">${MESH_WALLPAPERS.map((m) => html`<${Tile} key=${m.id} active=${bg.type === 'mesh' && bg.mesh === m.id} style=${{ background: meshCss(m) }} label=${m.name} onClick=${() => setBg({ type: 'mesh', mesh: m.id })} />`)}</div>
      <h4 class="s-sub">${t('Photos')}</h4>
      <div class="wp-grid">${PHOTO_WALLPAPERS.map((p) => html`<${PhotoTile} key=${p.id} p=${p} active=${bg.type === 'photo' && bg.photo === p.id} onClick=${() => setBg({ type: 'photo', photo: p.id })} />`)}</div>
      <h4 class="s-sub">${t('Your images')}</h4>
      <div class="wp-grid">
        <button type="button" class="wp-tile add" onClick=${doUpload} disabled=${busy}><${Icon} name="upload" size=${22} /><span>${busy ? t('Working…') : t('Upload image')}</span></button>
        ${bg.library.map((u) => html`<${Tile} key=${u} active=${bg.type === 'image' && bg.image === u} style=${{ backgroundImage: `url("${proxied(u)}")` }} label=${t('Custom')} onClick=${() => setBg({ type: 'image', image: u })} onRemove=${() => updateSettings({ bg: { library: bg.library.filter((x) => x !== u) } })} />`)}
        <${Tile} active=${bg.type === 'solid'} style=${{ background: bg.color }} label=${t('Solid color')} onClick=${() => setBg({ type: 'solid' })}><${Icon} name="palette" size=${20} /><//>
        <${Tile} active=${bg.type === 'gradient'} style=${{ background: `linear-gradient(${bg.gradient.angle}deg, ${bg.gradient.c1}, ${bg.gradient.c2})` }} label=${t('Custom gradient')} onClick=${() => setBg({ type: 'gradient' })}><${Icon} name="sliders" size=${20} /><//>
      </div>
      <div class="url-row"><${TextInput} value=${url} onInput=${setUrl} placeholder=${t('Or paste an image link…')} icon="link" onKeyDown=${(e) => e.key === 'Enter' && applyUrl()} /><${Btn} variant="primary" loading=${busy} disabled=${!url.trim()} onClick=${applyUrl}>${t('Use link')}<//></div>
      ${bg.type === 'solid' ? html`<div class="color-row slide-up"><div class="cr-item"><${ColorSwatch} value=${bg.color} onChange=${(c) => updateSettings({ bg: { color: c } })} label=${t('Background color')} size=${40} /><span>${t('Background color')}<small>${bg.color}</small></span></div></div>` : null}
      ${bg.type === 'gradient' ? html`<div class="color-row slide-up"><div class="cr-item"><${ColorSwatch} value=${bg.gradient.c1} onChange=${(c) => updateSettings({ bg: { gradient: { c1: c } } })} size=${40} label="From" /><span>${t('From')}<small>${bg.gradient.c1}</small></span></div><div class="cr-item"><${ColorSwatch} value=${bg.gradient.c2} onChange=${(c) => updateSettings({ bg: { gradient: { c2: c } } })} size=${40} label="To" /><span>${t('To')}<small>${bg.gradient.c2}</small></span></div>
        <div class="grow"><${SSlider} path="bg.gradient.angle" min=${0} max=${360} format=${(v) => v + '°'} label=${t('Angle')} /></div></div>` : null}
    <//>
    <${Section} title=${t('Adjustments')}>
      <${SettingRow} title=${t('Wallpaper blur')} desc=${t('Blurs the wallpaper image itself. 0 keeps it perfectly sharp.')} stack><${SSlider} path="bg.blur" min=${0} max=${40} format=${px} /><//>
      <${SettingRow} title=${t('Panel blur')} desc=${t('Frosted glass on the panels in front of the wallpaper. This is what blurs the picture you see through the UI — set it to 0 for a crisp wallpaper. (Capped at 3px while rain is on, so the drops stay visible.)')} stack><${SSlider} path="theme.panelBlur" min=${0} max=${60} format=${px} /><//>
      <${SettingRow} title=${t('Dim')} desc=${t('Darkens (or lightens, in light mode) the wallpaper for readability.')} stack><${SSlider} path="bg.dim" scale=${100} min=${0} max=${90} format=${pct} /><//>
      <${SettingRow} title=${t('Brightness')} stack><${SSlider} path="bg.brightness" scale=${100} min=${40} max=${160} format=${pct} /><//>
      <${SettingRow} title=${t('Saturation')} stack><${SSlider} path="bg.saturate" scale=${100} min=${0} max=${220} format=${pct} /><//>
      <${SettingRow} title=${t('Zoom')} stack><${SSlider} path="bg.zoom" scale=${100} min=${100} max=${250} format=${pct} /><//>
      <${SettingRow} title=${t('Position')} desc=${t('Slide the visible area of the image.')} stack><div class="two-sliders"><${SSlider} path="bg.posX" min=${0} max=${100} label="X" format=${pct} /><${SSlider} path="bg.posY" min=${0} max=${100} label="Y" format=${pct} /></div><//>
      <${SettingRow} title=${t('Parallax')} desc=${t('The wallpaper drifts gently as you move your mouse.')}><${SToggle} path="bg.parallax" /><//>
    <//>
    <div class="reset-row"><${Btn} variant="ghost" icon="rotate-cw" onClick=${() => resetSettings(['bg'])}>${t('Reset wallpaper')}<//></div>
  </div>`;
}

/* ------------------------------------------------------------------ effects */
export function EffectsPage() {
  const rain = useSel((s) => s.settings.rain); const g = useSel((s) => s.settings.glass); const m = useSel((s) => s.settings.motion); const fx = useSel((s) => s.settings.fx);
  const rainOn = rain.enabled && !m.reduce;
  const scopes = [['panels', 'Panels, menus & windows'], ['rail', 'Server icons'], ['nav', 'Navigation buttons'], ['toolbar', 'Toolbar & header buttons'], ['buttons', 'Action buttons'], ['composer', 'Message box']];
  return html`<div class="s-page">
    <${Section} title=${t('Rain on glass')} desc=${t('The original Codrops raindrop effect: drops refract your wallpaper upside-down, merge, slide down and leave trails on foggy glass.')}>
      <${SettingRow} title=${t('Enable rain')} desc=${m.reduce ? t('Turn off “Reduce motion” to use this.') : t('Runs on the GPU. Pauses automatically when the tab is hidden.')}><${SToggle} path="rain.enabled" onChange=${(on) => on && state.settings.bg.type === 'solid' && updateSettings({ bg: { type: 'mesh' } })} /><//>
      <div class=${cx('rain-controls', !rainOn && 'dim')}>
        <div class="preset-row">${Object.entries(RAIN_PRESETS).map(([k, p]) => html`<button type="button" class=${cx('preset-chip', rain.preset === k && 'on')} onClick=${() => { const { label, ...vals } = p; updateSettings({ rain: { ...vals, preset: k, enabled: true } }); }}><${Icon} name="droplet" size=${14} />${p.label}</button>`)}</div>
        <${SettingRow} title=${t('Amount')} desc=${t('How much rain keeps falling.')} stack><${SSlider} path="rain.amount" scale=${100} min=${0} max=${70} format=${pct} /><//>
        <${SettingRow} title=${t('Drop size')} stack><${SSlider} path="rain.size" scale=${100} min=${50} max=${180} format=${pct} /><//>
        <${SettingRow} title=${t('Speed')} stack><${SSlider} path="rain.speed" scale=${100} min=${30} max=${220} format=${pct} /><//>
        <${SettingRow} title=${t('Refraction')} desc=${t('How far each drop bends and flips the scene behind it.')} stack><${SSlider} path="rain.refraction" scale=${100} min=${30} max=${180} format=${pct} /><//>
        <${SettingRow} title=${t('Mist')} desc=${t('Fog on the glass between the drops (adds to the wallpaper blur).')} stack><${SSlider} path="rain.mist" min=${0} max=${40} format=${px} /><//>
        <${SettingRow} title=${t('Wet trails')} stack><${SSlider} path="rain.trails" scale=${100} min=${0} max=${500} format=${(v) => (v / 100).toFixed(1) + '×'} /><//>
        <${SettingRow} title=${t('Tiny droplets')} stack><${SSlider} path="rain.droplets" min=${0} max=${120} format=${(v) => v} /><//>
        <${SettingRow} title=${t('Lightning')} desc=${t('Random flashes, like the demo’s storm.')} stack><${SSlider} path="rain.lightning" scale=${100} min=${0} max=${25} format=${pct} /><//>
        <${SettingRow} title=${t('Frame rate')} desc=${t('30 FPS saves battery.')}><${Segmented} size="sm" options=${[{ value: 30, label: '30' }, { value: 60, label: '60' }]} value=${rain.fps} onChange=${(v) => setSetting('rain.fps', v)} /><//>
      </div>
    <//>
    <${Section} title=${t('Liquid glass')} desc=${t('Apple-style glass for the whole interface — panels, menus, windows and buttons. The rims bend whatever is behind them.')}>
      <div class="glass-demo"><button type="button" class="btn glass glass-buttons">${t('Primary')}</button><button type="button" class="icon-btn glass glass-toolbar"><${Icon} name="settings" size=${19} /></button><button type="button" class="btn glass glass-buttons"><${Icon} name="sparkles" size=${16} />${t('Explore')}</button><span class="rail-btn glass glass-rail" style="--s:46px"><${Icon} name="hash" size=${22} /></span></div>
      <${SettingRow} title=${t('Enable liquid glass')} desc=${t('Off by default. Turn it on for glass everywhere, or pick which parts below.')}><${Toggle} checked=${g.style !== 'off'} onChange=${(on) => setSetting('glass.style', on ? (g.last === 'frosted' ? 'frosted' : 'liquid') : 'off')} /><//>
      <div class=${cx(g.style === 'off' && 'dim')}>
        <${SettingRow} title=${t('Style')}><${Segmented} size="sm" options=${[{ value: 'liquid', label: t('Liquid') }, { value: 'frosted', label: t('Frosted') }]} value=${g.style === 'off' ? (g.last || 'liquid') : g.style} onChange=${(v) => updateSettings({ glass: { style: v, last: v } })} /><//>
        ${g.style === 'liquid' ? html`<div class="note-chip"><${Icon} name="info" size=${14} /> ${t('Liquid glass is drawn on the GPU (WebGL). If your browser can’t run it, glass falls back to a frosted look.')}</div>` : null}
        <${SettingRow} title=${t('Intensity')} desc=${t('Refraction strength, reflection and rim light.')} stack><${SSlider} path="glass.intensity" scale=${100} min=${10} max=${100} format=${pct} /><//>
        <h4 class="s-sub">${t('Apply to')}</h4>
        ${scopes.map(([k, l]) => html`<${SettingRow} title=${t(l)}><${SToggle} path=${'glass.' + k} /><//>`)}
      </div>
    <//>
    <${Section} title=${t('Button effects')} desc=${t('Little touches that make every click feel good.')}>
      <${SettingRow} title=${t('Particle bursts')} desc=${t('Sparkles when you send, react, toggle or confirm.')}><${SToggle} path="fx.particles" /><//>
      <${SettingRow} title=${t('Press ripples')}><${SToggle} path="fx.ripples" /><//>
      <${SettingRow} title=${t('Amount')} stack><${SSlider} path="fx.amount" scale=${100} min=${30} max=${200} format=${pct} disabled=${!fx.particles} /><//>
    <//>
    <${Section} title=${t('Motion')}>
      <${SettingRow} title=${t('Reduce motion')} desc=${t('Turns off most animations and the rain effect.')}><${SToggle} path="motion.reduce" /><//>
      <${SettingRow} title=${t('Animation speed')} stack><${SSlider} path="motion.speed" scale=${100} min=${50} max=${200} format=${(v) => (v / 100).toFixed(1) + '×'} disabled=${m.reduce} /><//>
    <//>
    <div class="reset-row"><${Btn} variant="ghost" icon="rotate-cw" onClick=${() => resetSettings(['rain', 'glass', 'motion', 'fx'])}>${t('Reset effects')}<//></div>
  </div>`;
}

/* ------------------------------------------------------------------ fonts */
export function FontsPage() {
  const f = useSel((s) => s.settings.fonts);
  const setF = (k, v) => updateSettings({ fonts: { [k]: v } });
  return html`<div class="s-page">
    <${Section} title=${t('Fonts')} desc=${t('Search the entire Google Fonts library. Every font in the list is shown in its own typeface.')}>
      <${SettingRow} title=${t('Interface font')} desc=${t('Menus, buttons and labels.')} stack><${FontField} value=${f.ui} onChange=${(v) => setF('ui', v || 'Inter')} defaultName="Inter" label="Interface font" /><//>
      <${SettingRow} title=${t('Chat font')} desc=${t('Used for message text. Leave on “same as interface” to match.')} stack>
        <div class="font-pair"><${FontField} value=${f.chat} onChange=${(v) => setF('chat', v)} defaultName=${f.ui || 'Inter'} label="Chat font" />${f.chat ? html`<${Btn} size="sm" variant="ghost" onClick=${() => setF('chat', null)}>${t('Same as interface')}<//>` : null}</div><//>
      <${SettingRow} title=${t('Code font')} desc=${t('Inline code and code blocks.')} stack><${FontField} value=${f.code} mono=${true} onChange=${(v) => setF('code', v || 'JetBrains Mono')} defaultName="JetBrains Mono" label="Code font" /><//>
    <//>
    <${Section} title=${t('Text')}>
      <${SettingRow} title=${t('Chat font size')} stack><${SSlider} path="fonts.size" min=${12} max=${24} format=${px} /><//>
      <${SettingRow} title=${t('Weight')} desc=${t('Interface weight (if the font supports it).')} stack><${SSlider} path="fonts.weight" min=${300} max=${600} step=${100} format=${(v) => v} /><//>
      <${SettingRow} title=${t('Line height')} stack><${SSlider} path="fonts.lineHeight" scale=${100} min=${110} max=${200} format=${(v) => (v / 100).toFixed(2)} /><//>
      <${SettingRow} title=${t('Letter spacing')} stack><${SSlider} path="fonts.letterSpacing" scale=${100} min=${-5} max=${20} format=${(v) => (v / 100).toFixed(2) + 'em'} /><//>
    <//>
    <${Section} title=${t('Preview')}>
      <div class="font-preview"><p class="fpv-ui">${t('Interface')}: Orate — The quick brown fox jumps over the lazy dog.</p>
        <p class="msg-content" style="font-size:var(--font-size)">${t('Chat')}: The quick brown fox jumps over the lazy dog. <strong>Bold</strong>, <em>italic</em> and <span class="mention">@mention</span>.</p>
        <pre class="codeblock fpv-code"><code>const greeting = "hello, world"; // ${t('Code')}</code></pre></div>
    <//>
    <div class="reset-row"><${Btn} variant="ghost" icon="rotate-cw" onClick=${() => resetSettings(['fonts'])}>${t('Reset fonts')}<//></div>
  </div>`;
}

/* ------------------------------------------------------------------ chat display */
export function ChatPage() {
  const c = useSel((s) => s.settings.chat);
  return html`<div class="s-page">
    <${Section} title=${t('Message display')}>
      <${SettingRow} title=${t('Compact mode')} desc=${t('Fit more messages on screen with tighter spacing.')}><${SToggle} path="chat.compact" /><//>
      <${SettingRow} title=${t('Show avatars')}><${SToggle} path="chat.showAvatars" /><//>
      <${SettingRow} title=${t('Space between message groups')} stack><${SSlider} path="chat.spacing" min=${0} max=${32} format=${px} /><//>
      <${SettingRow} title=${t('24-hour time')} desc=${t('Show times like 21:41 instead of 9:41 PM.')}><${SToggle} path="chat.hour24" /><//>
    <//>
    <${Section} title=${t('Media & links')}>
      <${SettingRow} title=${t('Link previews')} desc=${t('Show a card for links and play YouTube inline.')}><${SToggle} path="chat.linkPreviews" /><//>
      <${SettingRow} title=${t('Autoplay GIFs')} desc=${t('When off, GIFs show a still frame until opened.')}><${SToggle} path="chat.gifAutoplay" /><//>
      <${SettingRow} title=${t('Large emoji')} desc=${t('Messages that only contain emoji are shown bigger.')}><${SToggle} path="chat.jumbo" /><//>
    <//>
    <div class="s-preview panel">
      <div class=${cx('msg-scroller', c.compact && 'compact')} style="height:auto;padding:6px 0">
        <div class="msg head"><div class="msg-main"><div class="msg-gutter">${c.showAvatars ? html`<${Avatar} user=${state.me} size=${40} />` : null}</div><div class="msg-body"><div class="msg-head"><span class="msg-author">${state.me.displayName}</span><time class="msg-time">Today at ${c.hour24 ? '21:41' : '9:41 PM'}</time></div><div class="msg-content">Here is a sample message to preview your settings. 😀</div></div></div></div>
        <div class="msg cont"><div class="msg-main"><div class="msg-gutter"><time class="msg-time hover-time" style="opacity:1">${c.hour24 ? '21:42' : '9:42 PM'}</time></div><div class="msg-body"><div class="msg-content">And a second line from the same author.</div></div></div></div>
      </div></div>
  </div>`;
}
void DEFAULT_SETTINGS; void set; void Dropdown;
