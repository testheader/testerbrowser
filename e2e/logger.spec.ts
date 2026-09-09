import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { getMainWindow, launchApp, MAIN_PATH } from './helpers';

let app: ElectronApplication;
let window: Page;

test.beforeAll(async () => {
  app = await launchApp(MAIN_PATH);
  window = await getMainWindow(app);
  await window.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => { await app.close(); });

test('Network tab pills are visible, with only Req on by default', async () => {
  await window.locator('#consoleTabNetwork').click();
  const reqPill = window.locator('#networkPills .filter-pill[data-type="network-request"]');
  await expect(reqPill).toBeVisible();
  await expect(reqPill).toHaveClass(/\bon\b/);

  const resPill = window.locator('#networkPills .filter-pill[data-type="network-response"]');
  await expect(resPill).toBeVisible();
  await expect(resPill).not.toHaveClass(/\bon\b/);

  const errPill = window.locator('#networkPills .filter-pill[data-type="network-failed"]');
  await expect(errPill).toBeVisible();
  await expect(errPill).not.toHaveClass(/\bon\b/);
});

test('detail panel tab bar exists', async () => {
  await expect(window.locator('#detailPanelTabBar')).toBeAttached();
});
