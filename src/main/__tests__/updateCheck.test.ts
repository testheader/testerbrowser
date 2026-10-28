import { UPDATE_CHECK_INTERVAL_MS, shouldRunPeriodicCheck } from '../updateCheck';

describe('periodic update re-check', () => {
  it('runs every 15 minutes', () => {
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(15 * 60_000);
  });

  it.each(['not-available', 'available-manual', 'error'])('runs when status is %s', (status) => {
    expect(shouldRunPeriodicCheck(status)).toBe(true);
  });

  it.each(['checking', 'available', 'downloading', 'downloaded'])('is skipped when status is %s', (status) => {
    expect(shouldRunPeriodicCheck(status)).toBe(false);
  });
});
