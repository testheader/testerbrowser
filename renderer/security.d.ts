export interface SecurityFinding {
  severity: 'high' | 'medium' | 'low';
  url: string;
  issue: string;
  detail: string;
}

export interface TimelineEvent {
  kind: string;
  ts: number;
  summary: string;
  payload: string;
}

export function initSecurity(): void;
export function analyze(events: TimelineEvent[]): SecurityFinding[];
