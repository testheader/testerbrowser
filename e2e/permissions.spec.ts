/**
 * #18 — permission gatekeeping. permissionManager.ts routes every browser
 * permission request (camera, mic, geolocation, clipboard, ...) to the
 * renderer as a `permission:request` notification for the user to
 * approve/deny, and strictly enforces the answer via
 * setPermissionCheckHandler — this checks both the round trip and that a
 * denial is actually honored (not just cosmetically shown).
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { getMainWindow, getTabPage, launchApp, MAIN_PATH } from './helpers';
import { startFixtureServer, FixtureServer } from './fixtures/server';

let app: Awaited<ReturnType<typeof electron.launch>>;
let window: Page;
let fixtures: FixtureServer;

test.beforeAll(async () => {
  fixtures = await startFixtureServer();
  app = await launchApp(MAIN_PATH);
  window = await getMainWindow(app);
  await window.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app.close();
  await fixtures.close();
});

test('denying a geolocation request is strictly enforced (not just shown)', async () => {
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url('/permissions/index.html'));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, '/permissions/index.html');
  await tab.waitForLoadState('domcontentloaded');

  await tab.click('#geo');
  await expect(window.locator('.perm-notif .perm-msg')).toContainText('access your location');
  await window.locator('.perm-notif .perm-block').click();

  await expect(tab.locator('#out')).toContainText('denied', { timeout: 5000 });
});

test('granting a permission request lets the action actually succeed', async () => {
  // Re-navigates the same (only) tab from the previous test.
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url('/permissions/index.html'));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, '/permissions/index.html');
  await tab.waitForLoadState('domcontentloaded');

  await tab.click('#clip');
  await expect(window.locator('.perm-notif .perm-msg')).toContainText('write to the clipboard');
  await window.locator('.perm-notif .perm-allow').click();
  await expect(tab.locator('#out')).toContainText('succeeded', { timeout: 5000 });
});

test('a permission granted in one session does not carry over to a different session', async () => {
  // Driven through the same UI path as every other tab-creation test in this
  // suite (click "+", then the URL bar) rather than raw sessions.create()/
  // navigate() IPC calls — going through raw IPC calls here was an
  // intermittent source of flakiness in this sandbox (the new
  // WebContentsView's target sometimes took far longer than usual to
  // register with Playwright's CDP layer when driven that way).
  await window.click('#newSessionBtn');
  await window.click('#urlbar');
  // A unique query string sidesteps any ambiguity with the previous test's
  // still-open tab on the same fixture page.
  await window.fill('#urlbar', fixtures.url('/permissions/index.html?session=fresh'));
  await window.press('#urlbar', 'Enter');

  const tab = await getTabPage(app, 'session=fresh');
  await tab.waitForLoadState('domcontentloaded');

  await tab.click('#clip');
  // A brand-new session/partition has never been granted anything — it must
  // prompt again, not silently inherit the earlier tab's grant.
  await expect(window.locator('.perm-notif .perm-msg')).toContainText('write to the clipboard');
  await window.locator('.perm-notif .perm-allow').click();
  await expect(tab.locator('#out')).toContainText('succeeded', { timeout: 5000 });
});
