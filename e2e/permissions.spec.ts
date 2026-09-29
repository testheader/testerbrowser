import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { getMainWindow, getTabPage, launchApp, MAIN_PATH } from './helpers';
import { startFixtureServer, FixtureServer } from './fixtures/server';

let app: ElectronApplication;
let window: Page;
let fixtures: FixtureServer;

test.beforeAll(async () => {
  fixtures = await startFixtureServer();
  app = await launchApp(MAIN_PATH);
  window = await getMainWindow(app);
  await window.waitForLoadState('load');
});

test.afterAll(async () => {
  await app.close();
  await fixtures.close();
});

test('granting a permission is remembered — reloading the page does not re-prompt (#276)', async () => {
  const urlPath = '/permissions/index.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);
  await tab.waitForLoadState('load');

  await tab.click('#geo');
  await expect(window.locator('.perm-notif')).toBeVisible();
  await window.locator('.perm-allow').click();
  await expect(window.locator('.perm-notif')).toHaveCount(0);

  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  await tab.waitForLoadState('load');
  await tab.click('#geo');
  // No re-prompt — give a wrongly-shown one time to appear before asserting its absence.
  await tab.waitForTimeout(500);
  await expect(window.locator('.perm-notif')).toHaveCount(0);
});

// #276: denials weren't persisted at all before this fix — every request
// re-prompted, forever, with no way to make "always deny" sticky.
test('denying a permission is also remembered — reloading does not re-prompt either (#276)', async () => {
  const urlPath = '/permissions/index.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);
  await tab.waitForLoadState('load');

  await tab.click('#notif');
  await expect(window.locator('.perm-notif')).toBeVisible();
  await window.locator('.perm-block').click();
  await expect(window.locator('.perm-notif')).toHaveCount(0);

  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  await tab.waitForLoadState('load');
  await tab.click('#notif');
  await tab.waitForTimeout(500);
  await expect(window.locator('.perm-notif')).toHaveCount(0);
});

// #276: the prompt now names which tab it belongs to.
test('a permission prompt shows the requesting tab\'s name (#276)', async () => {
  const urlPath = '/permissions/index.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);
  await tab.waitForLoadState('load');

  await tab.click('#clip');
  const notif = window.locator('.perm-notif');
  await expect(notif).toBeVisible();
  await expect(notif.locator('.perm-tab-label')).toBeVisible();
  await window.locator('.perm-allow').click();
});

// Reuses the 'geolocation' grant test 1 already made for this same origin —
// getUserMedia (camera/mic) needs a real capture device to ever reach the
// permission handler at all, unavailable in this environment, so the
// fixture's hardware-backed buttons can't be used for permission coverage
// here. Ends with 'geolocation' revoked (no record left), which the next
// test relies on to get a guaranteed-fresh prompt.
test('revoking a granted permission from the Storage tab causes the prompt to reappear (#276)', async () => {
  const urlPath = '/permissions/index.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);
  await tab.waitForLoadState('load');

  // Still remembered from test 1 — no prompt.
  await tab.click('#geo');
  await tab.waitForTimeout(500);
  await expect(window.locator('.perm-notif')).toHaveCount(0);

  await window.click('#consoleTabStorage');
  const permRow = window.locator('.storage-table tr', { hasText: 'geolocation' }).filter({ hasText: 'Granted' });
  await expect(permRow).toHaveCount(1);
  await permRow.locator('.storage-delete-btn').click();
  await expect(permRow).toHaveCount(0);

  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  await tab.waitForLoadState('load');
  await tab.click('#geo');
  await expect(window.locator('.perm-notif')).toBeVisible({ timeout: 5_000 });
  // Left unanswered on purpose — the next test needs a genuinely pending
  // prompt of its own, and closes the tab this one belongs to anyway.
});

test('closing a tab with a pending permission prompt auto-dismisses it without the app hanging or throwing (#276)', async () => {
  // Still pending from the previous test, on the tab that test left active.
  await expect(window.locator('.perm-notif')).toBeVisible();

  await window.keyboard.press('Control+w'); // closes the tab the pending prompt belongs to

  await expect(window.locator('.perm-notif')).toHaveCount(0, { timeout: 5_000 });
  // The app is still responsive afterward — not wedged by a callback left
  // pointing at the now-destroyed webContents.
  await expect(window.locator('#urlbar')).toBeVisible();
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url('/console/logs.html'));
  await window.press('#urlbar', 'Enter');
  await (await getTabPage(app, '/console/logs.html')).waitForLoadState('load');
});
