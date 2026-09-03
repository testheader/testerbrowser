/* global testerBrowser */
import { state, TIMELINE_MAX, TIMELINE_DOM_MAX } from './state.js';
import { getEventTabId } from './utils.js';
import { openDetailTab } from './detail-panel.js';
import { openReplay } from './replay.js';

export function renderTimeline() {
  const panel = document.getElementById('timelinePanel');
  const tab   = state.activeConsoleTab;

  let filtered;
  if (tab === 'network') {
    const netFilter  = document.getElementById('networkFilterText').value.toLowerCase();
    const activeTypes = new Set([...document.querySelectorAll('#networkPills .filter-pill.on')].map(el => el.dataset.type));
    filtered = state.timelineEvents.filter(e => {
      const kindVisible = activeTypes.has(e.kind) ||
        (e.kind === 'network-body' && activeTypes.has('network-response'));
      return kindVisible && (!netFilter || e.summary.toLowerCase().includes(netFilter));
    });
  } else {
    const filterText = document.getElementById('filterText').value.toLowerCase();
    const CONSOLE_KINDS = new Set(['console', 'log']);
    filtered = state.timelineEvents.filter(e =>
      CONSOLE_KINDS.has(e.kind) && (!filterText || e.summary.toLowerCase().includes(filterText))
    );
  }

  const kindCounts = {};
  for (const e of state.timelineEvents) kindCounts[e.kind] = (kindCounts[e.kind] || 0) + 1;
  document.querySelectorAll('#networkPills .filter-pill').forEach(btn => {
    const n    = kindCounts[btn.dataset.type] || 0;
    const span = btn.querySelector('.pill-count');
    if (span) span.textContent = n > 0 ? n : '';
  });

  const visible = filtered.slice(-TIMELINE_DOM_MAX);
  panel.innerHTML = '';

  if (state.activeId && state.timelineEvents.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'timeline-empty';
    empty.innerHTML = '<span class="timeline-empty-dot"></span><span>Recording — waiting for activity…</span>';
    panel.appendChild(empty);
    if (state.autoScroll) panel.scrollTop = panel.scrollHeight;
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
    if (state.detailTabs.some(t => t.id === tabId)) line.classList.add('detail-row-active');

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

  if (state.autoScroll) panel.scrollTop = panel.scrollHeight;
}

export async function pollTimeline() {
  if (state.activeId) {
    const events = await testerBrowser.recording.timeline(state.activeId, { since: state.lastTs || undefined, limit: 200 });
    if (events.length > 0) {
      state.timelineEvents.push(...events);
      if (state.timelineEvents.length > TIMELINE_MAX) {
        state.timelineEvents.splice(0, state.timelineEvents.length - TIMELINE_MAX);
      }
      state.lastTs = Math.max(state.lastTs, ...events.map(e => e.ts));
      renderTimeline();
    }
  }
  setTimeout(pollTimeline, 1000);
}

export function initTimeline() {
  const timelinePanel     = document.getElementById('timelinePanel');
  const scrollToBottomBtn = document.getElementById('scrollToBottomBtn');

  timelinePanel.addEventListener('scroll', () => {
    state.autoScroll = timelinePanel.scrollTop + timelinePanel.clientHeight >= timelinePanel.scrollHeight - 30;
    scrollToBottomBtn.classList.toggle('visible', !state.autoScroll);
  });

  scrollToBottomBtn.onclick = () => {
    timelinePanel.scrollTop = timelinePanel.scrollHeight;
    state.autoScroll = true;
    scrollToBottomBtn.classList.remove('visible');
  };

  document.getElementById('filterText').addEventListener('input', renderTimeline);
  document.getElementById('networkFilterText').addEventListener('input', renderTimeline);

  document.querySelectorAll('#networkPills .filter-pill').forEach((btn) =>
    btn.addEventListener('click', () => { btn.classList.toggle('on'); renderTimeline(); })
  );

  function clearTimeline() {
    state.timelineEvents.length = 0;
    state.lastTs  = 0;
    timelinePanel.innerHTML = '';
    document.querySelectorAll('#networkPills .filter-pill .pill-count').forEach(s => { s.textContent = ''; });
    state.autoScroll = true;
    scrollToBottomBtn.classList.remove('visible');
  }

  document.getElementById('clearConsoleBtn').onclick  = clearTimeline;
  document.getElementById('clearNetworkBtn').onclick  = clearTimeline;

  testerBrowser.sessions.onLoadFailed(({ id, errorCode, errorDescription, url }) => {
    if (id !== state.activeId) return;
    state.timelineEvents.push({
      kind:    'network-failed',
      summary: `LOAD FAILED (${errorCode}) ${errorDescription} — ${url}`,
      ts:      Date.now(),
    });
    if (state.timelineEvents.length > TIMELINE_MAX) {
      state.timelineEvents.splice(0, state.timelineEvents.length - TIMELINE_MAX);
    }
    renderTimeline();
  });
}
