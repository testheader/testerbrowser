import { SHORTCUTS as MAIN_SHORTCUTS, matchShortcut as mainMatchShortcut } from '../shortcutTable';
import { SHORTCUTS as RENDERER_SHORTCUTS, matchShortcut as rendererMatchShortcut } from '../../../renderer/shortcut-table.js';

// #254: sessionManager.ts's before-input-event handler and renderer/
// shortcuts.js's own keydown listener each need the same key-combo → action
// mapping, but the renderer (plain unbundled ESM) can't import a TS-compiled
// module from src/, so the table is expressed twice — once here in TS, once
// in renderer/shortcut-table.js. This test is the only thing standing
// between an edit to one and a genuine, silent behavior split between the
// two processes: any change to one file that isn't mirrored in the other
// fails this test.
describe('shortcut table stays in sync between main and renderer (#254)', () => {
  it('renderer/shortcut-table.js\'s SHORTCUTS is structurally identical to shortcutTable.ts\'s', () => {
    expect(RENDERER_SHORTCUTS).toEqual(MAIN_SHORTCUTS);
  });

  it('matchShortcut behaves identically on both sides for every entry', () => {
    for (const entry of MAIN_SHORTCUTS) {
      const input = { ctrl: entry.ctrl, shift: entry.shift, alt: entry.alt, key: entry.key };
      expect(rendererMatchShortcut(input)).toEqual(mainMatchShortcut(input));
    }
  });

  it('matchShortcut behaves identically on both sides for a sampling of non-matching input', () => {
    const misses = [
      { key: 'x' },
      { ctrl: true, key: 'x' },
      { ctrl: true, shift: true, key: 't' }, // 'T' is the reopenTab entry, not 't'
      { key: 'F1' },
      { ctrl: true, alt: true, key: 'Tab' }, // handled by its own branch, not this table
    ];
    for (const input of misses) {
      expect(rendererMatchShortcut(input)).toEqual(mainMatchShortcut(input));
    }
  });
});
