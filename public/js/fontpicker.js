// Orata — Google Fonts picker: searchable, windowed list where every row is rendered in its own typeface.
import { html, useState, useEffect, useRef, useMemo, cx, debounce } from '/js/lib.js';
import { state, set, useSel } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { POPOVERS, Spinner, Empty } from '/js/ui.js';
import { api } from '/js/api.js';
import { loadFont, fontUrl, SYSTEM_FONTS } from '/js/theme.js';
import { uid } from '/js/lib.js';
import { t } from '/js/i18n.js';

let fontList = null; let fontPromise = null;
export function loadFontList() {
  if (fontList) return Promise.resolve(fontList);
  return (fontPromise ||= api.get('/fonts').then((l) => (fontList = l.map(([family, category, pop, weights, italic, axis]) => ({ family, category, pop, weights, italic: !!italic, axis }))))).catch(() => { fontPromise = null; return []; });
}

const previewLoaded = new Set();
function ensurePreview(family, text) {
  const key = family + '|' + text; if (previewLoaded.has(key)) return; previewLoaded.add(key);
  const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = fontUrl(family, { text }); document.head.appendChild(l);
}
const SAMPLE = 'The quick brown fox jumps over the lazy dog 0123456789';
const CATS = [['all', 'All'], ['Sans Serif', 'Sans'], ['Serif', 'Serif'], ['Display', 'Display'], ['Handwriting', 'Script'], ['Monospace', 'Mono']];
const ROW = 48;

function FontList({ value, onPick, mono }) {
  const [list, setList] = useState(fontList); const [q, setQ] = useState(''); const [cat, setCat] = useState(mono ? 'Monospace' : 'all');
  const [top, setTop] = useState(0); const [hover, setHover] = useState(null); const box = useRef(null);
  useEffect(() => { loadFontList().then(setList); }, []);
  const rows = useMemo(() => {
    if (!list) return [];
    const term = q.trim().toLowerCase();
    return list.filter((f) => (cat === 'all' || f.category === cat) && (!term || f.family.toLowerCase().includes(term)));
  }, [list, q, cat]);
  const H = 300; const start = Math.max(0, Math.floor(top / ROW) - 3); const end = Math.min(rows.length, Math.ceil((top + H) / ROW) + 3);
  // load the glyphs for visible rows (just the family name → a few hundred bytes each)
  useEffect(() => { const id = setTimeout(() => { for (let i = start; i < end; i++) ensurePreview(rows[i].family, rows[i].family); }, 60); return () => clearTimeout(id); }, [start, end, rows]);
  const hv = hover || value;
  useEffect(() => { if (hv && !SYSTEM_FONTS[hv]) { const id = setTimeout(() => ensurePreview(hv, SAMPLE), 120); return () => clearTimeout(id); } return undefined; }, [hv]);
  useEffect(() => { if (box.current) { box.current.scrollTop = 0; setTop(0); } }, [q, cat]);
  useEffect(() => { // jump to the selected font on open
    if (list && value && box.current && !q) { const i = rows.findIndex((f) => f.family === value); if (i > 3) { box.current.scrollTop = (i - 2) * ROW; setTop((i - 2) * ROW); } }
  }, [list]);
  return html`<div class="fp">
    <div class="picker-search"><${Icon} name="search" size=${16} /><input class="pk-input" placeholder=${t('Search Google Fonts')} value=${q} onInput=${(e) => setQ(e.target.value)} autofocus />${q ? html`<button type="button" class="pk-clear" onClick=${() => setQ('')}><${Icon} name="x" size=${14} /></button>` : null}</div>
    <div class="fp-cats">${CATS.map(([k, l]) => html`<button type="button" class=${cx(cat === k && 'on')} onClick=${() => setCat(k)}>${l}</button>`)}</div>
    ${!list ? html`<div class="pk-center" style="height:300px"><${Spinner} /></div>` : html`<div class="fp-scroll" ref=${box} onScroll=${(e) => setTop(e.target.scrollTop)} style=${{ height: H + 'px' }}>
      <div style=${{ height: rows.length * ROW + 'px', position: 'relative' }}>
        ${rows.slice(start, end).map((f, i) => html`<button type="button" key=${f.family} class=${cx('fp-row', value === f.family && 'sel')} style=${{ top: (start + i) * ROW + 'px', height: ROW + 'px' }} onMouseEnter=${() => setHover(f.family)} onMouseLeave=${() => setHover(null)} onClick=${() => onPick(f.family)}>
          <span class="fp-name" style=${{ fontFamily: `"${f.family}", system-ui, sans-serif` }}>${f.family}</span><small>${f.category === 'Sans Serif' ? 'Sans' : f.category === 'Handwriting' ? 'Script' : f.category === 'Monospace' ? 'Mono' : f.category}${f.axis ? ' · Variable' : ''}</small>${value === f.family ? html`<${Icon} name="check" size=${16} sw=${3} />` : null}</button>`)}
        ${!rows.length ? html`<${Empty} icon="search" title="No fonts match" />` : null}
      </div></div>`}
    <div class="fp-sample" style=${{ fontFamily: hv && !SYSTEM_FONTS[hv] ? `"${hv}", system-ui, sans-serif` : 'inherit' }}>${SAMPLE}</div>
    <div class="fp-foot"><span>${rows.length} ${t('fonts')} · Google Fonts</span>${value ? html`<button type="button" class="link-btn" onClick=${() => onPick(null)}>${t('Reset to default')}</button>` : null}</div>
  </div>`;
}

POPOVERS['font-picker'] = function FontPopover({ value, onChange, mono, close }) {
  return html`<div class="pop-card fp-pop"><${FontList} value=${value} mono=${mono} onPick=${(f) => { onChange(f); loadFont(f); close(); }} /></div>`;
};

export function FontField({ value, onChange, mono, defaultName = 'Inter', label }) {
  const ref = useRef(null);
  const open = () => { const r = ref.current.getBoundingClientRect(); set({ popover: { id: uid(), kind: 'font-picker', props: { value, onChange, mono }, rect: { x: r.x, y: r.y, w: r.width, h: r.height }, placement: 'bottom-start' } }); loadFontList(); };
  const fam = value || defaultName;
  return html`<button type="button" ref=${ref} class="font-field" onClick=${open} aria-label=${label}>
    <span class="ff-preview" style=${{ fontFamily: `"${fam}", ${mono ? 'monospace' : 'system-ui, sans-serif'}` }}>${fam}</span><span class="ff-sample" style=${{ fontFamily: `"${fam}", ${mono ? 'monospace' : 'system-ui, sans-serif'}` }}>Aa 123</span><${Icon} name="chevron-down" size=${17} /></button>`;
}
void useSel; void state; void debounce;
