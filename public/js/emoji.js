// Orate — emoji dataset (generated from Emojibase) + search + "frequently used".
import { state, updateLocal, updateSettings } from '/js/store.js';

let data = null; let loading = null; let flat = null; let byShortcode = null;
export function loadEmoji() {
  if (data) return Promise.resolve(data);
  return (loading ||= fetch('/data/emoji.json').then((r) => r.json()).then((d) => {
    data = d; flat = []; byShortcode = new Map();
    for (const g of d.groups) for (const e of g.emojis) {
      const item = { char: e[0], label: e[1], tags: e[2], code: e[3], skins: e[4] || null, group: g.key };
      flat.push(item); if (item.code) byShortcode.set(item.code, item);
    }
    return d;
  }).catch(() => { loading = null; return { groups: [] }; }));
}
export const emojiData = () => data;
export const allEmoji = () => flat || [];
export const shortcodeEmoji = (code) => byShortcode?.get(code)?.char || null;

export function searchEmoji(q, limit = 60) {
  const s = q.toLowerCase().trim(); if (!s || !flat) return [];
  const scored = [];
  for (const e of flat) {
    let score = 0;
    if (e.code === s) score = 100; else if (e.code?.startsWith(s)) score = 80; else if (e.label.startsWith(s)) score = 70;
    else if (e.code?.includes(s)) score = 55; else if (e.label.includes(s)) score = 50; else if (e.tags.includes(s)) score = 30;
    if (score) scored.push([score, e]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map((x) => x[1]);
}
export function applyTone(item, tone = state.settings.skinTone) {
  return tone && item.skins?.[tone - 1] ? item.skins[tone - 1] : item.char;
}
export function noteEmojiUse(char) {
  const f = { ...state.local.frequentEmoji }; f[char] = (f[char] || 0) + 1;
  const top = Object.entries(f).sort((a, b) => b[1] - a[1]).slice(0, 36);
  updateLocal({ frequentEmoji: Object.fromEntries(top) });
}
export const frequentEmoji = () => Object.entries(state.local.frequentEmoji).sort((a, b) => b[1] - a[1]).map((x) => x[0]);
export const setSkinTone = (n) => updateSettings({ skinTone: n });
