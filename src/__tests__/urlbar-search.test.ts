import { looksLikeUrl, buildSearchUrl } from '../../renderer/utils.js';

describe('looksLikeUrl', () => {
  it('treats an explicit scheme as a URL', () => {
    expect(looksLikeUrl('https://example.com')).toBe(true);
    expect(looksLikeUrl('http://example.com')).toBe(true);
    expect(looksLikeUrl('file:///tmp/x.html')).toBe(true);
  });

  it('treats a domain-shaped bare host as a URL', () => {
    expect(looksLikeUrl('example.com')).toBe(true);
    expect(looksLikeUrl('example.com/some/path')).toBe(true);
    expect(looksLikeUrl('sub.example.co.uk')).toBe(true);
  });

  it('treats localhost and IPv4 hosts as URLs', () => {
    expect(looksLikeUrl('localhost')).toBe(true);
    expect(looksLikeUrl('localhost:3000')).toBe(true);
    expect(looksLikeUrl('127.0.0.1')).toBe(true);
    expect(looksLikeUrl('192.168.1.1:8080/status')).toBe(true);
  });

  it('treats a plain search phrase as not a URL', () => {
    expect(looksLikeUrl('weather today')).toBe(false);
    expect(looksLikeUrl('cats')).toBe(false);
    expect(looksLikeUrl('how do I center a div')).toBe(false);
  });
});

describe('buildSearchUrl', () => {
  it('builds a Google search URL by default', () => {
    expect(buildSearchUrl('google', 'weather today')).toBe('https://www.google.com/search?q=weather%20today');
  });

  it('builds a DuckDuckGo search URL when selected', () => {
    expect(buildSearchUrl('duckduckgo', 'weather today')).toBe('https://duckduckgo.com/?q=weather%20today');
  });

  it('trims the query before encoding', () => {
    expect(buildSearchUrl('google', '  cats  ')).toBe('https://www.google.com/search?q=cats');
  });
});
