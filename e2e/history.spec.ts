import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { getMainWindow, getTabPage, launchApp, MAIN_PATH } from './helpers';
import { startFixtureServer, FixtureServer } from './fixtures/server';

// The session context menu's "History…" item can't be driven here — it's a
// native OS menu, same limitation noted in shortcuts.spec.ts — so these tests
// exercise the underlying testerBrowser.sessions.getHistory API directly
// (like app.spec.ts does for cookies/localStorage) and, for the panel UI
// itself, invoke history.js's openHistory() via a dynamic import in the
// chrome window's own module context, which is what the real menu action
// calls under the hood.

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

// Creates a new tab through the real UI flow (not a raw sessions.create()
// IPC call) so the renderer's own active-tab bookkeeping — which the urlbar
// Enter handler reads to know which session to navigate — stays in sync.
async function newSessionTab(): Promise<string> {
  const before = await window.locator('.tab').count();
  const pagesBefore = new Set(app.windows());
  await window.click('#newSessionBtn');
  await expect.poll(() => window.locator('.tab').count()).toBe(before + 1);

  // A new session's WebContentsView starts loading newtab.html the moment it
  // is created. Driving the URL bar before that initial load commits lets it
  // land *after* our loadURL and overwrite it, leaving the tab sitting on
  // newtab.html — so the navigated-to page never appears and getTabPage()
  // times out. Wait for the new view's own load to settle first.
  await expect.poll(() => app.windows().some(p => !pagesBefore.has(p))).toBe(true);
  const created = app.windows().find(p => !pagesBefore.has(p));
  await created?.waitForLoadState('load');

  return window.locator('.tab.active').getAttribute('data-id') as unknown as Promise<string>;
}

// Several tests below navigate to the same fixture paths, and getTabPage()
// matches by URL substring across every still-open tab in the shared
// Electron instance (nothing here closes tabs between tests) — a nonce query
// param keeps each call's URL unique so it can't resolve to a stale tab page
// left open by an earlier test.
let navCounter = 0;
async function navigateActive(urlPath: string): Promise<void> {
  const uniquePath = `${urlPath}?t=${Date.now()}-${navCounter++}`;
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(uniquePath));
  await window.press('#urlbar', 'Enter');
  await (await getTabPage(app, uniquePath)).waitForLoadState('load');
}

test('navigating a session records visited URLs, newest first', async () => {
  const id = await newSessionTab();

  await navigateActive('/console/logs.html');
  await navigateActive('/storage/localstorage.html');

  const history = await window.evaluate((sid: string) => (window as any).testerBrowser.sessions.getHistory(sid), id);
  expect(history.length).toBeGreaterThanOrEqual(2);
  expect(history[0].url).toContain('/storage/localstorage.html');
  expect(history[1].url).toContain('/console/logs.html');
});

test('a failed navigation is recorded and marked as failed', async () => {
  const id = await newSessionTab();
  await window.evaluate(
    (sid: string) => (window as any).testerBrowser.sessions.navigate(sid, 'http://127.0.0.1:1/unreachable'),
    id
  );
  await window.waitForTimeout(1_000);

  const history = await window.evaluate((sid: string) => (window as any).testerBrowser.sessions.getHistory(sid), id);
  const failedEntry = history.find((h: { url: string; failed?: boolean }) => h.url.includes('unreachable'));
  expect(failedEntry?.failed).toBe(true);
});

test('History panel lists entries and clicking one navigates there', async () => {
  const id = await newSessionTab();

  await navigateActive('/console/logs.html');
  await navigateActive('/storage/localstorage.html');

  await window.evaluate(async (sid: string) => {
    const mod = await import('./history.js');
    await mod.openHistory(sid);
  }, id);

  await expect(window.locator('#historyOverlay')).toHaveClass(/open/);
  const entries = window.locator('.history-entry');
  await expect(entries).toHaveCount(2);

  // Entries are newest-first; index 1 is the earlier /console/logs.html page.
  const targetUrl = await entries.nth(1).getAttribute('data-url');
  expect(targetUrl).toContain('/console/logs.html');
  await entries.nth(1).click();

  await expect(window.locator('#historyOverlay')).not.toHaveClass(/open/);
  await expect.poll(() => window.inputValue('#urlbar')).toBe(targetUrl);
});

test('history clears when the session is destroyed', async () => {
  const id = await newSessionTab();
  await navigateActive('/console/logs.html');

  let history = await window.evaluate((sid: string) => (window as any).testerBrowser.sessions.getHistory(sid), id);
  expect(history.length).toBeGreaterThan(0);

  await window.evaluate((sid: string) => (window as any).testerBrowser.sessions.destroy(sid), id);
  history = await window.evaluate((sid: string) => (window as any).testerBrowser.sessions.getHistory(sid), id);
  expect(history.length).toBe(0);
});
