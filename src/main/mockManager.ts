import { BrowserWindow, dialog } from 'electron';
import fs from 'fs';
import { matchesGlob } from './urlGlob';

/**
 * Owns Mock rule storage, matching and the fulfil-response shape (#255,
 * extracted from sessionManager.ts once every Mock ticket in this grooming
 * batch — #235/#263/#264 — had landed). Rules are keyed by session
 * *partition*, not by tab id: several tabs sharing one partition (a
 * middle-clicked link, a reopened tab) share the same rule set. Callers
 * resolve a tab id to its partition (SessionManager already owns that
 * lookup) and talk to this class purely in terms of partitions.
 *
 * The CDP interception point itself (Fetch.requestPaused) stays in
 * SessionManager, since it's shared infrastructure with ResilienceManager —
 * this class only owns storage, matching and the fulfil-params shape.
 */

export interface MockRule {
  id: string;
  urlPattern: string;
  method: string;
  statusCode: number;
  body: string;
  responseHeaders: Record<string, string>;
  // Request headers from the captured call this rule was created from, kept
  // only as read-only provenance in the panel — never used for matching.
  // Undefined for a rule composed by hand rather than from a real request.
  requestHeaders?: Record<string, string>;
  // #235: adds access-control-allow-* headers on fulfilment and answers a
  // matching OPTIONS preflight — see buildMockFulfillParams/buildMockPreflightParams.
  cors?: boolean;
  // #263: 0 (default, instant) to 120,000ms — lets a mock exercise loading
  // spinners, skeleton states or client timeouts. Absent on a rule from
  // before this existed (or restored by #264) — always read as
  // `rule.delayMs || 0`, never assumed present.
  delayMs?: number;
  enabled: boolean;
  hitCount: number;
  lastHitAt: number | null;
}

// #263: 0-120,000ms — a mock's own testable delay, distinct from Resilience's
// `latency`. A NaN/negative/huge input (a stray value from a hand-crafted
// IPC call, since the renderer's own number input already constrains this)
// clamps rather than producing an invalid rule.
function clampDelayMs(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(120_000, Math.max(0, n));
}

// #235: a captured response's own content-length/content-encoding/transfer-encoding
// are for the *original* (often compressed) body — fulfilling with the decoded,
// possibly-edited rule.body under those headers corrupts or truncates it, so
// they're never prefilled (openMockFromRequest, renderer/mock.js) and stripped
// again here as a backstop for rules saved before that existed. `connection`
// is stripped alongside them since it's equally a transport-layer header a
// mock response shouldn't be echoing. The renderer keeps its own copy of this
// same list (renderer/utils.js) rather than sharing one across the IPC
// boundary — see that file's comment.
const STRIPPED_MOCK_RESPONSE_HEADERS = ['content-length', 'content-encoding', 'transfer-encoding', 'connection'];

function findHeaderCI(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

// application/json when the body parses as JSON, text/html when it looks
// like markup, text/plain otherwise — only used when the rule doesn't
// already set its own Content-Type.
function inferMockContentType(body: string): string {
  try { JSON.parse(body); return 'application/json; charset=utf-8'; } catch {}
  if (body.trim().startsWith('<')) return 'text/html; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

// Adds the CORS response headers for a `cors: true` rule, unless the rule
// already sets them itself. Shared between an ordinary fulfilment
// (buildMockFulfillParams) and an OPTIONS preflight response
// (buildMockPreflightParams) so the two can never disagree on what "CORS on"
// means. `existingHeaderNames` is checked case-insensitively.
function buildCorsHeaders(
  requestHeaders: Record<string, string> | undefined,
  existingHeaderNames: Set<string>
): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  const origin = findHeaderCI(requestHeaders, 'origin');
  if (!existingHeaderNames.has('access-control-allow-origin')) {
    out.push({ name: 'access-control-allow-origin', value: origin || '*' });
    // Only echoing a specific origin (rather than the '*' wildcard) is a
    // valid combination with allow-credentials per the Fetch spec.
    if (origin) out.push({ name: 'access-control-allow-credentials', value: 'true' });
  }
  if (!existingHeaderNames.has('access-control-allow-headers')) {
    out.push({ name: 'access-control-allow-headers', value: '*' });
  }
  return out;
}

// Pulled out as a pure function so the Fetch.fulfillRequest shape a mock rule
// produces can be unit-tested without the CDP debugger/session plumbing
// around it. responseHeaders defaults to {} for a rule saved before that
// field existed (or built by hand without one). `request` is optional (the
// #233 replay path may not always have headers) and is only consulted for
// its `Origin` header when the rule has CORS on.
export function buildMockFulfillParams(
  rule: MockRule,
  request?: { headers?: Record<string, string> }
): { responseCode: number; responseHeaders: { name: string; value: string }[]; body: string } {
  const kept = Object.fromEntries(
    Object.entries(rule.responseHeaders || {}).filter(([name]) => !STRIPPED_MOCK_RESPONSE_HEADERS.includes(name.toLowerCase()))
  );
  if (!findHeaderCI(kept, 'content-type')) {
    kept['content-type'] = inferMockContentType(rule.body);
  }
  const responseHeaders = Object.entries(kept).map(([name, value]) => ({ name, value }));
  if (rule.cors) {
    const existing = new Set(Object.keys(kept).map((h) => h.toLowerCase()));
    responseHeaders.push(...buildCorsHeaders(request?.headers, existing));
  }
  return {
    responseCode: rule.statusCode,
    responseHeaders,
    body: Buffer.from(rule.body).toString('base64'),
  };
}

// A CORS preflight (OPTIONS) doesn't go through the rule's own method/body/status
// at all — it's answered 204 with just the access-control-allow-* headers, per
// the acceptance criteria. Only called for a `cors: true` rule.
export function buildMockPreflightParams(
  request?: { headers?: Record<string, string> }
): { responseCode: number; responseHeaders: { name: string; value: string }[] } {
  return {
    responseCode: 204,
    responseHeaders: buildCorsHeaders(request?.headers, new Set()),
  };
}

// Pure so an edit's merge behaviour is unit-testable directly: id, hitCount
// and lastHitAt are stripped from the incoming patch even if present, so an
// edit can never reset a rule's identity or hit history regardless of what
// the caller sends.
export function applyMockRulePatch(rule: MockRule, patch: Partial<MockRule>): MockRule {
  const { id: _id, hitCount: _hitCount, lastHitAt: _lastHitAt, ...safePatch } = patch;
  const next: MockRule = { ...rule, ...safePatch };
  if ('delayMs' in safePatch) next.delayMs = clampDelayMs(safePatch.delayMs);
  return next;
}

// #263: pure so reorder edge cases (top/bottom no-ops, middle) are
// unit-testable without SessionManager plumbing. Returns a new array —
// never mutates `arr` — so callers can swap it straight into a Map.
export function moveInArray<T>(arr: T[], index: number, dir: 'up' | 'down'): T[] {
  const target = dir === 'up' ? index - 1 : index + 1;
  if (index < 0 || index >= arr.length || target < 0 || target >= arr.length) return arr;
  const next = arr.slice();
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export type ImportableMockRule = Omit<MockRule, 'id' | 'hitCount' | 'lastHitAt'>;

export interface ValidateImportedMockRulesResult {
  rules: ImportableMockRule[];
  skipped: { index: number; reason: string }[];
  // Set only when the whole file is rejected outright (not JSON at the
  // top level, or missing the testerBrowserMocks marker) — rules/skipped
  // are both empty in that case.
  error?: string;
}

// #264: pure so every validation branch is unit-testable without the main
// process or dialogs around it. `json` is whatever JSON.parse() produced —
// entirely untrusted, since it came from a file the user picked. Per rule,
// unknown fields are dropped by construction: the returned object only ever
// copies the fields listed here, nothing else from the source object.
export function validateImportedMockRules(json: unknown): ValidateImportedMockRulesResult {
  if (!json || typeof json !== 'object' || Array.isArray(json) || (json as Record<string, unknown>).testerBrowserMocks !== 1) {
    return { rules: [], skipped: [], error: 'Not a TesterBrowser Mock rules file' };
  }
  const rawRules = (json as Record<string, unknown>).rules;
  if (!Array.isArray(rawRules)) {
    return { rules: [], skipped: [], error: 'Not a TesterBrowser Mock rules file' };
  }

  const rules: ImportableMockRule[] = [];
  const skipped: { index: number; reason: string }[] = [];

  rawRules.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      skipped.push({ index, reason: 'rule is not an object' });
      return;
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.urlPattern !== 'string' || r.urlPattern.length === 0) {
      skipped.push({ index, reason: 'urlPattern must be a non-empty string' });
      return;
    }
    if (typeof r.method !== 'string') {
      skipped.push({ index, reason: 'method must be a string' });
      return;
    }
    if (!Number.isInteger(r.statusCode) || (r.statusCode as number) < 100 || (r.statusCode as number) > 599) {
      skipped.push({ index, reason: 'statusCode must be an integer 100-599' });
      return;
    }
    if (typeof r.body !== 'string') {
      skipped.push({ index, reason: 'body must be a string' });
      return;
    }
    if (r.responseHeaders !== undefined) {
      const rh = r.responseHeaders;
      const rhValid = rh !== null && typeof rh === 'object' && !Array.isArray(rh)
        && Object.values(rh as Record<string, unknown>).every(v => typeof v === 'string');
      if (!rhValid) {
        skipped.push({ index, reason: 'responseHeaders must be an object of strings' });
        return;
      }
    }
    if (r.cors !== undefined && typeof r.cors !== 'boolean') {
      skipped.push({ index, reason: 'cors must be a boolean' });
      return;
    }
    if (r.delayMs !== undefined && typeof r.delayMs !== 'number') {
      skipped.push({ index, reason: 'delayMs must be a number' });
      return;
    }
    if (r.enabled !== undefined && typeof r.enabled !== 'boolean') {
      skipped.push({ index, reason: 'enabled must be a boolean' });
      return;
    }

    rules.push({
      urlPattern: r.urlPattern,
      method: r.method,
      statusCode: r.statusCode as number,
      body: r.body,
      responseHeaders: (r.responseHeaders as Record<string, string> | undefined) ?? {},
      cors: r.cors as boolean | undefined,
      delayMs: r.delayMs as number | undefined,
      enabled: r.enabled === undefined ? true : (r.enabled as boolean),
    });
  });

  return { rules, skipped };
}

export type ImportPromptResult =
  | { canceled: true }
  | { error: string }
  | { rules: ImportableMockRule[]; skipped: { index: number; reason: string }[] };

export class MockManager {
  private win: BrowserWindow;
  private rulesByPartition = new Map<string, MockRule[]>();

  constructor(win: BrowserWindow) {
    this.win = win;
  }

  // Seeds an empty rule bucket for a partition that's never had one — called
  // once, from SessionManager.createSession(), for the first tab ever to
  // represent a given partition. A partition that already has an entry
  // (reopen, "New tab in this session") is left alone.
  ensurePartition(partition: string): void {
    if (!this.rulesByPartition.has(partition)) this.rulesByPartition.set(partition, []);
  }

  getRules(partition: string): MockRule[] {
    let rules = this.rulesByPartition.get(partition);
    if (!rules) { rules = []; this.rulesByPartition.set(partition, rules); }
    return rules;
  }

  getEnabledRules(partition: string): MockRule[] {
    return (this.rulesByPartition.get(partition) ?? []).filter(r => r.enabled);
  }

  // Raw read with no lazy-creation side effect — for saveSessions(), which
  // must not conjure up a partition entry just by looking.
  peek(partition: string): MockRule[] | undefined {
    return this.rulesByPartition.get(partition);
  }

  // Overwrites a partition's rules wholesale — used by loadAndRestoreSessions()
  // to bring persisted rules back to life, with hitCount/lastHitAt reset (a
  // stale hit count from a previous run isn't worth restoring across a restart).
  restorePartition(partition: string, rules: MockRule[]): void {
    this.rulesByPartition.set(partition, rules.map((r) => ({ ...r, hitCount: 0, lastHitAt: null })));
  }

  // #269: deep-copies a source partition's rules into a destination partition
  // as an independent set — mutating either side afterward never affects the
  // other.
  cloneInto(destPartition: string, srcPartition: string): void {
    this.rulesByPartition.set(destPartition, structuredClone(this.rulesByPartition.get(srcPartition) ?? []));
  }

  // #233: shared by SessionManager's Fetch.requestPaused handler and the
  // recording:replay IPC, so a replay is intercepted by exactly the same
  // rules (and matching semantics) a live request from that tab would be.
  findMatch(partition: string, method: string, url: string): MockRule | null {
    return this.getRules(partition).find(
      r => r.enabled && (r.method === '*' || r.method === method) && matchesGlob(r.urlPattern, url)
    ) ?? null;
  }

  // A CORS preflight never carries the rule's own method (it's always
  // OPTIONS), so it can't go through findMatch's method check — answered
  // directly from any enabled cors:true rule whose URL pattern matches,
  // regardless of that rule's configured method.
  findCorsPreflightMatch(partition: string, url: string): MockRule | null {
    return this.getRules(partition).find(r => r.enabled && r.cors && matchesGlob(r.urlPattern, url)) ?? null;
  }

  recordHit(rule: MockRule): void {
    rule.hitCount = (rule.hitCount || 0) + 1;
    rule.lastHitAt = Date.now();
  }

  add(partition: string, rule: MockRule): void {
    const rules = this.getRules(partition);
    rules.push({ ...rule, responseHeaders: rule.responseHeaders || {}, delayMs: clampDelayMs(rule.delayMs), hitCount: 0, lastHitAt: null });
  }

  remove(partition: string, ruleId: string): void {
    this.rulesByPartition.set(partition, (this.rulesByPartition.get(partition) ?? []).filter(r => r.id !== ruleId));
  }

  toggle(partition: string, ruleId: string, enabled: boolean): void {
    const rule = this.getRules(partition).find(r => r.id === ruleId);
    if (rule) rule.enabled = enabled;
  }

  // Returns whether the update actually applied — #235: the renderer needs
  // to tell "saved" apart from "silently did nothing" (the owning tab was
  // closed since the edit row was opened, or the rule itself is gone) so it
  // can show an inline error instead of pretending the edit went through.
  update(partition: string, ruleId: string, patch: Partial<MockRule>): boolean {
    const rules = this.getRules(partition);
    const idx = rules.findIndex(r => r.id === ruleId);
    if (idx === -1) return false;
    rules[idx] = applyMockRulePatch(rules[idx], patch);
    return true;
  }

  // #263: rules are matched in array order (findMatch's own `.find()`) —
  // this is what makes that order visible/controllable from the panel
  // instead of only settable by deleting and recreating rules.
  move(partition: string, ruleId: string, dir: 'up' | 'down'): void {
    const rules = this.rulesByPartition.get(partition);
    if (!rules) return;
    const idx = rules.findIndex(r => r.id === ruleId);
    if (idx === -1) return;
    this.rulesByPartition.set(partition, moveInArray(rules, idx, dir));
  }

  // #264: id/hitCount/lastHitAt are run-local, not something a shared rule
  // set should carry — the exported file only has what's needed to recreate
  // the rules elsewhere.
  async exportRulesToFile(rules: MockRule[]): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> {
    const result = await dialog.showSaveDialog(this.win, {
      title: 'Export Mock rules',
      defaultPath: 'mock-rules.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    try {
      const exportable = rules.map(({ id: _id, hitCount: _hitCount, lastHitAt: _lastHitAt, ...rest }) => rest);
      fs.writeFileSync(result.filePath, JSON.stringify({ testerBrowserMocks: 1, rules: exportable }, null, 2));
      return { ok: true, path: result.filePath };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // Prompts for a file and validates it, without touching any partition's
  // rules yet — kept separate from appendImportedRules() so the caller can
  // run its own "does the owning session still exist" check in between,
  // exactly where the original inline implementation did (after the dialog/
  // parse/validate steps, not before).
  async promptAndValidateImportFile(): Promise<ImportPromptResult> {
    const result = await dialog.showOpenDialog(this.win, {
      title: 'Import Mock rules',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };

    let json: unknown;
    try {
      json = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf-8'));
    } catch {
      return { error: 'Not valid JSON' };
    }
    const { rules, skipped, error } = validateImportedMockRules(json);
    if (error) return { error };
    return { rules, skipped };
  }

  // #264: valid rules are appended (with fresh ids) to the target partition —
  // an import never replaces or reorders what's already there. Returns the
  // number appended.
  appendImportedRules(partition: string, rules: ImportableMockRule[]): number {
    const target = this.getRules(partition);
    for (const r of rules) {
      target.push({
        ...r,
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        responseHeaders: r.responseHeaders || {},
        delayMs: clampDelayMs(r.delayMs),
        hitCount: 0,
        lastHitAt: null,
      });
    }
    return rules.length;
  }
}
