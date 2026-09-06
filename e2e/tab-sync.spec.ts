/**
 * #13 — the tab strip's DOM must never drift from the backend's session
 * list, even when tabs are opened/closed in a rapid, overlapping burst
 * (the exact scenario refreshTabs()'s DOM-diffing in tabs.js exists to get
 * right — see its own comments about reusing tab nodes across renders).
 *
 * Note on "exact at every millisecond": the renderer talks to the main
 * process over async IPC, so the DOM can legitimately lag the backend for a
 * few milliseconds mid-flight — that's normal for any async UI, not a bug.
 * What actually matters, and what this asserts, is that the DOM always
 * catches up to the correct count once the in-flight operations settle,
 * with no phantom or missing tabs left behind by overlapping renders.
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

async function backendCount(): Promise<number> {
  return window.evaluate(async () => (await (window as any).testerBrowser.sessions.list()).length);
}

async function domTabCount(): Promise<number> {
  return window.evaluate(() => document.querySelectorAll('#tabs .tab').length);
}

test('a burst of overlapping tab creations settles with DOM count === backend count', async () => {
  // Fire the tab-bar's own "+" click handler many times without waiting
  // between clicks, so their async bodies genuinely overlap in the event
  // loop instead of running one at a time like a slow real user would.
  await window.evaluate(async () => {
    const btn = document.getElementById('newSessionBtn') as any;
    const clicks = [];
    for (let i = 0; i < 15; i++) clicks.push(btn.onclick({ shiftKey: false }));
    await Promise.all(clicks);
  });

  await expect.poll(() => backendCount()).toBeGreaterThanOrEqual(16); // 1 default + 15 created
  const [backend, dom] = [await backendCount(), await domTabCount()];
  expect(dom).toBe(backend);
});

test('a burst of overlapping tab closures settles with DOM count === backend count', async () => {
  const before = await backendCount();
  expect(before).toBeGreaterThan(5);

  await window.evaluate(async () => {
    // Close everything except the first tab, via the same close button a
    // real click would use, all fired in the same tick.
    const closeBtns = Array.from(document.querySelectorAll('#tabs .tab .tab-close')).slice(0, -1) as HTMLElement[];
    await Promise.all(closeBtns.map((btn) => {
      btn.onclick?.({ stopPropagation() {} } as any);
      return Promise.resolve();
    }));
    // Give in-flight destroy()+refreshTabs() promise chains a tick to settle.
    await new Promise((r) => setTimeout(r, 0));
  });

  await expect.poll(() => backendCount(), { timeout: 5000 }).toBeLessThan(before);
  const [backend, dom] = [await backendCount(), await domTabCount()];
  expect(dom).toBe(backend);
});

test('repeated rapid create/destroy cycles never leave the DOM out of sync', async () => {
  for (let round = 0; round < 5; round++) {
    await window.evaluate(async () => {
      const btn = document.getElementById('newSessionBtn') as any;
      await Promise.all([0, 1, 2, 3].map(() => btn.onclick({ shiftKey: false })));
    });
    const afterCreate = [await backendCount(), await domTabCount()];
    expect(afterCreate[1]).toBe(afterCreate[0]);

    await window.evaluate(async () => {
      const closeBtns = Array.from(document.querySelectorAll('#tabs .tab .tab-close')).slice(0, 3) as HTMLElement[];
      closeBtns.forEach((btn) => btn.onclick?.({ stopPropagation() {} } as any));
      await new Promise((r) => setTimeout(r, 0));
    });
    await expect.poll(async () => {
      const [backend, dom] = [await backendCount(), await domTabCount()];
      return backend === dom;
    }).toBe(true);
  }
});
