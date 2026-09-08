export function escHtml(str: unknown): string;

export interface TimelineEventLike {
  kind: string;
  ts: number;
  summary: string;
  payload?: string;
}

export function getEventTabId(e: TimelineEventLike): string;
export function getHeader(headers: Record<string, unknown> | undefined | null, name: string): string;
export function getConsoleLevel(e: TimelineEventLike): string | null;
export function wirePillGroup(containerEl: Element, onChange: () => void): void;
export function activePillValues(containerEl: Element, dataAttr: string): Set<string>;
export function cookieMatchesDomain(cookie: { domain?: string }, hostname: string): boolean;
export function matchesFreeText(text: string, filterText: string): boolean;
export function looksLikeUrl(v: string): boolean;
export function buildSearchUrl(engine: string, query: string): string;
