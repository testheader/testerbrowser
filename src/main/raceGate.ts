/**
 * Race gate: a barrier for paused requests.
 *
 * A Resilience rule of type `race` parks every matching request (held open at
 * the CDP Fetch pause) until `count` of them have arrived, then releases the
 * whole batch in one synchronous pass, so the server sees them back to back.
 * The requests are the page's own, so they carry real cookies/CSRF tokens and
 * are recorded like any other request. That is the point of gating them here
 * rather than replaying them.
 *
 * Pure and CDP-free on purpose: callers hand in a `release` callback per held
 * request, which keeps the barrier logic unit-testable. State is keyed by
 * partition + rule id, so tabs sharing a partition (in any window) share a
 * barrier. That is what makes "same user, two tabs" work.
 *
 * Not a single-packet attack: each release is a separate CDP command, so the
 * spread is typically sub-millisecond to a few ms, not zero.
 */

export const RACE_MIN_COUNT = 2;
export const RACE_MAX_COUNT = 50;
export const RACE_DEFAULT_COUNT = 2;
/** A gate that never fills would hang the page forever, so it always has a timeout. */
export const RACE_DEFAULT_TIMEOUT_MS = 10_000;
export const RACE_MAX_TIMEOUT_MS = 120_000;

export type RaceFlushReason = 'full' | 'timeout' | 'cleared';

export interface RaceFlush {
  key: string;
  reason: RaceFlushReason;
  /** How many held requests were released in this batch. */
  released: number;
  /** Wall-clock ms from the first request being held to the release. */
  heldForMs: number;
}

interface Held {
  sessionId: string;
  release: () => void;
}

interface Group {
  held: Held[];
  firstAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export function clampRaceCount(n: unknown): number {
  const v = Math.trunc(Number(n));
  if (!Number.isFinite(v)) return RACE_DEFAULT_COUNT;
  return Math.min(RACE_MAX_COUNT, Math.max(RACE_MIN_COUNT, v));
}

export function clampRaceTimeoutMs(ms: unknown): number {
  const v = Math.trunc(Number(ms));
  if (!Number.isFinite(v) || v <= 0) return RACE_DEFAULT_TIMEOUT_MS;
  return Math.min(RACE_MAX_TIMEOUT_MS, v);
}

export class RaceGate {
  private groups = new Map<string, Group>();

  /** Set once by the first window's manager; the gate itself is shared by all windows. */
  onFlush?: (flush: RaceFlush) => void;

  constructor(private now: () => number = Date.now) {}

  static key(partition: string, ruleId: string): string {
    return `${partition}\u0000${ruleId}`;
  }

  /** Requests currently parked at a gate (0 if it has none). */
  heldCount(key: string): number {
    return this.groups.get(key)?.held.length ?? 0;
  }

  /**
   * Park one request. Releases the whole batch (this request included) once
   * `count` have arrived, or when the timeout fires, whichever comes first.
   * Returns true if this call filled the gate.
   */
  hold(key: string, opts: { count: number; timeoutMs: number }, sessionId: string, release: () => void): boolean {
    const count = clampRaceCount(opts.count);
    let group = this.groups.get(key);
    if (!group) {
      group = {
        held: [],
        firstAt: this.now(),
        timer: setTimeout(() => this.flush(key, 'timeout'), clampRaceTimeoutMs(opts.timeoutMs)),
      };
      this.groups.set(key, group);
    }
    group.held.push({ sessionId, release });
    if (group.held.length >= count) {
      this.flush(key, 'full');
      return true;
    }
    return false;
  }

  /** Release whatever is parked at a gate now (rule removed/disabled, or timeout). */
  flush(key: string, reason: RaceFlushReason): void {
    const group = this.groups.get(key);
    if (!group) return;
    // Delete before releasing: a release callback must never see a half-drained group.
    this.groups.delete(key);
    clearTimeout(group.timer);
    const heldForMs = this.now() - group.firstAt;
    for (const h of group.held) {
      try { h.release(); } catch { /* a dead tab's release throws; the rest must still go */ }
    }
    this.onFlush?.({ key, reason, released: group.held.length, heldForMs });
  }

  /** Release every gate belonging to one rule (any partition key ending in its id). */
  flushRule(partition: string, ruleId: string): void {
    this.flush(RaceGate.key(partition, ruleId), 'cleared');
  }

  /**
   * A tab went away: drop its parked requests so they don't count toward a
   * batch (their release would be a no-op against a destroyed webContents).
   */
  discardSession(sessionId: string): void {
    for (const [key, group] of this.groups) {
      group.held = group.held.filter((h) => h.sessionId !== sessionId);
      if (group.held.length === 0) {
        clearTimeout(group.timer);
        this.groups.delete(key);
      }
    }
  }

  /** Drop everything without releasing (app shutdown). */
  dispose(): void {
    for (const group of this.groups.values()) clearTimeout(group.timer);
    this.groups.clear();
  }
}
