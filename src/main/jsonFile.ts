import fs from 'fs';
import path from 'path';
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
