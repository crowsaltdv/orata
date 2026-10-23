// Orata — font picker: your own uploaded fonts (Settings → Fonts keeps them in settings.fonts.custom), then a searchable, windowed list of
// Google Fonts where every row is rendered in its own typeface.
import { html, useState, useEffect, useRef, useMemo, cx, debounce } from '/js/lib.js';
import { state, set, useSel, updateSettings, toast } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { POPOVERS, Spinner, Empty } from '/js/ui.js';
import { api, upload } from '/js/api.js';
import { loadFont, fontUrl, SYSTEM_FONTS, isUploadedFont, fontFamilyName, fontLabel } from '/js/theme.js';
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
const MAX_FONT = 5 * 1024 * 1024;
/** WOFF2, WOFF, TrueType or OpenType, told from the file's first bytes (not its name). */
async function fontKind(file) {
  const b = new Uint8Array(await file.slice(0, 4).arrayBuffer()); const tag = String.fromCharCode(...b);
  return tag === 'wOF2' ? 'woff2' : tag === 'wOFF' ? 'woff' : tag === 'OTTO' ? 'otf' : (tag === 'true' || (b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0)) ? 'ttf' : null;
}
/** Uploads a font file and adds it to your fonts. Resolves its address, or null (the reason is shown). */
async function addFont(file) {
  const kind = await fontKind(file);
  if (!kind) { toast(t('That isn’t a font file Orata can use. Pick a WOFF2, WOFF, TTF or OTF font.'), 'error', 5000); return null; }
  if (file.size > MAX_FONT) { toast(t('Fonts can be 5 MB at most.'), 'error'); return null; }
  try {
    const name = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim().slice(0, 40) || 'My font';
    const r = await upload(new File([file], `${name.replace(/[^\w-]+/g, '-')}.${kind}`, { type: `font/${kind}` }));
    if (!isUploadedFont(r.url)) throw new Error(t('That font couldn’t be saved.'));
    updateSettings({ fonts: { custom: [...(state.settings.fonts?.custom || []).filter((x) => x.url !== r.url && x.name !== name), { url: r.url, name }].slice(-20) } });   // the same font again replaces the old copy
    toast(`${t('Added')} ${name}`, 'success', 2000);
    return r.url;
  } catch (e) { toast(e.message, 'error'); return null; }
}
/** Your uploaded fonts, at the top of the picker: pick one, remove one, or upload another. */
function YourFonts({ value, onPick }) {
  const mine = useSel((s) => s.settings.fonts?.custom || []); const input = useRef(null); const [busy, setBusy] = useState(false);
  useEffect(() => { for (const f of mine) loadFont(f.url); }, [mine.length]);
  const pickFile = async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; setBusy(true); const url = await addFont(f); setBusy(false); if (url) onPick(url); };
  const drop = (url) => updateSettings({ fonts: { custom: mine.filter((x) => x.url !== url) } });
  return html`<div class="fp-mine">
    <div class="fp-mine-head"><b>${t('Your fonts')}</b><button type="button" class="link-btn" disabled=${busy} onClick=${() => input.current?.click()}><${Icon} name="upload" size=${14} /> ${busy ? t('Uploading…') : t('Upload a font')}</button>
      <input ref=${input} type="file" hidden accept=".woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf" onChange=${pickFile} /></div>
    ${mine.length ? mine.map((f) => html`<div class=${cx('fp-mine-row', value === f.url && 'sel')} key=${f.url}>
        <button type="button" class="fp-mine-pick" onClick=${() => onPick(f.url)}><span style=${{ fontFamily: `"${fontFamilyName(f.url)}", system-ui, sans-serif` }}>${f.name}</span>${value === f.url ? html`<${Icon} name="check" size=${15} />` : null}</button>
        <button type="button" class="icon-btn" data-tip=${t('Remove from your fonts')} aria-label=${t('Remove from your fonts')} onClick=${() => drop(f.url)}><${Icon} name="x" size=${14} /></button></div>`)
      : html`<p class="fp-mine-none">${t('Upload a WOFF2, WOFF, TTF or OTF file (5 MB at most) to use it here and in your themes.')}</p>`}
  </div>`;
}
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
  useEffect(() => { if (hv && !SYSTEM_FONTS[hv] && !isUploadedFont(hv)) { const id = setTimeout(() => ensurePreview(hv, SAMPLE), 120); return () => clearTimeout(id); } return undefined; }, [hv]);
  useEffect(() => { if (box.current) { box.current.scrollTop = 0; setTop(0); } }, [q, cat]);
  useEffect(() => { // jump to the selected font on open
    if (list && value && box.current && !q) { const i = rows.findIndex((f) => f.family === value); if (i > 3) { box.current.scrollTop = (i - 2) * ROW; setTop((i - 2) * ROW); } }
  }, [list]);
  return html`<div class="fp">
    <${YourFonts} value=${value} onPick=${onPick} />
    <div class="picker-search"><${Icon} name="search" size=${16} /><input class="pk-input" placeholder=${t('Search Google Fonts')} value=${q} onInput=${(e) => setQ(e.target.value)} autofocus />${q ? html`<button type="button" class="pk-clear" onClick=${() => setQ('')}><${Icon} name="x" size=${14} /></button>` : null}</div>
    <div class="fp-cats">${CATS.map(([k, l]) => html`<button type="button" class=${cx(cat === k && 'on')} onClick=${() => setCat(k)}>${l}</button>`)}</div>
    ${!list ? html`<div class="pk-center" style="height:300px"><${Spinner} /></div>` : html`<div class="fp-scroll" ref=${box} onScroll=${(e) => setTop(e.target.scrollTop)} style=${{ height: H + 'px' }}>
      <div style=${{ height: rows.length * ROW + 'px', position: 'relative' }}>
        ${rows.slice(start, end).map((f, i) => html`<button type="button" key=${f.family} class=${cx('fp-row', value === f.family && 'sel')} style=${{ top: (start + i) * ROW + 'px', height: ROW + 'px' }} onMouseEnter=${() => setHover(f.family)} onMouseLeave=${() => setHover(null)} onClick=${() => onPick(f.family)}>
          <span class="fp-name" style=${{ fontFamily: `"${f.family}", system-ui, sans-serif` }}>${f.family}</span><small>${f.category === 'Sans Serif' ? 'Sans' : f.category === 'Handwriting' ? 'Script' : f.category === 'Monospace' ? 'Mono' : f.category}${f.axis ? ' · Variable' : ''}</small>${value === f.family ? html`<${Icon} name="check" size=${16} sw=${3} />` : null}</button>`)}
        ${!rows.length ? html`<${Empty} icon="search" title="No fonts match" />` : null}
      </div></div>`}
    <div class="fp-sample" style=${{ fontFamily: hv && !SYSTEM_FONTS[hv] ? `"${fontFamilyName(hv)}", system-ui, sans-serif` : 'inherit' }}>${SAMPLE}</div>
    <div class="fp-foot"><span>${rows.length} ${t('fonts')} · Google Fonts</span>${value ? html`<button type="button" class="link-btn" onClick=${() => onPick(null)}>${t('Reset to default')}</button>` : null}</div>
  </div>`;
}

POPOVERS['font-picker'] = function FontPopover({ value, onChange, mono, close }) {
  return html`<div class="pop-card fp-pop"><${FontList} value=${value} mono=${mono} onPick=${(f) => { onChange(f); loadFont(f); close(); }} /></div>`;
};

export function FontField({ value, onChange, mono, defaultName = 'Inter', label }) {
  const ref = useRef(null);
  const open = () => { const r = ref.current.getBoundingClientRect(); set({ popover: { id: uid(), kind: 'font-picker', props: { value, onChange, mono }, rect: { x: r.x, y: r.y, w: r.width, h: r.height }, placement: 'bottom-start' } }); loadFontList(); };
  const fam = value || defaultName; const css = `"${fontFamilyName(fam)}", ${mono ? 'monospace' : 'system-ui, sans-serif'}`;
  useEffect(() => { loadFont(value); }, [value]);
  return html`<button type="button" ref=${ref} class="font-field" onClick=${open} aria-label=${label}>
    <span class="ff-preview" style=${{ fontFamily: css }}>${fontLabel(fam)}</span><span class="ff-sample" style=${{ fontFamily: css }}>Aa 123</span><${Icon} name="chevron-down" size=${17} /></button>`;
}
void useSel; void state; void debounce;
