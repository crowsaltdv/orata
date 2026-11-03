// Orata — smooth moves. When the pieces of a screen change places (a layout was edited or a theme with another layout was put on), each piece slides from where it
// was to where it is now instead of jumping. Used by the real screen (app.js) and the picture in Settings → Layout (settings-layout.js).
import { useLayoutEffect, useRef } from '/js/lib.js';

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** `root`: a ref to the element whose children move (and which is positioned, so the children's offsets are measured from it); each child's name is `idOf(child)`
 *  (by default its data-blk). `key`: changes whenever
 *  the arrangement does; when it changes, every child that moved slides into place, and one that changed size fades in at its new place instead of being stretched
 *  on the way. Where each child is is measured with offsets, not on-screen boxes, so a slide that is still going on never confuses the next one. */
export function useFlip(root, key, { ms = 340, off = false, idOf = (k) => k.dataset?.blk } = {}) {
  const seen = useRef(null); const was = useRef(key);
  const measure = () => { const m = new Map(); for (const k of root.current?.children || []) { const id = idOf(k); if (id) m.set(id, { left: k.offsetLeft, top: k.offsetTop, width: k.offsetWidth, height: k.offsetHeight }); } return m; };
  useLayoutEffect(() => {   // after every render: where the pieces are now (the next arrangement slides from here)
    const el = root.current; if (!el) return;
    const now = measure(); const before = seen.current; seen.current = now;
    if (was.current === key) return; was.current = key;
    if (off || reduced() || !before?.size || !el.animate) return;
    for (const k of el.children) {
      const id = idOf(k); const b = before.get(id); const a = now.get(id); if (!id || !b || !a) continue;
      const dx = b.left - a.left; const dy = b.top - a.top; const resized = Math.abs(b.width - a.width) > 2 || Math.abs(b.height - a.height) > 2;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && !resized) continue;
      k.getAnimations?.().forEach((x) => x.cancel());
      k.animate(resized
        ? [{ transform: `translate(${dx}px, ${dy}px)`, opacity: 0.15 }, { transform: 'none', opacity: 1 }]
        : [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: ms, easing: 'cubic-bezier(.2, .8, .2, 1)' });
    }
  });
}
