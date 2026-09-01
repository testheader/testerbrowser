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

test('Mock tab button exists', async () => {
  const tab = window.locator('#consoleTabMock');
  await expect(tab).toBeVisible();
  await expect(tab).toHaveText('Mock');
});

test('clicking Mock tab shows mockPanel', async () => {
  await window.locator('#consoleTabMock').click();
  const panel = window.locator('#mockPanel');
  await expect(panel).toBeVisible();
});

test('mock panel renders add-rule form elements', async () => {
  await window.locator('#consoleTabMock').click();
  // The panel initializes on first click
  await window.waitForSelector('#mockUrl', { timeout: 3000 });
  await expect(window.locator('#mockUrl')).toBeVisible();
  await expect(window.locator('#mockMethod')).toBeVisible();
  await expect(window.locator('#mockStatus')).toBeVisible();
});
