import { FaviconCache, cacheFavicon, faviconKey, toFaviconDataUrl } from '../faviconCache';

function memStore() {
  let data: Record<string, string> = {};
  return { get: () => data, set: (v: Record<string, string>) => { data = v; } };
}

const png = new Uint8Array([137, 80, 78, 71]);
const okFetch = (type = 'image/png', bytes = png) => async () => ({
  ok: true,
  headers: { get: () => type },
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
});

describe('faviconKey', () => {
  it('is the origin for http(s) URLs and null otherwise', () => {
    expect(faviconKey('https://github.com/a/b?x=1')).toBe('https://github.com');
    expect(faviconKey('http://localhost:3000/x')).toBe('http://localhost:3000');
    expect(faviconKey('file:///tmp/x.html')).toBeNull();
    expect(faviconKey('not a url')).toBeNull();
  });
});

describe('toFaviconDataUrl', () => {
  it('accepts small images and rejects other types, empty and oversized bodies', () => {
    expect(toFaviconDataUrl(png, 'image/png; charset=x')).toBe(`data:image/png;base64,${Buffer.from(png).toString('base64')}`);
    expect(toFaviconDataUrl(png, 'text/html')).toBeNull();
    expect(toFaviconDataUrl(png, 'image/svg+xml')).toBeNull();
    expect(toFaviconDataUrl(new Uint8Array(0), 'image/png')).toBeNull();
    expect(toFaviconDataUrl(new Uint8Array(200 * 1024), 'image/png')).toBeNull();
  });
});

describe('FaviconCache', () => {
  it('returns cached icons by origin and omits unknown ones', () => {
    const cache = new FaviconCache(memStore());
    cache.put('https://github.com/x', 'data:a');
    expect(cache.lookup(['https://github.com/other', 'https://example.com', 42])).toEqual({ 'https://github.com': 'data:a' });
  });

  it('ignores non-http pages and evicts the oldest entry past the cap', () => {
    const store = memStore();
    const cache = new FaviconCache(store, 2);
    cache.put('file:///x', 'data:z');
    cache.put('https://a.test', 'data:a');
    cache.put('https://b.test', 'data:b');
    cache.put('https://a.test', 'data:a2'); // refresh a => b is now oldest
    cache.put('https://c.test', 'data:c');
    expect(Object.keys(store.get())).toEqual(['https://a.test', 'https://c.test']);
  });
});

describe('cacheFavicon', () => {
  it('downloads, validates and stores an icon', async () => {
    const cache = new FaviconCache(memStore());
    expect(await cacheFavicon(cache, 'https://x.test/p', 'https://x.test/favicon.png', okFetch())).toBe(true);
    expect(Object.keys(cache.lookup(['https://x.test']))).toEqual(['https://x.test']);
  });

  it('stores a base64 data: icon without fetching', async () => {
    const cache = new FaviconCache(memStore());
    const fetchImpl = jest.fn();
    const url = `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
    expect(await cacheFavicon(cache, 'https://x.test/', url, fetchImpl)).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('caches nothing for a bad type, a failed fetch or a non-http page', async () => {
    const cache = new FaviconCache(memStore());
    expect(await cacheFavicon(cache, 'https://x.test/', 'https://x.test/f', okFetch('text/html'))).toBe(false);
    expect(await cacheFavicon(cache, 'https://x.test/', 'https://x.test/f', async () => { throw new Error('offline'); })).toBe(false);
    expect(await cacheFavicon(cache, 'file:///x', 'https://x.test/f', okFetch())).toBe(false);
    expect(await cacheFavicon(cache, 'https://x.test/', 'file:///f.png', okFetch())).toBe(false);
    expect(cache.lookup(['https://x.test'])).toEqual({});
  });
});
