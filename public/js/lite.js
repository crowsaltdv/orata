// Orata — Lite mode: a lighter Orata for Chromebooks and low-end laptops. No rain, liquid glass, wallpaper picture, blur or downloaded fonts
// (theme.js, lite.css rules in extras.css); no link previews; only the lighter profile effects, slower and sparser (profile-style.js); smaller
// pictures and GIFs (thumb() below, message.js). Chosen per device: `mode` is the last pick, `modePref` the mode Orata opens in ('ask' = the
// launch screen asks, app.js ModeChooser). For now only orata_dev sees the choice.
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

/** In Lite mode an uploaded picture comes as a smaller, lighter copy (server/index.js /thumbs; an animated GIF becomes a still). */
export const thumb = (url, w) => (LITE && /^\/uploads\/[A-Za-z0-9_.-]+\.(png|jpe?g|gif|webp|avif)$/i.test(url || '') ? `/thumbs/${w}/${url.slice(9)}` : url);
/** Profile effects that draw a lot (many particles or big gradients over the whole card): off in Lite mode. */
export const HEAVY_EFFECTS = new Set(['glitter', 'starfield', 'galaxy', 'rain', 'snow', 'confetti', 'aurora', 'fog', 'ocean', 'caustics', 'rays', 'disco', 'spotlight', 'bokeh']);
