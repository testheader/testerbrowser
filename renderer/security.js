/* global testerBrowser */
import { state } from './state.js';
import { openDetailTab } from './detail-panel.js';

const REQUIRED_HEADERS = [
  'content-security-policy',
  'x-frame-options',
  'x-content-type-options',
  'strict-transport-security',
  'referrer-policy',
];

const SEVERITIES = ['high', 'medium', 'low'];

let lastFindings = [];

export function initSecurity() {
  const panel = document.getElementById('securityPanel');
  if (panel.dataset.initialized) return;
  panel.dataset.initialized = '1';
  panel.innerHTML = `
    <div class="sec-toolbar">
      <button class="sec-btn" id="secScanBtn">Scan session</button>
      <span class="sec-status" id="secStatus"></span>
    </div>
    <div class="sec-filterbar">
      <input id="secFilterText" placeholder="Filter by issue or URL…" />
      <div class="filter-pills" id="secPills">
        <button class="filter-pill on sec-pill-high"   data-sev="high">High<span class="pill-count"></span></button>
        <button class="filter-pill on sec-pill-medium" data-sev="medium">Medium<span class="pill-count"></span></button>
        <button class="filter-pill on sec-pill-low"    data-sev="low">Low<span class="pill-count"></span></button>
      </div>
    </div>
    <div class="sec-results" id="secResults">
      <div class="sec-hint">Click Scan to analyse headers and cookies for the current page.</div>
    </div>`;
  document.getElementById('secScanBtn').addEventListener('click', runScan);
  document.getElementById('secFilterText').addEventListener('input', renderFilteredFindings);
  document.querySelectorAll('#secPills .filter-pill').forEach(btn =>
    btn.addEventListener('click', () => { btn.classList.toggle('on'); renderFilteredFindings(); })
  );
}

// Findings are page-scoped — clear them whenever the active session changes
// or the current session navigates, so stale results are never shown as if
// they applied to a different page.
export function clearSecurityFindings() {
  lastFindings = [];
  const results = document.getElementById('secResults');
  if (results) results.innerHTML = '<div class="sec-hint">Click Scan to analyse headers and cookies for the current page.</div>';
  const status = document.getElementById('secStatus');
  if (status) status.textContent = '';
  document.querySelectorAll('#secPills .pill-count').forEach((el) => { el.textContent = ''; });
}

async function runScan() {
  if (!state.activeId) return;
  const btn    = document.getElementById('secScanBtn');
  const status = document.getElementById('secStatus');
  btn.disabled = true;
  status.textContent = 'Scanning…';

  const events   = await testerBrowser.recording.timeline(state.activeId, { limit: 5000 });
  lastFindings   = analyze(events);
  renderFilteredFindings();
  status.textContent = `${lastFindings.length} issue${lastFindings.length !== 1 ? 's' : ''} found`;
  btn.disabled = false;
}

export function analyze(events) {
  const findings = [];
  const seenUrls = new Set();

  for (const ev of events) {
    if (ev.kind !== 'network-response') continue;
    let payload;
    try { payload = JSON.parse(ev.payload); } catch { continue; }

    const url     = payload.url ?? payload.response?.url ?? '';
    const headers = payload.headers ?? payload.response?.headers ?? {};
    const norm    = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
    );

    if (url.startsWith('http://')) {
      findings.push({ severity: 'high', url, issue: 'HTTP (unencrypted)', detail: 'Request sent over HTTP, not HTTPS', sourceEvent: ev });
    }

    if (!seenUrls.has(url) && url.startsWith('https://')) {
      seenUrls.add(url);
      for (const h of REQUIRED_HEADERS) {
        if (!norm[h]) {
          findings.push({ severity: 'medium', url, issue: `Missing ${h}`, detail: `Response missing the ${h} header`, sourceEvent: ev });
        }
      }
    }

    const setCookie = norm['set-cookie'] ?? '';
    // The recorder replaces sensitive header values with [REDACTED] when that
    // setting is on; flag-checking the placeholder would report every cookie.
    if (setCookie && setCookie !== '[REDACTED]') {
      const lc = setCookie.toLowerCase();
      if (!lc.includes('secure')) {
        findings.push({ severity: 'medium', url, issue: 'Insecure cookie', detail: 'Cookie set without Secure flag', sourceEvent: ev });
      }
      if (!lc.includes('httponly')) {
        findings.push({ severity: 'low', url, issue: 'Cookie missing HttpOnly', detail: 'Cookie set without HttpOnly flag', sourceEvent: ev });
      }
    }

    const respStatus = payload.status ?? payload.response?.status ?? 0;
    if (respStatus === 401 || respStatus === 403) {
      findings.push({ severity: 'low', url, issue: `Auth failure (${respStatus})`, detail: `API responded with ${respStatus}`, sourceEvent: ev });
    }
  }
  return findings;
}

function renderFilteredFindings() {
  const filterText  = document.getElementById('secFilterText').value.toLowerCase();
  const activeSevs  = new Set([...document.querySelectorAll('#secPills .filter-pill.on')].map(el => el.dataset.sev));

  const sevCounts = { high: 0, medium: 0, low: 0 };
  for (const f of lastFindings) sevCounts[f.severity] = (sevCounts[f.severity] || 0) + 1;
  document.querySelectorAll('#secPills .filter-pill').forEach(btn => {
    const span = btn.querySelector('.pill-count');
    const n    = sevCounts[btn.dataset.sev] || 0;
    if (span) span.textContent = n > 0 ? n : '';
  });

  const filtered = lastFindings.filter(f =>
    activeSevs.has(f.severity) &&
    (!filterText || f.issue.toLowerCase().includes(filterText) || f.url.toLowerCase().includes(filterText))
  );
  renderFindings(filtered);
}

function renderFindings(findings) {
  const results = document.getElementById('secResults');
  results.innerHTML = '';

  if (!lastFindings.length) {
    results.innerHTML = '<div class="sec-hint sec-ok">No issues detected in recorded traffic.</div>';
    return;
  }
  if (!findings.length) {
    results.innerHTML = '<div class="sec-hint">No findings match the current filter.</div>';
    return;
  }

  const bySev = { high: [], medium: [], low: [] };
  for (const f of findings) (bySev[f.severity] ?? bySev.low).push(f);

  for (const sev of SEVERITIES) {
    const items = bySev[sev];
    if (!items.length) continue;

    const group = document.createElement('div');
    group.className = 'sec-group';

    const label = document.createElement('div');
    label.className = `sec-group-label sec-${sev}`;
    label.textContent = `${sev.toUpperCase()} (${items.length})`;
    group.appendChild(label);

    for (const f of items) {
      const row = document.createElement('div');
      row.className = `sec-row sec-row-${sev}`;
      row.title = 'Click to view the request/response that produced this finding';

      const issueEl = document.createElement('span');
      issueEl.className = 'sec-issue';
      issueEl.textContent = f.issue;
      row.appendChild(issueEl);

      const urlEl = document.createElement('span');
      urlEl.className = 'sec-url';
      urlEl.title = f.url;
      urlEl.textContent = trunc(f.url, 60);
      row.appendChild(urlEl);

      const detailEl = document.createElement('span');
      detailEl.className = 'sec-detail';
      detailEl.textContent = f.detail;
      row.appendChild(detailEl);

      if (f.sourceEvent) {
        row.addEventListener('click', () => openDetailTab(f.sourceEvent));
      }

      group.appendChild(row);
    }
    results.appendChild(group);
  }
}

function trunc(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }
