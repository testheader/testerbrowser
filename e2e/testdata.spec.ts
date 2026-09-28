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

  // The "Fill with test data" submenu only exists on the page's native
  // right-click context menu (sessionManager.ts's context-menu handler,
  // which calls Menu.buildFromTemplate(...).popup()) — there's no way to
  // drive a real native menu through Playwright. Same technique
  // snapshot.spec.ts uses: replace Menu.buildFromTemplate for the whole run
  // so a right-click still fires the real context-menu event (and builds
  // the real template, with the real click handlers closing over the real
  // session/view), but never pops an actual OS menu — tests invoke a
  // specific item's click() handler directly instead.
  await app.evaluate(({ Menu }) => {
    Menu.buildFromTemplate = ((template: unknown) => {
      (globalThis as unknown as { __lastMenuTemplate: unknown }).__lastMenuTemplate = template;
      return { popup: () => {}, closePopup: () => {} } as unknown as ReturnType<typeof Menu.buildFromTemplate>;
    }) as typeof Menu.buildFromTemplate;
  });
});

test.afterAll(async () => {
  await app.close();
  await fixtures.close();
});

type MenuItem = { label?: string; submenu?: MenuItem[]; click?: () => unknown };

// Right-clicking a real page element fires Electron's actual 'context-menu'
// event on the webContents (unlike the tab strip's own context menu, this
// one needs no IPC round-trip to simulate) — Menu.buildFromTemplate is
// already stubbed in beforeAll to capture the resulting template instead of
// popping a real menu. The lookup-and-click must happen in a *single*
// app.evaluate call: click() closures live only in the main process and are
// stripped by JSON serialization the moment a template crosses back to Node,
// so only the (serializable) label path can be passed in — never the
// template or item itself.
async function openFieldMenu(tab: Page, selector: string, ...labels: string[]): Promise<void> {
  await tab.click(selector);
  await tab.click(selector, { button: 'right' });
  await app.evaluate(async ({}, labelPath) => {
    let items = (globalThis as unknown as { __lastMenuTemplate?: MenuItem[] }).__lastMenuTemplate;
    if (!items) throw new Error('context-menu did not populate __lastMenuTemplate');
    let found: MenuItem | undefined;
    for (const label of labelPath) {
      found = items?.find((i) => i.label === label);
      if (!found) throw new Error(`Menu item "${label}" not found among [${items?.map((i) => i.label).join(', ')}]`);
      items = found.submenu;
    }
    await found?.click?.();
  }, labels);
}

test('the "Fill with test data" submenu reaches a focused field, including the new Edge cases group', async () => {
  const urlPath = '/forms/testdata.html';
  await window.click('#urlbar');
  await window.fill('#urlbar', fixtures.url(urlPath));
  await window.press('#urlbar', 'Enter');
  const tab = await getTabPage(app, urlPath);
  await tab.waitForLoadState('load');

  await openFieldMenu(tab, '#fieldA', 'Fill with test data', 'First name');
  const firstName = await tab.locator('#fieldA').inputValue();
  expect(firstName.length).toBeGreaterThan(0);

  await openFieldMenu(tab, '#fieldB', 'Fill with test data', 'Edge cases', 'SQL injection');
  await expect(tab.locator('#fieldB')).toHaveValue("' OR '1'='1");
});

test('the Edge cases submenu\'s "Test card number" fills a Luhn-valid card number', async () => {
  const urlPath = '/forms/testdata.html';
  const tab = await getTabPage(app, urlPath);

  await openFieldMenu(tab, '#fieldA', 'Fill with test data', 'Edge cases', 'Test card number');
  const card = await tab.locator('#fieldA').inputValue();
  expect(card).toMatch(/^\d+$/);
});

// #275: the custom-template modal fills whichever element currently has
// focus with the *entire* resolved template as one string (sessionManager.ts's
// injectTestData) — there's no mechanism to spread one template across two
// separate fields. The acceptance criteria's identity-matching guarantee is
// scoped to "a single call to resolveTemplate(tpl)", so the real way to
// exercise it end-to-end is one field, one template mixing {firstName} and
// {email}.
test('a custom template mixing {firstName} and {email} fills one field with a matching identity (#275)', async () => {
  const urlPath = '/forms/testdata.html';
  const tab = await getTabPage(app, urlPath);
  await tab.fill('#fieldA', '');

  await openFieldMenu(tab, '#fieldA', 'Fill with test data', 'Custom template…');

  await window.fill('#testdataInput', '{firstName} {email}');
  await window.click('#testdataFillBtn');

  await expect(tab.locator('#fieldA')).not.toHaveValue('', { timeout: 5_000 });
  const value = await tab.locator('#fieldA').inputValue();
  const [firstName, email] = value.split(' ');
  const localPart = email.split('@')[0];
  expect(localPart.toLowerCase()).toMatch(new RegExp(`^${firstName.toLowerCase()}\\.[a-z]+$`));
});
