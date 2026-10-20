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

// #298: error count on the Console tab; follows the active session.
test('the Console tab badge counts errors, and is hidden on a clean tab (#298)', async () => {
  const urlPath = '/console/js-error.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);
  await tab.waitForLoadState('load');
  await tab.click('#throwSync');

  const badge = window.locator('#consoleTabConsole .tab-badge');
  await expect(badge).toBeVisible({ timeout: 5_000 });
  await expect(badge).toHaveAttribute('aria-label', /^\d+ errors?$/);

  // A fresh tab has no errors of its own.
  await window.click('#newSessionBtn');
  await expect(badge).toHaveCount(0, { timeout: 5_000 });

  // Switching back restores the first tab's count.
  await window.locator('.tab').first().locator('.tab-name').click();
  await expect(badge).toBeVisible({ timeout: 5_000 });
});
