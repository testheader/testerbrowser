import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import type { ElectronApplication } from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getMainWindow, launchApp, MAIN_PATH } from './helpers';

let app: Awaited<ReturnType<typeof electron.launch>>;
let page: Awaited<ReturnType<typeof app.firstWindow>>;

test.beforeAll(async () => {
  app = await launchApp(MAIN_PATH);
  page = await getMainWindow(app);
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app.close();
});

test('Debug mode toggle exists in Settings and flipping it persists through settings:get', async () => {
  await page.evaluate(() => (window as any).testerBrowser.settings.set({ debugMode: false }));
  const before = await page.evaluate(() => (window as any).testerBrowser.settings.get());
  expect(before.debugMode).toBe(false);

  await page.click('#appName');
  await page.click('#appMenuSettings');
  await expect(page.locator('#settingsOverlay')).toHaveClass(/open/);
  await expect(page.locator('#debugModeToggle')).not.toBeChecked();
  // The checkbox itself is visually hidden by .toggle-switch (opacity/size
  // zeroed out — only the sibling .toggle-slider is rendered), so Playwright
  // won't treat it as clickable; click the visible slider instead, same as a
  // real user would.
  await page.locator('#debugModeToggle + .toggle-slider').click();
  await expect(page.locator('#debugModeToggle')).toBeChecked();

  // Persisted immediately via settings:set, same round-trip security.spec.ts
  // uses to prove securityRuleOverrides persistence.
  const after = await page.evaluate(() => (window as any).testerBrowser.settings.get());
  expect(after.debugMode).toBe(true);

  await page.locator('#settingsCloseXBtn').click();
  // Reset for later tests in this file.
  await page.evaluate(() => (window as any).testerBrowser.settings.set({ debugMode: false }));
});

// #229
test('Recording settings inputs exist, set via the modal reach settings:get, and an out-of-range value is clamped', async () => {
  await page.evaluate(() => (window as any).testerBrowser.settings.set({ recorderMaxEvents: 20000, recordingRetentionDays: 30 }));

  await page.click('#appName');
  await page.click('#appMenuSettings');
  await expect(page.locator('#settingsOverlay')).toHaveClass(/open/);
  await expect(page.locator('#recorderMaxEventsInput')).toHaveValue('20000');
  await expect(page.locator('#recordingRetentionDaysInput')).toHaveValue('30');

  await page.fill('#recorderMaxEventsInput', '75000');
  await page.locator('#recorderMaxEventsInput').blur();
  await expect(async () => {
    const settings = await page.evaluate(() => (window as any).testerBrowser.settings.get());
    expect(settings.recorderMaxEvents).toBe(75000);
  }).toPass({ timeout: 5_000 });

  // A value below the 1,000 floor is clamped up to it, both in the stored
  // setting and reflected back into the input itself.
  await page.fill('#recorderMaxEventsInput', '50');
  await page.locator('#recorderMaxEventsInput').blur();
  await expect(page.locator('#recorderMaxEventsInput')).toHaveValue('1000', { timeout: 5_000 });
  const clamped = await page.evaluate(() => (window as any).testerBrowser.settings.get());
  expect(clamped.recorderMaxEvents).toBe(1000);

  await page.locator('#settingsCloseXBtn').click();
  // Reset for later tests in this file.
  await page.evaluate(() => (window as any).testerBrowser.settings.set({ recorderMaxEvents: 20000, recordingRetentionDays: 30 }));
});

test('Debug Log tab shows the disabled empty state when debug mode is off', async () => {
  await page.evaluate(() => (window as any).testerBrowser.settings.set({ debugMode: false }));
  await page.click('#consoleTabDebugLog');
  await expect(page.locator('#debugLogPanel')).toBeVisible();
  await expect(page.locator('#debugLogList')).toContainText('Debug mode is off');
});

test('Debug Log tab lists a reported error when debug mode is on', async () => {
  await page.evaluate(() => (window as any).testerBrowser.settings.set({ debugMode: true }));
  await page.evaluate(() => (window as any).testerBrowser.app.reportError('debug-mode-test-marker'));

  // Switch away and back so the tab's own activation handler re-fetches
  // fresh state (it also polls on a 1s interval while active).
  await page.click('#consoleTabConsole');
  await page.click('#consoleTabDebugLog');

  await expect(page.locator('#debugLogList')).toContainText('debug-mode-test-marker', { timeout: 5_000 });
  // app:reportError always logs at 'error' — the row shows that level.
  await expect(page.locator('.debuglog-row', { hasText: 'debug-mode-test-marker' }).locator('.debuglog-level'))
    .toHaveText('error');

  // Reset for later specs.
  await page.evaluate(() => (window as any).testerBrowser.settings.set({ debugMode: false }));
});

test('Debug Log level pills filter entries by level', async () => {
  await page.evaluate(() => (window as any).testerBrowser.settings.set({ debugMode: true }));
  await page.evaluate(() => (window as any).testerBrowser.app.reportError('pill-filter-test-marker'));
  await page.click('#consoleTabConsole');
  await page.click('#consoleTabDebugLog');
  await expect(page.locator('#debugLogList')).toContainText('pill-filter-test-marker', { timeout: 5_000 });

  // Turning off the Error pill hides an error-level entry.
  await page.click('#debugLogLevelPills [data-level="error"]');
  await expect(page.locator('#debugLogList')).not.toContainText('pill-filter-test-marker');

  // Turning it back on shows it again.
  await page.click('#debugLogLevelPills [data-level="error"]');
  await expect(page.locator('#debugLogList')).toContainText('pill-filter-test-marker');

  // The free-text filter also applies.
  await page.fill('#debugLogFilterText', 'no-such-marker-xyz');
  await expect(page.locator('#debugLogList')).not.toContainText('pill-filter-test-marker');
  await page.fill('#debugLogFilterText', '');

  // Reset for later specs.
  await page.evaluate(() => (window as any).testerBrowser.settings.set({ debugMode: false }));
});

// #227: SessionManager's own info breadcrumbs (session create/destroy, …)
// reach DebugLogStore the same way app:reportError's error-level entries do
// — writeEntry() fans out to every sink regardless of level.
test('Debug Log tab shows an info row when a new tab is created', async () => {
  await page.evaluate(() => (window as any).testerBrowser.settings.set({ debugMode: true }));
  await page.click('#newSessionBtn');

  await page.click('#consoleTabConsole');
  await page.click('#consoleTabDebugLog');

  await expect(page.locator('#debugLogList')).toContainText('Session created', { timeout: 5_000 });
  await expect(page.locator('.debuglog-row', { hasText: 'Session created' }).first().locator('.debuglog-level'))
    .toHaveText('info');

  // Reset for later specs.
  await page.evaluate(() => (window as any).testerBrowser.settings.set({ debugMode: false }));
});

// #228: structured entries (source/session/ctx) + incremental, non-destructive polling.
test.describe('Debug Log panel structure and incremental polling (#228)', () => {
  test('polling appends new rows without disturbing an in-progress text selection', async () => {
    await page.evaluate(() => (window as any).testerBrowser.settings.set({ debugMode: true }));
    await page.evaluate(() => (window as any).testerBrowser.app.reportError('select-marker-1'));
    await page.click('#consoleTabConsole');
    await page.click('#consoleTabDebugLog');
    await expect(page.locator('#debugLogList')).toContainText('select-marker-1', { timeout: 5_000 });

    // Select the text of that row's message span, the way a user copying a
    // single line would.
    const selectedText = await page.evaluate(() => {
      const row = [...document.querySelectorAll('.debuglog-row')].find((r) => r.textContent?.includes('select-marker-1'));
      const msgEl = row?.querySelector('.debuglog-msg');
      if (!msgEl) return null;
      const range = document.createRange();
      range.selectNodeContents(msgEl);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      return window.getSelection()?.toString() ?? null;
    });
    expect(selectedText).toContain('select-marker-1');

    // Trigger a second entry and wait for its row — proves at least one 1s
    // poll tick has happened and appended it — then assert the earlier
    // selection is still exactly what it was (a destructive innerHTML
    // rebuild on that tick would have cleared it).
    await page.evaluate(() => (window as any).testerBrowser.app.reportError('select-marker-2'));
    await expect(page.locator('#debugLogList')).toContainText('select-marker-2', { timeout: 5_000 });

    const selectionAfterPoll = await page.evaluate(() => window.getSelection()?.toString() ?? null);
    expect(selectionAfterPoll).toBe(selectedText);

    await page.evaluate(() => (window as any).testerBrowser.settings.set({ debugMode: false }));
  });

  test('the Source select filters entries down to one source', async () => {
    await page.evaluate(() => (window as any).testerBrowser.settings.set({ debugMode: true }));
    await page.evaluate(() => (window as any).testerBrowser.app.reportError('source-filter-app-marker'));
    await page.click('#newSessionBtn'); // logs 'Session created' from source 'sessions'
    await page.click('#consoleTabConsole');
    await page.click('#consoleTabDebugLog');

    await expect(page.locator('#debugLogList')).toContainText('source-filter-app-marker', { timeout: 5_000 });
    await expect(page.locator('#debugLogList')).toContainText('Session created', { timeout: 5_000 });

    await page.selectOption('#debugLogSourceFilter', 'sessions');
    await expect(page.locator('#debugLogList')).toContainText('Session created');
    await expect(page.locator('#debugLogList')).not.toContainText('source-filter-app-marker');

    await page.selectOption('#debugLogSourceFilter', '');
    await expect(page.locator('#debugLogList')).toContainText('source-filter-app-marker');

    await page.evaluate(() => (window as any).testerBrowser.settings.set({ debugMode: false }));
  });
});

// #225: the central app logger's plain-text file, independent of the Debug
// Log console panel above (which reads DebugLogStore, not main.log).
test.describe('main.log (#225)', () => {
  test('exists after launch with a header line, and reportError() writes a redacted entry', async () => {
    const userDataDir = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
    const logPath = path.join(userDataDir, 'logs', 'main.log');

    await expect(async () => {
      expect(fs.existsSync(logPath)).toBe(true);
    }).toPass({ timeout: 5_000 });

    const firstLine = fs.readFileSync(logPath, 'utf-8').split('\n')[0];
    expect(firstLine).toMatch(/^=== TesterBrowser .+ \| Electron .+ \| .+ \| pid \d+ ===$/);

    await page.evaluate(() => (window as any).testerBrowser.app.reportError('e2e-marker ?secret=1'));

    await expect(async () => {
      expect(fs.readFileSync(logPath, 'utf-8')).toContain('e2e-marker');
    }).toPass({ timeout: 5_000 });

    expect(fs.readFileSync(logPath, 'utf-8')).not.toContain('secret=1');
  });
});

test.describe('main.log survives a hard kill (#225)', () => {
  test('a line logged right before SIGKILL is present in main.log on the next launch', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testerbrowser-e2e-hardkill-'));
    let killedApp: ElectronApplication | undefined;
    try {
      killedApp = await electron.launch({ args: [`--user-data-dir=${userDataDir}`, MAIN_PATH] });
      const win = await getMainWindow(killedApp);
      await win.waitForLoadState('domcontentloaded');

      await win.evaluate(() => (window as any).testerBrowser.app.reportError('before-kill'));
      // reportError() writes main.log synchronously (fs.appendFileSync), so
      // the line is on disk before this call resolves — no wait needed
      // beyond the IPC round trip itself.

      const pid = killedApp.process().pid;
      expect(pid).toBeDefined();
      process.kill(pid as number, 'SIGKILL');
      // No app.close() — the process is already dead; closing would error.
      killedApp = undefined;

      // Relaunch against the SAME user-data dir, as a real restart after a
      // crash would.
      const relaunched = await electron.launch({ args: [`--user-data-dir=${userDataDir}`, MAIN_PATH] });
      try {
        const relaunchedWin = await getMainWindow(relaunched);
        await relaunchedWin.waitForLoadState('domcontentloaded');

        const logPath = path.join(userDataDir, 'logs', 'main.log');
        const content = fs.readFileSync(logPath, 'utf-8');
        expect(content).toContain('before-kill');
      } finally {
        await relaunched.close();
      }
    } finally {
      if (killedApp) await killedApp.close();
    }
  });
});
