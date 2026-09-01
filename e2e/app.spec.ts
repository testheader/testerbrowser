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
    testServer = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://localhost');
      const setCookie = u.searchParams.get('setCookie');
      const headers: Record<string, string> = { 'content-type': 'text/html' };
      if (setCookie) headers['set-cookie'] = `${setCookie}=1; Path=/`;
      res.writeHead(200, headers);
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
  await win.locator('.evt-replay-btn').last().click();
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

test('replay cookie session picker shows each session\'s own cookies independently', async () => {
  // Ensure two sessions exist (test 3 usually creates the second, but a worker
  // restart after a flaky earlier test may leave only one).
  let allSessions: Array<{ id: string; partition: string }> =
    await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  if (allSessions.length < 2) {
    await window.click('#newSessionBtn');
    allSessions = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  }
  const { id: session1Id, partition: partition1 } = allSessions[0];
  const { id: session2Id, partition: partition2 } = allSessions[1];

  // Inject unique cookies directly via Electron's session API so we don't
  // depend on server-set cookies (Chromium rejects explicit domain for IPs).
  // Setting without a domain stores them as host-only (domain: ''), which
  // cookieMatchesDomain passes through for 127.0.0.1 replay requests.
  await app.evaluate(async ({ session: electronSession }, [part1, part2]) => {
    const ses1 = electronSession.fromPartition(part1);
    const ses2 = electronSession.fromPartition(part2);
    await ses1.clearStorageData({ storages: ['cookies'] });
    await ses2.clearStorageData({ storages: ['cookies'] });
    await ses1.cookies.set({ url: 'http://127.0.0.1', name: 's1_unique_tok', value: '1' });
    await ses2.cookies.set({ url: 'http://127.0.0.1', name: 's2_unique_tok', value: '1' });
  }, [partition1, partition2]);

  // Switch to session 1 and navigate to produce a 127.0.0.1 replay event.
  await window.evaluate((id: string) => (window as any).testerBrowser.sessions.switchTo(id), session1Id);
  await window.fill('#urlbar', `http://127.0.0.1:${testPort}`);
  await window.press('#urlbar', 'Enter');
  await window.waitForTimeout(2_500);

  await openReplayOverlay(window, testPort);

  // ── Session 1 ──
  await window.selectOption('#replayCookieSessionPick', { value: session1Id });
  await window.waitForTimeout(500);
  const s1Names: string[] = await window.locator('#replayCookiesTable .kv-key').evaluateAll(
    els => (els as HTMLInputElement[]).map(el => el.value)
  );

  // ── Session 2 — the picker handler clears and refills the table ──
  await window.selectOption('#replayCookieSessionPick', { value: session2Id });
  await window.waitForTimeout(500);
  const s2Names: string[] = await window.locator('#replayCookiesTable .kv-key').evaluateAll(
    els => (els as HTMLInputElement[]).map(el => el.value)
  );

  // Each session's cookie appears only when that session is selected.
  expect(s1Names).toContain('s1_unique_tok');
  expect(s1Names).not.toContain('s2_unique_tok');
  expect(s2Names).toContain('s2_unique_tok');
  expect(s2Names).not.toContain('s1_unique_tok');

  await window.click('#closeReplayBtn');
});

// ── Storage panel ─────────────────────────────────────────────────────────────

// Navigate to the test URL, switch to the Storage tab, and wait for it to load.
async function openStorageTab(win: Page, port: number) {
  await win.fill('#urlbar', `http://127.0.0.1:${port}`);
  await win.press('#urlbar', 'Enter');
  await win.waitForTimeout(1_500);
  await win.click('#consoleTabStorage');
  await win.waitForTimeout(500);
}

test('storage tab: add cookie via "+ Add" button', async () => {
  // Navigate first so we know which session is active, then query by URL.
  await openStorageTab(window, testPort);

  const allSessions: Array<{ id: string; partition: string; url: string }> =
    await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const active = allSessions.find(s => s.url && s.url.includes('127.0.0.1')) ?? allSessions[0];
  const { id: sessionId, partition } = active;

  // Start clean.
  await app.evaluate(async ({ session: electronSession }, part) => {
    await electronSession.fromPartition(part).clearStorageData({ storages: ['cookies'] });
  }, partition);

  // Reload storage panel after clearing.
  await window.click('#refreshStorageBtn');
  await window.waitForTimeout(500);

  // Click "+ Add" in the cookie section header.
  await window.locator('.storage-add-btn').first().click();

  // Fill in the add-row inputs: domain(0), name(1), value(2), path(3).
  const addRow = window.locator('.storage-add-row').first();
  await addRow.locator('input').nth(1).fill('e2e_added_cookie');
  await addRow.locator('input').nth(2).fill('e2e_value');
  await addRow.locator('input').nth(1).press('Enter');

  await window.waitForTimeout(500);

  const cookies: Array<{ name: string; value: string }> =
    await window.evaluate((id: string) => (window as any).testerBrowser.sessions.getCookies(id), sessionId);
  const added = cookies.find(c => c.name === 'e2e_added_cookie');
  expect(added).toBeDefined();
  expect(added?.value).toBe('e2e_value');
});

test('storage tab: edit cookie value by double-clicking', async () => {
  // Navigate first so we know which session is active, then query by URL.
  await openStorageTab(window, testPort);

  const allSessions: Array<{ id: string; partition: string; url: string }> =
    await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const active = allSessions.find(s => s.url && s.url.includes('127.0.0.1')) ?? allSessions[0];
  const { id: sessionId, partition } = active;

  // Inject a known cookie into the active session's partition.
  await app.evaluate(async ({ session: electronSession }, part) => {
    const ses = electronSession.fromPartition(part);
    await ses.clearStorageData({ storages: ['cookies'] });
    await ses.cookies.set({ url: 'http://127.0.0.1', name: 'e2e_edit_cookie', value: 'original' });
  }, partition);

  // Reload storage panel after injecting.
  await window.click('#refreshStorageBtn');
  await window.waitForTimeout(500);

  // Find the value cell for our cookie (3rd td, index 2) and double-click it.
  // The name column (td[1]) retains 'e2e_edit_cookie' after dblclick on the value cell,
  // so the row filter stays valid for the input locator.
  const cookieRow = window.locator('#storagePanel .storage-table tbody tr')
    .filter({ hasText: 'e2e_edit_cookie' });
  await cookieRow.locator('td').nth(2).dblclick();

  const editInput = cookieRow.locator('input.ls-edit-input');
  await editInput.fill('updated');
  await editInput.press('Enter');

  await window.waitForTimeout(500);

  const cookies: Array<{ name: string; value: string }> =
    await window.evaluate((id: string) => (window as any).testerBrowser.sessions.getCookies(id), sessionId);
  const edited = cookies.find(c => c.name === 'e2e_edit_cookie');
  expect(edited?.value).toBe('updated');
});

test('storage tab: add localStorage entry via "+ Add" button', async () => {
  const sessions: Array<{ id: string; partition: string }> =
    await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const { id: sessionId } = sessions[0];

  await window.evaluate((id: string) => (window as any).testerBrowser.sessions.clearLocalStorage(id), sessionId);

  await openStorageTab(window, testPort);

  // Click "+ Add" in the localStorage section (second .storage-add-btn).
  await window.locator('.storage-add-btn').nth(1).click();

  const addRow = window.locator('#storagePanel .storage-add-row');
  await addRow.locator('input').nth(0).fill('e2e_ls_key');
  await addRow.locator('input').nth(1).fill('e2e_ls_val');
  await addRow.locator('input').nth(0).press('Enter');

  await window.waitForTimeout(500);

  const ls: Record<string, string> =
    await window.evaluate((id: string) => (window as any).testerBrowser.sessions.getLocalStorage(id), sessionId);
  expect(ls['e2e_ls_key']).toBe('e2e_ls_val');
});

test('storage tab: rename localStorage key by double-clicking', async () => {
  // Navigate to testPort first so localStorage operations happen in the right page context.
  await openStorageTab(window, testPort);

  const allSessions: Array<{ id: string; url: string }> =
    await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const active = allSessions.find(s => s.url && s.url.includes('127.0.0.1')) ?? allSessions[0];
  const { id: sessionId } = active;

  await window.evaluate((id: string) => (window as any).testerBrowser.sessions.clearLocalStorage(id), sessionId);
  await window.evaluate(([id, k, v]: string[]) =>
    (window as any).testerBrowser.sessions.setLocalStorageKey(id, k, v),
  [sessionId, 'old_key', 'kept_value']);

  // Refresh the storage panel so the new key is visible.
  await window.click('#refreshStorageBtn');
  await window.waitForTimeout(500);

  const lsRow = window.locator('#storagePanel .storage-table tbody tr')
    .filter({ hasText: 'old_key' });
  await lsRow.locator('td').nth(0).dblclick();

  // After dblclick the key cell's text is replaced with an <input>, so the row
  // no longer has 'old_key' as visible text and lsRow no longer matches.
  // Use a panel-scoped locator instead.
  const editInput = window.locator('#storagePanel input.ls-edit-input');
  await editInput.fill('new_key');
  await editInput.press('Enter');

  await window.waitForTimeout(500);

  const ls: Record<string, string> =
    await window.evaluate((id: string) => (window as any).testerBrowser.sessions.getLocalStorage(id), sessionId);
  expect(ls['new_key']).toBe('kept_value');
  expect(ls['old_key']).toBeUndefined();
});
