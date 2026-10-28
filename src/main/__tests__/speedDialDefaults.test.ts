import fs from 'fs';
import path from 'path';
import { DEFAULT_SPEED_DIAL } from '../speedDialDefaults';

const renderer = path.join(__dirname, '..', '..', '..', 'renderer');

describe('Speed Dial defaults (#340)', () => {
  it('no default tile points at google.com', () => {
    for (const t of DEFAULT_SPEED_DIAL) expect(new URL(t.url).hostname).not.toMatch(/(^|\.)google\.com$/);
  });

  it('renderer/newtab.js carries the same default tiles', () => {
    const js = fs.readFileSync(path.join(renderer, 'newtab.js'), 'utf8');
    const block = js.slice(js.indexOf('DEFAULT_TILES = ['), js.indexOf('];', js.indexOf('DEFAULT_TILES = [')));
    const urls = [...block.matchAll(/url:\s*'([^']+)'/g)].map((m) => m[1]);
    expect(urls).toEqual(DEFAULT_SPEED_DIAL.map((t) => t.url));
  });

  it('the new-tab page makes no google.com image requests and has no dashboard', () => {
    const js = fs.readFileSync(path.join(renderer, 'newtab.js'), 'utf8');
    const html = fs.readFileSync(path.join(renderer, 'newtab.html'), 'utf8');
    expect(js).not.toContain('s2/favicons');
    expect(html).toMatch(/img-src data:;/);
    expect(html).not.toContain('bookmarksPanel');
    expect(html).not.toContain('quickSettingsPanel');
    expect(html).not.toContain('&#9881;');
  });
});
