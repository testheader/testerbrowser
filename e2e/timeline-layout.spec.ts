/**
 * E2E tests for ticket #166 — two-line timeline rows with a hanging indent,
 * replacing the old per-row horizontal scrollbar.
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

  // This file's tests are all about body row rendering, which the Res pill
  // defaulting off (#176) would otherwise hide — turn it on once for the
  // whole file rather than per test. (Res now governs the response body row
  // rather than a separate response-metadata row — #189.)
  await window.click('#consoleTabNetwork');
  await window.click('#networkPills .filter-pill[data-type="network-response"]');
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

test('no event row has its own horizontal scrollbar', async () => {
  const longQuery = 'y'.repeat(3000);
  await navigate('/network/status-codes.html?' + longQuery);
  await window.click('#consoleTabNetwork');

  // Request rows (#178) are single line, URL truncated with an ellipsis
  // instead of wrapping or scrolling — the long query string in the URL
  // never grows the row's scrollWidth past its own visible width.
  const reqRow = window.locator('.evt.network-request', { hasText: 'y'.repeat(50) });
  await expect(reqRow).toBeVisible();
  const reqBox = await reqRow.evaluate(el => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }));
  expect(reqBox.scrollWidth).toBeLessThanOrEqual(reqBox.clientWidth + 1);
});

test('a long request URL truncates with an ellipsis instead of wrapping', async () => {
  const longQuery = 'z'.repeat(3000);
  await navigate('/network/status-codes.html?' + longQuery);
  await window.click('#consoleTabNetwork');

  const shortRow = window.locator('.evt.network-request').first();
  const longRow  = window.locator('.evt.network-request', { hasText: 'z'.repeat(50) });
  await expect(longRow).toBeVisible();

  // Same height as any other single-line request row — the long URL never
  // pushes the row taller the way it would if it wrapped onto a second line.
  const shortHeight = await shortRow.evaluate(el => el.getBoundingClientRect().height);
  const longHeight  = await longRow.evaluate(el => el.getBoundingClientRect().height);
  expect(longHeight).toBeCloseTo(shortHeight, 0);

  const urlSpan = longRow.locator('.evt-inline-url');
  await expect(urlSpan).toBeVisible();
  await expect(urlSpan).toHaveCSS('text-overflow', 'ellipsis');
  await expect(urlSpan).toHaveCSS('white-space', 'nowrap');
});

test('a request row renders as a single line with timestamp/method/status and the URL all inline', async () => {
  await window.click('#clearNetworkBtn');
  const tab = await navigate('/network/status-codes.html');
  await window.click('#consoleTabNetwork');
  await tab.click('button:text-is("404")');

  // Status/timing merge into the request row itself once the response
  // arrives, rather than a separate response row (#189).
  const reqRow = window.locator('.evt.network-request', { hasText: '/network/status/404' });
  await expect(reqRow).toBeVisible();

  await expect(reqRow.locator('.evt-line1')).toBeVisible();
  await expect(reqRow.locator('.evt-line1 .evt-ts')).toBeVisible();
  await expect(reqRow.locator('.evt-line1 .evt-method')).toHaveText('GET');
  await expect(reqRow.locator('.evt-line1 .evt-status')).toHaveText('404');
  await expect(reqRow.locator('.evt-inline-url')).toContainText('/network/status/404');

  // Single line: unlike a body/failed row, a request row never gets a line2.
  await expect(reqRow.locator('.evt-line2')).toHaveCount(0);
});

test('a BODY row\'s line 2 begins at the same horizontal column as the method on line 1', async () => {
  const tab = await navigate('/network/status-codes.html');
  await window.click('#consoleTabNetwork');
  await tab.click('button:text-is("200")');

  const row = window.locator('.evt.network-body').first();
  await expect(row).toBeVisible();

  const methodX = await row.locator('.evt-line1-rest').evaluate(el => el.getBoundingClientRect().left);
  const line2X  = await row.locator('.evt-line2').evaluate(el => el.getBoundingClientRect().left);
  expect(Math.abs(line2X - methodX)).toBeLessThanOrEqual(1);
});

test('timestamps, methods and status codes align vertically down the list', async () => {
  const tsLefts = await window.locator('#timelinePanel .evt .evt-ts').evaluateAll(
    els => els.map(el => el.getBoundingClientRect().left)
  );
  expect(tsLefts.length).toBeGreaterThan(1);
  for (const left of tsLefts) expect(left).toBe(tsLefts[0]);

  const methodLefts = await window.locator('#timelinePanel .evt .evt-line1-rest').evaluateAll(
    els => els.map(el => el.getBoundingClientRect().left)
  );
  for (const left of methodLefts) expect(left).toBe(methodLefts[0]);
});

test('a BODY row shows "BODY" as its method (not the underlying request method) and the response body on line 2', async () => {
  await window.click('#consoleTabNetwork');
  await window.click('#clearNetworkBtn');
  await navigate('/performance/network-flood.html');
  await (await getTabPage(app, '/performance/network-flood.html')).click('button[data-n="50"]');

  // Network flood's own page navigation produces a network-body row for the
  // HTML document itself — filter to a row whose body is actually the JSON
  // /perf/echo response this test cares about.
  const bodyRow = window.locator('.evt.network-body', { hasText: '"ok":true' }).first();
  await expect(bodyRow).toBeVisible({ timeout: 10_000 });
  await expect(bodyRow.locator('.evt-line1 .evt-method')).toHaveText('BODY');
  // The response body is JSON like {"ok":true,"i":"12"} — not the request URL.
  await expect(bodyRow.locator('.evt-line2')).toContainText('"ok":true');
});

test('a request row still shows its duration once the response lands, and the panel still auto-scrolls to the newest event', async () => {
  await window.click('#consoleTabNetwork');
  await window.click('#clearNetworkBtn');
  const tab = await navigate('/network/slow.html');
  await tab.click('button[data-ms="500"]');

  const reqRow = window.locator('.evt.network-request', { hasText: 'ms=500' });
  await expect(reqRow).toBeVisible();
  await expect(reqRow.locator('.evt-duration')).toHaveText(/^\d+ms$/);

  const panel = window.locator('#timelinePanel');
  const atBottom = await panel.evaluate(el => el.scrollTop + el.clientHeight >= el.scrollHeight - 5);
  expect(atBottom).toBe(true);
});

test('clicking a row still opens its detail tab, and Replay still works from there (#178)', async () => {
  await window.click('#consoleTabNetwork');
  await window.click('#clearNetworkBtn');
  const tab = await navigate('/network/status-codes.html');
  await tab.click('button:text-is("200")');

  const reqRow = window.locator('.evt.network-request', { hasText: '/network/status/200' }).first();
  await expect(reqRow).toBeVisible();
  await reqRow.click();
  await expect(window.locator('.detail-tab.active')).toBeVisible();

  await window.locator('#detailReplayBtn').click();
  await expect(window.locator('#replayOverlay')).toHaveClass(/open/);
});
