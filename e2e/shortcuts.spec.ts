/**
 * #22 — accelerator conflicts: global shortcuts (Ctrl+T, Ctrl+W, ...) must
 * keep working even while focus sits inside an interactive webpage, not
 * just the chrome's own DOM. sessionManager.ts forwards keys from each
 * tab's WebContents via before-input-event -> 'app:shortcut' IPC
 * (shortcuts.js's onShortcut) specifically because a focused page swallows
 * normal keydown listeners on the chrome window (see CLAUDE.md's
 * BrowserView-input-swallowing gotcha).
 *
 * Note: Playwright's page.keyboard.press() on a tab's Page drives Chromium's
 * CDP Input domain, which injects straight into that renderer and never
 * reaches before-input-event at all (confirmed by instrumenting it directly
 * — a real keypress or Electron's own webContents.sendInputEvent both do
 * reach it; CDP-dispatched input doesn't). webContents.sendInputEvent (via
 * app.evaluate) is what actually exercises this mechanism.
 *
 * #23 — focus trapping: Ctrl+L must reliably focus the URL bar, and
 * clicking back into the page must return focus there.
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

async function sendKeyToPage(urlIncludes: string, keyCode: string, modifiers: string[]) {
  await app.evaluate(
    ({ webContents }, { urlIncludes, keyCode, modifiers }) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().includes(urlIncludes));
      wc?.sendInputEvent({ type: 'keyDown', keyCode, modifiers: modifiers as any });
      wc?.sendInputEvent({ type: 'keyUp', keyCode, modifiers: modifiers as any });
    },
    { urlIncludes, keyCode, modifiers }
  );
}

test('Ctrl+T still opens a new tab while an input field inside the page has focus', async () => {
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url('/record/target.html'));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, '/record/target.html');
  await tab.waitForLoadState('domcontentloaded');
  await tab.click('[data-testid="rp-input"]');
  await expect(tab.locator('[data-testid="rp-input"]')).toBeFocused();

  const before: Array<{ id: string }> = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  await sendKeyToPage('/record/target.html', 'T', ['control']);

  await expect.poll(async () => {
    const after: Array<{ id: string }> = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
    return after.length;
  }).toBe(before.length + 1);
});

test('Ctrl+W closes the active tab from page-focused keyboard input', async () => {
  // The Ctrl+T tab just opened (newtab.html) is now active and focused.
  const before: Array<{ id: string }> = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const activeId = before[before.length - 1].id;
  const newTabPage = await getTabPage(app, 'newtab.html');
  await newTabPage.waitForLoadState('domcontentloaded');

  await sendKeyToPage('newtab.html', 'W', ['control']);

  await expect.poll(async () => {
    const after: Array<{ id: string }> = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
    return after.some((s) => s.id === activeId);
  }).toBe(false);
});

test('Ctrl+L focuses the URL bar from page-focused keyboard input, and clicking the page returns focus there', async () => {
  const tab = await getTabPage(app, '/record/target.html');
  await tab.click('[data-testid="rp-input"]');
  await expect(tab.locator('[data-testid="rp-input"]')).toBeFocused();

  await sendKeyToPage('/record/target.html', 'L', ['control']);
  await expect(window.locator('#urlbar')).toBeFocused();

  await tab.click('[data-testid="rp-input"]');
  await expect(tab.locator('[data-testid="rp-input"]')).toBeFocused();
});
