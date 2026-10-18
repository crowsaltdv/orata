// Orate — tiny i18n: English text is the key; other languages override via the dictionary in i18n-data.js.
import { state } from '/js/store.js';
import { DICT } from '/js/i18n-data.js';

export const LANGUAGES = [
  { code: 'en', name: 'English', native: 'English' }, { code: 'es', name: 'Spanish', native: 'Español' }, { code: 'fr', name: 'French', native: 'Français' },
  { code: 'de', name: 'German', native: 'Deutsch' }, { code: 'pt', name: 'Portuguese', native: 'Português' }, { code: 'it', name: 'Italian', native: 'Italiano' },
  { code: 'nl', name: 'Dutch', native: 'Nederlands' }, { code: 'ja', name: 'Japanese', native: '日本語' }, { code: 'ko', name: 'Korean', native: '한국어' },
  { code: 'zh', name: 'Chinese', native: '中文' }, { code: 'ru', name: 'Russian', native: 'Русский' }, { code: 'tr', name: 'Turkish', native: 'Türkçe' },
];

export function t(key, vars) {
  const lang = state.settings.lang || 'en';
  let s = (lang !== 'en' && DICT[lang]?.[key]) || key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`));
  return s;
}
