import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { getActiveViewBounds, getMainWindow, getTabPage, launchApp, MAIN_PATH } from './helpers';
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

test.describe('logger.spec', () => {
  test('Network tab pills are visible, with only Req on by default', async () => {
    await window.locator('#consoleTabNetwork').click();
    const reqPill = window.locator('#networkPills .filter-pill[data-type="network-request"]');
    await expect(reqPill).toBeVisible();
    await expect(reqPill).toHaveClass(/\bon\b/);

    const resPill = window.locator('#networkPills .filter-pill[data-type="network-response"]');
    await expect(resPill).toBeVisible();
    await expect(resPill).not.toHaveClass(/\bon\b/);

    const errPill = window.locator('#networkPills .filter-pill[data-type="network-failed"]');
    await expect(errPill).toBeVisible();
    await expect(errPill).not.toHaveClass(/\bon\b/);
  });

  test('detail panel tab bar exists', async () => {
    await expect(window.locator('#detailPanelTabBar')).toBeAttached();
  });
});

test.describe('minimize.spec', () => {
  test('minimize button exists in console header', async () => {
    await expect(window.locator('#consolePanelMinBtn')).toBeVisible();
  });

  test('clicking minimize button hides console body', async () => {
    await expect(window.locator('#consolePanelBody')).toBeVisible();
    await window.click('#consolePanelMinBtn');
    await expect(window.locator('#consolePanelBody')).toBeHidden();
  });

  test('clicking minimize button again restores console body', async () => {
    // Body is hidden from previous test — click to restore
    await window.click('#consolePanelMinBtn');
    await expect(window.locator('#consolePanelBody')).toBeVisible();
  });

  test('minimize button title updates to reflect state', async () => {
    // Start expanded
    await expect(window.locator('#consolePanelMinBtn')).toHaveAttribute('title', 'Minimize panel');
    await window.click('#consolePanelMinBtn');
    await expect(window.locator('#consolePanelMinBtn')).toHaveAttribute('title', 'Restore panel');
    // Restore for subsequent tests
    await window.click('#consolePanelMinBtn');
  });
});

// #32: scrollbar in always-available console.
//
// Verifies that #timelinePanel has a non-zero height after tab-switching,
// which was broken when min-height: 0 was missing from the flex item.
test.describe('scrollbar.spec', () => {
  test('timeline panel is visible on initial load', async () => {
    // logger.spec (above, in this same file) switches to the Network
    // sub-tab and leaves it there — the Console sub-tab isn't actually
    // guaranteed to be active by file position, so switch to it explicitly
    // rather than assuming it, which is also what "on initial load" is
    // meant to exercise.
    await window.click('#consoleTabConsole');
    await expect(window.locator('#consoleTabConsole')).toHaveClass(/active/);

    // #timelinePanel is the only flex:1 child of #timelinePanelWrapper that
    // isn't the (also-visible, on the Console sub-tab) #consoleControls
    // toolbar row — with min-height: 0 doing its job, the panel's own height
    // should be the wrapper's height minus that toolbar's, not just "some"
    // nonzero value. The ±2px tolerance covers rounding/borders.
    const panel = window.locator('#timelinePanel');
    const wrapper = window.locator('#timelinePanelWrapper');
    const consoleControls = window.locator('#consoleControls');
    await expect(panel).toBeVisible();
    const [panelBox, wrapperBox, controlsBox] = await Promise.all([
      panel.boundingBox(), wrapper.boundingBox(), consoleControls.boundingBox(),
    ]);
    expect(panelBox).not.toBeNull();
    expect(wrapperBox).not.toBeNull();
    expect(controlsBox).not.toBeNull();
    expect(panelBox!.height).toBeGreaterThan(50);
    const expectedHeight = wrapperBox!.height - controlsBox!.height;
    expect(Math.abs(panelBox!.height - expectedHeight)).toBeLessThanOrEqual(2);
  });

  test('timeline panel remains scrollable after switching tabs', async () => {
    const panel = window.locator('#timelinePanel');
    await expect(panel).toBeVisible();
    const heightBefore = (await panel.boundingBox())!.height;
    expect(heightBefore).toBeGreaterThan(50);

    // Switch to Storage tab then back to Console. switchConsoleTab() toggles
    // the tab buttons' "active" class and panel display synchronously, so
    // waiting for the button's own active state is a real (and immediate)
    // signal rather than a guess at how long the switch takes.
    await window.click('#consoleTabStorage');
    await expect(window.locator('#consoleTabStorage')).toHaveClass(/active/);
    await window.click('#consoleTabConsole');
    await expect(window.locator('#consoleTabConsole')).toHaveClass(/active/);

    // The regression this guards: min-height: 0 missing from the flex chain
    // let #timelinePanel collapse to 0 (or some other unrelated height) once
    // its sibling panel had been displayed — proving it's back to the SAME
    // height it had before switching is a much stronger signal than "> 0".
    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.abs(box!.height - heightBefore)).toBeLessThanOrEqual(2);
  });

  test('timeline panel wrapper stays scrollable (scrollHeight > clientHeight) after multiple tab switches and enough events', async () => {
    // Flood the active tab's own console so the timeline has more entries
    // than fit in the panel — proving overflow-y actually works, not just
    // that the panel has *a* nonzero height. Directly evaluating console.log
    // in the tab's page is deterministic and fast, unlike driving the
    // performance/console-flood.html fixture's own chunked-setTimeout UI.
    const tab = await getTabPage(app, 'newtab.html');
    await tab.evaluate(() => {
      for (let i = 0; i < 300; i++) console.log('scrollbar-spec flood log', i);
    });

    for (const tabSel of ['#consoleTabStorage', '#consoleTabA11y', '#consoleTabConsole']) {
      await window.click(tabSel);
      await expect(window.locator(tabSel)).toHaveClass(/active/);
    }

    const wrapper = window.locator('#timelinePanelWrapper');
    await expect(wrapper).toBeVisible();

    // pollTimeline() only picks up new events on its own 1s interval —
    // poll on the panel's own scrollHeight rather than waiting a guessed
    // amount of time for "enough" events to have arrived and rendered.
    await expect.poll(
      () => window.locator('#timelinePanel').evaluate((el) => el.scrollHeight > el.clientHeight),
      { timeout: 15_000 },
    ).toBe(true);
  });
});

test.describe('testdata.spec', () => {
  test('testdata overlay exists in DOM', async () => {
    const overlay = window.locator('#testdataOverlay');
    await expect(overlay).toBeAttached();
  });

  test('testdata overlay is initially hidden', async () => {
    const overlay = window.locator('#testdataOverlay');
    await expect(overlay).not.toHaveClass(/open/);
  });

  test('testdata input field exists in overlay', async () => {
    const input = window.locator('#testdataInput');
    await expect(input).toBeAttached();
  });

  // #244: reachable without a focused input, via the app menu — and the modal
  // must actually be usable (painted above the page, not underneath it) once a
  // tab has real content loaded, which can only be observed by detaching the
  // native view — asserting against a blank new-tab page would pass either way.
  test('the app menu\'s "Fill with test data…" opens the modal with the page view hidden, for a tab with real content loaded (#244)', async () => {
    await window.click('#urlbar');
    await window.fill('#urlbar', fixtures.url('/index.html'));
    await window.press('#urlbar', 'Enter');
    await (await getTabPage(app, '/index.html')).waitForLoadState('load');

    const before = await getActiveViewBounds(app);
    expect(before).not.toBeNull();

    await window.click('#appName');
    await expect(window.locator('#appMenuDropdown')).toHaveClass(/open/);
    await expect(window.locator('#appMenuTestData')).toBeVisible();
    await window.click('#appMenuTestData');

    await expect(window.locator('#testdataOverlay')).toHaveClass(/open/);
    // The active tab's WebContentsView paints above all renderer HTML
    // regardless of z-index — it must be genuinely detached (no bounds to
    // report), not just covered, for the modal to actually be visible/usable.
    await expect.poll(() => getActiveViewBounds(app)).toBeNull();

    await window.click('#testdataCancelBtn');
    await expect(window.locator('#testdataOverlay')).not.toHaveClass(/open/);
    await expect.poll(() => getActiveViewBounds(app)).toEqual(before);
  });

  // #244: the plain (no-input-focused) page context menu also gets a
  // reachability entry. A real native Electron context menu can't be driven
  // through Playwright, so — per the ticket's own suggested fallback — this
  // exercises the actual main-process handler instead: it stubs
  // Menu.buildFromTemplate to capture the built template rather than ever
  // popping a real menu (the same technique used for #243's snapshot export/
  // import context-menu items), synthesizes the tab's own 'context-menu'
  // WebContents event with isEditable:false (a plain right-click, no field
  // focused), and then invokes the captured "Fill with test data…" item's
  // click() handler directly — proving the item is genuinely built into the
  // plain-menu branch and wired to the same testdata:promptTemplate event.
  test('a plain right-click (no input focused) builds a "Fill with test data…" item that opens the modal (#244)', async () => {
    await window.click('#urlbar');
    await window.fill('#urlbar', fixtures.url('/index.html'));
    await window.press('#urlbar', 'Enter');
    await (await getTabPage(app, '/index.html')).waitForLoadState('load');
    const urlPath = fixtures.url('/index.html');

    await app.evaluate(({ Menu }) => {
      Menu.buildFromTemplate = ((template: unknown) => {
        (globalThis as unknown as { __lastMenuTemplate: unknown }).__lastMenuTemplate = template;
        return { popup: () => {}, closePopup: () => {} } as unknown as ReturnType<typeof Menu.buildFromTemplate>;
      }) as typeof Menu.buildFromTemplate;
    });

    await app.evaluate(async ({ webContents }, url) => {
      const tabWc = webContents.getAllWebContents().find((wc) => wc.getURL() === url);
      if (!tabWc) throw new Error(`No tab WebContents found for ${url}`);
      tabWc.emit('context-menu', {}, {
        isEditable: false,
        selectionText: '',
        linkURL: '',
        mediaType: 'none',
        srcURL: '',
      });
      await new Promise((r) => setTimeout(r, 100));
      const template = (globalThis as unknown as { __lastMenuTemplate?: { label?: string; click?: () => unknown }[] }).__lastMenuTemplate;
      const item = template?.find((i) => i.label === 'Fill with test data…');
      if (!item?.click) throw new Error('"Fill with test data…" item not found in the plain context menu template');
      item.click();
    }, urlPath);

    await expect(window.locator('#testdataOverlay')).toHaveClass(/open/, { timeout: 5_000 });
    await window.click('#testdataCancelBtn');
    await expect(window.locator('#testdataOverlay')).not.toHaveClass(/open/);
  });
});

// Covers #169: the tab strip, app menu and window controls now share a single
// merged row instead of a separate titlebar row sitting above the tabs row.
test.describe('titlebar.spec', () => {
  test('tabs and window controls share a single row', async () => {
    const tabsBox = await window.locator('#tabs').boundingBox();
    const closeBox = await window.locator('#winCloseBtn').boundingBox();
    expect(tabsBox).not.toBeNull();
    expect(closeBox).not.toBeNull();
    // Vertical overlap = they sit on the same row rather than stacked rows.
    const overlap =
      Math.min(tabsBox!.y + tabsBox!.height, closeBox!.y + closeBox!.height) -
      Math.max(tabsBox!.y, closeBox!.y);
    expect(overlap).toBeGreaterThan(0);
  });

  test('the app menu button shows a logo, not the old wordmark text', async () => {
    const appName = window.locator('#appName');
    await expect(appName).toBeVisible();
    await expect(appName).not.toContainText('TesterBrowser');
    await expect(window.locator('#appLogo')).toBeVisible();
  });

  test('clicking the app menu button opens the dropdown with its menu items', async () => {
    await window.click('#appName');
    await expect(window.locator('#appMenuDropdown')).toHaveClass(/open/);
    await expect(window.locator('#appMenuNewTemp')).toBeVisible();
    await expect(window.locator('#appMenuSettings')).toBeVisible();
    await expect(window.locator('#appMenuBugReport')).toBeVisible();
    // Close it again so it doesn't leak into later tests.
    await window.click('#appName');
    await expect(window.locator('#appMenuDropdown')).not.toHaveClass(/open/);
  });

  test('window controls stay visible and clickable when the tab strip overflows', async () => {
    // Open a handful of extra tabs (kept small — each is a real isolated
    // session) and then artificially constrain the tab strip's available width
    // via injected CSS, exactly like a narrow window would, so the overflow
    // path is exercised deterministically without needing dozens of real
    // sessions.
    for (let i = 0; i < 8; i++) {
      await window.keyboard.press('Control+t');
    }
    await expect.poll(() => window.locator('.tab').count()).toBeGreaterThan(8);

    await window.locator('#tabs').evaluate((el) => { (el as HTMLElement).style.maxWidth = '250px'; });

    const tabsEl = window.locator('#tabs');
    const scrollWidth = await tabsEl.evaluate((el) => el.scrollWidth);
    const clientWidth = await tabsEl.evaluate((el) => el.clientWidth);
    expect(scrollWidth).toBeGreaterThan(clientWidth);

    // The window controls sit outside #tabs and must stay fully on-screen and
    // clickable regardless of how much the tab strip overflows.
    const winWidth = await window.evaluate(() => window.innerWidth);
    const closeBox = await window.locator('#winCloseBtn').boundingBox();
    expect(closeBox).not.toBeNull();
    expect(closeBox!.x + closeBox!.width).toBeLessThanOrEqual(winWidth + 1);
    await expect(window.locator('#winCloseBtn')).toBeVisible();
    await expect(window.locator('#winCloseBtn')).toBeEnabled();

    // Reduce back down so later specs (run in the same suite) start clean.
    for (let i = 0; i < 20 && (await window.locator('.tab').count()) > 1; i++) {
      await window.keyboard.press('Control+w');
    }
  });
});
