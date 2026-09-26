import { buildNavMirrorStepResult, startSingleFlightPoll } from '../sessionManager';

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

// #258: startSingleFlightPoll replaces the old setInterval(relayFollowSteps, 300)
// — relayFollowSteps awaits harvestRecordingSteps() plus follower playback
// (which can wait up to 10s for a selector), so a plain interval could start
// a second tick before the first had settled, relaying the same step twice
// or relaying a stale value after a newer one. Tested standalone via a
// hand-resolvable stub rather than through a full SessionManager instance,
// since the scheduling logic itself doesn't depend on any of its plumbing.
describe('startSingleFlightPoll (#258 — no overlapping relay ticks)', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  function deferred<T = void>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  it('does not start a second tick while the first is still pending', () => {
    const first = deferred();
    const tick = jest.fn(() => first.promise);
    startSingleFlightPoll(tick, 300);

    jest.advanceTimersByTime(300);
    expect(tick).toHaveBeenCalledTimes(1);

    // Well past another full interval, but the first tick's promise is still
    // unresolved — no second tick should have started.
    jest.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('schedules the next tick 300ms after the previous one resolves, not from when it started', async () => {
    const d1 = deferred();
    const d2 = deferred();
    const calls = [d1.promise, d2.promise];
    const tick = jest.fn(() => calls.shift()!);
    startSingleFlightPoll(tick, 300);

    jest.advanceTimersByTime(300);
    expect(tick).toHaveBeenCalledTimes(1);

    d1.resolve();
    await Promise.resolve(); // flush the .then/.finally microtask chain
    await Promise.resolve();
    expect(tick).toHaveBeenCalledTimes(1); // resolved, but the next 300ms hasn't elapsed yet

    jest.advanceTimersByTime(299);
    expect(tick).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('a rejected tick still reschedules the next one 300ms later', async () => {
    const first = deferred();
    const tick = jest.fn(() => first.promise);
    startSingleFlightPoll(tick, 300);

    jest.advanceTimersByTime(300);
    expect(tick).toHaveBeenCalledTimes(1);

    first.reject(new Error('boom'));
    await Promise.resolve();
    await Promise.resolve();

    jest.advanceTimersByTime(300);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('stop() cancels the pending timeout, and no further ticks run', () => {
    const tick = jest.fn(() => Promise.resolve());
    const poller = startSingleFlightPoll(tick, 300);

    poller.stop();
    jest.advanceTimersByTime(10_000);
    expect(tick).toHaveBeenCalledTimes(0);
  });

  it('a tick already in flight when stop() is called does not reschedule once it settles', async () => {
    const first = deferred();
    const tick = jest.fn(() => first.promise);
    const poller = startSingleFlightPoll(tick, 300);

    jest.advanceTimersByTime(300);
    expect(tick).toHaveBeenCalledTimes(1);

    poller.stop();
    first.resolve();
    await Promise.resolve();
    await Promise.resolve();

    jest.advanceTimersByTime(10_000);
    expect(tick).toHaveBeenCalledTimes(1);
  });
});
