import { HitLogThrottle } from '../hitLogThrottle';
import { startStallWatchdog } from '../stallWatchdog';

describe('HitLogThrottle (#210)', () => {
  it('logs the first hit, folds the rest of the window into a count, then reports it', () => {
    const t = new HitLogThrottle(1000);
    expect(t.hit('rule', 0)).toEqual({ log: true, suppressed: 0 });
    expect(t.hit('rule', 10).log).toBe(false);
    expect(t.hit('rule', 999).log).toBe(false);
    expect(t.hit('rule', 1000)).toEqual({ log: true, suppressed: 2 });
  });

  it('keeps separate windows per key', () => {
    const t = new HitLogThrottle(1000);
    expect(t.hit('a', 0).log).toBe(true);
    expect(t.hit('b', 1).log).toBe(true);
    expect(t.hit('a', 2).log).toBe(false);
  });

  it('writes a bounded number of lines for a 3000-hit burst', () => {
    const t = new HitLogThrottle(1000);
    let lines = 0;
    for (let i = 0; i < 3000; i++) if (t.hit('rule', i * 8).log) lines++; // ~24s of hits
    expect(lines).toBeLessThanOrEqual(25);
  });
});

describe('startStallWatchdog', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('reports a stalled event loop but not a healthy one', () => {
    let clock = 0;
    const onStall = jest.fn();
    const stop = startStallWatchdog({ onStall, intervalMs: 500, thresholdMs: 2000, now: () => clock });

    clock += 500; jest.advanceTimersByTime(500); // on time
    expect(onStall).not.toHaveBeenCalled();

    clock += 500 + 5000; jest.advanceTimersByTime(500); // the loop was blocked for 5s
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(onStall).toHaveBeenCalledWith(5000);

    stop();
    clock += 10_000; jest.advanceTimersByTime(10_000);
    expect(onStall).toHaveBeenCalledTimes(1);
  });
});
