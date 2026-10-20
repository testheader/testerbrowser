import * as fs from 'fs';
import * as path from 'path';

// #293: style.css's token blocks come from the redesign handoff
// (docs/design/ui-redesign/tokens.css); the --tb-* names must exist in both
// themes, and the legacy names must stay defined so un-restyled panels keep
// working.
const css = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'style.css'), 'utf8');

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('\n}', start));
}

const names = (b: string) => new Set([...b.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

describe('theme tokens (#293)', () => {
  const dark = names(block(':root'));
  const light = names(block('body.light-mode'));

  it('defines the --tb-* palette in both themes', () => {
    for (const t of ['chrome', 'surface', 'sunken', 'hover', 'line', 'line-strong', 'text', 'text-2', 'text-3',
      'accent', 'accent-soft', 'err', 'err-soft', 'warn', 'warn-soft', 'ok', 'ok-soft', 'page', 'shadow-pop', 'on-accent']) {
      expect(dark).toContain(`--tb-${t}`);
      expect(light).toContain(`--tb-${t}`);
    }
  });

  it('defines fonts and radii once, in :root', () => {
    for (const t of ['--tb-font-ui', '--tb-font-mono', '--tb-r-xs', '--tb-r-xl', '--tb-r-pill']) expect(dark).toContain(t);
  });

  it('keeps every legacy token name defined', () => {
    for (const t of ['--bg-deep', '--bg-primary', '--bg-secondary', '--bg-hover', '--text-primary', '--text-muted',
      '--border-color', '--accent', '--info-surface', '--error-strong', '--on-fill', '--tab-selected', '--active-tab-color']) {
      expect(dark).toContain(t);
    }
  });

  it('uses the UI and mono font tokens instead of hard-coded families', () => {
    expect(css).toMatch(/body \{[^}]*font-family: var\(--tb-font-ui\)/);
    expect(css).not.toMatch(/font-family:\s*monospace/);
  });

  it('has no hard-coded accent/status tints outside the token blocks', () => {
    expect(css).not.toMatch(/rgba\((127,\s*200,\s*255|79,\s*195,\s*247|143,\s*220,\s*143|255,\s*128,\s*128|224,\s*192,\s*96)/);
  });
});
