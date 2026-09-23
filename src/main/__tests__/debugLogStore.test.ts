import os from 'os';
import path from 'path';
import { DebugLogStore } from '../debugLogStore';

// better-sqlite3 is compiled against Electron's ABI via electron-rebuild, which
// may differ from Jest's Node runtime. Mock it with a faithful in-memory store,
// keyed by db path so closing and reopening the "same file" (as a restart does)
// sees the same rows — unlike recorder.test.ts's mock, which is fine giving each
// `new Database()` call a fresh store since SessionRecorder never reopens one.
jest.mock('better-sqlite3', () => {
  interface Row { id: number; ts: number; message: string; }
  const dbs = new Map<string, { rows: Row[]; nextId: number }>();

  return jest.fn().mockImplementation((dbPath: string) => {
    if (!dbs.has(dbPath)) dbs.set(dbPath, { rows: [], nextId: 1 });
    const state = dbs.get(dbPath)!;

    const makeStmt = (sql: string) => {
      if (/INSERT INTO entries/.test(sql)) {
        return {
          run: jest.fn((ts: number, message: string) => {
            const id = state.nextId++;
            state.rows.push({ id, ts, message });
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
      if (/ORDER BY ts DESC/.test(sql)) {
        return {
          all: jest.fn((limit: number) =>
            state.rows
              .slice()
              .sort((a, b) => b.ts - a.ts)
              .slice(0, limit)
              .map((r) => ({ ts: r.ts, message: r.message }))
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
    store.insert({ ts: 1000, message: 'first' });
    store.insert({ ts: 2000, message: 'second' });
    store.close();

    store = new DebugLogStore(dbPath);
    expect(store.getEntries()).toEqual([
      { ts: 1000, message: 'first' },
      { ts: 2000, message: 'second' },
    ]);
  });

  it('evicts the oldest entries first once past the row-count cap', () => {
    const dbPath = tmpDbPath('count');
    const store = new DebugLogStore(dbPath, { maxEntries: 3, trimEveryNInserts: 1 });
    const now = Date.now();
    for (let i = 0; i < 5; i++) store.insert({ ts: now + i, message: `msg-${i}` });

    expect(store.getEntries().map((e) => e.message)).toEqual(['msg-2', 'msg-3', 'msg-4']);
  });

  it('evicts entries older than the retention window on a periodic trim', () => {
    const dbPath = tmpDbPath('age');
    const store = new DebugLogStore(dbPath, { maxAgeMs: 1000, trimEveryNInserts: 1 });
    const now = Date.now();
    store.insert({ ts: now - 5000, message: 'old' });
    store.insert({ ts: now, message: 'fresh' });

    expect(store.getEntries().map((e) => e.message)).toEqual(['fresh']);
  });

  it('only checks trim every N inserts, not on every write', () => {
    const dbPath = tmpDbPath('trim-interval');
    const store = new DebugLogStore(dbPath, { maxEntries: 1, trimEveryNInserts: 3 });
    const now = Date.now();
    store.insert({ ts: now, message: 'a' });
    store.insert({ ts: now + 1, message: 'b' });
    // Cap is 1, but only 2 inserts have happened and trim runs every 3rd —
    // both entries should still be present.
    expect(store.getEntries()).toHaveLength(2);

    store.insert({ ts: now + 2, message: 'c' });
    // Third insert triggers the trim check — now capped down to 1.
    expect(store.getEntries().map((e) => e.message)).toEqual(['c']);
  });
});
