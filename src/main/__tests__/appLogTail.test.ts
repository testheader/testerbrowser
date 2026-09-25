import fs from 'fs';
import os from 'os';
import path from 'path';
import { readLogTail, capLogBlock, capIssueBody, decideScreenshotStrategy } from '../logTail';

function tmpDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `log-tail-test-${name}-`));
}

describe('readLogTail', () => {
  it('returns an empty array when neither main.log nor main.log.1 exist', () => {
    expect(readLogTail(tmpDir('missing'), 10)).toEqual([]);
  });

  it('returns the last N lines of main.log alone when it already has enough', () => {
    const dir = tmpDir('enough');
    fs.writeFileSync(path.join(dir, 'main.log'), ['a', 'b', 'c', 'd', 'e'].join('\n') + '\n');
    expect(readLogTail(dir, 3)).toEqual(['c', 'd', 'e']);
  });

  it('tops up from the end of main.log.1 when main.log alone has fewer than N lines', () => {
    const dir = tmpDir('span');
    fs.writeFileSync(path.join(dir, 'main.log.1'), ['old-1', 'old-2', 'old-3'].join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'main.log'), ['new-1', 'new-2'].join('\n') + '\n');
    // Wants 4 lines; main.log has 2, so 2 more come from the end of .1,
    // oldest-file-first so chronological order is preserved.
    expect(readLogTail(dir, 4)).toEqual(['old-2', 'old-3', 'new-1', 'new-2']);
  });

  it('never reaches into main.log.1 once main.log alone satisfies the request', () => {
    const dir = tmpDir('no-spill');
    fs.writeFileSync(path.join(dir, 'main.log.1'), ['old-1'].join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'main.log'), ['new-1', 'new-2', 'new-3'].join('\n') + '\n');
    expect(readLogTail(dir, 2)).toEqual(['new-2', 'new-3']);
  });
});

describe('capLogBlock', () => {
  it('returns the full text untruncated when under the cap', () => {
    const result = capLogBlock(['a', 'b', 'c'], 1000);
    expect(result).toEqual({ text: 'a\nb\nc', truncated: false });
  });

  it('drops the oldest (frontmost) lines until the joined text fits', () => {
    const lines = ['oldest', 'middle', 'newest'];
    // 'oldest\nmiddle\nnewest' is 20 chars; cap tight enough to force
    // dropping 'oldest' but keep 'middle\nnewest' (13 chars).
    const result = capLogBlock(lines, 13);
    expect(result).toEqual({ text: 'middle\nnewest', truncated: true });
  });

  it('hard-truncates from the front when even the last line alone is over the cap', () => {
    const result = capLogBlock(['a', 'x'.repeat(50)], 10);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(10);
    expect(result.text).toBe('x'.repeat(10));
  });
});

describe('capIssueBody', () => {
  it('returns description + diagnostics untouched when under the cap', () => {
    expect(capIssueBody('desc', 'diag', 100)).toBe('desc\n\ndiag');
  });

  it('never truncates the description and always returns <= max for a 100 KB input', () => {
    const description = 'a real bug description';
    const diagnostics = 'x'.repeat(100_000);
    const body = capIssueBody(description, diagnostics, 60_000);

    expect(body.length).toBeLessThanOrEqual(60_000);
    expect(body.startsWith(description)).toBe(true);
  });

  it('truncates diagnostics from the end, not the beginning', () => {
    const diagnostics = 'keep-this-start' + 'z'.repeat(1000);
    const body = capIssueBody('d', diagnostics, 30);
    expect(body).toContain('keep-this-start');
  });
});

describe('decideScreenshotStrategy (#246)', () => {
  it('uploads via the Contents API when the token has push access', () => {
    expect(decideScreenshotStrategy(true)).toBe('upload');
  });

  it('saves locally instead when the token lacks push access', () => {
    expect(decideScreenshotStrategy(false)).toBe('save-locally');
  });
});
