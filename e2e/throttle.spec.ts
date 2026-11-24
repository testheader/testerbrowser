import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { getMainWindow, getTabPage, launchApp, MAIN_PATH, openNewSession } from './helpers';
import { startFixtureServer, FixtureServer } from './fixtures/server';

let app: ElectronApplication;
let window: Page;
let fixtures: FixtureServer;

test.beforeAll(async () => {
  fixtures = await startFixtureServer();
  app = await launchApp(MAIN_PATH);
  window = await getMainWindow(app);
  await window.waitForLoadState('load');
});

test.afterAll(async () => {
  await app.close();
  await fixtures.close();
});

// Per-tab network/CPU throttling (Spoof › Advanced). Rules have their own spec (rules.spec.ts).
// ── #265: per-tab network/CPU conditions ────────────────────────────────

async function listSessions(): Promise<{ id: string }[]> {
  return window.evaluate(() => (window as unknown as {
    testerBrowser: { sessions: { list(): Promise<{ id: string }[]> } };
  }).testerBrowser.sessions.list());
}

type Conditions = { network: string | { custom: unknown }; cpuRate: number } | null;

async function getConditions(id: string): Promise<Conditions> {
  return window.evaluate((sid) => (window as unknown as {
    testerBrowser: { resilience: { getConditions(id: string): Promise<Conditions> } };
  }).testerBrowser.resilience.getConditions(sid), id);
}

// window.selectOption() only awaits the <select>'s synchronous 'change'
// event dispatch, not the async body of the listener it triggers
// (applyConditionsFromForm's IPC round-trip to the real CDP commands) — so a
// measurement taken immediately after selectOption() can race ahead of the
// conditions actually landing. setConditions() only stores the new state
// once its CDP commands have resolved (see sessionManager.ts), so polling
// getConditions() here is a reliable "has it actually landed yet" signal.
async function waitForConditionsApplied(id: string, expected: Partial<{ network: string; cpuRate: number }>): Promise<void> {
  await expect.poll(async () => {
    const c = await getConditions(id);
    return c ? { network: c.network, cpuRate: c.cpuRate } : null;
  }).toMatchObject(expected);
}

// getTabPage() matches on a URL *substring*, and none of these tests close
// their tab afterward — with every one navigating to the same
// /network/api.html, a later test's getTabPage() call would ambiguously
// match an earlier (still-open, stale) test's tab instead of its own
// brand-new one (Playwright/Electron's window list is creation-ordered, so
// it'd silently grab the *first* match). A unique query string per test
// sidesteps that ambiguity entirely rather than relying on getTabPage()'s
// `exclude` param, which only guards against one prior page, not several.
test('selecting Offline sets navigator.onLine=false and fails a fetch; reverting restores both (#265)', async () => {
  await window.click('#newSessionBtn');
  const urlPath = '/network/api.html?t=265-offline';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);
  await window.click('#consoleTabSpoof');

  await window.selectOption('#resNetworkSelect', 'offline');
  await expect.poll(() => tab.evaluate(() => navigator.onLine)).toBe(false);

  const statusUrl = fixtures.url('/network/status/200');
  const offlineResult = await tab.evaluate(
    (url) => fetch(url).then(() => 'ok').catch(() => 'failed'), statusUrl);
  expect(offlineResult).toBe('failed');

  await window.selectOption('#resNetworkSelect', 'none');
  await expect.poll(() => tab.evaluate(() => navigator.onLine)).toBe(true);
  const onlineResult = await tab.evaluate(
    (url) => fetch(url).then((r) => r.status).catch(() => 'failed'), statusUrl);
  expect(onlineResult).toBe(200);

  // Close this test's own tab — left open, its URL (containing
  // /network/api.html) would ambiguously satisfy a later test's own
  // getTabPage() substring match against the *original* shared tab.
  await window.keyboard.press('Control+w');
});

test('Slow 3G measurably slows a ~100KB fetch relative to the same fetch unthrottled (#265)', async () => {
  await window.click('#newSessionBtn');
  const urlPath = '/network/api.html?t=265-slow3g';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);
  const sessionId = (await listSessions()).slice(-1)[0].id;
  await window.click('#consoleTabSpoof');

  // A fresh, unique URL each call — a response cached from the unthrottled
  // baseline fetch would let the "throttled" fetch resolve from disk/memory
  // cache without ever touching the (throttled) network, understating the
  // throttling effect regardless of whether it actually applied.
  const timeFetch = () => tab.evaluate(async () => {
    const start = performance.now();
    await fetch(`bytes?n=102400&t=${Date.now()}-${Math.random()}`).then((r) => r.arrayBuffer());
    return performance.now() - start;
  });

  const unthrottledMs = await timeFetch();

  await window.selectOption('#resNetworkSelect', 'slow3g');
  await waitForConditionsApplied(sessionId, { network: 'slow3g' });
  const throttledMs = await timeFetch();
  await window.selectOption('#resNetworkSelect', 'none');

  expect(throttledMs).toBeGreaterThanOrEqual(1500);
  expect(throttledMs).toBeGreaterThanOrEqual(unthrottledMs * 3);

  await window.keyboard.press('Control+w'); // see the comment above the Offline test
});

test('CPU 6x slowdown measurably slows a fixed busy-loop relative to the same loop unthrottled (#265)', async () => {
  const { id: sessionId } = await openNewSession(window);
  const urlPath = '/network/api.html?t=265-cpu';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);
  await tab.waitForLoadState('load');
  await window.click('#consoleTabSpoof');

  const runBusyLoop = () => tab.evaluate(() => {
    const start = performance.now();
    let x = 0;
    for (let i = 0; i < 30_000_000; i++) x += Math.sqrt(i);
    (window as unknown as { __busyLoopResult?: number }).__busyLoopResult = x; // keep the loop from being optimized away
    return performance.now() - start;
  });
  // Best of three: a shared CI runner's noise only ever makes a run slower,
  // so the fastest run is the closest to the loop's real cost.
  const bestOf3 = async () => Math.min(await runBusyLoop(), await runBusyLoop(), await runBusyLoop());

  // Warm up first. The very first run includes V8 compiling and optimizing
  // the loop, which made the old single "unthrottled" sample several times
  // slower than the warm, throttled run that followed — on CI that once
  // measured 57ms unthrottled vs 59ms at 6x, a "failure" with the throttle
  // working exactly as intended.
  await runBusyLoop();
  const unthrottledMs = await bestOf3();

  await window.selectOption('#resCpuSelect', '6');
  await waitForConditionsApplied(sessionId, { cpuRate: 6 });
  // 6x nominal; asserting 3x leaves room for runner noise without letting a
  // throttle that never applied (~1x) pass. Polled, in case CDP's throttle
  // lands a moment after getConditions() reports it.
  await expect.poll(bestOf3, { timeout: 20_000, message: `unthrottled best-of-3 was ${unthrottledMs.toFixed(1)}ms` })
    .toBeGreaterThanOrEqual(unthrottledMs * 3);
  await window.selectOption('#resCpuSelect', '1');

  await window.keyboard.press('Control+w'); // see the comment above the Offline test
});

test('conditions are per tab: a new tab starts unthrottled, and switching back restores the throttled tab\'s own state and indicator (#265)', async () => {
  await window.click('#newSessionBtn');
  const urlPathA = '/network/api.html?t=265-tabA';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPathA));
  await window.press('#urlbar', 'Enter');
  const tabA = await getTabPage(app, urlPathA);
  const sessionsAfterA = await listSessions();
  const tabAId = sessionsAfterA[sessionsAfterA.length - 1].id;

  await window.click('#consoleTabSpoof');
  await window.selectOption('#resNetworkSelect', 'offline');
  await expect.poll(() => tabA.evaluate(() => navigator.onLine)).toBe(false);
  await expect(window.locator(`.tab[data-id="${tabAId}"]`)).toHaveClass(/throttled/);

  await window.click('#newSessionBtn');
  const urlPathB = '/network/redirect.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPathB));
  await window.press('#urlbar', 'Enter');
  const tabB = await getTabPage(app, urlPathB);

  await expect(window.locator('#resNetworkSelect')).toHaveValue('none');
  await expect.poll(() => tabB.evaluate(() => navigator.onLine)).toBe(true);

  await window.click(`.tab[data-id="${tabAId}"] .tab-name`);
  await expect(window.locator('#resNetworkSelect')).toHaveValue('offline');
  await expect(window.locator(`.tab[data-id="${tabAId}"]`)).toHaveClass(/throttled/);

  // Clean up so this tab doesn't stay offline for any later test in this file.
  await window.selectOption('#resNetworkSelect', 'none');
  // Close both tabs — see the comment above the Offline test.
  await window.keyboard.press('Control+w'); // closes tabA (still active)
  await window.keyboard.press('Control+w'); // closes tabB
});
