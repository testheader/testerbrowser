/**
 * Parses testerbrowser://open?url=<target> deep links (custom-protocol
 * handling — see index.ts's setAsDefaultProtocolClient/open-url/second-instance
 * wiring). Kept as a pure function so the parsing itself is unit-testable
 * without needing a real OS protocol registration, which only actually does
 * anything once the app is installed (Playwright/CI can't exercise the
 * registry/xdg-mime side of this at all).
 */
export function parseDeepLink(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'testerbrowser:') return null;
  const target = url.searchParams.get('url');
  if (!target || !/^https?:\/\//i.test(target)) return null;
  return target;
}

/** Picks the first testerbrowser:// argument out of a process argv list
 *  (how the link arrives on Windows/Linux: a second app instance is launched
 *  with the link as a CLI argument, forwarded to the running instance via
 *  'second-instance'). */
export function findDeepLinkArg(argv: string[]): string | null {
  const arg = argv.find((a) => a.startsWith('testerbrowser://'));
  return arg ? parseDeepLink(arg) : null;
}
