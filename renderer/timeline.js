/* global testerBrowser */
import { TIMELINE_MAX, TIMELINE_DOM_MAX } from './state.js';
import { getEventTabId } from './utils.js';
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

export function getTimelineEvents() { return timelineEvents; }

export function renderTimeline() {
  const panel = document.getElementById('timelinePanel');
  const tab   = getActiveConsoleTab();

  let filtered;
  if (tab === 'network') {
    const netFilter  = document.getElementById('networkFilterText').value.toLowerCase();
    const activeTypes = new Set([...document.querySelectorAll('#networkPills .filter-pill.on')].map(el => el.dataset.type));
    filtered = timelineEvents.filter(e => {
      const kindVisible = activeTypes.has(e.kind) ||
        (e.kind === 'network-body' && activeTypes.has('network-response'));
      return kindVisible && (!netFilter || e.summary.toLowerCase().includes(netFilter));
    });
  } else {
    const filterText = document.getElementById('filterText').value.toLowerCase();
    const CONSOLE_KINDS = new Set(['console', 'log']);
    filtered = timelineEvents.filter(e =>
      CONSOLE_KINDS.has(e.kind) && (!filterText || e.summary.toLowerCase().includes(filterText))
    );
  }

  const kindCounts = {};
  for (const e of timelineEvents) kindCounts[e.kind] = (kindCounts[e.kind] || 0) + 1;
  document.querySelectorAll('#networkPills .filter-pill').forEach(btn => {
    const n    = kindCounts[btn.dataset.type] || 0;
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
    if (e.kind === 'console') {
      const m = e.summary.match(/^\[(\w+)\]/);
      if (m) subtypeClass = ' console-' + m[1].toLowerCase();
    }
    const tabId = getEventTabId(e);
    const line  = document.createElement('div');
    line.className       = `evt ${e.kind}${subtypeClass}`;
    line.dataset.kind    = e.kind;
    line.dataset.summary = e.summary;
    line.dataset.tabId   = tabId;
    if (isDetailTabActive(tabId)) line.classList.add('detail-row-active');

    const summary = document.createElement('div');
    summary.className   = 'evt-summary';
    summary.textContent = `[${new Date(e.ts).toLocaleTimeString()}] ${e.summary}`;
    line.appendChild(summary);

    if (e.kind === 'network-request' && e.payload) {
      const replayBtn = document.createElement('button');
      replayBtn.className   = 'evt-replay-btn';
      replayBtn.textContent = '↺ Replay';
      replayBtn.title       = 'Edit and replay this request';
      replayBtn.onclick     = (ev) => { ev.stopPropagation(); openReplay(e); };
      summary.appendChild(replayBtn);
    }

    if ((e.kind === 'network-response' || e.kind === 'network-failed') && e.payload) {
      try {
        const p = JSON.parse(e.payload);
        if (p.mockRuleId) {
          const badge = document.createElement('span');
          badge.className = 'evt-badge evt-badge-mock';
          badge.textContent = 'MOCK';
          badge.title = 'Response served by a Mock rule instead of the real server';
          summary.appendChild(badge);
        } else if (p.resilienceRuleId) {
          const badge = document.createElement('span');
          badge.className = 'evt-badge evt-badge-resilience';
          badge.textContent = 'RESILIENCE';
          badge.title = `Altered by a Resilience rule (${p.resilienceType || 'unknown'})`;
          summary.appendChild(badge);
        }
      } catch {}
    }

    if (e.payload) {
      summary.style.cursor = 'pointer';
      summary.addEventListener('click', (ev) => {
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

  document.querySelectorAll('#networkPills .filter-pill').forEach((btn) =>
    btn.addEventListener('click', () => { btn.classList.toggle('on'); renderTimeline(); })
  );

  function clearTimeline() {
    timelineEvents.length = 0;
    lastTs  = 0;
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
