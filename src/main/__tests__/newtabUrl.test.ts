import path from 'path';
import { pathToFileURL } from 'url';
import { isNewtabFileUrl, isTrustedNewtabFrame } from '../newtabUrl';

// L1: exact-path match against the bundled newtab.html, not a substring test.
const NEWTAB = path.resolve('/opt/TesterBrowser/resources/app/renderer/newtab.html');
const NEWTAB_URL = pathToFileURL(NEWTAB).href;

describe('isNewtabFileUrl (L1)', () => {
  it('matches the bundled new-tab page, with or without a query/hash', () => {
    expect(isNewtabFileUrl(NEWTAB_URL, NEWTAB)).toBe(true);
    expect(isNewtabFileUrl(`${NEWTAB_URL}#x`, NEWTAB)).toBe(true);
  });

  it.each([
    pathToFileURL(path.resolve('/home/u/Downloads/newtab.html')).href,
    'file://attacker/share/newtab.html',
    `${pathToFileURL(path.resolve('/home/u/evil.html')).href}?newtab.html`,
    'https://evil.test/renderer/newtab.html',
    'file:///opt/TesterBrowser/resources/app/renderer/newtab.html.evil',
    'not a url',
    '',
  ])('rejects %p', (url) => {
    expect(isNewtabFileUrl(url, NEWTAB)).toBe(false);
  });
});

describe('isTrustedNewtabFrame (L1)', () => {
  it('trusts only a top-level frame showing the new-tab page', () => {
    expect(isTrustedNewtabFrame({ url: NEWTAB_URL, parent: null }, NEWTAB)).toBe(true);
  });

  it('rejects a subframe even when it shows the new-tab page', () => {
    expect(isTrustedNewtabFrame({ url: NEWTAB_URL, parent: {} }, NEWTAB)).toBe(false);
  });

  it('rejects a missing frame', () => {
    expect(isTrustedNewtabFrame(null, NEWTAB)).toBe(false);
    expect(isTrustedNewtabFrame(undefined, NEWTAB)).toBe(false);
  });
});
