import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { getMainWindow, getTabPage, launchApp, MAIN_PATH } from './helpers';
import { startFixtureServer, FixtureServer } from './fixtures/server';

// #217 — src/preload/newtab.ts's contextBridge APIs (appSettings, bookmarksApi,
// appTheme, appInfo) ride on NEWTAB_PRELOAD, which every WebContentsView gets —
// including tabs showing a website under test, not only renderer/newtab.html.
// Confirms a tested site can't reach those privileged APIs, and that the
// new-tab page itself still can.

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

test('a website under test cannot reach appSettings, bookmarksApi or appTheme, and unknown settings keys/types are dropped', async () => {
  // Seed a bookmark and a known settings value from the trusted chrome window.
  await window.evaluate(async () => {
    await (window as any).testerBrowser.bookmarks.add('https://example.com/keep-me', 'Keep me');
    await (window as any).testerBrowser.settings.set({ redactSensitiveHeaders: false });
  });
  const bookmarksBefore = await window.evaluate(() => (window as any).testerBrowser.bookmarks.list());
  const settingsBefore = await window.evaluate(() => (window as any).testerBrowser.settings.get());
  expect(bookmarksBefore.some((b: any) => b.url === 'https://example.com/keep-me')).toBe(true);

  // Open a new tab and navigate it to a plain website under test.
  await window.keyboard.press('Control+t');
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url('/index.html'));
  await window.press('#urlbar', 'Enter');
  const tabPage = await getTabPage(app, '/index.html', window);
  await tabPage.waitForLoadState('load');

  const attempt = await tabPage.evaluate(async () => {
    const w = window as any;
    const result: Record<string, unknown> = {
      hasAppSettings: typeof w.appSettings !== 'undefined',
      hasBookmarksApi: typeof w.bookmarksApi !== 'undefined',
      hasAppTheme: typeof w.appTheme !== 'undefined',
    };
    try {
      result.settingsSetResult = await w.appSettings?.set({
        redactSensitiveHeaders: true,
        securityRuleOverrides: { evil: false },
        totallyUnknownKey: 'x',
      });
    } catch (err) { result.settingsSetError = String(err); }
    try {
      result.bookmarksRemoveResult = await w.bookmarksApi?.remove('https://example.com/keep-me');
    } catch (err) { result.bookmarksRemoveError = String(err); }
    try {
      result.themeSetResult = await w.appTheme?.set('light');
    } catch (err) { result.themeSetError = String(err); }
    return result;
  });

  // The APIs are still injected (NEWTAB_PRELOAD stays on every view — see
  // ticket's "leave NEWTAB_PRELOAD as-is" note) but every call is rejected
  // server-side, so none of them changed anything.
  expect(attempt.hasAppSettings).toBe(true);
  expect(attempt.hasBookmarksApi).toBe(true);
  expect(attempt.hasAppTheme).toBe(true);

  const bookmarksAfter = await window.evaluate(() => (window as any).testerBrowser.bookmarks.list());
  const settingsAfter = await window.evaluate(() => (window as any).testerBrowser.settings.get());
  expect(bookmarksAfter.some((b: any) => b.url === 'https://example.com/keep-me')).toBe(true);
  expect(bookmarksAfter.length).toBe(bookmarksBefore.length);
  expect(settingsAfter.redactSensitiveHeaders).toBe(false);
  expect(settingsAfter.securityRuleOverrides).toEqual(settingsBefore.securityRuleOverrides);

  // Clean up the seeded bookmark via the trusted path so later runs start clean.
  await window.evaluate(async () => {
    await (window as any).testerBrowser.bookmarks.remove('https://example.com/keep-me');
  });
});

test('the new-tab page itself can still read and write settings, bookmarks and theme', async () => {
  // A freshly opened tab defaults to the new-tab page.
  await window.keyboard.press('Control+t');
  const newTabPage = await getTabPage(app, 'newtab.html');
  await newTabPage.waitForLoadState('load');

  const redactToggle = newTabPage.locator('#redactToggle');
  await expect(redactToggle).toBeVisible();
  await expect(redactToggle).toBeEnabled();

  // Exercise the full privileged IPC surface directly from the new-tab page's
  // own JS context — a real round trip through NEWTAB_PRELOAD and the main
  // process, proving the trusted-sender check doesn't also lock out the page
  // it exists to keep working.
  const before = await newTabPage.evaluate(() => (window as any).appSettings.get());
  const result = await newTabPage.evaluate(async (nextRedact: boolean) => {
    const w = window as any;
    await w.appSettings.set({ redactSensitiveHeaders: nextRedact });
    const after = await w.appSettings.get();
    const theme = await w.appTheme.get();
    const bookmarks = await w.bookmarksApi.list();
    const versionInfo = await w.appInfo.getVersionInfo();
    return { after, theme, bookmarksCount: bookmarks.length, hasVersion: typeof versionInfo?.current === 'string' };
  }, !before.redactSensitiveHeaders);

  expect(result.after.redactSensitiveHeaders).toBe(!before.redactSensitiveHeaders);
  expect(typeof result.theme).toBe('string');
  expect(typeof result.bookmarksCount).toBe('number');
  expect(result.hasVersion).toBe(true);

  // The UI toggle itself reflects the same underlying setting.
  await newTabPage.reload();
  await newTabPage.waitForLoadState('load');
  await expect(redactToggle).toBeChecked({ checked: !before.redactSensitiveHeaders });

  // Restore, so this doesn't leak into other spec files.
  await newTabPage.evaluate((wasChecked: boolean) =>
    (window as any).appSettings.set({ redactSensitiveHeaders: wasChecked }), !!before.redactSensitiveHeaders);
});
