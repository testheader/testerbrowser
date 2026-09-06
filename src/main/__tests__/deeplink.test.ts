import { parseDeepLink, findDeepLinkArg } from '../deeplink';

describe('parseDeepLink', () => {
  it('extracts an http(s) url from a testerbrowser:// link', () => {
    expect(parseDeepLink('testerbrowser://open?url=https%3A%2F%2Fexample.com%2Fpath')).toBe('https://example.com/path');
  });

  it('accepts plain http targets too', () => {
    expect(parseDeepLink('testerbrowser://open?url=http://example.com')).toBe('http://example.com');
  });

  it('rejects a different protocol', () => {
    expect(parseDeepLink('https://example.com?url=https://evil.com')).toBeNull();
  });

  it('rejects a non-http(s) target (e.g. file:// or javascript:)', () => {
    expect(parseDeepLink('testerbrowser://open?url=file:///etc/passwd')).toBeNull();
    expect(parseDeepLink('testerbrowser://open?url=javascript:alert(1)')).toBeNull();
  });

  it('rejects a link with no url param', () => {
    expect(parseDeepLink('testerbrowser://open')).toBeNull();
  });

  it('rejects garbage input instead of throwing', () => {
    expect(parseDeepLink('not a url at all')).toBeNull();
  });
});

describe('findDeepLinkArg', () => {
  it('finds and parses the deep link among ordinary argv entries', () => {
    const argv = ['/path/to/electron', '--flag', 'testerbrowser://open?url=https://example.com', '--other'];
    expect(findDeepLinkArg(argv)).toBe('https://example.com');
  });

  it('returns null when argv has no deep link', () => {
    expect(findDeepLinkArg(['/path/to/electron', '--flag'])).toBeNull();
  });
});
