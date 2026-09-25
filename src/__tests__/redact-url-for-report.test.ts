import { redactUrlForReport } from '../../renderer/utils.js';

describe('redactUrlForReport (#246)', () => {
  it('strips a query string down to origin + pathname', () => {
    expect(redactUrlForReport('https://x.test/a/b?token=1')).toBe('https://x.test/a/b');
  });

  it('strips a fragment', () => {
    expect(redactUrlForReport('https://x.test/a/b#f')).toBe('https://x.test/a/b');
  });

  it('strips both a query string and a fragment together', () => {
    expect(redactUrlForReport('https://x.test/a/b?token=1#f')).toBe('https://x.test/a/b');
  });

  it('strips userinfo (username:password@) from the origin', () => {
    expect(redactUrlForReport('https://u:p@x.test/')).toBe('https://x.test/');
  });

  it('shows a non-http(s) URL as just its scheme, with no local path', () => {
    expect(redactUrlForReport('file:///Users/tester/secret-project/notes.txt')).toBe('file:');
  });

  it('keeps http (not just https) origin + pathname', () => {
    expect(redactUrlForReport('http://localhost:3000/dashboard?session=abc')).toBe('http://localhost:3000/dashboard');
  });

  it('returns the raw string for an unparseable URL instead of throwing', () => {
    expect(() => redactUrlForReport('not a url')).not.toThrow();
    expect(redactUrlForReport('not a url')).toBe('not a url');
  });

  it('returns an empty string for empty/falsy input', () => {
    expect(redactUrlForReport('')).toBe('');
  });
});
