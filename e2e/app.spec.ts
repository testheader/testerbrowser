/**
 * End-to-end smoke tests for TesterBrowser.
 *
 * Run with: npm run test:e2e
 * Requires: npm run build (or npm run dev) first.
 *
 * A local HTTP server is started for navigation tests so no internet access
 * is required — tests are fully hermetic.
 */

import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createServer, Server } from 'http';
import path from 'path';

let app: ElectronApplication;
let window: Page;
let testServer: Server;
let testPort: number;

test.beforeAll(async () => {
  // Spin up a local HTTP server so navigation tests don't need internet access.
  // Port 0 lets the OS pick a free port.
  await new Promise<void>(resolve => {
    testServer = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body><h1>TesterBrowser test page</h1></body></html>');
    });
    testServer.listen(0, '127.0.0.1', () => {
      testPort = (testServer.address() as { port: number }).port;
      resolve();
    });
  });

  app = await electron.launch({
    args: [path.join(__dirname, '..', 'dist', 'main', 'index.js')],
  });
  window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app.close();
  await new Promise<void>(resolve => testServer.close(() => resolve()));
});

// ── Window ───────────────────────────────────────────────────────────────────

test('window opens with TesterBrowser title', async () => {
  expect(await window.title()).toBe('TesterBrowser');
});

// ── Tabs ─────────────────────────────────────────────────────────────────────

test('initial tab is present on startup', async () => {
  await expect(window.locator('.tab')).toHaveCount(1);
});

test('new tab button creates a second tab', async () => {
  await window.click('#newSessionBtn');
  await expect(window.locator('.tab')).toHaveCount(2);
});

// ── URL bar ──────────────────────────────────────────────────────────────────

test('URL bar is visible and accepts input', async () => {
  await window.click('#urlbar');
  await window.fill('#urlbar', `http://127.0.0.1:${testPort}`);
  await expect(window.locator('#urlbar')).toHaveValue(`http://127.0.0.1:${testPort}`);
});

test('pressing Enter in URL bar triggers navigation', async () => {
  await window.click('#urlbar');
  await window.fill('#urlbar', `http://127.0.0.1:${testPort}`);
  await window.press('#urlbar', 'Enter');
  await expect(window.locator('#urlbar')).toHaveValue(/127\.0\.0\.1/, { timeout: 5_000 });
});

// ── Console panel ────────────────────────────────────────────────────────────

test('console panel is visible on startup', async () => {
  await expect(window.locator('#consolePanel')).toBeVisible();
});

test('timeline panel is present inside the console', async () => {
  await expect(window.locator('#timelinePanel')).toBeVisible();
});

// ── Recording ────────────────────────────────────────────────────────────────

test('timeline receives events after navigation', async () => {
  await window.click('#urlbar');
  await window.fill('#urlbar', `http://127.0.0.1:${testPort}`);
  await window.press('#urlbar', 'Enter');
  // pollTimeline runs every 1 s; wait 2.5 s for at least one cycle to render events
  await window.waitForTimeout(2_500);

  const count = await window.locator('#timelinePanel .evt').count();
  expect(count).toBeGreaterThan(0);
});
