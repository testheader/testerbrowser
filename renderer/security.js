/* global testerBrowser */
import { state } from './state.js';

const REQUIRED_HEADERS = [
  'content-security-policy',
  'x-frame-options',
  'x-content-type-options',
  'strict-transport-security',
  'referrer-policy',
];

export function initSecurity() {
  const panel = document.getElementById('securityPanel');
  if (panel.dataset.initialized) return;
  panel.dataset.initialized = '1';
  panel.innerHTML = `
    <div class="sec-toolbar">
      <button class="sec-btn" id="secScanBtn">Scan session</button>
      <span class="sec-status" id="secStatus"></span>
    </div>
    <div class="sec-results" id="secResults">
      <div class="sec-hint">Click "Scan session" to analyze recorded traffic.</div>
    </div>`;
  document.getElementById('secScanBtn').addEventListener('click', runScan);
}

async function runScan() {
  if (!state.activeId) return;
  const btn    = document.getElementById('secScanBtn');
  const status = document.getElementById('secStatus');
  btn.disabled = true;
  status.textContent = 'Scanning…';

  const events   = await testerBrowser.recording.timeline(state.activeId, { limit: 5000 });
  const findings = analyze(events);
  renderFindings(findings);
  status.textContent = `${findings.length} issue${findings.length !== 1 ? 's' : ''} found`;
  btn.disabled = false;
}

function analyze(events) {
  const findings = [];
  const seenUrls = new Set();

  for (const ev of events) {
    if (ev.type !== 'network-response') continue;
    let payload;
    try { payload = JSON.parse(ev.payload); } catch { continue; }

    const url     = payload.url ?? payload.response?.url ?? '';
    const headers = payload.headers ?? payload.response?.headers ?? {};
    const norm    = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
    );

    if (url.startsWith('http://')) {
      findings.push({ severity: 'high', url, issue: 'HTTP (unencrypted)', detail: 'Request sent over HTTP, not HTTPS' });
    }

    if (!seenUrls.has(url) && url.startsWith('https://')) {
      seenUrls.add(url);
      for (const h of REQUIRED_HEADERS) {
        if (!norm[h]) {
          findings.push({ severity: 'medium', url, issue: `Missing ${h}`, detail: `Response missing the ${h} header` });
        }
      }
    }

    const setCookie = norm['set-cookie'] ?? '';
    if (setCookie) {
      const lc = setCookie.toLowerCase();
      if (!lc.includes('secure')) {
        findings.push({ severity: 'medium', url, issue: 'Insecure cookie', detail: 'Cookie set without Secure flag' });
      }
      if (!lc.includes('httponly')) {
        findings.push({ severity: 'low', url, issue: 'Cookie missing HttpOnly', detail: 'Cookie set without HttpOnly flag' });
      }
    }

    const respStatus = payload.status ?? payload.response?.status ?? 0;
    if (respStatus === 401 || respStatus === 403) {
      findings.push({ severity: 'low', url, issue: `Auth failure (${respStatus})`, detail: `API responded with ${respStatus}` });
    }
  }
  return findings;
}

function renderFindings(findings) {
  const results = document.getElementById('secResults');
  if (!findings.length) {
    results.innerHTML = '<div class="sec-hint sec-ok">No issues detected in recorded traffic.</div>';
    return;
  }
  const bySev = { high: [], medium: [], low: [] };
  for (const f of findings) (bySev[f.severity] ?? bySev.low).push(f);

  let html = '';
  for (const [sev, items] of Object.entries(bySev)) {
    if (!items.length) continue;
    html += `<div class="sec-group"><div class="sec-group-label sec-${sev}">${sev.toUpperCase()} (${items.length})</div>`;
    for (const f of items) {
      html += `<div class="sec-row sec-row-${sev}">
        <span class="sec-issue">${esc(f.issue)}</span>
        <span class="sec-url" title="${esc(f.url)}">${esc(trunc(f.url, 60))}</span>
        <span class="sec-detail">${esc(f.detail)}</span>
      </div>`;
    }
    html += '</div>';
  }
  results.innerHTML = html;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function trunc(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }
