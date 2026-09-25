export interface SecurityFinding {
  severity: 'high' | 'medium' | 'low';
  url: string;
  issue: string;
  detail: string;
  ruleId: string;
}

export interface TimelineEvent {
  kind: string;
  ts: number;
  summary: string;
  payload: string;
}

export interface SecurityAnalyzeResult {
  findings: SecurityFinding[];
  skipped: { cookieRulesRedacted: boolean };
}

export function initSecurity(): void;
export function analyze(
  events: TimelineEvent[],
  enabledRuleIds?: Set<string>,
  options?: { includeSubresources?: boolean }
): SecurityAnalyzeResult;
export function computeEnabledRuleIds(overrides: Record<string, boolean> | undefined): Set<string>;
export function computeGroupCheckState(
  rules: { id: string }[],
  overrides: Record<string, boolean> | undefined
): 'checked' | 'unchecked' | 'indeterminate';
