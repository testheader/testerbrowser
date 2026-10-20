import { methodFilterLabel, networkSummary } from '../../renderer/utils.js';

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'Other'];

describe('Network toolbar helpers (#299)', () => {
  it('methodFilterLabel reflects the selection', () => {
    expect(methodFilterLabel(METHODS, new Set(METHODS))).toBe('Method: Any');
    expect(methodFilterLabel(METHODS, new Set(['POST', 'GET']))).toBe('Method: GET, POST');
    expect(methodFilterLabel(METHODS, new Set())).toBe('Method: None');
  });

  it('networkSummary counts requests, sums Content-Length and spans time', () => {
    const res = (ts: number, len: string) => ({ kind: 'network-response', ts, payload: JSON.stringify({ response: { headers: { 'Content-Length': len } } }) });
    const events = [
      { kind: 'network-request', ts: 1000, payload: '{}' },
      res(1500, '2000'),
      { kind: 'network-request', ts: 2000, payload: '{}' },
      res(3710, '1000'),
      { kind: 'console', ts: 9999, payload: '{}' },
    ];
    expect(networkSummary(events)).toBe('2 requests · 3 kB · 2.71 s');
  });

  it('networkSummary is empty without requests, omits unknown sizes, and uses ms for short spans', () => {
    expect(networkSummary([])).toBe('');
    expect(networkSummary([{ kind: 'network-request', ts: 5, payload: '{}' }, { kind: 'network-failed', ts: 105, payload: '{}' }]))
      .toBe('1 request · 100 ms');
  });
});
