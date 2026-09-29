import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { log } from './appLogger';

/**
 * Atomic JSON read/write with a one-generation `.bak` fallback (#248).
 *
 * A plain `fs.writeFileSync(file, ...)` truncates the target in place — a
 * crash, power loss or full disk mid-write leaves a file `JSON.parse` can
 * never recover from, silently wiping settings/bookmarks/saved tests on the
 * next launch. writeJsonAtomic() instead writes to `<file>.tmp` and renames
 * it over `<file>` (rename is atomic on both POSIX and Windows — the target
 * is either the old file or the fully-written new one, never a partial
 * write), backing up the previous good content to `<file>.bak` first.
 * readJsonWithBackup() falls back to `.bak` when `<file>` itself is missing
 * or unparsable.
 */

// A short, blocking sleep for the Windows rename-retry below — every write
// site is synchronous (JsonStore.save() and friends), so a real async delay
// isn't an option. Atomics.wait on a throwaway SharedArrayBuffer is the
// standard Node technique for this.
function sleepSyncMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetry(tmpFile: string, destFile: string): void {
  try {
    fs.renameSync(tmpFile, destFile);
  } catch (e) {
    // Windows: a transient EPERM (antivirus/indexer holding the file open)
    // — retry once after a short delay before giving up for real.
    sleepSyncMs(50);
    fs.renameSync(tmpFile, destFile);
  }
}

export function writeJsonAtomic(file: string, data: unknown): void {
  try {
    const bakFile = file + '.bak';
    if (fs.existsSync(file)) {
      try {
        JSON.parse(fs.readFileSync(file, 'utf-8'));
        fs.copyFileSync(file, bakFile);
      } catch {
        // The current file is already corrupt — leave any existing .bak
        // (which may still be good) alone rather than overwriting it.
      }
    }
    const tmpFile = file + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(data));
    renameWithRetry(tmpFile, file);
  } catch (e) {
    log.warn('settings', `Failed to write ${path.basename(file)}`, { error: String(e) });
  }
}

export interface JsonReadResult {
  ok: boolean;
  data?: unknown;
  source?: 'main' | 'backup';
}

// Tries <file>, then <file>.bak. Never throws. Logging what it decided is
// the caller's job (readJsonWithBackup itself has no "name" to log under —
// JsonStore knows the friendly filename its caller passed in).
export function readJsonWithBackup(file: string): JsonReadResult {
  try {
    return { ok: true, data: JSON.parse(fs.readFileSync(file, 'utf-8')), source: 'main' };
  } catch {
    // fall through to the backup
  }
  try {
    return { ok: true, data: JSON.parse(fs.readFileSync(file + '.bak', 'utf-8')), source: 'backup' };
  } catch {
    return { ok: false };
  }
}

// A single userData-relative JSON file backing one typed value, with atomic
// writes and backup-fallback reads baked in (writeJsonAtomic/
// readJsonWithBackup above) — the shared pattern behind settings.json,
// bookmarks.json, tests.json, mock rules, and permissions.json. Exported
// here (moved out of index.ts, #276) so other main-process modules
// (permissionManager.ts) can use the same pattern without importing from
// index.ts, which would create a circular dependency (index.ts already
// imports from sessionManager.ts, which permissionManager.ts is used by).
export class JsonStore<T> {
  private file: string;
  private data: T;

  constructor(filename: string, defaultValue: T, init?: (raw: unknown) => T) {
    this.file = path.join(app.getPath('userData'), filename);
    const result = readJsonWithBackup(this.file);
    if (result.ok) {
      this.data = init ? init(result.data) : (result.data as T);
      if (result.source === 'backup') {
        log.warn('settings', `${filename} was missing or unreadable — restored from backup`);
      }
    } else {
      this.data = defaultValue;
      log.warn('settings', `${filename} and its backup were both missing or unreadable — using defaults`);
    }
  }

  get(): T { return this.data; }

  set(value: T): void { this.data = value; this.save(); }

  update(fn: (current: T) => T): T {
    this.data = fn(this.data);
    this.save();
    return this.data;
  }

  private save() {
    writeJsonAtomic(this.file, this.data);
  }
}
