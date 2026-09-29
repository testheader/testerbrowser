import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { getMainWindow, getTabPage, launchApp, MAIN_PATH } from './helpers';
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

// #265's tests intentionally run first, right after the shared app launches
// and before any Mock/Resilience rule exists — a later "hang" rule test
// (#236) leaves a Fetch domain interception permanently unresolved by
// design (the request is meant to stay pending until the client aborts it,
// and nothing in that test's own scope ever resolves the underlying CDP
// interception), which was observed to make Network.emulateNetworkConditions
// silently no-op on an unrelated, later-created tab for the rest of the
// file — a pre-existing #236 test-hygiene gap, not a bug in this feature.
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
  await window.click('#consoleTabResilience');

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
  await window.click('#consoleTabResilience');

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
  await window.click('#newSessionBtn');
  const urlPath = '/network/api.html?t=265-cpu';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);
  const sessionId = (await listSessions()).slice(-1)[0].id;
  await window.click('#consoleTabResilience');

  const runBusyLoop = () => tab.evaluate(() => {
    const start = performance.now();
    let x = 0;
    for (let i = 0; i < 30_000_000; i++) x += Math.sqrt(i);
    (window as unknown as { __busyLoopResult?: number }).__busyLoopResult = x; // keep the loop from being optimized away
    return performance.now() - start;
  });

  const unthrottledMs = await runBusyLoop();

  await window.selectOption('#resCpuSelect', '6');
  await waitForConditionsApplied(sessionId, { cpuRate: 6 });
  const throttledMs = await runBusyLoop();
  await window.selectOption('#resCpuSelect', '1');

  expect(throttledMs).toBeGreaterThanOrEqual(unthrottledMs * 3);

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

  await window.click('#consoleTabResilience');
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

test('a 100% error500 rule actually fails a matching fetch, and hits increments', async () => {
  const urlPath = '/network/api.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);

  await window.click('#consoleTabResilience');
  await window.selectOption('#resType', 'error500');
  await window.fill('#resUrl', '*/api/resilience-target');
  await window.fill('#resProb', '100');
  await window.click('.res-add-btn');
  await expect(window.locator('.res-rule-row')).toBeVisible();

  await tab.fill('#apiPath', '/api/resilience-target');
  await tab.click('#apiFetchBtn');
  await expect(tab.locator('#apiOut')).toContainText('"status":500', { timeout: 5_000 });

  await expect(window.locator('.res-hits-badge')).toHaveText('Hits: 1', { timeout: 3_000 });

  // The RESILIENCE flag should show on the request row, not just the response
  // row — the request is recorded before Fetch.requestPaused tags it, so this
  // also exercises the retroactive tag-patch onto the already-recorded row.
  await window.click('#consoleTabNetwork');
  const requestRow = window.locator('.evt.network-request', { hasText: '/api/resilience-target' });
  await expect(requestRow.locator('.evt-badge-resilience')).toBeVisible({ timeout: 5_000 });
});

test('an existing rule can be edited in place', async () => {
  await window.click('#consoleTabResilience');
  const row = window.locator('.res-rule-row').first();
  await row.locator('.res-edit-btn').click();

  const editRow = window.locator('.res-rule-row-editing');
  await expect(editRow).toBeVisible();
  await editRow.locator('.res-edit-prob').fill('42');
  await editRow.locator('.res-save-btn').click();

  await expect(window.locator('.res-rule-row').first().locator('.res-prob-badge')).toHaveText('42%');
});

test('the 1.5s auto-refresh does not wipe an in-progress edit (#224)', async () => {
  await window.click('#consoleTabResilience');
  const row = window.locator('.res-rule-row').first();
  await row.locator('.res-edit-btn').click();

  const editRow = window.locator('.res-rule-row-editing');
  await expect(editRow).toBeVisible();
  const urlField = editRow.locator('.res-edit-url');
  await urlField.fill('*/api/still-editing');

  // Auto-refresh polls every 1.5s — wait past two ticks and confirm the
  // edit row (and the typed value) is still there, not replaced by a
  // freshly re-rendered read-only row. This is a genuine negative wait
  // (proving nothing changed over the window): there is no DOM signal to
  // wait on for "two poll ticks did NOT happen", so a fixed sleep is the
  // only way to give the auto-refresh timer a real chance to fire twice.
  await window.waitForTimeout(3_500);
  await expect(window.locator('.res-rule-row-editing')).toHaveCount(1);
  await expect(urlField).toHaveValue('*/api/still-editing');

  await editRow.locator('.res-cancel-btn').click();
  await expect(window.locator('.res-rule-row-editing')).toHaveCount(0);
});

test('the "View in Network" button on a rule filters the Network tab to its pattern', async () => {
  await window.click('#consoleTabResilience');
  await window.locator('.res-rule-row').first().locator('.res-network-btn').click();

  await expect(window.locator('#consoleTabNetwork')).toHaveClass(/active/);
  await expect(window.locator('#networkFilterText')).toHaveValue('/api/resilience-target');
});

test('sending a captured POST request to Resilience scopes the rule to that method (#181)', async () => {
  const urlPath = '/network/api.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);

  const targetUrl = fixtures.url('/api/resilience-method-check');

  await window.click('#consoleTabNetwork');
  await window.click('#clearNetworkBtn');
  // A previous test ("View in Network") left the free-text filter set to its
  // own pattern — clear it so this test's own request isn't hidden by it.
  await window.fill('#networkFilterText', '');
  await tab.evaluate((url) => fetch(url, { method: 'POST', body: '{"x":1}' }).catch(() => {}), targetUrl);

  const requestRow = window.locator('.evt.network-request', { hasText: '/api/resilience-method-check' });
  await expect(requestRow.first()).toBeVisible({ timeout: 10_000 });
  await expect(async () => {
    await requestRow.first().locator('.evt-ts').click({ timeout: 2_000 });
    await expect(window.locator('#detailResilienceBtn')).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });

  await window.locator('#detailResilienceBtn').click();
  await expect(window.locator('#resiliencePanel')).toBeVisible();
  await expect(window.locator('#resUrl')).toHaveValue(targetUrl);
  // Defaults for a one-click reproduction: 500 error, 100%.
  await expect(window.locator('#resType')).toHaveValue('error500');
  await expect(window.locator('#resProb')).toHaveValue('100');

  await window.click('.res-add-btn');
  const newRow = window.locator('.res-rule-row', { hasText: '/api/resilience-method-check' });
  await expect(newRow).toBeVisible();
  // The rule row shows the method it's scoped to (only when it isn't '*').
  await expect(newRow.locator('.res-method-badge')).toHaveText('POST');

  // Method scoping in effect: the same POST is degraded...
  const postStatus = await tab.evaluate(
    (url) => fetch(url, { method: 'POST', body: '{"x":1}' }).then(r => r.status),
    targetUrl
  );
  expect(postStatus).toBe(500);

  // ...but a GET to the exact same URL reaches the real fixture server
  // instead (a 404 from its static handler, per api.html's own fixture note
  // — not artificially failed by the rule).
  const getStatus = await tab.evaluate((url) => fetch(url).then(r => r.status), targetUrl);
  expect(getStatus).toBe(404);

  // Provenance: the request headers/body this rule was created from are
  // shown read-only in its edit view, not sent anywhere or matched against.
  await newRow.locator('.res-edit-btn').click();
  const editRow = window.locator('.res-rule-row-editing');
  await expect(editRow.locator('.res-provenance')).toBeVisible();
  await expect(editRow.locator('.res-provenance-body')).toHaveText('{"x":1}');
  await editRow.locator('.res-cancel-btn').click();
});

test('a broad-but-not-wildcard rule pattern under a heavy request burst, refresh and tab switch, does not crash the app (#210)', async () => {
  test.setTimeout(30_000);

  // "*ad*" is not the literal '*' _applyFetch()'s hasWildcard check
  // special-cases, but matches any URL containing "ad" as a substring —
  // this is the pattern shared by all three bug reports behind #210.
  await window.click('#consoleTabResilience');
  await window.selectOption('#resType', 'error500');
  await window.fill('#resUrl', '*ad*');
  await window.fill('#resProb', '100');
  await window.click('.res-add-btn');
  await expect(window.locator('.res-rule-row', { hasText: '*ad*' })).toBeVisible();

  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url('/performance/network-flood.html'));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, 'network-flood.html');
  await tab.waitForLoadState('load');

  const tabCountBefore = await window.locator('.tab').count();

  // Fire without awaiting completion, so the refresh below lands mid-flight —
  // the "refresh tears down CDP targets while a burst is still in flight"
  // half of #210's hypothesis, alongside the immediate tab switch.
  tab.evaluate(() => {
    document.querySelector('button[data-ad="1"]').click();
  }).catch(() => {});
  // #status is set synchronously inside the click handler, before any of the
  // 3000 fetches resolve — waiting for it proves the burst is genuinely in
  // flight rather than hoping a fixed delay was long enough.
  await expect(tab.locator('#status')).toHaveText(/firing 3000 requests/);

  await window.click('#reloadBtn');
  // Wait for the reload to actually start (loadingBar flips to "loading")
  // before switching sessions, so the switch lands mid-reload as intended.
  await expect(window.locator('#loadingBar')).toHaveClass(/loading/);
  await window.click('#newSessionBtn');
  await expect.poll(() => window.locator('.tab').count()).toBeGreaterThan(tabCountBefore);

  // The app process is still alive and IPC-responsive — not just that
  // `window` didn't throw, but that a real round-trip to the main process
  // still completes.
  const sessionCount = await window.evaluate(() => (window as any).testerBrowser.sessions.list().then((s: unknown[]) => s.length));
  expect(sessionCount).toBeGreaterThan(0);
  await expect(window.locator('#appName')).toBeVisible();
});

test('a rule with a quote/HTML-bearing URL pattern renders safely, and round-trips through IPC unchanged (#218)', async () => {
  const evilPattern = '*/q?x="a"&y=<b>';

  await window.click('#consoleTabResilience');
  await window.selectOption('#resType', 'error500');
  await window.fill('#resUrl', evilPattern);
  await window.fill('#resProb', '100');
  await window.click('.res-add-btn');

  const row = window.locator('.res-rule-row', { hasText: '/q?x=' });
  await expect(row.locator('.res-rule-url')).toHaveText(evilPattern);
  await expect(row.locator('.res-rule-url')).toHaveAttribute('title', evilPattern);
  await expect(row.locator('b')).toHaveCount(0);

  await row.locator('.res-edit-btn').click();
  const editRow = window.locator('.res-rule-row-editing');
  await expect(editRow.locator('.res-edit-url')).toHaveValue(evilPattern);
  await editRow.locator('.res-save-btn').click();

  const activeId = await window.locator('.tab.active').getAttribute('data-id');
  const rules: { urlPattern: string }[] = await window.evaluate(
    (id) => (window as any).testerBrowser.resilience.getRules(id), activeId);
  const savedRule = rules.find(r => r.urlPattern === evilPattern);
  expect(savedRule).toBeTruthy();
  expect(savedRule?.urlPattern).toBe(evilPattern);
});

test('a "hang" rule leaves the request pending until the client aborts it (#236)', async () => {
  const urlPath = '/network/api.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);

  await window.click('#consoleTabResilience');
  await window.selectOption('#resType', 'hang');
  await window.fill('#resUrl', '*/api/hang-target');
  await window.fill('#resProb', '100');
  await window.click('.res-add-btn');
  await expect(window.locator('.res-rule-row', { hasText: 'hang-target' })).toBeVisible();

  const result = await tab.evaluate(async (url) => {
    try {
      await fetch(url, { signal: (AbortSignal as any).timeout(2000) });
      return { name: null };
    } catch (err) {
      return { name: (err as Error).name };
    }
  }, fixtures.url('/api/hang-target'));
  expect(result.name).toBe('TimeoutError');
});

test('a "hang" rule with Release after (s) eventually fails the request on its own (#236)', async () => {
  const urlPath = '/network/api.html';
  const tab = await getTabPage(app, urlPath);

  await window.click('#consoleTabResilience');
  await window.selectOption('#resType', 'hang');
  await window.fill('#resUrl', '*/api/hang-release-target');
  await window.fill('#resProb', '100');
  await expect(window.locator('#resReleaseField')).toBeVisible();
  await window.fill('#resRelease', '1');
  await window.click('.res-add-btn');
  await expect(window.locator('.res-rule-row', { hasText: 'hang-release-target' })).toBeVisible();

  const result = await tab.evaluate(async (url) => {
    const start = Date.now();
    try {
      await fetch(url);
      return { ok: true, ms: Date.now() - start };
    } catch (err) {
      return { ok: false, name: (err as Error).name, ms: Date.now() - start };
    }
  }, fixtures.url('/api/hang-release-target'));
  expect(result.ok).toBe(false);
  expect(result.ms).toBeGreaterThanOrEqual(900);
  expect(result.ms).toBeLessThan(5_000);
});

test('a "stall504" rule waits latencyMs then returns 504 (#236)', async () => {
  const urlPath = '/network/api.html';
  const tab = await getTabPage(app, urlPath);

  await window.click('#consoleTabResilience');
  await window.selectOption('#resType', 'stall504');
  await window.fill('#resUrl', '*/api/stall-target');
  await window.fill('#resProb', '100');
  await window.fill('#resLatency', '1500');
  await window.click('.res-add-btn');
  await expect(window.locator('.res-rule-row', { hasText: 'stall-target' })).toBeVisible();

  await tab.fill('#apiPath', '/api/stall-target');
  const start = Date.now();
  await tab.click('#apiFetchBtn');
  await expect(tab.locator('#apiOut')).toContainText('"status":504', { timeout: 5_000 });
  expect(Date.now() - start).toBeGreaterThanOrEqual(1_400);
});

test('fall-through: a rule whose roll misses lets a later matching rule fire on the same request (#236)', async () => {
  const urlPath = '/network/api.html';
  const tab = await getTabPage(app, urlPath);

  await window.click('#consoleTabResilience');
  await window.selectOption('#resType', 'random500');
  await window.fill('#resUrl', '*/api/fallthrough-target');
  await window.fill('#resProb', '1');
  await window.click('.res-add-btn');

  await window.selectOption('#resType', 'error500');
  await window.fill('#resUrl', '*/api/fallthrough-target');
  await window.fill('#resProb', '100');
  await window.click('.res-add-btn');

  const rows = window.locator('.res-rule-row', { hasText: 'fallthrough-target' });
  await expect(rows).toHaveCount(2);

  for (let i = 0; i < 5; i++) {
    await tab.fill('#apiPath', '/api/fallthrough-target');
    await tab.click('#apiFetchBtn');
    await expect(tab.locator('#apiOut')).toContainText('"status":500', { timeout: 5_000 });
  }

  // Read hit counts straight from the main process instead of the rule
  // row's `.res-hits-badge` — the panel only repaints on its own 1.5s
  // auto-refresh interval or an explicit user action, so five fast fetches
  // in a row can easily finish (and this assertion can run) before a
  // single repaint has happened, making the badge read back "Hits: 0"
  // regardless of what actually matched server-side.
  const activeId = await window.locator('.tab.active').getAttribute('data-id');
  const rules: { urlPattern: string; type: string; probability: number; hitCount: number }[] =
    await window.evaluate((id) => (window as any).testerBrowser.resilience.getRules(id), activeId);
  const secondRule = rules.find(r => r.urlPattern === '*/api/fallthrough-target' && r.type === 'error500');
  expect(secondRule).toBeTruthy();
  // The 1% rule may fire rarely too, so this only asserts the 100% rule
  // caught nearly everything, not that it caught literally every hit.
  expect(secondRule?.hitCount).toBeGreaterThanOrEqual(4);
});

test('editing the URL after a "⇒ Resilience" prefill resets the method scope to Any (#236)', async () => {
  const urlPath = '/network/api.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);

  const targetUrl = fixtures.url('/api/resilience-reset-check');
  await window.click('#consoleTabNetwork');
  await window.click('#clearNetworkBtn');
  await window.fill('#networkFilterText', '');
  await tab.evaluate((url) => fetch(url, { method: 'POST', body: '{}' }).catch(() => {}), targetUrl);

  const requestRow = window.locator('.evt.network-request', { hasText: '/api/resilience-reset-check' });
  await expect(requestRow.first()).toBeVisible({ timeout: 10_000 });
  await expect(async () => {
    await requestRow.first().locator('.evt-ts').click({ timeout: 2_000 });
    await expect(window.locator('#detailResilienceBtn')).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await window.locator('#detailResilienceBtn').click();
  await expect(window.locator('#resMethodChip')).toBeVisible();

  await window.fill('#resUrl', '*/api/reset-elsewhere');
  await expect(window.locator('#resMethodChip')).toBeHidden();

  await window.click('.res-add-btn');
  const newRow = window.locator('.res-rule-row', { hasText: 'reset-elsewhere' });
  await expect(newRow).toBeVisible();
  await expect(newRow.locator('.res-method-badge')).toHaveCount(0);
});
