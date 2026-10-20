import { buildNetworkRow, formatDuration, resourceTypeLabel, responseSize, splitUrl } from '../../renderer/network-rows.js';
import { formatSize } from '../../renderer/utils.js';

describe('Network row model (#300)', () => {
  const req = { requestId: 'r1', type: 'Fetch', request: { method: 'GET', url: 'https://api.example.com/api/flags?a=1' } };

  it('pairs the response into the request row', () => {
    const row = buildNetworkRow(req, { status: 503, durationMs: 2001, size: 200, mimeType: 'application/json' }, undefined, 'resilience');
    expect(row).toMatchObject({
      requestId: 'r1', method: 'GET', name: '/api/flags?a=1', host: 'api.example.com',
      status: 503, failed: false, isError: true, type: 'fetch', sizeLabel: '0.2 kB', durationMs: 2001, tag: 'resilience',
    });
  });

  it('a pending request has no status/size/time yet and is not an error', () => {
    const row = buildNetworkRow(req, undefined, undefined, null);
    expect(row).toMatchObject({ status: null, failed: false, isError: false, size: null, sizeLabel: '', durationMs: null, tag: null });
  });

  it('a failed request carries its error text and counts as an error', () => {
    const row = buildNetworkRow(req, undefined, 'net::ERR_CONNECTION_REFUSED', null);
    expect(row).toMatchObject({ failed: true, errorText: 'net::ERR_CONNECTION_REFUSED', isError: true, status: null });
  });

  it('4xx counts as an error, 3xx and 2xx do not', () => {
    expect(buildNetworkRow(req, { status: 404 }, undefined, null).isError).toBe(true);
    expect(buildNetworkRow(req, { status: 302 }, undefined, null).isError).toBe(false);
    expect(buildNetworkRow(req, { status: 200 }, undefined, null).isError).toBe(false);
  });

  it('formats sizes, durations, types and URLs', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(1700)).toBe('1.7 kB');
    expect(formatSize(470000)).toBe('470 kB');
    expect(formatSize(2500000)).toBe('2.5 MB');
    expect(formatDuration(315)).toBe('315 ms');
    expect(formatDuration(2000)).toBe('2.00 s');
    expect(resourceTypeLabel('Document', '')).toBe('document');
    expect(resourceTypeLabel(undefined, 'text/css; charset=utf-8')).toBe('css');
    expect(splitUrl('https://h.test/a/b')).toEqual({ name: '/a/b', host: 'h.test' });
    expect(splitUrl('not a url')).toEqual({ name: 'not a url', host: '' });
    expect(responseSize({ 'Content-Length': '1738' })).toBe(1738);
    expect(responseSize({})).toBeNull();
  });
});
