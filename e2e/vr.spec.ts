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

test('VR tab button is present', async () => {
  await expect(window.locator('#consoleTabVR')).toBeVisible();
});

test('clicking VR tab shows the VR panel', async () => {
  await window.click('#consoleTabVR');
  await expect(window.locator('#vrPanel')).toBeVisible();
});

test('VR tab is marked active after click', async () => {
  await window.click('#consoleTabVR');
  await expect(window.locator('#consoleTabVR')).toHaveClass(/active/);
});

test('VR panel contains Capture baseline button', async () => {
  await window.click('#consoleTabVR');
  await expect(window.locator('#vrCaptureBtn')).toBeVisible();
  await expect(window.locator('#vrCaptureBtn')).toHaveText('Capture baseline');
});

test('Compare button is disabled before baseline is captured', async () => {
  await window.click('#consoleTabVR');
  await expect(window.locator('#vrCompareBtn')).toBeDisabled();
});

test('the "Compare against" picker sits between Capture baseline and Compare, and view buttons are on their own row', async () => {
  await window.click('#consoleTabVR');
  const rows = window.locator('.vr-toolbar-row');
  await expect(rows).toHaveCount(2);

  const captureRow = rows.nth(0);
  await expect(captureRow).toContainText('Capture');
  const captureRowElements = captureRow.locator('#vrCaptureBtn, #vrComparePick, #vrCompareBtn');
  await expect(captureRowElements).toHaveCount(3);
  // Order within the row: capture button, then the compare-against picker, then Compare.
  const ids = await captureRow.locator('button, select').evaluateAll(els => els.map(el => el.id));
  expect(ids.indexOf('vrCaptureBtn')).toBeLessThan(ids.indexOf('vrComparePick'));
  expect(ids.indexOf('vrComparePick')).toBeLessThan(ids.indexOf('vrCompareBtn'));

  const viewRow = rows.nth(1);
  await expect(viewRow).toContainText('View');
  await expect(viewRow.locator('#vrViews')).toBeVisible();
});

test('capturing a baseline, mutating the page, and comparing reports a nonzero diff', async () => {
  const urlPath = '/performance/heavy-dom.html?count=50';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, 'heavy-dom.html');

  await window.click('#consoleTabVR');
  await window.click('#vrCaptureBtn');
  await expect(window.locator('#vrStats')).toContainText('Baseline captured', { timeout: 10_000 });

  await tab.click('#render');

  await window.click('#vrCompareBtn');
  await expect(window.locator('#vrStats')).toContainText('pixels differ', { timeout: 15_000 });

  const statsText = (await window.locator('#vrStats').textContent()) || '';
  const match = statsText.match(/^([\d,]+) pixels differ/);
  expect(match).toBeTruthy();
  expect(Number(match![1].replace(/,/g, ''))).toBeGreaterThan(0);
});

test('comparing against a different session captures that session\'s screenshot, not the baseline session\'s own (#127)', async () => {
  const urlPath = '/performance/heavy-dom.html?count=50';

  const sessionsBefore = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const baselineSessionId = sessionsBefore[sessionsBefore.length - 1].id;

  await window.evaluate((id: string) => (window as any).testerBrowser.sessions.switchTo(id), baselineSessionId);
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const baselineTab = await getTabPage(app, 'heavy-dom.html');

  await window.click('#consoleTabVR');
  await window.click('#vrCaptureBtn');
  await expect(window.locator('#vrStats')).toContainText('Baseline captured', { timeout: 10_000 });

  // A second, unrelated session navigated to the same page and then mutated —
  // if Compare still screenshots the baseline session itself (the pre-#127
  // bug), it'll capture the unmutated page and report ~0 diff.
  await window.click('#newSessionBtn');
  const sessionsAfter = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const otherSessionId = sessionsAfter.find((s: { id: string }) => s.id !== baselineSessionId
    && !sessionsBefore.some((b: { id: string }) => b.id === s.id)).id;

  await window.evaluate((id: string) => (window as any).testerBrowser.sessions.switchTo(id), otherSessionId);
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const otherTab = await getTabPage(app, 'heavy-dom.html', baselineTab);
  await otherTab.click('#render');

  // Switch back to the baseline session via a real tab click — unlike
  // testerBrowser.sessions.switchTo() (a raw IPC call to the main process
  // only), clicking a tab also updates the renderer's own notion of the
  // active session, which activeData()/getActiveId() (and so the VR panel)
  // depend on.
  await window.click(`.tab[data-id="${baselineSessionId}"] .tab-name`);
  await window.click('#consoleTabVR');
  await expect(window.locator('#vrCompareBtn')).toBeEnabled();
  await window.selectOption('#vrComparePick', otherSessionId);

  await window.click('#vrCompareBtn');
  await expect(window.locator('#vrStats')).toContainText('pixels differ', { timeout: 15_000 });

  const statsText = (await window.locator('#vrStats').textContent()) || '';
  const match = statsText.match(/^([\d,]+) pixels differ/);
  expect(match).toBeTruthy();
  expect(Number(match![1].replace(/,/g, ''))).toBeGreaterThan(0);
});
