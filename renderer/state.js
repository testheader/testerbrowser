/* Shared read-only constants. Mutable state lives with the module that owns
   each domain (tabs.js, timeline.js, detail-panel.js, console-tabs.js,
   layout.js, bookmarks.js, toolbar.js, storage.js, notes.js) — see #125. */

export const TIMELINE_MAX    = 5000;
export const TIMELINE_DOM_MAX = 500;
export const TOPBAR_BASE     = 127;  // 36px titlebar + 40px tabs + 46px toolbar + 2px border + 3px loading bar
export const FIND_BAR_H      = 40;
export const BOOKMARKS_BAR_H = 32;
