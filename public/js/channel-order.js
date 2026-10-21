// Orata — pure helpers behind drag-to-reorder in the channel list (no DOM, no imports, so Node can test them too).
// A layout is the sidebar top to bottom: [{ catId, ids }] — the channels with no category first (catId null), then each category with its channels.

const byPos = (a, b) => (a.position || 0) - (b.position || 0);

export function buildLayout(channels) {
  const cats = channels.filter((c) => c.type === 'category').sort(byPos);
  const known = new Set(cats.map((c) => c.id));
  const rest = channels.filter((c) => c.type !== 'category');
  const inGroup = (pred) => rest.filter(pred).sort(byPos).map((c) => c.id);
  return [
    { catId: null, ids: inGroup((c) => !c.parentId || !known.has(c.parentId)) },
    ...cats.map((c) => ({ catId: c.id, ids: inGroup((x) => x.parentId === c.id) })),
  ];
}

/** Puts channel `id` at `index` of the group `toCat` (null = no category); `index` counts the group without the channel itself. Same layout back when nothing moves. */
export function moveChannel(layout, id, toCat, index) {
  const cur = layout.find((g) => g.ids.includes(id)); if (!cur) return layout;
  const dest = layout.find((g) => g.catId === toCat); if (!dest) return layout;
  const without = dest.ids.filter((x) => x !== id);
  const at = Math.max(0, Math.min(index, without.length));
  if (cur === dest && dest.ids[at] === id) return layout;
  const ids = [...without.slice(0, at), id, ...without.slice(at)];
  return layout.map((g) => (g === dest ? { ...g, ids } : g === cur ? { ...g, ids: g.ids.filter((x) => x !== id) } : g));
}

/** Puts category `id` at `index` among the categories (counted without itself); the "no category" group always stays first. */
export function moveCategory(layout, id, index) {
  const cats = layout.slice(1); const from = cats.findIndex((g) => g.catId === id); if (from < 0) return layout;
  const g = cats[from]; const without = cats.filter((x) => x !== g);
  const at = Math.max(0, Math.min(index, without.length));
  if (at === from) return layout;
  return [layout[0], ...without.slice(0, at), g, ...without.slice(at)];
}

/** What the server needs to hear to make `channels` look like `layout`: [{ id, position, parentId }] for just the ones that differ. */
export function layoutChanges(layout, channels) {
  const by = new Map(channels.map((c) => [c.id, c])); const out = [];
  const want = (id, position, parentId) => { const c = by.get(id); if (c && ((c.position || 0) !== position || (c.parentId || null) !== parentId)) out.push({ id, position, parentId }); };
  layout.slice(1).forEach((g, i) => want(g.catId, i, null));
  for (const g of layout) g.ids.forEach((id, i) => want(id, i, g.catId));
  return out;
}

/** `channels` with the changes from layoutChanges applied (new objects only for the ones that moved). */
export function applyChanges(channels, changes) {
  const by = new Map(changes.map((c) => [c.id, c]));
  return channels.map((c) => { const ch = by.get(c.id); return ch ? { ...c, position: ch.position, parentId: ch.parentId } : c; });
}
