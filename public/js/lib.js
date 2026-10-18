// Orate — tiny shared helpers + the Preact/htm bundle re-export.
import { h, Component } from '/vendor/preact-htm.js';
export { html, h, render, Component, createContext, useState, useReducer, useEffect, useLayoutEffect, useRef, useImperativeHandle, useMemo, useCallback, useContext } from '/vendor/preact-htm.js';

export const cx = (...a) => a.flat(Infinity).filter(Boolean).join(' ');
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const uid = () => Math.random().toString(36).slice(2, 10);
export const noop = () => {};

export function shallowEq(a, b) {
  if (a === b) return true;
  const ka = Object.keys(a); const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}
export function memo(Fn, eq = shallowEq) {
  class Memo extends Component {
    shouldComponentUpdate(next) { return !eq(this.props, next); }
    render(props) { return h(Fn, props); }
  }
  Memo.displayName = 'Memo(' + (Fn.name || 'C') + ')';
  return Memo;
}
export function debounce(fn, ms) { let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; d.cancel = () => clearTimeout(t); d.flush = (...a) => { clearTimeout(t); fn(...a); }; return d; }
export function throttle(fn, ms) { let last = 0; let t; return (...a) => { const now = Date.now(); if (now - last >= ms) { last = now; fn(...a); } else { clearTimeout(t); t = setTimeout(() => { last = Date.now(); fn(...a); }, ms - (now - last)); } }; }

/* ids carry their creation time: id = ms * 1000 + seq */
export const idTime = (id) => Math.floor(Number(id) / 1000);
export const cmpId = (a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0);

/* time formatting */
export function formatClock(ts, hour12 = true) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12 });
}
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
export function formatStamp(ts, hour12 = true) {
  const d = new Date(ts); const today = startOfDay(new Date());
  const day = startOfDay(d);
  if (day === today) return `Today at ${formatClock(ts, hour12)}`;
  if (day === today - 86400000) return `Yesterday at ${formatClock(ts, hour12)}`;
  return `${d.toLocaleDateString([], { month: '2-digit', day: '2-digit', year: 'numeric' })} ${formatClock(ts, hour12)}`;
}
export const formatDay = (ts) => new Date(ts).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
export const sameDay = (a, b) => startOfDay(new Date(a)) === startOfDay(new Date(b));
export function formatFull(ts, hour12 = true) { return new Date(ts).toLocaleString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12 }); }
export function formatMemberSince(ts) { return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }); }
export function relTime(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'just now'; if (s < 3600) return `${Math.round(s / 60)}m ago`; if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
export function fileSize(n) {
  if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB'; return (n / 1073741824).toFixed(1) + ' GB';
}

/* colour helpers */
export function hexToRgb(hex) {
  let h = String(hex || '#000').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const rgbToHex = (r, g, b) => '#' + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
export function mixHex(a, b, t) { const A = hexToRgb(a); const B = hexToRgb(b); return rgbToHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t); }
export function luminance(hex) { const [r, g, b] = hexToRgb(hex).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; }
export const readableOn = (hex) => (luminance(hex) > 0.45 ? '#111' : '#fff');
export function hsvToHex(hh, s, v) {
  const f = (n, k = (n + hh / 60) % 6) => v - v * s * Math.max(Math.min(k, 4 - k, 1), 0);
  return rgbToHex(f(5) * 255, f(3) * 255, f(1) * 255);
}
export function hexToHsv(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b); const min = Math.min(r, g, b); const d = max - min;
  let hh = 0;
  if (d) { if (max === r) hh = ((g - b) / d) % 6; else if (max === g) hh = (b - r) / d + 2; else hh = (r - g) / d + 4; hh *= 60; if (hh < 0) hh += 360; }
  return [hh, max ? d / max : 0, max];
}
const AVATAR_HUES = ['#8b5cf6', '#ec4899', '#f97316', '#10b981', '#06b6d4', '#3b82f6', '#ef4444', '#eab308', '#14b8a6', '#a855f7'];
export const avatarColor = (id) => AVATAR_HUES[Number(String(id).slice(-6)) % AVATAR_HUES.length];

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { /* ignore */ } ta.remove(); return ok;
  }
}
export function isImageType(t = '') { return t.startsWith('image/') && !t.includes('svg'); }
export const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
export function ls(key, fallback, set) {
  try { if (set !== undefined) { localStorage.setItem('orate:' + key, JSON.stringify(set)); return set; } const v = localStorage.getItem('orate:' + key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
export function lsRemove(key) { try { localStorage.removeItem('orate:' + key); } catch { /* ignore */ } }
export function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
