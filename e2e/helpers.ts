import fs from 'fs';
import os from 'os';
import path from 'path';
import { _electron as electron, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

/**
 * Every spec file launches its own Electron instance in beforeAll and closes
 * it in afterAll, on the assumption that each file starts from a clean slate.
 * But run without an explicit --user-data-dir, Electron falls back to a
 * fixed, shared profile directory (e.g. ~/.config/Electron on Linux, keyed
 * off the default app name, not this project) — the same directory every
 * spec file's launch uses, and the same one a previous `playwright test`
 * invocation on this machine used too. TesterBrowser persists its open tabs
 * (open-sessions.json — see sessionManager.ts saveSessions/loadAndRestoreSessions)
 * and other state to that profile, so real state from one spec file (or a
 * stale run from hours earlier) silently carries into the next launch:
 * "initial tab is present on startup" expects exactly one tab, but restores
 * however many a previous run left behind. This is what actually produced
 * the intermittent, run-order-dependent failures in diff.spec.ts,
 * followalong.spec.ts and app.spec.ts's cookie/session-count assertions when
 * the full suite ran sequentially — not raw CPU contention. Give every
 * launch its own throwaway profile directory so no state survives between
 * spec files, let alone between separate test runs. (Supersedes destroying
 * extra sessions in afterAll as a per-file mitigation — with an isolated
 * profile per launch there's no shared open-sessions.json left to compound.)
 */
// #249: each launch also gets its own throwaway downloads folder — without
// this, parallel workers (and the developer's own machine) would all share
// app.getPath('downloads'), the real OS Downloads folder. DownloadManager
// reads app.getPath('downloads') fresh on every will-download (not once at
// startup — see downloadManager.ts), so a post-launch setPath takes effect
// for every download this launch triggers. Both temp dirs are removed when
// the returned app closes (best-effort — Windows can briefly hold a lock on
// a just-closed process's own files).
export async function launchApp(mainPath: string): Promise<ElectronApplication> {
  const userDataDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'testerbrowser-e2e-'));
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testerbrowser-e2e-downloads-'));
  const app = await electron.launch({
    args: [`--user-data-dir=${userDataDir}`, mainPath],
  });
  await app.evaluate(({ app: electronApp }, dir) => electronApp.setPath('downloads', dir), downloadsDir);
  wrapCloseForCleanup(app, [userDataDir, downloadsDir]);
  return app;
}

/** Shared by launchApp() and any spec that hand-rolls its own launch with an
 *  ad-hoc temp profile (crash-report.spec.ts, tests.spec.ts) — wraps the
 *  app's own close() so the given directories are removed once it exits,
 *  without changing close()'s signature or any call site. */
export function wrapCloseForCleanup(app: ElectronApplication, dirs: string[]): void {
  const originalClose = app.close.bind(app);
  app.close = async () => {
    await originalClose();
    for (const dir of dirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  };
}

/** Path to the built main-process entry point, for use with launchApp(). */
export const MAIN_PATH = path.join(__dirname, '..', 'dist', 'main', 'index.js');

/**
 * electronApp.firstWindow() resolves to whichever renderer target Playwright
 * observes first. The default session's WebContentsView (newtab.html) is
 * created moments after the main BrowserWindow (index.html), and that race
 * occasionally makes firstWindow() return the tab content instead of the
 * app's own chrome — surfacing as e.g. document.title reading "New Tab"
 * instead of "TesterBrowser". Wait explicitly for the chrome window instead.
 */
export async function getMainWindow(app: ElectronApplication, maxWaitMs = 20_000): Promise<Page> {
  await app.firstWindow();
  const isChrome = (p: Page) => p.url().endsWith('index.html');
  const already = app.windows().find(isChrome);
  if (already) return already;
  return app.waitForEvent('window', { predicate: isChrome, timeout: maxWaitMs });
}

/**
 * Each browser tab is its own WebContentsView — a separate Playwright Page,
 * not an element inside the chrome window's DOM (see getMainWindow above).
 * Anything a loaded page renders (buttons, forms, ...) has to be driven
 * through the Page this returns, not through the chrome `window`.
 */
export async function getTabPage(app: ElectronApplication, urlIncludes: string, exclude?: Page): Promise<Page> {
  // Unlike getMainWindow above, this can't just wait for a 'window' creation
  // event: the common case is an *existing* tab navigating to urlIncludes
  // (e.g. via the urlbar), not a brand-new one appearing — so the match has
  // to be re-checked against the live window list over time, which is
  // exactly what expect.poll does instead of a hand-rolled setTimeout loop.
  const find = () => app.windows().find(p => p.url().includes(urlIncludes) && p !== exclude) ?? null;
  await expect.poll(find, {
    timeout: 20_000,
    message: `No tab page found with URL including "${urlIncludes}"`,
  }).not.toBeNull();
  return find() as Page;
}

/**
 * Bounds of the active session's native WebContentsView, straight from
 * Electron's contentView tree in the main process. Returns null while the
 * view is detached (e.g. mid dropdown-overlay — see layout.js
 * beginPageOverlay/endPageOverlay), which callers can use as the "detached"
 * signal itself.
 */
export async function getActiveViewBounds(
  app: ElectronApplication
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return null;
    const child = win.contentView.children.find((c) => 'webContents' in c);
    return child ? child.getBounds() : null;
  });
}

/**
 * Triggers a tab's double-click-to-rename handler (tabs.js's startRename())
 * by dispatching a 'dblclick' event directly, instead of Playwright's native
 * two-click .dblclick(). What these tests care about is the app's own
 * rename logic — not whether Chromium's input pipeline recognizes two
 * synthetic clicks as a double-click, which depends on both clicks landing
 * within its own timing threshold and has proven unreliable (consistently,
 * not just occasionally) on CI. Dispatching the event directly is
 * deterministic and exercises the same ondblclick handler a real
 * double-click would.
 */
export async function dblclickTabName(win: Page, dataId: string): Promise<void> {
  await win.locator(`.tab[data-id="${dataId}"] .tab-name`).evaluate((el) => {
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  });
}
