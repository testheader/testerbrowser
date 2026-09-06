/**
 * #16 — cross-session cookie/storage isolation, and #17 — contextIsolation
 * blocking a page from reaching Node/require/process. Both are core
 * sandboxing guarantees of the "each tab is its own Electron session
 * partition" design (see CLAUDE.md) and the WebContentsView's webPreferences
 * (contextIsolation: true, sandbox: true, nodeIntegration implicitly off).
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

test('cookies and localStorage set in one session are invisible in another, same-origin session', async () => {
  const normalId: string = await window.evaluate(() => (window as any).testerBrowser.sessions.create('Normal', { persistent: true }));
  const privateId: string = await window.evaluate(() => (window as any).testerBrowser.sessions.create('Private', { persistent: false }));

  await window.evaluate((id) => (window as any).testerBrowser.sessions.switchTo(id), normalId);
  await window.evaluate(
    ({ id, url }) => (window as any).testerBrowser.sessions.navigate(id, url),
    { id: normalId, url: fixtures.url('/') }
  );
  const normalPage = await getTabPage(app, '127.0.0.1', undefined);
  await normalPage.waitForLoadState('domcontentloaded');
  await normalPage.evaluate(() => {
    document.cookie = 'iso_test=normal-session-value; path=/';
    localStorage.setItem('iso_key', 'normal-session-value');
  });

  await window.evaluate((id) => (window as any).testerBrowser.sessions.switchTo(id), privateId);
  await window.evaluate(
    ({ id, url }) => (window as any).testerBrowser.sessions.navigate(id, url),
    { id: privateId, url: fixtures.url('/') }
  );
  const privatePage = await getTabPage(app, '127.0.0.1', normalPage);
  await privatePage.waitForLoadState('domcontentloaded');

  const privateView = await privatePage.evaluate(() => ({ cookie: document.cookie, ls: localStorage.getItem('iso_key') }));
  expect(privateView.cookie).not.toContain('iso_test');
  expect(privateView.ls).toBeNull();

  // Confirm the original session's data is still intact (isolation isn't
  // just "both empty" — it's "each keeps its own").
  const normalView = await normalPage.evaluate(() => ({ cookie: document.cookie, ls: localStorage.getItem('iso_key') }));
  expect(normalView.cookie).toContain('iso_test=normal-session-value');
  expect(normalView.ls).toBe('normal-session-value');

  // And the app-level cookie API (Storage tab's data source) agrees.
  const cookiesForPrivate: Array<{ name: string }> = await window.evaluate(
    (id) => (window as any).testerBrowser.sessions.getCookies(id), privateId
  );
  expect(cookiesForPrivate.some((c) => c.name === 'iso_test')).toBe(false);
  const cookiesForNormal: Array<{ name: string }> = await window.evaluate(
    (id) => (window as any).testerBrowser.sessions.getCookies(id), normalId
  );
  expect(cookiesForNormal.some((c) => c.name === 'iso_test')).toBe(true);
});

test('contextIsolation blocks a page from reaching require/process/module', async () => {
  await window.click('#newSessionBtn');
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url('/'));
  await window.press('#urlbar', 'Enter');
  const tabPage = await getTabPage(app, '127.0.0.1');
  await tabPage.waitForLoadState('domcontentloaded');

  const leaked = await tabPage.evaluate(() => ({
    require: typeof (window as any).require,
    process: typeof (window as any).process,
    module:  typeof (window as any).module,
    exports: typeof (window as any).exports,
    __dirname: typeof (window as any).__dirname,
    testerBrowser: typeof (window as any).testerBrowser, // the chrome-only API must not leak into page content either
  }));

  expect(leaked).toEqual({
    require: 'undefined',
    process: 'undefined',
    module: 'undefined',
    exports: 'undefined',
    __dirname: 'undefined',
    testerBrowser: 'undefined',
  });
});

test('a page attempting to redefine require via the prototype chain still cannot reach Node internals', async () => {
  const tabPage = await getTabPage(app, '127.0.0.1');
  // A "malicious" page trying common tricks to smuggle in Node access.
  const result = await tabPage.evaluate(() => {
    try {
      // @ts-expect-error - deliberately probing for a leak
      const ctor = (function () {}).constructor;
      const fn = ctor('return typeof process');
      return { probed: fn() };
    } catch (e) {
      return { error: String(e) };
    }
  });
  // Either the probe runs and still finds no `process` (sandboxed renderer,
  // no Node integration), or it throws — both are acceptable; what must
  // never happen is it actually resolving to Node's real process object.
  expect(result.probed).not.toBe('object');
});
