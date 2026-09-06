/**
 * #8 — native window decorator scaling. The main window is frameless
 * (`frame: false` in index.ts) with a custom-drawn titlebar, so minimize/
 * maximize/restore go through window:minimize/maximize/close IPC (see
 * index.ts) rather than an OS-drawn titlebar.
 *
 * Note: isMaximized()/isMinimized() only reflect anything real when an
 * actual window manager is enforcing that state — under this dev sandbox's
 * bare Xvfb (no WM at all), calling win.maximize()/minimize() is a no-op as
 * far as the OS is concerned, so those getters can't be used to verify
 * behavior here. What's actually TesterBrowser's own responsibility — and
 * what these tests verify instead — is: (a) the custom titlebar calls
 * through to the right window method, and (b) the titlebar's icon/title
 * correctly track whatever maximized state the main process reports via
 * window:maximizedChanged, independent of whether a given OS/WM actually
 * enforces it. Both hold equally well on the real windows-2022 CI runner,
 * where a real WM does enforce it.
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

test('starts neither minimized nor maximized, with the maximize icon showing', async () => {
  await expect(window.locator('#winMaxIcon')).toBeVisible();
  await expect(window.locator('#winRestoreIcon')).toBeHidden();
  await expect(window.locator('#winMaxBtn')).toHaveAttribute('title', 'Maximize');
});

test('clicking the maximize button calls through to BrowserWindow.maximize()', async () => {
  // Stubbed out entirely (not delegating to the real method) — under this
  // sandbox's WM-less Xvfb, actually invoking native maximize()/minimize()
  // has follow-on effects (native window events firing at unpredictable
  // times) that would make the later window:maximizedChanged test flaky.
  // All that matters here is that the click reaches the right method.
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    (win as any).__maximizeCalled = false;
    win.maximize = (() => { (win as any).__maximizeCalled = true; }) as any;
  });
  await window.click('#winMaxBtn');
  const called = await app.evaluate(({ BrowserWindow }) => (BrowserWindow.getAllWindows()[0] as any).__maximizeCalled);
  expect(called).toBe(true);
});

test('the titlebar icon and title track window:maximizedChanged regardless of OS/WM support', async () => {
  // Drive the exact IPC channel index.ts's own 'maximize'/'unmaximize'
  // BrowserWindow listeners send, so this exercises the app's real wiring
  // (main → preload → renderer) without depending on a window manager to
  // actually enforce the maximized state.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('window:maximizedChanged', true);
  });
  await expect(window.locator('#winMaxIcon')).toBeHidden();
  await expect(window.locator('#winRestoreIcon')).toBeVisible();
  await expect(window.locator('#winMaxBtn')).toHaveAttribute('title', 'Restore');

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('window:maximizedChanged', false);
  });
  await expect(window.locator('#winMaxIcon')).toBeVisible();
  await expect(window.locator('#winRestoreIcon')).toBeHidden();
  await expect(window.locator('#winMaxBtn')).toHaveAttribute('title', 'Maximize');

  // The rest of the chrome must still be fully functional through a resize
  // cycle — tab strip and toolbar aren't just visually present but working.
  await expect(window.locator('#tabs')).toBeVisible();
  await window.click('#newSessionBtn');
  const sessions: Array<{ id: string }> = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  expect(sessions.length).toBeGreaterThanOrEqual(2);
});

test('clicking the minimize button calls through to BrowserWindow.minimize()', async () => {
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    (win as any).__minimizeCalled = false;
    win.minimize = (() => { (win as any).__minimizeCalled = true; }) as any;
  });
  await window.click('#winMinBtn');
  const called = await app.evaluate(({ BrowserWindow }) => (BrowserWindow.getAllWindows()[0] as any).__minimizeCalled);
  expect(called).toBe(true);
});
