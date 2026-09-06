/**
 * #20 — post-crash per-tab recovery. sessionManager.ts listens for
 * render-process-gone on each tab's WebContents and pulls the dead view out
 * of the window immediately, so the chrome can show an inline recovery
 * overlay (renderer/crash-recovery.js) in its place instead of a frozen or
 * blank surface — without taking down the rest of the app.
 */
import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { getMainWindow, launchApp, MAIN_PATH } from './helpers';
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

async function crashActiveTab() {
  await app.evaluate(({ webContents }) => {
    const target = webContents.getAllWebContents().find((wc) => wc.getURL().includes('127.0.0.1'));
    target?.forcefullyCrashRenderer();
  });
}

test('a crashed tab shows a recovery overlay, without taking down the app or other tabs', async () => {
  // A second tab that stays healthy throughout, to prove the crash is
  // contained to the one that actually crashed.
  await window.click('#newSessionBtn');
  const healthySessions: Array<{ id: string }> = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const healthyId = healthySessions[healthySessions.length - 1].id;

  await window.click('#newSessionBtn');
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url('/'));
  await window.press('#urlbar', 'Enter');
  const sessions: Array<{ id: string }> = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const crashingId = sessions[sessions.length - 1].id;

  await expect.poll(async () => {
    const s: Array<{ id: string; url: string }> = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
    return s.find((x) => x.id === crashingId)?.url ?? '';
  }).toContain('127.0.0.1');

  await crashActiveTab();

  await expect(window.locator('#crashOverlay')).toBeVisible();
  await expect(window.locator('#crashOverlay')).toContainText('crashed');

  // The rest of the app is completely unaffected: other tabs still work,
  // new tabs can still be created, the toolbar still responds.
  await window.click('#newSessionBtn');
  const afterCrash: Array<{ id: string; crashed: boolean }> = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  expect(afterCrash.find((s) => s.id === crashingId)?.crashed).toBe(true);
  expect(afterCrash.find((s) => s.id === healthyId)?.crashed).toBe(false);
  expect(afterCrash.length).toBe(sessions.length + 1);

  // Switching to the healthy tab (backgrounding the crashed one) hides the
  // overlay; switching back to the crashed tab shows it again. Driven
  // through real tab clicks (not the raw IPC call) since that's the only
  // path that keeps the renderer's own crash-overlay bookkeeping in sync
  // (see tabs.js's switchToSession -> syncCrashOverlay).
  await window.locator(`.tab[data-id="${healthyId}"] .tab-name`).click();
  await expect(window.locator('#crashOverlay')).toBeHidden();
  await window.locator(`.tab[data-id="${crashingId}"] .tab-name`).click();
  await expect(window.locator('#crashOverlay')).toBeVisible();
});

test('clicking "Reload tab" recovers the crashed tab', async () => {
  await window.click('#crashReloadBtn');
  await expect(window.locator('#crashOverlay')).toBeHidden({ timeout: 10_000 });

  const sessions: Array<{ id: string; crashed: boolean; url: string }> = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const active = sessions.find((s) => s.url.includes('127.0.0.1'));
  expect(active?.crashed).toBe(false);
});
