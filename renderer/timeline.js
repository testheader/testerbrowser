/* global testerBrowser */
import { TIMELINE_MAX, TIMELINE_DOM_MAX } from './state.js';
import { getEventTabId, wirePillGroup, activePillValues, getConsoleLevel, matchesFreeText, methodFilterLabel, networkSummary, getConsoleSource } from './utils.js';
import { buildNetworkRow, formatDuration, responseSize } from './network-rows.js';
import { openDetailTab, isDetailTabActive } from './detail-panel.js';
import { getActiveId } from './tabs.js';
import { getActiveConsoleTab } from './console-tabs.js';
import { setTabBadge } from './tab-badges.js';

// timeline.js owns the recording ring buffer (timelineEvents), the polling
// cursor (lastId) and the console panel's auto-scroll flag — nothing else
// reads or writes these directly. detail-panel.js reads the buffer through
// getTimelineEvents() to render a request/response's detail tab.
const timelineEvents = []; // ring buffer, max TIMELINE_MAX entries
let lastId          = 0;
let inflightFetch   = null; // single-flight guard for fetchTimeline
let autoScroll       = true;
// #229: { cap, evictedAt, evictedCount } | null for the active tab's
// recorder, once its cap has actually evicted something — polled alongside
// the timeline itself until evictedAt is set, then left alone (a recorder
// never "un-evicts").
let evictionStatus = null;
// #262: "Load older events" state. hasOlderEvents is only trustworthy for
// the head (timelineEvents[0].id) it was last computed against — checkedOldestId
// caches that id so a fast-moving live tail (which only ever appends) doesn't
// trigger a fresh recording:oldestId round-trip on every single poll.
let hasOlderEvents  = false;
let checkedOldestId = null;
let loadingOlder    = false;

// Only network-request payloads carry `request.method`/`request.url`
// directly; response/failed/body payloads only share the request's
// `requestId`. This maps one to the other so the method filter can hide a
// whole request+response(+body) group, not just the request line, and so a
// failed row's second line can show the URL even though loadingFailed's own
// CDP payload never carries it.
// Exported (not just module-private) so timeline-filters.test.ts can
// populate them directly — the alternative (threading requestMeta/
// responseMeta/tagMeta through every filter function as parameters) would
// touch far more call sites for no benefit outside tests.
export const requestMeta = new Map(); // requestId -> { method, url }
// The Req row now carries the response's status/timing inline (see
// getEventStatus/getEventDuration below) instead of leaving that to a
// separate Res row — this map is the response-side counterpart of
// requestMeta, populated the same way from network-response events as they
// arrive.
export const responseMeta = new Map(); // requestId -> { status, durationMs }
// Which rule (if any) intercepted/altered a call, keyed by requestId — the
// Mock/Resilience pills need this for kinds like network-body whose own
// payload never carries mockRuleId/resilienceRuleId directly.
export const tagMeta = new Map(); // requestId -> 'mock' | 'resilience'
// #300: loadingFailed's errorText per requestId, so a failed request's row
// can show the error instead of a status.
export const failMeta = new Map(); // requestId -> errorText
// The request row currently selected in the Network table (↑/↓/Enter).
let selectedRequestId = null;
const KNOWN_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);

// Rows whose level falls outside these five pills (e.g. CDP Log's 'verbose',
// or console types like 'trace'/'table') stay visible regardless of pill
// state, same policy as the network method filter's "unresolvable stays
// visible" rule — nothing should silently vanish just because it doesn't
// fit one of the named buckets.
const KNOWN_LEVELS = new Set(['error', 'warn', 'info', 'log', 'debug']);

function getEventMethod(e) {
  if (!e.payload) return null;
  try {
    const p = JSON.parse(e.payload);
    const method = e.kind === 'network-request' ? p.request?.method : requestMeta.get(p.requestId)?.method;
    return method || null;
  } catch { return null; }
}

// The response's duration, merged onto the request's row by requestId.
function getEventDuration(e) {
  if (!e.payload) return null;
  try {
    const p = JSON.parse(e.payload);
    if (e.kind === 'network-response') return typeof p.durationMs === 'number' ? p.durationMs : null;
    if (e.kind === 'network-request') {
      const durationMs = responseMeta.get(p.requestId)?.durationMs;
      return typeof durationMs === 'number' ? durationMs : null;
    }
  } catch {}
  return null;
}

// The Mock/Resilience pill filter's tag for a row: its own payload for
// request/response/failed rows (tagRequest patches mockRuleId/
// resilienceRuleId onto those directly), falling back to tagMeta for kinds
// like network-body that only carry a requestId.
function getEventTag(e) {
  if (!e.payload) return null;
  try {
    const p = JSON.parse(e.payload);
    if (p.mockRuleId) return 'mock';
    if (p.resilienceRuleId) return 'resilience';
    if (p.requestId) return tagMeta.get(p.requestId) ?? null;
  } catch {}
  return null;
}

// True for a request that failed outright or came back 4xx/5xx — what the
// Errors chip filters to and counts.
function isErrorRequest(e) {
  if (!e.payload) return false;
  try {
    const p = JSON.parse(e.payload);
    if (failMeta.has(p.requestId)) return true;
    const status = responseMeta.get(p.requestId)?.status;
    return typeof status === 'number' && status >= 400;
  } catch { return false; }
}

let pendingFocusRequestId = null;

export function getTimelineEvents() { return timelineEvents; }

// #306: "Open request" from a Security finding — selects the request's row in
// the Network table and opens its detail pane. Returns false when the request
// isn't in the loaded window (evicted or older than what's been fetched).
export function focusNetworkRequest(requestId) {
  const reqEvt = [...timelineEvents].reverse().find((e) => e.kind === 'network-request' && getEventTabId(e) === requestId);
  if (!reqEvt) {
    // The Network tab may not have fetched anything yet (its events are only
    // loaded while a timeline tab is showing) — retry once the next batch lands.
    pendingFocusRequestId = requestId;
    fetchTimeline();
    return false;
  }
  pendingFocusRequestId = null;
  selectedRequestId = requestId;
  autoScroll = false;
  openDetailTab(reqEvt);
  renderTimeline();
  const row = document.querySelector(`#timelinePanel .evt.network-request[data-tab-id="${CSS.escape(requestId)}"]`);
  if (row) row.scrollIntoView({ block: 'center' });
  return !!row;
}

const CONSOLE_KINDS = new Set(['console', 'log', 'exception']);

// Pure filter predicates — callers resolve DOM-derived filter state once per
// render (below) and pass it in, so these run per-event without touching
// document, and are directly unit-testable (#279). getEventMethod/
// getEventTag/getEventDuration close over the requestMeta/responseMeta/
// tagMeta maps above (module state, not DOM), same as the rest of this file.
export function matchesNetworkFilters(e, { activeTypes, activeMethods, minDuration, filterText }) {
  // #300: one row per request. The response's status/timing/size, a failure
  // and the body are all merged into (or shown from) the request row, so only
  // network-request events are ever rows of their own. The Errors chip
  // (data-type "network-failed") narrows to failed / 4xx / 5xx requests.
  if (e.kind !== 'network-request') return false;
  if (activeTypes.has('network-failed') && !isErrorRequest(e)) return false;

  const method = getEventMethod(e);
  const methodVisible = !method || activeMethods.has(KNOWN_METHODS.has(method) ? method : 'Other');
  if (!methodVisible) return false;

  if (minDuration > 0 && e.kind === 'network-request') {
    const durationMs = getEventDuration(e);
    if (typeof durationMs !== 'number' || durationMs < minDuration) return false;
  }

  const mockOn       = activeTypes.has('mock');
  const resilienceOn = activeTypes.has('resilience');
  if (mockOn || resilienceOn) {
    const tag = getEventTag(e);
    const tagVisible = (mockOn && tag === 'mock') || (resilienceOn && tag === 'resilience');
    if (!tagVisible) return false;
  }

  // Matches summary or payload the same way the console filter already
  // does — space-separated terms AND together, and a `-term` excludes.
  // Payload is bounded to prevent O(N × payload_size) string allocations
  // when the ring buffer is full of large CDP events: tags like
  // resilienceRuleId are appended near the end of the object, so we
  // search both a prefix and a suffix of large payloads.
  let searchText = e.summary;
  if (e.payload) {
    const raw = e.payload;
    const clipped = raw.length > 4096 ? raw.slice(0, 2048) + raw.slice(-512) : raw;
    searchText = `${e.summary}\n${clipped}`;
  }
  return matchesFreeText(searchText, filterText);
}

export function matchesConsoleFilters(e, { activeLevels, filterText }) {
  if (!CONSOLE_KINDS.has(e.kind)) return false;
  const level = getConsoleLevel(e);
  const levelVisible = !level || !KNOWN_LEVELS.has(level) || activeLevels.has(level);
  if (!levelVisible) return false;
  return matchesFreeText(e.summary, filterText);
}

// #302: the Console tab's level filter is a segmented control (All / Errors /
// Warnings / Info / Debug) — one level at a time, All = every level (including
// plain console.log rows, which have no segment of their own).
const ALL_LEVELS = ['error', 'warn', 'info', 'log', 'debug'];
let consoleLevel = 'all';
function activeConsoleLevels() {
  return new Set(consoleLevel === 'all' ? ALL_LEVELS : [consoleLevel]);
}

export function renderTimeline() {
  const panel = document.getElementById('timelinePanel');
  const tab   = getActiveConsoleTab();

  let filtered;
  if (tab === 'network') {
    const filters = {
      filterText:    /** @type {HTMLInputElement} */ (document.getElementById('networkFilterText')).value,
      activeTypes:   activePillValues(document.getElementById('networkPills'), 'type'),
      activeMethods: activePillValues(document.getElementById('networkMethodPills'), 'method'),
      minDuration:   parseFloat(/** @type {HTMLInputElement} */ (document.getElementById('networkMinDuration')).value) || 0,
    };
    filtered = timelineEvents.filter(e => matchesNetworkFilters(e, filters));
  } else {
    const filters = {
      filterText:   /** @type {HTMLInputElement} */ (document.getElementById('filterText')).value,
      activeLevels: activeConsoleLevels(),
    };
    filtered = timelineEvents.filter(e => matchesConsoleFilters(e, filters));
  }

  const kindCounts = {};
  for (const e of timelineEvents) kindCounts[e.kind] = (kindCounts[e.kind] || 0) + 1;
  // Mock/Resilience counts are per call (one request each), not per event
  // kind, so they're tallied off the network-request rows only.
  kindCounts['mock'] = 0;
  kindCounts['resilience'] = 0;
  kindCounts['network-failed'] = 0;
  for (const e of timelineEvents) {
    if (e.kind !== 'network-request') continue;
    if (isErrorRequest(e)) kindCounts['network-failed']++;
    const tag = getEventTag(e);
    if (tag === 'mock' || tag === 'resilience') kindCounts[tag]++;
  }
  document.querySelectorAll('#networkPills .filter-pill').forEach(btn => {
    const n    = kindCounts[btn.dataset.type] || 0;
    const span = btn.querySelector('.pill-count');
    if (span) span.textContent = n > 0 ? n : '';
  });

  document.getElementById('networkSummary').textContent = networkSummary(timelineEvents);

  const levelCounts = {};
  for (const e of timelineEvents) {
    const level = getConsoleLevel(e);
    if (level) levelCounts[level] = (levelCounts[level] || 0) + 1;
  }
  setTabBadge('console', levelCounts.error || 0);
  const consoleTotal = timelineEvents.filter((e) => CONSOLE_KINDS.has(e.kind)).length;
  document.querySelectorAll('#consoleLevelPills .seg-btn').forEach(btn => {
    const n    = btn.dataset.level === 'all' ? consoleTotal : (levelCounts[btn.dataset.level] || 0);
    const span = btn.querySelector('.pill-count');
    if (span) span.textContent = n > 0 ? n : '';
  });

  const visible = filtered.slice(-TIMELINE_DOM_MAX);
  panel.innerHTML = '';

  if (evictionStatus?.evictedAt) {
    const banner = document.createElement('div');
    banner.className = 'timeline-eviction-banner';
    banner.textContent =
      `Older events were evicted — this tab keeps the most recent ${evictionStatus.cap} events (Settings → Recording).`;
    panel.appendChild(banner);
  }

  if (getActiveId() && timelineEvents.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'timeline-empty';
    empty.innerHTML = '<span class="timeline-empty-dot"></span><span>Recording — waiting for activity…</span>';
    panel.appendChild(empty);
    if (autoScroll) panel.scrollTop = panel.scrollHeight;
    return;
  }

  // #262: independent of any active filter — a filter narrows which
  // *loaded* rows are shown, not how far back the loaded window reaches.
  if (timelineEvents.length > 0) {
    if (loadingOlder) {
      const row = document.createElement('div');
      row.className = 'timeline-load-older loading';
      row.textContent = 'Loading…';
      panel.appendChild(row);
    } else if (hasOlderEvents) {
      const btn = document.createElement('button');
      btn.className = 'timeline-load-older';
      btn.textContent = '▲ Load older events';
      btn.onclick = loadOlderEvents;
      panel.appendChild(btn);
    } else if (!evictionStatus?.evictedAt) {
      // If the recorder's own cap already evicted the true beginning, the
      // eviction banner above already explains that — showing this too
      // would wrongly suggest the recording started right here.
      const row = document.createElement('div');
      row.className = 'timeline-load-older exhausted';
      row.textContent = 'Beginning of recording';
      panel.appendChild(row);
    }
  }

  if (filtered.length > TIMELINE_DOM_MAX) {
    const msg = document.createElement('div');
    msg.className   = 'evt-overflow-msg';
    msg.textContent = `▲ ${filtered.length - TIMELINE_DOM_MAX} older events not shown — clear filter or console to see them`;
    panel.appendChild(msg);
  }

  if (tab === 'network') {
    renderNetworkTable(panel, visible);
    if (autoScroll) panel.scrollTop = panel.scrollHeight;
    return;
  }

  renderConsoleRows(panel, visible);
  if (autoScroll) panel.scrollTop = panel.scrollHeight;
}

// #302: Console rows — level icon, message (mono), clickable source, time.
// Class names (.evt, .evt.console / .log / .exception, .console-<level>) are
// kept; error and warn rows are tinted by CSS, an uncaught exception renders
// as an error row with a heavier (600) message.
const LEVEL_ICONS = {
  error: 'icon-circle-x', warn: 'icon-triangle-alert', info: 'icon-info', log: 'icon-chevron-right', debug: 'icon-bug',
};

function renderConsoleRows(panel, events) {
  for (const e of events) {
    const level = getConsoleLevel(e);
    const tabId = getEventTabId(e);
    const line  = document.createElement('div');
    // Exceptions keep their own class (no console-error); they are still
    // counted as errors by getConsoleLevel() and styled like one.
    line.className       = `evt ${e.kind}${level && e.kind !== 'exception' ? ' console-' + level : ''}`;
    line.dataset.kind    = e.kind;
    line.dataset.summary = e.summary;
    line.dataset.tabId   = tabId;
    if (isDetailTabActive(tabId)) line.classList.add('detail-row-active');

    const icon = document.createElement('i');
    icon.className = `con-icon ${LEVEL_ICONS[level] || 'icon-chevron-right'}`;
    icon.setAttribute('aria-hidden', 'true');
    line.appendChild(icon);

    const msg = document.createElement('span');
    msg.className = 'con-msg';
    // Strips the "[level] " prefix the summary was built with — a fixed,
    // anchored-at-start prefix, so this is safe even when the message text
    // itself contains brackets or spaces.
    msg.textContent = e.kind === 'console' || e.kind === 'log'
      ? e.summary.replace(/^\[[^\]]*\]\s?/, '')
      : e.summary;
    line.appendChild(msg);

    const source = getConsoleSource(e);
    const src = document.createElement('span');
    src.className = 'con-src';
    if (source) {
      const link = document.createElement('a');
      link.className = 'con-src-link';
      link.textContent = source.label;
      link.title = source.url;
      link.href = '#';
      link.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (/^https?:\/\//i.test(source.url)) testerBrowser.app.openExternal(source.url);
      });
      src.appendChild(link);
    }
    line.appendChild(src);

    const d = new Date(e.ts);
    const pad = (n) => String(n).padStart(2, '0');
    const time = document.createElement('span');
    time.className = 'con-time';
    time.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    time.title = d.toLocaleString();
    line.appendChild(time);

    if (e.payload) {
      line.style.cursor = 'pointer';
      line.addEventListener('click', () => openDetailTab(e));
    }
    panel.appendChild(line);
  }
}

// #300: the Network tab's table — a sticky header plus one 30px grid row per
// request: Status · Method · Name (path, host, tag) · Type · Size · Time.
// Class names (.evt.network-request, .evt-line1 .evt-method/.evt-status,
// .evt-inline-url, .evt-duration, .evt-badge-*) are kept; .evt-line1 and
// .evt-line1-rest are display:contents so their children are the grid cells.
function renderNetworkTable(panel, events) {
  const head = document.createElement('div');
  head.className = 'net-head';
  head.setAttribute('role', 'row');
  for (const [label, cls] of [['Status', ''], ['Method', ''], ['Name', ''], ['Type', ''], ['Size', 'right'], ['Time', 'right']]) {
    const cell = document.createElement('span');
    cell.textContent = label;
    if (cls) cell.className = cls;
    head.appendChild(cell);
  }
  panel.appendChild(head);

  for (const e of events) {
    let p;
    try { p = JSON.parse(e.payload); } catch { continue; }
    const row = buildNetworkRow(p, responseMeta.get(p.requestId), failMeta.get(p.requestId), getEventTag(e));
    const tabId = getEventTabId(e);

    const line = document.createElement('div');
    line.className       = 'evt network-request';
    line.dataset.kind    = e.kind;
    line.dataset.summary = e.summary;
    line.dataset.tabId   = tabId;
    line.setAttribute('role', 'row');
    if (isDetailTabActive(tabId)) line.classList.add('detail-row-active');
    if (row.requestId && row.requestId === selectedRequestId) line.classList.add('selected');
    line.title = row.url;

    const line1 = document.createElement('div');
    line1.className = 'evt-line1';

    const statusSpan = document.createElement('span');
    statusSpan.className = 'evt-status ' + (row.status === null ? (row.failed ? 'net-st-err' : 'net-st-pending')
      : row.status >= 400 ? 'net-st-err' : 'net-st-ok');
    statusSpan.textContent = row.status === null ? '—' : String(row.status);
    line1.appendChild(statusSpan);

    const rest = document.createElement('div');
    rest.className = 'evt-line1-rest';

    const methodSpan = document.createElement('span');
    methodSpan.className = 'evt-method';
    methodSpan.textContent = row.method;
    rest.appendChild(methodSpan);

    const nameCell = document.createElement('div');
    nameCell.className = 'net-name';
    const pathSpan = document.createElement('span');
    pathSpan.className = 'evt-inline-url';
    pathSpan.textContent = row.name || row.url;
    nameCell.appendChild(pathSpan);
    if (row.failed) {
      const err = document.createElement('span');
      err.className = 'net-host net-fail-text';
      err.textContent = row.errorText;
      nameCell.appendChild(err);
    } else if (row.host) {
      const host = document.createElement('span');
      host.className = 'net-host';
      host.textContent = row.host;
      nameCell.appendChild(host);
    }
    if (row.tag) {
      const badge = document.createElement('span');
      badge.className = `evt-badge evt-badge-${row.tag}`;
      badge.textContent = row.tag === 'mock' ? 'Mocked' : 'Resilience';
      badge.title = row.tag === 'mock'
        ? 'Response served by a Mock rule instead of the real server'
        : `Altered by a Resilience rule (${p.resilienceType || 'unknown'})`;
      nameCell.appendChild(badge);
    }
    rest.appendChild(nameCell);

    const typeSpan = document.createElement('span');
    typeSpan.className = 'net-type';
    typeSpan.textContent = row.type;
    rest.appendChild(typeSpan);

    const sizeSpan = document.createElement('span');
    sizeSpan.className = 'net-size';
    sizeSpan.textContent = row.sizeLabel;
    rest.appendChild(sizeSpan);

    const timeSpan = document.createElement('span');
    timeSpan.className = 'evt-duration' + (row.durationMs !== null && row.durationMs > 1000 ? ' slow' : '');
    timeSpan.textContent = row.durationMs === null ? '' : formatDuration(row.durationMs);
    rest.appendChild(timeSpan);

    line1.appendChild(rest);
    line.appendChild(line1);

    line.style.cursor = 'pointer';
    line.addEventListener('click', () => {
      selectedRequestId = row.requestId ?? null;
      openDetailTab(e);
      renderTimeline();
    });
    panel.appendChild(line);
  }
}

// ↑/↓ move the Network table's selection, Enter opens the selected row's
// detail (same as a click). Selection is tracked by requestId so it survives
// the panel re-rendering on every poll.
function onNetworkKeydown(ev) {
  if (getActiveConsoleTab() !== 'network') return;
  if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp' && ev.key !== 'Enter') return;
  const panel = document.getElementById('timelinePanel');
  const rows = /** @type {HTMLElement[]} */ ([...panel.querySelectorAll('.evt.network-request')]);
  if (rows.length === 0) return;
  ev.preventDefault();
  const idx = rows.findIndex((r) => r.classList.contains('selected'));
  if (ev.key === 'Enter') {
    if (idx >= 0) rows[idx].click();
    return;
  }
  const next = ev.key === 'ArrowDown' ? Math.min(rows.length - 1, idx + 1) : Math.max(0, idx === -1 ? rows.length - 1 : idx - 1);
  rows[idx]?.classList.remove('selected');
  rows[next].classList.add('selected');
  rows[next].scrollIntoView({ block: 'nearest' });
  selectedRequestId = rows[next].dataset.tabId || null;
}

const TIMELINE_PAGE = 200;

// Single-flight: a refresh while a poll is running reuses its promise, so the
// same cursor is never fetched twice concurrently (no duplicate rows).
function fetchTimeline() {
  // A fetch for a tab we've since switched away from discards its results, so
  // it must not be reused for the new tab.
  if (!inflightFetch || inflightFetch.tabId !== getActiveId()) {
    const run = { tabId: getActiveId() };
    run.promise = fetchTimelinePages().finally(() => {
      if (inflightFetch === run) inflightFetch = null;
    });
    inflightFetch = run;
  }
  return inflightFetch.promise;
}

async function fetchTimelinePages() {
  const activeId = getActiveId();
  if (!activeId) return;
  for (;;) {
    const events = await testerBrowser.recording.timeline(activeId, { sinceId: lastId, limit: TIMELINE_PAGE });
    // The tab changed while the request was in flight: drop the results.
    if (getActiveId() !== activeId) return;
    if (events.length === 0) return;
    ingestEvents(events);
    if (events.length < TIMELINE_PAGE) return;
  }
}

// Shared by ingestEvents (new events appended at the tail) and
// loadOlderEvents (older events prepended at the head) — both directions
// need the same requestMeta/responseMeta/tagMeta side-table population.
function populateMetaFromEvents(events) {
  for (const e of events) {
    if (!e.payload) continue;
    if (e.kind === 'network-request') {
      try {
        const p = JSON.parse(e.payload);
        if (p.requestId && p.request?.method) {
          requestMeta.set(p.requestId, { method: p.request.method, url: p.request.url });
        }
        if (p.requestId && p.mockRuleId) tagMeta.set(p.requestId, 'mock');
        else if (p.requestId && p.resilienceRuleId) tagMeta.set(p.requestId, 'resilience');
      } catch {}
    } else if (e.kind === 'network-response') {
      try {
        const p = JSON.parse(e.payload);
        if (p.requestId) {
          responseMeta.set(p.requestId, {
            status: p.response?.status ?? null, durationMs: p.durationMs,
            size: responseSize(p.response?.headers), mimeType: p.response?.mimeType,
          });
          if (p.mockRuleId) tagMeta.set(p.requestId, 'mock');
          else if (p.resilienceRuleId) tagMeta.set(p.requestId, 'resilience');
        }
      } catch {}
    } else if (e.kind === 'network-failed') {
      try {
        const p = JSON.parse(e.payload);
        if (p.requestId && p.mockRuleId) tagMeta.set(p.requestId, 'mock');
        else if (p.requestId && p.resilienceRuleId) tagMeta.set(p.requestId, 'resilience');
        if (p.requestId) failMeta.set(p.requestId, p.errorText || 'Failed');
      } catch {}
    }
  }
}

function ingestEvents(events) {
  populateMetaFromEvents(events);
  timelineEvents.push(...events);
  if (timelineEvents.length > TIMELINE_MAX) {
    timelineEvents.splice(0, timelineEvents.length - TIMELINE_MAX);
  }
  for (const e of events) if (e.id > lastId) lastId = e.id;
  renderTimeline();
  refreshOlderEventsState();
  if (pendingFocusRequestId) focusNetworkRequest(pendingFocusRequestId);
}

// #262: only re-checks the backend when the oldest *loaded* row has actually
// changed since the last check — a live tail only ever appends, so this
// almost never round-trips outside of an initial load or a "Load older"
// click actually changing the head.
async function refreshOlderEventsState() {
  const activeId     = getActiveId();
  const oldestLoaded = timelineEvents[0];
  if (!activeId || !oldestLoaded || typeof oldestLoaded.id !== 'number') {
    if (hasOlderEvents || checkedOldestId !== null) {
      hasOlderEvents  = false;
      checkedOldestId = null;
      renderTimeline();
    }
    return;
  }
  if (checkedOldestId === oldestLoaded.id) return;
  const queriedForId   = oldestLoaded.id;
  const storedOldestId = await testerBrowser.recording.oldestId(activeId);
  if (getActiveId() !== activeId) return; // switched tabs mid-flight
  // ingestEvents() fires this off without awaiting it, so a live poll tick
  // and a "Load older events" click can each have one of these in flight at
  // once. If the loaded window moved (either one's own head/tail trim) while
  // this call was awaiting the IPC round-trip, timelineEvents[0] is no longer
  // the row this result is about — applying it would stamp checkedOldestId
  // with a now-stale id and could latch hasOlderEvents to the wrong value
  // with nothing left to ever re-check it (a live tail with no new events
  // never calls this again, and the button itself disappears once
  // hasOlderEvents is wrongly false). Discard it instead: whichever
  // operation moved the window already triggers its own fresh check.
  if (timelineEvents[0]?.id !== queriedForId) return;
  checkedOldestId = queriedForId;
  const next = typeof storedOldestId === 'number' && storedOldestId < queriedForId;
  if (next !== hasOlderEvents) {
    hasOlderEvents = next;
    renderTimeline();
  }
}

// #262: fetches up to 500 events immediately preceding the currently-oldest
// loaded row and prepends them, keeping the previously-first-visible row
// anchored at the same viewport position instead of letting the browser's
// default scroll-anchoring (or lack of it) jump the view around.
async function loadOlderEvents() {
  if (loadingOlder || !hasOlderEvents) return;
  const activeId = getActiveId();
  if (!activeId || timelineEvents.length === 0) return;
  const beforeId = timelineEvents[0].id;

  loadingOlder = true;
  renderTimeline();

  const panel = document.getElementById('timelinePanel');
  const scrollHeightBefore = panel.scrollHeight;
  const scrollTopBefore    = panel.scrollTop;

  try {
    const older = await testerBrowser.recording.timeline(activeId, { beforeId, limit: 500 });
    if (getActiveId() !== activeId) return; // switched tabs mid-flight

    if (older.length === 0) {
      hasOlderEvents  = false;
      checkedOldestId = beforeId;
      return;
    }

    populateMetaFromEvents(older);
    timelineEvents.unshift(...older);

    // TIMELINE_MAX still holds, but an overflow from prepending older rows
    // drops the *newest* rows instead of the oldest ones a live poll would
    // drop: clicking "Load older events" is itself the signal the user wants
    // this history, so immediately discarding what was just fetched (by
    // dropping from the head again, the ordinary live-poll behavior) would
    // make the click a no-op.
    //
    // lastId is deliberately left untouched here — it's the 1s poller's own
    // high-water mark against the live tail, independent of what
    // timelineEvents currently holds. Rewinding it to the new (trimmed)
    // newest id would make the very next poll tick immediately re-fetch and
    // re-append the rows just dropped, which would then push the array back
    // over the cap and trigger ingestEvents' own oldest-drop trim — undoing
    // this newest-drop and fighting the poller forever. The trimmed rows
    // simply aren't visible again until a session switch reloads everything.
    if (timelineEvents.length > TIMELINE_MAX) {
      timelineEvents.length = TIMELINE_MAX;
    }

    await refreshOlderEventsState();
  } finally {
    loadingOlder = false;
    renderTimeline();
    // Content was inserted above the previously-first-visible row — grow
    // scrollTop by exactly the new content's height so that row stays put.
    panel.scrollTop = scrollTopBefore + (panel.scrollHeight - scrollHeightBefore);
  }
}

// #229: fire-and-forget alongside the timeline's own poll — once evictedAt
// is set for the active tab, there's nothing left to learn, so it stops
// polling (a recorder never "un-evicts").
async function pollRecordingStatus() {
  if (evictionStatus?.evictedAt) return;
  const activeId = getActiveId();
  if (!activeId) return;
  const status = await testerBrowser.recording.status(activeId);
  if (getActiveId() !== activeId) return; // switched tabs while the call was in flight
  if (status?.evictedAt) {
    evictionStatus = status;
    renderTimeline();
  }
}

export async function pollTimeline() {
  await fetchTimeline();
  pollRecordingStatus();
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
  lastId = 0;
  evictionStatus = null;
  hasOlderEvents = false;
  checkedOldestId = null;
  loadingOlder = false;
  requestMeta.clear();
  responseMeta.clear();
  tagMeta.clear();
  failMeta.clear();
  selectedRequestId = null;
  setTabBadge('console', 0);
  document.getElementById('timelinePanel').innerHTML = '';
}

export function initTimeline() {
  const timelinePanel     = document.getElementById('timelinePanel');
  const scrollToBottomBtn = document.getElementById('scrollToBottomBtn');

  timelinePanel.addEventListener('keydown', onNetworkKeydown);
  timelinePanel.addEventListener('scroll', () => {
    autoScroll = timelinePanel.scrollTop + timelinePanel.clientHeight >= timelinePanel.scrollHeight - 30;
    scrollToBottomBtn.classList.toggle('visible', !autoScroll);
  });

  scrollToBottomBtn.onclick = () => {
    timelinePanel.scrollTop = timelinePanel.scrollHeight;
    autoScroll = true;
    scrollToBottomBtn.classList.remove('visible');
  };

  /** @type {HTMLInputElement} */ (document.getElementById('filterText')).addEventListener('input', renderTimeline);
  /** @type {HTMLInputElement} */ (document.getElementById('networkFilterText')).addEventListener('input', renderTimeline);
  /** @type {HTMLInputElement} */ (document.getElementById('networkMinDuration')).addEventListener('input', renderTimeline);

  wirePillGroup(document.getElementById('networkPills'), renderTimeline);
  const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'Other'];
  const updateMethodLabel = () => {
    document.getElementById('networkMethodLabel').textContent =
      methodFilterLabel(METHODS, activePillValues(document.getElementById('networkMethodPills'), 'method'));
  };
  wirePillGroup(document.getElementById('networkMethodPills'), () => { updateMethodLabel(); renderTimeline(); });

  // #299: the Method and More-filters popovers (one open at a time; click
  // outside or Escape closes).
  const popovers = [
    { btn: document.getElementById('networkMethodBtn'), menu: document.getElementById('networkMethodMenu') },
    { btn: document.getElementById('networkMoreBtn'),   menu: document.getElementById('networkMoreMenu') },
  ];
  const closePopovers = () => popovers.forEach(({ btn, menu }) => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); });
  for (const { btn, menu } of popovers) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = menu.hidden;
      closePopovers();
      menu.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
    });
    menu.addEventListener('click', (e) => e.stopPropagation());
  }
  document.addEventListener('click', closePopovers);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopovers(); });
  document.querySelectorAll('#consoleLevelPills .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      consoleLevel = /** @type {HTMLElement} */ (btn).dataset.level;
      document.querySelectorAll('#consoleLevelPills .seg-btn').forEach((b) => {
        const on = /** @type {HTMLElement} */ (b).dataset.level === consoleLevel;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
      });
      renderTimeline();
    });
  });

  function clearTimeline() {
    timelineEvents.length = 0;
    // lastId is intentionally left alone: it's the polling high-water mark
    // against the backend's SQLite ring buffer, which Clear doesn't touch.
    // Resetting it to 0 would make the next poll re-fetch everything Clear
    // just wiped.
    requestMeta.clear();
    responseMeta.clear();
    tagMeta.clear();
    failMeta.clear();
    selectedRequestId = null;
    // #262: no loaded rows left to anchor "Load older events" against —
    // it'll recompute against the new head next time events are ingested.
    hasOlderEvents = false;
    checkedOldestId = null;
    loadingOlder = false;
    timelinePanel.innerHTML = '';
    document.getElementById('networkSummary').textContent = '';
    document.querySelectorAll('#networkPills .filter-pill .pill-count').forEach(s => { s.textContent = ''; });
    autoScroll = true;
    scrollToBottomBtn.classList.remove('visible');
  }

  document.getElementById('clearConsoleBtn').onclick  = clearTimeline;
  document.getElementById('clearNetworkBtn').onclick  = clearTimeline;

  /** @type {HTMLButtonElement} */ (document.getElementById('harExportBtn')).onclick = async () => {
    const id = getActiveId();
    if (!id) return;
    const statusEl = document.getElementById('harExportStatus');
    const btn = /** @type {HTMLButtonElement} */ (document.getElementById('harExportBtn'));
    statusEl.classList.remove('err');
    statusEl.textContent = 'Exporting…';
    btn.disabled = true;
    try {
      const result = await testerBrowser.recording.exportHar(id);
      if (result.canceled) {
        statusEl.textContent = '';
      } else if (result.ok) {
        const fileName = result.path.split(/[\\/]/).pop();
        statusEl.textContent = `Saved ${fileName}`;
      } else {
        statusEl.classList.add('err');
        statusEl.textContent = result.error || 'HAR export failed';
      }
    } finally {
      btn.disabled = false;
    }
  };

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
