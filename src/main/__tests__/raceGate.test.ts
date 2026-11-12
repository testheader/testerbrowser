import { RaceGate, RaceFlush, clampRaceCount, clampRaceTimeoutMs, RACE_DEFAULT_TIMEOUT_MS, RACE_MAX_COUNT, RACE_MIN_COUNT, RACE_MAX_TIMEOUT_MS } from '../raceGate';
import * as renderer from '../../../renderer/resilience-logic.js';

const K = RaceGate.key('persist:a', 'rule1');
const opts = (count: number, timeoutMs = 1000) => ({ count, timeoutMs });

describe('RaceGate', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('holds requests until the count is reached, then releases all of them together', () => {
    const gate = new RaceGate();
    const order: string[] = [];
    expect(gate.hold(K, opts(3), 's1', () => order.push('a'))).toBe(false);
    expect(gate.hold(K, opts(3), 's2', () => order.push('b'))).toBe(false);
    expect(order).toEqual([]);
    expect(gate.heldCount(K)).toBe(2);
    expect(gate.hold(K, opts(3), 's1', () => order.push('c'))).toBe(true);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(gate.heldCount(K)).toBe(0);
  });

  it('starts a fresh batch after a flush', () => {
    const gate = new RaceGate();
    const rel = jest.fn();
    gate.hold(K, opts(2), 's', rel); gate.hold(K, opts(2), 's', rel);
    expect(rel).toHaveBeenCalledTimes(2);
    gate.hold(K, opts(2), 's', rel);
    expect(rel).toHaveBeenCalledTimes(2);
    expect(gate.heldCount(K)).toBe(1);
  });

  it('releases a partial batch when the timeout fires, and reports why', () => {
    const flushes: RaceFlush[] = [];
    const gate = new RaceGate(() => 1000);
    gate.onFlush = (f) => flushes.push(f);
    const rel = jest.fn();
    gate.hold(K, opts(5, 2000), 's', rel);
    jest.advanceTimersByTime(1999);
    expect(rel).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(rel).toHaveBeenCalledTimes(1);
    expect(flushes).toEqual([{ key: K, reason: 'timeout', released: 1, heldForMs: 0 }]);
  });

  it('does not fire the timeout after a full release', () => {
    const gate = new RaceGate();
    const rel = jest.fn();
    gate.hold(K, opts(2, 500), 's', rel); gate.hold(K, opts(2, 500), 's', rel);
    jest.advanceTimersByTime(5000);
    expect(rel).toHaveBeenCalledTimes(2);
  });

  it('keeps gates for different rules and partitions independent', () => {
    const gate = new RaceGate();
    const a = jest.fn(); const b = jest.fn();
    gate.hold(RaceGate.key('p1', 'r'), opts(2), 's', a);
    gate.hold(RaceGate.key('p2', 'r'), opts(2), 's', b);
    expect(a).not.toHaveBeenCalled(); expect(b).not.toHaveBeenCalled();
  });

  it('a throwing release does not stop the rest of the batch', () => {
    const gate = new RaceGate();
    const ok = jest.fn();
    gate.hold(K, opts(3), 's', () => { throw new Error('destroyed'); });
    gate.hold(K, opts(3), 's', ok);
    gate.hold(K, opts(3), 's', ok);
    expect(ok).toHaveBeenCalledTimes(2);
  });

  it('flushRule releases what is parked (rule removed/disabled)', () => {
    const flushes: RaceFlush[] = [];
    const gate = new RaceGate();
    gate.onFlush = (f) => flushes.push(f);
    const rel = jest.fn();
    gate.hold(K, opts(5), 's', rel);
    gate.flushRule('persist:a', 'rule1');
    expect(rel).toHaveBeenCalledTimes(1);
    expect(flushes[0].reason).toBe('cleared');
    expect(() => gate.flushRule('persist:a', 'rule1')).not.toThrow();
  });

  it('discardSession drops a closed tab\'s requests without releasing them or counting them', () => {
    const gate = new RaceGate();
    const gone = jest.fn(); const stay = jest.fn();
    gate.hold(K, opts(2), 'closed', gone);
    gate.discardSession('closed');
    expect(gate.heldCount(K)).toBe(0);
    gate.hold(K, opts(2), 'open', stay);
    expect(stay).not.toHaveBeenCalled(); // the dead tab no longer counts toward the batch
    jest.advanceTimersByTime(60_000);
    expect(gone).not.toHaveBeenCalled();
  });

  it('dispose cancels timers without releasing', () => {
    const gate = new RaceGate();
    const rel = jest.fn();
    gate.hold(K, opts(2, 100), 's', rel);
    gate.dispose();
    jest.advanceTimersByTime(1000);
    expect(rel).not.toHaveBeenCalled();
  });
});

describe('clamps', () => {
  it('clampRaceCount keeps 2-50 and defaults on garbage', () => {
    expect(clampRaceCount(1)).toBe(2);
    expect(clampRaceCount(999)).toBe(50);
    expect(clampRaceCount(7.9)).toBe(7);
    expect(clampRaceCount(undefined)).toBe(2);
    expect(clampRaceCount('nope')).toBe(2);
  });
  it('clampRaceTimeoutMs defaults on 0/garbage and caps at 120 s', () => {
    expect(clampRaceTimeoutMs(0)).toBe(RACE_DEFAULT_TIMEOUT_MS);
    expect(clampRaceTimeoutMs(undefined)).toBe(RACE_DEFAULT_TIMEOUT_MS);
    expect(clampRaceTimeoutMs(5000)).toBe(5000);
    expect(clampRaceTimeoutMs(10 ** 9)).toBe(RACE_MAX_TIMEOUT_MS);
  });
  it('the renderer copy of the bounds matches the main process', () => {
    expect(renderer.RACE_MIN_COUNT).toBe(RACE_MIN_COUNT);
    expect(renderer.RACE_MAX_COUNT).toBe(RACE_MAX_COUNT);
    expect(renderer.RACE_DEFAULT_TIMEOUT_SEC * 1000).toBe(RACE_DEFAULT_TIMEOUT_MS);
    expect(renderer.RACE_MAX_TIMEOUT_SEC * 1000).toBe(RACE_MAX_TIMEOUT_MS);
  });
});
