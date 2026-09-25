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
import fs from 'fs';
import os from 'os';
import path from 'path';
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

// Res defaults off (#176) — tests that specifically exercise response-row
// rendering need to turn it on themselves rather than relying on the old
// on-by-default behaviour.
async function ensureResPillOn() {
  const pill = window.locator('#networkPills .filter-pill[data-type="network-response"]');
  const classes = await pill.getAttribute('class');
  if (!classes?.includes('on')) await pill.click();
}

// ── Console ──────────────────────────────────────────────────────────────────

test('console/logs.html produces console events at every level', async () => {
  await navigate('/console/logs.html');
  await window.waitForTimeout(1_500); // pollTimeline runs every 1s

  const kinds = await window.locator('#timelinePanel .evt').evaluateAll(
    els => els.map(el => (el as HTMLElement).className)
  );
  expect(kinds.some(c => c.includes('console-error'))).toBe(true);
  // CDP reports console.warn() as type "warning", not "warn" — getConsoleLevel
  // normalizes that, so the row's class is console-warn, matching the Warn
  // filter pill's data-level and the CSS rule that actually colors it.
  expect(kinds.some(c => c.includes('console-warn') && !c.includes('console-warning'))).toBe(true);
});

test('console/logs.html: level pills filter the timeline, and Log-domain rows get level color-coding', async () => {
  await navigate('/console/logs.html');
  await window.click('#clearConsoleBtn');
  await window.waitForTimeout(200);
  await navigate('/console/logs.html');
  await window.waitForTimeout(1_500);

  // The missing <img> load is reported via Log.entryAdded (kind "log"), not
  // a console.* call — before this ticket, log-kind rows never got a level
  // class at all, so this specifically checks the fix, not just filtering.
  // (Chromium's Log entry text for a failed resource load doesn't include
  // the request URL, only the status — so match on the row's kind, not text.)
  const missingImgRow = window.locator('.evt.log').first();
  await expect(missingImgRow).toBeVisible();
  await expect(missingImgRow).toHaveClass(/console-error/);

  const errorCountBefore = await window.locator('.evt.console-error').count();
  expect(errorCountBefore).toBeGreaterThan(0);

  await window.locator('#consoleLevelPills .filter-pill[data-level="error"]').click();
  await expect(window.locator('.evt.console-error')).toHaveCount(0);
  // A non-error row (e.g. plain console.log on load) stays visible.
  await expect(window.locator('.evt.console-log', { hasText: 'page loaded' }).first()).toBeVisible();

  await window.locator('#consoleLevelPills .filter-pill[data-level="error"]').click();
  await expect(window.locator('.evt.console-error').first()).toBeVisible();
});

test('console/logs.html: an uncaught exception renders as a visually distinct row from console.error()', async () => {
  const tab = await navigate('/console/logs.html');
  await window.click('#clearConsoleBtn');
  await tab.click('button:text("throw uncaught exception")');
  await window.waitForTimeout(1_500);

  const exceptionRow = window.locator('.evt.exception', { hasText: 'uncaught exception test' });
  await expect(exceptionRow).toBeVisible();
  // Counted as an error for filtering purposes...
  await window.locator('#consoleLevelPills .filter-pill[data-level="error"]').click();
  await expect(exceptionRow).toHaveCount(0);
  await window.locator('#consoleLevelPills .filter-pill[data-level="error"]').click();
  // ...but rendered with its own class, not console-error's.
  await expect(exceptionRow).not.toHaveClass(/console-error/);
});

test('console/logs.html: a negative term in the free-text filter hides matching rows and keeps the rest (#170)', async () => {
  await window.click('#clearConsoleBtn');
  await window.waitForTimeout(200);
  await navigate('/console/logs.html');
  await window.waitForTimeout(1_500);

  const warnRow  = window.locator('.evt', { hasText: 'warn on load' });
  const errorRow = window.locator('.evt', { hasText: 'error on load' });
  await expect(warnRow).toBeVisible();
  await expect(errorRow).toBeVisible();

  await window.fill('#filterText', '-warn');
  await expect(warnRow).toHaveCount(0);
  await expect(errorRow).toBeVisible();

  // Positive and negative terms combine: keep rows containing "on load" that
  // do not also contain "error".
  await window.fill('#filterText', 'on load -error');
  await expect(errorRow).toHaveCount(0);
  await expect(warnRow).toBeVisible();

  // A lone "-" is literal text, not a negation — matches nothing here since
  // no summary contains a bare hyphen, so every row disappears.
  await window.fill('#filterText', '-');
  await expect(warnRow).toHaveCount(0);
  await expect(errorRow).toHaveCount(0);

  await window.fill('#filterText', '');
  await expect(warnRow).toBeVisible();
  await expect(errorRow).toBeVisible();
});

// ── Network ──────────────────────────────────────────────────────────────────

test('a request with a very long URL neither wraps nor scrolls horizontally — it stays single-line and truncates', async () => {
  const longQuery = 'x'.repeat(3000);
  await navigate('/network/status-codes.html?' + longQuery);
  await window.click('#consoleTabNetwork');
  await window.waitForTimeout(500);

  const row = window.locator('.evt.network-request', { hasText: 'x'.repeat(50) });
  await expect(row).toBeVisible();

  // Request rows are single-line (#178): the row never grows taller to fit
  // the URL, and never gains a horizontal scrollbar either — the URL just
  // truncates with an ellipsis. (#166's original regression this guarded —
  // wrapping onto additional lines — no longer applies to this row kind;
  // see e2e/timeline-layout.spec.ts for the body-row case, which still
  // wraps as #166 intended.)
  const box = await row.evaluate(el => ({
    height: el.getBoundingClientRect().height,
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }));
  expect(box.height).toBeLessThan(30);
  expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1);
  await expect(row.locator('.evt-inline-url')).toHaveCSS('text-overflow', 'ellipsis');
});

test('network/status-codes.html: a 404 shows up as a network event', async () => {
  const tab = await navigate('/network/status-codes.html');
  await window.click('#consoleTabNetwork');
  await tab.click('button:text-is("404")');
  await window.waitForTimeout(1_500);

  const resPill = window.locator('#networkPills .filter-pill[data-type="network-response"] .pill-count');
  await expect(resPill).not.toHaveText('');
});

test('network/status-codes.html: Res and Err pills default off, hiding those rows until toggled on', async () => {
  const resPillBtn = window.locator('#networkPills .filter-pill[data-type="network-response"]');
  const errPillBtn = window.locator('#networkPills .filter-pill[data-type="network-failed"]');
  await expect(resPillBtn).not.toHaveClass(/\bon\b/);
  await expect(errPillBtn).not.toHaveClass(/\bon\b/);

  const tab = await navigate('/network/status-codes.html');
  await window.click('#consoleTabNetwork');
  await window.click('#clearNetworkBtn');
  await tab.click('button:text-is("404")');
  await window.waitForTimeout(1_500);

  // Captured (the pill count reflects everything in the buffer)...
  const resPillCount = resPillBtn.locator('.pill-count');
  await expect(resPillCount).not.toHaveText('');
  // ...but not rendered while the pill is off — Res now governs the response
  // body row, not a separate response-metadata row (#189).
  await expect(window.locator('.evt.network-body')).toHaveCount(0);

  // Toggling it on shows the rows already in the buffer — nothing was dropped.
  await resPillBtn.click();
  await expect(window.locator('.evt.network-body', { hasText: '"status":404' })).toBeVisible();

  // Toggling back off round-trips cleanly.
  await resPillBtn.click();
  await expect(window.locator('.evt.network-body')).toHaveCount(0);
});

test('network/status-codes.html: timeline rows show a time-only, date-free timestamp', async () => {
  const tab = await navigate('/network/status-codes.html');
  await window.click('#consoleTabNetwork');
  await ensureResPillOn();
  await tab.click('button:text-is("404")');
  await window.waitForTimeout(1_500);

  const bodyRow = window.locator('.evt.network-body', { hasText: '"status":404' }).first();
  await expect(bodyRow).toBeVisible();
  await expect(bodyRow.locator('.evt-ts')).toHaveText(/^\[\d{2}:\d{2}:\d{2}\]$/);
  await expect(bodyRow.locator('.evt-ts-date')).toHaveCount(0);
});

test('network/status-codes.html: Clear button empties the log and it stays empty on the next poll', async () => {
  const tab = await navigate('/network/status-codes.html');
  await window.click('#consoleTabNetwork');
  await tab.click('button:text-is("404")');
  await window.waitForTimeout(1_500);

  const resPill = window.locator('#networkPills .filter-pill[data-type="network-response"] .pill-count');
  await expect(resPill).not.toHaveText('');

  await window.click('#clearNetworkBtn');
  await expect(window.locator('.evt.network-request, .evt.network-body')).toHaveCount(0);
  await expect(resPill).toHaveText('');

  // pollTimeline runs every 1s — the bug re-fetched everything from the
  // backend ring buffer on the next tick because Clear reset the polling
  // cursor back to 0, dropping the `since` filter.
  await window.waitForTimeout(1_500);
  await expect(window.locator('.evt.network-request, .evt.network-body')).toHaveCount(0);
  await expect(resPill).toHaveText('');
});

test('network/status-codes.html: HAR button exports a valid HAR 1.2 file with a 200 entry for the page load (#232)', async () => {
  const tmpPath = path.join(os.tmpdir(), `testerbrowser-e2e-har-${Date.now()}.har`);
  // autoUpdater-style stubbing isn't available here (this isn't an
  // ipcMain.handle route) — replace dialog.showSaveDialog itself in the main
  // process, per the ticket's own suggested technique.
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath });
  }, tmpPath);

  await navigate('/network/status-codes.html');
  await window.waitForTimeout(1_500); // pollTimeline runs every 1s

  // #harExportBtn lives in the Console sub-tab's own toolbar (#consoleControls,
  // next to Clear), not the Network sub-tab's — recording:exportHar reads
  // every stored row straight from the recorder regardless of which sub-tab
  // is showing. An earlier test in this file leaves Network active, so
  // switch back explicitly rather than assuming Console's own default.
  await window.click('#consoleTabConsole');
  await expect(window.locator('#harExportBtn')).toBeVisible();
  await window.click('#harExportBtn');
  await expect(window.locator('#harExportStatus')).toHaveText(/Saved/, { timeout: 10_000 });

  const har = JSON.parse(fs.readFileSync(tmpPath, 'utf-8'));
  expect(har.log.version).toBe('1.2');
  const entry = har.log.entries.find(
    (e: { request: { url: string }; response: { status: number } }) =>
      e.request.url.includes('status-codes.html') && e.response.status === 200
  );
  expect(entry).toBeTruthy();

  fs.rmSync(tmpPath, { force: true });
});

test('network/status-codes.html: Copy as cURL copies a curl command for the selected request to the clipboard (#232)', async () => {
  const urlPath = '/network/status-codes.html';
  await window.click('#consoleTabNetwork');
  await window.click('#clearNetworkBtn');
  await navigate(urlPath);
  await window.waitForTimeout(1_500); // pollTimeline runs every 1s

  const requestRow = window.locator('.evt.network-request', { hasText: urlPath });
  await expect(requestRow.first()).toBeVisible({ timeout: 10_000 });

  const curlBtn = window.locator('#detailCurlBtn');
  await expect(async () => {
    await requestRow.first().locator('.evt-ts').click({ timeout: 2_000 });
    await expect(curlBtn).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await curlBtn.click();

  const clipboardText = await app.evaluate(({ clipboard }) => clipboard.readText());
  expect(clipboardText.startsWith("curl '")).toBe(true);
  expect(clipboardText).toContain(fixtures.url(urlPath));
});

test('network/slow.html: free-text filter also matches payload content not present in the summary line', async () => {
  const tab = await navigate('/network/slow.html');
  await window.click('#consoleTabNetwork');
  await window.click('#clearNetworkBtn');
  await tab.click('button[data-ms="500"]');
  await window.waitForTimeout(700);

  const row = window.locator('.evt.network-request', { hasText: 'ms=500' });
  await expect(row).toBeVisible();

  // "frameId" is a CDP request payload field recorded with every request —
  // present in the row's underlying JSON but never rendered in the row itself.
  await window.fill('#networkFilterText', 'frameid');
  await expect(row).toBeVisible();

  await window.fill('#networkFilterText', 'no-such-substring-anywhere');
  await expect(row).toHaveCount(0);

  await window.fill('#networkFilterText', '');
});

test('network/slow.html: min-duration filter hides fast requests but keeps slow ones', async () => {
  const tab = await navigate('/network/slow.html');
  await window.click('#consoleTabNetwork');
  await window.click('#clearNetworkBtn');
  await tab.click('button[data-ms="500"]');
  await window.waitForTimeout(700);
  await tab.click('button[data-ms="2000"]');
  await window.waitForTimeout(2500);

  const row500  = window.locator('.evt.network-request', { hasText: 'ms=500'  });
  const row2000 = window.locator('.evt.network-request', { hasText: 'ms=2000' });
  await expect(row500).toBeVisible();
  await expect(row2000).toBeVisible();

  // Duration now lives on the request row itself, merged in once its
  // response arrives (#189) — filtering by it hides the whole row.
  await window.fill('#networkMinDuration', '1000');
  await expect(row500).toHaveCount(0);
  await expect(row2000).toBeVisible();

  await window.fill('#networkMinDuration', '');
  await expect(row500).toBeVisible();
});

test('network/slow.html: request rows show a duration column once the response lands, staying visible without scrolling', async () => {
  const tab = await navigate('/network/slow.html');
  await window.click('#consoleTabNetwork');
  await window.click('#clearNetworkBtn');
  await tab.click('button[data-ms="500"]');
  await window.waitForTimeout(700);

  const reqRow = window.locator('.evt.network-request', { hasText: 'ms=500' });
  await expect(reqRow).toBeVisible();
  await expect(reqRow.locator('.evt-duration')).toHaveText(/^\d+ms$/);

  // The duration cell sits outside the row's scrollable text region, so its
  // right edge stays within the panel's own visible width — no scrolling
  // needed to see it, even though the row's text can overflow further left.
  const panelWidth = await window.locator('#timelinePanel').evaluate(el => el.clientWidth);
  const durationRight = await reqRow.locator('.evt-duration').evaluate(el => el.getBoundingClientRect().right);
  const panelLeft = await window.locator('#timelinePanel').evaluate(el => el.getBoundingClientRect().left);
  expect(durationRight - panelLeft).toBeLessThanOrEqual(panelWidth);
});

test('network/slow.html: method filter hides the request row for that method', async () => {
  const tab = await navigate('/network/slow.html');
  await window.click('#consoleTabNetwork');
  await window.click('#clearNetworkBtn');
  await tab.click('button[data-ms="500"]');
  await window.waitForTimeout(700);

  const reqRow = window.locator('.evt.network-request', { hasText: 'ms=500' });
  await expect(reqRow).toBeVisible();

  const getPill = window.locator('#networkMethodPills .filter-pill[data-method="GET"]');
  await getPill.click(); // turn GET off — the fixture only issues GET requests
  await expect(reqRow).toHaveCount(0);

  await getPill.click(); // back on
  await expect(reqRow).toBeVisible();
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

// #229: the recorder cap only applies to tabs opened after a settings
// change (out of scope: re-capping an already-open tab), so this opens its
// own fresh tab via #newSessionBtn rather than reusing navigate()'s shared
// one — every other test in this file navigates that one shared tab.
test('performance/console-flood.html: exceeding a low recorder cap shows the timeline eviction banner', async () => {
  await window.evaluate(() => (window as any).testerBrowser.settings.set({ recorderMaxEvents: 1000 }));

  await window.click('#newSessionBtn');
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url('/performance/console-flood.html'));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, '/performance/console-flood.html');

  await tab.click('button:text("10,000 logs")');

  // pollRecordingStatus() polls recording:status every 1s independent of
  // the timeline's own (much slower, for 10k rows) event replication — the
  // banner shows as soon as the backend cap is first exceeded, not once the
  // renderer has caught up on every event.
  await expect(window.locator('.timeline-eviction-banner')).toContainText(
    'Older events were evicted', { timeout: 15_000 }
  );
  await expect(window.locator('.timeline-eviction-banner')).toContainText('1000 events');

  // Reset for later tests in this file.
  await window.evaluate(() => (window as any).testerBrowser.settings.set({ recorderMaxEvents: 20000 }));
});

// ── Downloads ────────────────────────────────────────────────────────────────

// #247: autoOpenDownloadsPanel defaults to false — a download no longer
// force-opens the panel and narrows the active page mid-test. The button
// gets an unseen-download badge instead, and the row names the tab it
// came from once the panel is opened manually.
test('downloads/index.html: with auto-open off (default), a download does not force-open the panel — the badge shows, and the row names the originating tab', async () => {
  await window.evaluate(() => (window as any).testerBrowser.settings.set({ autoOpenDownloadsPanel: false }));
  if (await window.locator('#downloadsPanel').evaluate((el) => el.classList.contains('open'))) {
    await window.click('#downloadsBtn'); // start from closed
  }

  const tab = await navigate('/downloads/index.html');
  // Whichever tab is actually active/downloading — not assumed to be
  // sessions[0], since earlier tests in this shared-window file may have
  // left more than one tab open or renamed the original.
  const activeName = await window.evaluate(() => {
    const activeTab = document.querySelector('.tab.active');
    return activeTab ? activeTab.querySelector('.tab-name')?.textContent ?? '' : '';
  });
  await tab.click('a[href*="small.txt"] button');
  await window.waitForTimeout(1_500);

  await expect(window.locator('#downloadsPanel')).not.toHaveClass(/open/);
  await expect(window.locator('#downloadsBadge')).toBeVisible();

  await window.click('#downloadsBtn');
  await expect(window.locator('#downloadsPanel')).toHaveClass(/open/);
  // Electron appends "(1)" etc. if a same-named file already exists in the
  // downloads folder, so match loosely rather than asserting the exact name.
  await expect(window.locator('#downloadsList')).toContainText(/small.*\.txt/);
  await expect(window.locator('#downloadsList')).toContainText(activeName);
});

// #247: regression check that the old always-auto-open behavior is still
// reachable via the setting, for testers who want it back.
test('downloads/index.html: with auto-open on, a download does force-open the panel', async () => {
  await window.click('#downloadsBtn'); // close the panel left open by the previous test
  await window.evaluate(() => (window as any).testerBrowser.settings.set({ autoOpenDownloadsPanel: true }));

  const tab = await navigate('/downloads/index.html');
  await tab.click('a[href*="small.txt"] button');
  await expect(window.locator('#downloadsPanel')).toHaveClass(/open/, { timeout: 5_000 });

  // Reset for any later test in this file that assumes the default.
  await window.evaluate(() => (window as any).testerBrowser.settings.set({ autoOpenDownloadsPanel: false }));
  await window.click('#downloadsBtn');
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
