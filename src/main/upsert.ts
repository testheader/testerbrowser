// Replaces an existing item with the same `id`, or appends if none exists.
// Used by tests:save (and any other by-id-upsert store) so editing a saved
// item never creates a second entry with a different id for the "same" item.
export function upsertById<T extends { id: string }>(arr: T[], item: T): T[] {
  const idx = arr.findIndex(t => t.id === item.id);
  if (idx >= 0) {
    const next = arr.slice();
    next[idx] = item;
    return next;
  }
  return [...arr, item];
}
