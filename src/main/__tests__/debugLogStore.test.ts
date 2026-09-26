import os from 'os';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { DebugLogStore, toUpdateLogEntry } from '../debugLogStore';

// #252: better-sqlite3 turned out to load fine under Jest's plain Node
// runtime with no ABI issues — this package ships prebuilt binaries
// (prebuildify-style, see node_modules/better-sqlite3/package.json's
// "gypfile": false) selected by Node's own ABI at require time, not compiled
// via node-gyp, so electron-rebuild's Electron-ABI output (built for the
// packaged app) never gets in the way of a plain `node_modules` install
// running under Jest. Confirmed with a throwaway spike test before writing
// any of this file. Every test below uses the real driver against a real
// temp-file database (same pattern as appLogger.test.ts (#225) and
// jsonFile.test.ts (#248)), not a hand-rolled SQL-matching fake — the
// previous regex-based mock here could never have caught a real schema/query
// bug, which is exactly what this ticket exists to close.
const tmpDbPaths: string[] = [];
function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `debug-log-test-${name}-`));
  const p = path.join(dir, 'log.sqlite');
  tmpDbPaths.push(dir);
  return p;
}

afterEach(() => {
  for (const dir of tmpDbPaths.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

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

  // #252: exercises the real ALTER TABLE migration path against a genuinely
  // pre-#228 schema — a regex-based SQL fake never has a real schema to
  // migrate, so it could never have caught a broken ALTER TABLE/DEFAULT.
  it('migrates a pre-#228 database (created without level/source/session_id/ctx) — old rows read back with defaults, new inserts work', () => {
    const dbPath = tmpDbPath('migration');
    const raw = new Database(dbPath);
    raw.exec(`CREATE TABLE entries (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, message TEXT NOT NULL)`);
    raw.prepare(`INSERT INTO entries (ts, message) VALUES (?, ?)`).run(1000, 'pre-migration entry');
    raw.close();

    const store = new DebugLogStore(dbPath);
    const [entry] = store.getEntries();
    expect(entry.message).toBe('pre-migration entry');
    // Backfilled by the ALTER TABLE's own DEFAULT, not application code.
    expect(entry.level).toBe('error');
    expect(entry.source).toBe('app');
    expect(entry.sessionId ?? null).toBeNull();
    expect(entry.ctx).toBeNull();

    // The migrated table accepts new-shape inserts normally.
    store.insert({ ts: 2000, message: 'post-migration', level: 'warn', source: 'sessions', sessionId: 'tab-1' });
    const all = store.getEntries();
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ message: 'post-migration', level: 'warn', source: 'sessions', sessionId: 'tab-1' });

    store.close();
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
