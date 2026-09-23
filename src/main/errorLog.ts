import fs from 'fs';

export type AppLogLevel = 'error' | 'warn' | 'info' | 'debug';

// level is optional so entries written by a pre-#213 build (or read back from
// an older app-errors.json on disk) still deserialize — every entry recordAppError()
// itself produces from here on always sets it explicitly.
export interface AppErrorEntry { ts: number; message: string; level?: AppLogLevel; }

// Write-through for index.ts's recentAppErrors — a hard crash (renderer
// killed, OOM, native crash) never drains the event loop far enough for the
// process to run any handler of its own afterward, so the *next* launch's
// crash-detection code is often the only thing that ever reads this back,
// with a fresh, empty in-memory array of its own. Keeping the read/write
// pair here (rather than inline in index.ts) makes the durability itself
// unit-testable without pulling in all of index.ts's Electron app bootstrap.
export function writeAppErrors(filePath: string, entries: AppErrorEntry[]): void {
  try { fs.writeFileSync(filePath, JSON.stringify(entries)); } catch {}
}

export function readAppErrors(filePath: string): AppErrorEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
