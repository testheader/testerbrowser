import * as fs from 'fs';
import * as path from 'path';

// #328: Mock, Resilience and A11y labels/headers are sentence case — the
// redesign spec bans text-transform: uppercase on tabs, labels and titles.
const css = fs.readFileSync(path.join(__dirname, '../../renderer/style.css'), 'utf8');

describe('sentence-case panel labels', () => {
  it('no mock-*, res-* or a11y-* rule uses text-transform: uppercase', () => {
    const offenders: string[] = [];
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = m[1].trim();
      if (/text-transform:\s*uppercase/.test(m[2]) && /(^|[\s,.])(\.(mock|res|a11y)-|#(mock|res|a11y))/.test(selector)) {
        offenders.push(selector);
      }
    }
    expect(offenders).toEqual([]);
  });
});
