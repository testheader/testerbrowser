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
 *
 * #253: every test builds the exact tabs it measures itself (via
 * createTabs), rather than reading whatever sessions.list() happens to
 * contain — each test passes the same way whether it's the only test run
 * (`-g`) or run after the others in this file. Every timing is the median
 * of 5 switches after one untimed warm-up, not a single sample, since a
 * single sample on a shared CI runner is exactly the kind of thing that
 * turns runner noise into a red build.
 */

import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { getMainWindow, launchApp, MAIN_PATH, dblclickTabName } from './helpers';

let app: ElectronApplication;
let window: Page;

test.beforeAll(async () => {
  app = await launchApp(MAIN_PATH);
  window = await getMainWindow(app);
  await window.waitForLoadState('load');
});

test.afterAll(async () => {
  await app.close();
});

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

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

// Switches back and forth between two tabs 5 times (after one untimed
// warm-up switch) and returns the median round-trip-half latency, i.e. the
// median of all 10 individual switch measurements.
async function medianSwitchMs(win: Page, a: string, b: string): Promise<number> {
  await measureTabSwitchMs(win, a); // warm-up — leaves `a` active
  const samples: number[] = [];
  for (let i = 0; i < 5; i++) {
    samples.push(await measureTabSwitchMs(win, b));
    samples.push(await measureTabSwitchMs(win, a));
  }
  return median(samples);
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
  const [a, b] = await createTabs(window, 2);
  const ms = await medianSwitchMs(window, a, b);

  // Generous for a software-rendered CI sandbox, but tight enough to catch a
  // regression like a fixed artificial delay on the click handler (this used
  // to be a hardcoded 250ms debounce meant to distinguish a click from the
  // start of a double-click — see tabs.js for how that's handled instead).
  expect(ms).toBeLessThan(200);
});

test('double-click-to-rename still works when the first click also switches tabs', async () => {
  // Regression guard for the fix above: switching no longer rebuilds the tab
  // bar's DOM (it used to, on every switch), so a tab's .tab-name node
  // survives the switchToSession() its own first click triggers, and a
  // subsequent interaction still lands on that same, persistent node.
  const [targetId] = await createTabs(window, 1);

  const nameEl = window.locator(`.tab[data-id="${targetId}"] .tab-name`);
  // The first click of a real double-click also fires a plain 'click' (which
  // switches to this tab) before 'dblclick' — trigger that switch for real,
  // then dispatch dblclick directly via the helper rather than relying on
  // Playwright's native .dblclick() gesture: two synthetic clicks landing
  // within Chromium's own double-click interval has proven unreliable on
  // CI (consistently, not just occasionally), and what this test cares
  // about is that the switch didn't tear down the node dblclick targets —
  // not whether the browser's own gesture recognition succeeds.
  await nameEl.click();
  await dblclickTabName(window, targetId);

  const input = window.locator(`.tab[data-id="${targetId}"] input.tab-rename-input`);
  await expect(input).toBeVisible();
  await input.fill('Renamed Tab');
  await input.press('Enter');

  await expect(window.locator(`.tab[data-id="${targetId}"] .tab-name`)).toHaveText('Renamed Tab');
});

test('tab-switch latency does not scale with the number of open tabs', async () => {
  // A full teardown-and-rebuild of the tab bar on every switch would make
  // this scale with tab count; reusing existing DOM nodes should keep it
  // roughly flat regardless of how many tabs are open. Compared as a
  // relative bound measured in the same run (2 tabs vs. 16), not a fixed
  // number, since absolute per-switch latency varies with the runner.
  const [a2, b2] = await createTabs(window, 2);
  const baseline = await medianSwitchMs(window, a2, b2);

  const rest = await createTabs(window, 14); // 16 open tabs total
  const wide = await medianSwitchMs(window, a2, rest[rest.length - 1]);

  expect(wide).toBeLessThan(3 * baseline + 50);
});
