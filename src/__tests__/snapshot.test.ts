// Unit tests for session snapshot data structure contract

interface SnapshotShape {
  version: number;
  ts: number;
  sessionName: string;
  url: string;
  cookies: unknown[];
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
}

function isValidSnapshot(obj: unknown): obj is SnapshotShape {
  if (!obj || typeof obj !== 'object') return false;
  const s = obj as Record<string, unknown>;
  return (
    s['version'] === 1 &&
    typeof s['ts'] === 'number' &&
    typeof s['sessionName'] === 'string' &&
    typeof s['url'] === 'string' &&
    Array.isArray(s['cookies']) &&
    s['localStorage'] !== null && typeof s['localStorage'] === 'object' &&
    s['sessionStorage'] !== null && typeof s['sessionStorage'] === 'object'
  );
}

const validSnap: SnapshotShape = {
  version: 1,
  ts: 1700000000000,
  sessionName: 'test-session',
  url: 'https://example.com',
  cookies: [{ name: 'c', value: 'v', domain: 'example.com', path: '/' }],
  localStorage: { theme: 'dark', userId: '42' },
  sessionStorage: { flow: 'checkout' },
};

describe('session snapshot shape', () => {
  it('accepts a well-formed snapshot', () => {
    expect(isValidSnapshot(validSnap)).toBe(true);
  });

  it('accepts a snapshot with empty storage', () => {
    expect(isValidSnapshot({ ...validSnap, cookies: [], localStorage: {}, sessionStorage: {} })).toBe(true);
  });

  it('rejects null', () => {
    expect(isValidSnapshot(null)).toBe(false);
  });

  it('rejects wrong version', () => {
    expect(isValidSnapshot({ ...validSnap, version: 2 })).toBe(false);
  });

  it('rejects non-array cookies', () => {
    expect(isValidSnapshot({ ...validSnap, cookies: 'bad' })).toBe(false);
  });

  it('snapshot localStorage keys are accessible', () => {
    expect(Object.keys(validSnap.localStorage)).toContain('theme');
  });

  it('snapshot ts is a numeric timestamp', () => {
    expect(typeof validSnap.ts).toBe('number');
    expect(validSnap.ts).toBeGreaterThan(0);
  });
});
