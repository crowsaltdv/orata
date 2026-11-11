// Orata — every right click opens Orata's own menu. The places that have a menu of their own (messages, channels, servers, people …) open it themselves and this
// stays out of the way; everywhere else — text, links, pictures, text boxes, empty space — this opens a menu that fits what was clicked, in the same style, instead of the
// browser's. Hold Shift while right-clicking to get the browser's own menu (spell-check suggestions, "Inspect"…). A phone's long press is left alone.
import { copyText } from '/js/lib.js';
import { state, openContext, toast } from '/js/store.js';
import { t } from '/js/i18n.js';

const TEXT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number', '']);
/** The text box (or editable area) a right click landed in, or null. */
function editableOf(el) {
  const box = el.closest?.('input, textarea, [contenteditable]'); if (!box) return null;
  if (box.tagName === 'INPUT') return TEXT_TYPES.has((box.getAttribute('type') || '').toLowerCase()) && !box.readOnly ? box : null;
  if (box.tagName === 'TEXTAREA') return box.readOnly ? null : box;
  return box.isContentEditable ? box : null;
}
/** What is selected inside a text box, or on the page. */
function selectedText(box) {
  if (box && (box.tagName === 'INPUT' || box.tagName === 'TEXTAREA')) return box.value.slice(box.selectionStart ?? 0, box.selectionEnd ?? 0);
  return String(window.getSelection?.() || '');
}
const absolute = (u) => { try { return new URL(u, location.href).href; } catch { return ''; } };
const openTab = (u) => { const w = window.open(u, '_blank', 'noopener'); if (!w) toast(t('Your browser blocked the new tab'), 'info', 2600); };
const copied = async (text) => { toast(await copyText(text) ? t('Copied') : t('Couldn’t copy that'), 'success', 1400); };
/** Runs a clipboard command in a text box: its focus and selection are put back first (the menu took the focus while it was open). */
function inBox(box, selection, run) {
  box.focus();
  if (selection && box.setSelectionRange) { try { box.setSelectionRange(selection[0], selection[1]); } catch { /* a type that has no selection */ } }
  run();
}

/** The menu for a right click on `el` (whatever it is), with `at` = { x, y }. Returns the items. */
export function menuFor(el, at) {
  const box = editableOf(el); const sel = selectedText(box).trim(); const link = el.closest?.('a[href]');
  const img = el.closest?.('img[src]'); const media = el.closest?.('video, audio');
  const range = box && box.setSelectionRange ? [box.selectionStart ?? 0, box.selectionEnd ?? 0] : null;
  const items = [];
  if (box) {
    items.push(
      { label: t('Cut'), icon: 'trash', disabled: !sel, hint: 'Ctrl+X', onClick: () => inBox(box, range, () => document.execCommand('cut')) },
      { label: t('Copy'), icon: 'copy', disabled: !sel, hint: 'Ctrl+C', onClick: () => inBox(box, range, () => document.execCommand('copy')) },
      { label: t('Paste'), icon: 'paperclip', hint: 'Ctrl+V', onClick: async () => {
        try { const text = await navigator.clipboard.readText(); inBox(box, range, () => document.execCommand('insertText', false, text)); } catch { toast(t('Your browser didn’t allow that. Press Ctrl+V to paste.'), 'info', 3200); }
      } },
      { label: t('Select All'), icon: 'check', hint: 'Ctrl+A', onClick: () => inBox(box, null, () => (box.select ? box.select() : document.execCommand('selectAll'))) },
    );
  } else if (sel) items.push({ label: t('Copy'), icon: 'copy', hint: 'Ctrl+C', onClick: () => copied(sel) });
  if (link && !/^javascript:/i.test(link.getAttribute('href') || '')) {
    if (items.length) items.push({ type: 'sep' });
    items.push({ label: t('Open Link in New Tab'), icon: 'external', onClick: () => openTab(link.href) }, { label: t('Copy Link Address'), icon: 'link', onClick: () => copied(link.href) });
  }
  if (img) {
    if (items.length) items.push({ type: 'sep' });
    const src = img.currentSrc || img.src;
    items.push({ label: t('Open Image in New Tab'), icon: 'image', onClick: () => openTab(src) }, { label: t('Copy Image Address'), icon: 'link', onClick: () => copied(absolute(src)) },
      { label: t('Save Image As…'), icon: 'download', onClick: () => { const a = document.createElement('a'); a.href = src; a.download = ''; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove(); } });
  }
  if (media && (media.currentSrc || media.src)) {
    if (items.length) items.push({ type: 'sep' });
    const src = media.currentSrc || media.src;
    items.push({ label: t('Open in New Tab'), icon: 'external', onClick: () => openTab(src) }, { label: t('Copy Address'), icon: 'link', onClick: () => copied(absolute(src)) });
  }
  if (!items.length) {   // nothing under the pointer that has its own actions: the page
    items.push(
      { label: t('Back'), icon: 'arrow-left', disabled: history.length <= 1, onClick: () => history.back() },
      { label: t('Forward'), icon: 'arrow-right', onClick: () => history.forward() },
      { label: t('Reload'), icon: 'refresh', hint: 'Ctrl+R', onClick: () => location.reload() },
      { type: 'sep' },
      { label: t('Copy Page Link'), icon: 'link', onClick: () => copied(location.href) },
    );
    if (state.me) items.push({ label: t('Settings'), icon: 'settings', onClick: () => import('/js/actions.js').then((a) => a.openSettings('account')) });
  }
  void at; return items;
}

export function initContextMenu() {
  document.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented) return;   // a place with a menu of its own already opened it
    if (e.shiftKey) return;   // Shift: the browser's own menu
    if (e.pointerType === 'touch' || (e.pointerType === undefined && matchMedia('(pointer: coarse)').matches)) return;   // a long press on a phone: selection handles and the like
    const el = e.target instanceof Element ? e.target : e.target?.parentElement; if (!el) return;
    e.preventDefault();
    if (el.closest('.ctx-menu')) return;   // a right click on Orata's menu itself: nothing more
    const rect = el.getBoundingClientRect();
    const x = e.clientX || rect.left + 8; const y = e.clientY || rect.bottom;   // (the keyboard's menu key has no pointer: open at the element)
    openContext({ clientX: x, clientY: y }, menuFor(el, { x, y }));
  });
}
