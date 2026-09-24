import { escHtml } from '../../renderer/utils.js';

describe('escHtml (#218)', () => {
  it('escapes all five special characters', () => {
    expect(escHtml('&')).toBe('&amp;');
    expect(escHtml('<')).toBe('&lt;');
    expect(escHtml('>')).toBe('&gt;');
    expect(escHtml('"')).toBe('&quot;');
    expect(escHtml("'")).toBe('&#39;');
  });

  it('escapes a mock/resilience-style URL pattern with quotes and HTML', () => {
    const input = '*/q?x="a"&y=<b>';
    expect(escHtml(input)).toBe('*/q?x=&quot;a&quot;&amp;y=&lt;b&gt;');
  });

  it('escapes a body containing HTML tags and a mixed quote', () => {
    const input = '<b>bold</b>"quote"';
    expect(escHtml(input)).toBe('&lt;b&gt;bold&lt;/b&gt;&quot;quote&quot;');
  });

  it('leaves plain text untouched', () => {
    expect(escHtml('https://example.com/path?a=1&b=2')).not.toBe('https://example.com/path?a=1&b=2');
    expect(escHtml('plain text')).toBe('plain text');
  });

  it('coerces non-string input via String()', () => {
    expect(escHtml(42 as unknown as string)).toBe('42');
  });
});
