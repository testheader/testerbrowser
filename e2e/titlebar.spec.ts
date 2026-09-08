import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { getMainWindow, launchApp, MAIN_PATH } from './helpers';

// Covers #169: the tab strip, app menu and window controls now share a single
// merged row instead of a separate titlebar row sitting above the tabs row.

let app: ElectronApplication;
let window: Page;

test.beforeAll(async () => {
  app = await launchApp(MAIN_PATH);
  window = await getMainWindow(app);
  await window.waitForLoadState('load');
});

test.afterAll(async () => {
  await app.close();
});

test('tabs and window controls share a single row', async () => {
  const tabsBox = await window.locator('#tabs').boundingBox();
  const closeBox = await window.locator('#winCloseBtn').boundingBox();
  expect(tabsBox).not.toBeNull();
  expect(closeBox).not.toBeNull();
  // Vertical overlap = they sit on the same row rather than stacked rows.
  const overlap =
    Math.min(tabsBox!.y + tabsBox!.height, closeBox!.y + closeBox!.height) -
    Math.max(tabsBox!.y, closeBox!.y);
  expect(overlap).toBeGreaterThan(0);
});

test('the app menu button shows a logo, not the old wordmark text', async () => {
  const appName = window.locator('#appName');
  await expect(appName).toBeVisible();
  await expect(appName).not.toContainText('TesterBrowser');
  await expect(window.locator('#appLogo')).toBeVisible();
});

test('clicking the app menu button opens the dropdown with its menu items', async () => {
  await window.click('#appName');
  await expect(window.locator('#appMenuDropdown')).toHaveClass(/open/);
  await expect(window.locator('#appMenuNewTemp')).toBeVisible();
  await expect(window.locator('#appMenuSettings')).toBeVisible();
  await expect(window.locator('#appMenuBugReport')).toBeVisible();
  // Close it again so it doesn't leak into later tests.
  await window.click('#appName');
  await expect(window.locator('#appMenuDropdown')).not.toHaveClass(/open/);
});

test('window controls stay visible and clickable when the tab strip overflows', async () => {
  // Open a handful of extra tabs (kept small — each is a real isolated
  // session) and then artificially constrain the tab strip's available width
  // via injected CSS, exactly like a narrow window would, so the overflow
  // path is exercised deterministically without needing dozens of real
  // sessions.
  for (let i = 0; i < 8; i++) {
    await window.keyboard.press('Control+t');
  }
  await expect.poll(() => window.locator('.tab').count()).toBeGreaterThan(8);

  await window.locator('#tabs').evaluate((el) => { (el as HTMLElement).style.maxWidth = '250px'; });

  const tabsEl = window.locator('#tabs');
  const scrollWidth = await tabsEl.evaluate((el) => el.scrollWidth);
  const clientWidth = await tabsEl.evaluate((el) => el.clientWidth);
  expect(scrollWidth).toBeGreaterThan(clientWidth);

  // The window controls sit outside #tabs and must stay fully on-screen and
  // clickable regardless of how much the tab strip overflows.
  const winWidth = await window.evaluate(() => window.innerWidth);
  const closeBox = await window.locator('#winCloseBtn').boundingBox();
  expect(closeBox).not.toBeNull();
  expect(closeBox!.x + closeBox!.width).toBeLessThanOrEqual(winWidth + 1);
  await expect(window.locator('#winCloseBtn')).toBeVisible();
  await expect(window.locator('#winCloseBtn')).toBeEnabled();

  // Reduce back down so later specs (run in the same suite) start clean.
  for (let i = 0; i < 20 && (await window.locator('.tab').count()) > 1; i++) {
    await window.keyboard.press('Control+w');
  }
});
