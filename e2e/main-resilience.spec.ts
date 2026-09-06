/**
 * #21 — main-process/background-service resilience. index.ts's
 * recordAppError() is the single funnel every uncaught main-process error
 * and unhandled rejection already went through (for bug-report diagnostics)
 * — it now also pushes an app:mainError event so the renderer shows a
 * dismissible banner (renderer/errors.js) instead of the failure being
 * silent or the user seeing undefined behavior. debug:simulateMainError
 * drives that exact same funnel without needing to provoke a real crash
 * from outside the app. Recorder-level resilience (a broken recording DB
 * disabling just that session instead of taking down the app) is covered
 * by src/main/__tests__/recorder.test.ts's dedicated unit tests, which can
 * exercise it directly rather than needing to corrupt a real SQLite file
 * from an e2e test.
 */
import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { getMainWindow, launchApp, MAIN_PATH } from './helpers';

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

test('a main-process error surfaces as a dismissible banner instead of failing silently', async () => {
  await expect(window.locator('#mainErrorBanner')).toBeHidden();

  await window.evaluate(() => (window as any).testerBrowser.debug.simulateMainError('Recording database unavailable, recording disabled for this session'));

  await expect(window.locator('#mainErrorBanner')).toBeVisible();
  await expect(window.locator('#mainErrorMsg')).toContainText('Recording database unavailable');

  await window.locator('#mainErrorDismiss').click();
  await expect(window.locator('#mainErrorBanner')).toBeHidden();
});

test('a later error replaces the message rather than getting lost behind the first', async () => {
  await window.evaluate(() => (window as any).testerBrowser.debug.simulateMainError('first problem'));
  await expect(window.locator('#mainErrorMsg')).toContainText('first problem');

  await window.evaluate(() => (window as any).testerBrowser.debug.simulateMainError('second, more recent problem'));
  await expect(window.locator('#mainErrorMsg')).toContainText('second, more recent problem');

  await window.locator('#mainErrorDismiss').click();
});

test('the app keeps working normally after a main-process error is reported', async () => {
  await window.evaluate(() => (window as any).testerBrowser.debug.simulateMainError('background hiccup'));
  await expect(window.locator('#mainErrorBanner')).toBeVisible();

  await window.click('#newSessionBtn');
  const sessions: Array<{ id: string }> = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  expect(sessions.length).toBeGreaterThanOrEqual(2);

  // The error is diagnostic info, not a modal — it doesn't block anything.
  await expect(window.locator('#tabs')).toBeVisible();
});
