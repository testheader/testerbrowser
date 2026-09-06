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
