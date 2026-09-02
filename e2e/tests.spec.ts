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
  await window.waitForLoadState('domcontentloaded');
  await window.waitForTimeout(1000);
});

test.afterAll(async () => {
  await app.close();
});

test('Tests tab button exists in console panel', async () => {
  const btn = window.locator('#consoleTabTests');
  await expect(btn).toBeAttached();
});

test('clicking Tests tab shows testsPanel', async () => {
  await window.locator('#consoleTabTests').click();
  await expect(window.locator('#testsPanel')).toBeVisible();
});

test('testsPanel contains Start recording button', async () => {
  await window.locator('#consoleTabTests').click();
  await expect(window.locator('#rpStartBtn')).toBeAttached();
});

test('testsPanel contains test list section', async () => {
  await window.locator('#consoleTabTests').click();
  await expect(window.locator('#rpTestList')).toBeAttached();
});
