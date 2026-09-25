import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { _electron as electron } from '@playwright/test';
import { getMainWindow, getActiveViewBounds, MAIN_PATH } from './helpers';

// launchApp() (helpers.ts) always starts from a fresh, sentinel-free userData
// dir, so there's nothing for src/main/index.ts's crash detection to find on
// launch. Simulate "the previous session crashed" by writing a
// running.sentinel file into a fresh userData dir *before* launching — the
// same file app.whenReady() itself writes on every normal startup and only
// fails to clean up when the app doesn't exit normally.
//
// A *hard* crash (renderer killed, OOM, native crash) never runs any of this
// process's own cleanup code, so the only way its errors/session URLs can
// reach the next launch's crash log is if they were already write-through'd
// to disk before it died — src/main/index.ts's recordAppError()/
// persistSessionUrls() do this into app-errors.json/session-urls.json
// (errorLog.ts's writeAppErrors() for the former). Seed those same files
// here to simulate that write-through having already happened.
async function launchWithSimulatedCrash(durableState?: {
  errors?: { ts: number; message: string }[];
  sessionUrls?: string[];
  // #226: writeCrashLog() reads its main.log tail from disk (readLogTail),
  // same as the sentinel/app-errors/session-urls state above — seed it the
  // same way to simulate the crashed process having already written these
  // lines through before it died.
  logLines?: string[];
}): Promise<ElectronApplication> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testerbrowser-e2e-crash-'));
  fs.writeFileSync(
    path.join(userDataDir, 'running.sentinel'),
    JSON.stringify({ startedAt: new Date(Date.now() - 60_000).toISOString() }),
  );
  if (durableState?.errors) {
    fs.writeFileSync(path.join(userDataDir, 'app-errors.json'), JSON.stringify(durableState.errors));
  }
  if (durableState?.sessionUrls) {
    fs.writeFileSync(path.join(userDataDir, 'session-urls.json'), JSON.stringify(durableState.sessionUrls));
  }
  if (durableState?.logLines) {
    fs.mkdirSync(path.join(userDataDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(userDataDir, 'logs', 'main.log'), durableState.logLines.join('\n') + '\n');
  }
  return electron.launch({ args: [`--user-data-dir=${userDataDir}`, MAIN_PATH] });
}

test.describe('crash modal visibility', () => {
  let app: ElectronApplication;
  let window: Page;

  test.beforeAll(async () => {
    app = await launchWithSimulatedCrash();
    window = await getMainWindow(app);
    await window.waitForLoadState('load');
  });

  test.afterAll(async () => {
    await app.close();
  });

  test('crash modal shows fully visible over the restored tab view, not hidden behind it', async () => {
    await expect(window.locator('#crashReportOverlay')).toHaveClass(/open/, { timeout: 5_000 });
    // setViewerVisible(false) removes the active tab's WebContentsView from
    // the window's contentView tree entirely — getActiveViewBounds() finds
    // no child view while it's detached, proving the modal isn't rendering
    // hidden underneath it.
    expect(await getActiveViewBounds(app)).toBeNull();
  });

  test('Dismiss hides the modal, clears the crash log and restores the tab view', async () => {
    await window.click('#crashReportDismissBtn');
    await expect(window.locator('#crashReportOverlay')).not.toHaveClass(/open/);

    await expect(async () => {
      expect(await getActiveViewBounds(app)).not.toBeNull();
    }).toPass({ timeout: 5_000 });

    const log = await window.evaluate(() => (window as any).testerBrowser.crash.check());
    expect(log).toBeNull();
  });
});

test.describe('crash modal file-a-bug-report handoff', () => {
  let app: ElectronApplication;
  let window: Page;

  test.beforeAll(async () => {
    app = await launchWithSimulatedCrash();
    window = await getMainWindow(app);
    await window.waitForLoadState('load');
  });

  test.afterAll(async () => {
    await app.close();
  });

  test('"File a bug report…" opens the bug report form pre-filled with the crash timestamp', async () => {
    await expect(window.locator('#crashReportOverlay')).toHaveClass(/open/, { timeout: 5_000 });
    const timestampText = await window.locator('#crashReportTimestamp').textContent();

    await window.click('#crashReportFileBtn');

    await expect(window.locator('#crashReportOverlay')).not.toHaveClass(/open/);
    await expect(window.locator('#bugReportOverlay')).toHaveClass(/open/, { timeout: 5_000 });
    // #bugReportDesc is a textarea filled via .value = ..., not markup — assert
    // against its value, not textContent (which toContainText would check).
    await expect(window.locator('#bugReportDesc')).toHaveValue(/TesterBrowser crashed unexpectedly\./, { timeout: 5_000 });
    if (timestampText) {
      await expect(window.locator('#bugReportDesc')).toHaveValue(new RegExp(timestampText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });
});

// #206 only proved the modal itself becomes visible; it explicitly left the
// log's *content* out of scope. These cover that content is actually
// populated for a hard crash — the scenario the sentinel mechanism exists
// for, where nothing but a prior write-through to disk survives.
test.describe('crash log content after a hard crash', () => {
  let app: ElectronApplication;
  let window: Page;

  const seededErrors = [
    { ts: 1735732800000, message: 'Uncaught exception: something in the crashed process' },
    { ts: 1735732801000, message: 'Chrome UI render process gone: crashed' },
  ];
  const seededSessionUrls = ['https://example.com/crashed-tab', 'https://example.org/other-tab'];

  test.beforeAll(async () => {
    app = await launchWithSimulatedCrash({ errors: seededErrors, sessionUrls: seededSessionUrls });
    window = await getMainWindow(app);
    await window.waitForLoadState('load');
  });

  test.afterAll(async () => {
    await app.close();
  });

  test('crash-log.json carries over the crashed process\'s recentErrors and sessionUrls, not empty ones', async () => {
    await expect(window.locator('#crashReportOverlay')).toHaveClass(/open/, { timeout: 5_000 });
    const log = await window.evaluate(() => (window as any).testerBrowser.crash.check());
    expect(log.recentErrors).toEqual(seededErrors);
    expect(log.sessionUrls).toEqual(seededSessionUrls);
  });

  test('the pre-filled bug report renders the recovered "Active tabs" and "Recent errors" sections', async () => {
    await window.click('#crashReportFileBtn');
    await expect(window.locator('#bugReportOverlay')).toHaveClass(/open/, { timeout: 5_000 });

    const desc = await window.locator('#bugReportDesc').inputValue();
    expect(desc).toContain('**Active tabs at crash time:**');
    expect(desc).toContain('https://example.com/crashed-tab');
    expect(desc).toContain('https://example.org/other-tab');
    expect(desc).toContain('**Recent errors before crash:**');
    expect(desc).toContain('Uncaught exception: something in the crashed process');
    expect(desc).toContain('Chrome UI render process gone: crashed');
  });
});

// #246: crashedAt (actual detection time) vs timestamp (the crashed
// session's own *start* time) — and URL redaction in the pre-filled report.
test.describe('crash time and URL redaction (#246)', () => {
  let app: ElectronApplication;
  let window: Page;

  const seededStartedAt = new Date(Date.now() - 60_000).toISOString();
  const tokenUrl = 'https://example.test/p?token=abc';

  test.beforeEach(async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testerbrowser-e2e-crash-'));
    fs.writeFileSync(path.join(userDataDir, 'running.sentinel'), JSON.stringify({ startedAt: seededStartedAt }));
    fs.writeFileSync(path.join(userDataDir, 'session-urls.json'), JSON.stringify([tokenUrl]));
    app = await electron.launch({ args: [`--user-data-dir=${userDataDir}`, MAIN_PATH] });
    window = await getMainWindow(app);
    await window.waitForLoadState('load');
    await expect(window.locator('#crashReportOverlay')).toHaveClass(/open/, { timeout: 5_000 });
  });

  test.afterEach(async () => {
    await app.close();
  });

  test('the modal shows the actual detection time, not the crashed session\'s start time', async () => {
    const shown = await window.locator('#crashReportTimestamp').textContent();
    // seededStartedAt is a fixed 60s-old timestamp — crashedAt (written at
    // detection, i.e. "now") renders differently as long as the two seconds
    // don't happen to share the same locale string (they're a minute apart).
    expect(shown).not.toBe(new Date(seededStartedAt).toLocaleString());
  });

  test('filing a bug report redacts the query string by default, and includes it when "full tab URLs" is checked', async () => {
    await window.click('#crashReportFileBtn');
    await expect(window.locator('#bugReportOverlay')).toHaveClass(/open/, { timeout: 5_000 });
    let desc = await window.locator('#bugReportDesc').inputValue();
    expect(desc).toContain('https://example.test/p');
    expect(desc).not.toContain('token=abc');
    expect(desc).toMatch(/Session started: /);

    // Reopen the crash flow to check the full-URLs box this time — checking
    // File issue closed the crash modal (fileIssue -> dismissCrash), so
    // relaunch with the same seeded state for a clean second pass.
    await app.close();
    const userDataDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'testerbrowser-e2e-crash-'));
    fs.writeFileSync(path.join(userDataDir2, 'running.sentinel'), JSON.stringify({ startedAt: seededStartedAt }));
    fs.writeFileSync(path.join(userDataDir2, 'session-urls.json'), JSON.stringify([tokenUrl]));
    app = await electron.launch({ args: [`--user-data-dir=${userDataDir2}`, MAIN_PATH] });
    window = await getMainWindow(app);
    await window.waitForLoadState('load');
    await expect(window.locator('#crashReportOverlay')).toHaveClass(/open/, { timeout: 5_000 });

    await window.check('#crashReportFullUrls');
    await window.click('#crashReportFileBtn');
    await expect(window.locator('#bugReportOverlay')).toHaveClass(/open/, { timeout: 5_000 });
    desc = await window.locator('#bugReportDesc').inputValue();
    expect(desc).toContain('token=abc');
  });
});

// #226: writeCrashLog()'s logTail/logTailTruncated, formatted by
// formatCrashForIssue() -> formatAppLogBlock() (renderer/utils.js), and the
// crash modal's new "Open log folder" button.
// Each test below needs its own fresh crash: clicking "File a bug report…"
// dismisses the crash modal and clears the crash log (crash-report.js's
// fileIssue() -> dismissCrash() -> testerBrowser.crash.clear()), so a shared
// beforeAll app instance would leave #crashReportOverlay's "open" class
// removed for any test running after the first one. Give each test its own
// app, same as every other describe block in this file.
test.describe('crash modal app log (#226)', () => {
  let app: ElectronApplication;
  let window: Page;

  test.beforeEach(async () => {
    app = await launchWithSimulatedCrash({ logLines: ['some earlier line', 'crash-log-tail-marker', 'last line before crash'] });
    window = await getMainWindow(app);
    await window.waitForLoadState('load');
  });

  test.afterEach(async () => {
    await app.close();
  });

  test('"File a bug report…" includes the seeded main.log line inside an App log block', async () => {
    await expect(window.locator('#crashReportOverlay')).toHaveClass(/open/, { timeout: 5_000 });
    await window.click('#crashReportFileBtn');
    await expect(window.locator('#bugReportOverlay')).toHaveClass(/open/, { timeout: 5_000 });

    const desc = await window.locator('#bugReportDesc').inputValue();
    expect(desc).toContain('App log');
    expect(desc).toContain('crash-log-tail-marker');
  });

  test('"Open log folder" is visible and reveals main.log', async () => {
    await expect(window.locator('#crashReportOverlay')).toHaveClass(/open/, { timeout: 5_000 });
    await expect(window.locator('#crashReportLogFolderBtn')).toBeVisible();

    // shell.showItemInFolder() opens the OS file explorer — not something a
    // headless/CI e2e run should actually trigger. Replace it in the main
    // process (rather than delegating to the real implementation) and assert
    // it was invoked with a path ending in main.log instead.
    await app.evaluate(({ shell }) => {
      (globalThis as any).__revealedPaths = [];
      (shell as any).showItemInFolder = (p: string) => {
        (globalThis as any).__revealedPaths.push(p);
      };
    });

    await window.click('#crashReportLogFolderBtn');

    await expect(async () => {
      const revealed: string[] = await app.evaluate(() => (globalThis as any).__revealedPaths ?? []);
      expect(revealed.some((p) => p.endsWith('main.log'))).toBe(true);
    }).toPass({ timeout: 5_000 });
  });
});
