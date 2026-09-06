import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { getMainWindow, launchApp, MAIN_PATH } from './helpers';
import { startFixtureServer, FixtureServer } from './fixtures/server';

let app: Awaited<ReturnType<typeof electron.launch>>;
let page: Awaited<ReturnType<typeof app.firstWindow>>;
let fixtures: FixtureServer;

test.beforeAll(async () => {
  fixtures = await startFixtureServer();
  app = await launchApp(MAIN_PATH);
  page = await getMainWindow(app);
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app.close();
  await fixtures.close();
});

test('Security tab button exists', async () => {
  const tab = page.locator('#consoleTabSecurity');
  await expect(tab).toBeVisible();
  await expect(tab).toHaveText('Security');
});

test('clicking Security tab shows securityPanel', async () => {
  await page.locator('#consoleTabSecurity').click();
  await expect(page.locator('#securityPanel')).toBeVisible();
});

test('Security tab is marked active after click', async () => {
  await page.locator('#consoleTabSecurity').click();
  await expect(page.locator('#consoleTabSecurity')).toHaveClass(/active/);
});

test('Scan session button exists in panel', async () => {
  await page.locator('#consoleTabSecurity').click();
  await expect(page.locator('#secScanBtn')).toBeVisible();
});

test('securityPanel shows hint text initially', async () => {
  await page.locator('#consoleTabSecurity').click();
  await expect(page.locator('#secResults .sec-hint')).toBeVisible();
});

test('scan reports a real HTTP finding, and a row opens the detail panel', async () => {
  // Not testing the cookie findings here: Chromium's Network domain never
  // exposes Set-Cookie in Network.responseReceived's headers (it's only on
  // the separate Network.responseReceivedExtraInfo event, which the recorder
  // doesn't currently listen to) — so analyze()'s cookie checks are
  // unreachable via normal page loads regardless of what the response sends.
  const urlPath = '/storage/set-cookie?name=sec_test&value=1';
  await page.click('#urlbar');
  await page.fill('#urlbar', fixtures.url(urlPath));
  await page.press('#urlbar', 'Enter');
  await page.waitForTimeout(1_000);

  await page.click('#consoleTabSecurity');
  await page.click('#secScanBtn');
  await expect(page.locator('#secStatus')).not.toHaveText('Scanning…', { timeout: 5_000 });

  // Fixture server is plain HTTP — this finding always fires for any page load.
  await expect(page.locator('.sec-row', { hasText: 'HTTP (unencrypted)' })).toBeVisible();

  await page.locator('.sec-row', { hasText: 'HTTP (unencrypted)' }).first().click();
  await expect(page.locator('#detailPanelTabBar .detail-tab')).toHaveCount(1);
});
