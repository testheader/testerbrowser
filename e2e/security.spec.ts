import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import path from 'path';

let app: Awaited<ReturnType<typeof electron.launch>>;
let page: Awaited<ReturnType<typeof app.firstWindow>>;

test.beforeAll(async () => {
  app = await electron.launch({
    args: [path.join(__dirname, '..', 'dist', 'main', 'index.js')],
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app.close();
});

test('Security tab button exists', async () => {
  const tab = page.locator('#consoleTabSecurity');
  await expect(tab).toBeVisible();
  await expect(tab).toHaveText('Security');
});

test('clicking Security tab shows securityPanel', async () => {
  const tab = page.locator('#consoleTabSecurity');
  await tab.click();
  const panel = page.locator('#securityPanel');
  await expect(panel).toBeVisible();
});

test('Security tab is marked active after click', async () => {
  const tab = page.locator('#consoleTabSecurity');
  await tab.click();
  await expect(tab).toHaveClass(/active/);
});

test('Scan session button exists in panel', async () => {
  await page.locator('#consoleTabSecurity').click();
  const btn = page.locator('#secScanBtn');
  await expect(btn).toBeVisible();
  await expect(btn).toHaveText('Scan session');
});

test('securityPanel shows hint text initially', async () => {
  await page.locator('#consoleTabSecurity').click();
  const hint = page.locator('#secResults .sec-hint');
  await expect(hint).toBeVisible();
});
