import fs from 'fs';
import os from 'os';
import path from 'path';
import { SENSITIVE_HEADERS } from '../recorder';

jest.mock('electron', () => ({
  app: { getVersion: jest.fn(() => '9.9.9') },
}));

import { rotateIfNeeded, redact, redactCtx, formatLine } from '../appLogger';
import type * as AppLogger from '../appLogger';

function tmpDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `app-logger-test-${name}-`));
}

describe('rotateIfNeeded', () => {
  it('does nothing when the file does not exist', () => {
    const dir = tmpDir('missing');
    expect(() => rotateIfNeeded(path.join(dir, 'main.log'), 10, 4)).not.toThrow();
    expect(fs.existsSync(path.join(dir, 'main.log'))).toBe(false);
  });

  it('does nothing when the file is under the size cap', () => {
    const dir = tmpDir('under-cap');
    const filePath = path.join(dir, 'main.log');
    fs.writeFileSync(filePath, 'small');
    rotateIfNeeded(filePath, 1024, 4);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('small');
    expect(fs.existsSync(`${filePath}.1`)).toBe(false);
  });

  it('shifts main.log to main.log.1 once at or over the size cap', () => {
    const dir = tmpDir('shift-once');
    const filePath = path.join(dir, 'main.log');
    fs.writeFileSync(filePath, 'x'.repeat(20));
    rotateIfNeeded(filePath, 10, 4);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(fs.readFileSync(`${filePath}.1`, 'utf-8')).toBe('x'.repeat(20));
  });

  it('cascades existing rotated files up a slot and never exceeds keep', () => {
    const dir = tmpDir('cascade');
    const filePath = path.join(dir, 'main.log');
    // Simulate repeated rotations, as appendLine() would trigger on each new
    // main.log that grows past the cap again after a previous rotation.
    for (let round = 0; round < 8; round++) {
      fs.writeFileSync(filePath, `round-${round}-`.repeat(5));
      rotateIfNeeded(filePath, 10, 4);
    }
    const files = fs.readdirSync(dir);
    // main.log itself was just rotated away each round, so only the rotated
    // siblings remain — at most `keep` (4) of them: .1 through .4.
    expect(files.length).toBeLessThanOrEqual(4);
    expect(files.sort()).toEqual(['main.log.1', 'main.log.2', 'main.log.3', 'main.log.4']);
    // Most recent round's content should have landed in .1 (the freshest slot).
    expect(fs.readFileSync(`${filePath}.1`, 'utf-8')).toBe('round-7-'.repeat(5));
  });
});

describe('redact', () => {
  it('strips a URL query string and fragment, keeping a marker', () => {
    expect(redact('see https://x.test/a?token=1#f for details')).toBe('see https://x.test/a?… for details');
  });

  it('leaves a URL with no query string or fragment untouched', () => {
    expect(redact('see https://x.test/a for details')).toBe('see https://x.test/a for details');
  });

  it('strips a bare query string even without a preceding URL scheme', () => {
    expect(redact('e2e-marker ?secret=1')).toBe('e2e-marker ?…');
  });

  it('redacts a Bearer token', () => {
    expect(redact('Authorization header was Bearer abc.def.ghi')).toBe('Authorization header was Bearer [REDACTED]');
  });

  it.each([...SENSITIVE_HEADERS])('redacts the %s header name/value pair, case-insensitively', (name) => {
    const upper = name.toUpperCase();
    expect(redact(`${name}: secretvalue`)).toBe(`${name}: [REDACTED]`);
    expect(redact(`${upper}=secretvalue`)).toBe(`${upper}: [REDACTED]`);
  });

  it('leaves a non-sensitive name/value pair untouched', () => {
    expect(redact('status=ok')).toBe('status=ok');
  });

  it('passes through empty and non-string input unchanged', () => {
    expect(redact('')).toBe('');
  });
});

describe('redactCtx', () => {
  it('redacts every string value but leaves other types untouched', () => {
    const out = redactCtx({ url: 'https://x.test/a?token=1', count: 3, ok: true });
    expect(out).toEqual({ url: 'https://x.test/a?…', count: 3, ok: true });
  });

  it('returns undefined when passed undefined', () => {
    expect(redactCtx(undefined)).toBeUndefined();
  });
});

describe('formatLine', () => {
  it('escapes newlines in the message', () => {
    const line = formatLine({ ts: Date.UTC(2026, 8, 24, 13, 48, 26, 123), level: 'error', source: 'app', message: 'line one\nline two' });
    expect(line).toBe('2026-09-24T13:48:26.123Z ERROR [app] line one\\nline two');
  });

  it('appends ctx as trailing JSON when present', () => {
    const line = formatLine({ ts: 0, level: 'warn', source: 'sess', message: 'hi', ctx: { a: 1 } });
    expect(line).toBe('1970-01-01T00:00:00.000Z WARN [sess] hi {"a":1}');
  });

  it('omits the trailing JSON when ctx is empty or absent', () => {
    expect(formatLine({ ts: 0, level: 'info', source: 'app', message: 'hi' })).toBe('1970-01-01T00:00:00.000Z INFO [app] hi');
    expect(formatLine({ ts: 0, level: 'info', source: 'app', message: 'hi', ctx: {} })).toBe('1970-01-01T00:00:00.000Z INFO [app] hi');
  });
});

// log/initLogger/getRecentErrors share module-level state (the ring, the
// sink config) across calls, the same way index.ts's single long-lived
// process does. jest.resetModules() + a fresh require between tests keeps
// each case's ring isolated instead of depending on test execution order.
describe('log / initLogger', () => {
  let appLogger: typeof AppLogger;

  beforeEach(() => {
    jest.resetModules();
    appLogger = require('../appLogger');
  });

  it('drops debug entries entirely when the debugMode getter returns false', () => {
    const dir = tmpDir('debug-off');
    const appErrorsPath = path.join(dir, 'app-errors.json');
    appLogger.initLogger({ dir, debugMode: () => false, debugLogStore: null, appErrorsPath });

    appLogger.log.debug('app', 'should not appear');

    expect(appLogger.getRecentErrors()).toEqual([]);
    expect(fs.existsSync(appErrorsPath)).toBe(false);
    const mainLog = fs.readFileSync(path.join(dir, 'main.log'), 'utf-8');
    expect(mainLog).not.toContain('should not appear');
  });

  it('writes debug entries to every sink when the debugMode getter returns true', () => {
    const dir = tmpDir('debug-on');
    const appErrorsPath = path.join(dir, 'app-errors.json');
    appLogger.initLogger({ dir, debugMode: () => true, debugLogStore: null, appErrorsPath });

    appLogger.log.debug('app', 'debug marker');

    expect(appLogger.getRecentErrors().map((e) => e.message)).toEqual(['debug marker']);
    expect(JSON.parse(fs.readFileSync(appErrorsPath, 'utf-8'))).toEqual(appLogger.getRecentErrors());
    const mainLog = fs.readFileSync(path.join(dir, 'main.log'), 'utf-8');
    expect(mainLog).toContain('debug marker');
  });

  it('writes a header line on init containing the app/Electron version and pid', () => {
    const dir = tmpDir('header');
    appLogger.initLogger({ dir, debugMode: () => false, debugLogStore: null, appErrorsPath: path.join(dir, 'app-errors.json') });
    const firstLine = fs.readFileSync(path.join(dir, 'main.log'), 'utf-8').split('\n')[0];
    expect(firstLine).toMatch(/^=== TesterBrowser 9\.9\.9 \| Electron .+ \| .+ \| pid \d+ ===$/);
  });

  it('redacts message and ctx before they reach main.log', () => {
    const dir = tmpDir('redact-sink');
    appLogger.initLogger({ dir, debugMode: () => false, debugLogStore: null, appErrorsPath: path.join(dir, 'app-errors.json') });

    appLogger.log.error('app', 'token leak at https://x.test/cb?token=abc123');

    const mainLog = fs.readFileSync(path.join(dir, 'main.log'), 'utf-8');
    expect(mainLog).not.toContain('token=abc123');
    expect(mainLog).toContain('https://x.test/cb?…');
  });

  it('calls made before initLogger only update the in-memory ring', () => {
    appLogger.log.error('app', 'pre-init entry');
    expect(appLogger.getRecentErrors().map((e: { message: string }) => e.message)).toEqual(['pre-init entry']);
  });
});
