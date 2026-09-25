import { test, expect } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { _electron as electron } from '@playwright/test';
import { getMainWindow, MAIN_PATH } from './helpers';

// #231: saveSessions()/loadAndRestoreSessions() didn't persist the pinned
// flag at all, so even a normal app restart (not just Ctrl+Shift+T reopen)
// silently unpinned every tab. Unlike every other spec file, this test needs
// two separate launches sharing the *same* userData dir (launchApp() in
// helpers.ts deliberately gives every launch its own throwaway profile so
// state never leaks between spec files) — same technique as
// launchWithSimulatedCrash() in crash-report.spec.ts.
test('a pinned tab is still pinned after a full app restart (#231)', async () => {
  // Two full Electron launches (each including a build's worth of startup
  // work) in one test easily exceeds the default 30s budget on a loaded CI
  // runner — every other spec file launches exactly once per test.
  test.setTimeout(120_000);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testerbrowser-e2e-pin-'));

  const app1 = await electron.launch({ args: [`--user-data-dir=${userDataDir}`, MAIN_PATH] });
  const window1 = await getMainWindow(app1);
  await window1.waitForLoadState('load');

  // Explicit timeouts below: Playwright's own per-action default (30s, unset
  // in playwright.config.ts) is a separate, tighter ceiling than this test's
  // own test.setTimeout(90_000) above — a slow-to-render tab on a loaded CI
  // runner can still trip the former even with the latter raised.
  const tabId = await window1.locator('.tab.active').getAttribute('data-id', { timeout: 60_000 });
  await window1.evaluate(
    (id) => (window as unknown as { testerBrowser: any }).testerBrowser.sessions.pin(id, true), tabId
  );
  await window1.evaluate(
    (id) => (window as unknown as { testerBrowser: any }).testerBrowser.sessions.rename(id, 'Pinned across restart'), tabId
  );

  // index.ts's before-quit handler calls sessionManager.saveSessions() — this
  // is what the helpers.ts profile-isolation comment describes as
  // open-sessions.json otherwise leaking real state between launches.
  await app1.close();

  const app2 = await electron.launch({ args: [`--user-data-dir=${userDataDir}`, MAIN_PATH] });
  const window2 = await getMainWindow(app2);
  await window2.waitForLoadState('load');

  await expect(window2.locator('.tab', { hasText: 'Pinned across restart' }))
    .toHaveAttribute('data-pinned', '1', { timeout: 60_000 });

  await app2.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
});
