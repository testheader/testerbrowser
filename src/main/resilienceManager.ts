import { matchesGlob } from './urlGlob';

/**
 * Owns Resilience rule storage and matching (#255, extracted from
 * sessionManager.ts once every Resilience ticket in this grooming batch —
 * #236/#265/#224 — had landed). Rules are keyed by session *partition*,
 * same rationale as MockManager. Unlike Mock rules, Resilience rules are
 * never persisted to disk (#264's own "Out of scope") — this class has no
 * save/restore surface.
 *
 * The CDP interception point itself (Fetch.requestPaused) and the actual
 * response-degradation dispatch (hung-request timers, Fetch.fulfillRequest
 * calls) stay in SessionManager, since they're shared infrastructure with
 * MockManager / tightly coupled to the CDP debugger — this class only owns
 * rule storage and matching.
 */

export type ResilienceType = 'error500' | 'timeout' | 'latency' | 'offline' | 'missing' | 'random500' | 'corrupt' | 'hang' | 'stall504';

export interface ResilienceRule {
  id: string;
  type: ResilienceType;
  urlPattern: string;
  // '*' (the default, matching every method) or a single HTTP method — never
  // matched against headers or body, only used to scope which requests this
  // rule degrades.
  method: string;
  probability: number;
  latencyMs: number;
  // #236: only meaningful for type 'hang'. 0 (the default) means never
  // released automatically — the request stays paused until the tester
  // aborts it client-side or navigates away. The renderer caps entry at
  // 600s; not re-validated here.
  releaseAfterMs?: number;
  enabled: boolean;
  hitCount: number;
  lastHitAt: number | null;
  // Provenance from the captured call this rule was created from — read-only
  // display in the panel, never sent anywhere and never part of matching.
  // Undefined for a rule composed by hand.
  requestHeaders?: Record<string, string>;
  requestBody?: string;
}

// Pulled out as a pure function so the method-scoping this ticket (#181)
// adds is unit-testable without the CDP debugger/session plumbing around it.
// A missing/'*' method matches every method, same as before this field
// existed — never matched against headers or body, only method + URL.
export function resilienceRuleMatchesRequest(rule: ResilienceRule, request: { method: string; url: string }): boolean {
  return (!rule.method || rule.method === '*' || rule.method === request.method) && matchesGlob(rule.urlPattern, request.url);
}

// #236: matching rules are tried in list order, each rolling its own
// probability — the first whose roll succeeds is returned. A rule whose
// roll fails is skipped, not removed from consideration entirely: it simply
// doesn't win this request, and a later matching rule still gets its own
// independent roll. `rand` is injectable so this is deterministically
// testable; defaults to Math.random for real traffic.
export function pickResilienceRule(
  rules: ResilienceRule[],
  request: { method: string; url: string },
  rand: () => number = Math.random
): ResilienceRule | null {
  for (const rule of rules) {
    if (!rule.enabled || !resilienceRuleMatchesRequest(rule, request)) continue;
    if (rand() < rule.probability) return rule;
  }
  return null;
}

export class ResilienceManager {
  private rulesByPartition = new Map<string, ResilienceRule[]>();

  // Seeds an empty rule bucket for a partition that's never had one — called
  // once, from SessionManager.createSession(), for the first tab ever to
  // represent a given partition. A partition that already has an entry
  // (reopen, "New tab in this session") is left alone.
  ensurePartition(partition: string): void {
    if (!this.rulesByPartition.has(partition)) this.rulesByPartition.set(partition, []);
  }

  getRules(partition: string): ResilienceRule[] {
    let rules = this.rulesByPartition.get(partition);
    if (!rules) { rules = []; this.rulesByPartition.set(partition, rules); }
    return rules;
  }

  getEnabledRules(partition: string): ResilienceRule[] {
    return (this.rulesByPartition.get(partition) ?? []).filter(r => r.enabled);
  }

  pickMatch(partition: string, request: { method: string; url: string }, rand?: () => number): ResilienceRule | null {
    return pickResilienceRule(this.rulesByPartition.get(partition) ?? [], request, rand);
  }

  recordHit(rule: ResilienceRule): void {
    rule.hitCount = (rule.hitCount || 0) + 1;
    rule.lastHitAt = Date.now();
  }

  add(partition: string, rule: ResilienceRule): void {
    const rules = this.getRules(partition);
    rules.push({ ...rule, method: rule.method || '*', hitCount: 0, lastHitAt: null });
  }

  remove(partition: string, ruleId: string): void {
    this.rulesByPartition.set(partition, (this.rulesByPartition.get(partition) ?? []).filter(r => r.id !== ruleId));
  }

  // Returns the matched rule (already mutated in place), or null if nothing
  // matched — callers use this to decide whether a CDP re-application /
  // log entry is warranted, matching the original inline implementation.
  toggle(partition: string, ruleId: string, enabled: boolean): ResilienceRule | null {
    const rule = this.getRules(partition).find(r => r.id === ruleId);
    if (rule) rule.enabled = enabled;
    return rule ?? null;
  }

  update(partition: string, ruleId: string, patch: Partial<ResilienceRule>): ResilienceRule | null {
    const rule = this.getRules(partition).find(r => r.id === ruleId);
    if (rule) Object.assign(rule, patch);
    return rule ?? null;
  }

  // #269: deep-copies a source partition's rules into a destination partition
  // as an independent set — mutating either side afterward never affects the
  // other.
  cloneInto(destPartition: string, srcPartition: string): void {
    this.rulesByPartition.set(destPartition, structuredClone(this.rulesByPartition.get(srcPartition) ?? []));
  }
}
