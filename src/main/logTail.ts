import fs from 'fs';
import path from 'path';

/**
 * Pure helpers behind the crash log's/bug report's "App log" tail (#226).
 * Kept separate from appLogger.ts (#225) and dependency-free (no Electron)
 * so they're trivially unit-testable with a real temp dir.
 */

function readLines(filePath: string): string[] {
  try {
    return fs.readFileSync(filePath, 'utf-8').split('\n').filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

/**
 * The last `lines` lines of `dir`/main.log, oldest first. When main.log
 * alone has fewer than `lines`, tops up from the end of main.log.1 (the
 * next-oldest rotated file) so the tail still spans a rotation boundary.
 */
export function readLogTail(dir: string, lines: number): string[] {
  const current = readLines(path.join(dir, 'main.log'));
  if (current.length >= lines) return current.slice(-lines);

  const needed = lines - current.length;
  const older = readLines(path.join(dir, 'main.log.1'));
  return [...older.slice(-needed), ...current];
}

/**
 * Joins `lines` and, if the result is over maxChars, drops the oldest
 * (frontmost) lines until it fits — falling back to a hard slice off the
 * front for the pathological case of a single line already over maxChars.
 */
export function capLogBlock(lines: string[], maxChars: number): { text: string; truncated: boolean } {
  const full = lines.join('\n');
  if (full.length <= maxChars) return { text: full, truncated: false };

  const kept = lines.slice();
  while (kept.length > 1 && kept.join('\n').length > maxChars) kept.shift();
  let text = kept.join('\n');
  if (text.length > maxChars) text = text.slice(text.length - maxChars);
  return { text, truncated: true };
}

/**
 * description + "\n\n" + diagnostics, capped at `max` chars. Truncates from
 * the *end* of diagnostics (never description) — since the app-log block is
 * always appended last within diagnostics, an end-truncation naturally
 * drops app-log content before it eats into the rest of the diagnostics.
 */
export function capIssueBody(description: string, diagnostics: string, max: number): string {
  const sep = '\n\n';
  const body = `${description}${sep}${diagnostics}`;
  if (body.length <= max) return body;

  const budget = max - description.length - sep.length;
  if (budget <= 0) return description.slice(0, max);
  return `${description}${sep}${diagnostics.slice(0, budget)}`;
}
