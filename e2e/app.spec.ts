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
  // toHaveTitle polls until the title matches (up to the configured timeout),
  // so it handles Electron startup timing without needing test-level retries.
  await expect(window).toHaveTitle('TesterBrowser');
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

// ── Replay overlay ───────────────────────────────────────────────────────────

// Navigate and wait for at least one replay button to appear in the timeline.
async function openReplayOverlay(win: Page, port: number) {
  await win.fill('#urlbar', `http://127.0.0.1:${port}`);
  await win.press('#urlbar', 'Enter');
  await win.waitForTimeout(2_500);
  await win.locator('.evt-replay-btn').first().click();
  await expect(win.locator('#replayOverlay')).toHaveClass(/open/);
}

test('replay button opens the overlay and close button dismisses it', async () => {
  await openReplayOverlay(window, testPort);
  await window.click('#closeReplayBtn');
  await expect(window.locator('#replayOverlay')).not.toHaveClass(/open/);
});

test('replay cookie session picker lists all available sessions', async () => {
  await openReplayOverlay(window, testPort);

  // Picker always starts with a placeholder option, plus one entry per session.
  const optionCount = await window.locator('#replayCookieSessionPick option').count();
  expect(optionCount).toBeGreaterThan(1);

  await window.click('#closeReplayBtn');
});

test('replay cookie session picker filters out cookies from unrelated domains', async () => {
  // Navigate so there is a 127.0.0.1 network event in the timeline.
  await window.fill('#urlbar', `http://127.0.0.1:${testPort}`);
  await window.press('#urlbar', 'Enter');
  await window.waitForTimeout(2_500);

  // Get the first session's id and partition so we can inject test cookies.
  const sessions: Array<{ id: string; partition: string }> =
    await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const { id: sessionId, partition } = sessions[0];

  // Inject foreign-domain cookies directly into the Electron session.
  // Neither domain matches 127.0.0.1, so both should be filtered out.
  await app.evaluate(async ({ session: electronSession }, part) => {
    const ses = electronSession.fromPartition(part);
    await ses.cookies.set({ url: 'http://example.com', name: 'example_cookie', value: 'v1', domain: 'example.com' });
    await ses.cookies.set({ url: 'http://facebook.com', name: 'fb_cookie',      value: 'v2', domain: 'facebook.com' });
  }, partition);

  await openReplayOverlay(window, testPort);

  // Clear whatever cookies the recorded request's own Cookie: header pre-populated,
  // so we can isolate what the session picker contributes.
  await window.evaluate(() => {
    (document.getElementById('replayCookiesTable') as HTMLElement).innerHTML = '';
  });

  // Select the session — the change handler should filter by the request's hostname.
  await window.selectOption('#replayCookieSessionPick', { value: sessionId });
  await window.waitForTimeout(500);

  const cookieNames: string[] = await window.locator('#replayCookiesTable .kv-key').evaluateAll(
    els => (els as HTMLInputElement[]).map(el => el.value)
  );

  // Foreign-domain cookies must not appear when replaying a 127.0.0.1 request.
  expect(cookieNames).not.toContain('example_cookie');
  expect(cookieNames).not.toContain('fb_cookie');

  await window.click('#closeReplayBtn');
});
