// Orata — Settings → Theme → Cursor: upload a cursor, say where its tip is, pick its size and switch it on or off. The normal cursor is what you get until you switch one on, and
// switching it off keeps your picture. A cursor can be saved to your theme library and sent to Discovery's Cursors tab (themes.js). cursor-data.js says what a cursor is; cursor.js shows it.
import { html, useState, useRef, cx } from '/js/lib.js';
import { useSel, updateSettings, toast } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { Btn, Section, SettingRow, Toggle, Segmented } from '/js/ui.js';
import { upload } from '/js/api.js';
import { t } from '/js/i18n.js';
import { CURSOR_SIZES, CURSOR_MAX_PX, DEFAULT_CURSOR } from '/js/cursor-data.js';
import { saveCurrentLook, openThemes } from '/js/themes.js';

/** Turns a picture the person chose into a cursor picture (a PNG of at most 64 pixels on its longer side, a GIF as its first frame) and uploads it. Resolves its address. */
export async function uploadCursorPicture(file) {
  if (!/^image\/(png|jpe?g|webp|gif|avif|bmp)$/i.test(file.type || '')) throw new Error(t('Pick a picture: PNG, JPEG, WebP or GIF.'));
  if (file.size > 8 * 1024 * 1024) throw new Error(t('That picture is too big. Pick one under 8 MB.'));
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) throw new Error(t('That picture couldn’t be read.'));
  const k = Math.min(1, CURSOR_MAX_PX / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas'); cv.width = Math.max(1, Math.round(bmp.width * k)); cv.height = Math.max(1, Math.round(bmp.height * k));
  const c = cv.getContext('2d'); c.imageSmoothingQuality = 'high'; c.drawImage(bmp, 0, 0, cv.width, cv.height); bmp.close?.();
  const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
  if (!blob) throw new Error(t('That picture couldn’t be read.'));
  const r = await upload(new File([blob], 'cursor.png', { type: 'image/png' }));
  if (!r?.url) throw new Error(t('That picture couldn’t be saved.'));
  return r.url;
}

const clamp01 = (v) => Math.round(Math.min(1, Math.max(0, v)) * 100) / 100;

/** One picture of the cursor: its preview (press it to say where the tip is), Upload / Replace and, for the optional pointer, Remove. */
function Slot({ field, hotField, title, desc, optional }) {
  const c = useSel((s) => s.settings.cursor); const url = c[field]; const hot = c[hotField] || DEFAULT_CURSOR[hotField];
  const input = useRef(null); const [busy, setBusy] = useState(false);
  const pick = async (e) => {
    const f = e.target.files?.[0]; e.target.value = ''; if (!f) return;
    setBusy(true);
    try { const u = await uploadCursorPicture(f); updateSettings({ cursor: { [field]: u, [hotField]: { ...DEFAULT_CURSOR[hotField] }, ...(field === 'image' && !c.image ? { on: true } : {}) } }); }
    catch (err) { toast(err.message || String(err), 'error', 5000); }
    setBusy(false);
  };
  const tip = (e) => { const r = e.currentTarget.getBoundingClientRect(); updateSettings({ cursor: { [hotField]: { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) } } }); };
  return html`<div class="cur-slot">
    <div class="cur-head"><b>${title}</b><small>${desc}</small></div>
    <div class=${cx('cur-stage', !url && 'none')}>${url
      ? html`<span class="cur-pick" onClick=${tip} role="button" aria-label=${t('Press where the tip of the cursor is')} data-tip=${t('Press where the tip is')}><img src=${url} alt="" draggable=${false} /><i class="cur-dot" style=${{ left: `${hot.x * 100}%`, top: `${hot.y * 100}%` }}></i></span>`
      : html`<${Icon} name="image" size=${30} sw=${1.5} />`}</div>
    <div class="cur-btns"><${Btn} size="sm" variant=${url ? 'ghost' : 'primary'} icon="upload" loading=${busy} onClick=${() => input.current?.click()}>${url ? t('Replace') : t('Upload a picture')}<//>
      ${url && optional ? html`<${Btn} size="sm" variant="ghost" icon="x" onClick=${() => updateSettings({ cursor: { [field]: null } })}>${t('Remove')}<//>` : null}
      <input ref=${input} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif,image/avif" onChange=${pick} /></div>
  </div>`;
}

export function CursorSection() {
  const c = useSel((s) => s.settings.cursor); const has = !!c.image;
  return html`<${Section} title=${t('Cursor')} desc=${t('Your own mouse cursor, everywhere in Orata. The normal cursor is what you get until you switch one on.')}>
    <${SettingRow} title=${t('Use a custom cursor')} desc=${has ? t('Switch it off to get the normal cursor back. Your picture stays here.') : t('Upload a picture below to use it as your cursor.')}>
      <${Toggle} checked=${!!c.on && has} disabled=${!has} onChange=${(v) => updateSettings({ cursor: { on: v } })} /><//>
    <div class="cur-slots">
      <${Slot} field="image" hotField="hot" title=${t('Cursor')} desc=${t('The arrow. Any picture works; it is shrunk to fit. Press the picture to set the tip.')} />
      <${Slot} field="pointer" hotField="hotPointer" optional=${true} title=${t('Pointer (optional)')} desc=${t('Shown over buttons and links. Leave it out to use the same picture.')} />
    </div>
    <${SettingRow} title=${t('Size')} desc=${t('How big it is drawn, along its longer side.')}>
      <${Segmented} size="sm" options=${CURSOR_SIZES.map(([value, label]) => ({ value, label: `${t(label)} · ${value}` }))} value=${c.size} onChange=${(v) => updateSettings({ cursor: { size: v } })} /><//>
    <div class="cur-actions"><${Btn} icon="plus" disabled=${!has} onClick=${() => saveCurrentLook('cursor')}>${t('Save to my cursors')}<//><${Btn} icon="folder" onClick=${() => openThemes('library', 'cursor')}>${t('My cursors')}<//><${Btn} icon="globe-grid" onClick=${() => openThemes('discover', 'cursor')}>${t('Browse cursors')}<//></div>
  <//>`;
}
