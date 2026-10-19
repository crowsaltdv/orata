// Orate — emoji / GIF / sticker picker popover.
import { html, useState, useEffect, useRef, useMemo, useCallback, memo, cx, debounce, uid } from '/js/lib.js';
import { state, set, useSel, updateSettings } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { POPOVERS, Spinner, Empty } from '/js/ui.js';
import { api } from '/js/api.js';
import { loadEmoji, emojiData, searchEmoji, applyTone, frequentEmoji, allEmoji, setSkinTone } from '/js/emoji.js';
import { t } from '/js/i18n.js';

export function openPicker(anchor, handlers, opts = {}) {
  const h = typeof handlers === 'function' ? { onEmoji: handlers } : handlers;
  const r = anchor.getBoundingClientRect();
  set({ popover: { id: uid(), kind: 'picker', props: { handlers: h, tab: opts.emojiOnly ? 'emoji' : opts.gifOnly ? 'gif' : opts.tab || 'emoji', query: opts.query || '', emojiOnly: !!opts.emojiOnly, gifOnly: !!opts.gifOnly }, rect: { x: r.x, y: r.y, w: r.width, h: r.height }, placement: opts.placement || 'top-end', class: 'picker-pop' }, ctx: null });
}

const TONES = ['', '🏻', '🏼', '🏽', '🏾', '🏿'];

/* ------------------------------------------------------------------ emoji tab */
// A cell is a stable, memoised component: if it were created inside EmojiTab every hover would re-render the tab, Preact would
// see a brand-new component type and rebuild all ~1,800 buttons — which made the picker lag and could swallow clicks.
const EmojiCell = memo(function EmojiCell({ char, label, code, onEmoji, onHover }) {
  return html`<button type="button" class="emoji-cell" onMouseEnter=${() => onHover({ char, label, code })} onFocus=${() => onHover({ char, label, code })} onClick=${(e) => onEmoji(char, e)} aria-label=${label} title=${code ? ':' + code + ':' : label}>${char}</button>`;
});
const CustomCell = memo(function CustomCell({ e, onEmoji, onHover }) {
  const token = `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`;
  return html`<button type="button" class="emoji-cell custom" onMouseEnter=${() => onHover({ img: e.url, label: e.name, code: e.name })} onFocus=${() => onHover({ img: e.url, label: e.name, code: e.name })} onClick=${(ev) => onEmoji(token, ev)} aria-label=${e.name} title=${':' + e.name + ':'}><img src=${e.url} alt="" draggable="false" /></button>`;
});
function EmojiPreview({ api }) {
  const [hover, setHover] = useState(null);
  api.current = setHover;
  return html`<div class="emoji-preview">${hover ? html`<span class="big">${hover.img ? html`<img class="emoji custom big-img" src=${hover.img} alt="" />` : hover.char}</span><span class="nm">${hover.code ? ':' + hover.code + ':' : hover.label}</span>` : html`<span class="hint">${t('Pick an emoji…')}</span>`}</div>`;
}
function EmojiTab({ onEmoji }) {
  const [data, setData] = useState(emojiData());
  const [q, setQ] = useState(''); const [toneOpen, setToneOpen] = useState(false); const [active, setActive] = useState('freq');
  const tone = useSel((s) => s.settings.skinTone); const scroller = useRef(null);
  const previewApi = useRef(null); const freq = useMemo(() => frequentEmoji(), []);
  const onHover = useCallback((h) => previewApi.current?.(h), []);
  const pick = useRef(onEmoji); pick.current = onEmoji;
  const choose = useCallback((c, e) => pick.current(c, e), []);
  useEffect(() => { loadEmoji().then(setData); }, []);
  useEffect(() => { const el = scroller.current?.closest('.emoji-tab')?.querySelector('.pk-input'); el?.focus(); }, []);
  const servers = useSel((s) => s.servers);
  const custom = useMemo(() => Object.values(servers).filter((sv) => sv.emojis?.length), [servers]);
  const acr = (n) => (n || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const results = useMemo(() => (q.trim() ? searchEmoji(q, 120) : null), [q, data]);
  const customHits = useMemo(() => (q.trim() ? custom.flatMap((sv) => sv.emojis).filter((e) => e.name.toLowerCase().includes(q.trim().toLowerCase().replace(/^:|:$/g, ''))) : []), [q, custom]);
  const groups = data?.groups || [];
  const cats = [...custom.map((sv) => ({ key: 'srv-' + sv.id, icon: acr(sv.name), name: sv.name })), ...(freq.length ? [{ key: 'freq', icon: '🕘', name: 'Frequently Used' }] : []), ...groups];
  const scrollTo = (key) => { const el = scroller.current?.querySelector(`[data-sec="${key}"]`); if (el) { scroller.current.scrollTo({ top: el.offsetTop - 4, behavior: 'smooth' }); } };
  const onScroll = () => {
    const el = scroller.current; if (!el) return; let cur = cats[0]?.key;
    for (const s of el.querySelectorAll('[data-sec]')) if (s.offsetTop - 12 <= el.scrollTop) cur = s.dataset.sec;
    if (cur !== active) setActive(cur);
  };
  const cell = (char, label, code) => html`<${EmojiCell} key=${code || char} char=${char} label=${label} code=${code} onEmoji=${choose} onHover=${onHover} />`;
  return html`<div class="emoji-tab">
    <div class="picker-search"><${Icon} name="search" size=${16} /><input class="pk-input" placeholder=${t('Find the perfect emoji')} value=${q} onInput=${(e) => setQ(e.target.value)} />
      ${q ? html`<button type="button" class="pk-clear" onClick=${() => setQ('')}><${Icon} name="x" size=${14} /></button>` : null}
      <div class="tone-wrap"><button type="button" class="tone-btn" data-tip="Skin tone" onClick=${() => setToneOpen(!toneOpen)}>${'👋' + TONES[tone]}</button>
        ${toneOpen ? html`<div class="tone-pop pop-in">${TONES.map((tn, i) => html`<button type="button" class=${cx(i === tone && 'sel')} onClick=${() => { setSkinTone(i); setToneOpen(false); }}>${'👋' + tn}</button>`)}</div>` : null}</div></div>
    <div class="emoji-main">
      ${!results ? html`<div class="cat-bar">${cats.map((c) => html`<button type="button" class=${cx(active === c.key && 'on')} data-tip=${c.name} data-tip-pos="right" onClick=${() => scrollTo(c.key)}>${c.icon}</button>`)}</div>` : null}
      <div class="emoji-scroll" ref=${scroller} onScroll=${onScroll}>
        ${!data ? html`<div class="pk-center"><${Spinner} /></div>` : results ? (results.length || customHits.length ? html`<div class="emoji-grid">${customHits.map((e) => html`<${CustomCell} key=${e.id} e=${e} onEmoji=${choose} onHover=${onHover} />`)}${results.map((e) => cell(applyTone(e, tone), e.label, e.code))}</div>` : html`<${Empty} icon="search" title="No emoji found">Try a different search.<//>`)
          : html`${custom.map((sv) => html`<section key=${sv.id} data-sec=${'srv-' + sv.id}><h4>${sv.name}</h4><div class="emoji-grid">${sv.emojis.map((e) => html`<${CustomCell} key=${e.id} e=${e} onEmoji=${choose} onHover=${onHover} />`)}</div></section>`)}${freq.length ? html`<section data-sec="freq"><h4>Frequently Used</h4><div class="emoji-grid">${freq.slice(0, 24).map((c) => cell(c, c, null))}</div></section>` : null}
            ${groups.map((g) => html`<section key=${g.key} data-sec=${g.key}><h4>${g.name}</h4><div class="emoji-grid">${g.emojis.map((e) => cell(e[4] && tone ? e[4][tone - 1] : e[0], e[1], e[3]))}</div></section>`)}`}
      </div>
    </div>
    <${EmojiPreview} api=${previewApi} />
  </div>`;
}

/* ------------------------------------------------------------------ gif / sticker tab */
function Tile({ item, kind, onPick }) {
  const p = item.preview; const ref = useRef(null);
  useEffect(() => {
    const v = ref.current; if (!v || v.tagName !== 'VIDEO') return undefined;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) v.play().catch(() => {}); else v.pause(); }, { threshold: 0.1 });
    io.observe(v); return () => io.disconnect();
  }, []);
  return html`<button type="button" class=${cx('gif-tile', kind)} style=${{ aspectRatio: `${p.w} / ${p.h}` }} onClick=${() => onPick(item)} title=${item.title} aria-label=${item.title || 'GIF'}>
    ${p.mp4 && kind === 'gifs' ? html`<video ref=${ref} src=${p.mp4} muted loop playsinline autoplay preload="metadata"></video>` : html`<img src=${p.url} alt=${item.title} loading="lazy" draggable="false" />`}
  </button>`;
}
/** The stickers of every server you are in, filtered by the search box. */
function ServerStickers({ term, onPick }) {
  const servers = useSel((s) => s.servers);
  const groups = Object.values(servers).map((sv) => ({ sv, list: (sv.stickers || []).filter((st) => !term || st.name.toLowerCase().includes(term.toLowerCase())) })).filter((g) => g.list.length);
  if (!groups.length) return null;
  return html`${groups.map(({ sv, list }) => html`<h4 class="gif-h" key=${'h' + sv.id}>${sv.name}</h4><div class="sticker-grid" key=${sv.id}>${list.map((st) => html`<button type="button" key=${st.id} class="gif-tile stickers custom" title=${st.name} aria-label=${st.name}
    onClick=${() => onPick({ id: 's:' + st.id, title: st.name, w: 160, h: 160, preview: { url: st.url, w: 160, h: 160 }, full: { url: st.url }, custom: { serverId: sv.id, id: st.id } })}><img src=${st.url} alt=${st.name} draggable="false" /></button>`)}</div>`)}`;
}
function GifTab({ kind, initialQuery, onPick, noRemote }) {
  const [q, setQ] = useState(initialQuery || ''); const [term, setTerm] = useState(initialQuery || '');
  const [items, setItems] = useState([]); const [page, setPage] = useState(1); const [next, setNext] = useState(false);
  const [loading, setLoading] = useState(false); const [err, setErr] = useState(null); const [cats, setCats] = useState(null);
  const scroller = useRef(null); const seq = useRef(0);
  const stickers = kind === 'stickers';
  const setTermDebounced = useRef(debounce((v) => setTerm(v), 380)).current;
  const fetchPage = useCallback(async (pg, reset) => {
    if (noRemote) return;
    const my = ++seq.current; setLoading(true); setErr(null);
    try {
      const params = new URLSearchParams({ type: kind, mode: term ? 'search' : 'trending', page: String(pg), per_page: '24' }); if (term) params.set('q', term);
      const r = await api.get('/gifs?' + params);
      if (my !== seq.current) return;
      setItems((cur) => (reset ? r.items : [...cur, ...r.items.filter((i) => !cur.some((x) => x.id === i.id))])); setNext(r.hasNext); setPage(pg);
    } catch (e) { if (my === seq.current) setErr(e.message); } finally { if (my === seq.current) setLoading(false); }
  }, [term, kind]);
  useEffect(() => { fetchPage(1, true); scroller.current?.scrollTo({ top: 0 }); }, [term, kind]);
  useEffect(() => { if (!noRemote) api.get(`/gifs?type=${kind}&mode=categories`).then((r) => setCats(r.categories)).catch(() => setCats([])); }, [kind]);
  const onScroll = () => { const el = scroller.current; if (next && !loading && el.scrollHeight - el.scrollTop - el.clientHeight < 300) fetchPage(page + 1, false); };
  const cols = useMemo(() => {
    if (stickers) return null;
    const c = [[], []]; const h = [0, 0];
    for (const it of items) { const i = h[0] <= h[1] ? 0 : 1; c[i].push(it); h[i] += it.preview.h / it.preview.w; }
    return c;
  }, [items, stickers]);
  const showCats = !term && cats?.length && !stickers;
  return html`<div class="gif-tab">
    <div class="picker-search"><${Icon} name="search" size=${16} /><input class="pk-input" placeholder=${stickers ? t('Search stickers') : t('Search KLIPY')} value=${q} onInput=${(e) => { setQ(e.target.value); setTermDebounced(e.target.value.trim()); }} autofocus />
      ${q ? html`<button type="button" class="pk-clear" onClick=${() => { setQ(''); setTerm(''); }}><${Icon} name="x" size=${14} /></button>` : null}</div>
    <div class="gif-scroll" ref=${scroller} onScroll=${onScroll}>
      ${showCats ? html`<div class="gif-cats">${cats.slice(0, 20).map((c) => html`<button type="button" class="gif-cat" key=${c.name} onClick=${() => { setQ(c.query); setTerm(c.query); }} style=${{ backgroundImage: `url("${c.preview}")` }}><span>${c.name}</span></button>`)}</div><h4 class="gif-h">${t('Trending')}</h4>` : null}
      ${stickers ? html`<${ServerStickers} term=${term} onPick=${onPick} />` : null}
      ${term && !noRemote ? html`<h4 class="gif-h">${t('Results for')} “${term}”</h4>` : null}
      ${err ? html`<${Empty} icon="alert-circle" title=${t('GIFs unavailable')}>${err}<//>`
        : stickers ? html`<div class="sticker-grid">${items.map((it) => html`<${Tile} key=${it.id} item=${it} kind=${kind} onPick=${onPick} />`)}</div>`
          : html`<div class="masonry">${cols.map((col, i) => html`<div class="mcol" key=${i}>${col.map((it) => html`<${Tile} key=${it.id} item=${it} kind=${kind} onPick=${onPick} />`)}</div>`)}</div>`}
      ${!loading && !items.length && !err && !noRemote ? html`<${Empty} icon="search" title=${t('Nothing found')}>${t('Try another search.')}<//>` : null}
      ${loading ? html`<div class="pk-center"><${Spinner} /></div>` : null}
    </div>
    ${noRemote ? null : html`<div class="klipy-credit">${t('Powered by')} <b>KLIPY</b></div>`}
  </div>`;
}

/* ------------------------------------------------------------------ popover */
POPOVERS.picker = function Picker({ handlers, tab: initial, query, emojiOnly, gifOnly, close }) {
  const [tab, setTab] = useState(initial);
  const gifOk = useSel((s) => s.gifOk);
  const tabs = [['gif', 'GIFs'], ['stickers', 'Stickers'], ['emoji', 'Emoji']];
  const idx = tabs.findIndex((x) => x[0] === tab);
  return html`<div class="picker pop-card" style=${emojiOnly ? { width: '390px' } : null}>
    ${!emojiOnly && !gifOnly ? html`<div class="picker-tabs" style=${{ '--i': idx }}><span class="thumb"></span>${tabs.map(([k, l]) => html`<button type="button" class=${cx(tab === k && 'on')} onClick=${() => setTab(k)}>${t(l)}</button>`)}</div>` : null}
    <div class="picker-body">
      ${tab === 'emoji' ? html`<${EmojiTab} onEmoji=${(c, e) => { handlers.onEmoji?.(c, e); if (emojiOnly && !e?.shiftKey) close(); }} />`
        : gifOk === false && tab !== 'stickers' ? html`<${Empty} icon="alert-circle" title="GIFs not configured">Add a KLIPY_API_KEY to .env to enable GIFs.<//>`
          : html`<${GifTab} key=${tab} noRemote=${gifOk === false} kind=${tab === 'stickers' ? 'stickers' : 'gifs'} initialQuery=${tab === 'gif' ? query : ''} onPick=${tab === 'stickers' ? handlers.onSticker : handlers.onGif} />`}
    </div></div>`;
};
void allEmoji; void updateSettings;
