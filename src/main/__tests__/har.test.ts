import { buildHar, HarEntry } from '../har';
import type { EventRow } from '../recorder';

function makeRow(kind: EventRow['kind'], ts: number, payload: object): EventRow {
  return { session_id: 'test-session', ts, kind, summary: '', payload: JSON.stringify(payload) };
}

// Checks every field HAR 1.2 requires is present and of the right type —
// the acceptance criterion is "opens without errors in a HAR 1.2 validator".
function assertHarShape(entry: HarEntry) {
  expect(typeof entry.pageref).toBe('string');
  expect(typeof entry.startedDateTime).toBe('string');
  expect(Number.isNaN(new Date(entry.startedDateTime).getTime())).toBe(false);
  expect(typeof entry.time).toBe('number');

  const { request, response, timings } = entry;
  expect(typeof request.method).toBe('string');
  expect(typeof request.url).toBe('string');
  expect(typeof request.httpVersion).toBe('string');
  expect(Array.isArray(request.headers)).toBe(true);
  expect(Array.isArray(request.queryString)).toBe(true);
  expect(Array.isArray(request.cookies)).toBe(true);
  expect(request.headersSize).toBe(-1);
  expect(typeof request.bodySize).toBe('number');

  expect(typeof response.status).toBe('number');
  expect(typeof response.statusText).toBe('string');
  expect(typeof response.httpVersion).toBe('string');
  expect(Array.isArray(response.headers)).toBe(true);
  expect(Array.isArray(response.cookies)).toBe(true);
  expect(typeof response.content.size).toBe('number');
  expect(typeof response.content.mimeType).toBe('string');
  expect(typeof response.redirectURL).toBe('string');
  expect(response.headersSize).toBe(-1);
  expect(typeof response.bodySize).toBe('number');

  expect(typeof entry.cache).toBe('object');
  for (const key of ['blocked', 'dns', 'connect', 'ssl', 'send', 'wait', 'receive'] as const) {
    expect(typeof timings[key]).toBe('number');
  }
}

describe('buildHar (#232)', () => {
  it('produces a HAR 1.2 skeleton with the given creator version', () => {
    const har = buildHar([], { creatorVersion: '1.2.3' });
    expect(har.log.version).toBe('1.2');
    expect(har.log.creator).toEqual({ name: 'TesterBrowser', version: '1.2.3' });
    expect(har.log.pages).toHaveLength(1);
    expect(har.log.entries).toEqual([]);
  });

  it('builds one entry for a simple GET with a JSON response body', () => {
    const rows: EventRow[] = [
      makeRow('network-request', 1000, {
        requestId: 'r1',
        request: { url: 'https://example.com/api/data?x=1', method: 'GET', headers: { Accept: 'application/json' } },
      }),
      makeRow('network-response', 1050, {
        requestId: 'r1',
        response: {
          url: 'https://example.com/api/data?x=1', status: 200, statusText: 'OK',
          headers: { 'content-type': 'application/json' }, mimeType: 'application/json', protocol: 'h2',
          timing: {
            requestTime: 1, dnsStart: -1, dnsEnd: -1, connectStart: -1, connectEnd: -1,
            sslStart: -1, sslEnd: -1, sendStart: 0, sendEnd: 2, receiveHeadersEnd: 40,
          },
        },
        durationMs: 50,
      }),
      makeRow('network-body', 1060, { requestId: 'r1', base64Encoded: false, body: '{"ok":true}' }),
    ];

    const { entries } = buildHar(rows, { creatorVersion: '1.0.0' }).log;
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    assertHarShape(entry);

    expect(entry.request.method).toBe('GET');
    expect(entry.request.queryString).toEqual([{ name: 'x', value: '1' }]);
    expect(entry.request.bodySize).toBe(0);
    expect(entry.response.status).toBe(200);
    expect(entry.response.content.text).toBe('{"ok":true}');
    expect(entry.response.content.mimeType).toBe('application/json');
    expect(entry.response.httpVersion).toBe('HTTP/2');
    expect(entry.time).toBe(50);
    expect(entry.timings.dns).toBe(-1);
    expect(entry.timings.send).toBe(2);
    expect(entry.timings.wait).toBe(38);
  });

  it('builds a POST entry with postData and its mimeType from Content-Type', () => {
    const rows: EventRow[] = [
      makeRow('network-request', 2000, {
        requestId: 'r2',
        request: {
          url: 'https://example.com/api/create', method: 'POST',
          headers: { 'content-type': 'application/json' }, postData: '{"name":"bob"}',
        },
      }),
      makeRow('network-response', 2020, {
        requestId: 'r2',
        response: { url: 'https://example.com/api/create', status: 201, statusText: 'Created', headers: {}, mimeType: 'application/json' },
        durationMs: 20,
      }),
    ];

    const [entry] = buildHar(rows, { creatorVersion: '1.0.0' }).log.entries;
    assertHarShape(entry);
    expect(entry.request.postData).toEqual({ mimeType: 'application/json', text: '{"name":"bob"}' });
    expect(entry.request.bodySize).toBe(Buffer.byteLength('{"name":"bob"}', 'utf-8'));
  });

  it('a 302 -> 200 redirect produces 2 entries, the first with redirectURL set', () => {
    const rows: EventRow[] = [
      makeRow('network-request', 3000, {
        requestId: 'r3',
        request: { url: 'https://example.com/old', method: 'GET', headers: {} },
      }),
      makeRow('network-request', 3010, {
        requestId: 'r3',
        request: { url: 'https://example.com/new', method: 'GET', headers: {} },
        redirectResponse: {
          url: 'https://example.com/old', status: 302, statusText: 'Found',
          headers: { location: 'https://example.com/new' }, protocol: 'http/1.1',
        },
      }),
      makeRow('network-response', 3040, {
        requestId: 'r3',
        response: { url: 'https://example.com/new', status: 200, statusText: 'OK', headers: {}, mimeType: 'text/html' },
        durationMs: 30,
      }),
    ];

    const { entries } = buildHar(rows, { creatorVersion: '1.0.0' }).log;
    expect(entries).toHaveLength(2);
    entries.forEach(assertHarShape);

    expect(entries[0].request.url).toBe('https://example.com/old');
    expect(entries[0].response.status).toBe(302);
    expect(entries[0].response.redirectURL).toBe('https://example.com/new');

    expect(entries[1].request.url).toBe('https://example.com/new');
    expect(entries[1].response.status).toBe(200);
    expect(entries[1].response.redirectURL).toBe('');
  });

  it('a base64-encoded body sets content.encoding and keeps the raw base64 text', () => {
    const rows: EventRow[] = [
      makeRow('network-request', 4000, {
        requestId: 'r4', request: { url: 'https://example.com/logo.png', method: 'GET', headers: {} },
      }),
      makeRow('network-response', 4020, {
        requestId: 'r4',
        response: { url: 'https://example.com/logo.png', status: 200, statusText: 'OK', headers: { 'content-type': 'image/png' }, mimeType: 'image/png' },
        durationMs: 20,
      }),
      makeRow('network-body', 4025, { requestId: 'r4', base64Encoded: true, body: 'aGVsbG8=' }),
    ];

    const [entry] = buildHar(rows, { creatorVersion: '1.0.0' }).log.entries;
    assertHarShape(entry);
    expect(entry.response.content.encoding).toBe('base64');
    expect(entry.response.content.text).toBe('aGVsbG8=');
    expect(entry.response.bodySize).toBe(Buffer.from('aGVsbG8=', 'base64').length);
  });

  it('a network-failed row becomes an entry with status 0 and _error set', () => {
    const rows: EventRow[] = [
      makeRow('network-request', 5000, {
        requestId: 'r5', request: { url: 'https://example.com/fail', method: 'GET', headers: {} },
      }),
      makeRow('network-failed', 5010, { requestId: 'r5', errorText: 'net::ERR_CONNECTION_REFUSED', canceled: false }),
    ];

    const [entry] = buildHar(rows, { creatorVersion: '1.0.0' }).log.entries;
    assertHarShape(entry);
    expect(entry.response.status).toBe(0);
    expect(entry.response._error).toBe('net::ERR_CONNECTION_REFUSED');
  });

  it('redacted headers ([REDACTED] values, as written by the recorder when redaction is on) pass through unchanged', () => {
    const rows: EventRow[] = [
      makeRow('network-request', 6000, {
        requestId: 'r6',
        request: { url: 'https://example.com/secure', method: 'GET', headers: { Authorization: '[REDACTED]' } },
      }),
      makeRow('network-response', 6010, {
        requestId: 'r6',
        response: { url: 'https://example.com/secure', status: 200, statusText: 'OK', headers: {}, mimeType: 'text/plain' },
        durationMs: 10,
      }),
    ];

    const [entry] = buildHar(rows, { creatorVersion: '1.0.0' }).log.entries;
    expect(entry.request.headers).toContainEqual({ name: 'Authorization', value: '[REDACTED]' });
  });
});
