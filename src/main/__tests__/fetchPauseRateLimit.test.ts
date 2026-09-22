import {
  shouldRateLimitFetchPause,
  FetchPauseRateState,
  FETCH_PAUSE_RATE_LIMIT,
  FETCH_PAUSE_RATE_WINDOW_MS,
} from '../sessionManager';

function freshState(): FetchPauseRateState {
  return { windowStart: 0, count: 0 };
}

describe('shouldRateLimitFetchPause (#210)', () => {
  it('does not rate-limit calls within the cap in one window', () => {
    const state = freshState();
    const now = 1_000_000;
    for (let i = 0; i < FETCH_PAUSE_RATE_LIMIT; i++) {
      expect(shouldRateLimitFetchPause(state, now)).toBe(false);
    }
  });

  it('rate-limits calls once the cap is exceeded within one window', () => {
    const state = freshState();
    const now = 1_000_000;
    for (let i = 0; i < FETCH_PAUSE_RATE_LIMIT; i++) shouldRateLimitFetchPause(state, now);
    // One more in the same window — over the cap.
    expect(shouldRateLimitFetchPause(state, now)).toBe(true);
    expect(shouldRateLimitFetchPause(state, now + 1)).toBe(true);
  });

  it('resets the cap once a new window starts', () => {
    const state = freshState();
    const now = 2_000_000;
    for (let i = 0; i < FETCH_PAUSE_RATE_LIMIT; i++) shouldRateLimitFetchPause(state, now);
    expect(shouldRateLimitFetchPause(state, now)).toBe(true);

    // A call FETCH_PAUSE_RATE_WINDOW_MS later starts a fresh window, so the
    // cap applies again from zero rather than staying tripped forever.
    const nextWindow = now + FETCH_PAUSE_RATE_WINDOW_MS;
    expect(shouldRateLimitFetchPause(state, nextWindow)).toBe(false);
  });

  it('a burst spread safely under the cap across many windows never trips it', () => {
    const state = freshState();
    let now = 3_000_000;
    // Half the cap, once per window, for 10 windows — well under the
    // threshold each time, unlike a genuine flood concentrated in one window.
    for (let w = 0; w < 10; w++) {
      for (let i = 0; i < FETCH_PAUSE_RATE_LIMIT / 2; i++) {
        expect(shouldRateLimitFetchPause(state, now)).toBe(false);
      }
      now += FETCH_PAUSE_RATE_WINDOW_MS;
    }
  });

  it('mutates the passed-in state object rather than tracking state internally', () => {
    const state = freshState();
    shouldRateLimitFetchPause(state, 5_000_000);
    expect(state.count).toBe(1);
    expect(state.windowStart).toBe(5_000_000);
  });
});
