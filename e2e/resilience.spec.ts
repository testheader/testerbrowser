import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'path';
import { getMainWindow } from './helpers';

let app: ElectronApplication;
let window: Page;

test.beforeAll(async () => {
  app = await electron.launch({
    args: [path.join(__dirname, '..', 'dist', 'main', 'index.js')],
  });
  window = await getMainWindow(app);
  await window.waitForLoadState('load');
});

test.afterAll(async () => {
  await app.close();
});

test('Resilience tab button exists', async () => {
  const tab = window.locator('#consoleTabResilience');
  await expect(tab).toBeVisible();
  await expect(tab).toHaveText('Resilience');
});

test('clicking Resilience tab shows resiliencePanel', async () => {
  await window.locator('#consoleTabResilience').click();
  const panel = window.locator('#resiliencePanel');
  await expect(panel).toBeVisible();
});

test('resilience panel renders add-rule form on first click', async () => {
  await window.locator('#consoleTabResilience').click();
  await window.waitForSelector('#resForm', { timeout: 3000 });
  await expect(window.locator('#resType')).toBeVisible();
  await expect(window.locator('#resUrl')).toBeVisible();
});

test('resilience panel shows empty state initially', async () => {
  await window.locator('#consoleTabResilience').click();
  await window.waitForSelector('#resEmpty', { timeout: 3000 });
  await expect(window.locator('#resEmpty')).toBeVisible();
});
