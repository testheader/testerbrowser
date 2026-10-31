import { summarizeSnapshot, formatSnapshotResult } from '../snapshotSummary';

describe('summarizeSnapshot', () => {
  it('counts a v2 multi-frame snapshot', () => {
    expect(summarizeSnapshot({
      cookies: [{}, {}, {}],
      frames: [
        { localStorage: { a: '1', b: '2' }, sessionStorage: { s: '1' }, indexedDB: { db1: {}, db2: {} } },
        { localStorage: { c: '3' } },
      ],
    })).toEqual({ cookies: 3, localStorageKeys: 3, sessionStorageKeys: 1, indexedDBDatabases: 2, frames: 2 });
  });
  it('counts a v1 inline snapshot as one frame', () => {
    expect(summarizeSnapshot({ url: 'https://x', cookies: [{}], localStorage: { a: '1' }, sessionStorage: { b: '2', c: '3' } }))
      .toEqual({ cookies: 1, localStorageKeys: 1, sessionStorageKeys: 2, indexedDBDatabases: 0, frames: 1 });
  });
  it('handles an empty snapshot', () => {
    expect(summarizeSnapshot({ url: 'https://x' }))
      .toEqual({ cookies: 0, localStorageKeys: 0, sessionStorageKeys: 0, indexedDBDatabases: 0, frames: 1 });
  });
});

describe('formatSnapshotResult', () => {
  const summary = { cookies: 2, localStorageKeys: 1, sessionStorageKeys: 0, indexedDBDatabases: 1, frames: 3 };
  it('export names the file and explains how to restore', () => {
    const r = formatSnapshotResult({ kind: 'export', fileName: '/tmp/dir/snap.json' });
    expect(r.title).toBe('Snapshot exported');
    expect(r.type).toBe('info');
    expect(r.message).toContain('snap.json');
    expect(r.message).not.toContain('/tmp/dir');
    expect(r.detail).toContain('/tmp/dir/snap.json');
    expect(r.detail).toContain('Import snapshot…');
    expect(r.detail).toContain('Import session…');
    expect(r.detail).toContain('React component state');
  });
  it('import says it applied to the current tab with counts and not-restored line', () => {
    const r = formatSnapshotResult({ kind: 'import', fileName: 'snap.json', summary });
    expect(r.title).toBe('Snapshot imported');
    expect(r.message).toContain('current tab');
    expect(r.detail).toContain('2 cookies');
    expect(r.detail).toContain('1 localStorage key,');
    expect(r.detail).toContain('0 sessionStorage keys');
    expect(r.detail).toContain('1 IndexedDB database');
    expect(r.detail).toContain('3 frames');
    expect(r.detail).toContain('Not restored');
  });
  it('importNew says it opened a new tab', () => {
    const r = formatSnapshotResult({ kind: 'importNew', fileName: 'snap.json', summary });
    expect(r.message).toContain('new tab');
    expect(r.detail).toContain('Not restored');
  });
  it('appends warnings, caps at 20 and switches type to warning', () => {
    const warnings = Array.from({ length: 25 }, (_, i) => `w${i}`);
    const r = formatSnapshotResult({ kind: 'import', fileName: 'snap.json', summary, warnings });
    expect(r.type).toBe('warning');
    expect(r.detail).toContain('25 warning(s)');
    expect(r.detail).toContain('w19');
    expect(r.detail).not.toContain('w20');
    expect(r.detail).toContain('…and 5 more');
  });
});
