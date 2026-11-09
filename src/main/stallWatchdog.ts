/**
 * Detects the main process's event loop being blocked. A timer that should
 * fire every `intervalMs` is compared with the wall clock; if it fires more
 * than `thresholdMs` late, the loop was stalled for that long and
 * `onStall(lagMs)` is called.
 *
 * Without this, a stall (e.g. #210's burst of synchronous log writes) leaves
 * no trace in main.log — the app just looks frozen, and a user who force-quits
 * it reports a "crash".
 */
export function startStallWatchdog(opts: {
  onStall: (lagMs: number) => void;
  intervalMs?: number;
  thresholdMs?: number;
  now?: () => number;
}): () => void {
  const intervalMs = opts.intervalMs ?? 500;
  const thresholdMs = opts.thresholdMs ?? 2000;
  const now = opts.now ?? Date.now;
  let last = now();
  const timer = setInterval(() => {
    const t = now();
    const lag = t - last - intervalMs;
    last = t;
    if (lag >= thresholdMs) opts.onStall(lag);
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
