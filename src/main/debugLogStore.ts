import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { AppLogLevel } from './errorLog';

/**
 * App-wide, disk-backed store for TesterBrowser's own debug-log entries
 * (main-process errors surfaced via recordAppError()). One file for the
 * whole app's lifetime — not per-session like SessionRecorder's event DBs
 * (src/main/recorder.ts) — so the log survives an app restart instead of
 * living only in the in-memory recentAppErrors ring buffer.
 */

export interface DebugLogEntry {
  ts: number;
  message: string;
  level: AppLogLevel;
}

export interface DebugLogStoreOptions {
  maxEntries?: number; // row-count cap, oldest evicted first
  maxAgeMs?: number; // age cap, oldest evicted first
  trimEveryNInserts?: number; // how often to run the trim check
}

const DEFAULT_MAX_ENTRIES = 5000;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_TRIM_EVERY = 20;

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
        level TEXT NOT NULL DEFAULT 'error'
      );
      CREATE INDEX IF NOT EXISTS idx_entries_ts ON entries(ts);
    `);
    // A store created by a pre-#213 build has no level column yet — add it
    // (existing rows backfill to 'error', same as their implicit level was
    // before levels existed). Throws (harmlessly) if the column is already
    // there, which the CREATE TABLE above already ensures for a fresh store.
    try { this.db.exec(`ALTER TABLE entries ADD COLUMN level TEXT NOT NULL DEFAULT 'error'`); } catch {}
    this.insertStmt = this.db.prepare(`INSERT INTO entries (ts, message, level) VALUES (?, ?, ?)`);
    this.countStmt = this.db.prepare(`SELECT COUNT(*) as c FROM entries`);
    this.trimCountStmt = this.db.prepare(
      `DELETE FROM entries WHERE id IN (SELECT id FROM entries ORDER BY id ASC LIMIT ?)`
    );
    this.trimAgeStmt = this.db.prepare(`DELETE FROM entries WHERE ts < ?`);
  }

  insert(entry: DebugLogEntry): void {
    this.insertStmt.run(entry.ts, entry.message, entry.level);
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

  /** Most recent entries, oldest first (same order recentAppErrors keeps). */
  getEntries(opts: { limit?: number } = {}): DebugLogEntry[] {
    const limit = opts.limit ?? 500;
    return (
      this.db
        .prepare(`SELECT ts, message, level FROM entries ORDER BY ts DESC LIMIT ?`)
        .all(limit) as DebugLogEntry[]
    ).reverse();
  }

  close(): void {
    this.db.close();
  }
}
