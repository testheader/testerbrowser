/* global testerBrowser */
import { getActiveId } from './tabs.js';
import { openDetailTab } from './detail-panel.js';

const SEVERITIES = ['high', 'medium', 'low'];

// Rules whose absence, not presence, is the finding. Only checked once per
// unique HTTPS URL per scan (see analyze()) — repeated calls to the same
// endpoint would otherwise report the same missing header over and over.
const HEADER_PRESENCE_RULES = [
  { id: 'missing-content-security-policy',      header: 'content-security-policy',      severity: 'medium' },
  { id: 'missing-x-frame-options',               header: 'x-frame-options',              severity: 'medium' },
  { id: 'missing-x-content-type-options',        header: 'x-content-type-options',       severity: 'medium' },
  { id: 'missing-strict-transport-security',     header: 'strict-transport-security',    severity: 'medium' },
  { id: 'missing-referrer-policy',                header: 'referrer-policy',              severity: 'medium' },
  { id: 'missing-permissions-policy',            header: 'permissions-policy',           severity: 'low' },
  { id: 'missing-cross-origin-opener-policy',    header: 'cross-origin-opener-policy',   severity: 'low' },
  { id: 'missing-cross-origin-embedder-policy',  header: 'cross-origin-embedder-policy', severity: 'low' },
  { id: 'missing-cross-origin-resource-policy',  header: 'cross-origin-resource-policy', severity: 'low' },
  { id: 'missing-x-xss-protection',              header: 'x-xss-protection',             severity: 'low' },
].map(r => ({
  ...r,
  label: `Missing ${r.header}`,
  issue: `Missing ${r.header}`,
  detail: `Response missing the ${r.header} header`,
  check: norm => !norm[r.header],
}));

// Header value-quality checks: the header is present, but its value is weak
// or dangerous. Also scoped to once per unique HTTPS URL, same as above.
const HEADER_VALUE_RULES = [
  {
    id: 'csp-unsafe-inline', severity: 'high', label: "CSP allows 'unsafe-inline'",
    issue: "CSP allows unsafe-inline", detail: "content-security-policy includes 'unsafe-inline'",
    check: norm => (norm['content-security-policy'] ?? '').includes('unsafe-inline'),
  },
  {
    id: 'csp-unsafe-eval', severity: 'high', label: "CSP allows 'unsafe-eval'",
    issue: 'CSP allows unsafe-eval', detail: "content-security-policy includes 'unsafe-eval'",
    check: norm => (norm['content-security-policy'] ?? '').includes('unsafe-eval'),
  },
  {
    id: 'csp-wildcard-source', severity: 'medium', label: 'CSP has a wildcard source',
    issue: 'CSP has a wildcard source', detail: "content-security-policy includes a '*' source",
    check: norm => /(^|[\s;])\*($|[\s;])/.test(norm['content-security-policy'] ?? ''),
  },
  {
    id: 'xfo-not-deny-or-sameorigin', severity: 'medium', label: 'X-Frame-Options not DENY/SAMEORIGIN',
    issue: 'X-Frame-Options is not DENY/SAMEORIGIN', detail: 'x-frame-options is set but not DENY or SAMEORIGIN',
    check: norm => {
      const v = (norm['x-frame-options'] ?? '').toUpperCase().trim();
      return !!v && v !== 'DENY' && v !== 'SAMEORIGIN';
    },
  },
  {
    id: 'hsts-short-max-age', severity: 'medium', label: 'HSTS max-age too short',
    issue: 'HSTS max-age is too short', detail: 'strict-transport-security max-age is under ~180 days',
    check: norm => {
      const v = norm['strict-transport-security'];
      if (!v) return false;
      const m = /max-age=(\d+)/i.exec(v);
      return !!m && Number(m[1]) < 15552000; // 180 days
    },
  },
  {
    id: 'hsts-no-include-subdomains', severity: 'medium', label: 'HSTS missing includeSubDomains',
    issue: 'HSTS missing includeSubDomains', detail: 'strict-transport-security is missing includeSubDomains',
    check: norm => {
      const v = norm['strict-transport-security'];
      return !!v && !/includesubdomains/i.test(v);
    },
  },
  {
    id: 'referrer-policy-unsafe-url', severity: 'medium', label: 'Referrer-Policy is unsafe-url',
    issue: 'Referrer-Policy is unsafe-url', detail: 'referrer-policy is set to unsafe-url, leaking full URLs cross-origin',
    check: norm => (norm['referrer-policy'] ?? '').toLowerCase().trim() === 'unsafe-url',
  },
  {
    id: 'server-header-discloses-version', severity: 'low', label: 'Server header discloses version',
    issue: 'Server header discloses version info', detail: ctx => `Server: ${ctx.norm['server']}`,
    check: norm => /\d/.test(norm['server'] ?? ''),
  },
  {
    id: 'x-powered-by-present', severity: 'low', label: 'X-Powered-By header present',
    issue: 'X-Powered-By header present', detail: ctx => `X-Powered-By: ${ctx.norm['x-powered-by']}`,
    check: norm => !!norm['x-powered-by'],
  },
];

// Cookie checks run against the raw Set-Cookie value (lowercased), once per
// response that actually sets one. The recorder replaces sensitive header
// values with [REDACTED] when that setting is on — flag-checking the
// placeholder would report every cookie, so callers must skip it first.
const COOKIE_RULES = [
  {
    id: 'cookie-insecure', severity: 'medium', label: 'Cookie missing Secure',
    issue: 'Insecure cookie', detail: 'Cookie set without Secure flag',
    check: lc => !lc.includes('secure'),
  },
  {
    id: 'cookie-missing-httponly', severity: 'low', label: 'Cookie missing HttpOnly',
    issue: 'Cookie missing HttpOnly', detail: 'Cookie set without HttpOnly flag',
    check: lc => !lc.includes('httponly'),
  },
  {
    id: 'cookie-missing-samesite', severity: 'medium', label: 'Cookie missing SameSite',
    issue: 'Cookie missing SameSite', detail: 'Cookie set without a SameSite attribute',
    check: lc => !lc.includes('samesite'),
  },
  {
    id: 'cookie-samesite-none-without-secure', severity: 'high', label: 'SameSite=None without Secure',
    issue: 'SameSite=None without Secure', detail: 'SameSite=None cookies without Secure are invalid and rejected by browsers',
    check: lc => lc.includes('samesite=none') && !lc.includes('secure'),
  },
];

// Transport-level checks against the response as a whole (status, url,
// headers) — evaluated on every response, no per-URL dedup.
const TRANSPORT_RULES = [
  {
    id: 'http-unencrypted', severity: 'high', label: 'HTTP (unencrypted)',
    issue: 'HTTP (unencrypted)', detail: 'Request sent over HTTP, not HTTPS',
    check: ctx => ctx.url.startsWith('http://'),
  },
  {
    id: 'insecure-redirect', severity: 'high', label: 'Insecure redirect (HTTPS → HTTP)',
    issue: 'Insecure redirect (HTTPS → HTTP)', detail: ctx => `Redirects to ${ctx.norm['location']}`,
    check: ctx => ctx.status >= 300 && ctx.status < 400 && (ctx.norm['location'] ?? '').startsWith('http://'),
  },
  {
    id: 'cookie-set-without-cache-control', severity: 'medium', label: 'Cookie set without no-store/private',
    issue: 'Cookie set without no-store/private caching', detail: 'Response sets a cookie but Cache-Control is missing no-store/private',
    check: ctx => !!ctx.setCookie && ctx.setCookie !== '[REDACTED]' && !/no-store|private/i.test(ctx.norm['cache-control'] ?? ''),
  },
];

const CORS_RULES = [
  {
    id: 'cors-acao-wildcard', severity: 'low', label: 'CORS allows any origin',
    issue: 'CORS allows any origin', detail: 'Access-Control-Allow-Origin is *',
    check: norm => norm['access-control-allow-origin'] === '*',
  },
  {
    id: 'cors-acao-wildcard-with-credentials', severity: 'high', label: 'CORS wildcard with credentials',
    issue: 'CORS wildcard combined with credentials', detail: 'Access-Control-Allow-Origin: * with Access-Control-Allow-Credentials: true is invalid and dangerous',
    check: norm => norm['access-control-allow-origin'] === '*' && (norm['access-control-allow-credentials'] ?? '').toLowerCase() === 'true',
  },
];

const STATUS_RULES = [
  {
    id: 'auth-failure', severity: 'low', label: 'Auth failure (401/403)',
    issue: ctx => `Auth failure (${ctx.status})`, detail: ctx => `API responded with ${ctx.status}`,
    check: ctx => ctx.status === 401 || ctx.status === 403,
  },
];

// Full rule set, in the order the "Configure checks" panel lists them.
const ALL_RULES = [
  ...TRANSPORT_RULES,
  ...HEADER_PRESENCE_RULES,
  ...HEADER_VALUE_RULES,
  ...COOKIE_RULES,
  ...CORS_RULES,
  ...STATUS_RULES,
];
const ALL_RULE_IDS = new Set(ALL_RULES.map(r => r.id));

function resolve(val, ctx) { return typeof val === 'function' ? val(ctx) : val; }

function pushFinding(findings, rule, ctx, ev) {
  findings.push({
    severity: rule.severity,
    url: ctx.url,
    issue: resolve(rule.issue, ctx),
    detail: resolve(rule.detail, ctx),
    sourceEvent: ev,
    ruleId: rule.id,
  });
}

// Maps { id: false } overrides onto the full rule set — an id absent from
// overrides (or explicitly true) means the rule is enabled. New rules added
// later are enabled by default without needing any migration.
export function computeEnabledRuleIds(overrides) {
  const enabled = new Set();
  for (const rule of ALL_RULES) {
    if ((overrides ?? {})[rule.id] !== false) enabled.add(rule.id);
  }
  return enabled;
}

// State for a severity group's master checkbox: 'checked' when every rule in
// the group is enabled, 'unchecked' when none are, 'indeterminate' for a mix.
// A rule absent from overrides counts as enabled, same as computeEnabledRuleIds.
export function computeGroupCheckState(rules, overrides) {
  const o = overrides ?? {};
  let enabledCount = 0;
  for (const rule of rules) {
    if (o[rule.id] !== false) enabledCount++;
  }
  if (enabledCount === 0) return 'unchecked';
  if (enabledCount === rules.length) return 'checked';
  return 'indeterminate';
}

let lastFindings = [];

export function initSecurity() {
  const panel = document.getElementById('securityPanel');
  if (panel.dataset.initialized) return;
  panel.dataset.initialized = '1';
  panel.innerHTML = `
    <div class="sec-toolbar">
      <button class="sec-btn" id="secScanBtn">Scan session</button>
      <button class="sec-btn sec-config-btn" id="secConfigBtn" title="Configure checks"
              aria-label="Configure checks" aria-pressed="false">&#9881;</button>
      <span class="sec-status" id="secStatus"></span>
    </div>
    <div class="sec-config" id="secConfig" hidden></div>
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
  document.getElementById('secConfigBtn').addEventListener('click', toggleConfigPanel);
  document.getElementById('secFilterText').addEventListener('input', renderFilteredFindings);
  document.querySelectorAll('#secPills .filter-pill').forEach(btn =>
    btn.addEventListener('click', () => { btn.classList.toggle('on'); renderFilteredFindings(); })
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('secConfig').hidden) setConfigOpen(false);
  });
}

function setConfigOpen(open) {
  const configEl = document.getElementById('secConfig');
  const btn = document.getElementById('secConfigBtn');
  configEl.hidden = !open;
  btn.classList.toggle('active', open);
  btn.setAttribute('aria-pressed', String(open));
}

async function toggleConfigPanel() {
  const opening = document.getElementById('secConfig').hidden;
  setConfigOpen(opening);
  if (!opening) return;
  const settings = await testerBrowser.settings.get();
  renderConfigPanel(settings.securityRuleOverrides ?? {});
}

function renderConfigPanel(overrides) {
  const configEl = document.getElementById('secConfig');
  configEl.innerHTML = '';

  for (const sev of SEVERITIES) {
    const rules = ALL_RULES.filter(r => r.severity === sev);
    if (!rules.length) continue;

    const group = document.createElement('div');
    group.className = 'sec-config-group';

    const label = document.createElement('label');
    label.className = `sec-config-group-label sec-${sev}`;

    const master = document.createElement('input');
    master.type = 'checkbox';
    const applyMasterState = (state) => {
      master.checked = state === 'checked';
      master.indeterminate = state === 'indeterminate';
    };
    applyMasterState(computeGroupCheckState(rules, overrides));
    label.appendChild(master);

    const labelText = document.createElement('span');
    labelText.textContent = sev.toUpperCase();
    label.appendChild(labelText);
    group.appendChild(label);

    const rowCheckboxes = [];

    master.addEventListener('change', async () => {
      const settings = await testerBrowser.settings.get();
      const nextOverrides = { ...(settings.securityRuleOverrides ?? {}) };
      for (const rule of rules) nextOverrides[rule.id] = master.checked;
      await testerBrowser.settings.set({ securityRuleOverrides: nextOverrides });
      for (const cb of rowCheckboxes) cb.checked = master.checked;
      master.indeterminate = false;
    });

    for (const rule of rules) {
      const row = document.createElement('label');
      row.className = 'sec-config-row';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = overrides[rule.id] !== false;
      rowCheckboxes.push(checkbox);
      checkbox.addEventListener('change', async () => {
        const settings = await testerBrowser.settings.get();
        const nextOverrides = { ...(settings.securityRuleOverrides ?? {}), [rule.id]: checkbox.checked };
        await testerBrowser.settings.set({ securityRuleOverrides: nextOverrides });
        applyMasterState(computeGroupCheckState(rules, nextOverrides));
      });
      row.appendChild(checkbox);

      const span = document.createElement('span');
      span.textContent = rule.label;
      row.appendChild(span);

      group.appendChild(row);
    }
    configEl.appendChild(group);
  }
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
  if (!getActiveId()) return;
  const btn    = document.getElementById('secScanBtn');
  const status = document.getElementById('secStatus');
  btn.disabled = true;
  status.textContent = 'Scanning…';

  const [events, settings] = await Promise.all([
    testerBrowser.recording.timeline(getActiveId(), { limit: 5000 }),
    testerBrowser.settings.get(),
  ]);
  const enabledRuleIds = computeEnabledRuleIds(settings.securityRuleOverrides);
  lastFindings = analyze(events, enabledRuleIds);
  renderFilteredFindings();
  status.textContent = `${lastFindings.length} issue${lastFindings.length !== 1 ? 's' : ''} found`;
  btn.disabled = false;
}

export function analyze(events, enabledRuleIds = ALL_RULE_IDS) {
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
    const status    = payload.status ?? payload.response?.status ?? 0;
    const setCookie = norm['set-cookie'] ?? '';
    const ctx = { url, norm, status, setCookie };

    for (const rule of TRANSPORT_RULES) {
      if (enabledRuleIds.has(rule.id) && rule.check(ctx)) pushFinding(findings, rule, ctx, ev);
    }

    if (!seenUrls.has(url) && url.startsWith('https://')) {
      seenUrls.add(url);
      for (const rule of HEADER_PRESENCE_RULES) {
        if (enabledRuleIds.has(rule.id) && rule.check(norm)) pushFinding(findings, rule, ctx, ev);
      }
      for (const rule of HEADER_VALUE_RULES) {
        if (enabledRuleIds.has(rule.id) && rule.check(norm)) pushFinding(findings, rule, ctx, ev);
      }
    }

    if (setCookie && setCookie !== '[REDACTED]') {
      const lc = setCookie.toLowerCase();
      for (const rule of COOKIE_RULES) {
        if (enabledRuleIds.has(rule.id) && rule.check(lc)) pushFinding(findings, rule, ctx, ev);
      }
    }

    for (const rule of CORS_RULES) {
      if (enabledRuleIds.has(rule.id) && rule.check(norm)) pushFinding(findings, rule, ctx, ev);
    }

    for (const rule of STATUS_RULES) {
      if (enabledRuleIds.has(rule.id) && rule.check(ctx)) pushFinding(findings, rule, ctx, ev);
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
    (!filterText ||
      f.issue.toLowerCase().includes(filterText) ||
      f.url.toLowerCase().includes(filterText) ||
      (f.ruleId ?? '').toLowerCase().includes(filterText))
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
