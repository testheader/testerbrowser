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
