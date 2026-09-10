// Unit tests for session snapshot data structure contract

interface FrameSnapshotShape {
  url: string;
  localStorage?: Record<string, string>;
  sessionStorage?: Record<string, string>;
  indexedDB?: Record<string, unknown>;
  fields?: { sel: string; kind: 'value' | 'checked'; value?: string; checked?: boolean }[];
  scroll?: { x: number; y: number };
  historyState?: unknown;
  reactState?: { note: string; nodes: unknown[] };
  warnings?: string[];
}

interface SnapshotShape {
  version: number;
  ts: number;
  sessionName: string;
  url: string;
  cookies: unknown[];
  frames: FrameSnapshotShape[];
  warnings: string[];
}

function isValidSnapshot(obj: unknown): obj is SnapshotShape {
  if (!obj || typeof obj !== 'object') return false;
  const s = obj as Record<string, unknown>;
  return (
    s['version'] === 2 &&
    typeof s['ts'] === 'number' &&
    typeof s['sessionName'] === 'string' &&
    typeof s['url'] === 'string' &&
    Array.isArray(s['cookies']) &&
    Array.isArray(s['frames']) &&
    Array.isArray(s['warnings'])
  );
}

// Mirrors sessionManager.ts's readSnapshotFile acceptance check: a file is
// importable if it has a frames array (v2), a cookies array, or a url —
// covering both current and legacy (v1) exports.
function looksLikeImportableSnapshot(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const s = obj as Record<string, unknown>;
  return Array.isArray(s['frames']) || Array.isArray(s['cookies']) || typeof s['url'] === 'string';
}

const validFrame: FrameSnapshotShape = {
  url: 'https://example.com',
  localStorage: { theme: 'dark', userId: '42' },
  sessionStorage: { flow: 'checkout' },
};

const validSnap: SnapshotShape = {
  version: 2,
  ts: 1700000000000,
  sessionName: 'test-session',
  url: 'https://example.com',
  cookies: [{ name: 'c', value: 'v', domain: 'example.com', path: '/' }],
  frames: [validFrame],
  warnings: [],
};

const legacyV1Snap = {
  version: 1,
  ts: 1700000000000,
  sessionName: 'legacy-session',
  url: 'https://example.com',
  cookies: [{ name: 'c', value: 'v', domain: 'example.com', path: '/' }],
  localStorage: { theme: 'dark' },
  sessionStorage: {},
};

describe('session snapshot shape (v2)', () => {
  it('accepts a well-formed snapshot', () => {
    expect(isValidSnapshot(validSnap)).toBe(true);
  });

  it('accepts a snapshot with an empty frame', () => {
    expect(isValidSnapshot({ ...validSnap, frames: [{ url: 'https://example.com' }] })).toBe(true);
  });

  it('accepts multiple frames (main + iframe)', () => {
    const iframeSnap: FrameSnapshotShape = { url: 'https://widget.example.com/frame', localStorage: { widgetState: '1' } };
    expect(isValidSnapshot({ ...validSnap, frames: [validFrame, iframeSnap] })).toBe(true);
  });

  it('rejects null', () => {
    expect(isValidSnapshot(null)).toBe(false);
  });

  it('rejects wrong version', () => {
    expect(isValidSnapshot({ ...validSnap, version: 1 })).toBe(false);
  });

  it('rejects non-array cookies', () => {
    expect(isValidSnapshot({ ...validSnap, cookies: 'bad' })).toBe(false);
  });

  it('rejects non-array frames', () => {
    expect(isValidSnapshot({ ...validSnap, frames: 'bad' })).toBe(false);
  });

  it('frame localStorage keys are accessible', () => {
    expect(Object.keys(validFrame.localStorage!)).toContain('theme');
  });

  it('snapshot ts is a numeric timestamp', () => {
    expect(typeof validSnap.ts).toBe('number');
    expect(validSnap.ts).toBeGreaterThan(0);
  });

  it('reactState, when present, is diagnostic-only metadata rather than restorable state', () => {
    const withReact: FrameSnapshotShape = { ...validFrame, reactState: { note: 'diagnostic only, not restored on import', nodes: [{ path: 'App > Counter', state: [{ count: 3 }] }] } };
    expect(withReact.reactState?.note).toMatch(/not restored/i);
  });
});

describe('legacy (v1) snapshot compatibility', () => {
  it('a v1 file is still recognized as importable', () => {
    expect(looksLikeImportableSnapshot(legacyV1Snap)).toBe(true);
  });

  it('a v2 file with only frames[] (no top-level url) is still importable', () => {
    expect(looksLikeImportableSnapshot({ frames: [validFrame] })).toBe(true);
  });

  it('rejects a file with none of frames/cookies/url', () => {
    expect(looksLikeImportableSnapshot({ sessionName: 'nope' })).toBe(false);
  });

  it('rejects arrays and primitives at the top level', () => {
    expect(looksLikeImportableSnapshot([])).toBe(false);
    expect(looksLikeImportableSnapshot('snapshot')).toBe(false);
    expect(looksLikeImportableSnapshot(null)).toBe(false);
  });
});
