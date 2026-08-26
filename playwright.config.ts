import { defineConfig } from '@playwright/test';

// Tests use _electron.launch() which drives Electron's own bundled Chromium.
// No `npx playwright install` is needed — never downloads a browser.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1, // Electron app is shared across tests; must run serially
  reporter: 'list',
  projects: [{ name: 'electron', use: {} }],
});
