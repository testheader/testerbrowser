/**
 * #19 — SSL/certificate error handling. TesterBrowser never overrides
 * Electron's default 'certificate-error' handling (no listener is
 * registered for it at all), so an invalid/self-signed certificate is
 * rejected exactly like a real browser would: the navigation fails
 * (did-fail-load with a net::ERR_CERT_* code) and the page never commits —
 * unlike full Chrome, Electron doesn't ship a built-in interstitial
 * document for this, so without extra handling the tab would just silently
 * stay put with zero feedback. sessionManager.ts's did-fail-load handler
 * recognizes the cert-range error code and pushes session:certificateError
 * so the chrome can show its own warning instead (renderer/errors.js).
 */
import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { getMainWindow, launchApp, MAIN_PATH } from './helpers';
import { startFixtureServer, startHttpsFixtureServer, FixtureServer } from './fixtures/server';

let app: ElectronApplication;
let window: Page;
let httpsFixtures: FixtureServer;
let httpFixtures: FixtureServer;

test.beforeAll(async () => {
  httpsFixtures = await startHttpsFixtureServer();
  httpFixtures = await startFixtureServer();
  app = await launchApp(MAIN_PATH);
  window = await getMainWindow(app);
  await window.waitForLoadState('load');
});

test.afterAll(async () => {
  await app.close();
  await httpsFixtures.close();
  await httpFixtures.close();
});

test('a self-signed-cert HTTPS site never commits, and the chrome surfaces its own warning', async () => {
  const before: Array<{ id: string; url: string }> = await window.evaluate(() => (window as any).testerBrowser.sessions.list());

  await window.click('#urlbar');
  await window.fill('#urlbar', httpsFixtures.url('/'));
  await window.press('#urlbar', 'Enter');

  await expect(window.locator('#certErrorBanner')).toBeVisible();
  await expect(window.locator('#certErrorMsg')).toContainText('untrusted certificate');
  await expect(window.locator('#certErrorMsg')).toContainText('127.0.0.1');

  // The navigation never actually committed — the session's URL is
  // unchanged, i.e. the fixture server's real content was never reached.
  const after: Array<{ id: string; url: string }> = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  expect(after.find((s) => s.id === before[0].id)?.url).toBe(before[0].url);

  await window.locator('#certErrorDismiss').click();
  await expect(window.locator('#certErrorBanner')).toBeHidden();
});

test('a normal navigation afterward is unaffected', async () => {
  // The blocked HTTPS attempt shouldn't leave the tab or the cert-error
  // machinery in a broken state for subsequent, legitimate navigations.
  await window.click('#urlbar');
  await window.fill('#urlbar', httpFixtures.url('/'));
  await window.press('#urlbar', 'Enter');
  await expect(window.locator('#urlbar')).toHaveValue(httpFixtures.url('/'));
  await expect(window.locator('#certErrorBanner')).toBeHidden();
});
