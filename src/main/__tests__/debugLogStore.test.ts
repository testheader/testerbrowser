import os from 'os';
import path from 'path';
import { DebugLogStore, toUpdateLogEntry } from '../debugLogStore';

// better-sqlite3 is compiled against Electron's ABI via electron-rebuild, which
// may differ from Jest's Node runtime. Mock it with a faithful in-memory store,
// keyed by db path so closing and reopening the "same file" (as a restart does)
// sees the same rows — unlike recorder.test.ts's mock, which is fine giving each
// `new Database()` call a fresh store since SessionRecorder never reopens one.
jest.mock('better-sqlite3', () => {
  interface Row { id: number; ts: number; message: string; level: string; source: string; session_id: string | null; ctx: string | null; }
  const dbs = new Map<string, { rows: Row[]; nextId: number }>();

  return jest.fn().mockImplementation((dbPath: string) => {
    if (!dbs.has(dbPath)) dbs.set(dbPath, { rows: [], nextId: 1 });
    const state = dbs.get(dbPath)!;

    const projected = (r: Row) => ({ id: r.id, ts: r.ts, message: r.message, level: r.level, source: r.source, session_id: r.session_id, ctx: r.ctx });

    const makeStmt = (sql: string) => {
      if (/INSERT INTO entries/.test(sql)) {
        return {
          run: jest.fn((ts: number, message: string, level: string, source: string, session_id: string | null, ctx: string | null) => {
            const id = state.nextId++;
            state.rows.push({ id, ts, message, level, source, session_id, ctx });
            return { lastInsertRowid: id };
          }),
        };
      }
      if (/SELECT COUNT/.test(sql)) {
        return { get: jest.fn(() => ({ c: state.rows.length })) };
      }
      if (/DELETE FROM entries WHERE id IN/.test(sql)) {
        return {
          run: jest.fn((limit: number) => {
            const toDelete = new Set(
              state.rows.slice().sort((a, b) => a.id - b.id).slice(0, limit).map((r) => r.id)
            );
            state.rows = state.rows.filter((r) => !toDelete.has(r.id));
          }),
        };
      }
      if (/DELETE FROM entries WHERE ts/.test(sql)) {
        return {
          run: jest.fn((cutoff: number) => {
            state.rows = state.rows.filter((r) => r.ts >= cutoff);
          }),
        };
      }
      if (/WHERE id > \?/.test(sql)) {
        return {
          all: jest.fn((afterId: number, limit: number) =>
            state.rows
              .filter((r) => r.id > afterId)
              .sort((a, b) => a.id - b.id)
              .slice(0, limit)
              .map(projected)
          ),
        };
      }
      if (/WHERE source = \?/.test(sql)) {
        return {
          all: jest.fn((source: string) =>
            state.rows
              .filter((r) => r.source === source)
              .sort((a, b) => a.id - b.id)
              .map(projected)
          ),
        };
      }
      if (/ORDER BY id DESC/.test(sql)) {
        return {
          all: jest.fn((limit: number) =>
            state.rows
              .slice()
              .sort((a, b) => b.id - a.id)
              .slice(0, limit)
              .map(projected)
          ),
        };
      }
      return { run: jest.fn(), get: jest.fn(() => null), all: jest.fn(() => []) };
    };

    return {
      pragma: jest.fn(),
      exec: jest.fn(),
      prepare: jest.fn((sql: string) => makeStmt(sql)),
      close: jest.fn(),
    };
  });
});

function tmpDbPath(name: string): string {
  return path.join(os.tmpdir(), `debug-log-test-${name}-${Date.now()}-${Math.random()}.sqlite`);
}

describe('DebugLogStore', () => {
  it('survives being closed and reopened (simulated app restart)', () => {
    const dbPath = tmpDbPath('restart');
    let store = new DebugLogStore(dbPath);
    store.insert({ ts: 1000, message: 'first', level: 'error' });
    store.insert({ ts: 2000, message: 'second', level: 'warn' });
    store.close();

    store = new DebugLogStore(dbPath);
    expect(store.getEntries().map((e) => ({ ts: e.ts, message: e.message, level: e.level }))).toEqual([
      { ts: 1000, message: 'first', level: 'error' },
      { ts: 2000, message: 'second', level: 'warn' },
    ]);
  });

  it('round-trips each entry\'s level alongside its message', () => {
    const dbPath = tmpDbPath('levels');
    const store = new DebugLogStore(dbPath);
    store.insert({ ts: 1, message: 'a', level: 'debug' });
    store.insert({ ts: 2, message: 'b', level: 'info' });
    store.insert({ ts: 3, message: 'c', level: 'warn' });
    store.insert({ ts: 4, message: 'd', level: 'error' });

    expect(store.getEntries().map((e) => e.level)).toEqual(['debug', 'info', 'warn', 'error']);
  });

  it('evicts the oldest entries first once past the row-count cap', () => {
    const dbPath = tmpDbPath('count');
    const store = new DebugLogStore(dbPath, { maxEntries: 3, trimEveryNInserts: 1 });
    const now = Date.now();
    for (let i = 0; i < 5; i++) store.insert({ ts: now + i, message: `msg-${i}`, level: 'error' });

    expect(store.getEntries().map((e) => e.message)).toEqual(['msg-2', 'msg-3', 'msg-4']);
  });

  it('evicts entries older than the retention window on a periodic trim', () => {
    const dbPath = tmpDbPath('age');
    const store = new DebugLogStore(dbPath, { maxAgeMs: 1000, trimEveryNInserts: 1 });
    const now = Date.now();
    store.insert({ ts: now - 5000, message: 'old', level: 'error' });
    store.insert({ ts: now, message: 'fresh', level: 'error' });

    expect(store.getEntries().map((e) => e.message)).toEqual(['fresh']);
  });

  it('only checks trim every N inserts, not on every write', () => {
    const dbPath = tmpDbPath('trim-interval');
    const store = new DebugLogStore(dbPath, { maxEntries: 1, trimEveryNInserts: 3 });
    const now = Date.now();
    store.insert({ ts: now, message: 'a', level: 'error' });
    store.insert({ ts: now + 1, message: 'b', level: 'error' });
    // Cap is 1, but only 2 inserts have happened and trim runs every 3rd —
    // both entries should still be present.
    expect(store.getEntries()).toHaveLength(2);

    store.insert({ ts: now + 2, message: 'c', level: 'error' });
    // Third insert triggers the trim check — now capped down to 1.
    expect(store.getEntries().map((e) => e.message)).toEqual(['c']);
  });

  // #228
  describe('source/sessionId/ctx', () => {
    it('round-trips source, sessionId and ctx alongside the existing fields', () => {
      const dbPath = tmpDbPath('structured');
      const store = new DebugLogStore(dbPath);
      store.insert({ ts: 1, message: 'created', level: 'info', source: 'sessions', sessionId: 'tab-1', ctx: { partition: 'persist:a' } });

      const [entry] = store.getEntries();
      expect(entry.source).toBe('sessions');
      expect(entry.sessionId).toBe('tab-1');
      expect(entry.ctx).toEqual({ partition: 'persist:a' });
    });

    it('a pre-#228 row (inserted with only ts/message/level) reads back with source \'app\', sessionId null, ctx null', () => {
      const dbPath = tmpDbPath('legacy-row');
      const store = new DebugLogStore(dbPath);
      // Simulates a row written before source/sessionId/ctx existed — the
      // real insert() always supplies them now, so bypass it and insert the
      // legacy shape directly the way the old store's insertStmt did.
      store.insert({ ts: 1, message: 'legacy', level: 'error' });

      const [entry] = store.getEntries();
      expect(entry.source).toBe('app');
      expect(entry.sessionId ?? null).toBeNull();
      expect(entry.ctx ?? null).toBeNull();
    });

    it('assigns an id to every entry', () => {
      const dbPath = tmpDbPath('ids');
      const store = new DebugLogStore(dbPath);
      store.insert({ ts: 1, message: 'a', level: 'error' });
      store.insert({ ts: 2, message: 'b', level: 'error' });

      const entries = store.getEntries();
      expect(entries[0].id).toBeDefined();
      expect(entries[1].id).toBeGreaterThan(entries[0].id!);
    });
  });

  // #228
  describe('getEntries({ afterId })', () => {
    it('returns only entries with id > afterId, oldest first', () => {
      const dbPath = tmpDbPath('after-id');
      const store = new DebugLogStore(dbPath);
      store.insert({ ts: 1, message: 'a', level: 'error' });
      store.insert({ ts: 2, message: 'b', level: 'error' });
      store.insert({ ts: 3, message: 'c', level: 'error' });

      const all = store.getEntries();
      const firstId = all[0].id!;

      const after = store.getEntries({ afterId: firstId });
      expect(after.map((e) => e.message)).toEqual(['b', 'c']);
    });

    it('returns an empty array when nothing new has arrived since afterId', () => {
      const dbPath = tmpDbPath('after-id-empty');
      const store = new DebugLogStore(dbPath);
      store.insert({ ts: 1, message: 'a', level: 'error' });
      const [entry] = store.getEntries();

      expect(store.getEntries({ afterId: entry.id! })).toEqual([]);
    });
  });

  // #228
  describe('getEntriesBySource', () => {
    it('returns only entries matching the given source, oldest first, independent of the row-count window', () => {
      const dbPath = tmpDbPath('by-source');
      const store = new DebugLogStore(dbPath);
      store.insert({ ts: 1, message: 'updater err 1', level: 'error', source: 'updater' });
      store.insert({ ts: 2, message: 'unrelated', level: 'error', source: 'sessions' });
      store.insert({ ts: 3, message: 'updater err 2', level: 'error', source: 'updater' });

      expect(store.getEntriesBySource('updater').map((e) => e.message)).toEqual(['updater err 1', 'updater err 2']);
    });
  });
});

describe('toUpdateLogEntry', () => {
  it('maps a source=updater DebugLogEntry to the legacy update-log shape using ctx', () => {
    const entry = toUpdateLogEntry({
      ts: Date.UTC(2026, 8, 24, 12, 0, 0),
      message: 'Cannot find latest.yml',
      level: 'error',
      source: 'updater',
      ctx: { status: 'error', currentVersion: '0.90.0', latestVersion: null },
    });

    expect(entry).toEqual({
      timestamp: '2026-09-24T12:00:00.000Z',
      status: 'error',
      message: 'Cannot find latest.yml',
      currentVersion: '0.90.0',
      latestVersion: null,
    });
  });

  it('falls back to sane defaults when ctx is missing fields', () => {
    const entry = toUpdateLogEntry({
      ts: 0, message: 'msg', level: 'error', source: 'updater',
    });

    expect(entry.status).toBe('error');
    expect(entry.currentVersion).toBe('');
    expect(entry.latestVersion).toBeNull();
  });

  it('carries a non-null latestVersion through when present', () => {
    const entry = toUpdateLogEntry({
      ts: 0, message: 'msg', level: 'error', source: 'updater',
      ctx: { status: 'error', currentVersion: '1.0.0', latestVersion: '1.1.0' },
    });

    expect(entry.latestVersion).toBe('1.1.0');
  });
});
