import { formatSize, getHeader } from './utils.js';

// #300: the Network tab's row model. One row per request: the request event
// carries method/url/type, and the response (status, timing, size) and any
// failure are paired in by requestId. Pure so it can be unit-tested.

// "315 ms" below a second, "2.00 s" from one second up.
export function formatDuration(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

// Content-Length of a response's headers as a number, or null when absent.
export function responseSize(headers) {
  const raw = getHeader(headers, 'content-length');
  const n = raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Lower-case resource type for the Type column ("document", "script", "fetch"…),
// from CDP's own request type, falling back to the MIME subtype.
export function resourceTypeLabel(cdpType, mimeType) {
  if (cdpType) return String(cdpType).toLowerCase();
  const sub = String(mimeType || '').split(';')[0].split('/')[1];
  return sub || '';
}

// Splits a URL into the Name column's path (+query) and its host. Anything
// that isn't a parseable URL is shown whole as the name.
export function splitUrl(url) {
  try {
    const u = new URL(url);
    const name = (u.pathname || '/') + u.search;
    return { name, host: u.host };
  } catch {
    return { name: String(url ?? ''), host: '' };
  }
}

/**
 * @param {{ requestId?: string, type?: string, request?: { method?: string, url?: string } }} req parsed network-request payload
 * @param {{ status?: number|null, durationMs?: number, size?: number|null, mimeType?: string }|undefined} res paired response, if it has arrived
 * @param {string|undefined} errorText loadingFailed's errorText, if the request failed
 * @param {'mock'|'resilience'|null} tag
 */
export function buildNetworkRow(req, res, errorText, tag) {
  const url = req.request?.url ?? '';
  const { name, host } = splitUrl(url);
  const status = typeof res?.status === 'number' ? res.status : null;
  const failed = errorText !== undefined;
  return {
    requestId: req.requestId,
    method: req.request?.method ?? '',
    url,
    name,
    host,
    status,
    failed,
    errorText: failed ? errorText : '',
    isError: failed || (status !== null && status >= 400),
    type: resourceTypeLabel(req.type, res?.mimeType),
    size: typeof res?.size === 'number' ? res.size : null,
    sizeLabel: typeof res?.size === 'number' ? formatSize(res.size) : '',
    durationMs: typeof res?.durationMs === 'number' ? res.durationMs : null,
    tag: tag ?? null,
  };
}
