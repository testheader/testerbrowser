import type { EventRow } from './recorder';

// Pure HAR 1.2 builder — no Electron imports, so it's usable from a plain
// Jest environment. See #232: rows come from SessionRecorder.getAllNetworkRows(),
// which stores the raw CDP event params (plus a couple of recorder-added
// fields like durationMs) as JSON, one row per event.

export interface HarHeader { name: string; value: string; }
export interface HarQueryParam { name: string; value: string; }
export interface HarCookie { name: string; value: string; }
export interface HarPostData { mimeType: string; text: string; }

export interface HarRequest {
  method: string;
  url: string;
  httpVersion: string;
  headers: HarHeader[];
  queryString: HarQueryParam[];
  cookies: HarCookie[];
  headersSize: number;
  bodySize: number;
  postData?: HarPostData;
}

export interface HarContent {
  size: number;
  mimeType: string;
  text?: string;
  encoding?: string;
}

export interface HarResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  headers: HarHeader[];
  cookies: HarCookie[];
  content: HarContent;
  redirectURL: string;
  headersSize: number;
  bodySize: number;
  _error?: string;
}

export interface HarTimings {
  blocked: number;
  dns: number;
  connect: number;
  ssl: number;
  send: number;
  wait: number;
  receive: number;
}

export interface HarEntry {
  pageref: string;
  startedDateTime: string;
  time: number;
  request: HarRequest;
  response: HarResponse;
  cache: object;
  timings: HarTimings;
}

export interface HarPage {
  startedDateTime: string;
  id: string;
  title: string;
  pageTimings: { onContentLoad: number; onLoad: number };
}

export interface Har {
  log: {
    version: string;
    creator: { name: string; version: string };
    pages: HarPage[];
    entries: HarEntry[];
  };
}

type CdpHeaders = Record<string, string>;

interface CdpTiming {
  requestTime?: number;
  dnsStart?: number; dnsEnd?: number;
  connectStart?: number; connectEnd?: number;
  sslStart?: number; sslEnd?: number;
  sendStart?: number; sendEnd?: number;
  receiveHeadersEnd?: number;
}

interface CdpRequest {
  url: string;
  method: string;
  headers?: CdpHeaders;
  postData?: string;
  hasPostData?: boolean;
}

interface CdpResponse {
  url: string;
  status: number;
  statusText?: string;
  headers?: CdpHeaders;
  mimeType?: string;
  protocol?: string;
  timing?: CdpTiming;
  encodedDataLength?: number;
}

interface RequestWillBeSentPayload {
  requestId: string;
  request: CdpRequest;
  redirectResponse?: CdpResponse;
}

interface ResponseReceivedPayload {
  requestId: string;
  response: CdpResponse;
  durationMs?: number;
}

interface LoadingFailedPayload {
  requestId: string;
  errorText: string;
  canceled?: boolean;
}

interface BodyPayload {
  requestId: string;
  base64Encoded: boolean;
  body: string;
}

function parsePayload<T>(row: EventRow): T | null {
  try {
    return JSON.parse(row.payload) as T;
  } catch {
    return null;
  }
}

function headersToArray(headers?: CdpHeaders): HarHeader[] {
  if (!headers) return [];
  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));
}

function findHeader(headers: CdpHeaders | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

function parseQueryString(url: string): HarQueryParam[] {
  try {
    const u = new URL(url);
    return Array.from(u.searchParams.entries()).map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function parseCookiePairs(raw: string, separator: string): HarCookie[] {
  return raw
    .split(separator)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((pair) => {
      const [namePart] = pair.split(';'); // drop Set-Cookie attributes (Path, Expires, ...)
      const idx = namePart.indexOf('=');
      return idx === -1
        ? { name: namePart.trim(), value: '' }
        : { name: namePart.slice(0, idx).trim(), value: namePart.slice(idx + 1).trim() };
    })
    .filter((c) => c.name);
}

function requestBodySize(req: CdpRequest): number {
  if (typeof req.postData === 'string') return Buffer.byteLength(req.postData, 'utf-8');
  return req.hasPostData ? -1 : 0;
}

function httpVersionFromProtocol(protocol?: string): string {
  if (!protocol) return 'HTTP/1.1';
  const p = protocol.toLowerCase();
  if (p === 'h2' || p === 'http/2' || p === 'http/2.0') return 'HTTP/2';
  if (p === 'h3' || p.startsWith('http/3')) return 'HTTP/3';
  if (p.startsWith('http/')) return p.toUpperCase();
  return protocol;
}

function timeSpan(start: number | undefined, end: number | undefined): number {
  return typeof start === 'number' && typeof end === 'number' && start >= 0 && end >= 0 ? end - start : -1;
}

function buildTimings(timing?: CdpTiming): HarTimings {
  if (!timing) return { blocked: -1, dns: -1, connect: -1, ssl: -1, send: -1, wait: -1, receive: -1 };
  return {
    // CDP's ResourceTiming has no distinct queueing phase to derive this
    // from — left unknown rather than guessed.
    blocked: -1,
    dns: timeSpan(timing.dnsStart, timing.dnsEnd),
    connect: timeSpan(timing.connectStart, timing.connectEnd),
    ssl: timeSpan(timing.sslStart, timing.sslEnd),
    send: timeSpan(timing.sendStart, timing.sendEnd),
    wait: timeSpan(timing.sendEnd, timing.receiveHeadersEnd),
    // Body-download timing needs Network.loadingFinished's own timestamp,
    // which the recorder doesn't currently store as a distinct event.
    receive: -1,
  };
}

function buildRequest(req: CdpRequest, response: CdpResponse | undefined): HarRequest {
  const out: HarRequest = {
    method: req.method,
    url: req.url,
    httpVersion: httpVersionFromProtocol(response?.protocol),
    headers: headersToArray(req.headers),
    queryString: parseQueryString(req.url),
    cookies: (() => {
      const cookieHeader = findHeader(req.headers, 'cookie');
      return cookieHeader ? parseCookiePairs(cookieHeader, ';') : [];
    })(),
    headersSize: -1,
    bodySize: requestBodySize(req),
  };
  if (typeof req.postData === 'string') {
    out.postData = {
      mimeType: findHeader(req.headers, 'content-type') || 'application/octet-stream',
      text: req.postData,
    };
  }
  return out;
}

function emptyResponse(): HarResponse {
  return {
    status: 0, statusText: '', httpVersion: 'HTTP/1.1',
    headers: [], cookies: [], content: { size: 0, mimeType: '' },
    redirectURL: '', headersSize: -1, bodySize: -1,
  };
}

function buildResponse(opts: {
  response?: CdpResponse;
  redirectURL: string;
  failed?: LoadingFailedPayload;
  body?: BodyPayload;
}): HarResponse {
  const { response, redirectURL, failed, body } = opts;
  if (failed) return { ...emptyResponse(), _error: failed.errorText };
  if (!response) return emptyResponse();

  const bodySize = body
    ? (body.base64Encoded ? Buffer.from(body.body, 'base64').length : Buffer.byteLength(body.body, 'utf-8'))
    : (typeof response.encodedDataLength === 'number' ? response.encodedDataLength : -1);
  const setCookieHeader = findHeader(response.headers, 'set-cookie');

  const content: HarContent = { size: Math.max(bodySize, 0), mimeType: response.mimeType || '' };
  if (body) {
    content.text = body.body;
    if (body.base64Encoded) content.encoding = 'base64';
  }

  return {
    status: response.status,
    statusText: response.statusText || '',
    httpVersion: httpVersionFromProtocol(response.protocol),
    headers: headersToArray(response.headers),
    // Chrome's CDP merges multiple Set-Cookie response headers into one
    // string joined by newlines.
    cookies: setCookieHeader ? parseCookiePairs(setCookieHeader, '\n') : [],
    content,
    redirectURL,
    headersSize: -1,
    bodySize,
  };
}

/** Builds a HAR 1.2 document from a session's stored network-* rows.
 *  A redirected request produces one entry per hop: CDP re-fires
 *  requestWillBeSent for the same requestId on each hop, carrying the
 *  previous hop's response as redirectResponse. */
export function buildHar(rows: EventRow[], meta: { creatorVersion: string; pageUrl?: string }): Har {
  const requestRows: { row: EventRow; data: RequestWillBeSentPayload }[] = [];
  const responseByReqId = new Map<string, { row: EventRow; data: ResponseReceivedPayload }>();
  const failedByReqId = new Map<string, LoadingFailedPayload>();
  const bodyByReqId = new Map<string, BodyPayload>();

  for (const row of rows) {
    if (row.kind === 'network-request') {
      const data = parsePayload<RequestWillBeSentPayload>(row);
      if (data?.requestId && data.request) requestRows.push({ row, data });
    } else if (row.kind === 'network-response') {
      const data = parsePayload<ResponseReceivedPayload>(row);
      if (data?.requestId) responseByReqId.set(data.requestId, { row, data });
    } else if (row.kind === 'network-failed') {
      const data = parsePayload<LoadingFailedPayload>(row);
      if (data?.requestId) failedByReqId.set(data.requestId, data);
    } else if (row.kind === 'network-body') {
      const data = parsePayload<BodyPayload>(row);
      if (data?.requestId) bodyByReqId.set(data.requestId, data);
    }
  }

  const hopsByReqId = new Map<string, { row: EventRow; data: RequestWillBeSentPayload }[]>();
  for (const r of requestRows) {
    const list = hopsByReqId.get(r.data.requestId) ?? [];
    list.push(r);
    hopsByReqId.set(r.data.requestId, list);
  }

  const entries: HarEntry[] = [];
  const pageId = 'page_1';

  for (const hops of hopsByReqId.values()) {
    for (let i = 0; i < hops.length; i++) {
      const hop = hops[i];
      const isLastHop = i === hops.length - 1;

      let response: CdpResponse | undefined;
      let redirectURL = '';
      let time = 0;
      let failed: LoadingFailedPayload | undefined;
      let body: BodyPayload | undefined;

      if (!isLastHop) {
        const nextHop = hops[i + 1];
        response = nextHop.data.redirectResponse;
        redirectURL = nextHop.data.request.url;
        time = Math.max(0, nextHop.row.ts - hop.row.ts);
      } else {
        const resEntry = responseByReqId.get(hop.data.requestId);
        const failEntry = failedByReqId.get(hop.data.requestId);
        if (resEntry) {
          response = resEntry.data.response;
          time = typeof resEntry.data.durationMs === 'number'
            ? resEntry.data.durationMs
            : Math.max(0, resEntry.row.ts - hop.row.ts);
          body = bodyByReqId.get(hop.data.requestId);
        } else if (failEntry) {
          failed = failEntry;
          time = 0; // network-failed rows carry no matching later row to diff against
        }
      }

      entries.push({
        pageref: pageId,
        startedDateTime: new Date(hop.row.ts).toISOString(),
        time,
        request: buildRequest(hop.data.request, response),
        response: buildResponse({ response, redirectURL, failed, body }),
        cache: {},
        timings: buildTimings(response?.timing),
      });
    }
  }

  entries.sort((a, b) => new Date(a.startedDateTime).getTime() - new Date(b.startedDateTime).getTime());

  return {
    log: {
      version: '1.2',
      creator: { name: 'TesterBrowser', version: meta.creatorVersion },
      pages: [{
        startedDateTime: rows.length ? new Date(rows[0].ts).toISOString() : new Date().toISOString(),
        id: pageId,
        title: meta.pageUrl || 'Session',
        pageTimings: { onContentLoad: -1, onLoad: -1 },
      }],
      entries,
    },
  };
}
