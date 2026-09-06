import type { ElectronApplication, Page } from '@playwright/test';

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
  for (let i = 0; i < 50; i++) {
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
export async function getTabPage(app: ElectronApplication, urlIncludes: string): Promise<Page> {
  for (let i = 0; i < 50; i++) {
    const found = app.windows().find(p => p.url().includes(urlIncludes));
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`No tab page found with URL including "${urlIncludes}"`);
}
