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
  workers: process.env.CI ? 2 : 4,
  fullyParallel: false,
  reporter: 'list',
  projects: [{ name: 'electron', use: {} }],
});
