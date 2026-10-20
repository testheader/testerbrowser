/* global testerBrowser */
import { escHtml, getEventTabId, getHeader, timingBars, toCurl, toFetch, parseCookieHeader, parseSetCookies, formatSize } from './utils.js';
import { formatDuration, responseSize, resourceTypeLabel } from './network-rows.js';
import { getTimelineEvents } from './timeline.js';
import { getActiveConsoleTab } from './console-tabs.js';
import { openMockFromRequest } from './mock.js';
import { openResilienceFromRequest } from './resilience.js';
import { openReplay } from './replay.js';
import { getActiveId } from './tabs.js';

// detail-panel.js owns the single open detail item (#301: one request at a
// time, shown with Headers / Response / Timing / Cookies section tabs instead
// of one tab per opened request) and the selected section — nothing outside
// this file touches them; console-tabs.js and timeline.js only need read
// access, via getDetailTabsCount()/isDetailTabActive() below.
/** @type {{ id: string, event: any, fetchedPostData?: string | false | null } | null} */
let current = null;
let activeSection = 'headers';

export function getDetailTabsCount() { return current ? 1 : 0; }
export function isDetailTabActive(tabId) { return current?.id === tabId; }

function statusClass(code) {
  if (!code) return 'detail-status-err';
  if (code < 300) return 'detail-status-ok';
  if (code < 400) return 'detail-status-redir';
  return 'detail-status-err';
}

// #261: a request with hasPostData:true and no inline postData (CDP omits it
// for large/multipart bodies) needs a separate Network.getRequestPostData
// round-trip. Cached on the open item itself so it naturally goes away when
// the item is replaced or closed, and is fetched at most once per item
// regardless of how many times the pane re-renders while it's in flight.
async function fetchPostDataFor(item, requestId) {
  try {
    const result = await testerBrowser.recording.getRequestPostData(getActiveId(), requestId);
    item.fetchedPostData = (result && typeof result.postData === 'string') ? result.postData : false;
  } catch {
    item.fetchedPostData = false;
  }
  if (current === item) renderDetailPanel();
}

export function openDetailTab(e) {
  const tabId = getEventTabId(e);
  if (current?.id !== tabId) current = { id: tabId, event: e };
  renderDetailPanel();
}

export function closeDetailTab(tabId) {
  if (!current || current.id !== tabId) return;
  current = null;
  renderDetailPanel();
}

// #261: called by tabs.js on every session switch, alongside
// resetTimelineForNewSession() — the open item belongs to whichever session
// was active when it was opened, so switching sessions without clearing it
// left a stale request showing (and Replay/Mock/Resilience acting on the
// wrong tab).
export function clearDetailTabs() {
  current = null;
  renderDetailPanel();
}

/**
 * Everything the pane shows for one network request, gathered from the
 * recorded events that share its requestId.
 */
function collectRequestView(item) {
  const rid = item.id;
  const timelineEvents = getTimelineEvents();
  // #261: a redirect chain shares one CDP requestId across every hop, so
  // more than one network-request event can share this id — ordered oldest
  // first, the *last* one is the final hop, which is what the Request/
  // Response sections describe. Earlier hops only feed the Redirect Chain.
  const reqEvts = timelineEvents
    .filter(ev => ev.kind === 'network-request' && getEventTabId(ev) === rid)
    .sort((a, b) => (a.id ?? a.ts) - (b.id ?? b.ts));
  const reqEvt  = reqEvts[reqEvts.length - 1];
  const resEvt  = timelineEvents.find(ev => ev.kind === 'network-response' && getEventTabId(ev) === rid);
  const bodyEvt = timelineEvents.find(ev => ev.kind === 'network-body'     && getEventTabId(ev) === rid);
  const failEvt = timelineEvents.find(ev => ev.kind === 'network-failed'   && getEventTabId(ev) === rid);

  const reqPayload = reqEvt?.payload ? JSON.parse(reqEvt.payload) : null;
  const req = reqPayload?.request || null;
  const resPayload = resEvt?.payload ? JSON.parse(resEvt.payload) : null;
  const res = resPayload ? (resPayload.response || {}) : null;
  const failPayload = failEvt?.payload ? JSON.parse(failEvt.payload) : null;
  // #260: Set-Cookie/Cookie never appear on the base request/response events —
  // only on the separate ...ExtraInfo events, merged in by the recorder as a
  // sibling `extraInfoHeaders` field. Merge it back over the base headers so
  // the tables show the real wire headers.
  const reqHeaders = req ? { ...(req.headers || {}), ...(reqPayload.extraInfoHeaders || {}) } : {};
  const resHeaders = res ? { ...(res.headers || {}), ...(resPayload.extraInfoHeaders || {}) } : {};

  /** @type {{ method: string, url: string, requestHeaders: Record<string, string>, requestBody: string | null, statusCode?: number, responseHeaders?: Record<string, string>, body?: string, bodyUnavailable?: boolean } | null} */
  let mockData = null;
  if (req) {
    mockData = { method: req.method, url: req.url, requestHeaders: req.headers || {}, requestBody: req.postData || null };
    if (res) { mockData.statusCode = res.status; mockData.responseHeaders = res.headers || {}; }
  }
  const bp = bodyEvt?.payload ? JSON.parse(bodyEvt.payload) : null;
  // A base64 body is binary (an image, a font, ...) — Mock's body field is
  // plain text that gets base64-encoded fresh when the rule fires, so stuffing
  // already-encoded bytes in there would double-encode and serve garbage.
  // Leave it unset; bodyUnavailable turns into a note in the Mock panel.
  if (mockData && bp && !bp.base64Encoded) mockData.body = String(bp.body || '');
  if (mockData && mockData.body === undefined && (resEvt || failEvt)) mockData.bodyUnavailable = true;

  return { reqEvts, reqEvt, resEvt, failEvt, req, reqPayload, res, resPayload, failPayload, reqHeaders, resHeaders, bp, mockData };
}

function headerCount(h) { return Object.keys(h).length; }

function cookieCounts(v) {
  const sent = parseCookieHeader(getHeader(v.reqHeaders, 'cookie'));
  const set = parseSetCookies(getHeader(v.resHeaders, 'set-cookie'));
  return { sent, set, total: sent.length + set.length };
}

function sectionTabs(v) {
  const hdrs = headerCount(v.reqHeaders) + headerCount(v.resHeaders);
  const ck = cookieCounts(v).total;
  return [
    { key: 'headers', label: 'Headers', count: hdrs },
    { key: 'response', label: 'Response', count: 0 },
    { key: 'timing', label: 'Timing', count: 0 },
    { key: 'cookies', label: 'Cookies', count: ck },
  ];
}

function headerTable(headers) {
  let html = '<table class="headers-table">';
  for (const [k, val] of Object.entries(headers)) {
    html += `<tr><td>${escHtml(k)}</td><td>${escHtml(String(val))}</td></tr>`;
  }
  return html + '</table>';
}

// Native <details> keeps the groups collapsible and keyboard-accessible.
function headerGroup(title, headers) {
  const n = headerCount(headers);
  if (!n) return '';
  return `<details class="detail-section detail-group" open><summary><h3>${escHtml(title)}</h3><span class="detail-count">${n}</span></summary>${headerTable(headers)}</details>`;
}

function renderHeadersSection(v, item) {
  let html = '';
  if (v.reqEvts.length > 1) {
    // Each hop's outgoing status is the *next* hop's redirectResponse (CDP
    // attaches the previous hop's 3xx response to the following
    // requestWillBeSent) — the last hop's status comes from the final
    // response instead, since there's no further hop to carry it.
    const finalStatus = v.res ? v.res.status : undefined;
    const hops = v.reqEvts.map((ev, i) => {
      const hopReq = JSON.parse(ev.payload).request || {};
      // redirectResponse is a top-level field on requestWillBeSent's own
      // params, a sibling of `request` — not nested inside it.
      const status = i < v.reqEvts.length - 1
        ? JSON.parse(v.reqEvts[i + 1].payload).redirectResponse?.status
        : finalStatus;
      return { method: hopReq.method, url: hopReq.url, status };
    });
    html += `<div class="detail-section"><h3>Redirect Chain</h3><table class="headers-table">`;
    for (const hop of hops) {
      html += `<tr><td class="${statusClass(hop.status)}">${escHtml(hop.status !== null && hop.status !== undefined ? String(hop.status) : '—')}</td>` +
        `<td>${escHtml(hop.method || '')}</td><td>${escHtml(hop.url || '')}</td></tr>`;
    }
    html += `</table></div>`;
  }
  html += headerGroup('Response headers', v.resHeaders);
  html += headerGroup('Request headers', v.reqHeaders);
  if (v.req?.postData) {
    html += `<div class="detail-section"><h3>Request Body</h3><pre class="detail-body-pre">${escHtml(v.req.postData)}</pre></div>`;
  } else if (v.req?.hasPostData) {
    // #261: CDP omits postData inline for large/multipart bodies — fetch it
    // lazily via Network.getRequestPostData, once per open item.
    if (item.fetchedPostData === undefined) {
      item.fetchedPostData = null; // sentinel: fetch in flight
      fetchPostDataFor(item, item.id);
    }
    html += `<div class="detail-section"><h3>Request Body</h3>`;
    if (item.fetchedPostData === null) {
      html += `<div class="detail-note">Loading request body…</div>`;
    } else if (item.fetchedPostData === false) {
      html += `<div class="detail-note">Body no longer available</div>`;
    } else {
      html += `<pre class="detail-body-pre">${escHtml(item.fetchedPostData)}</pre>`;
    }
    html += `</div>`;
  }
  if (!html) html = `<div class="detail-empty">${v.failEvt ? 'No headers were received.' : 'Waiting for response…'}</div>`;
  return html;
}

function prettyBody(text, contentType) {
  if (contentType.includes('json') || /^[\s]*[[{]/.test(text)) {
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch { /* not JSON: show as-is */ }
  }
  return text;
}

function renderResponseSection(v) {
  let html = '';
  if (v.failPayload) {
    html += `<div class="detail-section"><h3 class="detail-err">Request Failed</h3>
      <div class="detail-err">${escHtml(v.failPayload.errorText || 'Unknown error')}</div>`;
    if (v.failPayload.canceled) html += `<div class="detail-note">Request was canceled</div>`;
    html += `</div>`;
  }
  if (v.bp) {
    const contentType = getHeader(v.res?.headers, 'content-type').toLowerCase();
    html += `<div class="detail-section"><h3>Response Body</h3>`;
    if (v.bp.omitted) {
      html += `<div class="detail-note">Binary body omitted (${Math.round(v.bp.size / 1024)} KB)</div>`;
    } else if (v.bp.base64Encoded && contentType.startsWith('image/')) {
      html += `<img class="detail-body-image" src="data:${escHtml(contentType)};base64,${v.bp.body}" alt="Response image preview" />`;
    } else {
      if (v.bp.base64Encoded) html += `<div class="detail-note">[base64 encoded]</div>`;
      const text = String(v.bp.body || '');
      html += `<pre class="detail-body-pre">${escHtml(v.bp.base64Encoded ? text : prettyBody(text, contentType))}</pre>`;
    }
    html += `</div>`;
  } else if (!v.failPayload) {
    html += `<div class="detail-empty">${v.resEvt ? 'No response body was captured.' : 'Waiting for response…'}</div>`;
  }
  return html;
}

function renderTimingSection(v) {
  if (!v.res?.timing) {
    return `<div class="detail-empty">${v.resEvt ? 'No timing data for this request.' : 'Waiting for response…'}</div>`;
  }
  const bars = timingBars(v.res.timing, v.resPayload?.durationMs);
  const total = bars.reduce((sum, b) => sum + (b.ms ?? 0), 0) || 1;
  let html = '<div class="detail-section detail-timing-section"><h3>Timing</h3>';
  for (const b of bars) {
    const pct = b.ms === null ? 0 : Math.max(b.ms > 0 ? 1 : 0, (b.ms / total) * 100);
    html += `<div class="detail-timing-row"><span class="detail-timing-label">${escHtml(b.label)}</span>` +
      `<span class="detail-timing-track"><span class="detail-timing-bar${b.key === 'wait' ? ' ttfb' : ''}" style="width:${pct.toFixed(1)}%"></span></span>` +
      `<span class="detail-timing-ms">${b.ms === null ? '—' : `${Math.round(b.ms)} ms`}</span></div>`;
  }
  return html + '</div>';
}

function renderCookiesSection(v) {
  const { sent, set } = cookieCounts(v);
  if (!sent.length && !set.length) {
    return '<div class="detail-empty">No cookies were sent or set by this request.</div>';
  }
  let html = '';
  if (sent.length) {
    html += `<div class="detail-section"><h3>Sent cookies</h3><table class="headers-table">`;
    for (const c of sent) html += `<tr><td>${escHtml(c.name)}</td><td>${escHtml(c.value)}</td></tr>`;
    html += `</table></div>`;
  }
  if (set.length) {
    html += `<div class="detail-section"><h3>Set cookies</h3><table class="headers-table">`;
    for (const c of set) {
      html += `<tr><td>${escHtml(c.name)}</td><td>${escHtml(c.value)}${c.attrs.length ? `<div class="detail-cookie-attrs">${escHtml(c.attrs.join('; '))}</div>` : ''}</td></tr>`;
    }
    html += `</table></div>`;
  }
  return html;
}

function pillHtml(v) {
  if (v.failPayload) return `<span class="detail-pill err">${escHtml(v.failPayload.errorText || 'Request failed')}</span>`;
  if (v.res) {
    const status = v.res.status;
    const cls = status >= 400 ? 'err' : status >= 300 ? 'warn' : 'ok';
    return `<span class="detail-pill ${cls}">${escHtml(`${status ?? ''} ${v.res.statusText || ''}`.trim())}</span>`;
  }
  return `<span class="detail-pill pending">Pending</span>`;
}

function metaText(v) {
  const parts = [];
  if (typeof v.resPayload?.durationMs === 'number') parts.push(formatDuration(v.resPayload.durationMs));
  const size = responseSize(v.res?.headers);
  if (size !== null) parts.push(formatSize(size));
  const type = resourceTypeLabel(v.reqPayload?.type, v.res?.mimeType);
  if (type) parts.push(type);
  return parts.join(' · ');
}

function actionButtons() {
  return `<div class="detail-actions">
    <button class="detail-action-btn strong" id="detailReplayBtn" title="Edit and replay this request"><i class="icon-rotate-ccw" aria-hidden="true"></i>Replay</button>
    <button class="detail-action-btn" id="detailMockBtn" title="Send this call's method, URL, status and body to the Mock panel"><i class="icon-replace" aria-hidden="true"></i>Mock</button>
    <button class="detail-action-btn" id="detailResilienceBtn" title="Send this call's method and URL to the Resilience panel"><i class="icon-zap-off" aria-hidden="true"></i>Resilience</button>
    <button class="detail-action-btn" id="detailCurlBtn" title="Copy this request as a curl command"><i class="icon-copy" aria-hidden="true"></i>Copy as cURL</button>
    <button class="detail-action-btn" id="detailFetchBtn" title="Copy this request as a fetch() call"><i class="icon-copy" aria-hidden="true"></i>Copy as fetch</button>
  </div>`;
}

function wireActions(v) {
  const mockData = v.mockData;
  if (!mockData) return;
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  on('detailMockBtn', () => openMockFromRequest(mockData.method, mockData.url, mockData.statusCode, mockData.body, {
    requestHeaders: mockData.requestHeaders,
    responseHeaders: mockData.responseHeaders,
    bodyUnavailable: !!mockData.bodyUnavailable,
  }));
  if (v.reqEvt) on('detailReplayBtn', () => openReplay(v.reqEvt, getActiveId()));
  on('detailResilienceBtn', () => openResilienceFromRequest(mockData.method, mockData.url, mockData.requestHeaders, mockData.requestBody));
  on('detailCurlBtn', () => testerBrowser.clipboard.write(toCurl({
    method: mockData.method, url: mockData.url, headers: mockData.requestHeaders, postData: mockData.requestBody,
  })));
  on('detailFetchBtn', () => testerBrowser.clipboard.write(toFetch({
    method: mockData.method, url: mockData.url, headers: mockData.requestHeaders, postData: mockData.requestBody,
  })));
}

function renderDetailPanelBody() {
  const header  = document.getElementById('detailPanelHeader');
  const bar     = document.getElementById('detailPanelTabBar');
  const content = document.getElementById('detailPanelContent');
  if (!current) { header.innerHTML = ''; bar.innerHTML = ''; content.innerHTML = ''; return; }

  const e = current.event;
  let v = null;
  try {
    if (e.kind.startsWith('network-')) v = collectRequestView(current);
  } catch { v = null; }

  const closeBtn = `<button class="detail-close" id="detailCloseBtn" title="Close" aria-label="Close details"><i class="icon-x" aria-hidden="true"></i></button>`;

  if (!v || !v.req) {
    // Not a request (console exception, …), or its request event is gone: a
    // single read-only view of the raw event.
    let p = null;
    try { p = e.payload ? JSON.parse(e.payload) : null; } catch { /* raw payload shown below */ }
    header.innerHTML = `<div class="detail-head-top"><span class="detail-meta">${escHtml(e.kind)}</span>${closeBtn}</div>`;
    bar.innerHTML = '';
    const tab = document.createElement('button');
    tab.className = 'detail-tab active';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', 'true');
    tab.title = e.summary;
    tab.textContent = e.kind;
    bar.appendChild(tab);
    content.innerHTML = `<div class="detail-section"><pre class="detail-body-pre">${escHtml(p ? JSON.stringify(p, null, 2) : (e.payload || e.summary))}</pre></div>`;
  } else {
    header.innerHTML = `<div class="detail-head-top">${pillHtml(v)}<span class="detail-meta">${escHtml(metaText(v))}</span>${closeBtn}</div>
      <div class="detail-urlline"><span class="detail-url-method">${escHtml(v.req.method || '?')}</span> <span class="detail-url">${escHtml(v.req.url || '')}</span></div>
      ${actionButtons()}`;
    wireActions(v);

    bar.innerHTML = '';
    for (const t of sectionTabs(v)) {
      const btn = document.createElement('button');
      btn.className = `detail-tab${t.key === activeSection ? ' active' : ''}`;
      btn.dataset.section = t.key;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', String(t.key === activeSection));
      btn.textContent = t.label;
      if (t.count) {
        const n = document.createElement('span');
        n.className = 'detail-tab-count';
        n.textContent = String(t.count);
        btn.appendChild(n);
      }
      btn.onclick = () => { activeSection = t.key; renderDetailPanel(); };
      bar.appendChild(btn);
    }

    try {
      content.innerHTML = activeSection === 'response' ? renderResponseSection(v)
        : activeSection === 'timing' ? renderTimingSection(v)
        : activeSection === 'cookies' ? renderCookiesSection(v)
        : renderHeadersSection(v, current);
    } catch {
      content.innerHTML = `<pre class="detail-body-pre">${escHtml(e.payload || e.summary)}</pre>`;
    }
  }
  document.getElementById('detailCloseBtn').onclick = () => closeDetailTab(current.id);
}

export function renderDetailPanel() {
  const panel        = document.getElementById('detailPanel');
  const resizeHandle = document.getElementById('detailPanelResizeHandle');
  // The timeline is shared by the Console and Network tabs, so rows on either
  // can open the pane. Security findings link back to the network event that
  // produced them, so the Security tab shares the same detail panel.
  const activeConsoleTab = getActiveConsoleTab();
  const showsDetail  = activeConsoleTab === 'console' || activeConsoleTab === 'network' || activeConsoleTab === 'security';
  const hasOpen      = !!current && showsDetail;
  panel.classList.toggle('open', hasOpen);
  resizeHandle.style.display = hasOpen ? 'block' : 'none';
  renderDetailPanelBody();
  // Update detail-row-active highlights without a full timeline re-render
  document.querySelectorAll('.evt').forEach(row => {
    row.classList.toggle('detail-row-active', isDetailTabActive(/** @type {HTMLElement} */ (row).dataset.tabId));
  });
}

export function initDetailPanel() {
  const handle = document.getElementById('detailPanelResizeHandle');
  const panel  = document.getElementById('detailPanel');
  const body   = document.getElementById('consolePanelBody');
  const MIN_W  = 120;

  try {
    const saved = localStorage.getItem('consoleDetailSplitRatio');
    if (saved) panel.style.width = saved;
  } catch {}

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panel.offsetWidth;
    const onMove = (ev) => {
      const maxW = (body.offsetWidth || window.innerWidth) - MIN_W;
      const newW = Math.max(MIN_W, Math.min(startW + (startX - ev.clientX), maxW));
      panel.style.width = newW + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      try { localStorage.setItem('consoleDetailSplitRatio', panel.style.width); } catch {}
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });
}
