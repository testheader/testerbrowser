import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'path';

let app: ElectronApplication;
let window: Page;

test.beforeAll(async () => {
  app = await electron.launch({
    args: [path.join(__dirname, '..', 'dist', 'main', 'index.js')],
  });
  window = await app.firstWindow();
  await window.waitForLoadState('load');
});

test.afterAll(async () => {
  await app.close();
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
  await expect(window.locator('#diffSessionA')).toBeAttached();
  await expect(window.locator('#diffSessionB')).toBeAttached();
});

test('diffPanel contains a Run diff button', async () => {
  await window.locator('#consoleTabDiff').click();
  await window.waitForTimeout(200);
  await expect(window.locator('#diffRunBtn')).toBeAttached();
});

test('diffPanel contains a HAR export button', async () => {
  await window.locator('#consoleTabDiff').click();
  await window.waitForTimeout(200);
  await expect(window.locator('#diffExportBtn')).toBeAttached();
});
