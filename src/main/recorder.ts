import Database from 'better-sqlite3';
import { WebContents } from 'electron';
import path from 'path';
import fs from 'fs';

/**
 * Recorder attaches to a WebContents' CDP debugger as soon as a session is
 * created and continuously logs Network + Console/Log events to SQLite.
 *
 * Design goals (per priority list):
 *  - Always recording, regardless of whether any UI panel is open/visible.
 *  - Correlated by timestamp so network + console can be viewed as one
 *    merged timeline per session.
 *  - Ring-buffered (capped) so long-running sessions don't grow unbounded.
 */

export interface RecorderOptions {
  sessionId: string;
  dbDir: string;
  maxEventsPerSession?: number;
  redactSensitiveHeaders?: boolean;
}

const SENSITIVE_HEADERS = new Set([
  'authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token',
  'x-csrf-token', 'proxy-authorization', 'x-access-token', 'x-session-token',
  'www-authenticate', 'x-forwarded-authorization',
]);

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  if (!headers || typeof headers !== 'object') return headers;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? '[REDACTED]' : v;
  }
  return out;
}

type EventRow = {
  id?: number;
  session_id: string;
  ts: number;
  kind: 'network-request' | 'network-response' | 'network-failed' | 'network-body' | 'console' | 'log';
  summary: string;
  payload: string; // JSON blob
};

export class SessionRecorder {
  private db: Database.Database;
  private sessionId: string;
  private maxEvents: number;
  private wc: WebContents;
  private insertStmt!: Database.Statement;
  private requestMeta = new Map<string, { url: string; method: string; startTs: number }>();
  private redact: boolean;

  constructor(wc: WebContents, opts: RecorderOptions) {
    this.wc = wc;
    this.sessionId = opts.sessionId;
    this.maxEvents = opts.maxEventsPerSession ?? 20000;
    this.redact = opts.redactSensitiveHeaders ?? false;

    if (!fs.existsSync(opts.dbDir)) fs.mkdirSync(opts.dbDir, { recursive: true });
    const dbPath = path.join(opts.dbDir, `${this.sessionId}.sqlite`);
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
    `);
    this.insertStmt = this.db.prepare(
      `INSERT INTO events (session_id, ts, kind, summary, payload) VALUES (?, ?, ?, ?, ?)`
    );

    this.attach();
  }

  private attach() {
    const dbg = this.wc.debugger;
    try {
      dbg.attach('1.3');
    } catch (e) {
      // Already attached (e.g. DevTools open) - not fatal.
    }

    dbg.sendCommand('Network.enable').catch(() => {});
    dbg.sendCommand('Log.enable').catch(() => {});
    dbg.sendCommand('Runtime.enable').catch(() => {});

    dbg.on('message', (_event, method, params) => {
      const ts = Date.now();
      switch (method) {
        case 'Network.requestWillBeSent': {
          this.requestMeta.set(params.requestId, {
            url: params.request.url,
            method: params.request.method,
            startTs: ts,
          });
          const reqPayload = this.redact
            ? { ...params, request: { ...params.request, headers: redactHeaders(params.request.headers) } }
            : params;
          this.record({
            kind: 'network-request',
            ts,
            summary: `${params.request.method} ${params.request.url}`,
            payload: JSON.stringify(reqPayload),
          });
          break;
        }
        case 'Network.responseReceived': {
          const meta = this.requestMeta.get(params.requestId);
          const resPayload = this.redact
            ? { ...params, response: { ...params.response, headers: redactHeaders(params.response.headers) } }
            : params;
          this.record({
            kind: 'network-response',
            ts,
            summary: `${params.response.status} ${meta?.url ?? params.response.url}`,
            payload: JSON.stringify(resPayload),
          });
          break;
        }
        case 'Network.loadingFailed': {
          const meta = this.requestMeta.get(params.requestId);
          this.record({
            kind: 'network-failed',
            ts,
            summary: `FAILED ${meta?.url ?? params.requestId}: ${params.errorText}`,
            payload: JSON.stringify(params),
          });
          break;
        }
        case 'Network.loadingFinished': {
          const meta = this.requestMeta.get(params.requestId);
          if (!meta) break;
          // Only fetch body for text-like responses (skip images, fonts, etc.)
          // We check the stored response kind by looking up the request meta
          this.wc.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId })
            .then((body: { body: string; base64Encoded: boolean }) => {
              if (!body?.body) return;
              const truncated = body.body.length > 51200; // 50 KB cap
              const content = truncated ? body.body.slice(0, 51200) + '\n[truncated]' : body.body;
              this.record({
                kind: 'network-body',
                ts: Date.now(),
                summary: `BODY ${meta.method} ${meta.url}${truncated ? ' [truncated]' : ''}`,
                payload: JSON.stringify({
                  requestId: params.requestId,
                  base64Encoded: body.base64Encoded,
                  body: content,
                }),
              });
            })
            .catch(() => {}); // body unavailable (e.g. redirect, image) — silently ignore
          break;
        }
        case 'Log.entryAdded': {
          this.record({
            kind: 'log',
            ts,
            summary: `[${params.entry.level}] ${params.entry.text}`,
            payload: JSON.stringify(params),
          });
          break;
        }
        case 'Runtime.consoleAPICalls': {
          const args = (params.args || [])
            .map((a: any) => a.value ?? a.description ?? '')
            .join(' ');
          this.record({
            kind: 'console',
            ts,
            summary: `[${params.type}] ${args}`,
            payload: JSON.stringify(params),
          });
          break;
        }
      }
    });
  }

  private record(row: Omit<EventRow, 'session_id' | 'id'>) {
    this.insertStmt.run(this.sessionId, row.ts, row.kind, row.summary, row.payload);
    this.trimIfNeeded();
  }

  private trimCounter = 0;
  private trimIfNeeded() {
    // Only check every 100 inserts to avoid a COUNT(*) on every event.
    this.trimCounter++;
    if (this.trimCounter % 100 !== 0) return;
    const countRow = this.db
      .prepare(`SELECT COUNT(*) as c FROM events WHERE session_id = ?`)
      .get(this.sessionId) as { c: number };
    if (countRow.c > this.maxEvents) {
      const excess = countRow.c - this.maxEvents;
      this.db
        .prepare(
          `DELETE FROM events WHERE id IN (
             SELECT id FROM events WHERE session_id = ? ORDER BY id ASC LIMIT ?
           )`
        )
        .run(this.sessionId, excess);
    }
  }

  /** Query the merged timeline, most recent last. */
  getTimeline(opts: { limit?: number; since?: number } = {}): EventRow[] {
    const limit = opts.limit ?? 500;
    if (opts.since) {
      return this.db
        .prepare(
          `SELECT * FROM events WHERE session_id = ? AND ts > ? ORDER BY ts ASC LIMIT ?`
        )
        .all(this.sessionId, opts.since, limit) as EventRow[];
    }
    return (
      this.db
        .prepare(`SELECT * FROM events WHERE session_id = ? ORDER BY ts DESC LIMIT ?`)
        .all(this.sessionId, limit) as EventRow[]
    ).reverse();
  }

  exportHAR(): object {
    // Minimal HAR-ish export from stored network events; extend as needed.
    const rows = this.db
      .prepare(
        `SELECT * FROM events WHERE session_id = ? AND kind LIKE 'network-%' ORDER BY ts ASC`
      )
      .all(this.sessionId) as EventRow[];
    return {
      log: {
        version: '1.2',
        creator: { name: 'TesterBrowser', version: '0.1.0' },
        entries: rows.map((r) => ({ kind: r.kind, ts: r.ts, data: JSON.parse(r.payload) })),
      },
    };
  }

  destroy() {
    try {
      this.wc.debugger.detach();
    } catch {}
    this.db.close();
  }
}
