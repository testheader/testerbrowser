import { getConsoleLevel } from '../../renderer/utils.js';

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
