import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { getMainWindow, getTabPage, launchApp, MAIN_PATH } from './helpers';
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

// #urlbar (the real <input>, text made transparent while unfocused) and
// #urlbarDisplay (an absolutely-positioned div showing the styled URL) are
// meant to be mutually exclusive — exactly one ever shows visible text.
async function urlbarLayerState() {
  return window.evaluate(() => {
    const urlbar  = document.getElementById('urlbar') as HTMLInputElement;
    const display = document.getElementById('urlbarDisplay') as HTMLElement;
    const urlbarStyle  = getComputedStyle(urlbar);
    const displayStyle = getComputedStyle(display);
    // "Visible text" for #urlbar means its own color isn't transparent; for
    // #urlbarDisplay it means display isn't none (it has no other hiding
    // mechanism).
    const urlbarTextVisible  = urlbarStyle.color !== 'rgba(0, 0, 0, 0)' && urlbarStyle.color !== 'transparent';
    const displayTextVisible = displayStyle.display !== 'none';
    return { urlbarTextVisible, displayTextVisible, displayText: display.textContent };
  });
}

test('only one of #urlbar / #urlbarDisplay ever shows visible text, across focus/blur/navigate/tab-switch', async () => {
  // Unfocused with no navigation yet.
  let state = await urlbarLayerState();
  expect(state.urlbarTextVisible).toBe(false);
  expect(state.displayTextVisible).toBe(true);

  // Focused.
  await window.click('#urlbar');
  state = await urlbarLayerState();
  expect(state.urlbarTextVisible).toBe(true);
  expect(state.displayTextVisible).toBe(false);

  // Navigate (Enter blurs the input as part of the handler).
  await window.fill('#urlbar', fixtures.url());
  await window.press('#urlbar', 'Enter');
  await expect.poll(async () => (await urlbarLayerState()).displayTextVisible, { timeout: 5_000 }).toBe(true);
  state = await urlbarLayerState();
  expect(state.urlbarTextVisible).toBe(false);

  // Focused again, then blurred without submitting (Escape path).
  await window.click('#urlbar');
  await window.fill('#urlbar', 'http://not-submitted.example/');
  state = await urlbarLayerState();
  expect(state.urlbarTextVisible).toBe(true);
  expect(state.displayTextVisible).toBe(false);
  await window.press('#urlbar', 'Escape');
  state = await urlbarLayerState();
  expect(state.urlbarTextVisible).toBe(false);
  expect(state.displayTextVisible).toBe(true);
});

test('#urlbarDisplay reflects the just-submitted URL immediately, without waiting on the navigation round-trip', async () => {
  // /network/slow delays its response, so the page load (and the
  // 'session:navigated' event that follows it) is guaranteed to still be
  // pending when this test checks the display a moment after submitting —
  // proving the display doesn't depend on that round-trip to show the right
  // URL.
  const slowUrl = fixtures.url('/network/slow?ms=2000');
  const historyBefore: string | undefined = await window.evaluate(
    () => (window as any).testerBrowser.urlHistory.get().then((h: string[]) => h[0])
  );
  await window.click('#urlbar');
  await window.fill('#urlbar', slowUrl);
  await window.press('#urlbar', 'Enter');

  // toolbar.js's keydown handler runs `await sessions.navigate(...)`, `await
  // urlHistory.add(...)`, then — synchronously, no further await —
  // `updateUrlbarSecurity(navigatedUrl)` and `e.target.blur()`. press()
  // itself only dispatches the keydown event and returns before that async
  // chain settles (same caveat urlbar-search.spec.ts's topHistoryUrl() poll
  // documents), so wait on urlHistory's top entry changing rather than on
  // activeElement — a focus-based proxy that can resolve `true` for reasons
  // unrelated to this handler's own blur() and was flaky in CI. The instant
  // the history entry lands, updateUrlbarSecurity()+blur() have already run
  // too (same tick), so reading displayText right after, with no further
  // retrying, still verifies it didn't wait on the — here, still 2s away —
  // 'session:navigated' round-trip.
  await expect.poll(
    () => window.evaluate(() => (window as any).testerBrowser.urlHistory.get().then((h: string[]) => h[0])),
    { timeout: 5_000 },
  ).not.toBe(historyBefore);
  const displayText = await window.locator('#urlbarDisplay').textContent();
  expect(displayText).toContain('/network/slow');

  // Let the slow response land so it doesn't bleed into the next test —
  // wait on the actual tab finishing its (still in-flight, ~2s) navigation
  // rather than a fixed sleep slightly longer than the fixture's delay.
  const slowTab = await getTabPage(app, '/network/slow');
  await slowTab.waitForLoadState('load');
});

test('#urlbar and #urlbarDisplay agree on exactly where their text starts', async () => {
  const boxes = await window.evaluate(() => {
    const urlbar  = document.getElementById('urlbar') as HTMLInputElement;
    const display = document.getElementById('urlbarDisplay') as HTMLElement;
    const urlbarStyle = getComputedStyle(urlbar);
    const urlbarRect   = urlbar.getBoundingClientRect();
    const displayRect  = display.getBoundingClientRect();
    const textStartU = urlbarRect.left + parseFloat(urlbarStyle.borderLeftWidth) + parseFloat(urlbarStyle.paddingLeft);
    const textStartD = displayRect.left; // #urlbarDisplay has no left border/padding of its own
    return { textStartU, textStartD };
  });
  expect(boxes.textStartD).toBeCloseTo(boxes.textStartU, 0);
});
