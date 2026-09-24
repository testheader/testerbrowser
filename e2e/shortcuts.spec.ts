import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { getMainWindow, getTabPage, launchApp, MAIN_PATH, dblclickTabName } from './helpers';
import { startFixtureServer, FixtureServer } from './fixtures/server';

// Exercises every keyboard shortcut documented in CLAUDE.md's shortcuts table,
// end to end, so a regression in the global keydown handler (shortcuts.js) or
// its per-session forwarding (sessionManager.ts's before-input-event path)
// gets caught by CI instead of only being discovered by hand.
//
// Not covered here: right-click tab (native OS context menu — Playwright has
// no way to interact with it) and drag-to-reorder (a native drag gesture, not
// meaningfully distinguishable from a click via CDP-dispatched pointer
// events). Double-click-to-rename is already covered by perf.spec.ts.
//
// Tests share one Electron instance and build on each other's state (tabs
// opened by one test are still open for the next), matching the pattern used
// throughout the rest of this e2e suite.

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

function tabCount() {
  return window.locator('.tab').count();
}

async function activeTabId(): Promise<string> {
  return window.locator('.tab.active').getAttribute('data-id') as unknown as Promise<string>;
}

// Tests that care about exact tab count or MRU order need a known starting
// point — reduce down to exactly one tab (reusing Ctrl+W, already verified
// above) so leftover tabs from earlier tests can't skew the assertions.
async function resetToSingleTab() {
  for (let i = 0; i < 20 && (await tabCount()) > 1; i++) {
    await window.keyboard.press('Control+w');
  }
  await expect.poll(tabCount).toBe(1);
}

test('Ctrl+T opens a new tab', async () => {
  const before = await tabCount();
  await window.keyboard.press('Control+t');
  await expect.poll(tabCount).toBe(before + 1);
});

test('Ctrl+W closes the active tab', async () => {
  const before = await tabCount();
  await window.keyboard.press('Control+w');
  await expect.poll(tabCount).toBe(before - 1);
});

test('Ctrl+Shift+T reopens the last closed tab', async () => {
  const beforeOpen = await tabCount();
  await window.keyboard.press('Control+t');
  // Poll until the new tab is in the DOM — keyboard.press() resolves when the
  // event is dispatched, but the resulting IPC round-trip to open the tab
  // (main process → renderer DOM update) may not have completed yet.
  await expect.poll(tabCount).toBe(beforeOpen + 1);
  const afterOpen = beforeOpen + 1;
  await window.keyboard.press('Control+w');
  await expect.poll(tabCount).toBe(afterOpen - 1);

  await window.keyboard.press('Control+Shift+T');
  await expect.poll(tabCount).toBe(afterOpen);
});

test('Ctrl+Tab / Ctrl+Shift+Tab cycle tabs by most-recently-used', async () => {
  // Start from exactly one tab so the MRU stack only ever contains A and B —
  // otherwise Ctrl+Shift+Tab's "least recently used" would land on whatever
  // third tab earlier tests happened to leave open, not A.
  await resetToSingleTab();
  const a = await activeTabId();
  await window.keyboard.press('Control+t');
  await expect.poll(tabCount).toBe(2);
  const b = await activeTabId();
  expect(b).not.toBe(a);

  // Ctrl+Tab from B goes to the previously-active tab, A.
  await window.keyboard.press('Control+Tab');
  await expect.poll(activeTabId).toBe(a);

  // Ctrl+Tab again from A goes back to B (A and B are now each other's MRU predecessor).
  await window.keyboard.press('Control+Tab');
  await expect.poll(activeTabId).toBe(b);

  // Ctrl+Shift+Tab from B goes to the least-recently-used tab, which is A again here.
  await window.keyboard.press('Control+Shift+Tab');
  await expect.poll(activeTabId).toBe(a);
});

test('Ctrl+Tab while a tab is mid-rename does not crash the tab bar (#211)', async () => {
  // shortcuts.js's Ctrl+Tab handler is a document-level keydown listener, so
  // it fires even while a tab-rename <input> has focus. Switching tabs also
  // focuses the newly-active tab's own view, which — same as clicking
  // elsewhere would — blurs the rename input via ordinary focus semantics,
  // triggering its own commit() (see startRename() in tabs.js). That commit
  // and cycleTab() -> switchToSession()'s own refreshTabs() call are two
  // independent, unsynchronized paths racing to touch the same tab's DOM:
  // updateTabElement() used to assume .tab-name was always present and
  // crashed on a null when a refreshTabs() call from either path ran while
  // it was still replaced by the rename <input>.
  await resetToSingleTab();
  await window.keyboard.press('Control+t');
  await expect.poll(tabCount).toBe(2);

  const renamingId = await activeTabId();
  // dblclickTabName dispatches 'dblclick' directly rather than relying on
  // Playwright's native two-click gesture — this test is about Ctrl+Tab
  // during a rename, not about the browser's own double-click timing
  // recognition, which has proven unreliable on CI (see perf.spec.ts's
  // rename test for the same fix and the full reasoning).
  await dblclickTabName(window, renamingId);
  await expect(window.locator(`.tab[data-id="${renamingId}"] input.tab-rename-input`)).toBeVisible();

  const pageErrors: string[] = [];
  window.on('pageerror', (err) => pageErrors.push(String(err)));

  await window.keyboard.press('Control+Tab');
  await window.waitForTimeout(300);

  expect(pageErrors).toEqual([]);
  // The tab bar itself must have survived intact — both tabs still present
  // and re-render-able, not stuck in whatever partial state a mid-loop
  // exception would have left it in. Whether the rename itself ended up
  // committed (likely, via the focus-driven blur above) or left in
  // progress is incidental to what this test checks — either way the tab
  // must be back to a normal, interactive state, not stuck mid-render.
  await expect.poll(tabCount).toBe(2);
  await expect(window.locator(`.tab[data-id="${renamingId}"] .tab-name`)).toBeVisible();

  window.removeAllListeners('pageerror');
});

test('refreshTabs() running while a tab is mid-rename (e.g. another tab\'s favicon updating) does not crash the tab bar (#211)', async () => {
  // A more direct trigger for the same underlying issue as the Ctrl+Tab test
  // above: onFaviconUpdated (tabs.js) calls refreshTabs() for *any* tab's
  // favicon changing. refreshTabs() moves every tab's element via
  // tabsEl.insertBefore() on every render (even one updateTabElement()
  // otherwise skips touching, per the null-name guard) — relocating a node
  // that contains the currently-focused rename <input> blurs it, which
  // commit()'s own blur listener treats as "done", auto-committing the
  // rename. So a still-in-progress rename never survives *any* refreshTabs()
  // call untouched, by this mechanism or Ctrl+Tab's — what actually matters,
  // and what used to crash, is that this resolves cleanly instead of hitting
  // a null .tab-name.
  await resetToSingleTab();
  const renamingId = await activeTabId();
  await dblclickTabName(window, renamingId);
  await expect(window.locator(`.tab[data-id="${renamingId}"] input.tab-rename-input`)).toBeVisible();

  const pageErrors: string[] = [];
  window.on('pageerror', (err) => pageErrors.push(String(err)));

  await app.evaluate(({ BrowserWindow }, id) => {
    BrowserWindow.getAllWindows()[0].webContents.send('session:faviconUpdated', {
      id, favicon: 'https://example.com/favicon.ico',
    });
  }, renamingId);
  await window.waitForTimeout(300);

  expect(pageErrors).toEqual([]);
  // Auto-committed (to the same, unchanged name — nothing was typed) rather
  // than left stuck as an input or torn down into nothing.
  await expect(window.locator(`.tab[data-id="${renamingId}"] .tab-name`)).toBeVisible();

  window.removeAllListeners('pageerror');
});

test('Ctrl+1 and Ctrl+9 switch tabs by position', async () => {
  // Start clean, then open two more tabs so position 1 and position 9 (last) differ.
  await resetToSingleTab();
  await window.keyboard.press('Control+t');
  await window.keyboard.press('Control+t');
  await expect(window.locator('.tab')).toHaveCount(3);
  const ids = await window.locator('.tab').evaluateAll(els => els.map(el => el.getAttribute('data-id')));

  await window.keyboard.press('Control+1');
  await expect.poll(activeTabId).toBe(ids[0]);

  await window.keyboard.press('Control+9'); // 9 always means "last tab", Chrome-style
  await expect.poll(activeTabId).toBe(ids[ids.length - 1]);
});

test('Ctrl+L focuses the URL bar', async () => {
  await window.click('body');
  await window.keyboard.press('Control+l');
  await expect(window.locator('#urlbar')).toBeFocused();
});

test('Ctrl+F opens the find bar, Escape closes it', async () => {
  await window.keyboard.press('Control+f');
  await expect(window.locator('#findBar')).toHaveClass(/open/);
  await expect(window.locator('#findInput')).toBeFocused();

  await window.keyboard.press('Escape');
  await expect(window.locator('#findBar')).not.toHaveClass(/open/);
});

// Chromium's find-in-page pipeline (webContents.findInPage / 'found-in-page')
// does not reliably fire in either of this suite's CI environments —
// confirmed identically failing under this sandbox's headless Xvfb display
// and on the e2e job's real windows-2022 runner, and verified (by calling
// webContents.findInPage() directly from the main process, bypassing this
// app's own code entirely) that Electron itself never delivers a result
// there either. That's a limitation of the automated runners, not something
// this app controls, so instead of asserting on real find results, this
// verifies the actual wiring this app owns: F3 asks find.js to search
// forward + next, Shift+F3 asks it to search backward + next.
test('F3 / Shift+F3 call findInPage with the correct direction', async () => {
  // Not '/index.html': the chrome shell's own file:// URL also ends in
  // "/index.html", so getTabPage(app, '/index.html') below would resolve to
  // the app's own window instead of the fixture tab.
  const urlPath = '/network/status-codes.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tabPage = await getTabPage(app, urlPath);
  await tabPage.waitForLoadState('load');

  await window.keyboard.press('Control+f');
  await window.fill('#findInput', 'Network');

  // contextBridge-exposed APIs are frozen, so this patches Electron's own
  // webContents.findInPage in the main process instead — the actual call
  // find.js's IPC round-trip bottoms out at (see sessionManager.findInPage).
  const patched = await app.evaluate(({ webContents }, url) => {
    const wc = webContents.getAllWebContents().find(w => w.getURL() === url);
    if (!wc) return false;
    const calls: unknown[][] = [];
    (wc as unknown as { findInPage: unknown }).findInPage = (text: string, opts: unknown) => { calls.push([text, opts]); return 0; };
    (globalThis as unknown as { __e2eFindCalls: unknown[][] }).__e2eFindCalls = calls;
    return true;
  }, tabPage.url());
  expect(patched).toBe(true);

  await window.keyboard.press('F3');
  await window.keyboard.press('Shift+F3');

  const recorded = await app.evaluate(() => (globalThis as unknown as { __e2eFindCalls?: unknown[][] }).__e2eFindCalls ?? []);
  expect(recorded.length).toBeGreaterThanOrEqual(2);
  const [, optsOnF3] = recorded[recorded.length - 2] as [string, { forward: boolean; findNext: boolean }];
  const [, optsOnShiftF3] = recorded[recorded.length - 1] as [string, { forward: boolean; findNext: boolean }];
  expect(optsOnF3.forward).toBe(true);
  expect(optsOnF3.findNext).toBe(true);
  expect(optsOnShiftF3.forward).toBe(false);
  expect(optsOnShiftF3.findNext).toBe(true);

  await window.keyboard.press('Escape');
});

test('Ctrl+D bookmarks and unbookmarks the current page', async () => {
  const urlPath = '/index.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  await (await getTabPage(app, urlPath)).waitForLoadState('load');

  await window.click('body');
  await window.keyboard.press('Control+d');
  await expect(window.locator('#bookmarkBtn')).toHaveClass(/bookmarked/);

  await window.keyboard.press('Control+d');
  await expect(window.locator('#bookmarkBtn')).not.toHaveClass(/bookmarked/);
});

test('Ctrl+Shift+B toggles the bookmarks bar', async () => {
  await window.keyboard.press('Control+Shift+B');
  await expect(window.locator('#bookmarksBar')).toHaveClass(/open/);
  await window.keyboard.press('Control+Shift+B');
  await expect(window.locator('#bookmarksBar')).not.toHaveClass(/open/);
});

async function requestCountForActiveTab(): Promise<number> {
  return window.evaluate(async () => {
    const w = window as unknown as { testerBrowser: any };
    const id = document.querySelector('.tab.active')?.getAttribute('data-id');
    if (!id) return -1;
    const events = await w.testerBrowser.recording.timeline(id, { limit: 5000 });
    return events.filter((e: { kind: string }) => e.kind === 'network-request').length;
  });
}

test('F5 and Ctrl+R reload the active tab', async () => {
  const urlPath = '/network/status-codes.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  await (await getTabPage(app, urlPath)).waitForLoadState('load');

  const before = await requestCountForActiveTab();
  await window.keyboard.press('F5');
  await expect.poll(requestCountForActiveTab, { timeout: 5_000 }).toBeGreaterThan(before);

  const afterF5 = await requestCountForActiveTab();
  await window.keyboard.press('Control+r');
  await expect.poll(requestCountForActiveTab, { timeout: 5_000 }).toBeGreaterThan(afterF5);
});

test('Escape closes the find bar (when nothing is loading)', async () => {
  await window.keyboard.press('Control+f');
  await expect(window.locator('#findBar')).toHaveClass(/open/);
  await window.keyboard.press('Escape');
  await expect(window.locator('#findBar')).not.toHaveClass(/open/);
});

test('Alt+Left / Alt+Right navigate back and forward', async () => {
  const pathA = '/network/status-codes.html';
  const pathB = '/network/redirect.html';

  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(pathA));
  await window.press('#urlbar', 'Enter');
  await (await getTabPage(app, pathA)).waitForLoadState('load');

  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(pathB));
  await window.press('#urlbar', 'Enter');
  await (await getTabPage(app, pathB)).waitForLoadState('load');

  await window.keyboard.press('Alt+ArrowLeft');
  await expect(window.locator('#urlbar')).toHaveValue(fixtures.url(pathA), { timeout: 5_000 });

  await window.keyboard.press('Alt+ArrowRight');
  await expect(window.locator('#urlbar')).toHaveValue(fixtures.url(pathB), { timeout: 5_000 });
});

test('Ctrl+= zooms in, Ctrl+- zooms out, Ctrl+0 resets zoom', async () => {
  await expect(window.locator('#zoomIndicator')).toHaveText('100%');

  await window.keyboard.press('Control+=');
  await expect(window.locator('#zoomIndicator')).not.toHaveText('100%', { timeout: 5_000 });
  const zoomedIn = await window.locator('#zoomIndicator').textContent();

  await window.keyboard.press('Control+-');
  await window.keyboard.press('Control+-');
  await expect.poll(() => window.locator('#zoomIndicator').textContent(), { timeout: 5_000 }).not.toBe(zoomedIn);

  await window.keyboard.press('Control+0');
  await expect(window.locator('#zoomIndicator')).toHaveText('100%', { timeout: 5_000 });
});

test('F12 toggles DevTools for the active tab', async () => {
  const countDevtoolsContents = () =>
    app.evaluate(({ webContents }) =>
      webContents.getAllWebContents().filter(wc => wc.getURL().startsWith('devtools://')).length);

  await window.click('body');
  const before = await countDevtoolsContents();
  await window.keyboard.press('F12');
  await expect.poll(countDevtoolsContents, { timeout: 8_000 }).toBeGreaterThan(before);

  // A little breathing room before toggling again — devtools attaches
  // asynchronously, and isDevToolsOpened() needs to reflect that first.
  await window.waitForTimeout(500);
  await window.keyboard.press('F12');
  await expect.poll(countDevtoolsContents, { timeout: 8_000 }).toBe(before);
});

test('Middle-click on a tab closes it, but not when the tab is pinned', async () => {
  await window.keyboard.press('Control+t');
  const targetId = await activeTabId();
  const before = await tabCount();

  const tab = window.locator(`.tab[data-id="${targetId}"]`);
  await tab.click({ button: 'middle' });
  await expect.poll(tabCount).toBe(before - 1);

  // Pin a tab, then confirm middle-click no longer closes it. Pinning alone
  // only updates backend state — the tab strip's data-pinned attribute (what
  // the middle-click handler actually checks) is refreshed the next time
  // refreshTabs() runs, same as after any ordinary tab switch, so switch away
  // and back to pick that up before asserting on it.
  await window.keyboard.press('Control+t');
  const pinnedId = await activeTabId();
  const otherId = (await window.locator('.tab').evaluateAll(els => els.map(el => el.getAttribute('data-id')))).find(id => id !== pinnedId)!;
  await window.evaluate((id) => (window as unknown as { testerBrowser: any }).testerBrowser.sessions.pin(id, true), pinnedId);
  await window.locator(`.tab[data-id="${otherId}"]`).click();
  await window.locator(`.tab[data-id="${pinnedId}"]`).click();
  await expect(window.locator(`.tab[data-id="${pinnedId}"]`)).toHaveAttribute('data-pinned', '1');

  const beforePinned = await tabCount();
  await window.locator(`.tab[data-id="${pinnedId}"]`).click({ button: 'middle' });
  await expect.poll(tabCount).toBe(beforePinned); // unchanged — still open
});

test('Ctrl+W does not close a pinned tab, from the chrome UI or from the page itself, but does once unpinned (#223)', async () => {
  // Not resetToSingleTab()'d — this test only checks counts relative to its
  // own captured `before` snapshots, and a leftover pinned tab from the
  // Middle-click test above is exactly the kind of state Ctrl+W's own guard
  // (what this test verifies) would now make resetToSingleTab's repeated
  // Ctrl+W presses unable to clear anyway.
  await window.keyboard.press('Control+t');
  const pinnedId = await activeTabId();
  const urlPath = '/console/logs.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);
  await tab.waitForLoadState('load');

  await window.evaluate((id) => (window as unknown as { testerBrowser: any }).testerBrowser.sessions.pin(id, true), pinnedId);
  // Pinning alone only updates backend state — the tab strip's data-pinned
  // attribute is refreshed the next time refreshTabs() runs (see the
  // middle-click test above) — switch away and back to pick it up.
  await window.keyboard.press('Control+t');
  await window.locator(`.tab[data-id="${pinnedId}"]`).click();
  await expect(window.locator(`.tab[data-id="${pinnedId}"]`)).toHaveAttribute('data-pinned', '1');
  await expect.poll(activeTabId).toBe(pinnedId);

  const beforeChrome = await tabCount();
  await window.keyboard.press('Control+w');
  await expect.poll(tabCount).toBe(beforeChrome); // unchanged — chrome-focused Ctrl+W path

  // Same shortcut, but with keyboard focus inside the pinned tab's own page
  // — the app:shortcut IPC path (sessionManager.ts's before-input-event),
  // not the chrome window's own keydown listener. Retried: under a loaded
  // CI runner, the initial `tab` handle can occasionally report "target
  // closed" for a click that lands right as the view settles after the
  // tab-switch above — re-fetching the page handle and retrying clears it,
  // same rationale as mock.spec.ts's retried detail-panel row click.
  const beforePage = await tabCount();
  await expect(async () => {
    const freshTab = await getTabPage(app, urlPath);
    await freshTab.click('body', { timeout: 2_000 });
    await freshTab.keyboard.press('Control+w');
  }).toPass({ timeout: 15_000 });
  await window.waitForTimeout(200); // app:shortcut is a fire-and-forget IPC round trip
  await expect.poll(tabCount).toBe(beforePage); // still unchanged

  // Unpin and confirm Ctrl+W now closes it.
  await window.evaluate((id) => (window as unknown as { testerBrowser: any }).testerBrowser.sessions.pin(id, false), pinnedId);
  await window.keyboard.press('Control+t');
  await window.locator(`.tab[data-id="${pinnedId}"]`).click();
  await expect(window.locator(`.tab[data-id="${pinnedId}"]`)).toHaveAttribute('data-pinned', '');
  await expect.poll(activeTabId).toBe(pinnedId);

  const beforeUnpinned = await tabCount();
  await window.keyboard.press('Control+w');
  await expect.poll(tabCount).toBe(beforeUnpinned - 1);
  await expect(window.locator(`.tab[data-id="${pinnedId}"]`)).toHaveCount(0);
});

test('Middle-click on a link opens it in a new tab with the same session partition and colour', async () => {
  const urlPath = '/windows/popup.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tabPage = await getTabPage(app, urlPath);
  await tabPage.waitForLoadState('load');

  const parentId = await activeTabId();
  const sessions = await window.evaluate(() => (window as unknown as { testerBrowser: any }).testerBrowser.sessions.list());
  const parent = sessions.find((s: { id: string }) => s.id === parentId);

  const before = await tabCount();
  // The "<a> (same tab)" link — middle-click should still open it as a new
  // tab, exactly like a real browser, regardless of the missing target attr.
  await tabPage.locator('a:has-text("<a> (same tab)")').click({ button: 'middle' });
  await expect.poll(tabCount, { timeout: 5_000 }).toBe(before + 1);

  const newId = await activeTabId();
  expect(newId).not.toBe(parentId);
  const sessionsAfter = await window.evaluate(() => (window as unknown as { testerBrowser: any }).testerBrowser.sessions.list());
  const child = sessionsAfter.find((s: { id: string }) => s.id === newId);
  expect(child.partition).toBe(parent.partition);
  expect(child.color).toBe(parent.color);
});
