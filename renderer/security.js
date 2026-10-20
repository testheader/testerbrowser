/* global testerBrowser */
import { getActiveId } from './tabs.js';
import { getEventTabId } from './utils.js';
import { switchConsoleTab } from './console-tabs.js';
import { focusNetworkRequest } from './timeline.js';
import { openJiraBugFromFinding } from './jira.js';
import { setTabBadge } from './tab-badges.js';
import { renderEmptyState } from './empty-state.js';

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

// #306: the group each finding is listed under (the row's right-hand column).
for (const r of TRANSPORT_RULES) r.category = r.id === 'cookie-set-without-cache-control' ? 'Cookies' : 'Transport';
for (const r of [...HEADER_PRESENCE_RULES, ...HEADER_VALUE_RULES]) r.category = 'Headers';
for (const r of COOKIE_RULES) r.category = 'Cookies';
for (const r of CORS_RULES) r.category = 'CORS';
for (const r of STATUS_RULES) r.category = 'Auth';

// #306: one sentence per rule on why the finding matters (detail pane).
export const WHY = {
  'http-unencrypted': 'Traffic can be read or changed by anyone on the network, including cookies and form input.',
  'insecure-redirect': 'An HTTPS request is redirected to plain HTTP, exposing everything that follows.',
  'cookie-set-without-cache-control': 'A shared cache or proxy could store and replay a response that sets a session cookie.',
  'missing-content-security-policy': "Without a Content-Security-Policy the browser can't block injected scripts or unexpected content sources.",
  'missing-x-frame-options': 'The page can be embedded in another site\'s frame, which enables clickjacking.',
  'missing-x-content-type-options': "Browsers may guess a response's content type, which can turn uploads into executable content.",
  'missing-strict-transport-security': 'Without Strict-Transport-Security, browsers can be downgraded to HTTP on later visits.',
  'missing-referrer-policy': 'Without a Referrer-Policy, full URLs can leak to other sites in the Referer header.',
  'missing-permissions-policy': 'The page does not restrict which powerful browser features embedded content may use.',
  'missing-cross-origin-opener-policy': 'Without Cross-Origin-Opener-Policy, other windows can keep a reference to this page.',
  'missing-cross-origin-embedder-policy': "Without Cross-Origin-Embedder-Policy, the page can't opt in to cross-origin isolation.",
  'missing-cross-origin-resource-policy': 'Other sites can embed this resource because no Cross-Origin-Resource-Policy limits it.',
  'missing-x-xss-protection': 'The legacy X-XSS-Protection header is absent; modern sites should rely on a Content-Security-Policy instead.',
  'csp-unsafe-inline': "'unsafe-inline' lets injected inline scripts run, which defeats most of what a CSP protects against.",
  'csp-unsafe-eval': "'unsafe-eval' lets injected strings run as code through eval and similar APIs.",
  'csp-wildcard-source': "A '*' source allows content to load from any origin, weakening the policy.",
  'xfo-not-deny-or-sameorigin': 'Values other than DENY or SAMEORIGIN are ignored by browsers, leaving the page frameable.',
  'hsts-short-max-age': 'A short max-age lets the HTTPS-only protection expire quickly.',
  'hsts-no-include-subdomains': 'Subdomains are not covered by HSTS and can still be downgraded to HTTP.',
  'referrer-policy-unsafe-url': 'unsafe-url sends the full URL, including path and query, to every destination.',
  'server-header-discloses-version': 'Version details help attackers look up known vulnerabilities for your server.',
  'x-powered-by-present': 'Revealing the framework or platform helps attackers pick targeted exploits.',
  'cookie-insecure': 'Without Secure, the cookie is also sent over plain HTTP where it can be intercepted.',
  'cookie-missing-httponly': 'Without HttpOnly, scripts running on the page can read this cookie.',
  'cookie-missing-samesite': 'Without SameSite, the cookie is sent on cross-site requests, which enables CSRF.',
  'cookie-samesite-none-without-secure': 'Browsers reject SameSite=None cookies that are not Secure, so this cookie is dropped.',
  'cors-acao-wildcard': 'Any website can read this response from a browser.',
  'cors-acao-wildcard-with-credentials': 'Browsers refuse this combination, and intending it suggests credentials could be exposed.',
  'auth-failure': 'The server rejected the request as unauthenticated or forbidden.',
};

function resolve(val, ctx) { return typeof val === 'function' ? val(ctx) : val; }

// The name of the first cookie in a Set-Cookie value ("sid=abc; Path=/" → "sid").
function cookieNameOf(setCookie) {
  const first = String(setCookie || '').split('\n')[0].split(';')[0];
  const eq = first.indexOf('=');
  return (eq === -1 ? first : first.slice(0, eq)).trim();
}

// What the row's second line points at: the cookie's name for a cookie
// finding, the full URL for a transport finding, otherwise "path · type".
function targetOf(rule, ctx) {
  if (rule.category === 'Cookies' && ctx.setCookie && ctx.setCookie !== '[REDACTED]') return cookieNameOf(ctx.setCookie);
  if (rule.category === 'Transport') return ctx.url;
  let path = ctx.url;
  try { const u = new URL(ctx.url); path = u.pathname + u.search; } catch { /* not a URL */ }
  return ctx.resourceType ? `${path} \u00b7 ${String(ctx.resourceType).toLowerCase()}` : path;
}

function pushFinding(findings, rule, ctx, ev) {
  findings.push({
    severity: rule.severity,
    url: ctx.url,
    issue: resolve(rule.issue, ctx),
    detail: resolve(rule.detail, ctx),
    sourceEvent: ev,
    ruleId: rule.id,
    category: rule.category || 'Other',
    target: targetOf(rule, ctx),
    method: ctx.method || 'GET',
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
let lastSkipped = { cookieRulesRedacted: false };
let lastTruncated = false;

// #306: single-selection severity segment (All / High / Medium / Low) and the
// selected finding (kept across re-renders by a stable key).
let secSeverity = 'all';
let selectedFindingKey = null;

function findingKey(f) { return `${f.ruleId}|${f.url}|${f.target}`; }

export function initSecurity() {
  const panel = document.getElementById('securityPanel');
  if (panel.dataset.initialized) return;
  panel.dataset.initialized = '1';
  panel.innerHTML = `
    <div class="sec-toolbar">
      <div class="seg" id="secPills" role="group" aria-label="Severity">
        <button class="seg-btn on" data-sev="all" aria-pressed="true">All<span class="pill-count"></span></button>
        <button class="seg-btn" data-sev="high" aria-pressed="false"><span class="sec-dot sec-dot-high"></span>High<span class="pill-count"></span></button>
        <button class="seg-btn" data-sev="medium" aria-pressed="false"><span class="sec-dot sec-dot-medium"></span>Medium<span class="pill-count"></span></button>
        <button class="seg-btn" data-sev="low" aria-pressed="false"><span class="sec-dot sec-dot-low"></span>Low<span class="pill-count"></span></button>
      </div>
      <div class="net-search sec-search"><i class="icon-search" aria-hidden="true"></i><input id="secFilterText" placeholder="Filter by issue or URL" aria-label="Filter findings" /></div>
      <button class="net-chip sec-config-btn" id="secConfigBtn" title="Configure checks"
              aria-label="Configure checks" aria-pressed="false"><i class="icon-settings-2" aria-hidden="true"></i></button>
      <span class="net-spacer"></span>
      <span class="sec-status" id="secStatus"></span>
      <button class="net-chip sec-btn" id="secScanBtn"><i class="icon-refresh-cw" aria-hidden="true"></i><span id="secScanLabel">Scan session</span></button>
    </div>
    <div class="sec-config" id="secConfig" hidden></div>
    <div class="sec-body">
      <div class="sec-results" id="secResults"></div>
      <aside class="sec-detail-pane" id="secDetail" aria-label="Finding details" hidden></aside>
    </div>`;
  document.getElementById('secResults').replaceChildren(securityEmptyState());
  /** @type {HTMLButtonElement} */ (document.getElementById('secScanBtn')).addEventListener('click', runScan);
  /** @type {HTMLButtonElement} */ (document.getElementById('secConfigBtn')).addEventListener('click', toggleConfigPanel);
  /** @type {HTMLInputElement} */ (document.getElementById('secFilterText')).addEventListener('input', renderFilteredFindings);
  document.querySelectorAll('#secPills .seg-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      secSeverity = /** @type {HTMLElement} */ (btn).dataset.sev;
      document.querySelectorAll('#secPills .seg-btn').forEach((b) => {
        const on = /** @type {HTMLElement} */ (b).dataset.sev === secSeverity;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
      });
      renderFilteredFindings();
    })
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('secConfig').hidden) setConfigOpen(false);
  });
}

function setConfigOpen(open) {
  const configEl = document.getElementById('secConfig');
  const btn = /** @type {HTMLButtonElement} */ (document.getElementById('secConfigBtn'));
  configEl.hidden = !open;
  btn.classList.toggle('active', open);
  btn.setAttribute('aria-pressed', String(open));
}

async function toggleConfigPanel() {
  const opening = document.getElementById('secConfig').hidden;
  setConfigOpen(opening);
  if (!opening) return;
  const settings = await testerBrowser.settings.get();
  renderConfigPanel(settings.securityRuleOverrides ?? {}, !!settings.securityIncludeSubresources);
}

function renderConfigPanel(overrides, includeSubresources) {
  const configEl = document.getElementById('secConfig');
  configEl.innerHTML = '';

  const subresourcesLabel = document.createElement('label');
  subresourcesLabel.className = 'sec-config-subresources';
  const subresourcesCheckbox = document.createElement('input');
  subresourcesCheckbox.type = 'checkbox';
  subresourcesCheckbox.checked = includeSubresources;
  subresourcesCheckbox.addEventListener('change', async () => {
    await testerBrowser.settings.set({ securityIncludeSubresources: subresourcesCheckbox.checked });
  });
  subresourcesLabel.appendChild(subresourcesCheckbox);
  const subresourcesText = document.createElement('span');
  subresourcesText.textContent = 'Include subresources in header checks';
  subresourcesLabel.appendChild(subresourcesText);
  configEl.appendChild(subresourcesLabel);

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
// #303: the pre-scan state, built with the shared empty state.
function securityEmptyState() {
  return renderEmptyState({
    icon: 'shield-check', tone: 'accent', title: 'Security scan',
    text: 'Scan this tab\'s recorded traffic for insecure headers and cookies.',
    actionLabel: 'Scan session', onAction: () => runScan(),
  });
}

export function clearSecurityFindings() {
  lastFindings = [];
  lastSkipped = { cookieRulesRedacted: false };
  lastTruncated = false;
  const results = document.getElementById('secResults');
  if (results) results.replaceChildren(securityEmptyState());
  const status = document.getElementById('secStatus');
  if (status) status.textContent = '';
  const scanLabel = document.getElementById('secScanLabel');
  if (scanLabel) scanLabel.textContent = 'Scan session';
  document.querySelectorAll('#secPills .pill-count').forEach((el) => { el.textContent = ''; });
  selectedFindingKey = null;
  const detail = document.getElementById('secDetail');
  if (detail) { detail.hidden = true; detail.replaceChildren(); }
  setTabBadge('security', 0);
}

async function runScan() {
  if (!getActiveId()) return;
  const btn    = /** @type {HTMLButtonElement} */ (document.getElementById('secScanBtn'));
  const status = document.getElementById('secStatus');
  btn.disabled = true;
  status.textContent = 'Scanning…';

  const [events, settings] = await Promise.all([
    testerBrowser.recording.timeline(getActiveId(), { limit: 5000 }),
    testerBrowser.settings.get(),
  ]);
  const enabledRuleIds = computeEnabledRuleIds(settings.securityRuleOverrides);
  const result = analyze(events, enabledRuleIds, { includeSubresources: !!settings.securityIncludeSubresources });
  lastFindings = result.findings;
  lastSkipped = result.skipped;
  lastTruncated = events.length >= 5000;
  renderFilteredFindings();
  setTabBadge('security', lastFindings.length);
  const scanned = events.filter((e) => e.kind === 'network-response').length;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  status.textContent = `Scanned ${scanned} request${scanned === 1 ? '' : 's'} \u00b7 ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  document.getElementById('secScanLabel').textContent = 'Scan again';
  btn.disabled = false;
}

export function analyze(events, enabledRuleIds = ALL_RULE_IDS, { includeSubresources = false } = {}) {
  const findings = [];
  const seenUrls = new Set();
  let cookieRulesRedacted = false;

  // requestId -> method, from the request events (a response payload doesn't
  // carry it) — shown in a finding's evidence.
  const methodById = new Map();
  for (const ev of events) {
    if (ev.kind !== 'network-request' || !ev.payload) continue;
    try {
      const p = JSON.parse(ev.payload);
      if (p.requestId && p.request?.method) methodById.set(p.requestId, p.request.method);
    } catch { /* skip malformed */ }
  }

  for (const ev of events) {
    if (ev.kind !== 'network-response') continue;
    let payload;
    try { payload = JSON.parse(ev.payload); } catch { continue; }

    const url     = payload.url ?? payload.response?.url ?? '';
    // #260: Set-Cookie only ever arrives via the separate
    // Network.responseReceivedExtraInfo event, merged in by the recorder as
    // a sibling `extraInfoHeaders` field — merge it over the base headers so
    // the cookie rules below can actually see it.
    const headers = { ...(payload.headers ?? payload.response?.headers ?? {}), ...(payload.extraInfoHeaders ?? {}) };
    const norm    = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
    );
    const status    = payload.status ?? payload.response?.status ?? 0;
    const setCookie = norm['set-cookie'] ?? '';
    const ctx = { url, norm, status, setCookie, method: methodById.get(payload.requestId), resourceType: undefined };

    // #240: header-presence/value rules only matter on the document itself
    // by default — a missing CSP on a third-party image isn't a real
    // finding. `type` comes straight off CDP's Network.responseReceived
    // (a Page.ResourceType string like "Document"/"Image"/"Script"); a
    // payload shape with no such field at all (an older recording, or a
    // hand-built fixture) has no way to tell, so it's treated as Document
    // — old recordings keep scanning exactly as they did before this.
    const resourceType = payload.type ?? payload.response?.type;
    const isDocument = resourceType === undefined || resourceType === 'Document';
    ctx.resourceType = resourceType;

    for (const rule of TRANSPORT_RULES) {
      if (enabledRuleIds.has(rule.id) && rule.check(ctx)) pushFinding(findings, rule, ctx, ev);
    }

    if ((includeSubresources || isDocument) && !seenUrls.has(url) && url.startsWith('https://')) {
      seenUrls.add(url);
      for (const rule of HEADER_PRESENCE_RULES) {
        if (enabledRuleIds.has(rule.id) && rule.check(norm)) pushFinding(findings, rule, ctx, ev);
      }
      for (const rule of HEADER_VALUE_RULES) {
        if (enabledRuleIds.has(rule.id) && rule.check(norm)) pushFinding(findings, rule, ctx, ev);
      }
    }

    if (setCookie === '[REDACTED]') cookieRulesRedacted = true;
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
  return { findings, skipped: { cookieRulesRedacted } };
}

function renderFilteredFindings() {
  const filterText  = /** @type {HTMLInputElement} */ (document.getElementById('secFilterText')).value.toLowerCase();

  const sevCounts = { high: 0, medium: 0, low: 0 };
  for (const f of lastFindings) sevCounts[f.severity] = (sevCounts[f.severity] || 0) + 1;
  document.querySelectorAll('#secPills .seg-btn').forEach(btn => {
    const span = btn.querySelector('.pill-count');
    const n    = btn.dataset.sev === 'all' ? lastFindings.length : (sevCounts[btn.dataset.sev] || 0);
    if (span) span.textContent = n > 0 ? n : '';
  });

  const filtered = lastFindings.filter(f =>
    (secSeverity === 'all' || f.severity === secSeverity) &&
    (!filterText ||
      f.issue.toLowerCase().includes(filterText) ||
      f.url.toLowerCase().includes(filterText) ||
      (f.ruleId ?? '').toLowerCase().includes(filterText))
  );
  renderFindings(filtered);
}

function bannersHtml() {
  let html = '';
  if (lastTruncated) {
    html += '<div class="sec-banner">Only the most recent 5,000 events were scanned.</div>';
  }
  if (lastSkipped.cookieRulesRedacted) {
    html += '<div class="sec-banner">Cookie rules skipped — sensitive headers are redacted (Settings → Redact sensitive headers)</div>';
  }
  return html;
}

const SEV_LABELS = { high: 'High', medium: 'Medium', low: 'Low' };

function renderFindings(findings) {
  const results = document.getElementById('secResults');
  const banners = bannersHtml();

  if (!lastFindings.length) {
    results.innerHTML = banners + '<div class="sec-hint sec-ok">No issues detected in recorded traffic.</div>';
    showFindingDetail(null);
    return;
  }
  if (!findings.length) {
    results.innerHTML = banners + '<div class="sec-hint">No findings match the current filter.</div>';
    showFindingDetail(null);
    return;
  }

  results.innerHTML = banners;

  // Rows in severity order (high → medium → low), one flat list.
  const ordered = [];
  for (const sev of SEVERITIES) for (const f of findings) if (f.severity === sev) ordered.push(f);

  // Keep the selection across re-renders; otherwise open the first finding.
  const selected = ordered.find((f) => findingKey(f) === selectedFindingKey) ?? ordered[0];
  selectedFindingKey = findingKey(selected);
  for (const f of ordered) {
    const row = document.createElement('div');
    row.className = `sec-row sec-row-${f.severity}`;
    row.dataset.key = findingKey(f);
    row.tabIndex = 0;
    row.setAttribute('role', 'button');

    const sevEl = document.createElement('span');
    sevEl.className = `sec-sev sec-sev-${f.severity}`;
    sevEl.textContent = SEV_LABELS[f.severity] ?? f.severity;
    row.appendChild(sevEl);

    const main = document.createElement('span');
    main.className = 'sec-main';
    const issueEl = document.createElement('span');
    issueEl.className = 'sec-issue';
    issueEl.textContent = f.issue;
    main.appendChild(issueEl);
    const urlEl = document.createElement('span');
    urlEl.className = 'sec-url';
    urlEl.title = f.url;
    urlEl.textContent = f.target || f.url;
    main.appendChild(urlEl);
    row.appendChild(main);

    const cat = document.createElement('span');
    cat.className = 'sec-cat';
    cat.textContent = f.category || '';
    row.appendChild(cat);

    if (selected && f === selected) row.classList.add('selected');
    const select = () => {
      selectedFindingKey = findingKey(f);
      results.querySelectorAll('.sec-row.selected').forEach((r) => r.classList.remove('selected'));
      row.classList.add('selected');
      showFindingDetail(f);
    };
    row.addEventListener('click', select);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); }
    });
    results.appendChild(row);
  }
  showFindingDetail(selected);
}

// The "Report to Jira" prefill for a finding.
export function findingReport(f) {
  const lines = [
    `Severity: ${SEV_LABELS[f.severity] ?? f.severity}`,
    `Category: ${f.category}`,
    `URL: ${f.url}`,
    '',
    `Why it matters: ${WHY[f.ruleId] ?? ''}`,
    '',
    'Evidence:',
    `${f.method} ${f.url}`,
    f.detail,
  ];
  return { summary: `Security: ${f.issue}`, description: lines.join('\n') };
}

function showFindingDetail(f) {
  const pane = document.getElementById('secDetail');
  if (!pane) return;
  pane.replaceChildren();
  pane.hidden = !f;
  if (!f) return;

  const top = document.createElement('div');
  top.className = 'sec-detail-top';
  const pill = document.createElement('span');
  pill.className = `sec-pill sec-pill-${f.severity}`;
  pill.textContent = SEV_LABELS[f.severity] ?? f.severity;
  const cat = document.createElement('span');
  cat.className = 'sec-detail-cat';
  cat.textContent = f.category || '';
  top.append(pill, cat);
  pane.appendChild(top);

  const title = document.createElement('div');
  title.className = 'sec-detail-title';
  title.textContent = f.issue;
  pane.appendChild(title);

  const why = document.createElement('p');
  why.className = 'sec-detail-why';
  why.textContent = WHY[f.ruleId] ?? f.detail;
  pane.appendChild(why);

  const evLabel = document.createElement('div');
  evLabel.className = 'sec-detail-label';
  evLabel.textContent = 'Evidence';
  pane.appendChild(evLabel);
  const ev = document.createElement('pre');
  ev.className = 'sec-evidence';
  ev.textContent = `${f.method} ${f.url}\n${f.detail}`;
  pane.appendChild(ev);

  const actions = document.createElement('div');
  actions.className = 'sec-detail-actions';
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'sec-action strong';
  open.id = 'secOpenRequestBtn';
  open.innerHTML = '<i class="icon-globe" aria-hidden="true"></i>Open request';
  open.addEventListener('click', () => {
    switchConsoleTab('network');
    if (f.sourceEvent) focusNetworkRequest(getEventTabId(f.sourceEvent));
  });
  const jira = document.createElement('button');
  jira.type = 'button';
  jira.className = 'sec-action';
  jira.id = 'secReportJiraBtn';
  jira.innerHTML = '<i class="icon-ticket" aria-hidden="true"></i>Report to Jira';
  jira.addEventListener('click', () => {
    const r = findingReport(f);
    openJiraBugFromFinding(r.summary, r.description);
  });
  actions.append(open, jira);
  pane.appendChild(actions);
}


