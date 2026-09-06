import fs from 'fs';
import os from 'os';
import path from 'path';
import { _electron as electron } from '@playwright/test';
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
export async function launchApp(mainPath: string): Promise<ElectronApplication> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testerbrowser-e2e-'));
  return electron.launch({
    args: [`--user-data-dir=${userDataDir}`, mainPath],
  });
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
export async function getMainWindow(app: ElectronApplication): Promise<Page> {
  await app.firstWindow();
  const isChrome = (p: Page) => p.url().endsWith('index.html');
  for (let i = 0; i < 100; i++) {
    const found = app.windows().find(isChrome);
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return app.firstWindow();
}

/**
 * Each browser tab is its own WebContentsView — a separate Playwright Page,
 * not an element inside the chrome window's DOM (see getMainWindow above).
 * Anything a loaded page renders (buttons, forms, ...) has to be driven
 * through the Page this returns, not through the chrome `window`.
 */
export async function getTabPage(app: ElectronApplication, urlIncludes: string, exclude?: Page): Promise<Page> {
  for (let i = 0; i < 100; i++) {
    const found = app.windows().find(p => p.url().includes(urlIncludes) && p !== exclude);
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`No tab page found with URL including "${urlIncludes}"`);
}
