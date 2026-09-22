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
  await window.click('#urlbar');
  await window.fill('#urlbar', slowUrl);
  await window.press('#urlbar', 'Enter');

  // testerBrowser.sessions.navigate() is a fire-and-forget loadURL() — it
  // resolves well before the page finishes loading. Wait only for the
  // keydown handler's own blur() (which runs right after its
  // navigate()/urlHistory awaits settle), then read the display's content
  // with no further retrying: at that instant, with the slow response still
  // 2s away, it must already hold the just-submitted URL, not the previous
  // page's URL left over until the much-later navigation event arrives.
  await expect.poll(
    () => window.evaluate(() => document.activeElement === document.getElementById('urlbar')),
    { timeout: 2_000 },
  ).toBe(false);
  const displayText = await window.locator('#urlbarDisplay').textContent();
  expect(displayText).toContain('/network/slow');

  // Let the slow response land so it doesn't bleed into the next test.
  await window.waitForTimeout(2_100);
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
