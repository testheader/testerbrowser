import { isMixedContent } from '../sessionManager';

describe('isMixedContent (#266)', () => {
  it('is true when CDP classifies the request as blockable', () => {
    expect(isMixedContent('https://example.com/', 'http://example.com/img.png', 'blockable')).toBe(true);
  });

  it('is true when CDP classifies the request as optionally-blockable', () => {
    expect(isMixedContent('https://example.com/', 'http://example.com/img.png', 'optionally-blockable')).toBe(true);
  });

  it('is false when CDP explicitly classifies the request as none, even on an http: subresource', () => {
    expect(isMixedContent('https://example.com/', 'http://example.com/img.png', 'none')).toBe(false);
  });

  it('falls back to scheme comparison when CDP gives no mixedContentType at all', () => {
    expect(isMixedContent('https://example.com/', 'http://example.com/img.png', undefined)).toBe(true);
  });

  it('is false via the fallback when both page and request are https', () => {
    expect(isMixedContent('https://example.com/', 'https://example.com/img.png', undefined)).toBe(false);
  });

  it('is false via the fallback when the page itself is http', () => {
    expect(isMixedContent('http://example.com/', 'http://example.com/img.png', undefined)).toBe(false);
  });

  it('is false for an unparseable URL', () => {
    expect(isMixedContent('not a url', 'also not a url', undefined)).toBe(false);
  });
});
