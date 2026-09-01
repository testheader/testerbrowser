import { defineConfig } from '@playwright/test';

// Tests use _electron.launch() which drives Electron's own bundled Chromium.
// No `npx playwright install` is needed — never downloads a browser.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 }, // slow CI runners need more than the 5s default
  retries: 0, // no silent retries — a failing test should fail the CI run visibly
  workers: 1, // Electron app is shared across tests; must run serially
  reporter: 'list',
  projects: [{ name: 'electron', use: {} }],
});
