import { badgeLabel } from '../../renderer/tab-badges.js';

describe('tab badge labels (#298)', () => {
  it('pluralises per tab noun', () => {
    expect(badgeLabel('console', 1)).toBe('1 error');
    expect(badgeLabel('console', 2)).toBe('2 errors');
    expect(badgeLabel('a11y', 3)).toBe('3 issues');
    expect(badgeLabel('security', 1)).toBe('1 finding');
    expect(badgeLabel('security', 6)).toBe('6 findings');
  });
});
