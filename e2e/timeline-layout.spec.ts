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
  await window.waitForTimeout(500);

  const row = window.locator('.evt.network-request', { hasText: 'y'.repeat(50) });
  await expect(row).toBeVisible();

  const line2Box = await row.locator('.evt-line2').evaluate(el => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }));
  expect(line2Box.scrollWidth).toBeLessThanOrEqual(line2Box.clientWidth + 1);
});

test('a row renders as two visual lines: line 1 has timestamp/method/status, line 2 has the URL', async () => {
  await window.click('#clearNetworkBtn');
  const tab = await navigate('/network/status-codes.html');
  await window.click('#consoleTabNetwork');
  await tab.click('button:text-is("404")');
  await window.waitForTimeout(1_500);

  const resRow = window.locator('.evt.network-response', { hasText: '/network/status/404' });
  await expect(resRow).toBeVisible();

  await expect(resRow.locator('.evt-line1')).toBeVisible();
  await expect(resRow.locator('.evt-line1 .evt-ts')).toBeVisible();
  await expect(resRow.locator('.evt-line1 .evt-method')).toHaveText('GET');
  await expect(resRow.locator('.evt-line1 .evt-status')).toHaveText('404');
  await expect(resRow.locator('.evt-line2')).toContainText('/network/status/404');

  // Line 1 and line 2 are genuinely on different visual lines.
  const line1Box = await resRow.locator('.evt-line1').boundingBox();
  const line2Box = await resRow.locator('.evt-line2').boundingBox();
  expect(line2Box!.y).toBeGreaterThan(line1Box!.y);
});

test('line 2 begins at the same horizontal column as the method on line 1', async () => {
  const tab = await navigate('/network/status-codes.html');
  await window.click('#consoleTabNetwork');
  await tab.click('button:text-is("200")');
  await window.waitForTimeout(1_500);

  const row = window.locator('.evt.network-response', { hasText: '/network/status/200' }).first();
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
  await window.waitForTimeout(2_000);

  // Network flood's own page navigation produces a network-body row for the
  // HTML document itself — filter to a row whose body is actually the JSON
  // /perf/echo response this test cares about.
  const bodyRow = window.locator('.evt.network-body', { hasText: '"ok":true' }).first();
  await expect(bodyRow).toBeVisible({ timeout: 10_000 });
  await expect(bodyRow.locator('.evt-line1 .evt-method')).toHaveText('BODY');
  // The response body is JSON like {"ok":true,"i":"12"} — not the request URL.
  await expect(bodyRow.locator('.evt-line2')).toContainText('"ok":true');
});

test('a response row still shows its duration, and the panel still auto-scrolls to the newest event', async () => {
  await window.click('#consoleTabNetwork');
  await window.click('#clearNetworkBtn');
  const tab = await navigate('/network/slow.html');
  await tab.click('button[data-ms="500"]');
  await window.waitForTimeout(700);

  const resRow = window.locator('.evt.network-response', { hasText: 'ms=500' });
  await expect(resRow).toBeVisible();
  await expect(resRow.locator('.evt-duration')).toHaveText(/^\d+ms$/);

  const panel = window.locator('#timelinePanel');
  const atBottom = await panel.evaluate(el => el.scrollTop + el.clientHeight >= el.scrollHeight - 5);
  expect(atBottom).toBe(true);
});

test('clicking a row still opens its detail tab, and the Replay button still works on request rows', async () => {
  await window.click('#consoleTabNetwork');
  await window.click('#clearNetworkBtn');
  const tab = await navigate('/network/status-codes.html');
  await tab.click('button:text-is("200")');
  await window.waitForTimeout(1_500);

  const reqRow = window.locator('.evt.network-request', { hasText: '/network/status/200' }).first();
  await expect(reqRow).toBeVisible();
  await reqRow.locator('.evt-ts').click();
  await expect(window.locator('.detail-tab.active')).toBeVisible();

  await reqRow.locator('.evt-replay-btn').click();
  await expect(window.locator('#replayOverlay')).toHaveClass(/open/);
});
