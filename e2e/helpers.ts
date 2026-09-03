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
