// Primary CTA rule (#361): a renderEmptyState() call that passes `actionLabel`
// must use `tone: 'accent'`. Static scan of renderer/*.js.
import * as fs from 'fs';
import * as path from 'path';

const RENDERER_DIR = path.join(__dirname, '..', '..', 'renderer');

// Intentional / pending exceptions, keyed by file. Remove an entry once fixed.
const ALLOW: Record<string, string> = {
  'debuglog.js': 'neutral "Open settings" is a secondary action (ticket owner decision)',
  'record-playback.js': "tone 'err' matches the red record button",
  'resilience.js': "tone 'warn' has no button style; fixed by #362",
};

/** Returns the text of each renderEmptyState({ ... }) call (balanced braces). */
function findCalls(src: string): string[] {
  const calls: string[] = [];
  const re = /renderEmptyState\(\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    calls.push(src.slice(m.index, i));
  }
  return calls;
}

describe('renderEmptyState CTA tone rule', () => {
  const files = fs.readdirSync(RENDERER_DIR).filter(f => f.endsWith('.js') && f !== 'empty-state.js');

  it('finds the scanned calls', () => {
    const total = files.reduce((n, f) => n + findCalls(fs.readFileSync(path.join(RENDERER_DIR, f), 'utf8')).length, 0);
    expect(total).toBeGreaterThan(5);
  });

  it("requires tone: 'accent' on every call with an actionLabel", () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (ALLOW[f]) continue;
      for (const call of findCalls(fs.readFileSync(path.join(RENDERER_DIR, f), 'utf8'))) {
        if (!/\bactionLabel\b/.test(call)) continue;
        if (!/tone:\s*'accent'/.test(call)) offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the allow-list free of stale entries', () => {
    for (const f of Object.keys(ALLOW)) expect(files).toContain(f);
  });
});
