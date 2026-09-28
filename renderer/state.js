/* Shared read-only constants. Mutable state lives with the module that owns
   each domain (tabs.js, timeline.js, detail-panel.js, console-tabs.js,
   layout.js, bookmarks.js, toolbar.js, storage.js, notes.js) — see #125. */

export const TIMELINE_MAX    = 5000;
// #262: matches TIMELINE_MAX (was 500) — a fixed tail slice below the
// in-memory cap meant "Load older events" could prepend rows that were
// simply never rendered, since a prepend never changes which rows are in
// the last N of the array. 5000 plain monospace rows stays comfortably
// within what a non-virtualized DOM list can render (virtualization is
// explicitly out of scope for that ticket).
export const TIMELINE_DOM_MAX = TIMELINE_MAX;
export const TOPBAR_BASE     = 91;   // 40px merged titlebar+tabs row + 46px toolbar + 2px border + 3px loading bar
export const FIND_BAR_H      = 40;
export const BOOKMARKS_BAR_H = 32;
