/**
 * #12 — tearing a tab off into its own native window. sessionManager.ts's
 * popOutSession() moves a session's WebContentsView into a brand-new,
 * OS-decorated BrowserWindow and drops it from this window's tab strip —
 * see the "Pop out to new window" tab context-menu entry, or the drag-down
 * gesture in tabs.js. Testing the deterministic IPC path (sessions.popOut)
 * rather than simulating a native drag gesture, which Playwright/Electron
 * can't reliably drive across window boundaries in CI.
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

test('popping out a tab opens a real second native window and removes it from this window\'s tab strip', async () => {
  await window.click('#newSessionBtn');
  const before: Array<{ id: string }> = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  expect(before.length).toBeGreaterThanOrEqual(2);
  const targetId = before[before.length - 1].id;

  const windowCountBefore = app.windows().length;

  await window.evaluate((id) => (window as any).testerBrowser.sessions.popOut(id), targetId);

  // A real, separate BrowserWindow now exists for the torn-off session.
  await expect.poll(() => app.windows().length).toBe(windowCountBefore + 1);
  const nativeWindowCount = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  expect(nativeWindowCount).toBe(2);

  // It's gone from this window's session list and tab strip...
  await expect.poll(async () => {
    const sessions: Array<{ id: string }> = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
    return sessions.some((s) => s.id === targetId);
  }).toBe(false);
  await expect(window.locator(`.tab[data-id="${targetId}"]`)).toHaveCount(0);

  // ...but the chrome window itself is still fully alive and usable.
  await expect(window.locator('#tabs')).toBeVisible();
  await window.click('#newSessionBtn');
  const after: Array<{ id: string }> = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  expect(after.length).toBe(before.length); // one popped out, one created back
});

test('a single remaining tab cannot be popped out (nothing left to tear off from)', async () => {
  // Close down to exactly one session first.
  const sessions: Array<{ id: string }> = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  for (const s of sessions.slice(1)) {
    await window.evaluate((id) => (window as any).testerBrowser.sessions.destroy(id), s.id);
  }
  const remaining: Array<{ id: string }> = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  expect(remaining).toHaveLength(1);

  const nativeWindowCountBefore = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  const result = await window.evaluate((id) => (window as any).testerBrowser.sessions.popOut(id), remaining[0].id);
  expect(result).toBeNull();

  const nativeWindowCountAfter = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  expect(nativeWindowCountAfter).toBe(nativeWindowCountBefore);
  const stillThere: Array<{ id: string }> = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  expect(stillThere).toHaveLength(1);
});
