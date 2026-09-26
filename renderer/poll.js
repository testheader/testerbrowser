// #254: consolidates the "single-flight interval poll that skips its own
// work while its panel isn't visible" pattern shared by debuglog.js,
// mock.js and resilience.js. Each panel still owns what "visible" means for
// it and what its own tick actually does — this only owns the scheduling:
// single-flight (a slow tick never overlaps the next, the same overlap
// concern #248/#258 raise for Follow Along's relay loop), and isVisible()
// is checked fresh before every tick rather than once at start, so a panel
// that becomes hidden mid-flight has its NEXT tick skipped, not just future
// ones scheduled after some external stop() call.
//
// record-playback.js's own recording poller is a deliberate exception, not
// migrated here — it's gated on isRecording, not tab visibility, and must
// keep polling even when the Tests tab isn't the one currently showing
// (#224: "a recording started on one tab keeps polling and stops on that
// tab, even if another tab is active at Stop"). Routing it through
// isVisible() would silence it exactly when #224 says it must not be.
export function pollWhileVisible(fn, intervalMs, isVisible) {
  let stopped = false;
  let timer = null;
  const tick = () => {
    if (stopped) return;
    Promise.resolve(isVisible() ? fn() : undefined)
      .catch(() => {})
      .finally(() => {
        if (stopped) return;
        timer = setTimeout(tick, intervalMs);
      });
  };
  timer = setTimeout(tick, intervalMs);
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}
