// Orata — tiny i18n: English text is the key; other languages override via the dictionary in i18n-data.js.
import { state, set } from '/js/store.js';

// the other languages' text (40 KB) loads only when someone picks one; App re-renders (key) once it's here
let DICT = null; let loading = null;
const loadDict = () => (loading ||= import('/js/i18n-data.js').then((m) => { DICT = m.DICT; set({ i18nVer: Date.now() }); }));

export const LANGUAGES = [
  { code: 'en', name: 'English', native: 'English' }, { code: 'es', name: 'Spanish', native: 'Español' }, { code: 'fr', name: 'French', native: 'Français' },
  { code: 'de', name: 'German', native: 'Deutsch' }, { code: 'pt', name: 'Portuguese', native: 'Português' }, { code: 'it', name: 'Italian', native: 'Italiano' },
  { code: 'nl', name: 'Dutch', native: 'Nederlands' }, { code: 'ja', name: 'Japanese', native: '日本語' }, { code: 'ko', name: 'Korean', native: '한국어' },
  { code: 'zh', name: 'Chinese', native: '中文' }, { code: 'ru', name: 'Russian', native: 'Русский' }, { code: 'tr', name: 'Turkish', native: 'Türkçe' },
];

export function t(key, vars) {
  const lang = state.settings.lang || 'en';
  if (lang !== 'en' && !DICT) loadDict();
  let s = (lang !== 'en' && DICT?.[lang]?.[key]) || key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`));
  return s;
}
