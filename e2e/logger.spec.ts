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
  await window.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => { await app.close(); });

test('Network tab pills are visible and on by default', async () => {
  await window.locator('#consoleTabNetwork').click();
  const resPill = window.locator('#networkPills .filter-pill[data-type="network-response"]');
  await expect(resPill).toBeVisible();
  const resClasses = await resPill.getAttribute('class');
  expect(resClasses).toContain('on');
  const reqPill = window.locator('#networkPills .filter-pill[data-type="network-request"]');
  await expect(reqPill).toBeVisible();
  const reqClasses = await reqPill.getAttribute('class');
  expect(reqClasses).toContain('on');
});

test('detail panel tab bar exists', async () => {
  await expect(window.locator('#detailPanelTabBar')).toBeAttached();
});
