import Database from 'better-sqlite3';
import { WebContents } from 'electron';
import path from 'path';
import fs from 'fs';
import { log } from './appLogger';
import { isSafeId } from './pathSafety';

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
  // #248: evaluated per event (not read once at construction), so toggling
  // "Redact sensitive headers" in Settings changes the very next recorded
  // request/response in every already-open tab, not just new ones.
  getRedact?: () => boolean;
  // #229: temp (non-persistent) tabs record in-memory only — no traffic,
  // including bodies, ever touches disk for them.
  inMemory?: boolean;
}

export const SENSITIVE_HEADERS = new Set([
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

export type EventRow = {
  id?: number;
  session_id: string;
  ts: number;
  kind: 'network-request' | 'network-response' | 'network-failed' | 'network-body' | 'console' | 'log' | 'exception';
  summary: string;
  payload: string; // JSON blob
};

export class SessionRecorder {
  private db: Database.Database;
  private sessionId: string;
  private maxEvents: number;
  private wc: WebContents;
  private insertStmt!: Database.Statement;
  private countStmt!: Database.Statement;
  private trimStmt!: Database.Statement;
  private requestMeta = new Map<string, { url: string; method: string; startTs: number }>();
  private requestTags = new Map<string, { mockRuleId?: string; resilienceRuleId?: string; resilienceType?: string }>();
  // Row id of the still-open network-request event for a requestId, so a tag
  // that arrives (Fetch.requestPaused) after the request was already recorded
  // can be stamped onto that same row instead of only the eventual response.
  private requestRowId = new Map<string, number>();
  // Row id of the still-open network-response event for a requestId, so a
  // Network.responseReceivedExtraInfo that arrives after the response was
  // already recorded can patch that same row.
  private responseRowId = new Map<string, number>();
  // Network.requestWillBeSentExtraInfo / Network.responseReceivedExtraInfo
  // can each arrive before their corresponding requestWillBeSent/
  // responseReceived event — buffer them per requestId until the row exists.
  // Capped so a request that never completes can't leak forever.
  private static readonly MAX_PENDING_EXTRA_INFO = 500;
  private pendingRequestExtraInfo = new Map<string, { headers: Record<string, string>; associatedCookies?: unknown }>();
  private pendingResponseExtraInfo = new Map<string, { headers: Record<string, string>; blockedCookies?: unknown }>();
  private updatePayloadStmt!: Database.Statement;
  private getRedact: () => boolean;
  // #229: set the first time trimIfNeeded() evicts rows for this session —
  // null until then. Exposed via getStatus() for the recording:status IPC
  // and the timeline's eviction banner.
  evictedAt: number | null = null;
  evictedCount = 0;

  constructor(wc: WebContents, opts: RecorderOptions) {
    this.wc = wc;
    this.sessionId = opts.sessionId;
    this.maxEvents = opts.maxEventsPerSession ?? 20000;
    this.getRedact = opts.getRedact ?? (() => false);

    // L5: the id becomes a filename — refuse anything that could escape dbDir.
    if (!opts.inMemory && !isSafeId(this.sessionId)) throw new Error('Invalid session id for recorder database');
    const dbPath = opts.inMemory ? ':memory:' : path.join(opts.dbDir, `${this.sessionId}.sqlite`);
    if (!opts.inMemory) {
      if (!fs.existsSync(opts.dbDir)) fs.mkdirSync(opts.dbDir, { recursive: true });
    }
    this.db = new Database(dbPath);
    if (!opts.inMemory) this.db.pragma('journal_mode = WAL');
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
    this.countStmt = this.db.prepare(
      `SELECT COUNT(*) as c FROM events WHERE session_id = ?`
    );
    this.trimStmt = this.db.prepare(
      `DELETE FROM events WHERE id IN (SELECT id FROM events WHERE session_id = ? ORDER BY id ASC LIMIT ?)`
    );
    this.updatePayloadStmt = this.db.prepare(
      `UPDATE events SET payload = ? WHERE id = ?`
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
    dbg.sendCommand('Runtime.enable').catch(() => {}); // also needed for exceptionThrown

    dbg.on('message', (_event, method, params) => {
      const ts = Date.now();
      switch (method) {
        case 'Network.requestWillBeSent': {
          this.requestMeta.set(params.requestId, {
            url: params.request.url,
            method: params.request.method,
            startTs: ts,
          });
          const reqPayload = this.getRedact()
            ? { ...params, request: { ...params.request, headers: redactHeaders(params.request.headers) } }
            : params;
          const tag = this.requestTags.get(params.requestId);
          const pendingExtra = this.pendingRequestExtraInfo.get(params.requestId);
          this.pendingRequestExtraInfo.delete(params.requestId);
          const extra = pendingExtra
            ? {
                extraInfoHeaders: this.getRedact() ? redactHeaders(pendingExtra.headers) : pendingExtra.headers,
                associatedCookies: pendingExtra.associatedCookies,
              }
            : undefined;
          const rowId = this.record({
            kind: 'network-request',
            ts,
            summary: `${params.request.method} ${params.request.url}`,
            payload: JSON.stringify({ ...reqPayload, ...tag, ...extra }),
          });
          this.requestRowId.set(params.requestId, rowId);
          break;
        }
        case 'Network.requestWillBeSentExtraInfo': {
          const rowId = this.requestRowId.get(params.requestId);
          const extra = {
            extraInfoHeaders: this.getRedact() ? redactHeaders(params.headers) : params.headers,
            associatedCookies: params.associatedCookies,
          };
          if (rowId !== undefined) {
            this.patchPayload(rowId, extra);
          } else {
            this.setPending(this.pendingRequestExtraInfo, params.requestId, {
              headers: params.headers,
              associatedCookies: params.associatedCookies,
            });
          }
          break;
        }
        case 'Network.responseReceived': {
          const meta = this.requestMeta.get(params.requestId);
          const tag  = this.requestTags.get(params.requestId);
          const durationMs = meta ? ts - meta.startTs : undefined;
          const resPayload = this.getRedact()
            ? { ...params, response: { ...params.response, headers: redactHeaders(params.response.headers) } }
            : params;
          const pendingExtra = this.pendingResponseExtraInfo.get(params.requestId);
          this.pendingResponseExtraInfo.delete(params.requestId);
          const extra = pendingExtra
            ? {
                extraInfoHeaders: this.getRedact() ? redactHeaders(pendingExtra.headers) : pendingExtra.headers,
                blockedCookies: pendingExtra.blockedCookies,
              }
            : undefined;
          const rowId = this.record({
            kind: 'network-response',
            ts,
            summary: `${params.response.status} ${meta?.url ?? params.response.url}`,
            payload: JSON.stringify({ ...resPayload, ...tag, durationMs, ...extra }),
          });
          this.responseRowId.set(params.requestId, rowId);
          break;
        }
        case 'Network.responseReceivedExtraInfo': {
          const rowId = this.responseRowId.get(params.requestId);
          const extra = {
            extraInfoHeaders: this.getRedact() ? redactHeaders(params.headers) : params.headers,
            blockedCookies: params.blockedCookies,
          };
          if (rowId !== undefined) {
            this.patchPayload(rowId, extra);
          } else {
            this.setPending(this.pendingResponseExtraInfo, params.requestId, {
              headers: params.headers,
              blockedCookies: params.blockedCookies,
            });
          }
          break;
        }
        case 'Network.loadingFailed': {
          const meta = this.requestMeta.get(params.requestId);
          const tag  = this.requestTags.get(params.requestId);
          this.record({
            kind: 'network-failed',
            ts,
            summary: `FAILED ${meta?.url ?? params.requestId}: ${params.errorText}`,
            payload: JSON.stringify(tag ? { ...params, ...tag } : params),
          });
          this.requestTags.delete(params.requestId);
          this.requestRowId.delete(params.requestId);
          this.responseRowId.delete(params.requestId);
          this.pendingRequestExtraInfo.delete(params.requestId);
          this.pendingResponseExtraInfo.delete(params.requestId);
          break;
        }
        case 'Network.loadingFinished': {
          const meta = this.requestMeta.get(params.requestId);
          this.requestTags.delete(params.requestId);
          this.requestRowId.delete(params.requestId);
          this.responseRowId.delete(params.requestId);
          this.pendingRequestExtraInfo.delete(params.requestId);
          this.pendingResponseExtraInfo.delete(params.requestId);
          if (!meta) break;
          // Only fetch body for text-like responses (skip images, fonts, etc.)
          // We check the stored response kind by looking up the request meta
          this.wc.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId })
            .then((body: { body: string; base64Encoded: boolean }) => {
              if (!body?.body) return;
              const overCap = body.body.length > 51200; // 50 KB cap
              let payload: Record<string, unknown>;
              let summarySuffix = '';
              if (body.base64Encoded && overCap) {
                // A truncated base64 string is no longer valid base64 — storing
                // it would corrupt the body (e.g. break an image preview), so
                // binary bodies over the cap are omitted entirely instead.
                payload = { requestId: params.requestId, base64Encoded: true, omitted: true, size: body.body.length };
                summarySuffix = ' [omitted]';
              } else if (overCap) {
                payload = {
                  requestId: params.requestId,
                  base64Encoded: false,
                  truncated: true,
                  body: body.body.slice(0, 51200) + '\n[truncated]',
                };
                summarySuffix = ' [truncated]';
              } else {
                payload = { requestId: params.requestId, base64Encoded: body.base64Encoded, body: body.body };
              }
              this.record({
                kind: 'network-body',
                ts: Date.now(),
                summary: `BODY ${meta.method} ${meta.url}${summarySuffix}`,
                payload: JSON.stringify(payload),
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
        case 'Runtime.consoleAPICalled': {
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
        case 'Runtime.exceptionThrown': {
          const details = params.exceptionDetails;
          const stack = details?.exception?.description;
          this.record({
            kind: 'exception',
            ts,
            summary: stack ? `${details.text}: ${stack}` : (details?.text ?? 'Uncaught exception'),
            payload: JSON.stringify(params),
          });
          break;
        }
      }
    });
  }

  /** Records that a request was intercepted by a Mock/Resilience rule, so the
   *  eventual Network.responseReceived/loadingFailed record carries the tag.
   *  If the request event was already recorded (the common case — Fetch's
   *  requestPaused arrives after Network's requestWillBeSent), patch the tag
   *  onto that row too, so the flag shows up on the request, not just the
   *  eventual response/failure. */
  tagRequest(requestId: string, tag: { mockRuleId?: string; resilienceRuleId?: string; resilienceType?: string }) {
    this.requestTags.set(requestId, tag);
    const rowId = this.requestRowId.get(requestId);
    if (rowId === undefined) return;
    this.patchPayload(rowId, tag);
  }

  /** Merges `extra` onto an already-recorded row's JSON payload. Used both by
   *  tagRequest() and by the ExtraInfo handlers above to patch a row that was
   *  recorded before the patching data arrived. */
  private patchPayload(rowId: number, extra: Record<string, unknown>) {
    const row = this.db.prepare(`SELECT payload FROM events WHERE id = ?`).get(rowId) as { payload: string } | undefined;
    if (!row) return;
    try {
      const payload = { ...JSON.parse(row.payload), ...extra };
      this.updatePayloadStmt.run(JSON.stringify(payload), rowId);
    } catch {}
  }

  /** Inserts into a pending-ExtraInfo buffer, evicting the oldest entry once
   *  the cap is exceeded so a request that never completes can't leak. */
  private setPending<V>(map: Map<string, V>, requestId: string, value: V) {
    map.set(requestId, value);
    if (map.size > SessionRecorder.MAX_PENDING_EXTRA_INFO) {
      const oldestKey = map.keys().next().value;
      if (oldestKey !== undefined) map.delete(oldestKey);
    }
  }

  private record(row: Omit<EventRow, 'session_id' | 'id'>): number {
    const info = this.insertStmt.run(this.sessionId, row.ts, row.kind, row.summary, row.payload);
    this.trimIfNeeded();
    return info.lastInsertRowid as number;
  }

  private trimCounter = 0;
  private trimIfNeeded() {
    // Only check every 100 inserts to avoid a COUNT(*) on every event.
    this.trimCounter++;
    if (this.trimCounter % 100 !== 0) return;
    const countRow = this.countStmt.get(this.sessionId) as { c: number };
    if (countRow.c > this.maxEvents) {
      const info = this.trimStmt.run(this.sessionId, countRow.c - this.maxEvents);
      if (info.changes > 0) {
        if (this.evictedAt === null) {
          this.evictedAt = Date.now();
          log.info('recorder', `Recorder cap (${this.maxEvents}) reached — evicting oldest events`, { sessionId: this.sessionId });
        }
        this.evictedCount += info.changes;
      }
    }
  }

  /** For the recording:status IPC / the timeline's eviction banner. */
  getStatus(): { cap: number; evictedAt: number | null; evictedCount: number } {
    return { cap: this.maxEvents, evictedAt: this.evictedAt, evictedCount: this.evictedCount };
  }

  /** Query the merged timeline, most recent last. */
  getTimeline(opts: { limit?: number; since?: number; sinceId?: number; beforeId?: number } = {}): EventRow[] {
    const limit = opts.limit ?? 500;
    // id cursor: ids are unique and monotonic, so events sharing a
    // millisecond are never skipped or reordered.
    if (typeof opts.sinceId === 'number') {
      return this.db
        .prepare(
          `SELECT * FROM events WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?`
        )
        .all(this.sessionId, opts.sinceId, limit) as EventRow[];
    }
    // #262: "Load older events" — the `limit` rows immediately *before* the
    // cursor (nearest first via DESC, then reversed to the same
    // oldest-first order every other branch returns), not the absolute
    // oldest `limit` rows in the whole session.
    if (typeof opts.beforeId === 'number') {
      return (
        this.db
          .prepare(`SELECT * FROM events WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?`)
          .all(this.sessionId, opts.beforeId, limit) as EventRow[]
      ).reverse();
    }
    if (opts.since) {
      return this.db
        .prepare(
          `SELECT * FROM events WHERE session_id = ? AND ts > ? ORDER BY ts ASC, id ASC LIMIT ?`
        )
        .all(this.sessionId, opts.since, limit) as EventRow[];
    }
    return (
      this.db
        .prepare(`SELECT * FROM events WHERE session_id = ? ORDER BY id DESC LIMIT ?`)
        .all(this.sessionId, limit) as EventRow[]
    ).reverse();
  }

  /** The lowest id currently stored for this session (null if empty) — lets
   *  the renderer tell whether "Load older events" has anything left to
   *  fetch without guessing from an empty page result. */
  getOldestId(): number | null {
    const row = this.db
      .prepare(`SELECT MIN(id) as id FROM events WHERE session_id = ?`)
      .get(this.sessionId) as { id: number | null };
    return row.id;
  }

  /** Every stored network-* row for this session, unbounded by getTimeline()'s
   *  limit — the HAR builder (har.ts) needs the full history, not just the
   *  window currently loaded into the renderer's timeline. */
  getAllNetworkRows(): EventRow[] {
    return this.db
      .prepare(`SELECT * FROM events WHERE session_id = ? AND kind LIKE 'network-%' ORDER BY ts ASC, id ASC`)
      .all(this.sessionId) as EventRow[];
  }

  /** Every stored console/log/exception row for this session, unbounded by
   *  getTimeline()'s limit and its all-kinds cap — #245's "Console errors"
   *  bug-report attachment needs the full console-error history, not just
   *  whatever survived inside the most recent 500 events across every kind. */
  getConsoleErrorRows(): EventRow[] {
    return this.db
      .prepare(`SELECT * FROM events WHERE session_id = ? AND kind IN ('console','log','exception') ORDER BY ts ASC, id ASC`)
      .all(this.sessionId) as EventRow[];
  }

  destroy() {
    try {
      this.wc.debugger.detach();
    } catch {}
    this.db.close();
  }
}
