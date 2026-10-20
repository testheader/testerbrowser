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

  await window.click('#consoleTabNetwork');
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

test('one request is exactly one row, carrying status, method and path inline (#300)', async () => {
  await window.click('#clearNetworkBtn');
  const tab = await navigate('/network/status-codes.html');
  await window.click('#consoleTabNetwork');
  await tab.click('button:text-is("404")');

  // Status/timing merge into the request row itself once the response
  // arrives, rather than a separate response row (#189) — and a response
  // body is never a row of its own (#300).
  const reqRow = window.locator('.evt.network-request', { hasText: '/network/status/404' });
  await expect(reqRow).toHaveCount(1);
  await expect(reqRow).toBeVisible();

  await expect(reqRow.locator('.evt-line1 .evt-method')).toHaveText('GET');
  await expect(reqRow.locator('.evt-line1 .evt-status')).toHaveText('404');
  await expect(reqRow.locator('.evt-inline-url')).toContainText('/network/status/404');
  await expect(reqRow.locator('.evt-line2')).toHaveCount(0);
  await expect(window.locator('.evt.network-body')).toHaveCount(0);
  const h = await reqRow.evaluate(el => Math.round(el.getBoundingClientRect().height));
  expect(h).toBe(30);
});

test('the Network table has a header row, and status/method/name cells align down the list (#300)', async () => {
  await expect(window.locator('#timelinePanel .net-head')).toBeVisible();
  await expect(window.locator('#timelinePanel .net-head span')).toHaveText(['Status', 'Method', 'Name', 'Type', 'Size', 'Time']);

  for (const sel of ['.evt-status', '.evt-method', '.evt-inline-url']) {
    const lefts = await window.locator(`#timelinePanel .evt.network-request ${sel}`).evaluateAll(
      els => els.map(el => Math.round(el.getBoundingClientRect().left))
    );
    expect(lefts.length).toBeGreaterThan(1);
    for (const left of lefts) expect(left).toBe(lefts[0]);
  }
});

test('↑/↓ move the selected row and Enter opens its detail (#300)', async () => {
  await window.click('#consoleTabNetwork');
  await window.click('#clearNetworkBtn');
  const tab = await navigate('/network/status-codes.html');
  await tab.click('button:text-is("404")');
  const rows = window.locator('#timelinePanel .evt.network-request');
  await expect(async () => { expect(await rows.count()).toBeGreaterThan(1); }).toPass({ timeout: 10_000 });

  await window.locator('#timelinePanel').focus();
  await window.keyboard.press('ArrowUp');
  await expect(rows.last()).toHaveClass(/\bselected\b/);
  await window.keyboard.press('ArrowUp');
  const count = await rows.count();
  await expect(rows.nth(count - 2)).toHaveClass(/\bselected\b/);
  await expect(window.locator('#timelinePanel .evt.network-request.selected')).toHaveCount(1);

  await window.keyboard.press('Enter');
  await expect(window.locator('.detail-tab.active')).toBeVisible();
});

test('a request row still shows its duration once the response lands, and the panel still auto-scrolls to the newest event', async () => {
  await window.click('#consoleTabNetwork');
  await window.click('#clearNetworkBtn');
  const tab = await navigate('/network/slow.html');
  await tab.click('button[data-ms="500"]');

  const reqRow = window.locator('.evt.network-request', { hasText: 'ms=500' });
  await expect(reqRow).toBeVisible();
  await expect(reqRow.locator('.evt-duration')).toHaveText(/^(\d+ ms|\d+\.\d{2} s)$/);

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
