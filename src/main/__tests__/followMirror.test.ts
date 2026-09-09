import { buildNavMirrorStepResult } from '../sessionManager';

describe('buildNavMirrorStepResult (#186 — logging mirrored navigations)', () => {
  it('a successful full-page navigation reports success with the destination URL', () => {
    const payload = buildNavMirrorStepResult('navigate', 'https://example.com/page');
    expect(payload.step).toEqual({ type: 'navigate', url: 'https://example.com/page' });
    expect(payload.result).toEqual({ success: true });
  });

  it('a successful in-page navigation is distinguishable from a full navigation', () => {
    const payload = buildNavMirrorStepResult('navigate-in-page', 'https://example.com/page#section');
    expect(payload.step.type).toBe('navigate-in-page');
    expect(payload.step).not.toEqual(expect.objectContaining({ type: 'navigate' }));
  });

  it('a failed mirror carries the error and success:false', () => {
    const payload = buildNavMirrorStepResult('navigate', 'https://example.com/blocked', 'net::ERR_FAILED');
    expect(payload.result).toEqual({ success: false, error: 'net::ERR_FAILED' });
    expect(payload.step.url).toBe('https://example.com/blocked');
  });
});
