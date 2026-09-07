/**
 * Smoke tests for the test-pages/ fixtures, served by the shared fixture
 * server (e2e/fixtures/server.ts). These exist to prove the fixture pages
 * actually exercise the app features they're named for, so the fixtures
 * don't silently rot.
 *
 * Each tab is its own WebContentsView (a separate Playwright Page from the
 * chrome window) — see getTabPage in helpers.ts. Anything the fixture page
 * itself renders must be driven through that page, not through `window`.
 */
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

async function navigate(urlPath: string): Promise<Page> {
  const url = fixtures.url(urlPath);
  await window.click('#urlbar');
  await window.fill('#urlbar', url);
  await window.press('#urlbar', 'Enter');
  return getTabPage(app, urlPath);
}

// ── Console ──────────────────────────────────────────────────────────────────

test('console/logs.html produces console events at every level', async () => {
  await navigate('/console/logs.html');
  await window.waitForTimeout(1_500); // pollTimeline runs every 1s

  const kinds = await window.locator('#timelinePanel .evt').evaluateAll(
    els => els.map(el => (el as HTMLElement).className)
  );
  expect(kinds.some(c => c.includes('console-error'))).toBe(true);
  expect(kinds.some(c => c.includes('console-warning'))).toBe(true);
});

// ── Network ──────────────────────────────────────────────────────────────────

test('a request with a very long URL stays a single line and scrolls horizontally instead of wrapping', async () => {
  const longQuery = 'x'.repeat(3000);
  await navigate('/network/status-codes.html?' + longQuery);
  await window.click('#consoleTabNetwork');
  await window.waitForTimeout(500);

  const row = window.locator('.evt.network-request', { hasText: 'x'.repeat(50) });
  await expect(row).toBeVisible();

  const box = await row.evaluate(el => ({
    height:      el.getBoundingClientRect().height,
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }));
  expect(box.height).toBeLessThan(40);
  expect(box.scrollWidth).toBeGreaterThan(box.clientWidth + 100);
});

test('network/status-codes.html: a 404 shows up as a network event', async () => {
  const tab = await navigate('/network/status-codes.html');
  await window.click('#consoleTabNetwork');
  await tab.click('button:text-is("404")');
  await window.waitForTimeout(1_500);

  const resPill = window.locator('#networkPills .filter-pill[data-type="network-response"] .pill-count');
  await expect(resPill).not.toHaveText('');
});

test('network/status-codes.html: Clear button empties the log and it stays empty on the next poll', async () => {
  const tab = await navigate('/network/status-codes.html');
  await window.click('#consoleTabNetwork');
  await tab.click('button:text-is("404")');
  await window.waitForTimeout(1_500);

  const resPill = window.locator('#networkPills .filter-pill[data-type="network-response"] .pill-count');
  await expect(resPill).not.toHaveText('');

  await window.click('#clearNetworkBtn');
  await expect(window.locator('.evt.network-request, .evt.network-response')).toHaveCount(0);
  await expect(resPill).toHaveText('');

  // pollTimeline runs every 1s — the bug re-fetched everything from the
  // backend ring buffer on the next tick because Clear reset the polling
  // cursor back to 0, dropping the `since` filter.
  await window.waitForTimeout(1_500);
  await expect(window.locator('.evt.network-request, .evt.network-response')).toHaveCount(0);
  await expect(resPill).toHaveText('');
});

test('network/slow.html: free-text filter also matches payload content not present in the summary line', async () => {
  const tab = await navigate('/network/slow.html');
  await window.click('#consoleTabNetwork');
  await window.click('#clearNetworkBtn');
  await tab.click('button[data-ms="500"]');
  await window.waitForTimeout(700);

  const row = window.locator('.evt.network-response', { hasText: 'ms=500' });
  await expect(row).toBeVisible();

  // "text/plain" is the response's content-type header — present in the
  // recorded payload JSON, but not in the row's rendered summary text.
  await window.fill('#networkFilterText', 'text/plain');
  await expect(row).toBeVisible();

  await window.fill('#networkFilterText', 'no-such-substring-anywhere');
  await expect(row).toHaveCount(0);

  await window.fill('#networkFilterText', '');
});

test('network/slow.html: min-duration filter hides fast responses but keeps slow ones', async () => {
  const tab = await navigate('/network/slow.html');
  await window.click('#consoleTabNetwork');
  await window.click('#clearNetworkBtn');
  await tab.click('button[data-ms="500"]');
  await window.waitForTimeout(700);
  await tab.click('button[data-ms="2000"]');
  await window.waitForTimeout(2500);

  const row500  = window.locator('.evt.network-response', { hasText: 'ms=500'  });
  const row2000 = window.locator('.evt.network-response', { hasText: 'ms=2000' });
  await expect(row500).toBeVisible();
  await expect(row2000).toBeVisible();

  // Only network-response rows carry a duration — the request row for the
  // 500ms call must stay visible even while its response is filtered out.
  await window.fill('#networkMinDuration', '1000');
  await expect(row500).toHaveCount(0);
  await expect(row2000).toBeVisible();
  await expect(window.locator('.evt.network-request', { hasText: 'ms=500' })).toBeVisible();

  await window.fill('#networkMinDuration', '');
  await expect(row500).toBeVisible();
});

test('network/slow.html: method filter hides both the request and response rows for that method', async () => {
  const tab = await navigate('/network/slow.html');
  await window.click('#consoleTabNetwork');
  await window.click('#clearNetworkBtn');
  await tab.click('button[data-ms="500"]');
  await window.waitForTimeout(700);

  const reqRow = window.locator('.evt.network-request',  { hasText: 'ms=500' });
  const resRow = window.locator('.evt.network-response', { hasText: 'ms=500' });
  await expect(reqRow).toBeVisible();
  await expect(resRow).toBeVisible();

  const getPill = window.locator('#networkMethodPills .filter-pill[data-method="GET"]');
  await getPill.click(); // turn GET off — the fixture only issues GET requests
  await expect(reqRow).toHaveCount(0);
  await expect(resRow).toHaveCount(0);

  await getPill.click(); // back on
  await expect(reqRow).toBeVisible();
  await expect(resRow).toBeVisible();
});

test('network/slow.html: date-range "from" filter hides events before the chosen time', async () => {
  const tab = await navigate('/network/slow.html');
  await window.click('#consoleTabNetwork');
  await window.click('#clearNetworkBtn');
  await tab.click('button[data-ms="500"]');
  await window.waitForTimeout(700);

  const row = window.locator('.evt.network-response', { hasText: 'ms=500' });
  await expect(row).toBeVisible();

  const future = new Date(Date.now() + 5 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const futureLocal = `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}` +
    `T${pad(future.getHours())}:${pad(future.getMinutes())}:${pad(future.getSeconds())}`;
  await window.fill('#networkFromTs', futureLocal);
  await expect(row).toHaveCount(0);

  await window.fill('#networkFromTs', '');
  await expect(row).toBeVisible();
});

test('performance/network-flood.html: burst of 50 requests all get recorded', async () => {
  const tab = await navigate('/performance/network-flood.html');
  await window.click('#consoleTabNetwork');
  await tab.click('button:text("50 concurrent requests")');
  // Give the burst + poll cycle time to land.
  await window.waitForTimeout(3_000);

  const reqPillText = await window
    .locator('#networkPills .filter-pill[data-type="network-request"] .pill-count')
    .textContent();
  expect(Number(reqPillText)).toBeGreaterThanOrEqual(50);
});

// ── Downloads ────────────────────────────────────────────────────────────────

test('downloads/index.html: generated file download appears in the downloads list', async () => {
  const tab = await navigate('/downloads/index.html');
  await tab.click('a[href*="small.txt"] button');
  await window.waitForTimeout(1_500);
  await window.click('#downloadsBtn');

  // Electron appends "(1)" etc. if a same-named file already exists in the
  // downloads folder, so match loosely rather than asserting the exact name.
  await expect(window.locator('#downloadsList')).toContainText(/small.*\.txt/);
});

// ── Storage ──────────────────────────────────────────────────────────────────

test('storage/localstorage.html: seeded keys appear in the Storage tab', async () => {
  const tab = await navigate('/storage/localstorage.html');
  await tab.click('button:text("Seed 3 keys")');
  await window.click('#consoleTabStorage');
  await window.click('#refreshStorageBtn');
  await window.waitForTimeout(500);

  await expect(window.locator('#storagePanel')).toContainText('username');
  await expect(window.locator('#storagePanel')).toContainText('tester');
});

// ── Permissions ──────────────────────────────────────────────────────────────

test('permissions page triggers a permission notification', async () => {
  const tab = await navigate('/permissions/index.html');
  await tab.click('#notif');
  await expect(window.locator('#permissionNotifications')).not.toBeEmpty();
  // Dismiss it — window is shared across tests in this file, and a
  // lingering notification would throw off the next test's assumptions.
  await window.locator('.perm-notif .perm-block').first().click();
  await expect(window.locator('.perm-notif')).toHaveCount(0);
});

test('permission notification reserves BrowserView space instead of sitting under it, and Allow works', async () => {
  const tab = await navigate('/permissions/index.html');

  const barBefore = await window.evaluate(() =>
    document.getElementById('permissionNotifications').getBoundingClientRect().height);
  expect(barBefore).toBe(0);

  await tab.click('#geo');
  const notif = window.locator('.perm-notif').first();
  await expect(notif).toBeVisible();

  // The notification only avoids the BrowserView if the topbar/BrowserView
  // split actually grew to make room for it — a plain CSS z-index bump
  // wouldn't do that, since the BrowserView is a separate native layer.
  const barAfter = await window.evaluate(() =>
    document.getElementById('permissionNotifications').getBoundingClientRect().height);
  expect(barAfter).toBeGreaterThan(0);

  await notif.locator('.perm-allow').click();
  await expect(window.locator('.perm-notif')).toHaveCount(0);

  const barCleared = await window.evaluate(() =>
    document.getElementById('permissionNotifications').getBoundingClientRect().height);
  expect(barCleared).toBe(0);
});
