import os from 'os';
import { SessionRecorder } from '../recorder';

// better-sqlite3 is compiled against Electron's ABI via electron-rebuild, which
// may differ from Jest's Node runtime. Mock it with a faithful in-memory store
// so tests are fast, hermetic, and ABI-independent.
jest.mock('better-sqlite3', () => {
  return jest.fn().mockImplementation(() => {
    type Row = { id: number; session_id: string; ts: number; kind: string; summary: string; payload: string };
    const rows: Row[] = [];
    let nextId = 1;

    const makeStmt = (sql: string) => {
      if (/INSERT/.test(sql)) {
        return {
          run: jest.fn((session_id: string, ts: number, kind: string, summary: string, payload: string) => {
            rows.push({ id: nextId++, session_id, ts, kind, summary, payload });
          }),
        };
      }
      if (/COUNT\(\*\)/.test(sql)) {
        return {
          get: jest.fn((session_id: string) => ({
            c: rows.filter(r => r.session_id === session_id).length,
          })),
        };
      }
      if (/DELETE/.test(sql)) {
        return {
          run: jest.fn((session_id: string, limit: number) => {
            const toDelete = rows
              .filter(r => r.session_id === session_id)
              .sort((a, b) => a.id - b.id)
              .slice(0, limit)
              .map(r => r.id);
            for (const id of toDelete) {
              const i = rows.findIndex(r => r.id === id);
              if (i >= 0) rows.splice(i, 1);
            }
          }),
        };
      }
      if (/ts > \?/.test(sql)) {
        return {
          all: jest.fn((session_id: string, since: number, limit: number) =>
            rows
              .filter(r => r.session_id === session_id && r.ts > since)
              .sort((a, b) => a.ts - b.ts)
              .slice(0, limit)
          ),
        };
      }
      if (/ORDER BY ts DESC/.test(sql)) {
        return {
          all: jest.fn((session_id: string, limit: number) =>
            rows
              .filter(r => r.session_id === session_id)
              .sort((a, b) => b.ts - a.ts)
              .slice(0, limit)
          ),
        };
      }
      if (/kind LIKE/.test(sql)) {
        return {
          all: jest.fn((session_id: string) =>
            rows
              .filter(r => r.session_id === session_id && r.kind.startsWith('network-'))
              .sort((a, b) => a.ts - b.ts)
          ),
        };
      }
      return { run: jest.fn(), get: jest.fn(() => null), all: jest.fn(() => []) };
    };

    return {
      pragma: jest.fn(),
      exec: jest.fn(),
      prepare: jest.fn((sql: string) => makeStmt(sql)),
      close: jest.fn(),
    };
  });
});

function makeMockWc() {
  let messageListener: ((e: null, method: string, params: unknown) => void) | null = null;
  const debugger_ = {
    attach: jest.fn(),
    sendCommand: jest.fn().mockResolvedValue({ body: '', base64Encoded: false }),
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

describe('SessionRecorder', () => {
  let recorder: SessionRecorder;
  let emit: (method: string, params: unknown) => void;

  beforeEach(() => {
    const mock = makeMockWc();
    emit = mock.emit;
    recorder = new SessionRecorder(mock.wc, { sessionId: 'test-session', dbDir: os.tmpdir() });
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
        dbDir: os.tmpdir(),
        redactSensitiveHeaders: true,
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
        dbDir: os.tmpdir(),
        redactSensitiveHeaders: true,
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
  });

  // ── Ring buffer ────────────────────────────────────────────────────────────

  describe('ring buffer', () => {
    it('trims oldest events once the 100th insert exceeds the cap', () => {
      const { wc, emit: e } = makeMockWc();
      const rec = new SessionRecorder(wc, {
        sessionId: 'trim-session',
        dbDir: os.tmpdir(),
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
        dbDir: os.tmpdir(),
        maxEventsPerSession: 5,
      });

      for (let i = 0; i < 99; i++) {
        e('Log.entryAdded', { entry: { level: 'info', text: `event-${i}` } });
      }

      // trimCounter=99, never hit a multiple of 100 yet
      expect(rec.getTimeline({ limit: 200 })).toHaveLength(99);

      rec.destroy();
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

    it('tags each event with the session_id', () => {
      emit('Log.entryAdded', { entry: { level: 'info', text: 'hello' } });

      expect(recorder.getTimeline()[0].session_id).toBe('test-session');
    });
  });

  // ── exportHAR ─────────────────────────────────────────────────────────────

  describe('exportHAR', () => {
    it('returns a valid HAR skeleton', () => {
      const har = recorder.exportHAR() as any;
      expect(har.log.version).toBe('1.2');
      expect(har.log.creator.name).toBe('TesterBrowser');
      expect(Array.isArray(har.log.entries)).toBe(true);
    });

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

      const har = recorder.exportHAR() as any;
      expect(har.log.entries).toHaveLength(2);
      expect(har.log.entries.every((e: any) => (e.kind as string).startsWith('network-'))).toBe(true);
    });

    it('returns an empty entries array when there are no network events', () => {
      emit('Log.entryAdded', { entry: { level: 'error', text: 'an error' } });

      expect((recorder.exportHAR() as any).log.entries).toHaveLength(0);
    });

    it('orders entries by timestamp ascending', () => {
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

        const { entries } = (recorder.exportHAR() as any).log;
        expect(entries[0].ts).toBe(1000);
        expect(entries[1].ts).toBe(3000);
      } finally {
        mockNow.mockRestore();
      }
    });
  });

  // ── destroy ────────────────────────────────────────────────────────────────

  describe('destroy', () => {
    it('detaches the CDP debugger', () => {
      const { wc } = makeMockWc();
      const rec = new SessionRecorder(wc, { sessionId: 'destroy-test', dbDir: os.tmpdir() });
      rec.destroy();
      expect(wc.debugger.detach).toHaveBeenCalled();
    });
  });
});
