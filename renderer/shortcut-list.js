// #316: the Settings → Shortcuts list, generated from the shortcut table so
// it can't drift from what the app actually binds. Pure — no DOM access.
import { SHORTCUTS } from './shortcut-table.js';

/** Human label per table action. A unit test fails if an action has none. */
export const ACTION_LABELS = {
  newTab: 'New tab',
  closeTab: 'Close tab',
  reopenTab: 'Reopen closed tab',
  focusUrl: 'Focus URL bar',
  findToggle: 'Find in page',
  bookmark: 'Bookmark page',
  toggleBookmarksBar: 'Toggle bookmarks bar',
  findNext: 'Find next',
  findPrev: 'Find previous',
  reload: 'Reload',
  stopOrEsc: 'Stop loading / close find bar',
  devtools: 'DevTools',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  zoomReset: 'Reset zoom',
  back: 'Back',
  forward: 'Forward',
};

// Bindings that aren't flat key matches (see shortcut-table.js) or aren't
// keyboard shortcuts at all, so they can't come from the table.
export const EXTRA_SHORTCUTS = [
  { label: 'Cycle to last-used tab', keys: ['Ctrl+Tab'] },
  { label: 'Switch to tab by number', keys: ['Ctrl+1–9'] },
  { label: 'Close tab', keys: ['Middle-click tab'] },
  { label: 'Open link in new tab (same session)', keys: ['Middle-click link'] },
  { label: 'Rename, pin, clone, notes…', keys: ['Right-click tab'] },
];

const KEY_NAMES = { ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc', '=': '+' };

/** @param {{ ctrl?: boolean, shift?: boolean, alt?: boolean, key: string }} s */
export function formatCombo(s) {
  const parts = [];
  // An upper-case letter binding (Ctrl+T vs Ctrl+Shift+T) means Shift is held.
  const shift = s.shift ?? (s.key.length === 1 && s.key !== s.key.toLowerCase());
  if (s.ctrl) parts.push('Ctrl');
  if (shift) parts.push('Shift');
  if (s.alt) parts.push('Alt');
  const key = KEY_NAMES[s.key] ?? (s.key.length === 1 ? s.key.toUpperCase() : s.key);
  parts.push(key);
  return parts.join('+');
}

/** @returns {{ label: string, keys: string[] }[]} */
export function buildShortcutRows() {
  /** @type {Map<string, string[]>} */
  const byAction = new Map();
  for (const s of SHORTCUTS) {
    const combos = byAction.get(s.action) ?? [];
    const combo = formatCombo(s);
    if (!combos.includes(combo)) combos.push(combo);
    byAction.set(s.action, combos);
  }
  const rows = [...byAction].map(([action, keys]) => ({ label: ACTION_LABELS[action] ?? action, keys }));
  return [...rows, ...EXTRA_SHORTCUTS];
}
