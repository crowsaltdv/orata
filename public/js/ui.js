// Orata — shared UI primitives: avatars, buttons, form controls, modals, menus, popovers, toasts, tooltips.
import { html, cx, useState, useEffect, useRef, useLayoutEffect, useCallback, memo, clamp, hexToHsv, hsvToHex, avatarColor, uid } from '/js/lib.js';
import { thumb } from '/js/lite.js';
import { state, set, useSel, closeModal, closeContext, closePopover, dismissToast, openModal, toast } from '/js/store.js';
import { Icon, Logo } from '/js/icons.js';
import { STATUS_META } from '/js/defaults.js';
import { t } from '/js/i18n.js';

/**
 * The "you have unsaved changes" bar. Pages call useSaveBar(dirty, { save, reset, busy }); one SaveBarHost at the app root draws it,
 * so it always floats over the bottom of the screen however long the page is (a bar inside an animated page ends up at the page's end).
 */
export function useSaveBar(dirty, handlers) {
  const ref = useRef(handlers); ref.current = handlers;
  useEffect(() => {
    if (!dirty) { if (state.saveBar?.owner === ref) set({ saveBar: null }); return undefined; }
    set({ saveBar: { owner: ref, busy: !!handlers.busy, save: () => ref.current.save(), reset: () => ref.current.reset() } });
    return undefined;
  }, [dirty, !!handlers.busy]);
  useEffect(() => () => { if (state.saveBar?.owner === ref) set({ saveBar: null }); }, []);
}
export function SaveBarHost() {
  const bar = useSel((s) => s.saveBar);
  if (!bar) return null;
  return html`<div class="save-bar" role="status"><span><${Icon} name="alert-triangle" size=${18} /> ${t('Careful — you have unsaved changes!')}</span><${Btn} variant="ghost" onClick=${bar.reset}>${t('Reset')}<//><${Btn} variant="primary" loading=${bar.busy} onClick=${bar.save}>${t('Save Changes')}<//></div>`;
}

export const MODALS = {}; // kind -> Component, filled by feature modules
export const POPOVERS = {};

/* ------------------------------------------------------------------ hooks */
export function useClickOutside(ref, fn, active = true) {
  useEffect(() => {
    if (!active) return undefined;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) fn(e); };
    document.addEventListener('pointerdown', h, true);
    return () => document.removeEventListener('pointerdown', h, true);
  }, [active]);
}
export function useKey(key, fn, active = true) {
  useEffect(() => {
    if (!active) return undefined;
    const h = (e) => { if (e.key === key) fn(e); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [key, fn, active]);
}
export function useEscape(fn, active = true) { useKey('Escape', fn, active); }

/* ------------------------------------------------------------------ avatars */
export function StatusDot({ status = 'offline', size = 10, class: c, ring = true }) {
  const meta = STATUS_META[status] || STATUS_META.offline;
  return html`<span class=${cx('status-dot', `st-${status}`, ring && 'ring', c)} style=${{ width: size + 'px', height: size + 'px', '--sc': meta.color }}>${status === 'dnd' ? html`<i class="bar"></i>` : status === 'idle' ? html`<i class="cut"></i>` : null}</span>`;
}
export function Avatar({ user, userId, src, name, size = 40, status, class: c, onClick, onContextMenu, speaking, title, square, children }) {
  const u = user || (userId ? state.users[userId] : null);
  const url = thumb(src !== undefined ? src : u?.avatar, size > 64 ? 256 : 96);   // Lite mode: a smaller copy
  const id = u?.id || name || '0';
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);
  const letter = (name || u?.displayName || '?').trim().slice(0, 1).toUpperCase();
  const stSize = Math.max(8, Math.round(size * 0.3));
  const bg = u?.avatarBg ? `linear-gradient(${u.avatarBg.angle}deg, ${u.avatarBg.a}, ${u.avatarBg.b})` : avatarColor(id);   // each account's own random gradient
  return html`<span class=${cx('avatar', square && 'square', speaking && 'speaking', onClick && 'clickable', c)} style=${{ width: size + 'px', height: size + 'px', '--av': size + 'px' }} onClick=${onClick} onContextMenu=${onContextMenu} title=${title}>
    ${url && !broken
      ? html`<img src=${url} alt="" draggable=${false} loading="lazy" onError=${() => setBroken(true)} />`
      : u?.bot || !(url !== undefined && url === null && name && !u) ? html`<span class="av-default" style=${{ background: bg }}><${Logo} size=${Math.round(size * 0.62)} bg="rgba(255,255,255,.92)" /></span>`
        : html`<span class="av-default letter" style=${{ background: bg, fontSize: size * 0.44 + 'px' }}>${letter}</span>`}
    ${status ? html`<${StatusDot} status=${status} size=${stSize} class="av-status" />` : null}
    ${children}
  </span>`;
}
export const UserAvatar = memo(function UserAvatar({ userId, size = 40, showStatus = false, ...rest }) {
  const u = useSel((s) => s.users[userId]);
  return html`<${Avatar} user=${u} size=${size} status=${showStatus ? u?.status || 'offline' : undefined} ...${rest} />`;
});
export function ServerIcon({ server, size = 48, class: c }) {
  const [broken, setBroken] = useState(false);
  const acr = (server?.name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 3);
  return html`<span class=${cx('server-icon', c)} style=${{ width: size + 'px', height: size + 'px', fontSize: Math.round(size * (acr.length > 2 ? 0.28 : 0.36)) + 'px' }}>
    ${server?.icon && !broken ? html`<img src=${server.icon} alt="" draggable=${false} onError=${() => setBroken(true)} />` : html`<span class="acr">${acr}</span>`}
  </span>`;
}

/* ------------------------------------------------------------------ controls */
export function Btn({ variant = 'secondary', size, icon, children, loading, class: c, glass, ...rest }) {
  return html`<button type="button" class=${cx('btn', `btn-${variant}`, size && `btn-${size}`, loading && 'loading', glass && 'glass glass-buttons', c)} disabled=${rest.disabled || loading} ...${rest}>
    ${loading ? html`<span class="spinner sm"></span>` : icon ? html`<${Icon} name=${icon} size=${size === 'sm' ? 15 : 17} />` : null}${children ? html`<span class="btn-label">${children}</span>` : null}</button>`;
}
export function IconBtn({ icon, label, onClick, active, size = 20, class: c, danger, badge, glass = 'toolbar', pos = 'bottom', ...rest }) {
  return html`<button type="button" class=${cx('icon-btn', active && 'active', danger && 'danger', glass && `glass glass-${glass}`, c)} data-tip=${label} data-tip-pos=${pos} aria-label=${label} onClick=${onClick} ...${rest}>
    <${Icon} name=${icon} size=${size} />${badge ? html`<span class="mini-badge">${badge}</span>` : null}</button>`;
}
export function Toggle({ checked, onChange, disabled, id }) {
  return html`<button type="button" role="switch" id=${id} aria-checked=${!!checked} disabled=${disabled} class=${cx('toggle', checked && 'on')} onClick=${() => onChange?.(!checked)}><span class="knob"></span></button>`;
}
export function Slider({ value, min = 0, max = 100, step = 1, onChange, format, label, disabled, marks, class: c }) {
  const pct = ((value - min) / (max - min)) * 100;
  return html`<div class=${cx('slider', disabled && 'disabled', c)}>
    ${label ? html`<span class="slider-label">${label}</span>` : null}
    <div class="slider-track-wrap" style=${{ '--pct': pct + '%' }}>
      <input type="range" min=${min} max=${max} step=${step} value=${value} disabled=${disabled} onInput=${(e) => onChange?.(Number(e.target.value))} />
    </div>
    <span class="slider-value">${format ? format(value) : value}</span>
  </div>`;
}
export function Segmented({ options, value, onChange, class: c, size }) {
  const idx = Math.max(0, options.findIndex((o) => (o.value ?? o) === value));
  return html`<div class=${cx('segmented', size, c)} style=${{ '--n': options.length, '--i': idx }}>
    <span class="seg-thumb"></span>
    ${options.map((o) => { const v = o.value ?? o; const l = o.label ?? o; return html`<button type="button" class=${cx(v === value && 'on')} onClick=${() => onChange(v)}>${o.icon ? html`<${Icon} name=${o.icon} size=${15} />` : null}${l}</button>`; })}
  </div>`;
}
export function Field({ label, hint, error, children, class: c }) {
  return html`<label class=${cx('field', error && 'has-error', c)}>${label ? html`<span class="field-label">${label}${error ? html`<em class="field-error"> — ${error}</em>` : null}</span>` : null}${children}${hint && !error ? html`<span class="field-hint">${hint}</span>` : null}</label>`;
}
export function TextInput({ value, onInput, class: c, icon, right, ...rest }) {
  return html`<div class=${cx('input-wrap', c)}>${icon ? html`<${Icon} name=${icon} size=${16} class="in-icon" />` : null}<input class="input" value=${value} onInput=${(e) => onInput?.(e.target.value, e)} ...${rest} />${right}</div>`;
}
export function SettingRow({ title, desc, children, class: c, stack }) {
  return html`<div class=${cx('setting-row', stack && 'stack', c)}><div class="sr-text"><div class="sr-title">${title}</div>${desc ? html`<div class="sr-desc">${desc}</div>` : null}</div><div class="sr-ctl">${children}</div></div>`;
}
export function Section({ title, desc, children, class: c, action }) {
  return html`<section class=${cx('s-section', c)}>${title ? html`<header class="s-head"><div><h3>${title}</h3>${desc ? html`<p>${desc}</p>` : null}</div>${action}</header>` : null}${children}</section>`;
}
export function Spinner({ size = 24 }) { return html`<span class="spinner" style=${{ width: size + 'px', height: size + 'px' }}></span>`; }
export function Empty({ icon = 'inbox', title, children }) { return html`<div class="empty"><div class="empty-ic"><${Icon} name=${icon} size=${34} sw=${1.6} /></div>${title ? html`<h4>${title}</h4>` : null}${children ? html`<p>${children}</p>` : null}</div>`; }
export function Badge({ n, class: c }) { return n ? html`<span class=${cx('badge', c)}>${n > 99 ? '99+' : n}</span>` : null; }

export function Dropdown({ value, options, onChange, renderOption, width, placeholder, class: c, up }) {
  const [open, setOpen] = useState(false); const ref = useRef(null);
  useClickOutside(ref, () => setOpen(false), open); useEscape(() => setOpen(false), open);
  const cur = options.find((o) => (o.value ?? o) === value);
  return html`<div class=${cx('dropdown', open && 'open', up && 'up', c)} ref=${ref} style=${width ? { width: width + 'px' } : null}>
    <button type="button" class="dd-btn" onClick=${() => setOpen(!open)}><span class="dd-val">${cur ? (renderOption ? renderOption(cur) : cur.label ?? cur) : placeholder || 'Select…'}</span><${Icon} name="chevron-down" size=${16} class="dd-chev" /></button>
    ${open ? html`<div class="dd-menu pop-in">${options.map((o) => html`<button type="button" class=${cx('dd-item', (o.value ?? o) === value && 'sel')} onClick=${() => { onChange(o.value ?? o); setOpen(false); }}>${renderOption ? renderOption(o) : o.label ?? o}${(o.value ?? o) === value ? html`<${Icon} name="check" size=${15} />` : null}</button>`)}</div>` : null}
  </div>`;
}

/* ------------------------------------------------------------------ colour picker */
export function ColorPicker({ value, onChange }) {
  const [hsv, setHsv] = useState(() => hexToHsv(value || '#8b5cf6'));
  const [hex, setHex] = useState(value || '#8b5cf6');
  const sv = useRef(null); const hue = useRef(null);
  useEffect(() => { if (value && value.toLowerCase() !== hsvToHex(...hsv).toLowerCase()) { setHsv(hexToHsv(value)); } setHex(value); }, [value]);
  const emit = (n) => { setHsv(n); const h2 = hsvToHex(...n); setHex(h2); onChange(h2); };
  const drag = (el, fn) => (e) => {
    e.preventDefault(); const move = (ev) => { const r = el.current.getBoundingClientRect(); fn(clamp((ev.clientX - r.left) / r.width, 0, 1), clamp((ev.clientY - r.top) / r.height, 0, 1)); };
    move(e); const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  return html`<div class="colorpicker">
    <div class="cp-sv" ref=${sv} style=${{ background: `hsl(${hsv[0]} 100% 50%)` }} onPointerDown=${drag(sv, (x, y) => emit([hsv[0], x, 1 - y]))}>
      <div class="cp-sv-w"></div><div class="cp-sv-b"></div><span class="cp-knob" style=${{ left: hsv[1] * 100 + '%', top: (1 - hsv[2]) * 100 + '%', background: hsvToHex(...hsv) }}></span></div>
    <div class="cp-hue" ref=${hue} onPointerDown=${drag(hue, (x) => emit([x * 360, hsv[1] || 0.01, hsv[2] || 0.01]))}><span class="cp-knob" style=${{ left: (hsv[0] / 360) * 100 + '%', background: `hsl(${hsv[0]} 100% 50%)` }}></span></div>
    <div class="cp-row"><span class="cp-prev" style=${{ background: hex }}></span>
      <input class="input cp-hex" value=${hex} spellcheck="false" maxlength="7" onInput=${(e) => { let v = e.target.value.trim(); if (!v.startsWith('#')) v = '#' + v; setHex(v); if (/^#[0-9a-f]{6}$/i.test(v)) { setHsv(hexToHsv(v)); onChange(v.toLowerCase()); } }} />
      ${window.EyeDropper ? html`<button type="button" class="icon-btn" data-tip="Pick from screen" onClick=${async () => { try { const r = await new window.EyeDropper().open(); emit(hexToHsv(r.sRGBHex)); } catch { /* cancelled */ } }}><${Icon} name="droplet" size=${16} /></button>` : null}
    </div></div>`;
}
export function ColorSwatch({ value, onChange, label, size = 36, presets }) {
  const ref = useRef(null);
  const open = () => set({ popover: { id: uid(), kind: 'color', props: { value, onChange, presets }, rect: rectOf(ref.current), placement: 'bottom' } });
  return html`<button type="button" ref=${ref} class="swatch" data-tip=${label} style=${{ '--c': value, width: size + 'px', height: size + 'px' }} onClick=${open} aria-label=${label || 'Pick colour'}><span></span></button>`;
}
function rectOf(el) { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }
POPOVERS.color = function ColorPopover({ value, onChange, presets }) {
  const [v, setV] = useState(value);
  return html`<div class="pop-card color-pop"><${ColorPicker} value=${v} onChange=${(c) => { setV(c); onChange(c); }} />
    ${presets ? html`<div class="cp-presets">${presets.map((p) => html`<button type="button" class="swatch sm" style=${{ '--c': p }} onClick=${() => { setV(p); onChange(p); }}><span></span></button>`)}</div>` : null}</div>`;
};

/* ------------------------------------------------------------------ modal */
export function Modal({ title, subtitle, onClose, children, footer, width = 440, class: c, hideClose, flush }) {
  useEscape(() => onClose?.(), true);
  const [closing, setClosing] = useState(false);
  const close = () => { setClosing(true); setTimeout(() => onClose?.(), 140); };
  return html`<div class=${cx('modal-backdrop', closing && 'closing')} onPointerDown=${(e) => { if (e.target === e.currentTarget) close(); }}>
    <div class=${cx('modal', flush && 'flush', c)} style=${{ width: `min(${width}px, calc(100vw - 24px))` }} role="dialog" aria-modal="true" aria-label=${typeof title === 'string' ? title : undefined}>
      ${title || !hideClose ? html`<header class="modal-head">${title ? html`<div><h2>${title}</h2>${subtitle ? html`<p>${subtitle}</p>` : null}</div>` : html`<span></span>`}${!hideClose ? html`<button type="button" class="icon-btn" aria-label="Close" onClick=${close}><${Icon} name="x" size=${20} /></button>` : null}</header>` : null}
      <div class="modal-body">${children}</div>
      ${footer ? html`<footer class="modal-foot">${footer}</footer>` : null}
    </div></div>`;
}
export function confirmDialog({ title, body, confirmLabel = 'Confirm', danger = false, cancelLabel = 'Cancel', input } = {}) {
  return new Promise((resolve) => { openModal('confirm', { title, body, confirmLabel, danger, cancelLabel, input, resolve }); });
}
MODALS.confirm = function ConfirmModal({ id, title, body, confirmLabel, danger, cancelLabel, input, resolve }) {
  const [val, setVal] = useState(''); const done = (v) => { closeModal(id); resolve(v); };
  return html`<${Modal} title=${title} width=${420} onClose=${() => done(false)}
    footer=${html`<${Btn} variant="ghost" onClick=${() => done(false)}>${cancelLabel}<//><${Btn} variant=${danger ? 'danger' : 'primary'} disabled=${input && val !== input.match} onClick=${() => done(true)}>${confirmLabel}<//>`}>
    <div class="confirm-body">${body}</div>
    ${input ? html`<${Field} label=${input.label}><${TextInput} value=${val} onInput=${setVal} placeholder=${input.match} autofocus />${''}<//>` : null}
  <//>`;
};

export function ModalHost() {
  const modals = useSel((s) => s.modals);
  return html`${modals.map((m) => { const C = MODALS[m.kind]; return C ? html`<${C} key=${m.id} id=${m.id} ...${m.props} />` : null; })}`;
}

/* ------------------------------------------------------------------ context menu */
export function ContextMenu() {
  const ctx = useSel((s) => s.ctx);
  const ref = useRef(null); const [pos, setPos] = useState(null); const [sub, setSub] = useState(null);
  useLayoutEffect(() => {
    if (!ctx || !ref.current) { setPos(null); return; }
    const r = ref.current.getBoundingClientRect(); const pad = 8;
    let x = ctx.x; let y = ctx.y;
    if (x + r.width > innerWidth - pad) x = Math.max(pad, ctx.x - r.width);
    if (y + r.height > innerHeight - pad) y = Math.max(pad, innerHeight - r.height - pad);
    setPos({ x, y, ox: ctx.x > x ? 'right' : 'left', oy: ctx.y > y ? 'bottom' : 'top' }); setSub(null);
  }, [ctx?.id]);
  useEffect(() => {
    if (!ctx) return undefined;
    const close = () => closeContext();
    const key = (e) => { if (e.key === 'Escape') close(); };
    const dismissPtr = (e) => { if (!e.target.closest?.('.ctx-menu')) close(); };
    window.addEventListener('keydown', key); window.addEventListener('blur', close); window.addEventListener('wheel', close, { passive: true });
    document.addEventListener('pointerdown', dismissPtr, true);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('blur', close); window.removeEventListener('wheel', close); document.removeEventListener('pointerdown', dismissPtr, true); };
  }, [ctx?.id]);
  if (!ctx) return null;
  return html`<${MenuList} key=${ctx.id} items=${ctx.items} menuRef=${ref} style=${{ left: (pos?.x ?? ctx.x) + 'px', top: (pos?.y ?? ctx.y) + 'px', visibility: pos ? 'visible' : 'hidden', transformOrigin: `${pos?.oy || 'top'} ${pos?.ox || 'left'}` }} sub=${sub} setSub=${setSub} />`;
}
function MenuList({ items, menuRef, style, sub, setSub, nested }) {
  return html`<div class=${cx('ctx-menu', 'pop-in', nested && 'nested')} ref=${menuRef} style=${style} role="menu">
    ${items.filter(Boolean).map((it, i) => {
      if (it.type === 'sep') return html`<div class="ctx-sep"></div>`;
      if (it.type === 'label') return html`<div class="ctx-label">${it.label}</div>`;
      if (it.type === 'custom') return html`<div class="ctx-custom">${it.render()}</div>`;
      const hasSub = !!it.submenu;
      return html`<div class="ctx-item-wrap" onMouseEnter=${() => setSub?.(hasSub ? i : null)}>
        <button type="button" role="menuitem" class=${cx('ctx-item', it.danger && 'danger', it.disabled && 'disabled', hasSub && sub === i && 'open')} disabled=${it.disabled} onClick=${(e) => { if (hasSub) { setSub(i); return; } closeContext(); it.onClick?.(e); }}>
          ${it.checked !== undefined ? html`<span class=${cx('ctx-check', it.checked && 'on')}>${it.checked ? html`<${Icon} name="check" size=${13} sw=${3} />` : null}</span>` : null}
          <span class="ctx-label-t">${it.label}</span>
          ${it.hint ? html`<span class="ctx-hint">${it.hint}</span>` : null}
          ${it.icon ? html`<${Icon} name=${it.icon} size=${16} class="ctx-ic" />` : null}
          ${hasSub ? html`<${Icon} name="chevron-right" size=${15} class="ctx-ic" />` : null}
        </button>
        ${hasSub && sub === i ? html`<div class="ctx-sub"><${MenuList} nested items=${it.submenu} sub=${null} setSub=${null} /></div>` : null}
      </div>`;
    })}</div>`;
}

/* ------------------------------------------------------------------ popovers */
export function PopoverHost() {
  const p = useSel((s) => s.popover);
  const ref = useRef(null); const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    if (!p || !ref.current) { setPos(null); return undefined; }
    const el = ref.current; const a = p.rect; const pad = 14; const gap = 10;
    const place = () => {
    const r = { width: el.offsetWidth, height: el.offsetHeight };   // layout size: the pop-in animation's scale must not make it look smaller than it is
    let x; let y;
    switch (p.placement) {
      case 'left': x = a.x - r.width - gap; y = a.y; break;
      case 'top': x = a.x + a.w / 2 - r.width / 2; y = a.y - r.height - gap; break;
      case 'bottom': x = a.x + a.w / 2 - r.width / 2; y = a.y + a.h + gap; break;
      case 'bottom-start': x = a.x; y = a.y + a.h + gap; break;
      case 'top-end': x = a.x + a.w - r.width; y = a.y - r.height - gap; break;
      case 'top-start': x = a.x; y = a.y - r.height - gap; break;
      default: x = a.x + a.w + gap; y = a.y;
    }
    if (x + r.width > innerWidth - pad) { x = p.placement === 'right' ? a.x - r.width - gap : innerWidth - r.width - pad; }
    if (x < pad) x = p.placement === 'left' ? a.x + a.w + gap : pad;
    x = clamp(x, pad, Math.max(pad, innerWidth - r.width - pad)); y = clamp(y, pad, Math.max(pad, innerHeight - r.height - pad));
    setPos((cur) => (cur && Math.abs(cur.x - x) < 0.5 && Math.abs(cur.y - y) < 0.5 ? cur : { x, y }));
    };
    place();
    // pictures, fonts and the person's details arrive after the popover opened and make it taller: keep it inside the window
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null; ro?.observe(el);
    window.addEventListener('resize', place);
    return () => { ro?.disconnect(); window.removeEventListener('resize', place); };
  }, [p?.id]);
  useEffect(() => {
    if (!p) return undefined;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target) && !e.target.closest?.('.keep-popover')) closePopover(); };
    const k = (e) => { if (e.key === 'Escape') closePopover(); };
    document.addEventListener('pointerdown', h, true); window.addEventListener('keydown', k);
    return () => { document.removeEventListener('pointerdown', h, true); window.removeEventListener('keydown', k); };
  }, [p?.id]);
  if (!p) return null; const C = POPOVERS[p.kind]; if (!C) return null;
  return html`<div class=${cx('popover', 'pop-in', p.class)} ref=${ref} key=${p.id} style=${{ left: (pos?.x ?? p.rect.x) + 'px', top: (pos?.y ?? p.rect.y) + 'px', visibility: pos ? 'visible' : 'hidden' }}><${C} ...${p.props} close=${closePopover} /></div>`;
}

/* ------------------------------------------------------------------ toasts + tooltips */
export function ToastHost() {
  const toasts = useSel((s) => s.toasts);
  return html`<div class="toasts" aria-live="polite">${toasts.map((x) => html`<div key=${x.id} class=${cx('toast', x.type)} onClick=${() => dismissToast(x.id)}>
    <${Icon} name=${x.type === 'error' ? 'alert-circle' : x.type === 'success' ? 'check-circle' : 'info'} size=${18} /><span>${x.message}</span></div>`)}</div>`;
}
let tipEl = null; let tipTimer = null; let tipTarget = null;
export function initTooltips() {
  tipEl = document.createElement('div'); tipEl.className = 'tooltip'; document.getElementById('portals').appendChild(tipEl);
  const hide = () => { clearTimeout(tipTimer); tipTarget = null; tipEl.classList.remove('show'); };
  const show = (el) => {
    if (!state.settings.access.tooltips) return;
    const text = el.dataset.tip; if (!text) return;
    tipEl.textContent = text; tipEl.style.maxWidth = el.dataset.tipWide ? '320px' : '240px';
    tipEl.className = 'tooltip'; const r = el.getBoundingClientRect(); const tr = tipEl.getBoundingClientRect();
    let pos = el.dataset.tipPos || 'top'; const gap = 10;
    if (pos === 'top' && r.top - tr.height - gap < 4) pos = 'bottom';
    if (pos === 'bottom' && r.bottom + tr.height + gap > innerHeight - 4) pos = 'top';
    let x; let y;
    if (pos === 'right') { x = r.right + gap; y = r.top + r.height / 2 - tr.height / 2; }
    else if (pos === 'left') { x = r.left - tr.width - gap; y = r.top + r.height / 2 - tr.height / 2; }
    else { x = r.left + r.width / 2 - tr.width / 2; y = pos === 'bottom' ? r.bottom + gap : r.top - tr.height - gap; }
    tipEl.style.left = clamp(x, 6, innerWidth - tr.width - 6) + 'px'; tipEl.style.top = clamp(y, 6, innerHeight - tr.height - 6) + 'px';
    tipEl.dataset.pos = pos; tipEl.classList.add('show');
  };
  document.addEventListener('pointerover', (e) => {
    const el = e.target.closest?.('[data-tip]'); if (el === tipTarget) return;
    hide(); if (!el || e.pointerType === 'touch') return; tipTarget = el;
    tipTimer = setTimeout(() => show(el), el.dataset.tipInstant ? 0 : 280);
  });
  document.addEventListener('pointerdown', hide, true); document.addEventListener('scroll', hide, true); window.addEventListener('blur', hide);
  document.addEventListener('keydown', hide);
}

/* misc */
export function useAsync(fn, deps = []) {
  const [st, setSt] = useState({ loading: true, data: null, error: null });
  const run = useCallback(() => { setSt((s) => ({ ...s, loading: true })); return Promise.resolve(fn()).then((data) => setSt({ loading: false, data, error: null })).catch((error) => setSt({ loading: false, data: null, error })); }, deps);
  useEffect(() => { run(); }, [run]);
  return [st, run];
}
export const notYet = (what) => toast(`${what} is coming soon`, 'info');
export { t };
