import fs from 'fs';
import os from 'os';
import path from 'path';
import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { getMainWindow, launchApp, MAIN_PATH, wrapCloseForCleanup } from './helpers';

let app: ElectronApplication;
let window: Page;

// Notes… (and "New tab in this session") are only reachable from a tab's
// native right-click context menu (sessionManager.ts's showContextMenu(),
// which calls Menu.buildFromTemplate(...).popup()) — there's no way to
// interact with a real native menu through Playwright. Replace
// Menu.buildFromTemplate for the given app instance: capture the template
// instead of ever popping a real menu, so a test can invoke a specific
// item's click() handler directly. Same approach as snapshot.spec.ts.
type MenuItem = { label?: string; click?: () => unknown };

async function stubContextMenu(electronApp: ElectronApplication) {
  await electronApp.evaluate(({ Menu }) => {
    Menu.buildFromTemplate = ((template: unknown) => {
      (globalThis as unknown as { __lastMenuTemplate: unknown }).__lastMenuTemplate = template;
      return { popup: () => {}, closePopup: () => {} } as unknown as ReturnType<typeof Menu.buildFromTemplate>;
    }) as typeof Menu.buildFromTemplate;
  });
}

async function contextMenuClick(win: Page, electronApp: ElectronApplication, sessionId: string, label: string) {
  await win.evaluate((id) => (window as unknown as {
    testerBrowser: { sessions: { contextMenu(id: string): Promise<void> } };
  }).testerBrowser.sessions.contextMenu(id), sessionId);

  await electronApp.evaluate(async ({}, itemLabel) => {
    const template = (globalThis as unknown as { __lastMenuTemplate?: MenuItem[] }).__lastMenuTemplate;
    const item = template?.find((i) => i.label === itemLabel);
    if (!item?.click) throw new Error(`Menu item "${itemLabel}" not found or has no click handler`);
    await item.click();
  }, label);
}

test.beforeAll(async () => {
  app = await launchApp(MAIN_PATH);
  window = await getMainWindow(app);
  await window.waitForLoadState('load');
  await stubContextMenu(app);
});

test.afterAll(async () => {
  await app.close();
});

test('two tabs sharing a partition ("New tab in this session") keep independent notes across a restart (#268)', async () => {
  // A dedicated instance sharing one profile dir across two sequential
  // launches — unlike the file's shared `app`/`window`, which uses its own
  // isolated profile and would otherwise carry state between test files.
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testerbrowser-e2e-notes-'));

  const app1 = await electron.launch({ args: [`--user-data-dir=${userDataDir}`, MAIN_PATH] });
  const win1 = await getMainWindow(app1);
  await win1.waitForLoadState('load');
  await stubContextMenu(app1);

  const sessionsBefore = await win1.evaluate(() => (window as any).testerBrowser.sessions.list());
  const tabAId = sessionsBefore[0].id; // the default, already-persistent tab

  await contextMenuClick(win1, app1, tabAId, 'New tab in this session');
  await expect.poll(() => win1.locator('.tab').count()).toBe(2);
  const sessionsAfter = await win1.evaluate(() => (window as any).testerBrowser.sessions.list());
  const tabA = sessionsAfter.find((s: { id: string }) => s.id === tabAId);
  const tabB = sessionsAfter.find((s: { id: string }) => s.id !== tabAId);
  expect(tabB.partition).toBe(tabA.partition); // sharing a partition is the whole point of this test

  await win1.evaluate(
    ({ aId, bId }) => Promise.all([
      (window as any).testerBrowser.sessions.setNotes(aId, 'note for A'),
      (window as any).testerBrowser.sessions.setNotes(bId, 'note for B'),
    ]),
    { aId: tabAId, bId: tabB.id }
  );

  await app1.close(); // triggers before-quit -> saveSessions()

  const app2 = await electron.launch({ args: [`--user-data-dir=${userDataDir}`, MAIN_PATH] });
  // Only the second (last) launch's close should remove the shared profile
  // dir — app1's own close above must leave it in place for app2 to reuse.
  wrapCloseForCleanup(app2, [userDataDir]);
  const win2 = await getMainWindow(app2);
  await win2.waitForLoadState('load');
  await expect.poll(() => win2.locator('.tab').count()).toBe(2);

  const restoredSessions = await win2.evaluate(() => (window as any).testerBrowser.sessions.list());
  expect(restoredSessions).toHaveLength(2);
  const notes = await Promise.all(
    restoredSessions.map((s: { id: string }) => win2.evaluate(
      (id) => (window as any).testerBrowser.sessions.getNotes(id), s.id
    ))
  );
  expect(notes.sort()).toEqual(['note for A', 'note for B']);

  await app2.close();
});

test('closing the notes modal with unsaved text shows a discard confirm; Keep editing preserves it, Discard drops it', async () => {
  const sessions = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const id = sessions[0].id;
  await window.evaluate((sid) => (window as any).testerBrowser.sessions.setNotes(sid, 'original note'), id);

  await contextMenuClick(window, app, id, 'Notes…');
  const overlay = window.locator('#notesOverlay');
  await expect(overlay).toHaveClass(/open/);
  await expect(window.locator('#notesTextarea')).toHaveValue('original note');

  // No unsaved changes yet — Esc closes immediately, no confirm.
  await window.keyboard.press('Escape');
  await expect(overlay).not.toHaveClass(/open/);

  await contextMenuClick(window, app, id, 'Notes…');
  await window.fill('#notesTextarea', 'edited but not saved');
  await window.keyboard.press('Escape');

  const confirm = window.locator('#notesDiscardConfirm');
  await expect(confirm).toBeVisible();
  await expect(overlay).toHaveClass(/open/); // Esc did not close the modal itself

  await window.click('#notesKeepEditingBtn');
  await expect(confirm).toBeHidden();
  await expect(window.locator('#notesTextarea')).toHaveValue('edited but not saved');
  await expect(overlay).toHaveClass(/open/);

  // Try again and actually discard this time.
  await window.keyboard.press('Escape');
  await expect(confirm).toBeVisible();
  await window.click('#notesDiscardBtn');
  await expect(overlay).not.toHaveClass(/open/);

  const notesAfterDiscard = await window.evaluate((sid) => (window as any).testerBrowser.sessions.getNotes(sid), id);
  expect(notesAfterDiscard).toBe('original note'); // the discarded edit never got saved

  // Save still closes unconditionally, without the confirm ever appearing.
  await contextMenuClick(window, app, id, 'Notes…');
  await window.fill('#notesTextarea', 'saved for real');
  await window.click('#saveNotesBtn');
  await expect(overlay).not.toHaveClass(/open/);
  await expect(confirm).toBeHidden();

  const notesAfterSave = await window.evaluate((sid) => (window as any).testerBrowser.sessions.getNotes(sid), id);
  expect(notesAfterSave).toBe('saved for real');
});
