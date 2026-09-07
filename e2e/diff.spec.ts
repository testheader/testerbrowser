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

test('Diff tab button is present', async () => {
  await expect(window.locator('#consoleTabDiff')).toBeVisible();
});

test('clicking Diff tab shows diffPanel', async () => {
  await window.locator('#consoleTabDiff').click();
  await expect(window.locator('#diffPanel')).toBeVisible();
});

test('diffPanel contains session pickers A and B', async () => {
  await window.locator('#consoleTabDiff').click();
  // initDiff populates pickers on first click; wait briefly
  await window.waitForTimeout(200);
  await expect(window.locator('#diffPickA')).toBeAttached();
  await expect(window.locator('#diffPickB')).toBeAttached();
});

test('diffPanel contains a Run diff button', async () => {
  await window.locator('#consoleTabDiff').click();
  await window.waitForTimeout(200);
  await expect(window.locator('#diffRunBtn')).toBeAttached();
});

test('diffPanel contains a HAR export button', async () => {
  await window.locator('#consoleTabDiff').click();
  await window.waitForTimeout(200);
  await expect(window.locator('#diffHarBtn')).toBeAttached();
});

test('comparing two sessions categorizes matching and unique requests correctly', async () => {
  // Deliberately navigation-only (no post-load button clicks): a fetch
  // triggered by clicking a button on a second, non-default session has
  // proven unreliable to drive from here, in a way a plain page load isn't —
  // the page load itself already produces a real, recordable network event.
  const sharedPath = '/network/status-codes.html';
  const onlyAPath = '/downloads/sample.txt';

  const sessions = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const sessionAId = sessions[0].id;

  await window.evaluate((id: string) => (window as any).testerBrowser.sessions.switchTo(id), sessionAId);
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(sharedPath));
  await window.press('#urlbar', 'Enter');
  await (await getTabPage(app, sharedPath)).waitForLoadState('load');

  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(onlyAPath));
  await window.press('#urlbar', 'Enter');
  await (await getTabPage(app, onlyAPath)).waitForLoadState('load');

  await window.click('#newSessionBtn');
  const allSessions = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const sessionBId = allSessions.find((s: { id: string }) => s.id !== sessionAId).id;

  await window.evaluate((id: string) => (window as any).testerBrowser.sessions.switchTo(id), sessionBId);
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(sharedPath));
  await window.press('#urlbar', 'Enter');
  await (await getTabPage(app, sharedPath)).waitForLoadState('load');

  await window.click('#consoleTabDiff');
  await window.selectOption('#diffPickA', sessionAId);
  await window.selectOption('#diffPickB', sessionBId);
  await window.click('#diffRunBtn');

  // Both sessions loaded status-codes.html → same. Only session A loaded sample.txt.
  await expect(window.locator('.diff-row.same', { hasText: '/network/status-codes.html' })).toBeVisible();
  await expect(window.locator('.diff-row.only-a', { hasText: '/downloads/sample.txt' })).toBeVisible();
});

test('diff shows which sessions (by name) were compared and when', async () => {
  const sessions = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  await window.selectOption('#diffPickA', sessions[0].id);
  await window.selectOption('#diffPickB', sessions[1].id);
  await window.click('#diffRunBtn');

  const meta = window.locator('.diff-meta');
  await expect(meta).toBeVisible();
  await expect(meta).toContainText(sessions[0].name);
  await expect(meta).toContainText(sessions[1].name);
});

test('category pills filter the table while the legend keeps showing totals', async () => {
  await expect(window.locator('.diff-row')).not.toHaveCount(0);
  const sameCountBefore = await window.locator('.diff-row.same').count();
  expect(sameCountBefore).toBeGreaterThan(0);

  await window.locator('#diffCatPills .filter-pill[data-cat="same"]').click();
  await expect(window.locator('.diff-row.same')).toHaveCount(0);
  // Legend badge count is unaffected by the pill filter.
  await expect(window.locator('.diff-badge.same')).toContainText(String(sameCountBefore));

  await window.locator('#diffCatPills .filter-pill[data-cat="same"]').click();
  await expect(window.locator('.diff-row.same')).toHaveCount(sameCountBefore);
});

test('Reset clears the comparison back to its initial state and disables HAR export', async () => {
  await expect(window.locator('.diff-row')).not.toHaveCount(0);
  await expect(window.locator('#diffHarBtn')).not.toBeDisabled();

  await window.click('#diffResetBtn');

  await expect(window.locator('.diff-hint')).toHaveText('Select two sessions above and click Compare.');
  await expect(window.locator('.diff-row')).toHaveCount(0);
  await expect(window.locator('.diff-meta')).toHaveCount(0);
  await expect(window.locator('#diffHarBtn')).toBeDisabled();
});
