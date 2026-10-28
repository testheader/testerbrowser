// Persisted favicon cache for the Speed Dial (#340): the new-tab page shows a
// site's own icon when one has been seen, otherwise an initial-letter tile —
// it never asks a third party (google.com) for one. Icons are stored as data
// URLs keyed by origin, so they survive restarts and work offline.

export interface FaviconStore {
  get(): Record<string, string>;
  set(value: Record<string, string>): void;
}

export const MAX_FAVICON_ENTRIES = 300;
export const MAX_FAVICON_BYTES = 128 * 1024;

const IMAGE_TYPES = /^image\/(png|x-icon|vnd\.microsoft\.icon|jpeg|gif|webp)$/i;

/** The cache key for a page URL: its http(s) origin, or null for anything else. */
export function faviconKey(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch { return null; }
}

/** A data URL for an icon's bytes, or null if the type or size is not acceptable. */
export function toFaviconDataUrl(bytes: Uint8Array, contentType: string | null | undefined): string | null {
  const type = (contentType ?? '').split(';')[0].trim();
  if (!IMAGE_TYPES.test(type) || bytes.length === 0 || bytes.length > MAX_FAVICON_BYTES) return null;
  return `data:${type.toLowerCase()};base64,${Buffer.from(bytes).toString('base64')}`;
}

export class FaviconCache {
  constructor(private store: FaviconStore, private max = MAX_FAVICON_ENTRIES) {}

  /** Cached data URLs for the origins of `urls`, keyed by origin. Unknown origins are omitted. */
  lookup(urls: unknown[]): Record<string, string> {
    const all = this.store.get();
    const out: Record<string, string> = {};
    for (const url of urls) {
      const key = typeof url === 'string' ? faviconKey(url) : null;
      if (key && all[key]) out[key] = all[key];
    }
    return out;
  }

  put(pageUrl: string, dataUrl: string): void {
    const key = faviconKey(pageUrl);
    if (!key) return;
    const next = { ...this.store.get() };
    delete next[key]; // re-insert last so the oldest entries are evicted first
    next[key] = dataUrl;
    const keys = Object.keys(next);
    for (const k of keys.slice(0, Math.max(0, keys.length - this.max))) delete next[k];
    this.store.set(next);
  }
}

type FetchLike = (url: string) => Promise<{ ok: boolean; headers: { get(name: string): string | null }; arrayBuffer(): Promise<ArrayBuffer> }>;

/** Download `faviconUrl` and cache it under `pageUrl`'s origin. Resolves false (never throws) if it was not cached. */
export async function cacheFavicon(cache: FaviconCache, pageUrl: string, faviconUrl: string, fetchImpl: FetchLike): Promise<boolean> {
  if (!faviconKey(pageUrl)) return false;
  try {
    const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(faviconUrl);
    if (m) {
      if (!m[2]) return false;
      const dataUrl = toFaviconDataUrl(Buffer.from(m[3], 'base64'), m[1]);
      if (!dataUrl) return false;
      cache.put(pageUrl, dataUrl);
      return true;
    }
    if (!faviconKey(faviconUrl)) return false;
    const res = await fetchImpl(faviconUrl);
    if (!res.ok) return false;
    const dataUrl = toFaviconDataUrl(new Uint8Array(await res.arrayBuffer()), res.headers.get('content-type'));
    if (!dataUrl) return false;
    cache.put(pageUrl, dataUrl);
    return true;
  } catch { return false; }
}
