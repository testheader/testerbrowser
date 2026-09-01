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
});

test.afterAll(async () => { await app.close(); });

test('Res pill is off by default', async () => {
  const resPill = window.locator('.filter-pill[data-type="network-response"]');
  await expect(resPill).toBeVisible();
  const classes = await resPill.getAttribute('class');
  expect(classes).not.toContain('on');
});

test('Req pill is on by default', async () => {
  const reqPill = window.locator('.filter-pill[data-type="network-request"]');
  await expect(reqPill).toBeVisible();
  const classes = await reqPill.getAttribute('class');
  expect(classes).toContain('on');
});

test('detail panel tab bar exists', async () => {
  await expect(window.locator('#detailPanelTabBar')).toBeAttached();
});
