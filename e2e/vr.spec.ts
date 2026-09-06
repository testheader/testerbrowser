import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'path';
import { getMainWindow, getTabPage } from './helpers';
import { startFixtureServer, FixtureServer } from './fixtures/server';

let app: ElectronApplication;
let window: Page;
let fixtures: FixtureServer;

test.beforeAll(async () => {
  fixtures = await startFixtureServer();
  app = await electron.launch({
    args: [path.join(__dirname, '..', 'dist', 'main', 'index.js')],
  });
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
