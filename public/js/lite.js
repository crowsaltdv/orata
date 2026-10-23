// Orata — Lite mode: a lighter Orata for older and low-power computers. No rain, liquid glass, wallpaper picture, blur or downloaded fonts
// (theme.js, the html.lite rules in extras.css); no link previews; smaller pictures and GIFs (thumb() below, message.js). Chosen per device:
// `mode` is the last pick, `modePref` the mode Orata opens in ('ask' = the launch screen asks, app.js ModeChooser). Only orata_dev sees the
// choice, for now.
import { ls } from '/js/lib.js';

export const MODE_OWNER = 'orata_dev';   // the only account that sees the launch screen and the Settings switch, for now
export const preferredMode = () => ls('modePref', 'ask');
export const LITE = (preferredMode() === 'ask' ? ls('mode', 'normal') : preferredMode()) === 'lite';
if (LITE) document.documentElement.classList.add('lite');

/** Switches mode (reloading when it changes what loads). `prefer`: also make it the mode Orata opens in ('ask' to be asked again). */
export function setMode(mode, prefer = null) {
  ls('mode', null, mode); if (prefer) ls('modePref', null, prefer);
  try { sessionStorage.setItem('orate:modeChosen', '1'); } catch { /* private mode */ }
  if ((mode === 'lite') !== LITE) location.reload();
}
export const modeChosenThisVisit = () => { try { return !!sessionStorage.getItem('orate:modeChosen'); } catch { return true; } };

/** In Lite mode an uploaded picture comes as a smaller, lighter copy (server/index.js /thumbs; animated GIFs stay animated). */
export const thumb = (url, w) => (LITE && /^\/uploads\/[A-Za-z0-9_.-]+\.(png|jpe?g|gif|webp|avif)$/i.test(url || '') ? `/thumbs/${w}/${url.slice(9)}` : url);
