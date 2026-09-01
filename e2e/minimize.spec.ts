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

test('minimize button exists in console header', async () => {
  await expect(window.locator('#consolePanelMinBtn')).toBeVisible();
});

test('clicking minimize button hides console body', async () => {
  await expect(window.locator('#consolePanelBody')).toBeVisible();
  await window.click('#consolePanelMinBtn');
  await expect(window.locator('#consolePanelBody')).toBeHidden();
});

test('clicking minimize button again restores console body', async () => {
  // Body is hidden from previous test — click to restore
  await window.click('#consolePanelMinBtn');
  await expect(window.locator('#consolePanelBody')).toBeVisible();
});

test('minimize button title updates to reflect state', async () => {
  // Start expanded
  await expect(window.locator('#consolePanelMinBtn')).toHaveAttribute('title', 'Minimize panel');
  await window.click('#consolePanelMinBtn');
  await expect(window.locator('#consolePanelMinBtn')).toHaveAttribute('title', 'Restore panel');
  // Restore for subsequent tests
  await window.click('#consolePanelMinBtn');
});
