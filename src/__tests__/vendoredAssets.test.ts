import * as fs from 'fs';
import * as path from 'path';

// #292: the redesign's icon font and monospace face are vendored under
// renderer/ (nothing may load from a CDN), and the page CSPs must allow
// same-origin fonts without loosening any other directive.
const renderer = path.join(__dirname, '..', '..', 'renderer');
const read = (rel: string) => fs.readFileSync(path.join(renderer, rel), 'utf8');

function cspOf(html: string): Record<string, string> {
  const m = html.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/);
  expect(m).not.toBeNull();
  const out: Record<string, string> = {};
  for (const part of (m as RegExpMatchArray)[1].split(';')) {
    const [name, ...vals] = part.trim().split(/\s+/);
    if (name) out[name] = vals.join(' ');
  }
  return out;
}

describe('vendored Lucide + JetBrains Mono (#292)', () => {
  it('ships the lucide font, stylesheet and licence', () => {
    for (const f of ['lucide.woff2', 'lucide.css', 'LICENSE']) {
      expect(fs.existsSync(path.join(renderer, 'vendor/lucide', f))).toBe(true);
    }
    const css = read('vendor/lucide/lucide.css');
    expect(css).toContain('.icon-globe:before');
    expect(css).toContain('lucide.woff2');
    expect(css).not.toMatch(/https?:\/\//);
  });

  it('ships JetBrains Mono 400/500/600 and the OFL, each wired through @font-face', () => {
    const style = read('style.css');
    for (const w of [400, 500, 600]) {
      const file = `jetbrains-mono-latin-${w}-normal.woff2`;
      expect(fs.statSync(path.join(renderer, 'vendor/fonts', file)).size).toBeGreaterThan(1000);
      expect(style).toContain(`vendor/fonts/${file}`);
    }
    expect(style).toContain('font-family: "JetBrains Mono"');
    expect(read('vendor/fonts/OFL.txt')).toContain('SIL OPEN FONT LICENSE');
  });

  it('index.html links lucide.css and adds only font-src \'self\' to the CSP', () => {
    const html = read('index.html');
    expect(html).toContain('href="vendor/lucide/lucide.css"');
    const csp = cspOf(html);
    expect(csp['font-src']).toBe("'self'");
    expect(csp['default-src']).toBe("'none'");
    expect(csp['script-src']).toBe("'self'");
    expect(csp['style-src']).toBe("'self'");
    expect(csp['connect-src']).toBe("'none'");
  });

  it('newtab.html allows same-origin fonts, and (#317) no longer needs unsafe-inline for script or style', () => {
    const csp = cspOf(read('newtab.html'));
    expect(csp['font-src']).toBe("'self'");
    expect(csp['script-src']).toBe("'self'");
    expect(csp['style-src']).toBe("'self'");
    expect(csp['connect-src']).toBe("'none'");
  });
});
