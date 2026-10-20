import { formatAgo } from '../../renderer/utils.js';

describe('formatAgo (#310)', () => {
  const now = 1_000_000_000;
  it('handles never, seconds, minutes, hours and days', () => {
    expect(formatAgo(0, now)).toBe('Never');
    expect(formatAgo(now - 5_000, now)).toBe('5 s ago');
    expect(formatAgo(now - 3 * 60_000, now)).toBe('3 min ago');
    expect(formatAgo(now - 2 * 3_600_000, now)).toBe('2 h ago');
    expect(formatAgo(now - 3 * 86_400_000, now)).toBe('3 d ago');
  });
});
