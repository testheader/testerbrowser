import { getEventTabId } from '../../renderer/utils.js';

function ev(kind: string, overrides: Partial<{ payload: string; ts: number; summary: string }> = {}) {
  return { kind, ts: 1700000000000, summary: '', payload: '', ...overrides };
}

describe('getEventTabId (#279)', () => {
  // detail-panel.js groups a request's request/response/body/failed rows
  // into one detail tab by this id — a regression here would silently split
  // one call across several tabs, or merge two unrelated ones into one.
  it('returns the shared requestId for network-request/response/body/failed variants of the same call', () => {
    const requestId = 'req-123';
    const requestEvt  = ev('network-request',  { payload: JSON.stringify({ requestId, request: { method: 'GET', url: 'https://x' } }) });
    const responseEvt = ev('network-response', { payload: JSON.stringify({ requestId, response: { status: 200 } }) });
    const bodyEvt      = ev('network-body',     { payload: JSON.stringify({ requestId, body: 'hi' }) });
    const failedEvt     = ev('network-failed',   { payload: JSON.stringify({ requestId, errorText: 'net::ERR_FAILED' }) });

    const ids = [requestEvt, responseEvt, bodyEvt, failedEvt].map(getEventTabId);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe(requestId);
  });

  it('distinguishes two different network calls by their own requestId', () => {
    const a = ev('network-request', { payload: JSON.stringify({ requestId: 'a' }) });
    const b = ev('network-request', { payload: JSON.stringify({ requestId: 'b' }) });
    expect(getEventTabId(a)).not.toBe(getEventTabId(b));
  });

  it('falls back to a timestamp+kind id for a network event with no requestId', () => {
    const e = ev('network-request', { payload: JSON.stringify({ request: { method: 'GET' } }), ts: 1700000001000 });
    expect(getEventTabId(e)).toBe('1700000001000-network-request');
  });

  it('falls back to a timestamp+kind id for a network event with an unparseable payload', () => {
    const e = ev('network-request', { payload: 'not json', ts: 1700000002000 });
    expect(getEventTabId(e)).toBe('1700000002000-network-request');
  });

  it('falls back to a timestamp+kind id for a network event with no payload at all', () => {
    const e = ev('network-failed', { payload: '', ts: 1700000003000 });
    expect(getEventTabId(e)).toBe('1700000003000-network-failed');
  });

  it('uses the timestamp+kind id for non-network kinds even when the payload has a requestId-shaped field', () => {
    // Only kinds whose name starts with "network-" take the requestId path —
    // a console/log/exception row always gets its own timestamp+kind id.
    const e = ev('console', { payload: JSON.stringify({ requestId: 'should-be-ignored' }), ts: 1700000004000 });
    expect(getEventTabId(e)).toBe('1700000004000-console');
  });

  it('produces distinct ids for two non-network events at different timestamps', () => {
    const a = ev('console', { ts: 1 });
    const b = ev('console', { ts: 2 });
    expect(getEventTabId(a)).not.toBe(getEventTabId(b));
  });
});
