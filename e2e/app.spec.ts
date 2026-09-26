/**
 * End-to-end smoke tests for TesterBrowser.
 *
 * Run with: npm run test:e2e
 * Requires: npm run build (or npm run dev) first.
 *
 * A local HTTP server is started for navigation tests so no internet access
 * is required — tests are fully hermetic.
 */

import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createServer, Server } from 'http';
import { getMainWindow, getTabPage, launchApp, MAIN_PATH } from './helpers';
import { startFixtureServer, FixtureServer } from './fixtures/server';

let app: ElectronApplication;
let window: Page;
let testServer: Server;
let testPort: number;
// #233: the Replay/Mock/redaction/timeout tests below need real routes
// (/echo/headers, /network/slow) the inline testServer above doesn't have —
// the shared fixtures server already provides them.
let fixtures: FixtureServer;

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

  fixtures = await startFixtureServer();
  app = await launchApp(MAIN_PATH);
  window = await getMainWindow(app);
  // 'load' waits until all scripts have run, ensuring the renderer has set its
  // title before any test assertion reads it.
  await window.waitForLoadState('load');
});

test.afterAll(async () => {
  await app.close();
  await new Promise<void>(resolve => testServer.close(() => resolve()));
  await fixtures.close();
});

// ── Window ───────────────────────────────────────────────────────────────────

test('window opens with TesterBrowser title', async () => {
  // toHaveTitle polls until the title matches (up to the configured timeout),
  // so it handles Electron startup timing without needing test-level retries.
  await expect(window).toHaveTitle('TesterBrowser');
});

// ── Tabs ─────────────────────────────────────────────────────────────────────

// #253: this file's beforeAll launches one shared app for hundreds of tests,
// so "the app's tab count" is never guaranteed to be pristine by the time a
// given test runs (test order, --repeat-each, or an earlier test's own tabs
// all affect it). Reset down to a single tab first rather than assuming one.
async function resetToSingleTab() {
  while ((await window.locator('.tab').count()) > 1) {
    await window.locator('.tab .tab-close').first().click();
  }
  await expect(window.locator('.tab')).toHaveCount(1);
}

test('initial tab is present on startup', async () => {
  await resetToSingleTab();
  await expect(window.locator('.tab')).toHaveCount(1);
});

test('new tab button creates a second tab', async () => {
  // Compares against a count read at the start of the test, not an assumed
  // baseline — passes the same whether this is the first tab-creating test
  // in the file or the fiftieth.
  const before = await window.locator('.tab').count();
  await window.click('#newSessionBtn');
  await expect(window.locator('.tab')).toHaveCount(before + 1);
});

test('tab strip opts out of the titlebar drag region', async () => {
  // A real click can't be proven headlessly (Playwright's synthetic clicks bypass
  // -webkit-app-region: drag), so assert the CSS contract instead: no ancestor
  // between #newSessionBtn and #titlebar leaves the drag region active.
  const dragRegion = await window.evaluate(() => {
    let el: HTMLElement | null = document.getElementById('newSessionBtn');
    while (el && el.id !== 'titlebar') {
      const region = getComputedStyle(el).webkitAppRegion;
      if (region === 'no-drag') return 'no-drag';
      el = el.parentElement;
    }
    return getComputedStyle(el as HTMLElement).webkitAppRegion;
  });
  expect(dragRegion).toBe('no-drag');
});

test('closing the last remaining tab opens a fresh one instead of leaving the window empty', async () => {
  await resetToSingleTab();

  await window.locator('.tab .tab-close').first().click();

  // Never zero — a fresh tab (the New Tab page) takes its place.
  await expect(window.locator('.tab')).toHaveCount(1);
  await expect(window.locator('.tab.active')).toBeVisible();
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
  const tab = await getTabPage(app, `127.0.0.1:${testPort}`, window);
  await tab.waitForLoadState('load');
  // #253: a specific row for this navigation, not just "some row exists" —
  // the timeline can easily be non-empty from an earlier test's own traffic
  // regardless of whether this navigation was ever actually recorded. The
  // default Console sub-tab only renders console/log/exception kinds (see
  // renderTimeline() in timeline.js), so a network-request row needs the
  // Network sub-tab active to be visible at all.
  await window.click('#consoleTabNetwork');
  await expect(
    window.locator('#timelinePanel .evt', { hasText: `127.0.0.1:${testPort}` }).first()
  ).toBeVisible();
});

// ── Replay overlay ───────────────────────────────────────────────────────────

// Navigate, open a request row's detail tab, and click its Replay action
// button (#178 moved Replay off the per-row button and into the detail
// panel — see #detailReplayBtn in detail-panel.js).
async function openReplayOverlayAt(win: Page, url: string) {
  // By the time this file's later tests run, the timeline already has many
  // earlier network-request rows in it — waiting for .last() to be visible
  // would resolve instantly against one of those, not this navigation's own
  // request. Capture the count first (on the Network tab, since rows for a
  // non-active console tab aren't rendered at all — see renderTimeline's
  // per-tab filtering) and wait for it to actually grow.
  await win.click('#consoleTabNetwork');
  const beforeCount = await win.locator('.evt.network-request').count();
  await win.fill('#urlbar', url);
  await win.press('#urlbar', 'Enter');
  await expect.poll(() => win.locator('.evt.network-request').count(), { timeout: 10_000 })
    .toBeGreaterThan(beforeCount);
  await win.locator('.evt.network-request').last().click();
  await win.locator('#detailReplayBtn').click();
  await expect(win.locator('#replayOverlay')).toHaveClass(/open/);
}

async function openReplayOverlay(win: Page, port: number) {
  await openReplayOverlayAt(win, `http://127.0.0.1:${port}`);
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

// The session picker's change handler fetches cookies via IPC
// (testerBrowser.sessions.getCookies) and, when the result is empty for the
// active domain filter, leaves no DOM change to poll for — call the same
// endpoint ourselves as a completion proxy: dispatched strictly after the
// handler's own identical call (selectOption already fired the change
// event), it resolves no earlier, so by the time it does, the handler's own
// synchronous re-render has already run too.
async function waitForReplayCookiesSettled(win: Page, sessionId: string) {
  await win.evaluate((id) => (window as any).testerBrowser.sessions.getCookies(id), sessionId);
}

test('replay cookie session picker filters out cookies from unrelated domains', async () => {
  // Navigate so there is a 127.0.0.1 network event in the timeline.
  await window.fill('#urlbar', `http://127.0.0.1:${testPort}`);
  await window.press('#urlbar', 'Enter');
  const navTab = await getTabPage(app, `127.0.0.1:${testPort}`, window);
  await navTab.waitForLoadState('load');

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
  await waitForReplayCookiesSettled(window, sessionId);

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
  const navTab = await getTabPage(app, `127.0.0.1:${testPort}`, window);
  await navTab.waitForLoadState('load');

  await openReplayOverlay(window, testPort);

  // ── Session 1 ──
  await window.selectOption('#replayCookieSessionPick', { value: session1Id });
  await waitForReplayCookiesSettled(window, session1Id);
  const s1Names: string[] = await window.locator('#replayCookiesTable .kv-key').evaluateAll(
    els => (els as HTMLInputElement[]).map(el => el.value)
  );

  // ── Session 2 — the picker handler clears and refills the table ──
  await window.selectOption('#replayCookieSessionPick', { value: session2Id });
  await waitForReplayCookiesSettled(window, session2Id);
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

test('replay-actions: ⇒ Resilience carries the edited URL to the Resilience tab', async () => {
  await openReplayOverlay(window, testPort);

  const editedUrl = `http://127.0.0.1:${testPort}/edited-by-tester`;
  await window.fill('#replayUrl', editedUrl);
  await window.click('#replayToResilienceBtn');

  await expect(window.locator('#replayOverlay')).not.toHaveClass(/open/);
  await expect(window.locator('#consoleTabResilience')).toHaveClass(/active/);
  await expect(window.locator('#resUrl')).toHaveValue(editedUrl);
});

test('replay-actions: ⇒ Mock after Send ↵ carries the replay response to the Mock tab', async () => {
  await openReplayOverlay(window, testPort);

  // The test server (beforeAll above) returns the same fixed 200 HTML page
  // for every path, so the response body/status are deterministic without
  // needing a specific route.
  await window.click('#sendReplayBtn');
  await expect(window.locator('.replay-res-status')).toHaveClass(/ok/, { timeout: 5_000 });

  await window.click('#replayToMockBtn');

  await expect(window.locator('#replayOverlay')).not.toHaveClass(/open/);
  await expect(window.locator('#consoleTabMock')).toHaveClass(/active/);
  await expect(window.locator('#mockStatus')).toHaveValue('200');
  await expect(window.locator('#mockBody')).toHaveValue('<html><body><h1>TesterBrowser test page</h1></body></html>');
  await expect(window.locator('#mockBodyNote')).toBeHidden();
});

test('replay-actions: ⇒ Mock before any Send ↵ shows the "no response" note', async () => {
  await openReplayOverlay(window, testPort);

  await window.click('#replayToMockBtn');

  await expect(window.locator('#consoleTabMock')).toHaveClass(/active/);
  await expect(window.locator('#mockBodyNote')).toBeVisible();
});

test('replay sends through the originating tab\'s own session, including its cookies (#233)', async () => {
  // #233's whole point: replay used to go through the app's default session
  // (net.fetch), which has none of a tab's cookies — send through this tab's
  // partition instead, with the Cookies table's contents as the Cookie header.
  await openReplayOverlayAt(window, fixtures.url('/echo/headers'));
  // Simulate what a recorded Cookie header would prefill: the send handler
  // folds the Cookies table into a Cookie header regardless of where the row
  // came from, so this exercises the same "explicit cookies, sent through
  // the tab's own session" path the ticket asks for.
  await window.click('#replayAddCookie');
  await window.locator('#replayCookiesTable .kv-key').last().fill('replay_test_cookie');
  await window.locator('#replayCookiesTable .kv-val').last().fill('hello');

  await window.click('#sendReplayBtn');
  await expect(window.locator('.replay-res-status')).toHaveClass(/ok/, { timeout: 10_000 });

  const bodyText = await window.locator('#replayBodyOut').textContent();
  const echoed = JSON.parse(bodyText || '{}');
  expect(echoed.cookie).toContain('replay_test_cookie=hello');

  await window.click('#closeReplayBtn');
});

test('replay is intercepted by the tab\'s Mock rules instead of touching the network (#233)', async () => {
  const sessionId = await window.locator('.tab.active').getAttribute('data-id');
  await window.evaluate(
    (id) => (window as unknown as { testerBrowser: any }).testerBrowser.mock.addRule(id, {
      id: 'replay-mock-233', urlPattern: '*/echo/headers*', method: 'GET',
      statusCode: 200, body: '{"mocked":true}', responseHeaders: { 'content-type': 'application/json' }, enabled: true,
    }),
    sessionId
  );

  await openReplayOverlayAt(window, fixtures.url('/echo/headers'));
  await window.click('#sendReplayBtn');
  await expect(window.locator('.replay-res-status')).toHaveClass(/ok/, { timeout: 10_000 });
  await expect(window.locator('.replay-mock-note')).toHaveText(/Served by mock rule/);

  const bodyText = await window.locator('#replayBodyOut').textContent();
  expect(JSON.parse(bodyText || '{}').mocked).toBe(true);

  await window.evaluate(
    (id) => (window as unknown as { testerBrowser: any }).testerBrowser.mock.removeRule(id, 'replay-mock-233'),
    sessionId
  );
  await window.click('#closeReplayBtn');
});

test('replay drops [REDACTED] headers from the prefill and never sends them (#233)', async () => {
  // #248: redactSensitiveHeaders is now re-evaluated per event, so it no
  // longer requires a fresh tab to take effect — the new tab here is just
  // test isolation (a clean URL to navigate), not a requirement. See the
  // dedicated "applies immediately to an already-open tab" test below for
  // proof of the live-toggle behavior itself.
  await window.evaluate(() => (window as unknown as { testerBrowser: any }).testerBrowser.settings.set({ redactSensitiveHeaders: true }));
  await window.click('#newSessionBtn');
  // A query string unique to this test — other tests above also navigate to
  // /echo/headers on tabs that are still open, and getTabPage() matches by
  // URL substring across every open tab, not just the active one.
  const redactUrlPath = '/echo/headers?t=redact-233';
  await window.fill('#urlbar', fixtures.url(redactUrlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, redactUrlPath, window);
  await tab.waitForLoadState('load');

  await window.click('#consoleTabNetwork');
  // The page's own navigation to redactUrlPath is itself a request that
  // matches 'echo/headers' — capture its count before the explicit fetch
  // below so waiting for .last() afterward can't resolve against that
  // earlier (already-visible) row instead of this fetch's own one.
  const echoHeadersRows = window.locator('.evt.network-request', { hasText: 'echo/headers' });
  const beforeFetchCount = await echoHeadersRows.count();
  await tab.evaluate(
    (url) => fetch(url, { headers: { Authorization: 'Bearer secret123' } }),
    fixtures.url(redactUrlPath)
  );
  await expect.poll(() => echoHeadersRows.count(), { timeout: 10_000 }).toBeGreaterThan(beforeFetchCount);
  const echoHeadersRow = echoHeadersRows.last();
  await echoHeadersRow.click();
  await window.locator('#detailReplayBtn').click();
  await expect(window.locator('#replayOverlay')).toHaveClass(/open/);

  const headerValues = await window.locator('#replayHeadersTable .kv-val').evaluateAll(
    (els) => (els as HTMLInputElement[]).map((el) => el.value)
  );
  expect(headerValues).not.toContain('[REDACTED]');

  await window.click('#sendReplayBtn');
  await expect(window.locator('.replay-res-status')).toHaveClass(/ok/, { timeout: 10_000 });
  const bodyText = await window.locator('#replayBodyOut').textContent();
  const echoed = JSON.parse(bodyText || '{}');
  for (const v of Object.values(echoed)) expect(v).not.toBe('[REDACTED]');

  await window.evaluate(() => (window as unknown as { testerBrowser: any }).testerBrowser.settings.set({ redactSensitiveHeaders: false }));
  await window.click('#closeReplayBtn');
});

// #248: SessionRecorder now takes getRedact: () => boolean and calls it per
// event instead of reading redactSensitiveHeaders once at construction —
// toggling the setting must change the very next recorded request on a tab
// that was already open before the toggle, with no new tab and no reload.
//
// Asserted directly against the recorded payload (recording:timeline) rather
// than through the Replay UI: openReplay() (#233) deliberately strips any
// header whose stored value is the literal '[REDACTED]' out of its editable
// table (showing a separate banner instead of a nonsensical prefilled
// value), so the table never actually contains the string '[REDACTED]' —
// asserting against the raw stored event is what actually proves the
// recorder redacted it. Real Chromium also doesn't reliably surface a
// custom Authorization header in every Network.requestWillBeSent (observed:
// present on a fresh connection, silently missing — reported via ExtraInfo
// instead, per #260's already-known gap — on a reused one), which is real,
// separate Chromium/CDP behavior unrelated to this ticket. Inject synthetic
// Network.requestWillBeSent messages straight onto the tab's real debugger
// EventEmitter instead (the same technique security.spec.ts uses), driving
// the real recorder deterministically through its actual pipeline.
test('turning on header redaction applies immediately to an already-open tab, without needing a new tab (#248)', async () => {
  const urlPath = '/network/status-codes.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath, window);
  await tab.waitForLoadState('load');

  const sessionId = await window.evaluate(() => document.querySelector('.tab.active')?.getAttribute('data-id'));
  expect(sessionId).toBeTruthy();

  async function injectRequest(requestId: string, url: string) {
    const ok = await app.evaluate(({ webContents }, opts) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().includes(opts.urlPath));
      if (!wc) return false;
      wc.debugger.emit('message', {}, 'Network.requestWillBeSent', {
        requestId: opts.requestId,
        request: { url: opts.url, method: 'GET', headers: { Authorization: 'Bearer secret' } },
      });
      return true;
    }, { urlPath, requestId, url });
    expect(ok).toBe(true);
  }

  const beforeUrl = fixtures.url('/echo/headers?t=redact-248-before');
  const afterUrl  = fixtures.url('/echo/headers?t=redact-248-after');

  // Before the toggle: unredacted.
  await injectRequest('redact248-before', beforeUrl);

  await window.evaluate(() => (window as unknown as { testerBrowser: any }).testerBrowser.settings.set({ redactSensitiveHeaders: true }));

  // Same tab, same recorder, no reload — after the toggle: redacted.
  await injectRequest('redact248-after', afterUrl);

  async function authorizationHeaderFor(marker: string): Promise<unknown> {
    return window.evaluate(async ({ sid, marker }) => {
      const events = await (window as unknown as { testerBrowser: any }).testerBrowser.recording.timeline(sid, { limit: 500 });
      const evt = (events as { kind: string; payload?: string }[]).find(
        (e) => e.kind === 'network-request' && e.payload?.includes(marker)
      );
      if (!evt?.payload) return undefined;
      return JSON.parse(evt.payload).request?.headers?.Authorization;
    }, { sid: sessionId, marker });
  }

  await expect.poll(() => authorizationHeaderFor('redact-248-after'), { timeout: 5_000 }).toBe('[REDACTED]');
  // The earlier row (recorded before the toggle) is unaffected — redaction
  // applies at record time, not retroactively to already-stored rows.
  expect(await authorizationHeaderFor('redact-248-before')).toBe('Bearer secret');

  await window.evaluate(() => (window as unknown as { testerBrowser: any }).testerBrowser.settings.set({ redactSensitiveHeaders: false }));
});

test('replay times out after the configured number of seconds (#233)', async () => {
  await openReplayOverlayAt(window, fixtures.url('/network/status-codes.html'));
  await window.fill('#replayUrl', fixtures.url('/network/slow?ms=5000'));
  await window.fill('#replayTimeout', '1');

  await window.click('#sendReplayBtn');
  await expect(window.locator('.replay-res-status.err')).toHaveText(/Timed out after 1 s/, { timeout: 10_000 });

  await window.click('#closeReplayBtn');
});

// ── Storage panel ─────────────────────────────────────────────────────────────

// Navigate to the test URL, switch to the Storage tab, and wait for it to load.
async function openStorageTab(win: Page, port: number) {
  await win.fill('#urlbar', `http://127.0.0.1:${port}`);
  await win.press('#urlbar', 'Enter');
  await expect(win.locator('#urlbar')).toHaveValue(/127\.0\.0\.1/, { timeout: 5_000 });
  await win.click('#consoleTabStorage');
  await waitForStorageSettled(win);
}

// storage.js's renderStoragePanel() shows a "Loading…" placeholder until
// fetchStorageData's own IPC round-trip (getCookies/getLocalStorage/…)
// resolves and the real sections render — a reliable, content-agnostic
// signal that a refresh (from switching to the tab, or #refreshStorageBtn)
// has actually completed, unlike a fixed sleep.
async function waitForStorageSettled(win: Page) {
  await expect(win.locator('#storagePanelContent')).not.toContainText('Loading…', { timeout: 10_000 });
}

// storage-section-title spans are recreated on every re-render in a fixed
// order (Cookies, Local Storage, Session Storage, IndexedDB) with a
// "Label (N)" or "Label (N/M)" (while filtered) text — waiting for the
// expected count is a precise, content-aware signal that a specific
// clear/set/refresh this test triggered has actually landed, stronger than
// waitForStorageSettled alone (which only proves *some* fetch finished).
async function waitForStorageSectionCount(win: Page, label: string, expected: number) {
  await expect(win.locator('.storage-section-title', { hasText: label }))
    .toHaveText(new RegExp(`^${label} \\(${expected}(?:/\\d+)?\\)$`));
}

// Returns the session the Storage tab is actually bound to (state.activeId,
// read via the active tab's DOM element rather than guessing from the URL —
// once more than one session has ever visited 127.0.0.1, which happens by
// the time later tests in this file run, a URL-substring match is ambiguous
// and can silently resolve to the wrong session).
async function activeSession(win: Page): Promise<{ id: string; partition: string; url: string }> {
  const activeId = await win.evaluate(() => document.querySelector('.tab.active')?.getAttribute('data-id'));
  if (!activeId) throw new Error('No active tab found');
  const sessions: Array<{ id: string; partition: string; url: string }> =
    await win.evaluate(() => (window as any).testerBrowser.sessions.list());
  const s = sessions.find(s => s.id === activeId);
  if (!s) throw new Error(`Active session ${activeId} not found in sessions.list()`);
  return s;
}

test('storage tab: add cookie via "+ Add" button', async () => {
  await openStorageTab(window, testPort);
  const { id: sessionId, partition } = await activeSession(window);

  // Start clean.
  await app.evaluate(async ({ session: electronSession }, part) => {
    await electronSession.fromPartition(part).clearStorageData({ storages: ['cookies'] });
  }, partition);

  // Reload storage panel after clearing.
  await window.click('#refreshStorageBtn');
  await waitForStorageSectionCount(window, 'Cookies', 0);

  // Click "+ Add" in the cookie section header.
  await window.locator('.storage-add-btn').first().click();

  // Fill in the add-row inputs: domain(0), name(1), value(2), path(3).
  const addRow = window.locator('.storage-add-row').first();
  await addRow.locator('input').nth(1).fill('e2e_added_cookie');
  await addRow.locator('input').nth(2).fill('e2e_value');
  await addRow.locator('input').nth(1).press('Enter');

  let added: { name: string; value: string } | undefined;
  await expect(async () => {
    const cookies: Array<{ name: string; value: string }> =
      await window.evaluate((id: string) => (window as any).testerBrowser.sessions.getCookies(id), sessionId);
    added = cookies.find(c => c.name === 'e2e_added_cookie');
    expect(added).toBeDefined();
  }).toPass({ timeout: 5_000 });
  expect(added?.value).toBe('e2e_value');
});

test('storage tab: edit cookie value by double-clicking', async () => {
  await openStorageTab(window, testPort);
  const { id: sessionId, partition } = await activeSession(window);

  // Inject a known cookie into the active session's partition.
  await app.evaluate(async ({ session: electronSession }, part) => {
    const ses = electronSession.fromPartition(part);
    await ses.clearStorageData({ storages: ['cookies'] });
    await ses.cookies.set({ url: 'http://127.0.0.1', name: 'e2e_edit_cookie', value: 'original' });
  }, partition);

  await window.click('#refreshStorageBtn');
  await waitForStorageSectionCount(window, 'Cookies', 1);

  // dblclick on the value cell (td[2]); the name cell (td[1]) keeps its text so
  // the row filter stays valid for the chained input locator.
  const cookieRow = window.locator('#storagePanel .storage-table tbody tr')
    .filter({ hasText: 'e2e_edit_cookie' });
  await cookieRow.locator('td').nth(2).dblclick();

  const editInput = cookieRow.locator('input.ls-edit-input');
  await editInput.fill('updated');
  await editInput.press('Enter');

  // commit() calls setCookie() then fetchStorageData() — wait for the
  // re-rendered cell to actually show the new value.
  await expect(cookieRow.locator('td').nth(2)).toHaveText('updated');

  const cookies: Array<{ name: string; value: string }> =
    await window.evaluate((id: string) => (window as any).testerBrowser.sessions.getCookies(id), sessionId);
  const edited = cookies.find(c => c.name === 'e2e_edit_cookie');
  expect(edited?.value).toBe('updated');
});

test('storage tab: add localStorage entry via "+ Add" button', async () => {
  await openStorageTab(window, testPort);
  const { id: sessionId } = await activeSession(window);

  await window.evaluate((id: string) => (window as any).testerBrowser.sessions.clearLocalStorage(id), sessionId);

  await window.click('#refreshStorageBtn');
  await waitForStorageSectionCount(window, 'Local Storage', 0);

  // Click "+ Add" in the localStorage section (second .storage-add-btn).
  await window.locator('.storage-add-btn').nth(1).click();

  const addRow = window.locator('#storagePanel .storage-add-row');
  await addRow.locator('input').nth(0).fill('e2e_ls_key');
  await addRow.locator('input').nth(1).fill('e2e_ls_val');
  await addRow.locator('input').nth(0).press('Enter');

  // commit() calls setLocalStorageKey() then fetchStorageData() — wait for
  // the re-rendered row to actually show the new entry.
  await expect(window.locator('#storagePanel .storage-table tbody tr').filter({ hasText: 'e2e_ls_key' })).toBeVisible();

  const ls: Record<string, string> =
    await window.evaluate((id: string) => (window as any).testerBrowser.sessions.getLocalStorage(id), sessionId);
  expect(ls['e2e_ls_key']).toBe('e2e_ls_val');
});

test('storage tab: rename localStorage key by double-clicking', async () => {
  await openStorageTab(window, testPort);
  const { id: sessionId } = await activeSession(window);

  await window.evaluate((id: string) => (window as any).testerBrowser.sessions.clearLocalStorage(id), sessionId);
  await window.evaluate(([id, k, v]: string[]) =>
    (window as any).testerBrowser.sessions.setLocalStorageKey(id, k, v),
  [sessionId, 'old_key', 'kept_value']);

  await window.click('#refreshStorageBtn');
  await waitForStorageSectionCount(window, 'Local Storage', 1);

  const lsRow = window.locator('#storagePanel .storage-table tbody tr')
    .filter({ hasText: 'old_key' });
  await lsRow.locator('td').nth(0).dblclick();

  // dblclick replaces the key cell's text with an <input>, so the row filter no
  // longer matches; scope the input locator to the panel instead of the row.
  const editInput = window.locator('#storagePanel input.ls-edit-input');
  await editInput.fill('new_key');
  await editInput.press('Enter');

  // commit() calls setLocalStorageKey()+deleteLocalStorageKey() then
  // fetchStorageData() — wait for the re-rendered row to show the new key.
  await expect(window.locator('#storagePanel .storage-table tbody tr').filter({ hasText: 'new_key' })).toBeVisible();

  const ls: Record<string, string> =
    await window.evaluate((id: string) => (window as any).testerBrowser.sessions.getLocalStorage(id), sessionId);
  expect(ls['new_key']).toBe('kept_value');
  expect(ls['old_key']).toBeUndefined();
});

// #234: typing in the filter must re-render from the already-fetched data,
// never re-fetch. Proven by adding a cookie out-of-band (bypassing the
// panel entirely, as a page or another tool would) while a filter that
// would match it is typed: if filtering re-fetched, the new cookie would
// appear; since it's cache-only, it stays absent until an explicit refresh.
test('storage tab: filter re-renders from cached data, not a fresh fetch', async () => {
  await openStorageTab(window, testPort);
  const { partition } = await activeSession(window);

  await app.evaluate(async ({ session: electronSession }, part) => {
    const ses = electronSession.fromPartition(part);
    await ses.clearStorageData({ storages: ['cookies'] });
    await ses.cookies.set({ url: 'http://127.0.0.1', name: 'e2e_filter_aaa', value: '1' });
    await ses.cookies.set({ url: 'http://127.0.0.1', name: 'e2e_filter_bbb', value: '1' });
  }, partition);

  await window.click('#refreshStorageBtn');
  await waitForStorageSectionCount(window, 'Cookies', 2);

  // Added after the panel already loaded its snapshot — a live fetch would
  // pick this up, a cache-only render never will.
  await app.evaluate(async ({ session: electronSession }, part) => {
    await electronSession.fromPartition(part).cookies.set({ url: 'http://127.0.0.1', name: 'e2e_filter_ccc', value: '1' });
  }, partition);

  // storageFilter's input handler re-renders synchronously from the cache
  // (no IPC round-trip) — no wait needed between filling it and asserting.
  await window.fill('#storageFilter', 'e2e_filter_');

  const rows = window.locator('#storagePanel .storage-table tbody tr');
  await expect(rows.filter({ hasText: 'e2e_filter_aaa' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'e2e_filter_bbb' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'e2e_filter_ccc' })).toHaveCount(0);

  // A real refresh does pick it up.
  await window.click('#refreshStorageBtn');
  await waitForStorageSectionCount(window, 'Cookies', 3);
  await expect(rows.filter({ hasText: 'e2e_filter_ccc' })).toHaveCount(1);

  // Leaving the filter populated leaks into every later test that inspects
  // #storagePanel's rows by text — clear it back to the panel's default state.
  await window.fill('#storageFilter', '');
});

test('storage tab: add cookie with Secure + SameSite=Strict round-trips through the form', async () => {
  await openStorageTab(window, testPort);
  const { id: sessionId, partition } = await activeSession(window);

  await app.evaluate(async ({ session: electronSession }, part) => {
    await electronSession.fromPartition(part).clearStorageData({ storages: ['cookies'] });
  }, partition);
  await window.click('#refreshStorageBtn');
  await waitForStorageSectionCount(window, 'Cookies', 0);

  await window.locator('.storage-add-btn').first().click();
  const addRow = window.locator('.storage-add-row').first();
  await addRow.locator('input').nth(1).fill('e2e_secure_cookie');
  await addRow.locator('input').nth(2).fill('e2e_value');
  await addRow.locator('select').selectOption('strict');
  await addRow.locator('input[type="checkbox"]').nth(0).check(); // Secure
  await addRow.locator('input').nth(1).press('Enter');

  let added: { name: string; value: string; secure: boolean; sameSite: string } | undefined;
  await expect(async () => {
    const cookies: Array<{ name: string; value: string; secure: boolean; sameSite: string }> =
      await window.evaluate((id: string) => (window as any).testerBrowser.sessions.getCookies(id), sessionId);
    added = cookies.find(c => c.name === 'e2e_secure_cookie');
    expect(added).toBeDefined();
  }).toPass({ timeout: 5_000 });
  expect(added?.secure).toBe(true);
  expect(added?.sameSite).toBe('strict');
});

test('storage tab: a failed cookie edit leaves the original value and shows an error', async () => {
  await openStorageTab(window, testPort);
  const { id: sessionId, partition } = await activeSession(window);

  await app.evaluate(async ({ session: electronSession }, part) => {
    const ses = electronSession.fromPartition(part);
    await ses.clearStorageData({ storages: ['cookies'] });
    await ses.cookies.set({ url: 'http://127.0.0.1', name: 'e2e_safe_edit_cookie', value: 'original' });
  }, partition);
  // Defensive: a filter left over from an earlier test would hide this row
  // and make the dblclick locator below wait out its full timeout.
  await window.fill('#storageFilter', '');
  await window.click('#refreshStorageBtn');
  await waitForStorageSectionCount(window, 'Cookies', 1);

  const cookieRow = window.locator('#storagePanel .storage-table tbody tr')
    .filter({ hasText: 'e2e_safe_edit_cookie' });
  await cookieRow.locator('td').nth(2).dblclick();

  const editInput = cookieRow.locator('input.ls-edit-input');
  // A semicolon is illegal inside a cookie value (it's the attribute
  // separator) — Electron's cookies.set() rejects it, giving a deterministic
  // failure to prove the edit is safe.
  await editInput.fill('bad;value');
  await editInput.press('Enter');

  await expect(window.locator('#storagePanel .storage-row-error')).toBeVisible();

  const cookies: Array<{ name: string; value: string }> =
    await window.evaluate((id: string) => (window as any).testerBrowser.sessions.getCookies(id), sessionId);
  const stillThere = cookies.find(c => c.name === 'e2e_safe_edit_cookie');
  expect(stillThere?.value).toBe('original');
  await expect(window.locator('#storagePanel .storage-table tbody tr').filter({ hasText: 'e2e_safe_edit_cookie' })).toBeVisible();
});

test('storage tab: sessionStorage section shows page-set entries', async () => {
  // A fresh tab + a query string unique to this test, since getTabPage()
  // matches by URL substring across every open tab, not just the active one
  // (see the #233 redaction test above for the same pattern).
  await window.click('#newSessionBtn');
  const ssUrlPath = '/network/status-codes.html?t=ss-234';
  await window.fill('#urlbar', fixtures.url(ssUrlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, ssUrlPath, window);
  await tab.waitForLoadState('load');
  await tab.evaluate(() => { sessionStorage.setItem('e2e_ss_key', 'e2e_ss_val'); });

  await window.click('#consoleTabStorage');
  await waitForStorageSettled(window);
  await window.click('#refreshStorageBtn');
  await waitForStorageSectionCount(window, 'Session Storage', 1);

  const ssRow = window.locator('#storagePanel .storage-table tbody tr').filter({ hasText: 'e2e_ss_key' });
  await expect(ssRow).toContainText('e2e_ss_val');
});
