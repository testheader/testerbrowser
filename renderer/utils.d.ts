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
export const MOCK_STRIPPED_RESPONSE_HEADERS: string[];
export function matchesFreeText(text: string, filterText: string): boolean;
export function looksLikeUrl(v: string): boolean;
export function buildSearchUrl(engine: string, query: string): string;
export function mergeRecordedSteps<T>(localSteps: T[], remoteSteps: T[], receivedCount: number): T[];

export interface CopyableRequest {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  postData?: string;
}
export function toCurl(req: CopyableRequest): string;
export function toFetch(req: CopyableRequest): string;
export function stripRedactedHeaders(headers: Record<string, string> | undefined | null): Record<string, string>;
export function redactUrlForReport(url: string): string;

export interface ResourceTimingLike {
  dnsStart?: number;
  dnsEnd?: number;
  connectStart?: number;
  connectEnd?: number;
  sslStart?: number;
  sslEnd?: number;
  sendStart?: number;
  sendEnd?: number;
  receiveHeadersEnd?: number;
}
export interface TimingPhases {
  dns: number | null;
  connect: number | null;
  tls: number | null;
  send: number | null;
  wait: number | null;
  receive: number | null;
}
export function timingPhases(timing: ResourceTimingLike | undefined | null, durationMs: number | undefined): TimingPhases;
