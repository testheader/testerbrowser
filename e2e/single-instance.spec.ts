import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { getMainWindow, launchAppWithProfile, MAIN_PATH } from './helpers';
import { startFixtureServer, FixtureServer } from './fixtures/server';

// #257: this spec gets its own launch (not the shared launchApp() pattern
// most files use) because it needs the primary instance's own
// --user-data-dir to hand to a *second*, real `electron` process — the
// single-instance lock only does anything when two processes actually race
// for the same directory, which two independent launchApp() calls (each
// with their own throwaway dir) would never exercise.
let app: ElectronApplication;
let window: Page;
let userDataDir: string;
let fixtures: FixtureServer;

test.beforeAll(async () => {
  fixtures = await startFixtureServer();
  const launched = await launchAppWithProfile(MAIN_PATH);
  app = launched.app;
  userDataDir = launched.userDataDir;
  window = await getMainWindow(app);
  await window.waitForLoadState('load');
});

test.afterAll(async () => {
  await app.close();
  await fixtures.close();
});

// require('electron') resolves to the electron binary's own path when
// required from plain Node (as this spec runs under, via ts-node/Playwright)
// rather than from inside an Electron process itself.
const ELECTRON_BIN = require('electron') as unknown as string;

test('a second launch against the same --user-data-dir focuses the running window, opens the URL as a new tab, and writes no crash log', async () => {
  const tabsBefore = await window.locator('.tab').count();
  const targetUrl = fixtures.url('/storage/cookies.html');

  // --no-sandbox: Playwright's own electron.launch() (used by launchApp/
  // launchAppWithProfile for the primary instance) adds this itself unless
  // chromiumSandbox is explicitly true — required to run Electron as root,
  // which this sandboxed environment does. A plain child_process.spawn()
  // doesn't get that for free, so it's added explicitly here too.
  const second = spawn(ELECTRON_BIN, [`--user-data-dir=${userDataDir}`, '--no-sandbox', MAIN_PATH, targetUrl], {
    stdio: 'ignore',
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('second instance did not exit within 10s')), 10_000);
    second.on('exit', (code) => { clearTimeout(timer); resolve(code); });
    second.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
  // Losing the single-instance lock calls app.quit() before app.whenReady()
  // ever runs, so this is a clean exit, not a crash.
  expect(exitCode).toBe(0);

  await expect(window.locator('.tab')).toHaveCount(tabsBefore + 1);
  const activeUrlbar = window.locator('#urlbar');
  await expect(activeUrlbar).toHaveValue(targetUrl, { timeout: 5_000 });

  expect(fs.existsSync(path.join(userDataDir, 'crash-log.json'))).toBe(false);
});
