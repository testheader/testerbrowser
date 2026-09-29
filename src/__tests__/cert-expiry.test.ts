import { certExpiryState } from '../../renderer/urlbar-security.js';

const DAY_MS = 86400000;
const NOW = 1_700_000_000_000; // fixed epoch ms
const NOW_SEC = NOW / 1000;

describe('certExpiryState (#266)', () => {
  it('is "ok" 31 days out', () => {
    expect(certExpiryState(NOW_SEC + 31 * 86400, NOW)).toEqual({ state: 'ok', days: 31 });
  });

  it('is "soon" 29 days out', () => {
    expect(certExpiryState(NOW_SEC + 29 * 86400, NOW)).toEqual({ state: 'soon', days: 29 });
  });

  it('is "soon" expiring today (0 days out)', () => {
    expect(certExpiryState(NOW_SEC, NOW)).toEqual({ state: 'soon', days: 0 });
  });

  it('is "expired" once validTo is in the past', () => {
    const result = certExpiryState(NOW_SEC - 86400, NOW);
    expect(result.state).toBe('expired');
  });

  it('treats exactly 30 days out as "ok" (the boundary is under 30, not through it)', () => {
    expect(certExpiryState(NOW_SEC + 30 * 86400, NOW).state).toBe('ok');
  });

  it('is deterministic off its nowMs parameter, not the real clock', () => {
    const a = certExpiryState(NOW_SEC + DAY_MS / 1000, NOW);
    const b = certExpiryState(NOW_SEC + DAY_MS / 1000, NOW);
    expect(a).toEqual(b);
  });
});
