import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { AppLogLevel } from './errorLog';

/**
 * App-wide, disk-backed store for TesterBrowser's own debug-log entries
 * (main-process breadcrumbs/errors surfaced via appLogger.ts's log object).
 * One file for the whole app's lifetime — not per-session like
 * SessionRecorder's event DBs (src/main/recorder.ts) — so the log survives
 * an app restart instead of living only in the in-memory ring buffer.
 */

export interface DebugLogEntry {
  id?: number;
  ts: number;
  message: string;
  level: AppLogLevel;
  source: string;
  sessionId?: string | null;
  ctx?: Record<string, unknown> | null;
}

export interface DebugLogStoreOptions {
  maxEntries?: number; // row-count cap, oldest evicted first
  maxAgeMs?: number; // age cap, oldest evicted first
  trimEveryNInserts?: number; // how often to run the trim check
}

const DEFAULT_MAX_ENTRIES = 5000;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_TRIM_EVERY = 20;
const DEFAULT_QUERY_LIMIT = 2000;

interface RawRow {
  id: number;
  ts: number;
  message: string;
  level: AppLogLevel;
  source: string;
  session_id: string | null;
  ctx: string | null;
}

function rowToEntry(row: RawRow): DebugLogEntry {
  let ctx: Record<string, unknown> | null = null;
  if (row.ctx) {
    try { ctx = JSON.parse(row.ctx); } catch { ctx = null; }
  }
  return {
    id: row.id,
    ts: row.ts,
    message: row.message,
    level: row.level,
    // A pre-#228 row has no source column value yet — the ALTER TABLE's own
    // DEFAULT 'app' already backfills that at the SQL level, so row.source
    // is never actually null/undefined here; the fallback is defensive.
    source: row.source || 'app',
    sessionId: row.session_id,
    ctx,
  };
}

export class DebugLogStore {
  private db: Database.Database;
  private maxEntries: number;
  private maxAgeMs: number;
  private trimEvery: number;
  private insertStmt: Database.Statement;
  private countStmt: Database.Statement;
  private trimCountStmt: Database.Statement;
  private trimAgeStmt: Database.Statement;
  private trimCounter = 0;

  constructor(dbPath: string, opts: DebugLogStoreOptions = {}) {
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.trimEvery = opts.trimEveryNInserts ?? DEFAULT_TRIM_EVERY;

    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        message TEXT NOT NULL,
        level TEXT NOT NULL DEFAULT 'error',
        source TEXT NOT NULL DEFAULT 'app',
        session_id TEXT,
        ctx TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_entries_ts ON entries(ts);
    `);
    // A store created by an older build is missing one or more of these
    // columns — add each (existing rows backfill via DEFAULT/NULL). Throws
    // (harmlessly) if the column is already there, which the CREATE TABLE
    // above already ensures for a fresh store.
    try { this.db.exec(`ALTER TABLE entries ADD COLUMN level TEXT NOT NULL DEFAULT 'error'`); } catch {}
    try { this.db.exec(`ALTER TABLE entries ADD COLUMN source TEXT NOT NULL DEFAULT 'app'`); } catch {}
    try { this.db.exec(`ALTER TABLE entries ADD COLUMN session_id TEXT`); } catch {}
    try { this.db.exec(`ALTER TABLE entries ADD COLUMN ctx TEXT`); } catch {}
    this.insertStmt = this.db.prepare(
      `INSERT INTO entries (ts, message, level, source, session_id, ctx) VALUES (?, ?, ?, ?, ?, ?)`
    );
    this.countStmt = this.db.prepare(`SELECT COUNT(*) as c FROM entries`);
    this.trimCountStmt = this.db.prepare(
      `DELETE FROM entries WHERE id IN (SELECT id FROM entries ORDER BY id ASC LIMIT ?)`
    );
    this.trimAgeStmt = this.db.prepare(`DELETE FROM entries WHERE ts < ?`);
  }

  insert(entry: {
    ts: number; message: string; level: AppLogLevel;
    source?: string; sessionId?: string; ctx?: Record<string, unknown> | null;
  }): void {
    this.insertStmt.run(
      entry.ts, entry.message, entry.level,
      entry.source ?? 'app',
      entry.sessionId ?? null,
      entry.ctx ? JSON.stringify(entry.ctx) : null,
    );
    this.trimIfNeeded();
  }

  private trimIfNeeded(): void {
    // Only check every N inserts to avoid a COUNT(*)/DELETE on every write —
    // mirrors SessionRecorder.trimIfNeeded() in recorder.ts.
    this.trimCounter++;
    if (this.trimCounter % this.trimEvery !== 0) return;

    this.trimAgeStmt.run(Date.now() - this.maxAgeMs);

    const countRow = this.countStmt.get() as { c: number };
    if (countRow.c > this.maxEntries) {
      this.trimCountStmt.run(countRow.c - this.maxEntries);
    }
  }

  /**
   * Without `afterId`: the most recent `limit` entries, oldest first (same
   * order the panel renders top-to-bottom) — used for the panel's first
   * load. With `afterId`: entries with id > afterId, oldest first, up to
   * `limit` — used for every poll after that, so the renderer can append
   * rather than rebuild.
   */
  getEntries(opts: { afterId?: number; limit?: number } = {}): DebugLogEntry[] {
    const limit = opts.limit ?? DEFAULT_QUERY_LIMIT;
    if (opts.afterId !== undefined) {
      const rows = this.db
        .prepare(`SELECT id, ts, message, level, source, session_id, ctx FROM entries WHERE id > ? ORDER BY id ASC LIMIT ?`)
        .all(opts.afterId, limit) as RawRow[];
      return rows.map(rowToEntry);
    }
    const rows = this.db
      .prepare(`SELECT id, ts, message, level, source, session_id, ctx FROM entries ORDER BY id DESC LIMIT ?`)
      .all(limit) as RawRow[];
    return rows.reverse().map(rowToEntry);
  }

  /** Every stored entry from one source, oldest first — used for the update log (source 'updater'), independent of the row-count window getEntries()'s default limit applies. */
  getEntriesBySource(source: string): DebugLogEntry[] {
    const rows = this.db
      .prepare(`SELECT id, ts, message, level, source, session_id, ctx FROM entries WHERE source = ? ORDER BY id ASC`)
      .all(source) as RawRow[];
    return rows.map(rowToEntry);
  }

  close(): void {
    this.db.close();
  }
}

export interface UpdateLogEntry {
  timestamp: string;
  status: string;
  message: string;
  currentVersion: string;
  latestVersion: string | null;
}

/**
 * Reconstructs the Settings "update log" shape from a source='updater'
 * DebugLogEntry — the updater's own log.error() call (index.ts) stores
 * status/currentVersion/latestVersion in ctx specifically so this mapping
 * can round-trip them back out.
 */
export function toUpdateLogEntry(row: DebugLogEntry): UpdateLogEntry {
  const ctx = row.ctx ?? {};
  return {
    timestamp: new Date(row.ts).toISOString(),
    status: typeof ctx.status === 'string' ? ctx.status : 'error',
    message: row.message,
    currentVersion: typeof ctx.currentVersion === 'string' ? ctx.currentVersion : '',
    latestVersion: typeof ctx.latestVersion === 'string' ? ctx.latestVersion : null,
  };
}
