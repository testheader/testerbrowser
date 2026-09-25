import {
  normaliseKey, isTruncated, buildRequestMap, computeDiffRows, diffHeaders,
  DEFAULT_IGNORED_PARAMS, DEFAULT_IGNORED_HEADERS,
} from '../../renderer/diff-logic.js';

function ev(kind: string, payload: unknown) {
  return { kind, ts: Date.now(), summary: '', payload: JSON.stringify(payload) };
}

function requestEvent(requestId: string, method: string, url: string) {
  return ev('network-request', { requestId, request: { method, url } });
}

function responseEvent(requestId: string, status: number, opts: {
  headers?: Record<string, string>; fromDiskCache?: boolean; durationMs?: number;
} = {}) {
  return ev('network-response', {
    requestId,
    response: { status, headers: opts.headers ?? {}, fromDiskCache: !!opts.fromDiskCache },
    durationMs: opts.durationMs ?? 100,
  });
}

function failedEvent(requestId: string, errorText = 'net::ERR_FAILED') {
  return ev('network-failed', { requestId, errorText });
}

function bodyEvent(requestId: string, body: string, base64Encoded = false) {
  return ev('network-body', { requestId, body, base64Encoded });
}

describe('normaliseKey', () => {
  it('sorts query parameters by name', () => {
    expect(normaliseKey('GET', 'https://x/api?b=2&a=1'))
      .toBe(normaliseKey('GET', 'https://x/api?a=1&b=2'));
  });

  it('drops ignored parameters, including the utm_* wildcard', () => {
    const key = normaliseKey('GET', 'https://x/api?a=1&utm_source=ad&_=123', { ignoreParams: DEFAULT_IGNORED_PARAMS });
    expect(key).toBe(normaliseKey('GET', 'https://x/api?a=1'));
  });

  it('drops the fragment', () => {
    expect(normaliseKey('GET', 'https://x/api?a=1#section'))
      .toBe(normaliseKey('GET', 'https://x/api?a=1'));
  });

  it('drops the host in path mode, so the same path on two hosts matches', () => {
    const a = normaliseKey('GET', 'https://staging.example.com/api/widgets', { mode: 'path' });
    const b = normaliseKey('GET', 'https://prod.example.com/api/widgets', { mode: 'path' });
    expect(a).toBe(b);
  });

  it('keeps the host in full-URL mode, so the same path on two hosts differs', () => {
    const a = normaliseKey('GET', 'https://staging.example.com/api/widgets', { mode: 'full' });
    const b = normaliseKey('GET', 'https://prod.example.com/api/widgets', { mode: 'full' });
    expect(a).not.toBe(b);
  });
});

describe('isTruncated', () => {
  it('is true once the event count reaches the limit', () => {
    expect(isTruncated(new Array(5000).fill(0), 5000)).toBe(true);
  });
  it('is false below the limit', () => {
    expect(isTruncated(new Array(4999).fill(0), 5000)).toBe(false);
  });
});

describe('buildRequestMap', () => {
  it('pairs a request with its response, including headers/duration/body', () => {
    const events = [
      requestEvent('r1', 'GET', 'https://x/api/widgets'),
      responseEvent('r1', 200, { headers: { 'content-type': 'application/json' }, durationMs: 42 }),
      bodyEvent('r1', '{"ok":true}'),
    ];
    const map = buildRequestMap(events);
    const entry = map.get(normaliseKey('GET', 'https://x/api/widgets'));
    expect(entry).toBeDefined();
    expect(entry!.calls).toHaveLength(1);
    expect(entry!.calls[0]).toMatchObject({
      status: 200, requestId: 'r1', durationMs: 42,
      responseHeaders: { 'content-type': 'application/json' },
      body: { body: '{"ok":true}', base64Encoded: false },
    });
  });

  it('pairs a request with a failure as status "FAILED"', () => {
    const events = [
      requestEvent('r1', 'GET', 'https://x/api/widgets'),
      failedEvent('r1'),
    ];
    const map = buildRequestMap(events);
    const entry = map.get(normaliseKey('GET', 'https://x/api/widgets'));
    expect(entry!.calls[0].status).toBe('FAILED');
  });

  it('groups duplicate calls to the same normalised key under one entry', () => {
    const events = [
      requestEvent('r1', 'GET', 'https://x/api/widgets?_=1'),
      responseEvent('r1', 200),
      requestEvent('r2', 'GET', 'https://x/api/widgets?_=2'),
      responseEvent('r2', 200),
    ];
    const map = buildRequestMap(events);
    const entry = map.get(normaliseKey('GET', 'https://x/api/widgets'));
    expect(entry!.calls).toHaveLength(2);
  });

  it('a response with no matching request is ignored (no crash, no orphan entry)', () => {
    const map = buildRequestMap([responseEvent('unknown', 200)]);
    expect(map.size).toBe(0);
  });
});

describe('computeDiffRows', () => {
  const same = [requestEvent('r1', 'GET', 'https://x/api/same'), responseEvent('r1', 200)];
  const diffA = [requestEvent('r2', 'GET', 'https://x/api/diff'), responseEvent('r2', 200)];
  const diffB = [requestEvent('r3', 'GET', 'https://x/api/diff'), responseEvent('r3', 500)];
  const onlyA = [requestEvent('r4', 'GET', 'https://x/api/only-a'), responseEvent('r4', 200)];

  it('categorises same, diff and only-a rows (grouped)', () => {
    const mapA = buildRequestMap([...same, ...diffA, ...onlyA]);
    const mapB = buildRequestMap([...same, ...diffB]);
    const rows = computeDiffRows(mapA, mapB, { groupDuplicates: true });
    const byUrl = Object.fromEntries(rows.map(r => [r.url, r.category]));
    expect(byUrl['https://x/api/same']).toBe('same');
    expect(byUrl['https://x/api/diff']).toBe('diff');
    expect(byUrl['https://x/api/only-a']).toBe('only-a');
  });

  it('categorises only-b when a key exists only on the B side', () => {
    const onlyB = [requestEvent('r5', 'GET', 'https://x/api/only-b'), responseEvent('r5', 200)];
    const mapA = buildRequestMap(same);
    const mapB = buildRequestMap([...same, ...onlyB]);
    const rows = computeDiffRows(mapA, mapB);
    const row = rows.find(r => r.url === 'https://x/api/only-b');
    expect(row?.category).toBe('only-b');
  });

  it('produces one row per call when groupDuplicates is false', () => {
    const events = [
      requestEvent('r1', 'GET', 'https://x/api/dup?_=1'), responseEvent('r1', 200),
      requestEvent('r2', 'GET', 'https://x/api/dup?_=2'), responseEvent('r2', 500),
    ];
    const mapA = buildRequestMap(events);
    const mapB = buildRequestMap(events);
    const rows = computeDiffRows(mapA, mapB, { groupDuplicates: false });
    const dupRows = rows.filter(r => r.url.includes('/api/dup'));
    expect(dupRows).toHaveLength(2);
  });

  it('flags headerBodyDiffer without changing the category when status matches but a header differs', () => {
    const eventsA = [
      requestEvent('r1', 'GET', 'https://x/api/hdr'),
      responseEvent('r1', 200, { headers: { 'x-variant': '1' } }),
    ];
    const eventsB = [
      requestEvent('r2', 'GET', 'https://x/api/hdr'),
      responseEvent('r2', 200, { headers: { 'x-variant': '2' } }),
    ];
    const mapA = buildRequestMap(eventsA);
    const mapB = buildRequestMap(eventsB);
    const rows = computeDiffRows(mapA, mapB);
    const row = rows.find(r => r.url === 'https://x/api/hdr');
    expect(row?.category).toBe('same');
    expect(row?.headerBodyDiffer).toBe(true);
    expect(row?.detail?.headerDiff.changed).toEqual([{ name: 'x-variant', valueA: '1', valueB: '2' }]);
  });
});

describe('diffHeaders', () => {
  it('reports added, removed and changed headers, case-insensitively', () => {
    const a = { 'Content-Type': 'text/html', 'X-Only-A': '1' };
    const b = { 'content-type': 'text/plain', 'x-only-b': '2' };
    const result = diffHeaders(a, b, []);
    expect(result.removed).toEqual([{ name: 'x-only-a', value: '1' }]);
    expect(result.added).toEqual([{ name: 'x-only-b', value: '2' }]);
    expect(result.changed).toEqual([{ name: 'content-type', valueA: 'text/html', valueB: 'text/plain' }]);
  });

  it('excludes headers on the ignore list, case-insensitively', () => {
    const a = { Date: 'Mon', 'X-Same': '1' };
    const b = { date: 'Tue', 'x-same': '1' };
    const result = diffHeaders(a, b, DEFAULT_IGNORED_HEADERS);
    expect(result.changed).toEqual([]);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it('returns empty diffs for identical headers', () => {
    const headers = { 'content-type': 'application/json' };
    const result = diffHeaders(headers, { ...headers });
    expect(result).toEqual({ added: [], removed: [], changed: [] });
  });
});
