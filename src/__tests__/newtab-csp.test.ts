import fs from 'fs';
import path from 'path';

const renderer = path.join(__dirname, '..', '..', 'renderer');
const read = (f: string) => fs.readFileSync(path.join(renderer, f), 'utf8');

// Every `--tb-*: value;` declaration inside the first block that starts with `selector {`.
function tokens(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  const end = css.indexOf('\n}', start);
  const out: Record<string, string> = {};
  for (const m of css.slice(start, end).matchAll(/(--tb-[\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

describe('new-tab page (#317)', () => {
  const html = read('newtab.html');

  it("has a CSP without 'unsafe-inline' for script or style", () => {
    const csp = /Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).toContain("font-src 'self'");
  });

  it('has no inline script, style element, style attribute or inline event handler', () => {
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(html).not.toMatch(/<style[\s>]/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });

  it('keeps its copied theme tokens in sync with style.css', () => {
    const shell = read('style.css');
    const page = read('newtab.css');
    for (const selector of [':root', 'body.light-mode']) {
      const mine = tokens(page, selector);
      expect(Object.keys(mine).length).toBeGreaterThan(10);
      const theirs = tokens(shell, selector);
      for (const [name, value] of Object.entries(mine)) {
        if (name in theirs) expect({ selector, name, value }).toEqual({ selector, name, value: theirs[name] });
      }
    }
  });
});
