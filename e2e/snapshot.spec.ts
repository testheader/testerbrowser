import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
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

  // Export/Import snapshot are only reachable from a tab's native right-click
  // context menu (sessionManager.ts's showContextMenu(), which calls
  // Menu.buildFromTemplate(...).popup()) — there's no HTML button or IPC
  // channel to drive directly, and no way to interact with a real native
  // menu through Playwright. Replace Menu.buildFromTemplate for the whole
  // run: capture the template instead of ever popping a real menu, so tests
  // can invoke a specific item's click() handler directly — the same
  // approach fixtures.spec.ts uses to stub dialog.showSaveDialog instead of
  // driving a real save dialog.
  await app.evaluate(({ Menu, dialog }) => {
    Menu.buildFromTemplate = ((template: unknown) => {
      (globalThis as unknown as { __lastMenuTemplate: unknown }).__lastMenuTemplate = template;
      return { popup: () => {}, closePopup: () => {} } as unknown as ReturnType<typeof Menu.buildFromTemplate>;
    }) as typeof Menu.buildFromTemplate;
    // The export sensitivity-warning confirm and the post-import/-export
    // warnings summary both use dialog.showMessageBox — auto-approve so a
    // real modal never blocks the (headless) app.
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

async function listSessions(): Promise<{ id: string; partition: string }[]> {
  return window.evaluate(() => (window as unknown as {
    testerBrowser: { sessions: { list(): Promise<{ id: string; partition: string }[]> } };
  }).testerBrowser.sessions.list());
}

test('export then import round-trips cookies (incl. sameSite) and seeds storage before the page\'s own bootstrap script runs (#243)', async () => {
  const urlPath = '/storage/localstorage.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const sourceTab = await getTabPage(app, urlPath);
  await sourceTab.waitForLoadState('load');
  await sourceTab.click('#seed'); // sets username/theme/lastVisit

  const sessionsBefore = await listSessions();
  const sourceId = sessionsBefore[0].id;
  const sourcePartition = sessionsBefore[0].partition;

  // A cookie with an explicit sameSite value — restoreSnapshot previously
  // dropped this field entirely on import.
  await app.evaluate(async ({ session: electronSession }, opts) => {
    await electronSession.fromPartition(opts.partition).cookies.set({
      url: opts.url, name: 'sscookie', value: 'v1', sameSite: 'strict',
    });
  }, { partition: sourcePartition, url: fixtures.url(urlPath) });

  const tmpPath = path.join(os.tmpdir(), `testerbrowser-e2e-snapshot-${Date.now()}.json`);
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath });
  }, tmpPath);

  await contextMenuClick(sourceId, 'Export snapshot…');
  await expect.poll(() => fs.existsSync(tmpPath), { timeout: 10_000 }).toBe(true);

  const snap = JSON.parse(fs.readFileSync(tmpPath, 'utf-8'));
  const cookie = snap.cookies.find((c: { name: string }) => c.name === 'sscookie');
  expect(cookie?.sameSite).toBe('strict');
  const mainFrame = snap.frames.find((f: { url: string }) => f.url.includes(urlPath));
  expect(mainFrame?.localStorage?.username).toBe('tester');

  // Import into a brand-new, unrelated tab.
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [filePath] });
  }, tmpPath);

  await window.click('#newSessionBtn');
  const sessionsAfterNew = await listSessions();
  const target = sessionsAfterNew.find((s) => s.id !== sourceId)!;
  await window.click(`.tab[data-id="${target.id}"] .tab-name`);

  await contextMenuClick(target.id, 'Import snapshot…');

  const importedTab = await getTabPage(app, urlPath, sourceTab);
  await importedTab.waitForLoadState('load');

  // Storage must already be present in the page's FIRST render — not only
  // after a manual "Refresh view" click — proving it was seeded before the
  // page's own bootstrap script ran (the #243 ordering fix), not applied
  // only after loadURL/did-finish-load like the pre-fix behavior did.
  await expect(importedTab.locator('#ls')).toContainText('"username": "tester"', { timeout: 10_000 });
  await expect(importedTab.locator('#ls')).toContainText('"theme": "dark"');

  const importedCookies = await app.evaluate(async ({ session: electronSession }, part) =>
    electronSession.fromPartition(part).cookies.get({ name: 'sscookie' }), target.partition);
  expect((importedCookies as { sameSite?: string }[])[0]?.sameSite).toBe('strict');

  fs.rmSync(tmpPath, { force: true });
});

test('a write failure during export shows an error dialog instead of throwing (#243)', async () => {
  const sessions = await listSessions();
  const sourceId = sessions[0].id;

  // A path inside a directory that doesn't exist — a real, deterministic
  // fs.writeFileSync failure (ENOENT), not a stubbed throw.
  const badPath = path.join(os.tmpdir(), `testerbrowser-e2e-missing-dir-${Date.now()}`, 'snapshot.json');
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath });
  }, badPath);

  await app.evaluate(({ dialog }) => {
    (globalThis as unknown as { __showErrorBoxCalls: { title: string; content: string }[] }).__showErrorBoxCalls = [];
    dialog.showErrorBox = (title: string, content: string) => {
      (globalThis as unknown as { __showErrorBoxCalls: { title: string; content: string }[] }).__showErrorBoxCalls.push({ title, content });
    };
  });

  await contextMenuClick(sourceId, 'Export snapshot…');

  await expect.poll(async () => {
    const calls = await app.evaluate(() =>
      (globalThis as unknown as { __showErrorBoxCalls?: { title: string }[] }).__showErrorBoxCalls ?? []);
    return calls.some((c) => c.title === 'Export failed');
  }, { timeout: 10_000 }).toBe(true);

  expect(fs.existsSync(badPath)).toBe(false);
});
