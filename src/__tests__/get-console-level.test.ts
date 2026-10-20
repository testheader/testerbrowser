import { getConsoleLevel, getConsoleSource } from '../../renderer/utils.js';

function ev(kind: string, summary: string) {
  return { kind, ts: 1700000000000, summary, payload: '' };
}

describe('getConsoleLevel', () => {
  it('reads the level out of a console-kind row summary', () => {
    expect(getConsoleLevel(ev('console', '[error] boom'))).toBe('error');
    expect(getConsoleLevel(ev('console', '[log] hello'))).toBe('log');
    expect(getConsoleLevel(ev('console', '[debug] x'))).toBe('debug');
    expect(getConsoleLevel(ev('console', '[info] x'))).toBe('info');
  });

  it('normalizes CDP\'s "warning" type/level to "warn"', () => {
    expect(getConsoleLevel(ev('console', '[warning] careful'))).toBe('warn');
    expect(getConsoleLevel(ev('log', '[warning] careful'))).toBe('warn');
  });

  it('reads the level out of a log-kind row summary too', () => {
    expect(getConsoleLevel(ev('log', '[error] Failed to load resource'))).toBe('error');
  });

  it('always reports "error" for an exception-kind row', () => {
    expect(getConsoleLevel(ev('exception', 'Uncaught TypeError: x is not a function'))).toBe('error');
  });

  it('returns null for kinds it does not apply to', () => {
    expect(getConsoleLevel(ev('network-request', '[error] not a level'))).toBeNull();
    expect(getConsoleLevel(ev('network-response', '200 https://example.com'))).toBeNull();
  });

  it('returns null when the summary has no bracketed level', () => {
    expect(getConsoleLevel(ev('console', 'no brackets here'))).toBeNull();
  });
});

describe('getConsoleSource (#302)', () => {
  const withPayload = (kind: string, payload: object) => ({ kind, ts: 1, summary: '', payload: JSON.stringify(payload) });

  it('reads the first stack frame of a console call (0-based line → 1-based label)', () => {
    const e = withPayload('console', { stackTrace: { callFrames: [{ url: 'https://x.test/js/jquery-1.11.3.min.js', lineNumber: 3 }] } });
    expect(getConsoleSource(e)).toEqual({ label: 'jquery-1.11.3.min.js:4', url: 'https://x.test/js/jquery-1.11.3.min.js', line: 4 });
  });

  it('reads an exception\'s own url/line', () => {
    const e = withPayload('exception', { exceptionDetails: { url: 'https://x.test/app.js', lineNumber: 87 } });
    expect(getConsoleSource(e)?.label).toBe('app.js:88');
  });

  it('reads a Log entry\'s url/line, and omits the line when absent', () => {
    expect(getConsoleSource(withPayload('log', { entry: { url: 'https://x.test/status_codes/500', lineNumber: 0 } }))?.label).toBe('500:1');
    expect(getConsoleSource(withPayload('log', { entry: { url: 'https://x.test/a/b.js' } }))?.label).toBe('b.js');
  });

  it('is null when the event has no location', () => {
    expect(getConsoleSource(withPayload('console', { type: 'log' }))).toBeNull();
    expect(getConsoleSource({ kind: 'console', ts: 1, summary: '', payload: '' })).toBeNull();
    expect(getConsoleSource({ kind: 'console', ts: 1, summary: '', payload: '{not json' })).toBeNull();
  });
});
