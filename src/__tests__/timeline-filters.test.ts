import { matchesNetworkFilters, matchesConsoleFilters, requestMeta, responseMeta, tagMeta, failMeta } from '../../renderer/timeline.js';

function netEvent(kind: string, payload: object, overrides: Partial<{ summary: string; ts: number }> = {}) {
  return { kind, ts: 1700000000000, summary: '', payload: JSON.stringify(payload), ...overrides };
}

// Mock/Resilience are deliberately left *off* by default: turning either on
// is a restrictive filter (only rows carrying that tag pass), so an "every
// other dimension is permissive" baseline needs them off, same as the real
// panel's own default pill state.
function baseNetworkFilters(overrides: Partial<{
  activeTypes: Set<string>; activeMethods: Set<string>; minDuration: number; filterText: string;
}> = {}) {
  return {
    activeTypes: new Set<string>(),
    activeMethods: new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'Other']),
    minDuration: 0,
    filterText: '',
    ...overrides,
  };
}

beforeEach(() => {
  requestMeta.clear();
  responseMeta.clear();
  tagMeta.clear();
  failMeta.clear();
});

describe('matchesNetworkFilters (#279)', () => {
  describe('row kinds and the Errors chip (#300)', () => {
    it('shows a request row with no chip on', () => {
      const e = netEvent('network-request', { requestId: 'r1', request: { method: 'GET', url: 'https://x' } });
      expect(matchesNetworkFilters(e, baseNetworkFilters())).toBe(true);
    });

    it('response, failed and body events are never rows of their own', () => {
      for (const kind of ['network-response', 'network-failed', 'network-body']) {
        const e = netEvent(kind, { requestId: 'r1', response: { status: 200 }, body: 'hi' });
        expect(matchesNetworkFilters(e, baseNetworkFilters())).toBe(false);
      }
    });

    it('the Errors chip keeps only failed, 4xx and 5xx requests', () => {
      const req = (id: string) => netEvent('network-request', { requestId: id, request: { method: 'GET', url: 'https://x' } });
      const filters = baseNetworkFilters({ activeTypes: new Set(['network-failed']) });
      responseMeta.set('ok', { status: 200, durationMs: 1 });
      responseMeta.set('nf', { status: 404, durationMs: 1 });
      responseMeta.set('se', { status: 503, durationMs: 1 });
      failMeta.set('boom', 'net::ERR_FAILED');
      expect(matchesNetworkFilters(req('ok'), filters)).toBe(false);
      expect(matchesNetworkFilters(req('nf'), filters)).toBe(true);
      expect(matchesNetworkFilters(req('se'), filters)).toBe(true);
      expect(matchesNetworkFilters(req('boom'), filters)).toBe(true);
      expect(matchesNetworkFilters(req('pending'), filters)).toBe(false);
    });
  });

  describe('method match', () => {
    it('hides a request whose method pill is off', () => {
      const e = netEvent('network-request', { requestId: 'r1', request: { method: 'POST', url: 'https://x' } });
      const filters = baseNetworkFilters({ activeMethods: new Set(['GET']) });
      expect(matchesNetworkFilters(e, filters)).toBe(false);
    });

    it('shows a request whose method pill is on', () => {
      const e = netEvent('network-request', { requestId: 'r1', request: { method: 'POST', url: 'https://x' } });
      const filters = baseNetworkFilters({ activeMethods: new Set(['POST']) });
      expect(matchesNetworkFilters(e, filters)).toBe(true);
    });

    it('an unrecognized method is bucketed under "Other"', () => {
      const e = netEvent('network-request', { requestId: 'r1', request: { method: 'CONNECT', url: 'https://x' } });
      expect(matchesNetworkFilters(e, baseNetworkFilters({ activeMethods: new Set(['GET']) }))).toBe(false);
      expect(matchesNetworkFilters(e, baseNetworkFilters({ activeMethods: new Set(['Other']) }))).toBe(true);
    });

    it('a request with no method is never hidden by the method filter', () => {
      const e = netEvent('network-request', { requestId: 'r1', request: { url: 'https://x' } });
      expect(matchesNetworkFilters(e, baseNetworkFilters({ activeMethods: new Set() }))).toBe(true);
    });
  });

  describe('min-duration threshold', () => {
    it('hides a request faster than the threshold', () => {
      responseMeta.set('r1', { status: 200, durationMs: 50 });
      const e = netEvent('network-request', { requestId: 'r1', request: { method: 'GET', url: 'https://x' } });
      expect(matchesNetworkFilters(e, baseNetworkFilters({ minDuration: 100 }))).toBe(false);
    });

    it('shows a request at or slower than the threshold', () => {
      responseMeta.set('r1', { status: 200, durationMs: 150 });
      const e = netEvent('network-request', { requestId: 'r1', request: { method: 'GET', url: 'https://x' } });
      expect(matchesNetworkFilters(e, baseNetworkFilters({ minDuration: 100 }))).toBe(true);
    });

    it('hides a request whose duration is not yet known (response has not arrived) once a threshold is set', () => {
      const e = netEvent('network-request', { requestId: 'no-response-yet', request: { method: 'GET', url: 'https://x' } });
      expect(matchesNetworkFilters(e, baseNetworkFilters({ minDuration: 100 }))).toBe(false);
    });

    it('a zero threshold (the default) never filters on duration', () => {
      const e = netEvent('network-request', { requestId: 'no-response-yet', request: { method: 'GET', url: 'https://x' } });
      expect(matchesNetworkFilters(e, baseNetworkFilters({ minDuration: 0 }))).toBe(true);
    });
  });

  describe('Mock/Resilience tag filter', () => {
    it('hides a request tagged mock when only the Resilience pill is on', () => {
      const e = netEvent('network-request', { requestId: 'r1', request: { method: 'GET', url: 'https://x' }, mockRuleId: 'rule-1' });
      const filters = baseNetworkFilters({ activeTypes: new Set(['resilience']) });
      expect(matchesNetworkFilters(e, filters)).toBe(false);
    });

    it('shows a request tagged mock when the Mock pill is on', () => {
      const e = netEvent('network-request', { requestId: 'r1', request: { method: 'GET', url: 'https://x' }, mockRuleId: 'rule-1' });
      const filters = baseNetworkFilters({ activeTypes: new Set(['mock']) });
      expect(matchesNetworkFilters(e, filters)).toBe(true);
    });

    it('a request resolves its tag via tagMeta when its own payload carries none', () => {
      tagMeta.set('r1', 'resilience');
      const e = netEvent('network-request', { requestId: 'r1', request: { method: 'GET', url: 'https://x' } });
      expect(matchesNetworkFilters(e, baseNetworkFilters({ activeTypes: new Set(['mock']) }))).toBe(false);
      expect(matchesNetworkFilters(e, baseNetworkFilters({ activeTypes: new Set(['resilience']) }))).toBe(true);
    });

    it('neither Mock nor Resilience pill on leaves every row visible regardless of tag', () => {
      const e = netEvent('network-request', { requestId: 'r1', request: { method: 'GET', url: 'https://x' }, mockRuleId: 'rule-1' });
      const filters = baseNetworkFilters({ activeTypes: new Set<string>() });
      expect(matchesNetworkFilters(e, filters)).toBe(true);
    });
  });

  describe('free-text filter', () => {
    it('hides a row whose summary and payload do not match the filter text', () => {
      const e = netEvent('network-request', { requestId: 'r1', request: { method: 'GET', url: 'https://example.com/api' } });
      expect(matchesNetworkFilters(e, baseNetworkFilters({ filterText: 'nomatch' }))).toBe(false);
    });

    it('matches against the JSON payload, not just the summary', () => {
      // The request row's summary alone doesn't carry the URL, only its JSON payload does.
      const e = netEvent('network-request', { requestId: 'r1', request: { method: 'GET', url: 'https://example.com/widgets/42' } }, { summary: 'GET' });
      expect(matchesNetworkFilters(e, baseNetworkFilters({ filterText: 'widgets' }))).toBe(true);
      expect(matchesNetworkFilters(e, baseNetworkFilters({ filterText: 'nomatch' }))).toBe(false);
    });
  });

  describe('several filter dimensions active at once', () => {
    it('a row must pass kind, method, duration and text filters together', () => {
      responseMeta.set('r1', { status: 200, durationMs: 500 });
      const e = netEvent('network-request', { requestId: 'r1', request: { method: 'GET', url: 'https://example.com/slow' } });
      const passing = baseNetworkFilters({
        activeTypes: new Set<string>(),
        activeMethods: new Set(['GET']),
        minDuration: 100,
        filterText: 'slow',
      });
      expect(matchesNetworkFilters(e, passing)).toBe(true);

      // Same row, one dimension flipped to fail — method this time.
      const failingMethod = { ...passing, activeMethods: new Set(['POST']) };
      expect(matchesNetworkFilters(e, failingMethod)).toBe(false);
    });
  });
});

describe('matchesConsoleFilters (#279)', () => {
  function consoleEvent(kind: string, summary: string) {
    return { kind, ts: 1700000000000, summary, payload: '' };
  }

  it('hides a non-console/log/exception kind outright', () => {
    const e = consoleEvent('network-request', '[error] not really');
    expect(matchesConsoleFilters(e, { activeLevels: new Set(['error']), filterText: '' })).toBe(false);
  });

  it('hides a level whose pill is off', () => {
    const e = consoleEvent('console', '[warn] careful');
    expect(matchesConsoleFilters(e, { activeLevels: new Set(['error']), filterText: '' })).toBe(false);
  });

  it('shows a level whose pill is on', () => {
    const e = consoleEvent('console', '[warn] careful');
    expect(matchesConsoleFilters(e, { activeLevels: new Set(['warn']), filterText: '' })).toBe(true);
  });

  it('a row with no resolvable level (no bracketed prefix) is never hidden by the level filter', () => {
    const e = consoleEvent('console', 'no brackets here');
    expect(matchesConsoleFilters(e, { activeLevels: new Set(), filterText: '' })).toBe(true);
  });

  it('an exception row always counts as error for the level filter', () => {
    const e = consoleEvent('exception', 'Uncaught TypeError: x is not a function');
    expect(matchesConsoleFilters(e, { activeLevels: new Set(['error']), filterText: '' })).toBe(true);
    expect(matchesConsoleFilters(e, { activeLevels: new Set(['warn']), filterText: '' })).toBe(false);
  });

  it('applies the free-text filter against the summary', () => {
    const e = consoleEvent('console', '[error] boom goes the dynamite');
    expect(matchesConsoleFilters(e, { activeLevels: new Set(['error']), filterText: 'dynamite' })).toBe(true);
    expect(matchesConsoleFilters(e, { activeLevels: new Set(['error']), filterText: 'nomatch' })).toBe(false);
  });

  it('level and text filters both apply — passing one is not enough', () => {
    const e = consoleEvent('console', '[error] boom');
    expect(matchesConsoleFilters(e, { activeLevels: new Set(['warn']), filterText: 'boom' })).toBe(false);
    expect(matchesConsoleFilters(e, { activeLevels: new Set(['error']), filterText: 'nomatch' })).toBe(false);
    expect(matchesConsoleFilters(e, { activeLevels: new Set(['error']), filterText: 'boom' })).toBe(true);
  });
});
