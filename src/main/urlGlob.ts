// Matches CDP's own Fetch.RequestPattern.urlPattern semantics (the pattern a
// Mock/Resilience rule is ultimately handed to via Fetch.enable — see
// SessionManager's _applyFetch()): '*' matches zero or more characters, '?'
// matches exactly one character, and every other character — including
// every other regex metacharacter — matches itself literally. '*' and '?'
// are left out of the escape class so they're still recognizable as
// wildcards in the next two steps, then each is turned into its regex
// equivalent. Shared between MockManager and ResilienceManager (#255) so the
// two can never disagree on what a rule's urlPattern actually matches.
export function matchesGlob(pattern: string, url: string): boolean {
  try {
    const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    return re.test(url);
  } catch { return false; }
}
