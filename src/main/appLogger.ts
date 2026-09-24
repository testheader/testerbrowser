import { app } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AppErrorEntry, AppLogLevel, writeAppErrors } from './errorLog';
import { DebugLogStore } from './debugLogStore';
import { SENSITIVE_HEADERS } from './recorder';

/**
 * Central app-wide logger (#225). Every log[level]() call fans out to three
 * sinks: the in-memory ring + app-errors.json (durable, crash recovery —
 * see errorLog.ts), DebugLogStore (durable, message/level only until #228
 * adds source/session/ctx columns), and userData/logs/main.log (a plain
 * text file a user can open and attach to a bug report). recordAppError()
 * in index.ts is a thin wrapper over log[level]('app', message) so every
 * existing call site keeps working unchanged.
 */

export interface AppLogEntry {
  ts: number;
  level: AppLogLevel;
  source: string;
  message: string;
  sessionId?: string;
  ctx?: Record<string, unknown>;
}

const MAX_RING = 20;
const MAX_LOG_BYTES = 1024 * 1024;
const KEEP_ROTATED = 4;

// Any whitespace-free run containing a '?' — not just a full https:// URL —
// so a bare query string logged on its own (e.g. an e2e marker suffixed
// with "?secret=1") gets the same treatment as one attached to a full URL.
const QUERY_RE = /\S*\?\S*/g;
const BEARER_RE = /\bBearer\s+\S+/gi;
// name: value / name=value, matching a colon or equals separator. The value
// alternation prefers a quoted string, else a single non-whitespace run —
// good enough for header-dump-shaped log lines without swallowing the rest
// of an unrelated sentence.
const PAIR_RE = /([A-Za-z0-9-]+)\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/g;

function stripUrlQuery(text: string): string {
  return text.replace(QUERY_RE, (token) => `${token.slice(0, token.indexOf('?'))}?…`);
}

function stripSensitivePairs(text: string): string {
  return text.replace(PAIR_RE, (match, name: string) =>
    SENSITIVE_HEADERS.has(name.toLowerCase()) ? `${name}: [REDACTED]` : match
  );
}

/**
 * Strips URL query strings/fragments, redacts `Bearer <token>` and any
 * `name: value`/`name=value` pair whose name is in SENSITIVE_HEADERS.
 * Bearer runs before the name/value pass so "Authorization: Bearer <tok>"
 * can't leave a token fragment behind — the pair pass's value capture is a
 * single whitespace-free run, so it alone would only swallow the literal
 * word "Bearer" and leave the token after it untouched.
 */
export function redact(text: string): string {
  if (typeof text !== 'string' || !text) return text;
  let out = stripUrlQuery(text);
  out = out.replace(BEARER_RE, 'Bearer [REDACTED]');
  out = stripSensitivePairs(out);
  return out;
}

export function redactCtx(ctx?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!ctx) return ctx;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx)) {
    out[k] = typeof v === 'string' ? redact(v) : v;
  }
  return out;
}

export function formatLine(entry: AppLogEntry): string {
  const ts = new Date(entry.ts).toISOString();
  const level = entry.level.toUpperCase();
  const message = entry.message.replace(/\n/g, '\\n');
  let line = `${ts} ${level} [${entry.source}] ${message}`;
  if (entry.ctx && Object.keys(entry.ctx).length > 0) {
    line += ` ${JSON.stringify(entry.ctx)}`;
  }
  return line;
}

/**
 * Rotates filePath if it's at or above maxBytes: main.log.(keep-1) -> .keep,
 * … , main.log.1 -> .2, main.log -> main.log.1. Any previous main.log.<keep>
 * is silently discarded by the final rename overwriting it, keeping at most
 * keep+1 files (main.log + .1.._.keep_) on disk at all times. A no-op if
 * filePath doesn't exist yet or is still under the size cap.
 */
export function rotateIfNeeded(filePath: string, maxBytes: number, keep: number): void {
  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return;
  }
  if (size < maxBytes) return;
  for (let i = keep - 1; i >= 1; i--) {
    const src = `${filePath}.${i}`;
    try {
      if (fs.existsSync(src)) fs.renameSync(src, `${filePath}.${i + 1}`);
    } catch { /* best-effort rotation — a stuck old file never blocks new writes */ }
  }
  try {
    fs.renameSync(filePath, `${filePath}.1`);
  } catch { /* best-effort — see above */ }
}

interface LoggerState {
  dir: string;
  debugMode: () => boolean;
  debugLogStore: DebugLogStore | null;
  appErrorsPath: string;
}

let state: LoggerState = { dir: '', debugMode: () => false, debugLogStore: null, appErrorsPath: '' };
let ring: AppErrorEntry[] = [];

function mainLogPath(): string {
  return path.join(state.dir, 'main.log');
}

function appendLine(line: string): void {
  if (!state.dir) return;
  try {
    const filePath = mainLogPath();
    rotateIfNeeded(filePath, MAX_LOG_BYTES, KEEP_ROTATED);
    fs.appendFileSync(filePath, line + '\n');
  } catch { /* a logging failure must never throw into the caller */ }
}

/**
 * Wires the logger up to its sinks. Calls made before this runs (there are
 * none today — nothing calls log.*() until after whenReady()) still update
 * the in-memory ring, just not app-errors.json/DebugLogStore/main.log,
 * since state.appErrorsPath/debugLogStore/dir all start out unset.
 */
export function initLogger(opts: {
  dir: string;
  debugMode: () => boolean;
  debugLogStore: DebugLogStore | null;
  appErrorsPath: string;
}): void {
  state = { ...opts };
  try { fs.mkdirSync(state.dir, { recursive: true }); } catch { /* appendLine's own try/catch covers the write itself */ }
  appendLine(
    `=== TesterBrowser ${app.getVersion()} | Electron ${process.versions.electron} | ` +
    `${process.platform} ${os.release()} | pid ${process.pid} ===`
  );
}

function writeEntry(level: AppLogLevel, source: string, message: string, ctx?: Record<string, unknown>): void {
  if (level === 'debug' && !state.debugMode()) return;

  const redactedCtx = redactCtx(ctx);
  const sessionId = typeof redactedCtx?.sessionId === 'string' ? redactedCtx.sessionId : undefined;
  const trimmedMessage = redact(String(message)).slice(0, 2000);
  const ts = Date.now();

  ring.push({ ts, message: trimmedMessage, level });
  if (ring.length > MAX_RING) ring.shift();
  if (state.appErrorsPath) writeAppErrors(state.appErrorsPath, ring);
  state.debugLogStore?.insert({ ts, message: trimmedMessage, level });

  appendLine(formatLine({ ts, level, source, message: trimmedMessage, sessionId, ctx: redactedCtx }));
}

export const log = {
  error: (source: string, message: string, ctx?: Record<string, unknown>) => writeEntry('error', source, message, ctx),
  warn:  (source: string, message: string, ctx?: Record<string, unknown>) => writeEntry('warn', source, message, ctx),
  info:  (source: string, message: string, ctx?: Record<string, unknown>) => writeEntry('info', source, message, ctx),
  debug: (source: string, message: string, ctx?: Record<string, unknown>) => writeEntry('debug', source, message, ctx),
};

// #227: lets SessionManager (and anything else taking a logger by
// injection) accept exactly this shape without importing the whole module.
export type AppLog = typeof log;

/** The same ring recordAppError() used to keep in index.ts, now owned here. */
export function getRecentErrors(): AppErrorEntry[] {
  return ring.slice();
}
