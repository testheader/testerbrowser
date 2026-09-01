import fs from 'fs';

export interface UpdateLogEntry {
  timestamp: string;
  status: string;
  message: string;
  currentVersion: string;
  latestVersion: string | null;
}

const MAX_ENTRIES = 50;

export function writeUpdateLog(logFile: string, entry: UpdateLogEntry): void {
  let existing: string[] = [];
  try {
    existing = fs.readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean);
  } catch {}
  existing.push(JSON.stringify(entry));
  fs.writeFileSync(logFile, existing.slice(-MAX_ENTRIES).join('\n') + '\n', 'utf-8');
}

export function readUpdateLog(logFile: string): UpdateLogEntry[] {
  try {
    return fs.readFileSync(logFile, 'utf-8')
      .trim().split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as UpdateLogEntry);
  } catch {
    return [];
  }
}
