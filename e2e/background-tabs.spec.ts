/**
 * #14 — "tab sleeping" / background throttling. TesterBrowser doesn't
 * implement a custom throttling scheme: switching away from a tab already
 * removes its WebContentsView from the window and calls View.setVisible(false)
 * on it (sessionManager.ts switchTo) — which is what makes Chromium treat it
 * as backgrounded (rAF/timers throttle per the normal page lifecycle) while
 * keeping the underlying process, and its JS state/scroll position, alive
 * for instant reactivation.
 *
 * The first test below checks that mechanism directly (via
 * sessions.isViewVisible, backed by View.getVisible()) rather than via
 * document.visibilityState in the page itself: Playwright's Electron/CDP
 * automation layer keeps every page reporting visibilityState "visible"
 * regardless of real window attachment (confirmed by reproducing the same
 * setVisible/removeChildView sequence outside of Playwright, where it
 * correctly reports "hidden") — that's a Playwright characteristic for test
 * determinism, not something TesterBrowser controls or real users see.
 */
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

async function isViewVisible(id: string): Promise<boolean | null> {
  return window.evaluate((id) => (window as any).testerBrowser.sessions.isViewVisible(id), id);
}

test('a backgrounded tab is marked not-visible, and visible again once reactivated', async () => {
  const firstSessions: Array<{ id: string }> = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const firstId = firstSessions[0].id;

  await window.click('#newSessionBtn'); // opens and switches to a second tab
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url('/'));
  await window.press('#urlbar', 'Enter');
  const tabPage = await getTabPage(app, '127.0.0.1');
  await tabPage.waitForLoadState('domcontentloaded');

  const sessions: Array<{ id: string }> = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const bgId = sessions.find((s) => s.id !== firstId)!.id;
  expect(await isViewVisible(bgId)).toBe(true);

  // Switch back to the first tab — this backgrounds the one we just loaded.
  await window.evaluate((id) => (window as any).testerBrowser.sessions.switchTo(id), firstId);
  expect(await isViewVisible(bgId)).toBe(false);

  // Reactivating it makes it visible again — the process/page was never
  // destroyed, just detached from the window (confirmed by the scroll-
  // position test below).
  await window.evaluate((id) => (window as any).testerBrowser.sessions.switchTo(id), bgId);
  expect(await isViewVisible(bgId)).toBe(true);
});

test('scroll position survives being backgrounded and reactivated', async () => {
  const sessions: Array<{ id: string }> = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const firstId = sessions[0].id;
  const otherId = sessions.find((s) => s.id !== firstId)!.id;

  await window.evaluate((id) => (window as any).testerBrowser.sessions.switchTo(id), otherId);
  const tabPage = await getTabPage(app, '127.0.0.1');
  await tabPage.evaluate(() => {
    document.documentElement.style.minHeight = '5000px';
    window.scrollTo(0, 1234);
  });
  await expect(tabPage.evaluate(() => window.scrollY)).resolves.toBe(1234);

  // Background it, then bring it back.
  await window.evaluate((id) => (window as any).testerBrowser.sessions.switchTo(id), firstId);
  await window.waitForTimeout(200);
  await window.evaluate((id) => (window as any).testerBrowser.sessions.switchTo(id), otherId);

  await expect(tabPage.evaluate(() => window.scrollY)).resolves.toBe(1234);
});
