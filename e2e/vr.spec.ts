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
