import { firstHttpUrl } from '../singleInstance';

describe('firstHttpUrl (#257)', () => {
  it('finds an http URL', () => {
    expect(firstHttpUrl(['/path/to/electron', 'http://example.com'])).toBe('http://example.com');
  });

  it('finds an https URL', () => {
    expect(firstHttpUrl(['/path/to/TesterBrowser.exe', 'https://example.com/page'])).toBe('https://example.com/page');
  });

  it('is case-insensitive on the scheme', () => {
    expect(firstHttpUrl(['HTTPS://example.com'])).toBe('HTTPS://example.com');
  });

  it('ignores CLI flags', () => {
    expect(firstHttpUrl(['/path/to/electron', '--flag', '--user-data-dir=/tmp/foo'])).toBeNull();
  });

  it('ignores a file: URL', () => {
    expect(firstHttpUrl(['/path/to/electron', 'file:///C:/Users/test/index.html'])).toBeNull();
  });

  it('ignores just the exe path with nothing else', () => {
    expect(firstHttpUrl(['/path/to/electron'])).toBeNull();
  });

  it('ignores a javascript: URI', () => {
    expect(firstHttpUrl(['/path/to/electron', 'javascript:alert(1)'])).toBeNull();
  });

  it('returns null for an empty argv', () => {
    expect(firstHttpUrl([])).toBeNull();
  });

  it('picks the first http(s) URL when more than one is present', () => {
    expect(firstHttpUrl(['/path/to/electron', 'https://first.example.com', 'https://second.example.com']))
      .toBe('https://first.example.com');
  });
});
