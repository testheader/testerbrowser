import { getHeader } from '../../renderer/utils.js';

describe('getHeader (#279)', () => {
  it('finds a header case-insensitively', () => {
    const headers = { 'Content-Type': 'application/json' };
    expect(getHeader(headers, 'content-type')).toBe('application/json');
    expect(getHeader(headers, 'CONTENT-TYPE')).toBe('application/json');
    expect(getHeader(headers, 'Content-Type')).toBe('application/json');
  });

  it('returns the empty string for a missing header', () => {
    expect(getHeader({ 'X-Foo': 'bar' }, 'x-missing')).toBe('');
  });

  it('returns the empty string when headers is undefined or null', () => {
    expect(getHeader(undefined, 'x-foo')).toBe('');
    expect(getHeader(null, 'x-foo')).toBe('');
  });

  it('returns the empty string for an empty headers object', () => {
    expect(getHeader({}, 'x-foo')).toBe('');
  });

  it('coerces a non-string header value to a string', () => {
    expect(getHeader({ 'X-Count': 42 }, 'x-count')).toBe('42');
  });

  it('matches the first key when several differ only by case (pathological input)', () => {
    // CDP headers are a plain object, so duplicate-by-case keys can't really
    // occur in practice, but Object.keys().find() taking the first match
    // (not the last, not an error) is the actual, worth-locking-down contract.
    const headers = { 'x-foo': 'first', 'X-Foo': 'second' };
    expect(getHeader(headers, 'X-FOO')).toBe('first');
  });
});
