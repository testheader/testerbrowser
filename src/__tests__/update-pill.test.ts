import { shouldShowUpdatePill, tempTabCount } from '../../renderer/update-pill.js';

describe('shouldShowUpdatePill (#230)', () => {
  it('shows the pill only for a downloaded update', () => {
    expect(shouldShowUpdatePill('downloaded')).toBe(true);
  });

  it('does not show the pill for any other status, including available-manual', () => {
    expect(shouldShowUpdatePill('checking')).toBe(false);
    expect(shouldShowUpdatePill('available')).toBe(false);
    expect(shouldShowUpdatePill('available-manual')).toBe(false);
    expect(shouldShowUpdatePill('downloading')).toBe(false);
    expect(shouldShowUpdatePill('not-available')).toBe(false);
    expect(shouldShowUpdatePill('error')).toBe(false);
  });
});

describe('tempTabCount (#230)', () => {
  it('counts only non-persistent sessions', () => {
    const sessions = [
      { id: 'a', persistent: true },
      { id: 'b', persistent: false },
      { id: 'c', persistent: false },
      { id: 'd', persistent: true },
    ];
    expect(tempTabCount(sessions)).toBe(2);
  });

  it('returns 0 when every session is persistent', () => {
    expect(tempTabCount([{ id: 'a', persistent: true }, { id: 'b', persistent: true }])).toBe(0);
  });

  it('returns 0 for an empty or missing list', () => {
    expect(tempTabCount([])).toBe(0);
    expect(tempTabCount(undefined)).toBe(0);
    expect(tempTabCount(null)).toBe(0);
  });
});
