/* global testerBrowser */
import { TIMELINE_MAX, TIMELINE_DOM_MAX } from './state.js';
import { getEventTabId, wirePillGroup, activePillValues, getConsoleLevel, matchesFreeText } from './utils.js';
import { openDetailTab, isDetailTabActive } from './detail-panel.js';
import { openReplay } from './replay.js';
import { getActiveId } from './tabs.js';
import { getActiveConsoleTab } from './console-tabs.js';

// timeline.js owns the recording ring buffer (timelineEvents), the polling
// cursor (lastTs) and the console panel's auto-scroll flag — nothing else
// reads or writes these directly. detail-panel.js reads the buffer through
// getTimelineEvents() to render a request/response's detail tab.
const timelineEvents = []; // ring buffer, max TIMELINE_MAX entries
let lastTs          = 0;
let autoScroll       = true;

// Only network-request payloads carry `request.method`/`request.url`
// directly; response/failed/body payloads only share the request's
// `requestId`. This maps one to the other so the method filter can hide a
// whole request+response(+body) group, not just the request line, and so a
// failed row's second line can show the URL even though loadingFailed's own
// CDP payload never carries it.
const requestMeta = new Map(); // requestId -> { method, url }
const KNOWN_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);

// Rows whose level falls outside these five pills (e.g. CDP Log's 'verbose',
// or console types like 'trace'/'table') stay visible regardless of pill
// state, same policy as the network method filter's "unresolvable stays
// visible" rule — nothing should silently vanish just because it doesn't
// fit one of the named buckets.
const KNOWN_LEVELS = new Set(['error', 'warn', 'info', 'log', 'debug']);
const INTERESTING_LOG_SOURCES = new Set(['security', 'network', 'deprecation', 'intervention']);

function getEventMethod(e) {
  if (!e.payload) return null;
  try {
    const p = JSON.parse(e.payload);
    const method = e.kind === 'network-request' ? p.request?.method : requestMeta.get(p.requestId)?.method;
    return method || null;
  } catch { return null; }
}

// The method shown on line 1: BODY rows always show the literal "BODY",
// never the underlying request's real method (that's what made "BODY POST"
// read like two unrelated tokens) — everything else uses the real method,
// falling back to "FAILED" for a failed row whose method never resolved
// (e.g. the request row itself never made it into the buffer).
function getEventDisplayMethod(e) {
  if (e.kind === 'network-body') return 'BODY';
  if (e.kind === 'network-request' || e.kind === 'network-response' || e.kind === 'network-failed') {
    return getEventMethod(e) || (e.kind === 'network-failed' ? 'FAILED' : null);
  }
  return null;
}

function getEventStatus(e) {
  if (e.kind !== 'network-response' || !e.payload) return null;
  try { return JSON.parse(e.payload).response?.status ?? null; } catch { return null; }
}

// The URL for line 2. network-response's own CDP payload does carry
// response.url, but network-failed's loadingFailed payload never carries a
// url at all — it's resolved from the request row recorded earlier via
// requestMeta instead of re-parsing the "FAILED <url>: <err>" summary text,
// which would be ambiguous for a URL that itself contains a colon or spaces.
function getEventUrl(e) {
  if (!e.payload) return null;
  try {
    const p = JSON.parse(e.payload);
    if (e.kind === 'network-request') return p.request?.url ?? null;
    if (e.kind === 'network-response') return p.response?.url ?? requestMeta.get(p.requestId)?.url ?? null;
    if (e.kind === 'network-failed') return requestMeta.get(p.requestId)?.url ?? null;
  } catch {}
  return null;
}

// The text rendered on line 2, below the hanging indent. Falls back to the
// stored summary for anything that doesn't resolve cleanly from payload —
// notably the synthetic "LOAD FAILED" row (sessions:loadFailed) which never
// carries a payload at all.
function getEventLine2(e) {
  if (e.kind === 'network-body' && e.payload) {
    try {
      const body = JSON.parse(e.payload).body;
      if (typeof body === 'string') return body;
    } catch {}
    return e.summary;
  }
  if (e.kind === 'network-request' || e.kind === 'network-response') {
    return getEventUrl(e) ?? e.summary;
  }
  if (e.kind === 'network-failed') {
    const url = getEventUrl(e);
    if (url && e.payload) {
      try {
        const errorText = JSON.parse(e.payload).errorText;
        if (errorText) return `${url}: ${errorText}`;
      } catch {}
    }
    return e.summary;
  }
  if (e.kind === 'console' || e.kind === 'log') {
    // Strips the "[level] " prefix that summary was built with — a fixed,
    // anchored-at-start prefix, so this is safe even when the message text
    // itself contains brackets or spaces (unlike splitting on whitespace).
    return e.summary.replace(/^\[[^\]]*\]\s?/, '');
  }
  return e.summary;
}


// <input type="datetime-local"> values (no timezone) are parsed by Date()
// as local time, matching how `new Date(e.ts).toLocaleTimeString()` already
// displays event timestamps in the timeline.
function parseLocalDatetime(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

export function getTimelineEvents() { return timelineEvents; }

export function renderTimeline() {
  const panel = document.getElementById('timelinePanel');
  const tab   = getActiveConsoleTab();

  let filtered;
  if (tab === 'network') {
    const netFilter    = document.getElementById('networkFilterText').value.toLowerCase();
    const activeTypes  = activePillValues(document.getElementById('networkPills'), 'type');
    const activeMethods = activePillValues(document.getElementById('networkMethodPills'), 'method');
    const minDuration  = parseFloat(document.getElementById('networkMinDuration').value) || 0;
    const fromTs       = parseLocalDatetime(document.getElementById('networkFromTs').value);
    const toTs         = parseLocalDatetime(document.getElementById('networkToTs').value);

    filtered = timelineEvents.filter(e => {
      const kindVisible = activeTypes.has(e.kind) ||
        (e.kind === 'network-body' && activeTypes.has('network-response'));
      if (!kindVisible) return false;

      const method = getEventMethod(e);
      const methodVisible = !method || activeMethods.has(KNOWN_METHODS.has(method) ? method : 'Other');
      if (!methodVisible) return false;

      if (minDuration > 0 && e.kind === 'network-response') {
        let durationMs = null;
        try { durationMs = JSON.parse(e.payload).durationMs; } catch {}
        if (typeof durationMs !== 'number' || durationMs < minDuration) return false;
      }

      if (fromTs !== null && e.ts < fromTs) return false;
      if (toTs !== null && e.ts > toTs) return false;

      if (!netFilter) return true;
      if (e.summary.toLowerCase().includes(netFilter)) return true;
      return !!e.payload && e.payload.toLowerCase().includes(netFilter);
    });
  } else {
    const filterText   = document.getElementById('filterText').value;
    const activeLevels = activePillValues(document.getElementById('consoleLevelPills'), 'level');
    const CONSOLE_KINDS = new Set(['console', 'log', 'exception']);
    filtered = timelineEvents.filter(e => {
      if (!CONSOLE_KINDS.has(e.kind)) return false;
      const level = getConsoleLevel(e);
      const levelVisible = !level || !KNOWN_LEVELS.has(level) || activeLevels.has(level);
      if (!levelVisible) return false;
      return matchesFreeText(e.summary, filterText);
    });
  }

  const kindCounts = {};
  for (const e of timelineEvents) kindCounts[e.kind] = (kindCounts[e.kind] || 0) + 1;
  document.querySelectorAll('#networkPills .filter-pill').forEach(btn => {
    const n    = kindCounts[btn.dataset.type] || 0;
    const span = btn.querySelector('.pill-count');
    if (span) span.textContent = n > 0 ? n : '';
  });

  const levelCounts = {};
  for (const e of timelineEvents) {
    const level = getConsoleLevel(e);
    if (level) levelCounts[level] = (levelCounts[level] || 0) + 1;
  }
  document.querySelectorAll('#consoleLevelPills .filter-pill').forEach(btn => {
    const n    = levelCounts[btn.dataset.level] || 0;
    const span = btn.querySelector('.pill-count');
    if (span) span.textContent = n > 0 ? n : '';
  });

  const visible = filtered.slice(-TIMELINE_DOM_MAX);
  panel.innerHTML = '';

  if (getActiveId() && timelineEvents.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'timeline-empty';
    empty.innerHTML = '<span class="timeline-empty-dot"></span><span>Recording — waiting for activity…</span>';
    panel.appendChild(empty);
    if (autoScroll) panel.scrollTop = panel.scrollHeight;
    return;
  }

  if (filtered.length > TIMELINE_DOM_MAX) {
    const msg = document.createElement('div');
    msg.className   = 'evt-overflow-msg';
    msg.textContent = `▲ ${filtered.length - TIMELINE_DOM_MAX} older events not shown — clear filter or console to see them`;
    panel.appendChild(msg);
  }

  for (const e of visible) {
    let subtypeClass = '';
    if (e.kind === 'console' || e.kind === 'log') {
      const level = getConsoleLevel(e);
      if (level) subtypeClass = ' console-' + level;
    }
    const tabId = getEventTabId(e);
    const line  = document.createElement('div');
    line.className       = `evt ${e.kind}${subtypeClass}`;
    line.dataset.kind    = e.kind;
    line.dataset.summary = e.summary;
    line.dataset.tabId   = tabId;
    if (isDetailTabActive(tabId)) line.classList.add('detail-row-active');

    // Line 1: timestamp, then method, status, badges and duration — a
    // fixed-width column so these line up down the whole list. Line 2
    // (built below) starts at the same offset as the method, not the
    // timestamp, giving the row its hanging indent.
    const line1 = document.createElement('div');
    line1.className = 'evt-line1';

    const d = new Date(e.ts);
    const pad = (n) => String(n).padStart(2, '0');
    const tsSpan = document.createElement('span');
    tsSpan.className = 'evt-ts';
    tsSpan.innerHTML = `[<span class="evt-ts-date">${pad(d.getMonth() + 1)}-${pad(d.getDate())}</span> ${d.toLocaleTimeString()}]`;
    line1.appendChild(tsSpan);

    const rest = document.createElement('div');
    rest.className = 'evt-line1-rest';

    const method = getEventDisplayMethod(e);
    if (method) {
      const methodSpan = document.createElement('span');
      methodSpan.className = 'evt-method';
      methodSpan.textContent = method;
      rest.appendChild(methodSpan);
    }

    const status = getEventStatus(e);
    if (status !== null) {
      const statusSpan = document.createElement('span');
      statusSpan.className = 'evt-status';
      statusSpan.textContent = String(status);
      rest.appendChild(statusSpan);
    }

    if ((e.kind === 'network-request' || e.kind === 'network-response' || e.kind === 'network-failed') && e.payload) {
      try {
        const p = JSON.parse(e.payload);
        if (p.mockRuleId) {
          const badge = document.createElement('span');
          badge.className = 'evt-badge evt-badge-mock';
          badge.textContent = 'MOCK';
          badge.title = 'Response served by a Mock rule instead of the real server';
          rest.appendChild(badge);
        } else if (p.resilienceRuleId) {
          const badge = document.createElement('span');
          badge.className = 'evt-badge evt-badge-resilience';
          badge.textContent = 'RESILIENCE';
          badge.title = `Altered by a Resilience rule (${p.resilienceType || 'unknown'})`;
          rest.appendChild(badge);
        }
      } catch {}
    }

    if (e.kind === 'log' && e.payload) {
      try {
        const source = JSON.parse(e.payload).entry?.source;
        if (INTERESTING_LOG_SOURCES.has(source)) {
          const badge = document.createElement('span');
          badge.className = 'evt-badge evt-badge-log-source';
          badge.textContent = source.toUpperCase();
          badge.title = `Log source: ${source}`;
          rest.appendChild(badge);
        }
      } catch {}
    }

    // Duration is only known once the response arrives (ts - matching
    // request's ts, computed in the recorder) — every other row kind,
    // including network-request/failed, leaves this column empty.
    if (e.kind === 'network-response' && e.payload) {
      let durationMs;
      try { durationMs = JSON.parse(e.payload).durationMs; } catch {}
      if (typeof durationMs === 'number' && Number.isFinite(durationMs)) {
        const durationEl = document.createElement('span');
        durationEl.className = 'evt-duration';
        durationEl.textContent = `${Math.round(durationMs)}ms`;
        rest.appendChild(durationEl);
      }
    }

    if (e.kind === 'network-request' && e.payload) {
      const replayBtn = document.createElement('button');
      replayBtn.className   = 'evt-replay-btn';
      replayBtn.textContent = '↺ Replay';
      replayBtn.title       = 'Edit and replay this request';
      replayBtn.onclick     = (ev) => { ev.stopPropagation(); openReplay(e); };
      rest.appendChild(replayBtn);
    }

    line1.appendChild(rest);
    line.appendChild(line1);

    // Line 2: the URL (or message, or response body for BODY rows), wrapped
    // under the method column instead of scrolling sideways.
    const line2 = document.createElement('div');
    line2.className = 'evt-line2';
    line2.textContent = getEventLine2(e);
    line.appendChild(line2);

    if (e.payload) {
      line.style.cursor = 'pointer';
      line.addEventListener('click', (ev) => {
        if (!ev.target.closest('.evt-replay-btn')) openDetailTab(e);
      });
    }

    panel.appendChild(line);
  }

  if (autoScroll) panel.scrollTop = panel.scrollHeight;
}

async function fetchTimeline() {
  const activeId = getActiveId();
  if (!activeId) return;
  const events = await testerBrowser.recording.timeline(activeId, { since: lastTs || undefined, limit: 200 });
  if (events.length > 0) {
    for (const e of events) {
      if (e.kind !== 'network-request' || !e.payload) continue;
      try {
        const p = JSON.parse(e.payload);
        if (p.requestId && p.request?.method) {
          requestMeta.set(p.requestId, { method: p.request.method, url: p.request.url });
        }
      } catch {}
    }
    timelineEvents.push(...events);
    if (timelineEvents.length > TIMELINE_MAX) {
      timelineEvents.splice(0, timelineEvents.length - TIMELINE_MAX);
    }
    lastTs = Math.max(lastTs, ...events.map(e => e.ts));
    renderTimeline();
  }
}

export async function pollTimeline() {
  await fetchTimeline();
  setTimeout(pollTimeline, 1000);
}

// Switching tabs clears the timeline and would otherwise sit empty for up to
// the full 1s polling interval before catching up — fetch immediately instead,
// independent of (and without disturbing) the recurring pollTimeline loop.
export function refreshTimelineNow() {
  fetchTimeline();
}

// Called by tabs.js on every session switch: the buffer and polling cursor
// are per-tab, so a switch discards whatever the previous tab had recorded.
export function resetTimelineForNewSession() {
  timelineEvents.length = 0;
  lastTs = 0;
  requestMeta.clear();
  document.getElementById('timelinePanel').innerHTML = '';
}

export function initTimeline() {
  const timelinePanel     = document.getElementById('timelinePanel');
  const scrollToBottomBtn = document.getElementById('scrollToBottomBtn');

  timelinePanel.addEventListener('scroll', () => {
    autoScroll = timelinePanel.scrollTop + timelinePanel.clientHeight >= timelinePanel.scrollHeight - 30;
    scrollToBottomBtn.classList.toggle('visible', !autoScroll);
  });

  scrollToBottomBtn.onclick = () => {
    timelinePanel.scrollTop = timelinePanel.scrollHeight;
    autoScroll = true;
    scrollToBottomBtn.classList.remove('visible');
  };

  document.getElementById('filterText').addEventListener('input', renderTimeline);
  document.getElementById('networkFilterText').addEventListener('input', renderTimeline);
  document.getElementById('networkMinDuration').addEventListener('input', renderTimeline);
  document.getElementById('networkFromTs').addEventListener('input', renderTimeline);
  document.getElementById('networkToTs').addEventListener('input', renderTimeline);

  wirePillGroup(document.getElementById('networkPills'), renderTimeline);
  wirePillGroup(document.getElementById('networkMethodPills'), renderTimeline);
  wirePillGroup(document.getElementById('consoleLevelPills'), renderTimeline);

  function clearTimeline() {
    timelineEvents.length = 0;
    // lastTs is intentionally left alone: it's the polling high-water mark
    // against the backend's SQLite ring buffer, which Clear doesn't touch.
    // Resetting it to 0 makes `since: lastTs || undefined` drop the filter
    // entirely, so the next poll re-fetches everything Clear just wiped.
    requestMeta.clear();
    timelinePanel.innerHTML = '';
    document.querySelectorAll('#networkPills .filter-pill .pill-count').forEach(s => { s.textContent = ''; });
    autoScroll = true;
    scrollToBottomBtn.classList.remove('visible');
  }

  document.getElementById('clearConsoleBtn').onclick  = clearTimeline;
  document.getElementById('clearNetworkBtn').onclick  = clearTimeline;

  testerBrowser.sessions.onLoadFailed(({ id, errorCode, errorDescription, url }) => {
    if (id !== getActiveId()) return;
    timelineEvents.push({
      kind:    'network-failed',
      summary: `LOAD FAILED (${errorCode}) ${errorDescription} — ${url}`,
      ts:      Date.now(),
    });
    if (timelineEvents.length > TIMELINE_MAX) {
      timelineEvents.splice(0, timelineEvents.length - TIMELINE_MAX);
    }
    renderTimeline();
  });
}
