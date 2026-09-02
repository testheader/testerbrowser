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

test('tab bar is present for session context menu access', async () => {
  const tabBar = window.locator('#tabs');
  await expect(tabBar).toBeVisible();
});

test('at least one session tab exists', async () => {
  const tab = window.locator('.tab').first();
  await expect(tab).toBeVisible();
});

test('console panel is present', async () => {
  const consolePanel = window.locator('#consolePanel');
  await expect(consolePanel).toBeVisible();
});
