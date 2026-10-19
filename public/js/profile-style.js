// Orate — profile styling: how a styled profile card is drawn (colors, outline, shadow, fonts, name style, effect) and the editor for it.
// The options and their validation live in profile-data.js (shared with the server); the effect animations in profile-effects.js.
import { html, useState, useEffect, useRef, cx, hexToRgb } from '/js/lib.js';
import { useSel } from '/js/store.js';
import { Btn, Segmented, Dropdown, Slider, Toggle, ColorSwatch } from '/js/ui.js';
import { loadFont } from '/js/theme.js';
import { startEffect } from '/js/profile-effects.js';
import { t } from '/js/i18n.js';
import { PROFILE_FONTS, EFFECTS, OUTLINE_STYLES, PROFILE_DEFAULTS, fontFamily, effectColors } from '/js/profile-data.js';

const rgba = (h, a) => { const [r, g, b] = hexToRgb(h); return `rgb(${r} ${g} ${b} / ${a})`; };
const q = (family) => `"${family}"`;
const grad = (f) => (f.mode === 'gradient' ? `linear-gradient(${f.angle}deg, ${f.a}, ${f.b})` : f.a);

/** The CSS custom properties and classes a styled profile card needs. */
export function cardLook(p) {
  const style = {}; const cls = [];
  if (!p) return { style, cls };
  if (p.colors) { const c = p.colors; style['--pf-bg'] = c.mode === 'gradient' ? `linear-gradient(${c.angle}deg, ${rgba(c.a, c.tint)}, ${rgba(c.b, c.tint)})` : rgba(c.a, c.tint); cls.push('pf-colors'); }
  if (p.outline) { const o = p.outline; Object.assign(style, { '--pf-ol': o.color, '--pf-ol2': o.color2 || o.color, '--pf-olw': `${o.width}px` }); cls.push('pf-outline'); }
  if (p.shadow) { const s = p.shadow; style['--pf-shadow'] = `${s.x}px ${s.y}px ${s.blur}px ${s.spread}px ${rgba(s.color, s.alpha)}`; style['--pf-glow'] = `inset 0 0 ${Math.round(s.blur * 0.7)}px ${Math.round(s.spread / 2)}px ${rgba(s.color, s.alpha * 0.55)}`; cls.push('pf-shadow'); }
  if (p.fonts?.name && fontFamily(p.fonts.name)) { style['--pf-name-font'] = q(fontFamily(p.fonts.name)); cls.push('pf-name-font'); }
  if (p.fonts?.text && fontFamily(p.fonts.text)) { style['--pf-text-font'] = q(fontFamily(p.fonts.text)); cls.push('pf-text-font'); }
  return { style, cls };
}

/**
 * A display name with the person's name style: a color or gradient fill, an outline (also solid or gradient) and a shadow with its own angle.
 * Three layers — outline behind, fill in front, `filter: drop-shadow` around both — so the gradient, the outline and the shadow never fight.
 */
export function NameText({ text, profile: p, class: c }) {
  const fillOn = p?.nameColor; const ol = p?.nameOutline; const sh = p?.nameShadow;
  const style = {};
  if (fillOn) Object.assign(style, { '--pn-a': fillOn.a, '--pn-b': fillOn.mode === 'gradient' ? fillOn.b : fillOn.a, '--pn-angle': `${fillOn.angle}deg` });
  if (ol) Object.assign(style, { '--pno-a': ol.a, '--pno-b': ol.mode === 'gradient' ? ol.b : ol.a, '--pno-angle': `${ol.angle}deg`, '--pno-w': `${ol.width}px` });
  if (sh) { const rad = (sh.angle * Math.PI) / 180; style.filter = `drop-shadow(${(Math.cos(rad) * sh.distance).toFixed(1)}px ${(Math.sin(rad) * sh.distance).toFixed(1)}px ${sh.blur}px ${sh.color})`; }
  return html`<span class=${cx('pn', c)} style=${style}>${ol ? html`<span class=${cx('pn-o', ol.mode === 'gradient' && 'grad')} aria-hidden="true">${text}</span>` : null}<span class=${cx('pn-f', fillOn && (fillOn.mode === 'gradient' ? 'grad' : 'solid'))}>${text}</span></span>`;
}

/** The effect drawn over a profile card. Pauses when the tab is hidden and shows a still picture under Reduce motion. */
export function ProfileEffect({ fx }) {
  const ref = useRef(null); const reduce = useSel((s) => s.settings.motion?.reduce);
  useEffect(() => (ref.current ? startEffect(ref.current, fx, { reduce }) : undefined), [fx?.id, fx?.color, fx?.color2, fx?.density, fx?.speed, reduce]);
  return html`<canvas class="pf-fx" ref=${ref} aria-hidden="true"></canvas>`;
}

/** The decorations a styled card draws around its content (outline and effect). */
export function CardDecor({ profile: p }) {
  if (!p || (!p.outline && !p.effect)) return null;
  return html`${p.outline ? html`<span class=${cx('pf-ol', p.outline.style !== 'solid' && 'pf-ol-line')} style=${p.outline.style !== 'solid' ? { border: `${p.outline.width}px ${p.outline.style} ${p.outline.color}` } : null}></span>` : null}${p.effect ? html`<${ProfileEffect} fx=${p.effect} />` : null}`;
}

/** Loads the fonts a profile uses (once per page). */
export function useProfileFonts(p) {
  const a = p?.fonts?.name; const b = p?.fonts?.text;
  useEffect(() => { for (const id of [a, b]) { const f = fontFamily(id); if (f) loadFont(f); } }, [a, b]);
}

/* ------------------------------------------------------------------ editor */
const has = (p, k) => !!p?.[k];
function Row({ label, children, wide }) { return html`<div class=${cx('ps-row', wide && 'wide')}><span class="ps-label">${label}</span><div class="ps-ctl">${children}</div></div>`; }
function Swatch({ value, onChange, label }) { return html`<${ColorSwatch} value=${value} onChange=${onChange} label=${label} size=${30} />`; }
function Group({ title, on, onToggle, children, desc }) {
  return html`<div class=${cx('ps-group', !on && 'off')}><header><div><b>${title}</b>${desc ? html`<small>${desc}</small>` : null}</div><${Toggle} checked=${on} onChange=${onToggle} /></header>${on ? html`<div class="ps-body">${children}</div>` : null}</div>`;
}
/** One option of the effect gallery: its name with a live little preview below it. */
function EffectOption({ id, name, on, fx, onPick }) {
  const ref = useRef(null); const reduce = useSel((s) => s.settings.motion?.reduce);
  useEffect(() => (ref.current ? startEffect(ref.current, { ...fx, id }, { reduce, fps: 24, onlyWhenVisible: true, size: { width: 150, height: 84 } }) : undefined), [id, fx.color, fx.color2, fx.density, fx.speed, reduce]);
  return html`<button type="button" class=${cx('ps-fx', on && 'on')} onClick=${onPick} aria-pressed=${on}><span class="ps-fx-name">${t(name)}</span><span class="ps-fx-view"><canvas ref=${ref} aria-hidden="true"></canvas></span></button>`;
}
/** Solid / gradient fill controls shared by the name color and the name outline. */
function FillControls({ f, put, label, extra }) {
  return html`
    <${Row} label=${t('Style')}><${Segmented} size="sm" options=${[{ value: 'solid', label: t('Solid') }, { value: 'gradient', label: t('Gradient') }]} value=${f.mode} onChange=${(v) => put({ mode: v })} /><//>
    <${Row} label=${t('Colors')}><${Swatch} value=${f.a} onChange=${(v) => put({ a: v })} label=${label} />${f.mode === 'gradient' ? html`<${Swatch} value=${f.b} onChange=${(v) => put({ b: v })} label=${t('Second color')} />` : null}<//>
    ${f.mode === 'gradient' ? html`<${Row} label=${t('Angle')} wide=${true}><${Slider} value=${f.angle} min=${0} max=${360} step=${5} onChange=${(v) => put({ angle: v })} format=${(v) => v + '°'} /><//>` : null}
    ${extra}`;
}

/**
 * Edits `value` (the profile style, or null). Every change goes through `change(fn)` where `fn` turns the previous style into the next one —
 * safe to call from colour popovers that were opened earlier.
 */
export function ProfileStyleEditor({ value, change, me }) {
  const [tab, setTab] = useState('colors');
  const p = value || null;
  const put = (key, patch) => change((prev) => ({ ...(prev || {}), [key]: { ...(prev?.[key] || PROFILE_DEFAULTS[key]), ...patch } }));
  const toggle = (key, on) => change((prev) => { const n = { ...(prev || {}) }; if (on) n[key] = { ...PROFILE_DEFAULTS[key] }; else delete n[key]; return Object.keys(n).length ? n : null; });
  const fonts = [{ value: '', label: t('Default') }, ...PROFILE_FONTS.map(([id, fam]) => ({ value: id, label: fam }))];   // '' (not null): the dropdown matches options by value
  const fontOpt = (o) => { const fam = fontFamily(o.value); if (fam) loadFont(fam); return html`<span style=${fam ? { fontFamily: q(fam), fontSize: '16px' } : null}>${o.label}</span>`; };
  const tabs = [{ value: 'colors', label: t('Colors') }, { value: 'outline', label: t('Outline') }, { value: 'name', label: t('Name & text') }, { value: 'effect', label: t('Effect') }];
  const c = p?.colors; const o = p?.outline; const s = p?.shadow; const f = p?.fonts; const nc = p?.nameColor; const no = p?.nameOutline; const ns = p?.nameShadow; const e = p?.effect;
  const nameFont = f?.name ? { fontFamily: q(fontFamily(f.name)), fontWeight: 400 } : null;
  return html`<div class="ps-editor">
    <div class="ps-tabs"><${Segmented} options=${tabs} value=${tab} onChange=${setTab} size="sm" /></div>
    ${tab === 'colors' ? html`
      <${Group} title=${t('Card colors')} desc=${t('Tint the whole profile card with a color or a gradient.')} on=${has(p, 'colors')} onToggle=${(v) => toggle('colors', v)}>
        <${Row} label=${t('Style')}><${Segmented} size="sm" options=${[{ value: 'solid', label: t('Solid') }, { value: 'gradient', label: t('Gradient') }]} value=${c?.mode} onChange=${(v) => put('colors', { mode: v })} /><//>
        <${Row} label=${t('Colors')}><${Swatch} value=${c?.a} onChange=${(v) => put('colors', { a: v })} label=${t('First color')} />${c?.mode === 'gradient' ? html`<${Swatch} value=${c?.b} onChange=${(v) => put('colors', { b: v })} label=${t('Second color')} />` : null}<//>
        ${c?.mode === 'gradient' ? html`<${Row} label=${t('Angle')} wide=${true}><${Slider} value=${c.angle} min=${0} max=${360} step=${5} onChange=${(v) => put('colors', { angle: v })} format=${(v) => v + '°'} /><//>` : null}
        <${Row} label=${t('Strength')} wide=${true}><${Slider} value=${Math.round((c?.tint ?? 0.35) * 100)} min=${5} max=${100} onChange=${(v) => put('colors', { tint: v / 100 })} format=${(v) => v + '%'} /><//>
      <//>` : null}
    ${tab === 'outline' ? html`
      <${Group} title=${t('Outline')} desc=${t('A border around your profile card.')} on=${has(p, 'outline')} onToggle=${(v) => toggle('outline', v)}>
        <${Row} label=${t('Style')}><${Segmented} size="sm" options=${OUTLINE_STYLES.map((x) => ({ value: x, label: t(x[0].toUpperCase() + x.slice(1)) }))} value=${o?.style} onChange=${(v) => put('outline', { style: v })} /><//>
        <${Row} label=${t('Colors')}><${Swatch} value=${o?.color} onChange=${(v) => put('outline', { color: v })} label=${t('Outline color')} />${o?.color2 ? html`<${Swatch} value=${o.color2} onChange=${(v) => put('outline', { color2: v })} label=${t('Second color')} /><button type="button" class="link-btn" onClick=${() => put('outline', { color2: null })}>${t('Single color')}</button>` : html`<button type="button" class="link-btn" onClick=${() => put('outline', { color2: '#ec4899' })}>${t('Add a gradient')}</button>`}<//>
        ${o?.color2 && o.style !== 'solid' ? html`<p class="ps-note">${t('Gradient outlines use the Solid style.')}</p>` : null}
        <${Row} label=${t('Thickness')} wide=${true}><${Slider} value=${o?.width ?? 2} min=${1} max=${8} onChange=${(v) => put('outline', { width: v })} format=${(v) => v + 'px'} /><//>
      <//>
      <${Group} title=${t('Shadow & glow')} desc=${t('A soft glow around and inside your card.')} on=${has(p, 'shadow')} onToggle=${(v) => toggle('shadow', v)}>
        <${Row} label=${t('Color')}><${Swatch} value=${s?.color} onChange=${(v) => put('shadow', { color: v })} label=${t('Shadow color')} /><//>
        <${Row} label=${t('Blur')} wide=${true}><${Slider} value=${s?.blur ?? 30} min=${0} max=${80} onChange=${(v) => put('shadow', { blur: v })} format=${(v) => v + 'px'} /><//>
        <${Row} label=${t('Spread')} wide=${true}><${Slider} value=${s?.spread ?? 0} min=${0} max=${30} onChange=${(v) => put('shadow', { spread: v })} format=${(v) => v + 'px'} /><//>
        <${Row} label=${t('Strength')} wide=${true}><${Slider} value=${Math.round((s?.alpha ?? 0.55) * 100)} min=${5} max=${100} onChange=${(v) => put('shadow', { alpha: v / 100 })} format=${(v) => v + '%'} /><//>
        <${Row} label=${t('Offset')} wide=${true}><${Slider} value=${s?.x ?? 0} min=${-40} max=${40} onChange=${(v) => put('shadow', { x: v })} format=${(v) => `x ${v}`} /><${Slider} value=${s?.y ?? 8} min=${-40} max=${40} onChange=${(v) => put('shadow', { y: v })} format=${(v) => `y ${v}`} /><//>
      <//>` : null}
    ${tab === 'name' ? html`
      <div class="ps-namepreview" style=${nameFont}><${NameText} text=${me?.displayName || 'Name'} profile=${p} /></div>
      <div class="ps-group"><div class="ps-body flat">
        <${Row} label=${t('Name font')} wide=${true}><${Dropdown} value=${f?.name || ''} options=${fonts} onChange=${(v) => put('fonts', { name: v || null })} renderOption=${fontOpt} /><//>
        <${Row} label=${t('Text font')} wide=${true}><${Dropdown} value=${f?.text || ''} options=${fonts} onChange=${(v) => put('fonts', { text: v || null })} renderOption=${fontOpt} /><//>
        <p class="ps-note">${t('The text font is used for your username, status and About me.')}</p>
      </div></div>
      <${Group} title=${t('Name color')} desc=${t('A color or gradient for your name.')} on=${has(p, 'nameColor')} onToggle=${(v) => toggle('nameColor', v)}>
        <${FillControls} f=${nc || PROFILE_DEFAULTS.nameColor} put=${(patch) => put('nameColor', patch)} label=${t('Name color')} />
      <//>
      <${Group} title=${t('Name outline')} desc=${t('An outline around the letters — solid or a gradient.')} on=${has(p, 'nameOutline')} onToggle=${(v) => toggle('nameOutline', v)}>
        <${FillControls} f=${no || PROFILE_DEFAULTS.nameOutline} put=${(patch) => put('nameOutline', patch)} label=${t('Outline color')} extra=${html`<${Row} label=${t('Thickness')} wide=${true}><${Slider} value=${no?.width ?? 2} min=${1} max=${6} onChange=${(v) => put('nameOutline', { width: v })} format=${(v) => v + 'px'} /><//>`} />
      <//>
      <${Group} title=${t('Name shadow')} desc=${t('A shadow behind your name, at any angle. Set the distance to 0 for a glow.')} on=${has(p, 'nameShadow')} onToggle=${(v) => toggle('nameShadow', v)}>
        <${Row} label=${t('Color')}><${Swatch} value=${ns?.color || PROFILE_DEFAULTS.nameShadow.color} onChange=${(v) => put('nameShadow', { color: v })} label=${t('Shadow color')} /><//>
        <${Row} label=${t('Angle')} wide=${true}><${Slider} value=${ns?.angle ?? 135} min=${0} max=${360} step=${5} onChange=${(v) => put('nameShadow', { angle: v })} format=${(v) => v + '°'} /><//>
        <${Row} label=${t('Distance')} wide=${true}><${Slider} value=${ns?.distance ?? 4} min=${0} max=${24} onChange=${(v) => put('nameShadow', { distance: v })} format=${(v) => v + 'px'} /><//>
        <${Row} label=${t('Blur')} wide=${true}><${Slider} value=${ns?.blur ?? 0} min=${0} max=${30} onChange=${(v) => put('nameShadow', { blur: v })} format=${(v) => v + 'px'} /><//>
      <//>` : null}
    ${tab === 'effect' ? html`
      <div class="ps-fxgrid">${EFFECTS.map(([id, name]) => html`<${EffectOption} key=${id} id=${id} name=${name} on=${e?.id === id} fx=${e || { ...PROFILE_DEFAULTS.effect, ...effectColors(id) }} onPick=${() => put('effect', e ? { id } : { id, ...effectColors(id) })} />`)}</div>
      <${Group} title=${t('Profile effect')} desc=${t('Pick one above, then tune it here. Turn it off to remove it.')} on=${has(p, 'effect')} onToggle=${(v) => toggle('effect', v)}>
        <${Row} label=${t('Colors')}><${Swatch} value=${e?.color} onChange=${(v) => put('effect', { color: v })} label=${t('Effect color')} />${e?.color2 ? html`<${Swatch} value=${e.color2} onChange=${(v) => put('effect', { color2: v })} label=${t('Second color')} /><button type="button" class="link-btn" onClick=${() => put('effect', { color2: null })}>${t('Single color')}</button>` : html`<button type="button" class="link-btn" onClick=${() => put('effect', { color2: '#ec4899' })}>${t('Add a second color')}</button>`}<//>
        <${Row} label=${t('Amount')} wide=${true}><${Slider} value=${Math.round((e?.density ?? 0.6) * 100)} min=${10} max=${100} onChange=${(v) => put('effect', { density: v / 100 })} format=${(v) => v + '%'} /><//>
        <${Row} label=${t('Speed')} wide=${true}><${Slider} value=${Math.round((e?.speed ?? 1) * 100)} min=${30} max=${250} step=${10} onChange=${(v) => put('effect', { speed: v / 100 })} format=${(v) => (v / 100).toFixed(1) + '×'} /><//>
      <//>` : null}
    ${p ? html`<div class="ps-foot"><${Btn} variant="ghost" icon="x" onClick=${() => change(() => null)}>${t('Remove all profile styling')}<//></div>` : null}
  </div>`;
}
