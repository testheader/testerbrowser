/**
 * Rate-limits a log line that fires once per matching request (#210). A
 * broad Resilience pattern such as "*ad*" hits thousands of requests in a
 * burst, and every log.info() is a synchronous main-thread cost (rewrite of
 * app-errors.json, a SQLite insert, a main.log append), so logging each hit
 * stalled the whole app for tens of seconds.
 *
 * The first hit for a key logs immediately; further hits inside the window
 * are only counted, and the next hit after the window reports how many were
 * folded in.
 */
export class HitLogThrottle {
  private state = new Map<string, { windowStart: number; suppressed: number }>();

  constructor(private windowMs = 1000) {}

  /** `log` says whether to write a line now; `suppressed` is how many hits since the last line. */
  hit(key: string, now: number = Date.now()): { log: boolean; suppressed: number } {
    const s = this.state.get(key);
    if (!s || now - s.windowStart >= this.windowMs) {
      this.state.set(key, { windowStart: now, suppressed: 0 });
      return { log: true, suppressed: s?.suppressed ?? 0 };
    }
    s.suppressed++;
    return { log: false, suppressed: s.suppressed };
  }

  clear(key: string): void {
    this.state.delete(key);
  }
}
