import { BrowserWindow, dialog } from 'electron';
import fs from 'fs';
import {
  Rule, RuleAction, CookieRecord, ImportableRule,
  applyRulePatch, findCorsPreflightRule, moveInArray, normalizeRule, pickRule, reorderArray, validateImportedRules,
} from './rules';

/**
 * Owns Rule storage and matching (#370 — replaces MockManager and
 * ResilienceManager). Rules are keyed by session *partition*, not by tab id:
 * several tabs sharing one partition (a middle-clicked link, a reopened tab, a
 * tab in another window) share one ordered rule list. Callers resolve a tab id
 * to its partition and talk to this class purely in terms of partitions.
 *
 * The CDP interception point itself (Fetch.requestPaused) stays in
 * SessionManager — this class only owns storage, ordering and matching.
 */

export type ImportPromptResult =
  | { canceled: true }
  | { error: string }
  | { rules: ImportableRule[]; skipped: { index: number; reason: string }[] };

export class RulesManager {
  private win: BrowserWindow;
  private rulesByPartition: Map<string, Rule[]>;

  // rulesByPartition is shared by every window's manager when given (#367).
  constructor(win: BrowserWindow, rulesByPartition: Map<string, Rule[]> = new Map()) {
    this.win = win;
    this.rulesByPartition = rulesByPartition;
  }

  // Seeds an empty list for a partition that has never had one; a partition
  // that already has an entry (reopen, "New tab in this session") is left alone.
  ensurePartition(partition: string): void {
    if (!this.rulesByPartition.has(partition)) this.rulesByPartition.set(partition, []);
  }

  getRules(partition: string): Rule[] {
    let rules = this.rulesByPartition.get(partition);
    if (!rules) { rules = []; this.rulesByPartition.set(partition, rules); }
    return rules;
  }

  getEnabledRules(partition: string): Rule[] {
    return (this.rulesByPartition.get(partition) ?? []).filter((r) => r.enabled);
  }

  // Raw read with no lazy-creation side effect — for saveSessions().
  peek(partition: string): Rule[] | undefined {
    return this.rulesByPartition.get(partition);
  }

  // Overwrites a partition's rules wholesale (restoring persisted rules).
  // Hit stats are not worth restoring across a restart.
  restorePartition(partition: string, rules: Rule[]): void {
    this.rulesByPartition.set(partition, rules.map((r) => ({ ...r, hitCount: 0, lastHitAt: null })));
  }

  // Deep copy: mutating either side afterwards never affects the other.
  cloneInto(destPartition: string, srcPartition: string): void {
    this.rulesByPartition.set(destPartition, structuredClone(this.rulesByPartition.get(srcPartition) ?? []));
  }

  // Shared by the Fetch.requestPaused handler and the recording:replay IPC.
  pick(partition: string, request: { method: string; url: string }, rand?: () => number): Rule | null {
    return pickRule(this.rulesByPartition.get(partition) ?? [], request, rand);
  }

  findCorsPreflightMatch(partition: string, url: string): Rule | null {
    return findCorsPreflightRule(this.rulesByPartition.get(partition) ?? [], url);
  }

  recordHit(rule: Rule): void {
    rule.hitCount = (rule.hitCount || 0) + 1;
    rule.lastHitAt = Date.now();
  }

  add(partition: string, rule: Partial<Rule> & { id: string; action: RuleAction }): void {
    this.getRules(partition).push(normalizeRule(rule));
  }

  remove(partition: string, ruleId: string): void {
    this.rulesByPartition.set(partition, (this.rulesByPartition.get(partition) ?? []).filter((r) => r.id !== ruleId));
  }

  // Returns the rule (mutated in place) or null if there was none, so the
  // caller can decide whether a CDP re-application / race-gate flush is due.
  toggle(partition: string, ruleId: string, enabled: boolean): Rule | null {
    const rule = this.getRules(partition).find((r) => r.id === ruleId);
    if (rule) rule.enabled = enabled;
    return rule ?? null;
  }

  // Returns the updated rule, or null when the rule is gone — the renderer
  // needs to tell "saved" apart from "silently did nothing".
  update(partition: string, ruleId: string, patch: Partial<Rule>): Rule | null {
    const rules = this.getRules(partition);
    const idx = rules.findIndex((r) => r.id === ruleId);
    if (idx === -1) return null;
    rules[idx] = applyRulePatch(rules[idx], patch);
    return rules[idx];
  }

  // Rules are matched in array order — this makes that order controllable.
  move(partition: string, ruleId: string, dir: 'up' | 'down'): void {
    const rules = this.rulesByPartition.get(partition);
    if (!rules) return;
    const idx = rules.findIndex((r) => r.id === ruleId);
    if (idx === -1) return;
    this.rulesByPartition.set(partition, moveInArray(rules, idx, dir));
  }

  // Drag and drop: the rule ends up at `toIndex`.
  reorder(partition: string, ruleId: string, toIndex: number): void {
    const rules = this.rulesByPartition.get(partition);
    if (!rules) return;
    const idx = rules.findIndex((r) => r.id === ruleId);
    if (idx === -1) return;
    this.rulesByPartition.set(partition, reorderArray(rules, idx, toIndex));
  }

  // Every rewrite rule (in any partition) that reads cookies from `sourcePartition`.
  rewriteRulesReadingFrom(sourcePartition: string): Rule[] {
    const out: Rule[] = [];
    for (const rules of this.rulesByPartition.values()) {
      for (const r of rules) {
        if (r.action.kind === 'rewrite' && r.action.cookies?.sourcePartition === sourcePartition) out.push(r);
      }
    }
    return out;
  }

  // Remembers the source jar's last state on every rule that reads from it.
  setCookieSnapshot(sourcePartition: string, cookies: CookieRecord[]): void {
    for (const r of this.rewriteRulesReadingFrom(sourcePartition)) {
      if (r.action.kind === 'rewrite' && r.action.cookies) r.action.cookies.snapshot = cookies;
    }
  }

  // id/hitCount/lastHitAt are run-local, and a cookie source is only
  // meaningful on this machine — the exported file keeps what's needed to
  // recreate the rules elsewhere.
  async exportRulesToFile(rules: Rule[]): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> {
    const result = await dialog.showSaveDialog(this.win, {
      title: 'Export rules',
      defaultPath: 'rules.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    try {
      const exportable = rules.map(({ id: _id, hitCount: _h, lastHitAt: _l, ...rest }) => {
        if (rest.action.kind === 'rewrite' && rest.action.cookies) {
          const { sourcePartition: _s, snapshot: _snap, ...cookies } = rest.action.cookies;
          return { ...rest, action: { ...rest.action, cookies } };
        }
        return rest;
      });
      fs.writeFileSync(result.filePath, JSON.stringify({ testerBrowserRules: 1, rules: exportable }, null, 2));
      return { ok: true, path: result.filePath };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // Prompts for a file and validates it, without touching any partition yet —
  // kept apart from appendImportedRules() so the caller can check the owning
  // session still exists in between.
  async promptAndValidateImportFile(): Promise<ImportPromptResult> {
    const result = await dialog.showOpenDialog(this.win, {
      title: 'Import rules',
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
    const { rules, skipped, error } = validateImportedRules(json);
    if (error) return { error };
    return { rules, skipped };
  }

  // Valid rules are appended (fresh ids) after what's already there; an
  // import never replaces or reorders. Returns the number appended.
  appendImportedRules(partition: string, rules: ImportableRule[]): number {
    const target = this.getRules(partition);
    for (const r of rules) {
      target.push(normalizeRule({ ...r, id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }));
    }
    return rules.length;
  }
}
