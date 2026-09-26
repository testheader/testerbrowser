// #254: single source of truth for which key combo maps to which shortcut
// action, expressed here in TypeScript for sessionManager.ts and again,
// identically, in renderer/shortcut-table.js for the renderer's own
// shortcuts.js — the renderer is loaded as plain unbundled ESM and can't
// import a TS-compiled module from src/, so the two can't literally share
// one file across the process boundary. __tests__/shortcutTableSync.test.ts
// imports both and asserts they stay identical, so they can't silently
// drift apart without a failing test. See renderer/shortcut-table.js for
// the full design rationale (the `direct` flag, why Ctrl+Tab/Ctrl+1–9 stay
// as their own explicit branches).
export interface ShortcutEntry {
  action: string;
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  direct?: boolean;
}

export const SHORTCUTS: ShortcutEntry[] = [
  { action: 'newTab',             ctrl: true, key: 't' },
  { action: 'closeTab',           ctrl: true, key: 'w' },
  { action: 'reopenTab',          ctrl: true, key: 'T' },
  { action: 'focusUrl',           ctrl: true, key: 'l' },
  { action: 'findToggle',         ctrl: true, key: 'f' },
  { action: 'bookmark',           ctrl: true, key: 'd' },
  { action: 'toggleBookmarksBar', ctrl: true, key: 'B' },
  { action: 'findNext',           key: 'F3', shift: false },
  { action: 'findPrev',           key: 'F3', shift: true },
  { action: 'reload',             ctrl: true, key: 'r' },
  { action: 'reload',             key: 'F5' },
  { action: 'stopOrEsc',          key: 'Escape' },
  { action: 'devtools',           key: 'F12',           direct: true },
  { action: 'zoomIn',             ctrl: true, key: '=',  direct: true },
  { action: 'zoomIn',             ctrl: true, key: '+',  direct: true },
  { action: 'zoomOut',            ctrl: true, key: '-',  direct: true },
  { action: 'zoomReset',          ctrl: true, key: '0',  direct: true },
  { action: 'back',               alt: true, key: 'ArrowLeft',  direct: true },
  { action: 'forward',            alt: true, key: 'ArrowRight', direct: true },
];

function modMatches(want: boolean | undefined, have: boolean | undefined): boolean {
  return want === undefined || !!want === !!have;
}

export function matchShortcut(input: { ctrl?: boolean; shift?: boolean; alt?: boolean; key: string }): ShortcutEntry | undefined {
  return SHORTCUTS.find((s) =>
    modMatches(s.ctrl, input.ctrl) && modMatches(s.shift, input.shift) && modMatches(s.alt, input.alt) && s.key === input.key
  );
}
