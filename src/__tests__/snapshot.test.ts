import { looksLikeImportableSnapshot } from '../main/sessionManager';
import { buildRestoreFrameScript, COLLECT_FRAME_SCRIPT, COLLECT_INDEXEDDB_SCRIPT } from '../main/snapshotScripts';

describe('looksLikeImportableSnapshot (mirrors readSnapshotFile\'s real acceptance check — #243)', () => {
  it('accepts a well-formed v2 snapshot (cookies + frames)', () => {
    expect(looksLikeImportableSnapshot({
      version: 2,
      ts: 1700000000000,
      sessionName: 'test-session',
      url: 'https://example.com',
      cookies: [{ name: 'c', value: 'v', domain: 'example.com', path: '/' }],
      frames: [{ url: 'https://example.com', localStorage: { theme: 'dark' } }],
      warnings: [],
    })).toBe(true);
  });

  it('accepts an object with only a frames[] array', () => {
    expect(looksLikeImportableSnapshot({ frames: [{ url: 'https://example.com' }] })).toBe(true);
  });

  it('accepts an object with only a cookies[] array', () => {
    expect(looksLikeImportableSnapshot({ cookies: [] })).toBe(true);
  });

  it('accepts a legacy v1 snapshot (top-level url, no frames)', () => {
    expect(looksLikeImportableSnapshot({
      version: 1,
      cookies: [{ name: 'c', value: 'v', domain: 'example.com', path: '/' }],
      url: 'https://example.com',
      localStorage: { theme: 'dark' },
      sessionStorage: {},
    })).toBe(true);
  });

  it('accepts an object with only a top-level url string', () => {
    expect(looksLikeImportableSnapshot({ url: 'https://example.com' })).toBe(true);
  });

  it('rejects null', () => {
    expect(looksLikeImportableSnapshot(null)).toBe(false);
  });

  it('rejects arrays and primitives at the top level', () => {
    expect(looksLikeImportableSnapshot([])).toBe(false);
    expect(looksLikeImportableSnapshot('snapshot')).toBe(false);
    expect(looksLikeImportableSnapshot(42)).toBe(false);
    expect(looksLikeImportableSnapshot(undefined)).toBe(false);
  });

  it('rejects an object with none of frames/cookies/url', () => {
    expect(looksLikeImportableSnapshot({ sessionName: 'nope' })).toBe(false);
  });
});

describe('buildRestoreFrameScript — escaping (#243)', () => {
  const nasty = 'a"b`c</script><script>window.__pwned=1</script>\\d\ne\tf';

  it('produces syntactically valid JS regardless of nasty characters in the restored value', () => {
    const script = buildRestoreFrameScript({ url: 'https://example.com', localStorage: { nasty } });
    expect(() => new Function(script)).not.toThrow();
  });

  it('round-trips the nasty value through the embedded JSON payload without corruption', () => {
    const script = buildRestoreFrameScript({ url: 'https://example.com', localStorage: { nasty } });
    const match = script.match(/const DATA = ([\s\S]*?);\n\s*const warnings/);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match![1]);
    expect(parsed.localStorage.nasty).toBe(nasty);
  });

  it('handles nasty characters across localStorage, sessionStorage and form field values together', () => {
    const script = buildRestoreFrameScript({
      url: 'https://example.com',
      localStorage: { a: nasty },
      sessionStorage: { b: nasty },
      fields: [{ sel: '#x', kind: 'value', value: nasty }],
    });
    expect(() => new Function(script)).not.toThrow();
    const match = script.match(/const DATA = ([\s\S]*?);\n\s*const warnings/);
    const parsed = JSON.parse(match![1]);
    expect(parsed.localStorage.a).toBe(nasty);
    expect(parsed.sessionStorage.b).toBe(nasty);
    expect(parsed.fields[0].value).toBe(nasty);
  });

  it('round-trips an indexedDB snapshot, including nasty characters in record values (#280)', () => {
    const script = buildRestoreFrameScript({
      url: 'https://example.com',
      indexedDB: {
        myDb: {
          version: 2,
          stores: {
            myStore: {
              keyPath: 'id',
              autoIncrement: false,
              records: [{ key: 1, value: { id: 1, note: nasty } }],
            },
          },
        },
      },
    });
    expect(() => new Function(script)).not.toThrow();
    const match = script.match(/const DATA = ([\s\S]*?);\n\s*const warnings/);
    const parsed = JSON.parse(match![1]);
    expect(parsed.indexedDB.myDb.version).toBe(2);
    expect(parsed.indexedDB.myDb.stores.myStore.records[0].value.note).toBe(nasty);
  });

  it('produces valid, parseable JS for a frame snapshot with none of the optional fields set', () => {
    const script = buildRestoreFrameScript({ url: 'https://example.com' });
    expect(() => new Function(script)).not.toThrow();
  });

  it('produces valid JS when fields include a checkbox/radio ("checked") entry, not just "value"', () => {
    const script = buildRestoreFrameScript({
      url: 'https://example.com',
      fields: [{ sel: '#agree', kind: 'checked', checked: true }],
    });
    expect(() => new Function(script)).not.toThrow();
    const match = script.match(/const DATA = ([\s\S]*?);\n\s*const warnings/);
    const parsed = JSON.parse(match![1]);
    expect(parsed.fields[0]).toEqual({ sel: '#agree', kind: 'checked', checked: true });
  });
});

describe('COLLECT_FRAME_SCRIPT / COLLECT_INDEXEDDB_SCRIPT — well-formedness (#280)', () => {
  it('COLLECT_FRAME_SCRIPT is syntactically valid JS', () => {
    expect(() => new Function(COLLECT_FRAME_SCRIPT)).not.toThrow();
  });

  it('COLLECT_INDEXEDDB_SCRIPT is syntactically valid JS', () => {
    expect(() => new Function(COLLECT_INDEXEDDB_SCRIPT)).not.toThrow();
  });

  it('both scripts isolate collection failures per-database/per-store (never let one bad store abort the rest)', () => {
    for (const script of [COLLECT_FRAME_SCRIPT, COLLECT_INDEXEDDB_SCRIPT]) {
      expect(script).toContain("warnings.push('IndexedDB store '");
      expect(script).toContain("warnings.push('IndexedDB database '");
    }
  });

  it('COLLECT_FRAME_SCRIPT returns a JSON string carrying every documented top-level field', () => {
    for (const key of ['url', 'localStorage', 'sessionStorage', 'indexedDB', 'fields', 'scroll', 'historyState', 'warnings']) {
      expect(COLLECT_FRAME_SCRIPT).toContain(key);
    }
  });
});
