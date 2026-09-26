// #254: single source of truth for which key combo maps to which shortcut
// action, shared conceptually by two dispatchers that can't literally share
// one module across the process boundary — the renderer is loaded as plain,
// unbundled ESM (this file), while src/main/sessionManager.ts is
// TypeScript compiled to CommonJS. src/main/shortcutTable.ts is the same
// table expressed in TS; src/main/__tests__/shortcutTableSync.test.ts
// imports both and asserts they stay identical, so the two can't silently
// drift apart without a failing test.
//
// `direct: true` marks a shortcut sessionManager.ts's before-input-event
// handler executes itself (devtools/zoom/back-forward) when the active
// tab's own WebContentsView has focus, rather than forwarding it to the
// renderer as an app:shortcut IPC message — renderer/shortcuts.js's own
// keydown listener (chrome-focused case) executes every action directly
// either way, since there's nothing to forward to from there.
//
// Ctrl+Tab (cycle tabs, needs a reverse-direction flag) and Ctrl+1–9
// (switch to tab N, needs the digit) aren't flat key matches and stay as
// their own explicit branches in both dispatchers, ahead of this table.
export const SHORTCUTS = [
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

function modMatches(want, have) {
  return want === undefined || !!want === !!have;
}

// Returns the first SHORTCUTS entry whose modifiers/key match the given
// normalized input, or undefined. A modifier field left unset on an entry
// means "don't care" — matching whichever original if-chain condition that
// entry replaces, most of which never checked every modifier either (e.g.
// Ctrl+Alt+T still triggers newTab, exactly as before this table existed).
export function matchShortcut({ ctrl, shift, alt, key }) {
  return SHORTCUTS.find((s) =>
    modMatches(s.ctrl, ctrl) && modMatches(s.shift, shift) && modMatches(s.alt, alt) && s.key === key
  );
}
