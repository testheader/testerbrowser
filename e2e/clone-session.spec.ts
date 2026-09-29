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

  // "Clone" is only reachable from a tab's native right-click context menu
  // (sessionManager.ts's showContextMenu(), which calls
  // Menu.buildFromTemplate(...).popup()) — no HTML button or IPC channel to
  // drive directly, and no way to interact with a real native menu through
  // Playwright. Replace Menu.buildFromTemplate for the whole run: capture the
  // template instead of ever popping a real menu, so tests can invoke a
  // specific item's click() handler directly — the same approach
  // snapshot.spec.ts/notes.spec.ts use.
  await app.evaluate(({ Menu, dialog }) => {
    Menu.buildFromTemplate = ((template: unknown) => {
      (globalThis as unknown as { __lastMenuTemplate: unknown }).__lastMenuTemplate = template;
      return { popup: () => {}, closePopup: () => {} } as unknown as ReturnType<typeof Menu.buildFromTemplate>;
    }) as typeof Menu.buildFromTemplate;
    // showSnapshotWarnings() (reused by the Clone action for #269's
    // copy-failure warnings) pops a real modal via dialog.showMessageBox —
    // auto-dismiss so an unexpected warning never blocks the headless app.
    dialog.showMessageBox = (() => Promise.resolve({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox;
  });
});

test.afterAll(async () => {
  await app.close();
  await fixtures.close();
});

type MenuItem = { label?: string; click?: () => unknown };

async function contextMenuClick(sessionId: string, label: string) {
  await window.evaluate((id) => (window as unknown as {
    testerBrowser: { sessions: { contextMenu(id: string): Promise<void> } };
  }).testerBrowser.sessions.contextMenu(id), sessionId);

  await app.evaluate(async ({}, itemLabel) => {
    const template = (globalThis as unknown as { __lastMenuTemplate?: MenuItem[] }).__lastMenuTemplate;
    const item = template?.find((i) => i.label === itemLabel);
    if (!item?.click) throw new Error(`Menu item "${itemLabel}" not found or has no click handler`);
    await item.click();
  }, label);
}

async function listSessions(): Promise<{ id: string; partition: string; url: string }[]> {
  return window.evaluate(() => (window as unknown as {
    testerBrowser: { sessions: { list(): Promise<{ id: string; partition: string; url: string }[]> } };
  }).testerBrowser.sessions.list());
}

test('cloning a tab copies cookies (incl. sameSite), storage, emulation and navigates to the source URL (#269)', async () => {
  const urlPath = '/storage/localstorage.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const sourceTab = await getTabPage(app, urlPath);
  await sourceTab.waitForLoadState('load');
  await sourceTab.click('#seed');        // localStorage: username/theme/lastVisit
  await sourceTab.click('#seedSession'); // sessionStorage: tabOnly

  const before = await listSessions();
  const sourceId = before[0].id;
  const sourcePartition = before[0].partition;

  // A cookie with an explicit sameSite value — the pre-#269 clone dropped
  // this field entirely.
  await app.evaluate(async ({ session: electronSession }, opts) => {
    await electronSession.fromPartition(opts.partition).cookies.set({
      url: opts.url, name: 'cloneCookie', value: 'v1', sameSite: 'strict',
    });
  }, { partition: sourcePartition, url: fixtures.url(urlPath) });

  await window.evaluate((id) => (window as unknown as {
    testerBrowser: { emulation: { set(id: string, opts: { timezone: string }): Promise<unknown> } };
  }).testerBrowser.emulation.set(id, { timezone: 'Europe/Berlin' }), sourceId);

  await contextMenuClick(sourceId, 'Clone');

  const after = await listSessions();
  const cloneId = after.find((s) => !before.some((b) => b.id === s.id))?.id;
  expect(cloneId).toBeTruthy();
  const cloneSessionId = cloneId as string;

  // The clone navigated to the source's current URL.
  const cloneTab = await getTabPage(app, urlPath, sourceTab);
  await cloneTab.waitForLoadState('load');
  expect(cloneTab.url()).toContain(urlPath);

  const cloneLocalStorage = await window.evaluate((id) => (window as unknown as {
    testerBrowser: { sessions: { getLocalStorage(id: string): Promise<Record<string, string>> } };
  }).testerBrowser.sessions.getLocalStorage(id), cloneSessionId);
  expect(cloneLocalStorage.username).toBe('tester');
  expect(cloneLocalStorage.theme).toBe('dark');

  const cloneSessionStorage = await window.evaluate((id) => (window as unknown as {
    testerBrowser: { sessions: { getSessionStorage(id: string): Promise<Record<string, string>> } };
  }).testerBrowser.sessions.getSessionStorage(id), cloneSessionId);
  expect(cloneSessionStorage.tabOnly).toBeTruthy();

  const cloneCookies = await window.evaluate((id) => (window as unknown as {
    testerBrowser: { sessions: { getCookies(id: string): Promise<{ name: string; sameSite?: string }[]> } };
  }).testerBrowser.sessions.getCookies(id), cloneSessionId);
  expect(cloneCookies.find((c) => c.name === 'cloneCookie')?.sameSite).toBe('strict');

  const cloneEmulation = await window.evaluate((id) => (window as unknown as {
    testerBrowser: { emulation: { get(id: string): Promise<{ timezone?: string } | null> } };
  }).testerBrowser.emulation.get(id), cloneSessionId);
  expect(cloneEmulation?.timezone).toBe('Europe/Berlin');
});

test('cloning a tab still on the new-tab page produces a clone also on the new-tab page', async () => {
  const before = await listSessions();
  await window.evaluate(() => (window as unknown as {
    testerBrowser: { sessions: { create(name: string): Promise<string> } };
  }).testerBrowser.sessions.create('blank clone source'));
  const afterCreate = await listSessions();
  const blankId = afterCreate.find((s) => !before.some((b) => b.id === s.id))!.id;
  expect(afterCreate.find((s) => s.id === blankId)?.url).toBeFalsy();

  await contextMenuClick(blankId, 'Clone');

  const after = await listSessions();
  const cloneId = after.find((s) => !afterCreate.some((b) => b.id === s.id))?.id;
  expect(cloneId).toBeTruthy();
  expect(after.find((s) => s.id === cloneId)?.url).toBeFalsy();
});
