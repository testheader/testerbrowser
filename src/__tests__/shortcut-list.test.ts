import { SHORTCUTS } from '../../renderer/shortcut-table.js';
import { ACTION_LABELS, buildShortcutRows, formatCombo } from '../../renderer/shortcut-list.js';

describe('shortcut list (#316)', () => {
  it('has a label for every action in the shortcut table', () => {
    const missing = [...new Set(SHORTCUTS.map((s) => s.action))].filter((a) => !(a in ACTION_LABELS));
    expect(missing).toEqual([]);
  });

  it('formats modifiers and special keys', () => {
    expect(formatCombo({ ctrl: true, key: 't' })).toBe('Ctrl+T');
    expect(formatCombo({ ctrl: true, key: 'T' })).toBe('Ctrl+Shift+T');
    expect(formatCombo({ alt: true, key: 'ArrowLeft' })).toBe('Alt+←');
    expect(formatCombo({ key: 'Escape' })).toBe('Esc');
    expect(formatCombo({ key: 'F3', shift: true })).toBe('Shift+F3');
  });

  it('merges multiple bindings of one action into one row', () => {
    const rows = buildShortcutRows();
    expect(rows.find((r) => r.label === 'Reload')?.keys).toEqual(['Ctrl+R', 'F5']);
    expect(rows.find((r) => r.label === 'Zoom in')?.keys).toEqual(['Ctrl++']);
    expect(rows.some((r) => r.keys.includes('Ctrl+Tab'))).toBe(true);
  });
});
