import os from 'os';
import fs from 'fs';
import path from 'path';
import { SessionRecorder } from '../recorder';

// #252: better-sqlite3 turned out to load fine under Jest's plain Node
// runtime with no ABI issues — this package ships prebuilt binaries
// (prebuildify-style, see node_modules/better-sqlite3/package.json's
// "gypfile": false) selected by Node's own ABI at require time, not compiled
// via node-gyp, so electron-rebuild's Electron-ABI output (built for the
// packaged app) never gets in the way of a plain `node_modules` install
// running under Jest. Confirmed with a throwaway spike test before writing
// any of this file. Every test below uses the real driver against a fresh
// temp directory per test (same pattern as appLogger.test.ts (#225) and
// jsonFile.test.ts (#248)), not a hand-rolled SQL-matching fake — the
// previous regex-based mock here could never have caught a real schema/query
// bug (a broken column name, WHERE clause or trim LIMIT), which is exactly
// what this ticket exists to close.
const tmpDirs: string[] = [];
function freshDbDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function makeMockWc(opts: { onGetResponseBody?: (requestId: string) => Promise<{ body: string; base64Encoded: boolean }> } = {}) {
  let messageListener: ((e: null, method: string, params: unknown) => void) | null = null;
  const debugger_ = {
    attach: jest.fn(),
    sendCommand: jest.fn((method: string, params?: { requestId: string }) => {
      if (method === 'Network.getResponseBody' && opts.onGetResponseBody) {
        return opts.onGetResponseBody(params!.requestId);
      }
      return Promise.resolve({ body: '', base64Encoded: false });
    }),
    on: jest.fn((event: string, cb: (e: null, method: string, params: unknown) => void) => {
      if (event === 'message') messageListener = cb;
    }),
    detach: jest.fn(),
  };
  return {
    wc: { debugger: debugger_ } as any,
    emit(method: string, params: unknown) {
      messageListener?.(null, method, params);
    },
  };
}

// Network.loadingFinished's Network.getResponseBody call is fire-and-forget
// from recorder.ts's own perspective (not awaited) — its .then()/.catch()
// callback needs a turn of the microtask queue (the sendCommand promise
// resolving, then its own .then() running) before the resulting record()
// call (or lack of one) is observable. setImmediate is a macrotask, so it
// always runs after every microtask already queued.
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('SessionRecorder session id → filename (L5)', () => {
  it('refuses a traversal session id for an on-disk database, creating nothing outside dbDir', () => {
    const dbDir = freshDbDir();
    expect(() => new SessionRecorder(makeMockWc().wc, { sessionId: '../escaped', dbDir })).toThrow(/Invalid session id/);
    expect(fs.existsSync(path.join(dbDir, '..', 'escaped.sqlite'))).toBe(false);
  });

  it('still allows any id for an in-memory database (no file is named after it)', () => {
    const rec = new SessionRecorder(makeMockWc().wc, { sessionId: '../whatever', dbDir: freshDbDir(), inMemory: true });
    rec.destroy();
  });
});

describe('SessionRecorder', () => {
  let recorder: SessionRecorder;
  let emit: (method: string, params: unknown) => void;

  beforeEach(() => {
    const mock = makeMockWc();
    emit = mock.emit;
    recorder = new SessionRecorder(mock.wc, { sessionId: 'test-session', dbDir: freshDbDir() });
  });

  afterEach(() => {
    recorder.destroy();
  });

  // ── Event routing ──────────────────────────────────────────────────────────

  describe('network request recording', () => {
    it('records the correct kind and summary', () => {
      emit('Network.requestWillBeSent', {
        requestId: 'r1',
        request: { url: 'https://api.example.com/data', method: 'POST', headers: {} },
      });

      const [event] = recorder.getTimeline();
      expect(event.kind).toBe('network-request');
      expect(event.summary).toBe('POST https://api.example.com/data');
    });

    it('stores the full CDP params as JSON payload', () => {
      emit('Network.requestWillBeSent', {
        requestId: 'r1',
        request: { url: 'https://example.com', method: 'GET', headers: {} },
      });

      const payload = JSON.parse(recorder.getTimeline()[0].payload);
      expect(payload).toMatchObject({ requestId: 'r1' });
    });
  });

  describe('tagRequest (mock/resilience rule attribution)', () => {
    it('patches the tag onto the already-recorded request event, not just the response', () => {
      emit('Network.requestWillBeSent', {
        requestId: 'r1',
        request: { url: 'https://example.com', method: 'GET', headers: {} },
      });
      // Fetch.requestPaused (and therefore tagRequest) arrives after
      // requestWillBeSent has already been recorded — the common ordering.
      recorder.tagRequest('r1', { resilienceRuleId: 'res-1', resilienceType: 'error500' });
      emit('Network.responseReceived', {
        requestId: 'r1',
        response: { status: 500, url: 'https://example.com', headers: {} },
      });

      const request = recorder.getTimeline().find(e => e.kind === 'network-request')!;
      expect(JSON.parse(request.payload)).toMatchObject({ resilienceRuleId: 'res-1', resilienceType: 'error500' });

      const response = recorder.getTimeline().find(e => e.kind === 'network-response')!;
      expect(JSON.parse(response.payload)).toMatchObject({ resilienceRuleId: 'res-1', resilienceType: 'error500' });
    });

    it('tags the request event immediately when the tag exists before requestWillBeSent', () => {
      recorder.tagRequest('r1', { mockRuleId: 'mock-1' });
      emit('Network.requestWillBeSent', {
        requestId: 'r1',
        request: { url: 'https://example.com', method: 'GET', headers: {} },
      });

      const request = recorder.getTimeline().find(e => e.kind === 'network-request')!;
      expect(JSON.parse(request.payload)).toMatchObject({ mockRuleId: 'mock-1' });
    });

    it('is a no-op when the requestId has no recorded request row', () => {
      expect(() => recorder.tagRequest('unknown', { mockRuleId: 'mock-1' })).not.toThrow();
      expect(recorder.getTimeline()).toHaveLength(0);
    });
  });

  describe('network response recording', () => {
    it('uses the matched request URL in the summary', () => {
      emit('Network.requestWillBeSent', {
        requestId: 'r1',
        request: { url: 'https://example.com', method: 'GET', headers: {} },
      });
      emit('Network.responseReceived', {
        requestId: 'r1',
        response: { status: 200, url: 'https://example.com', headers: {} },
      });

      const response = recorder.getTimeline().find(e => e.kind === 'network-response')!;
      expect(response.summary).toBe('200 https://example.com');
    });

    it('falls back to the response URL when no matching request exists', () => {
      emit('Network.responseReceived', {
        requestId: 'unknown',
        response: { status: 404, url: 'https://other.com', headers: {} },
      });

      expect(recorder.getTimeline()[0].summary).toBe('404 https://other.com');
    });
  });

  describe('network failure recording', () => {
    it('includes the request URL and error text in the summary', () => {
      emit('Network.requestWillBeSent', {
        requestId: 'r1',
        request: { url: 'https://example.com', method: 'GET', headers: {} },
      });
      emit('Network.loadingFailed', {
        requestId: 'r1',
        errorText: 'net::ERR_NAME_NOT_RESOLVED',
      });

      const failed = recorder.getTimeline().find(e => e.kind === 'network-failed')!;
      expect(failed.summary).toContain('https://example.com');
      expect(failed.summary).toContain('net::ERR_NAME_NOT_RESOLVED');
    });
  });

  // #260: Set-Cookie (and the raw Cookie request header) never appear on
  // Network.requestWillBeSent/responseReceived — Chromium only delivers them
  // on the separate ...ExtraInfo events, which can arrive before or after
  // their corresponding request/response event.
  describe('ExtraInfo (Set-Cookie / Cookie headers)', () => {
    it('patches extraInfoHeaders onto the response row when responseReceivedExtraInfo arrives after the response', () => {
      emit('Network.requestWillBeSent', {
        requestId: 'r1',
        request: { url: 'https://example.com', method: 'GET', headers: {} },
      });
      emit('Network.responseReceived', {
        requestId: 'r1',
        response: { status: 200, url: 'https://example.com', headers: {} },
      });
      emit('Network.responseReceivedExtraInfo', {
        requestId: 'r1',
        headers: { 'set-cookie': 'sid=abc; Path=/' },
        blockedCookies: [],
      });

      const response = recorder.getTimeline().find(e => e.kind === 'network-response')!;
      const payload = JSON.parse(response.payload);
      expect(payload.extraInfoHeaders['set-cookie']).toBe('sid=abc; Path=/');
      expect(payload.blockedCookies).toEqual([]);
    });

    it('buffers responseReceivedExtraInfo arriving before responseReceived, and applies it once the response is recorded', () => {
      emit('Network.responseReceivedExtraInfo', {
        requestId: 'r1',
        headers: { 'set-cookie': 'sid=abc; Path=/' },
      });
      emit('Network.requestWillBeSent', {
        requestId: 'r1',
        request: { url: 'https://example.com', method: 'GET', headers: {} },
      });
      emit('Network.responseReceived', {
        requestId: 'r1',
        response: { status: 200, url: 'https://example.com', headers: {} },
      });

      const response = recorder.getTimeline().find(e => e.kind === 'network-response')!;
      const payload = JSON.parse(response.payload);
      expect(payload.extraInfoHeaders['set-cookie']).toBe('sid=abc; Path=/');
    });

    it('patches extraInfoHeaders onto the request row when requestWillBeSentExtraInfo arrives after the request', () => {
      emit('Network.requestWillBeSent', {
        requestId: 'r1',
        request: { url: 'https://example.com', method: 'GET', headers: {} },
      });
      emit('Network.requestWillBeSentExtraInfo', {
        requestId: 'r1',
        headers: { cookie: 'sid=abc' },
        associatedCookies: [{ cookie: { name: 'sid', value: 'abc' } }],
      });

      const request = recorder.getTimeline().find(e => e.kind === 'network-request')!;
      const payload = JSON.parse(request.payload);
      expect(payload.extraInfoHeaders.cookie).toBe('sid=abc');
      expect(payload.associatedCookies).toHaveLength(1);
    });

    it('buffers requestWillBeSentExtraInfo arriving before requestWillBeSent, and applies it once the request is recorded', () => {
      emit('Network.requestWillBeSentExtraInfo', {
        requestId: 'r1',
        headers: { cookie: 'sid=abc' },
      });
      emit('Network.requestWillBeSent', {
        requestId: 'r1',
        request: { url: 'https://example.com', method: 'GET', headers: {} },
      });

      const request = recorder.getTimeline().find(e => e.kind === 'network-request')!;
      expect(JSON.parse(request.payload).extraInfoHeaders.cookie).toBe('sid=abc');
    });

    it('redacts extraInfoHeaders the same way as regular headers when redaction is on', () => {
      const { wc, emit: e } = makeMockWc();
      const rec = new SessionRecorder(wc, {
        sessionId: 'redact-extra-info',
        dbDir: freshDbDir(),
        getRedact: () => true,
      });

      e('Network.requestWillBeSent', {
        requestId: 'r1',
        request: { url: 'https://example.com', method: 'GET', headers: {} },
      });
      e('Network.responseReceived', {
        requestId: 'r1',
        response: { status: 200, url: 'https://example.com', headers: {} },
      });
      e('Network.responseReceivedExtraInfo', {
        requestId: 'r1',
        headers: { 'set-cookie': 'sid=abc; Path=/', 'content-type': 'text/html' },
      });

      const response = rec.getTimeline().find(ev => ev.kind === 'network-response')!;
      const payload = JSON.parse(response.payload);
      expect(payload.extraInfoHeaders['set-cookie']).toBe('[REDACTED]');
      expect(payload.extraInfoHeaders['content-type']).toBe('text/html');

      rec.destroy();
    });

    it('drops buffered ExtraInfo for a request that fails before the response arrives, without leaking', () => {
      emit('Network.requestWillBeSent', {
        requestId: 'r1',
        request: { url: 'https://example.com', method: 'GET', headers: {} },
      });
      emit('Network.loadingFailed', { requestId: 'r1', errorText: 'net::ERR_FAILED' });
      // A late ExtraInfo for the same (already-cleaned-up) requestId is buffered
      // fresh rather than throwing — it just never gets consumed.
      expect(() => emit('Network.responseReceivedExtraInfo', {
        requestId: 'r1',
        headers: { 'set-cookie': 'sid=abc' },
      })).not.toThrow();
    });

    it('evicts the oldest buffered entry once pending ExtraInfo exceeds 500 requests', () => {
      for (let i = 0; i < 501; i++) {
        emit('Network.responseReceivedExtraInfo', {
          requestId: `pending-${i}`,
          headers: { 'set-cookie': `sid=${i}` },
        });
      }
      // The 0th entry was evicted, so its eventual response never gets patched.
      emit('Network.requestWillBeSent', {
        requestId: 'pending-0',
        request: { url: 'https://example.com/0', method: 'GET', headers: {} },
      });
      emit('Network.responseReceived', {
        requestId: 'pending-0',
        response: { status: 200, url: 'https://example.com/0', headers: {} },
      });
      const evicted = recorder.getTimeline().find(e => e.kind === 'network-response')!;
      expect(JSON.parse(evicted.payload).extraInfoHeaders).toBeUndefined();

      // The 500th (most recent) entry survived the cap.
      emit('Network.requestWillBeSent', {
        requestId: 'pending-500',
        request: { url: 'https://example.com/500', method: 'GET', headers: {} },
      });
      emit('Network.responseReceived', {
        requestId: 'pending-500',
        response: { status: 200, url: 'https://example.com/500', headers: {} },
      });
      const survived = recorder.getTimeline().find(e =>
        e.kind === 'network-response' && e.summary.includes('/500'))!;
      expect(JSON.parse(survived.payload).extraInfoHeaders['set-cookie']).toBe('sid=500');
    });
  });

  // #252: Network.loadingFinished's own Network.getResponseBody round-trip
  // (a separate CDP call the recorder makes itself, not part of the
  // requestWillBeSent/responseReceived payloads) had zero test coverage.
  describe('response body recording (Network.loadingFinished)', () => {
    it('records a network-body row once Network.getResponseBody resolves', async () => {
      const { wc, emit: e } = makeMockWc({
        onGetResponseBody: async () => ({ body: '{"ok":true}', base64Encoded: false }),
      });
      const rec = new SessionRecorder(wc, { sessionId: 'body-session', dbDir: freshDbDir() });

      e('Network.requestWillBeSent', {
        requestId: 'r1',
        request: { url: 'https://example.com/api', method: 'GET', headers: {} },
      });
      e('Network.loadingFinished', { requestId: 'r1' });
      await flushMicrotasks();

      const body = rec.getTimeline().find(ev => ev.kind === 'network-body')!;
      expect(body).toBeDefined();
      expect(body.summary).toBe('BODY GET https://example.com/api');
      const payload = JSON.parse(body.payload);
      expect(payload).toEqual({ requestId: 'r1', base64Encoded: false, body: '{"ok":true}' });

      rec.destroy();
    });

    it('truncates a text body over 51,200 characters, sets truncated: true and appends [truncated] to the body and summary', async () => {
      const longBody = 'x'.repeat(60_000);
      const { wc, emit: e } = makeMockWc({
        onGetResponseBody: async () => ({ body: longBody, base64Encoded: false }),
      });
      const rec = new SessionRecorder(wc, { sessionId: 'truncate-session', dbDir: freshDbDir() });

      e('Network.requestWillBeSent', {
        requestId: 'r1',
        request: { url: 'https://example.com/big', method: 'GET', headers: {} },
      });
      e('Network.loadingFinished', { requestId: 'r1' });
      await flushMicrotasks();

      const body = rec.getTimeline().find(ev => ev.kind === 'network-body')!;
      expect(body.summary).toContain('[truncated]');
      const payload = JSON.parse(body.payload);
      expect(payload.truncated).toBe(true);
      expect(payload.body).toBe('x'.repeat(51_200) + '\n[truncated]');

      rec.destroy();
    });

    // #260: a truncated base64 string is no longer valid base64 — storing it
    // corrupted image/font previews. Binary bodies over the cap are omitted
    // entirely instead of being cut.
    it('omits a base64-encoded body over 51,200 characters instead of truncating it, storing no body', async () => {
      const longBody = 'x'.repeat(60_000);
      const { wc, emit: e } = makeMockWc({
        onGetResponseBody: async () => ({ body: longBody, base64Encoded: true }),
      });
      const rec = new SessionRecorder(wc, { sessionId: 'omit-session', dbDir: freshDbDir() });

      e('Network.requestWillBeSent', {
        requestId: 'r1',
        request: { url: 'https://example.com/image.png', method: 'GET', headers: {} },
      });
      e('Network.loadingFinished', { requestId: 'r1' });
      await flushMicrotasks();

      const body = rec.getTimeline().find(ev => ev.kind === 'network-body')!;
      expect(body.summary).toContain('[omitted]');
      const payload = JSON.parse(body.payload);
      expect(payload).toEqual({ requestId: 'r1', base64Encoded: true, omitted: true, size: 60_000 });
      expect(payload.body).toBeUndefined();

      rec.destroy();
    });

    it('stores a base64-encoded body under the cap as-is, with no omitted/truncated flags', async () => {
      const { wc, emit: e } = makeMockWc({
        onGetResponseBody: async () => ({ body: 'aGVsbG8=', base64Encoded: true }),
      });
      const rec = new SessionRecorder(wc, { sessionId: 'small-base64-session', dbDir: freshDbDir() });

      e('Network.requestWillBeSent', {
        requestId: 'r1',
        request: { url: 'https://example.com/icon.png', method: 'GET', headers: {} },
      });
      e('Network.loadingFinished', { requestId: 'r1' });
      await flushMicrotasks();

      const body = rec.getTimeline().find(ev => ev.kind === 'network-body')!;
      const payload = JSON.parse(body.payload);
      expect(payload).toEqual({ requestId: 'r1', base64Encoded: true, body: 'aGVsbG8=' });

      rec.destroy();
    });

    it('does not record a network-body row (and does not throw) when Network.getResponseBody rejects', async () => {
      const { wc, emit: e } = makeMockWc({
        onGetResponseBody: async () => { throw new Error('No resource with given identifier found'); },
      });
      const rec = new SessionRecorder(wc, { sessionId: 'reject-session', dbDir: freshDbDir() });

      e('Network.requestWillBeSent', {
        requestId: 'r1',
        request: { url: 'https://example.com/image.png', method: 'GET', headers: {} },
      });
      expect(() => e('Network.loadingFinished', { requestId: 'r1' })).not.toThrow();
      await flushMicrotasks();

      expect(rec.getTimeline().some(ev => ev.kind === 'network-body')).toBe(false);

      rec.destroy();
    });

    it('does not record a network-body row when the resolved body is empty', async () => {
      const { wc, emit: e } = makeMockWc({
        onGetResponseBody: async () => ({ body: '', base64Encoded: false }),
      });
      const rec = new SessionRecorder(wc, { sessionId: 'empty-body-session', dbDir: freshDbDir() });

      e('Network.requestWillBeSent', {
        requestId: 'r1',
        request: { url: 'https://example.com/empty', method: 'GET', headers: {} },
      });
      e('Network.loadingFinished', { requestId: 'r1' });
      await flushMicrotasks();

      expect(rec.getTimeline().some(ev => ev.kind === 'network-body')).toBe(false);

      rec.destroy();
    });

    it('does nothing when loadingFinished arrives with no matching requestWillBeSent', async () => {
      const { wc, emit: e } = makeMockWc({
        onGetResponseBody: async () => ({ body: 'unreachable', base64Encoded: false }),
      });
      const rec = new SessionRecorder(wc, { sessionId: 'no-meta-session', dbDir: freshDbDir() });

      e('Network.loadingFinished', { requestId: 'unknown' });
      await flushMicrotasks();

      expect(rec.getTimeline()).toHaveLength(0);

      rec.destroy();
    });
  });

  describe('log and console recording', () => {
    it('records Log.entryAdded with level and text', () => {
      emit('Log.entryAdded', { entry: { level: 'error', text: 'Unhandled exception' } });

      const [event] = recorder.getTimeline();
      expect(event.kind).toBe('log');
      expect(event.summary).toBe('[error] Unhandled exception');
    });

    it('records Runtime.consoleAPICalled with joined args', () => {
      emit('Runtime.consoleAPICalled', {
        type: 'warn',
        args: [{ value: 'hello' }, { value: 'world' }],
      });

      const [event] = recorder.getTimeline();
      expect(event.kind).toBe('console');
      expect(event.summary).toBe('[warn] hello world');
    });

    it('uses description when arg has no value', () => {
      emit('Runtime.consoleAPICalled', {
        type: 'log',
        args: [{ description: 'HTMLElement' }],
      });

      expect(recorder.getTimeline()[0].summary).toBe('[log] HTMLElement');
    });

    it('records Runtime.exceptionThrown with the exception text and stack description', () => {
      emit('Runtime.exceptionThrown', {
        exceptionDetails: {
          text: 'Uncaught',
          exception: { description: 'Error: boom\n    at foo (page.html:1:1)' },
        },
      });

      const [event] = recorder.getTimeline();
      expect(event.kind).toBe('exception');
      expect(event.summary).toBe('Uncaught: Error: boom\n    at foo (page.html:1:1)');
    });

    it('falls back to just the exception text when there is no stack description', () => {
      emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught ReferenceError' } });

      expect(recorder.getTimeline()[0].summary).toBe('Uncaught ReferenceError');
    });
  });

  describe('unknown CDP events', () => {
    it('does not record unhandled event methods', () => {
      emit('Page.loadEventFired', {});
      emit('DOM.documentUpdated', {});

      expect(recorder.getTimeline()).toHaveLength(0);
    });
  });

  // ── Header redaction ───────────────────────────────────────────────────────

  describe('header redaction', () => {
    it('replaces sensitive request headers with [REDACTED]', () => {
      const { wc, emit: e } = makeMockWc();
      const rec = new SessionRecorder(wc, {
        sessionId: 'redact-req',
        dbDir: freshDbDir(),
        getRedact: () => true,
      });

      e('Network.requestWillBeSent', {
        requestId: 'r1',
        request: {
          url: 'https://api.example.com',
          method: 'GET',
          headers: {
            authorization: 'Bearer secret',
            'x-api-key': 'key-123',
            'content-type': 'application/json',
          },
        },
      });

      const payload = JSON.parse(rec.getTimeline()[0].payload);
      expect(payload.request.headers.authorization).toBe('[REDACTED]');
      expect(payload.request.headers['x-api-key']).toBe('[REDACTED]');
      expect(payload.request.headers['content-type']).toBe('application/json');

      rec.destroy();
    });

    it('replaces sensitive response headers with [REDACTED]', () => {
      const { wc, emit: e } = makeMockWc();
      const rec = new SessionRecorder(wc, {
        sessionId: 'redact-res',
        dbDir: freshDbDir(),
        getRedact: () => true,
      });

      e('Network.requestWillBeSent', {
        requestId: 'r1',
        request: { url: 'https://example.com', method: 'GET', headers: {} },
      });
      e('Network.responseReceived', {
        requestId: 'r1',
        response: {
          status: 200,
          url: 'https://example.com',
          headers: { 'set-cookie': 'session=secret; HttpOnly', 'content-type': 'text/html' },
        },
      });

      const responseEvent = rec.getTimeline().find(e => e.kind === 'network-response')!;
      const payload = JSON.parse(responseEvent.payload);
      expect(payload.response.headers['set-cookie']).toBe('[REDACTED]');
      expect(payload.response.headers['content-type']).toBe('text/html');

      rec.destroy();
    });

    it('does not redact headers when redaction is disabled (default)', () => {
      emit('Network.requestWillBeSent', {
        requestId: 'r1',
        request: {
          url: 'https://api.example.com',
          method: 'GET',
          headers: { authorization: 'Bearer token' },
        },
      });

      const payload = JSON.parse(recorder.getTimeline()[0].payload);
      expect(payload.request.headers.authorization).toBe('Bearer token');
    });

    // #248: toggling the getter must change the very next event in an
    // already-open tab — not require a fresh SessionRecorder.
    it('re-evaluates getRedact() per event, so flipping it mid-recording changes the next event', () => {
      const { wc, emit: e } = makeMockWc();
      let redact = false;
      const rec = new SessionRecorder(wc, {
        sessionId: 'live-toggle',
        dbDir: freshDbDir(),
        getRedact: () => redact,
      });

      e('Network.requestWillBeSent', {
        requestId: 'r1',
        request: { url: 'https://api.example.com/1', method: 'GET', headers: { authorization: 'Bearer secret' } },
      });
      const before = JSON.parse(rec.getTimeline()[0].payload);
      expect(before.request.headers.authorization).toBe('Bearer secret');

      redact = true;
      e('Network.requestWillBeSent', {
        requestId: 'r2',
        request: { url: 'https://api.example.com/2', method: 'GET', headers: { authorization: 'Bearer secret' } },
      });
      const after = JSON.parse(rec.getTimeline()[1].payload);
      expect(after.request.headers.authorization).toBe('[REDACTED]');

      rec.destroy();
    });

    // #252
    it('redacts a header spelled with capital letters (Authorization), not just lowercase', () => {
      const { wc, emit: e } = makeMockWc();
      const rec = new SessionRecorder(wc, {
        sessionId: 'redact-case',
        dbDir: freshDbDir(),
        getRedact: () => true,
      });

      e('Network.requestWillBeSent', {
        requestId: 'r1',
        request: {
          url: 'https://api.example.com',
          method: 'GET',
          headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
        },
      });

      const payload = JSON.parse(rec.getTimeline()[0].payload);
      expect(payload.request.headers.Authorization).toBe('[REDACTED]');
      expect(payload.request.headers['Content-Type']).toBe('application/json');

      rec.destroy();
    });

    // #252: redactHeaders' own `if (!headers || typeof headers !== 'object')
    // return headers` guard — a header set that's somehow not a plain object.
    it('does not throw when headers is not an object, and leaves the payload as-is', () => {
      const { wc, emit: e } = makeMockWc();
      const rec = new SessionRecorder(wc, {
        sessionId: 'redact-non-object',
        dbDir: freshDbDir(),
        getRedact: () => true,
      });

      expect(() => e('Network.requestWillBeSent', {
        requestId: 'r1',
        request: { url: 'https://example.com', method: 'GET', headers: undefined },
      })).not.toThrow();

      const payload = JSON.parse(rec.getTimeline()[0].payload);
      expect(payload.request.headers).toBeUndefined();

      rec.destroy();
    });
  });

  // ── Ring buffer ────────────────────────────────────────────────────────────

  describe('ring buffer', () => {
    it('trims oldest events once the 100th insert exceeds the cap', () => {
      const { wc, emit: e } = makeMockWc();
      const rec = new SessionRecorder(wc, {
        sessionId: 'trim-session',
        dbDir: freshDbDir(),
        maxEventsPerSession: 50,
      });

      // The 100th insert triggers the trim check: count(100) > 50 → delete 50 oldest
      for (let i = 0; i < 100; i++) {
        e('Log.entryAdded', { entry: { level: 'info', text: `event-${i}` } });
      }

      const events = rec.getTimeline({ limit: 200 });
      expect(events).toHaveLength(50);

      const summaries = events.map(ev => ev.summary);
      // event-0 through event-49 (lowest IDs) were deleted
      expect(summaries).not.toContain('[info] event-0');
      expect(summaries).not.toContain('[info] event-49');
      // event-50 through event-99 remain
      expect(summaries).toContain('[info] event-50');
      expect(summaries).toContain('[info] event-99');

      rec.destroy();
    });

    it('does not trim before the 100th insert even when over cap', () => {
      const { wc, emit: e } = makeMockWc();
      const rec = new SessionRecorder(wc, {
        sessionId: 'notrim-session',
        dbDir: freshDbDir(),
        maxEventsPerSession: 5,
      });

      for (let i = 0; i < 99; i++) {
        e('Log.entryAdded', { entry: { level: 'info', text: `event-${i}` } });
      }

      // trimCounter=99, never hit a multiple of 100 yet
      expect(rec.getTimeline({ limit: 200 })).toHaveLength(99);

      rec.destroy();
    });

    // #229
    it('sets evictedAt/evictedCount and reports them via getStatus() once the cap is exceeded', () => {
      const { wc, emit: e } = makeMockWc();
      const rec = new SessionRecorder(wc, {
        sessionId: 'evict-session',
        dbDir: freshDbDir(),
        maxEventsPerSession: 1000,
      });

      expect(rec.getStatus()).toEqual({ cap: 1000, evictedAt: null, evictedCount: 0 });

      for (let i = 0; i < 1500; i++) {
        e('Log.entryAdded', { entry: { level: 'info', text: `event-${i}` } });
      }

      expect(rec.getTimeline({ limit: 5000 })).toHaveLength(1000);
      const status = rec.getStatus();
      expect(status.cap).toBe(1000);
      expect(status.evictedAt).toEqual(expect.any(Number));
      expect(status.evictedCount).toBe(500);

      rec.destroy();
    });

    // #229
    it('only sets evictedAt on the first eviction, not every subsequent trim', () => {
      const { wc, emit: e } = makeMockWc();
      const rec = new SessionRecorder(wc, {
        sessionId: 'evict-once-session',
        dbDir: freshDbDir(),
        maxEventsPerSession: 100,
      });

      for (let i = 0; i < 300; i++) {
        e('Log.entryAdded', { entry: { level: 'info', text: `event-${i}` } });
      }

      const firstEvictedAt = rec.getStatus().evictedAt;
      expect(firstEvictedAt).not.toBeNull();

      for (let i = 300; i < 500; i++) {
        e('Log.entryAdded', { entry: { level: 'info', text: `event-${i}` } });
      }

      expect(rec.getStatus().evictedAt).toBe(firstEvictedAt);
      expect(rec.getStatus().evictedCount).toBeGreaterThan(200);

      rec.destroy();
    });

    // #252: trimStmt's WHERE session_id = ? is exactly the kind of thing a
    // regex-matching SQL fake can't meaningfully verify, since it never has a
    // real query to get wrong. In production each session already gets its
    // own <sessionId>.sqlite file under a shared dbDir, so two sessions never
    // actually share one physical database — this test still exercises the
    // WHERE clause itself as defense-in-depth against dbDir/dbPath ever
    // changing to a shared file.
    it('trimming one session never trims another session sharing the same dbDir', () => {
      const dbDir = freshDbDir();
      const { wc: wcA, emit: eA } = makeMockWc();
      const { wc: wcB, emit: eB } = makeMockWc();
      const recA = new SessionRecorder(wcA, { sessionId: 'session-a', dbDir, maxEventsPerSession: 5 });
      const recB = new SessionRecorder(wcB, { sessionId: 'session-b', dbDir, maxEventsPerSession: 1000 });

      for (let i = 0; i < 10; i++) eB('Log.entryAdded', { entry: { level: 'info', text: `b-${i}` } });
      // Push session A well past its cap and through a trim check (every
      // 100th insert) while session B's own rows sit in the same directory.
      for (let i = 0; i < 100; i++) eA('Log.entryAdded', { entry: { level: 'info', text: `a-${i}` } });

      expect(recA.getTimeline({ limit: 200 })).toHaveLength(5);
      // Session B's 10 rows are all still there — untouched by A's trim.
      expect(recB.getTimeline({ limit: 200 })).toHaveLength(10);

      recA.destroy();
      recB.destroy();
    });
  });

  // ── inMemory (#229) ─────────────────────────────────────────────────────────

  describe('inMemory temp-tab recording', () => {
    it('records normally but never creates a file under dbDir when inMemory is true', () => {
      // Against the real driver (#252), the meaningful proof isn't the
      // constructor argument — it's that no on-disk trace of a temp tab's
      // traffic ever appears, which a mock could only assert by trusting the
      // argument it was given, not by checking real disk state.
      const dbDir = freshDbDir();
      const { wc, emit: e } = makeMockWc();
      const rec = new SessionRecorder(wc, {
        sessionId: 'temp-session',
        dbDir,
        inMemory: true,
      });

      e('Log.entryAdded', { entry: { level: 'info', text: 'hello' } });
      expect(rec.getTimeline()).toHaveLength(1);
      // dbDir (used only for persistent, on-disk recorders) is never even
      // written to for an in-memory one.
      expect(fs.readdirSync(dbDir)).toEqual([]);

      rec.destroy();
    });

    it('opens a real file at <dbDir>/<sessionId>.sqlite when inMemory is false/omitted', () => {
      const dbDir = freshDbDir();
      const { wc, emit: e } = makeMockWc();
      const rec = new SessionRecorder(wc, { sessionId: 'persist-session', dbDir });

      e('Log.entryAdded', { entry: { level: 'info', text: 'hello' } });
      const dbPath = path.join(dbDir, 'persist-session.sqlite');
      expect(fs.existsSync(dbPath)).toBe(true);

      rec.destroy();

      // Surviving a close/reopen against the same file is the real proof
      // this is a genuine on-disk database, not just an empty placeholder.
      const { wc: wc2 } = makeMockWc();
      const rec2 = new SessionRecorder(wc2, { sessionId: 'persist-session', dbDir });
      expect(rec2.getTimeline()[0].summary).toBe('[info] hello');
      rec2.destroy();
    });
  });

  // ── getTimeline ────────────────────────────────────────────────────────────

  describe('getTimeline', () => {
    it('returns events in ascending timestamp order', () => {
      const mockNow = jest.spyOn(Date, 'now');
      try {
        mockNow.mockReturnValue(1000);
        emit('Log.entryAdded', { entry: { level: 'info', text: 'first' } });
        mockNow.mockReturnValue(2000);
        emit('Log.entryAdded', { entry: { level: 'info', text: 'second' } });
        mockNow.mockReturnValue(3000);
        emit('Log.entryAdded', { entry: { level: 'info', text: 'third' } });

        expect(recorder.getTimeline().map(e => e.ts)).toEqual([1000, 2000, 3000]);
      } finally {
        mockNow.mockRestore();
      }
    });

    it('returns only events strictly after the since timestamp', () => {
      const mockNow = jest.spyOn(Date, 'now');
      try {
        mockNow.mockReturnValue(1000);
        emit('Log.entryAdded', { entry: { level: 'info', text: 'old' } });
        mockNow.mockReturnValue(2000);
        emit('Log.entryAdded', { entry: { level: 'info', text: 'new' } });

        const events = recorder.getTimeline({ since: 1000 });
        expect(events).toHaveLength(1);
        expect(events[0].summary).toBe('[info] new');
      } finally {
        mockNow.mockRestore();
      }
    });

    it('respects the limit option', () => {
      for (let i = 0; i < 10; i++) {
        emit('Log.entryAdded', { entry: { level: 'info', text: `msg-${i}` } });
      }

      expect(recorder.getTimeline({ limit: 3 })).toHaveLength(3);
    });

    it('returns an empty array when nothing has been recorded', () => {
      expect(recorder.getTimeline()).toHaveLength(0);
    });

    it('pages 450 same-ts events via sinceId without loss or duplicates', () => {
      const spy = jest.spyOn(Date, 'now').mockReturnValue(1000);
      for (let i = 0; i < 450; i++) {
        emit('Log.entryAdded', { entry: { level: 'info', text: `msg-${i}` } });
      }
      const seen: number[] = [];
      let cursor = 0;
      for (;;) {
        const page = recorder.getTimeline({ sinceId: cursor, limit: 200 });
        seen.push(...page.map(r => r.id as number));
        if (page.length < 200) break;
        cursor = page[page.length - 1].id as number;
      }
      expect(seen).toHaveLength(450);
      expect(new Set(seen).size).toBe(450);
      expect([...seen].sort((a, b) => a - b)).toEqual(seen);

      // A late write with the same ts is still returned after the cursor.
      emit('Log.entryAdded', { entry: { level: 'info', text: 'late' } });
      const late = recorder.getTimeline({ sinceId: seen[seen.length - 1] });
      expect(late).toHaveLength(1);
      expect(late[0].summary).toContain('late');
      spy.mockRestore();
    });

    it('tags each event with the session_id', () => {
      emit('Log.entryAdded', { entry: { level: 'info', text: 'hello' } });

      expect(recorder.getTimeline()[0].session_id).toBe('test-session');
    });

    // #262: "Load older events" — the beforeId branch.
    describe('beforeId (Load older events)', () => {
      it('returns the nearest `limit` events below the cursor, oldest first', () => {
        for (let i = 0; i < 10; i++) {
          emit('Log.entryAdded', { entry: { level: 'info', text: `msg-${i}` } });
        }
        const all = recorder.getTimeline({ limit: 100 });
        const cursor = all[7].id as number; // msg-7

        const older = recorder.getTimeline({ beforeId: cursor, limit: 3 });
        expect(older.map(r => r.summary)).toEqual([
          '[info] msg-4', '[info] msg-5', '[info] msg-6',
        ]);
      });

      it('never includes an event with id >= beforeId', () => {
        for (let i = 0; i < 5; i++) {
          emit('Log.entryAdded', { entry: { level: 'info', text: `msg-${i}` } });
        }
        const all = recorder.getTimeline({ limit: 100 });
        const cursor = all[2].id as number;

        const older = recorder.getTimeline({ beforeId: cursor, limit: 100 });
        expect(older.every(r => (r.id as number) < cursor)).toBe(true);
        expect(older.map(r => r.summary)).toEqual(['[info] msg-0', '[info] msg-1']);
      });

      it('returns an empty array when beforeId is already the oldest event', () => {
        emit('Log.entryAdded', { entry: { level: 'info', text: 'only' } });
        const [only] = recorder.getTimeline();
        expect(recorder.getTimeline({ beforeId: only.id as number })).toEqual([]);
      });

      it('pages 450 events backward via beforeId without loss or duplicates', () => {
        for (let i = 0; i < 450; i++) {
          emit('Log.entryAdded', { entry: { level: 'info', text: `msg-${i}` } });
        }
        const seen: number[] = [];
        let cursor = Infinity;
        for (;;) {
          const page = recorder.getTimeline({ beforeId: cursor, limit: 200 });
          if (page.length === 0) break;
          seen.unshift(...page.map(r => r.id as number));
          cursor = page[0].id as number;
        }
        expect(seen).toHaveLength(450);
        expect(new Set(seen).size).toBe(450);
        expect([...seen].sort((a, b) => a - b)).toEqual(seen);
      });
    });
  });

  describe('getOldestId', () => {
    it('returns null when nothing has been recorded', () => {
      expect(recorder.getOldestId()).toBeNull();
    });

    it('returns the id of the first recorded event', () => {
      emit('Log.entryAdded', { entry: { level: 'info', text: 'first' } });
      emit('Log.entryAdded', { entry: { level: 'info', text: 'second' } });
      const [first] = recorder.getTimeline();
      expect(recorder.getOldestId()).toBe(first.id);
    });

    it('advances once the ring buffer trims the oldest rows', () => {
      const { wc, emit: e } = makeMockWc();
      const rec = new SessionRecorder(wc, {
        sessionId: 'oldest-id-trim-session',
        dbDir: freshDbDir(),
        maxEventsPerSession: 50,
      });
      for (let i = 0; i < 100; i++) {
        e('Log.entryAdded', { entry: { level: 'info', text: `event-${i}` } });
      }
      const [oldestRemaining] = rec.getTimeline({ limit: 200 });
      expect(rec.getOldestId()).toBe(oldestRemaining.id);
      rec.destroy();
    });
  });

  // ── getAllNetworkRows ─────────────────────────────────────────────────────

  describe('getAllNetworkRows', () => {
    it('includes only network-* events, excluding console and log', () => {
      emit('Network.requestWillBeSent', {
        requestId: 'r1',
        request: { url: 'https://example.com', method: 'GET', headers: {} },
      });
      emit('Network.responseReceived', {
        requestId: 'r1',
        response: { status: 200, url: 'https://example.com', headers: {} },
      });
      emit('Log.entryAdded', { entry: { level: 'info', text: 'ignored' } });
      emit('Runtime.consoleAPICalled', { type: 'log', args: [] });

      const rows = recorder.getAllNetworkRows();
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.kind.startsWith('network-'))).toBe(true);
    });

    it('returns an empty array when there are no network events', () => {
      emit('Log.entryAdded', { entry: { level: 'error', text: 'an error' } });

      expect(recorder.getAllNetworkRows()).toHaveLength(0);
    });

    it('orders rows by timestamp ascending, unbounded by any limit', () => {
      const mockNow = jest.spyOn(Date, 'now');
      try {
        mockNow.mockReturnValue(3000);
        emit('Network.requestWillBeSent', {
          requestId: 'r1',
          request: { url: 'https://example.com/b', method: 'GET', headers: {} },
        });
        mockNow.mockReturnValue(1000);
        emit('Network.requestWillBeSent', {
          requestId: 'r2',
          request: { url: 'https://example.com/a', method: 'GET', headers: {} },
        });

        const rows = recorder.getAllNetworkRows();
        expect(rows[0].ts).toBe(1000);
        expect(rows[1].ts).toBe(3000);
      } finally {
        mockNow.mockRestore();
      }
    });
  });

  // ── destroy ────────────────────────────────────────────────────────────────

  describe('destroy', () => {
    it('detaches the CDP debugger', () => {
      const { wc } = makeMockWc();
      const rec = new SessionRecorder(wc, { sessionId: 'destroy-test', dbDir: freshDbDir() });
      rec.destroy();
      expect(wc.debugger.detach).toHaveBeenCalled();
    });
  });
});
