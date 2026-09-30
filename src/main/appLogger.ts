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
// L3: a fragment carrying key=value data (OAuth implicit flow's
// #access_token=…&id_token=…) is stripped too. A plain "#section" anchor or
// "#123" reference has no '=' and is left alone.
const FRAGMENT_RE = /#[^\s#]*=\S*/g;
const BEARER_RE = /\bBearer\s+\S+/gi;
// L3: `Basic <base64>` outside a recognised header name (the name/value pass
// below handles "Authorization: Basic …" itself). Requires a base64-looking
// run so plain prose like "Basic auth failed" isn't mangled.
const BASIC_RE = /\bBasic\s+[A-Za-z0-9+/]{8,}=*/gi;
// Finds each `name:` / `name=` (optionally `"name":`, as in a JSON dump) —
// the value itself is decided per match in stripSensitivePairs.
const PAIR_NAME_RE = /([A-Za-z0-9_.-]+)["']?\s*[:=]/g;
// L3: key names that aren't header names but still carry secrets.
const SENSITIVE_KEY_RE = /passw(?:or)?d|^pwd$|secret|token|api[-_]?key|credential|private[-_]?key|^auth$|authorization|cookie/i;

export function isSensitiveKey(name: string): boolean {
  return SENSITIVE_HEADERS.has(name.toLowerCase()) || SENSITIVE_KEY_RE.test(name);
}

function stripUrlQuery(text: string): string {
  return text.replace(QUERY_RE, (token) => `${token.slice(0, token.indexOf('?'))}?…`);
}

// L3: a sensitive name's value is redacted to the end of the line, not just
// its first word — "Authorization: Basic abc" or "Cookie: a=1; b=2" would
// otherwise leak everything after the first whitespace-free run.
function stripSensitivePairs(text: string): string {
  return text.split(/(\r?\n)/).map((line) => {
    PAIR_NAME_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PAIR_NAME_RE.exec(line))) {
      if (isSensitiveKey(m[1])) return `${line.slice(0, m.index)}${m[1]}: [REDACTED]`;
    }
    return line;
  }).join('');
}

/**
 * Strips URL query strings and key=value fragments, redacts `Bearer <token>`
 * / `Basic <base64>`, and redacts to end of line after any `name: value` /
 * `name=value` whose name is in SENSITIVE_HEADERS or looks like a secret
 * (password, secret, token, api_key, …).
 */
export function redact(text: string): string {
  if (typeof text !== 'string' || !text) return text;
  let out = stripUrlQuery(text);
  out = out.replace(FRAGMENT_RE, '#…');
  out = out.replace(BEARER_RE, 'Bearer [REDACTED]');
  out = out.replace(BASIC_RE, 'Basic [REDACTED]');
  out = stripSensitivePairs(out);
  return out;
}

const MAX_CTX_DEPTH = 6;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function redactValue(v: unknown, depth: number): unknown {
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v) || isPlainObject(v)) {
    if (depth >= MAX_CTX_DEPTH) return '[…]';
    if (Array.isArray(v)) return v.map((item) => redactValue(item, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, inner] of Object.entries(v)) {
      // L3: a secret-named key loses its whole value (string, object, array),
      // not just whatever the string pass would catch; booleans/null/numbers
      // (e.g. hasToken: true) carry nothing worth hiding.
      out[k] = isSensitiveKey(k) && inner !== null && typeof inner !== 'boolean' && typeof inner !== 'number'
        ? '[REDACTED]'
        : redactValue(inner, depth + 1);
    }
    return out;
  }
  return v;
}

// L3: recurses into nested objects/arrays (depth-capped, which also stops
// a cyclic ctx), not only top-level strings.
export function redactCtx(ctx?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!ctx) return ctx;
  return redactValue(ctx, 0) as Record<string, unknown>;
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
  state.debugLogStore?.insert({ ts, message: trimmedMessage, level, source, sessionId, ctx: redactedCtx });

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
