/**
 * Performance tests for the browser chrome itself — tab creation and
 * switching — as distinct from webview/page-load performance, which is
 * covered elsewhere (fixtures.spec.ts, etc.) and depends on what a page
 * does, not on TesterBrowser.
 *
 * Tabs default to newtab.html (a local file, no network) precisely so these
 * numbers measure chrome overhead — IPC round-trips, tab-bar DOM work — and
 * aren't skewed by what a real page's own load time contributes.
 *
 * Timing is measured entirely inside the renderer via a MutationObserver on
 * the target tab's `class` attribute, both to avoid Node↔renderer IPC jitter
 * and because Playwright's own assertion polling interval (~100ms by
 * default) would otherwise dominate a measurement of something meant to
 * complete in tens of milliseconds.
 */

import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { getMainWindow, launchApp, MAIN_PATH } from './helpers';
import { startFixtureServer, FixtureServer } from './fixtures/server';

let app: ElectronApplication;
let window: Page;
let fixtures: FixtureServer;

test.beforeAll(async () => {
  fixtures = await startFixtureServer();
  app = await launchApp(MAIN_PATH);
  window = await getMainWindow(app);
  await window.waitForLoadState('load');
});

test.afterAll(async () => {
  await app.close();
  await fixtures.close();
});

// Clicks a tab's name (the real click target a user drives) and resolves
// with the milliseconds from that click until the tab's DOM element actually
// gains the "active" class — i.e. real chrome-side switch latency.
async function measureTabSwitchMs(win: Page, targetId: string): Promise<number> {
  return win.evaluate((id) => new Promise<number>((resolve, reject) => {
    const tabEl  = document.querySelector(`.tab[data-id="${id}"]`) as HTMLElement | null;
    const nameEl = tabEl?.querySelector('.tab-name') as HTMLElement | null;
    if (!tabEl || !nameEl) { reject(new Error(`tab ${id} not found`)); return; }
    if (tabEl.classList.contains('active')) { resolve(0); return; }

    const start = performance.now();
    const observer = new MutationObserver(() => {
      if (tabEl.classList.contains('active')) {
        observer.disconnect();
        resolve(performance.now() - start);
      }
    });
    observer.observe(tabEl, { attributes: true, attributeFilter: ['class'] });
    nameEl.click();
  }), targetId);
}

async function createTabs(win: Page, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    await win.click('#newSessionBtn');
    const sessions: Array<{ id: string }> = await win.evaluate(() => (window as any).testerBrowser.sessions.list());
    ids.push(sessions[sessions.length - 1].id);
  }
  return ids;
}

test('switching to a background tab updates the active tab near-instantly', async () => {
  const initialSessions: Array<{ id: string }> = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const firstId = initialSessions[0].id;
  const [secondId] = await createTabs(window, 1); // creating a tab switches to it, leaving firstId in the background

  // Warm-up switch (back to firstId): JIT/layout costs on the very first
  // switch after launch aren't representative of steady-state clicking, so
  // don't count it — but it does leave firstId active, ready for the loop below.
  await measureTabSwitchMs(window, firstId);

  const toSecond = await measureTabSwitchMs(window, secondId);
  const toFirst  = await measureTabSwitchMs(window, firstId);

  // Generous for a software-rendered CI sandbox, but tight enough to catch a
  // regression like a fixed artificial delay on the click handler (this used
  // to be a hardcoded 250ms debounce meant to distinguish a click from the
  // start of a double-click — see tabs.js for how that's handled instead).
  expect(toFirst).toBeLessThan(150);
  expect(toSecond).toBeLessThan(150);
});

test('double-click-to-rename still works when the first click also switches tabs', async () => {
  // Regression guard for the fix above: switching no longer rebuilds the tab
  // bar's DOM (it used to, on every switch), so the two clicks of a real
  // double-click keep landing on the same node and the browser's native
  // dblclick detection keeps working.
  const sessions: Array<{ id: string }> = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const targetId = sessions[0].id;

  const nameEl = window.locator(`.tab[data-id="${targetId}"] .tab-name`);
  await nameEl.dblclick();

  const input = window.locator(`.tab[data-id="${targetId}"] input.tab-rename-input`);
  await expect(input).toBeVisible();
  await input.fill('Renamed Tab');
  await input.press('Enter');

  await expect(window.locator(`.tab[data-id="${targetId}"] .tab-name`)).toHaveText('Renamed Tab');
});

test('tab-switch latency does not scale with the number of open tabs', async () => {
  // A full teardown-and-rebuild of the tab bar on every switch would make
  // this scale with tab count; reusing existing DOM nodes should keep it
  // roughly flat regardless of how many tabs are open.
  await createTabs(window, 15);
  const sessions: Array<{ id: string }> = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  expect(sessions.length).toBeGreaterThanOrEqual(15);

  const a = sessions[0].id;
  const b = sessions[sessions.length - 1].id;

  await measureTabSwitchMs(window, b); // warm-up
  const ms = await measureTabSwitchMs(window, a);
  expect(ms).toBeLessThan(150);
});

// ── IPC bridge performance (contextBridge invoke round-trips) ───────────────
// debug.ping() is a deliberately trivial main-process handler (see index.ts)
// so these measure IPC/contextBridge overhead itself, not any feature's own
// processing cost.

test('IPC round-trip latency: 200 sequential pings average under 15ms', async () => {
  const avgMs = await window.evaluate(async () => {
    const tb = (window as any).testerBrowser;
    await tb.debug.ping(); // warm-up — JIT/first-call overhead isn't representative
    const start = performance.now();
    for (let i = 0; i < 200; i++) await tb.debug.ping();
    return (performance.now() - start) / 200;
  });
  // Generous for a software-rendered CI sandbox under xvfb — tight enough to
  // catch a regression that makes every IPC call meaningfully slower.
  expect(avgMs).toBeLessThan(15);
});

test('IPC flood does not freeze the renderer: rAF keeps ticking under load', async () => {
  const maxFrameGapMs = await window.evaluate(async () => {
    const tb = (window as any).testerBrowser;
    let maxGap = 0;
    let last = performance.now();
    let rafRunning = true;
    function tick() {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
      if (rafRunning) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);

    // Fire a flood of concurrent IPC calls — not awaited one at a time —
    // simulating rapid status updates hammering the bridge.
    const flood: Promise<unknown>[] = [];
    for (let i = 0; i < 3000; i++) flood.push(tb.debug.ping());
    await Promise.all(flood);

    await new Promise((r) => setTimeout(r, 100)); // let a couple more frames land
    rafRunning = false;
    return maxGap;
  });
  // A responsive 60fps shell should never show a multi-hundred-ms stall even
  // under an IPC flood — that would mean the flood blocked the UI thread.
  expect(maxFrameGapMs).toBeLessThan(500);
});

test('large IPC payload (a "huge browsing history"-sized object) round-trips without a multi-second UI stall', async () => {
  const result = await window.evaluate(async () => {
    const tb = (window as any).testerBrowser;
    // 20k entries comfortably exceeds urlHistoryStore's own 500-entry cap —
    // an intentionally oversized "browsing history" to stress the IPC path.
    const big = new Array(20_000).fill(0).map((_, i) => ({ i, url: 'https://example.com/page/' + i, title: 'Page ' + i }));

    let maxGap = 0;
    let last = performance.now();
    let rafRunning = true;
    function tick() {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
      if (rafRunning) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);

    const start = performance.now();
    const echoed = await tb.debug.echo(big);
    const roundTripMs = performance.now() - start;

    await new Promise((r) => setTimeout(r, 100));
    rafRunning = false;
    return { length: echoed.length, roundTripMs, maxGap };
  });
  expect(result.length).toBe(20_000);
  // Serializing a payload this size across contextBridge is inherently
  // synchronous work on the render thread — some stall is expected and not
  // a bug. What this guards against is a regression that makes it far worse
  // (e.g. accidentally round-tripping the payload multiple times).
  expect(result.maxGap).toBeLessThan(1500);
});

// ── Framerate isolation (#4) ─────────────────────────────────────────────────

test('chrome framerate stays high while a heavy page loads in a background tab', async () => {
  // Create a second tab (backgrounded — creating a tab switches to it, so the
  // original active tab is what stays in the foreground for the FPS sample)
  // and point it at a CPU/DOM-heavy fixture page, without switching to it.
  const before: Array<{ id: string }> = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const activeId = before[0].id;

  await window.evaluate(async (activeId) => {
    const tb = (window as any).testerBrowser;
    await tb.sessions.create('heavy-bg', {});
    // Switch back to the original tab so the heavy one loads in the background.
    await tb.sessions.switchTo(activeId);
  }, activeId);

  const sessions: Array<{ id: string }> = await window.evaluate(() => (window as any).testerBrowser.sessions.list());
  const bgId = sessions[sessions.length - 1].id;
  await window.evaluate((args) => (window as any).testerBrowser.sessions.navigate(args.id, args.url), {
    id: bgId, url: fixtures.url('/perf/heavy'),
  });
  await window.waitForTimeout(500); // let the heavy page start its busy-loop

  const avgFps = await window.evaluate(() => new Promise<number>((resolve) => {
    let frames = 0;
    const start = performance.now();
    function tick() {
      frames++;
      if (performance.now() - start < 1000) requestAnimationFrame(tick);
      else resolve(frames / ((performance.now() - start) / 1000));
    }
    requestAnimationFrame(tick);
  }));

  // Each tab is its own renderer process — a background tab hogging its own
  // CPU core should barely dent the chrome shell's own frame rate.
  expect(avgFps).toBeGreaterThan(30);
});
