import { defineConfig } from '@playwright/test';

// Tests use _electron.launch() which drives Electron's own bundled Chromium.
// No `npx playwright install` is needed — never downloads a browser.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 }, // slow CI runners need more than the 5s default
  retries: 0, // no silent retries — a failing test should fail the CI run visibly
  // #249: each spec file gets its own Electron launch with an isolated
  // --user-data-dir (launchApp() in helpers.ts) and its own fixture server
  // bound to port 0, and the app takes no single-instance lock — nothing is
  // actually shared across files, so different files can safely run in
  // parallel workers. fullyParallel stays false (Playwright's own default):
  // tests *within* one file still run serially against that file's single
  // shared app launch, which many specs depend on for tab/session state
  // carried between tests.
  //
  // CI stays at 1 worker per shard, not 2: two concurrent electron.exe
  // launches on the SAME windows-2022 runner reproducibly hit "Process
  // failed to launch! ... The process cannot access the file because it is
  // being used by another process" (observed on 3 consecutive real CI runs
  // after this was briefly set to 2 — every run before that, at workers: 1,
  // was clean). Most likely Windows Defender's real-time scan briefly
  // locking electron.exe when two processes spawn it in the same instant.
  // #250's 2-shard matrix gets the parallelism back safely instead, since
  // each shard runs on its own separate runner VM.
  workers: process.env.CI ? 1 : 4,
  fullyParallel: false,
  // #250: retain-on-failure keeps a trace.zip (with screenshots/DOM
  // snapshots/network) per failing test in test-results/, viewable via
  // `npx playwright show-trace`. The html reporter writes playwright-report/
  // for the same purpose in CI (never opened automatically there — nothing
  // to open on a headless runner); the plain list reporter is enough when
  // running locally with a terminal in front of you.
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure' },
  projects: [{ name: 'electron', use: {} }],
});
