import fs from 'fs';
import path from 'path';

/**
 * #24 — the e2e suite must never depend on live network access: CI runs
 * against e2e/fixtures/server.ts (plain HTTP) and startHttpsFixtureServer
 * (self-signed HTTPS), both bound to 127.0.0.1, so a flaky or unreachable
 * real server can never fail a UI test. This statically guards that
 * invariant: it fails if any e2e spec ever points a real navigation
 * (urlbar fill/press, sessions.navigate) at a non-local host, which is the
 * actual way a live-network dependency would sneak in — as opposed to a
 * domain string used as inert data (a cookie's `domain`, a fake JSON
 * payload), which this deliberately does not flag.
 */

const E2E_DIR = path.join(__dirname, '../../e2e');
const ALLOWED_HOSTS = /^(127\.0\.0\.1|localhost)/;

// Matches the two ways a spec file actually drives a real navigation:
// filling the URL bar (then pressing Enter) or calling sessions.navigate().
const NAVIGATION_CALL = /(?:fill\(\s*['"]#urlbar['"]\s*,\s*|sessions\.navigate\([^,]+,\s*)(['"`])(https?:\/\/[^'"`]+)\1/g;

function listSpecFiles(): string[] {
  return fs.readdirSync(E2E_DIR)
    .filter((f) => f.endsWith('.spec.ts'))
    .map((f) => path.join(E2E_DIR, f));
}

describe('e2e suite has no live network dependency', () => {
  it('every real navigation target is 127.0.0.1/localhost, not a live external host', () => {
    const offenders: string[] = [];

    for (const file of listSpecFiles()) {
      const src = fs.readFileSync(file, 'utf-8');
      for (const match of src.matchAll(NAVIGATION_CALL)) {
        const url = match[2];
        // Template-literal targets like fixtures.url(...) interpolations
        // aren't literal external URLs — only flag plain string literals.
        if (url.includes('${')) continue;
        let host = '';
        try { host = new URL(url).hostname; } catch { continue; }
        if (!ALLOWED_HOSTS.test(host)) {
          offenders.push(`${path.basename(file)}: navigates to "${url}"`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('the fixture server binds to 127.0.0.1, not a wildcard/public interface', () => {
    const src = fs.readFileSync(path.join(E2E_DIR, 'fixtures/server.ts'), 'utf-8');
    const listenCalls = src.match(/\.listen\(0,\s*(['"`])([^'"`]+)\1/g) ?? [];
    expect(listenCalls.length).toBeGreaterThan(0);
    for (const call of listenCalls) {
      expect(call).toContain('127.0.0.1');
    }
  });
});
