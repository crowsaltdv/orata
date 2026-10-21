// Orata — favorite GIFs: a star in the GIF picker and on GIFs in chat; the list is saved with your account settings (so it follows you between devices).
import { state, useSel, updateSettings, toast } from '/js/store.js';

const MAX = 60;
/** What is kept of a GIF: enough to show it in the picker and send it again. */
export const slimGif = (it) => ({
  id: String(it.id), title: String(it.title || '').slice(0, 80), w: it.w || it.preview?.w, h: it.h || it.preview?.h,
  preview: { url: it.preview.url, w: it.preview.w, h: it.preview.h, mp4: it.preview.mp4 || null },
  full: { mp4: it.full?.mp4 || null, gif: it.full?.gif || null, webp: it.full?.webp || null, poster: it.full?.poster || null },
});
/** A GIF that arrived in a message (its own shape) as a favorite entry. */
export const gifFromMessage = (g) => slimGif({ id: g.id, title: g.title, w: g.w, h: g.h, preview: { url: g.poster || g.gif || g.url, w: g.w || 280, h: g.h || 200, mp4: g.mp4 }, full: { mp4: g.mp4, gif: g.gif, poster: g.poster } });
export const favGifs = () => state.settings.favGifs || [];
export const isFavGif = (id) => favGifs().some((g) => g.id === String(id));
/** Hooks: your favorites (re-renders when they change). */
export const useFavGifs = () => useSel((s) => s.settings.favGifs) || [];
/** Adds the GIF to your favorites, or removes it when it already is one. */
export function toggleFavGif(item) {
  const id = String(item.id); const cur = favGifs();
  if (cur.some((g) => g.id === id)) { updateSettings({ favGifs: cur.filter((g) => g.id !== id) }); return false; }
  if (cur.length >= MAX) { toast(`You can keep ${MAX} favorite GIFs — remove one first.`, 'error'); return false; }
  updateSettings({ favGifs: [slimGif(item), ...cur] }); return true;
}
