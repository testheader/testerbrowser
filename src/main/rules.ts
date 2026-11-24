import { matchesGlob } from './urlGlob';

/**
 * The unified Rules model (#370): Mock, Resilience and Rewrite used to be three
 * separate features that all did "match a request, then do something to it".
 * A rule is now `match` (method + URL glob + probability + optional delay) plus
 * one `action`. Rules live in one ordered list per session partition and the
 * first enabled match whose probability roll succeeds wins — always one winner.
 *
 * Everything here is pure (no Electron, no CDP) so it is unit-testable; the
 * storage lives in rulesManager.ts and the Fetch.requestPaused dispatch stays
 * in SessionManager.
 */

/** How a `fail` rule breaks the request. */
export type FailMode = 'error500' | 'timeout' | 'offline' | 'missing' | 'corrupt';
export const FAIL_MODES: readonly FailMode[] = ['error500', 'timeout', 'offline', 'missing', 'corrupt'];

/** Replace the response with a canned one — the request never reaches the server. */
export interface MockAction {
  kind: 'mock';
  statusCode: number;
  body: string;
  responseHeaders: Record<string, string>;
  // Adds access-control-allow-* headers on fulfilment and answers a matching OPTIONS preflight.
  cors?: boolean;
}
/** Fail the request: 500, 504, offline, 404 or a garbled 200. */
export interface FailAction { kind: 'fail'; mode: FailMode }
/** Let the request through untouched; only the rule's `delayMs` applies. */
export interface DelayAction { kind: 'delay' }
/** Never answer. `failAfterMs` (0/absent = never) fails it with TimedOut afterwards. */
export interface HangAction { kind: 'hang'; failAfterMs?: number }
/**
 * Race gate: park matching requests until `batchSize` have arrived (from any tab
 * on the partition), then send them all together. `giveUpAfterMs` releases an
 * incomplete batch anyway (0/absent = 10 s) so the gate can never hang a page.
 */
export interface RaceAction { kind: 'race'; batchSize: number; giveUpAfterMs?: number }

/** Cookies a Rewrite rule sends instead of the tab's own cookie jar. */
export interface RewriteCookies {
  // Partition of the session whose jar is read live at request time.
  sourcePartition?: string;
  // Added on top of the source jar; an extra wins over a source cookie of the same name.
  extra: Record<string, string>;
  // Last known state of the source jar. In memory only (never persisted — an
  // in-memory session's cookies must not end up on disk); refreshed whenever the
  // source is read and when its last tab closes, then used once it is gone.
  snapshot?: CookieRecord[];
  // How many cookies the snapshot holds. Only ever set on what is sent to the
  // renderer (see stripSnapshots) so the panel can say "using last cookies".
  snapshotCount?: number;
}

/**
 * Change what is sent to the server. Body is a full replace; headers are set on
 * top of the original ones (an empty value removes the header). When `cookies`
 * is set it replaces the tab's own Cookie header entirely.
 */
export interface RewriteAction {
  kind: 'rewrite';
  url?: string;
  method?: string;
  headers: Record<string, string>;
  // undefined = keep the original body, any string (even '') = replace it.
  body?: string;
  cookies?: RewriteCookies;
}

export type RuleAction = MockAction | FailAction | DelayAction | HangAction | RaceAction | RewriteAction;
export type RuleKind = RuleAction['kind'];
export const RULE_KINDS: readonly RuleKind[] = ['mock', 'fail', 'delay', 'hang', 'race', 'rewrite'];

export interface Rule {
  id: string;
  // '*' (any method) or a single HTTP method. Matching never looks at headers or body.
  method: string;
  urlPattern: string;
  // 0..1 share of matching requests the rule applies to (default 1). A failed
  // roll skips the rule: the next matching rule still gets its own roll.
  probability: number;
  // 0..120 000 ms before the action is carried out (mock / fail / delay / rewrite).
  delayMs?: number;
  action: RuleAction;
  enabled: boolean;
  hitCount: number;
  lastHitAt: number | null;
  // Provenance from the captured call the rule was created from — read-only
  // display in the panel, never matched against and never sent anywhere.
  requestHeaders?: Record<string, string>;
  requestBody?: string;
}

export const MAX_DELAY_MS = 120_000;

export function clampDelayMs(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(MAX_DELAY_MS, Math.max(0, Math.round(n)));
}

export function clampProbability(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0, n));
}

// ── Matching ────────────────────────────────────────────────────────────────

export function ruleMatchesRequest(rule: Rule, request: { method: string; url: string }): boolean {
  return (!rule.method || rule.method === '*' || rule.method === request.method) && matchesGlob(rule.urlPattern, request.url);
}

/**
 * First enabled rule that matches and whose probability roll succeeds. `rand`
 * is injectable so this is deterministically testable.
 */
export function pickRule(
  rules: Rule[],
  request: { method: string; url: string },
  rand: () => number = Math.random
): Rule | null {
  for (const rule of rules) {
    if (!rule.enabled || !ruleMatchesRequest(rule, request)) continue;
    if (rule.probability >= 1 || rand() < rule.probability) return rule;
  }
  return null;
}

/**
 * A CORS preflight is always OPTIONS, so it can never match a rule's own method:
 * it is answered from any enabled mock rule with `cors` whose URL matches.
 */
export function findCorsPreflightRule(rules: Rule[], url: string): Rule | null {
  return rules.find((r) => r.enabled && r.action.kind === 'mock' && r.action.cors && matchesGlob(r.urlPattern, url)) ?? null;
}

// ── Editing ─────────────────────────────────────────────────────────────────

/** Fills defaults and clamps what a caller (the renderer, an import) hands over. */
export function normalizeRule(rule: Partial<Rule> & { id: string; action: RuleAction }): Rule {
  const { requestHeaders, requestBody } = rule;
  const out: Rule = {
    id: rule.id,
    method: rule.method || '*',
    urlPattern: rule.urlPattern ?? '*',
    probability: clampProbability(rule.probability ?? 1),
    delayMs: clampDelayMs(rule.delayMs),
    action: normalizeAction(rule.action),
    enabled: rule.enabled ?? true,
    hitCount: 0,
    lastHitAt: null,
  };
  if (requestHeaders) out.requestHeaders = requestHeaders;
  if (requestBody !== undefined) out.requestBody = requestBody;
  return out;
}

function normalizeAction(action: RuleAction): RuleAction {
  switch (action.kind) {
    case 'mock':
      return { ...action, responseHeaders: action.responseHeaders || {}, body: action.body ?? '' };
    case 'rewrite':
      return { ...action, headers: action.headers || {}, ...(action.cookies ? { cookies: { ...action.cookies, extra: action.cookies.extra || {} } } : {}) };
    default:
      return action;
  }
}

/**
 * Merges a patch onto a rule. id, hitCount and lastHitAt are stripped so an
 * edit can never reset a rule's identity or hit history.
 */
export function applyRulePatch(rule: Rule, patch: Partial<Rule>): Rule {
  const { id: _id, hitCount: _hitCount, lastHitAt: _lastHitAt, ...safe } = patch;
  const next: Rule = { ...rule, ...safe };
  if ('delayMs' in safe) next.delayMs = clampDelayMs(safe.delayMs);
  if ('probability' in safe) next.probability = clampProbability(safe.probability);
  if (safe.action) {
    next.action = normalizeAction(safe.action);
    // An edit comes from the renderer, which never sees the cookie snapshot —
    // keep it as long as the rule still reads from the same source session.
    const before = rule.action;
    const after = next.action;
    if (before.kind === 'rewrite' && after.kind === 'rewrite' && after.cookies && !after.cookies.snapshot
        && before.cookies?.snapshot && before.cookies.sourcePartition === after.cookies.sourcePartition) {
      after.cookies = { ...after.cookies, snapshot: before.cookies.snapshot };
    }
    if (after.kind === 'rewrite' && after.cookies) {
      const { snapshotCount: _count, ...cookies } = after.cookies;
      after.cookies = cookies;
    }
  }
  return next;
}

/**
 * What the renderer gets: a rewrite rule's cookie snapshot is replaced by its
 * size — the snapshot can be a whole jar and the panel polls every 1.5 s.
 */
export function stripSnapshots(rules: Rule[]): Rule[] {
  return rules.map((r) => {
    if (r.action?.kind !== 'rewrite' || !r.action.cookies?.snapshot) return r;
    const { snapshot, ...cookies } = r.action.cookies;
    return { ...r, action: { ...r.action, cookies: { ...cookies, snapshotCount: snapshot.length } } };
  });
}

/** Returns a new array; never mutates `arr`. */
export function moveInArray<T>(arr: T[], index: number, dir: 'up' | 'down'): T[] {
  const target = dir === 'up' ? index - 1 : index + 1;
  if (index < 0 || index >= arr.length || target < 0 || target >= arr.length) return arr;
  const next = arr.slice();
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** Moves the item at `from` so it ends up at index `to` (drag and drop). */
export function reorderArray<T>(arr: T[], from: number, to: number): T[] {
  if (from < 0 || from >= arr.length || to < 0 || to >= arr.length || from === to) return arr;
  const next = arr.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

// ── Mock responses ──────────────────────────────────────────────────────────

// A captured response's own content-length/content-encoding/transfer-encoding
// describe the *original* (often compressed) body — fulfilling with the decoded,
// possibly edited body under them corrupts or truncates it. `connection` is a
// transport header a mock shouldn't echo. The renderer keeps its own copy of
// this list (renderer/utils.js); the unbundled ESM renderer can't import this.
const STRIPPED_MOCK_RESPONSE_HEADERS = ['content-length', 'content-encoding', 'transfer-encoding', 'connection'];

function findHeaderCI(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

function inferMockContentType(body: string): string {
  try { JSON.parse(body); return 'application/json; charset=utf-8'; } catch {}
  if (body.trim().startsWith('<')) return 'text/html; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

function buildCorsHeaders(
  requestHeaders: Record<string, string> | undefined,
  existingHeaderNames: Set<string>
): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  const origin = findHeaderCI(requestHeaders, 'origin');
  if (!existingHeaderNames.has('access-control-allow-origin')) {
    out.push({ name: 'access-control-allow-origin', value: origin || '*' });
    // Only echoing a specific origin (not the '*' wildcard) is valid with allow-credentials.
    if (origin) out.push({ name: 'access-control-allow-credentials', value: 'true' });
  }
  if (!existingHeaderNames.has('access-control-allow-headers')) {
    out.push({ name: 'access-control-allow-headers', value: '*' });
  }
  return out;
}

/** The Fetch.fulfillRequest params a mock action produces. */
export function buildMockFulfillParams(
  action: MockAction,
  request?: { headers?: Record<string, string> }
): { responseCode: number; responseHeaders: { name: string; value: string }[]; body: string } {
  const kept = Object.fromEntries(
    Object.entries(action.responseHeaders || {}).filter(([name]) => !STRIPPED_MOCK_RESPONSE_HEADERS.includes(name.toLowerCase()))
  );
  if (!findHeaderCI(kept, 'content-type')) kept['content-type'] = inferMockContentType(action.body);
  const responseHeaders = Object.entries(kept).map(([name, value]) => ({ name, value }));
  if (action.cors) {
    const existing = new Set(Object.keys(kept).map((h) => h.toLowerCase()));
    responseHeaders.push(...buildCorsHeaders(request?.headers, existing));
  }
  return { responseCode: action.statusCode, responseHeaders, body: Buffer.from(action.body).toString('base64') };
}

/** A CORS preflight is answered 204 with just the access-control-allow-* headers. */
export function buildMockPreflightParams(
  request?: { headers?: Record<string, string> }
): { responseCode: number; responseHeaders: { name: string; value: string }[] } {
  return { responseCode: 204, responseHeaders: buildCorsHeaders(request?.headers, new Set()) };
}

// ── Fail ────────────────────────────────────────────────────────────────────

/** The CDP command + params a `fail` action resolves a paused request with. */
export function buildFailCommand(mode: FailMode, requestId: string): { command: string; params: Record<string, unknown> } {
  const body = (text: string) => Buffer.from(text).toString('base64');
  switch (mode) {
    case 'error500': return { command: 'Fetch.fulfillRequest', params: { requestId, responseCode: 500, body: body('Internal Server Error') } };
    case 'timeout': return { command: 'Fetch.fulfillRequest', params: { requestId, responseCode: 504, body: body('Gateway Timeout') } };
    case 'missing': return { command: 'Fetch.fulfillRequest', params: { requestId, responseCode: 404, body: body('Not Found') } };
    case 'corrupt': return { command: 'Fetch.fulfillRequest', params: { requestId, responseCode: 200, body: body('\x00\x01\x02\xff\xfe' + 'x'.repeat(20)) } };
    case 'offline': return { command: 'Fetch.failRequest', params: { requestId, errorReason: 'InternetDisconnected' } };
  }
}

// ── Cookies (Rewrite) ───────────────────────────────────────────────────────

export interface CookieRecord {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure?: boolean;
  expirationDate?: number;
}

/** RFC 6265 domain + path + secure matching of a stored cookie against a request URL. */
export function cookieMatchesUrl(cookie: CookieRecord, url: string, now: number = Date.now() / 1000): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (cookie.expirationDate !== undefined && cookie.expirationDate <= now) return false;
  if (cookie.secure && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  const domain = cookie.domain.toLowerCase();
  const domainOk = domain.startsWith('.')
    ? host === domain.slice(1) || host.endsWith(domain)
    : host === domain;
  if (!domainOk) return false;
  const cookiePath = cookie.path || '/';
  const reqPath = u.pathname || '/';
  if (reqPath === cookiePath) return true;
  if (!reqPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || reqPath.charAt(cookiePath.length) === '/';
}

/**
 * The Cookie header a rewrite sends: the source jar's cookies that apply to
 * `url` (more specific path first, one per name), with `extra` on top.
 * Empty string when there is nothing to send.
 */
export function buildCookieHeader(
  cookies: CookieRecord[],
  extra: Record<string, string>,
  url: string,
  now?: number
): string {
  const byName = new Map<string, CookieRecord>();
  const applicable = cookies
    .filter((c) => cookieMatchesUrl(c, url, now))
    .sort((a, b) => (b.path || '/').length - (a.path || '/').length);
  for (const c of applicable) if (!byName.has(c.name)) byName.set(c.name, c);
  const pairs = new Map<string, string>();
  for (const [name, c] of byName) pairs.set(name, c.value);
  for (const [name, value] of Object.entries(extra || {})) {
    if (name.trim()) pairs.set(name.trim(), value);
  }
  return Array.from(pairs, ([n, v]) => `${n}=${v}`).join('; ');
}

// ── Rewrite ─────────────────────────────────────────────────────────────────

export interface RewriteRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

export interface RewriteSent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** A recorded "what was actually sent" body is capped so one huge upload can't bloat the row. */
export const MAX_SENT_BODY_CHARS = 20_000;

/**
 * The Fetch.continueRequest params a rewrite action produces, plus a plain
 * `sent` record of the same thing for the Network detail pane.
 * `cookieHeader` is the already-built Cookie header (undefined = leave the
 * tab's own cookies alone).
 */
export function buildRewriteParams(
  action: RewriteAction,
  request: RewriteRequest,
  cookieHeader?: string
): { params: { url?: string; method?: string; headers: { name: string; value: string }[]; postData?: string }; sent: RewriteSent } {
  const headers = new Map<string, { name: string; value: string }>();
  for (const [name, value] of Object.entries(request.headers || {})) headers.set(name.toLowerCase(), { name, value });

  for (const [name, value] of Object.entries(action.headers || {})) {
    const key = name.trim().toLowerCase();
    if (!key) continue;
    if (value === '') {
      // A header the page set is removed. Cookie is special: leaving it out
      // makes Chromium add the tab's own cookie jar back, so "no cookies" is
      // an explicit empty header. (Headers the network stack adds after the
      // pause, such as Accept-Language, can be overridden but not removed.)
      if (key === 'cookie') headers.set(key, { name: 'Cookie', value: '' });
      else headers.delete(key);
    } else {
      headers.set(key, { name: name.trim(), value });
    }
  }
  // Verified against Electron: an explicit empty Cookie header sends no cookies
  // at all, whereas omitting it falls back to the tab's own jar — which would
  // quietly send the wrong identity when a rule means "these cookies, and
  // nothing else".
  if (cookieHeader !== undefined) headers.set('cookie', { name: 'Cookie', value: cookieHeader });
  const bodyReplaced = action.body !== undefined;
  // The original length no longer applies; the network stack sets the right one.
  if (bodyReplaced) headers.delete('content-length');

  const url = action.url?.trim() || undefined;
  const method = action.method && action.method !== '*' ? action.method.toUpperCase() : undefined;
  const headerList = Array.from(headers.values());

  const params: { url?: string; method?: string; headers: { name: string; value: string }[]; postData?: string } = { headers: headerList };
  if (url) params.url = url;
  if (method) params.method = method;
  if (bodyReplaced) params.postData = Buffer.from(action.body as string).toString('base64');

  const sent: RewriteSent = {
    url: url ?? request.url,
    method: method ?? request.method,
    headers: Object.fromEntries(headerList.map((h) => [h.name, h.value])),
  };
  if (bodyReplaced) sent.body = (action.body as string).slice(0, MAX_SENT_BODY_CHARS);
  return { params, sent };
}

// ── Import / export ─────────────────────────────────────────────────────────

export type ImportableRule = Omit<Rule, 'id' | 'hitCount' | 'lastHitAt'>;

export interface ValidateImportedRulesResult {
  rules: ImportableRule[];
  skipped: { index: number; reason: string }[];
  // Set only when the whole file is rejected outright.
  error?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStringMap = (v: unknown): v is Record<string, string> =>
  isRecord(v) && Object.values(v).every((x) => typeof x === 'string');

/** Validates one action from an untrusted file; returns a rebuilt action (unknown fields dropped) or a reason. */
function validateAction(raw: unknown): { action: RuleAction } | { reason: string } {
  if (!isRecord(raw)) return { reason: 'action must be an object' };
  switch (raw.kind) {
    case 'mock': {
      if (!Number.isInteger(raw.statusCode) || (raw.statusCode as number) < 100 || (raw.statusCode as number) > 599) {
        return { reason: 'statusCode must be an integer 100-599' };
      }
      if (typeof raw.body !== 'string') return { reason: 'body must be a string' };
      if (raw.responseHeaders !== undefined && !isStringMap(raw.responseHeaders)) return { reason: 'responseHeaders must be an object of strings' };
      if (raw.cors !== undefined && typeof raw.cors !== 'boolean') return { reason: 'cors must be a boolean' };
      return { action: { kind: 'mock', statusCode: raw.statusCode as number, body: raw.body, responseHeaders: (raw.responseHeaders as Record<string, string>) ?? {}, cors: raw.cors as boolean | undefined } };
    }
    case 'fail':
      return FAIL_MODES.includes(raw.mode as FailMode) ? { action: { kind: 'fail', mode: raw.mode as FailMode } } : { reason: 'fail mode is not valid' };
    case 'delay':
      return { action: { kind: 'delay' } };
    case 'hang':
      if (raw.failAfterMs !== undefined && typeof raw.failAfterMs !== 'number') return { reason: 'failAfterMs must be a number' };
      return { action: { kind: 'hang', failAfterMs: raw.failAfterMs as number | undefined } };
    case 'race':
      if (typeof raw.batchSize !== 'number') return { reason: 'batchSize must be a number' };
      if (raw.giveUpAfterMs !== undefined && typeof raw.giveUpAfterMs !== 'number') return { reason: 'giveUpAfterMs must be a number' };
      return { action: { kind: 'race', batchSize: raw.batchSize, giveUpAfterMs: raw.giveUpAfterMs as number | undefined } };
    case 'rewrite': {
      if (raw.headers !== undefined && !isStringMap(raw.headers)) return { reason: 'headers must be an object of strings' };
      if (raw.url !== undefined && typeof raw.url !== 'string') return { reason: 'url must be a string' };
      if (raw.method !== undefined && typeof raw.method !== 'string') return { reason: 'method must be a string' };
      if (raw.body !== undefined && typeof raw.body !== 'string') return { reason: 'body must be a string' };
      let cookies: RewriteCookies | undefined;
      if (raw.cookies !== undefined) {
        if (!isRecord(raw.cookies) || (raw.cookies.extra !== undefined && !isStringMap(raw.cookies.extra))) return { reason: 'cookies.extra must be an object of strings' };
        if (raw.cookies.sourcePartition !== undefined && typeof raw.cookies.sourcePartition !== 'string') return { reason: 'cookies.sourcePartition must be a string' };
        // A source session is a partition of this machine/run; it means nothing in another install, so it is not imported.
        cookies = { extra: (raw.cookies.extra as Record<string, string>) ?? {} };
      }
      return { action: { kind: 'rewrite', url: raw.url as string | undefined, method: raw.method as string | undefined, headers: (raw.headers as Record<string, string>) ?? {}, body: raw.body as string | undefined, cookies } };
    }
    default:
      return { reason: 'unknown action kind' };
  }
}

/**
 * Pure so every validation branch is unit-testable. `json` is entirely untrusted
 * (a file the user picked): the returned objects only ever copy the fields
 * listed here.
 */
export function validateImportedRules(json: unknown): ValidateImportedRulesResult {
  if (!isRecord(json) || json.testerBrowserRules !== 1 || !Array.isArray(json.rules)) {
    return { rules: [], skipped: [], error: 'Not a TesterBrowser rules file' };
  }
  const rules: ImportableRule[] = [];
  const skipped: { index: number; reason: string }[] = [];

  json.rules.forEach((raw, index) => {
    if (!isRecord(raw)) { skipped.push({ index, reason: 'rule is not an object' }); return; }
    if (typeof raw.urlPattern !== 'string' || raw.urlPattern.length === 0) { skipped.push({ index, reason: 'urlPattern must be a non-empty string' }); return; }
    if (typeof raw.method !== 'string') { skipped.push({ index, reason: 'method must be a string' }); return; }
    if (raw.probability !== undefined && (typeof raw.probability !== 'number' || raw.probability < 0 || raw.probability > 1)) { skipped.push({ index, reason: 'probability must be a number from 0 to 1' }); return; }
    if (raw.delayMs !== undefined && typeof raw.delayMs !== 'number') { skipped.push({ index, reason: 'delayMs must be a number' }); return; }
    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') { skipped.push({ index, reason: 'enabled must be a boolean' }); return; }
    const checked = validateAction(raw.action);
    if ('reason' in checked) { skipped.push({ index, reason: checked.reason }); return; }
    rules.push({
      method: raw.method,
      urlPattern: raw.urlPattern,
      probability: (raw.probability as number | undefined) ?? 1,
      delayMs: raw.delayMs as number | undefined,
      action: checked.action,
      enabled: (raw.enabled as boolean | undefined) ?? true,
    });
  });
  return { rules, skipped };
}
