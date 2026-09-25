import { toCurl, toFetch } from '../../renderer/utils.js';

describe('toCurl (#232)', () => {
  it('quotes a header value containing a single quote', () => {
    const cmd = toCurl({ method: 'GET', url: 'https://example.com', headers: { 'X-Note': "it's here" } });
    expect(cmd).toContain(`-H 'X-Note: it'\\''s here'`);
  });

  it('quotes a body containing newlines as a single --data-raw argument', () => {
    const cmd = toCurl({ method: 'POST', url: 'https://example.com', postData: 'line1\nline2' });
    expect(cmd).toContain(`--data-raw 'line1\nline2'`);
  });

  it('omits -X for a GET request', () => {
    const cmd = toCurl({ method: 'GET', url: 'https://example.com' });
    expect(cmd).not.toContain('-X');
  });

  it('includes -X for a non-GET request', () => {
    const cmd = toCurl({ method: 'DELETE', url: 'https://example.com' });
    expect(cmd).toContain('-X DELETE');
  });

  it('leaves out [REDACTED] headers and prepends a comment line saying so', () => {
    const cmd = toCurl({
      method: 'GET',
      url: 'https://example.com',
      headers: { Authorization: '[REDACTED]', Accept: 'application/json' },
    });
    expect(cmd).not.toContain('Authorization');
    expect(cmd).toContain('-H \'Accept: application/json\'');
    expect(cmd.split('\n')[0]).toBe('# 1 redacted header omitted');
  });

  it('adds no comment line when nothing was redacted', () => {
    const cmd = toCurl({ method: 'GET', url: 'https://example.com', headers: { Accept: 'application/json' } });
    expect(cmd.startsWith('curl ')).toBe(true);
  });

  it('starts with curl and the quoted URL', () => {
    const cmd = toCurl({ method: 'GET', url: 'https://example.com/path' });
    expect(cmd).toBe(`curl 'https://example.com/path'`);
  });
});

describe('toFetch (#232)', () => {
  it('produces a fetch() call with method, headers and body', () => {
    const code = toFetch({
      method: 'POST', url: 'https://example.com/api',
      headers: { 'Content-Type': 'application/json' },
      postData: '{"a":1}',
    });
    expect(code).toContain('fetch("https://example.com/api"');
    expect(code).toContain('"method": "POST"');
    expect(code).toContain('"Content-Type": "application/json"');
    expect(code).toContain('"body": "{\\"a\\":1}"');
  });

  it('leaves out [REDACTED] headers and prepends a comment line saying so', () => {
    const code = toFetch({
      method: 'GET', url: 'https://example.com',
      headers: { Cookie: '[REDACTED]', Accept: 'text/html' },
    });
    expect(code).not.toContain('Cookie');
    expect(code).toContain('"Accept": "text/html"');
    expect(code.split('\n')[0]).toBe('// 1 redacted header omitted');
  });
});
