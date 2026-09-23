import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { getMainWindow, launchApp, MAIN_PATH } from './helpers';

let app: Awaited<ReturnType<typeof electron.launch>>;
let page: Awaited<ReturnType<typeof app.firstWindow>>;

test.beforeAll(async () => {
  app = await launchApp(MAIN_PATH);
  page = await getMainWindow(app);
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app.close();
});

test('Debug mode toggle exists in Settings and flipping it persists through settings:get', async () => {
  await page.evaluate(() => (window as any).testerBrowser.settings.set({ debugMode: false }));
  const before = await page.evaluate(() => (window as any).testerBrowser.settings.get());
  expect(before.debugMode).toBe(false);

  await page.click('#appName');
  await page.click('#appMenuSettings');
  await expect(page.locator('#settingsOverlay')).toHaveClass(/open/);
  await expect(page.locator('#debugModeToggle')).not.toBeChecked();
  // The checkbox itself is visually hidden by .toggle-switch (opacity/size
  // zeroed out — only the sibling .toggle-slider is rendered), so Playwright
  // won't treat it as clickable; click the visible slider instead, same as a
  // real user would.
  await page.locator('#debugModeToggle + .toggle-slider').click();
  await expect(page.locator('#debugModeToggle')).toBeChecked();

  // Persisted immediately via settings:set, same round-trip security.spec.ts
  // uses to prove securityRuleOverrides persistence.
  const after = await page.evaluate(() => (window as any).testerBrowser.settings.get());
  expect(after.debugMode).toBe(true);

  await page.locator('#settingsCloseXBtn').click();
  // Reset for later tests in this file.
  await page.evaluate(() => (window as any).testerBrowser.settings.set({ debugMode: false }));
});

test('Debug Log tab shows the disabled empty state when debug mode is off', async () => {
  await page.evaluate(() => (window as any).testerBrowser.settings.set({ debugMode: false }));
  await page.click('#consoleTabDebugLog');
  await expect(page.locator('#debugLogPanel')).toBeVisible();
  await expect(page.locator('#debugLogList')).toContainText('Debug mode is off');
});

test('Debug Log tab lists a reported error when debug mode is on', async () => {
  await page.evaluate(() => (window as any).testerBrowser.settings.set({ debugMode: true }));
  await page.evaluate(() => (window as any).testerBrowser.app.reportError('debug-mode-test-marker'));

  // Switch away and back so the tab's own activation handler re-fetches
  // fresh state (it also polls on a 1s interval while active).
  await page.click('#consoleTabConsole');
  await page.click('#consoleTabDebugLog');

  await expect(page.locator('#debugLogList')).toContainText('debug-mode-test-marker', { timeout: 5_000 });

  // Reset for later specs.
  await page.evaluate(() => (window as any).testerBrowser.settings.set({ debugMode: false }));
});
