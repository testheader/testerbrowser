// Pure decision behind the periodic update re-check (index.ts's setInterval).
// Kept Electron-free so it's testable without booting Electron.

// How often a running app asks the release feed for a newer version. The
// check is one small HTTPS request to GitHub, so it's cheap to run often.
export const UPDATE_CHECK_INTERVAL_MS = 15 * 60_000;

// Statuses where a re-check would be wrong:
// - 'checking' / 'available' / 'downloading': a check or download is already in flight.
// - 'downloaded': the update is ready. A re-check would reset the status and stop
//   the idle-install timer, which only runs while the status is 'downloaded'.
const SKIP_PERIODIC_CHECK = new Set(['checking', 'available', 'downloading', 'downloaded']);

export function shouldRunPeriodicCheck(status: string): boolean {
  return !SKIP_PERIODIC_CHECK.has(status);
}
