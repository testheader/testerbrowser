export function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function getEventTabId(e) {
  if (e.payload && e.kind.startsWith('network-')) {
    try {
      const p = JSON.parse(e.payload);
      if (p.requestId) return p.requestId;
    } catch {}
  }
  return `${e.ts}-${e.kind}`;
}

// CDP response headers preserve whatever case the server sent them in.
export function getHeader(headers, name) {
  if (!headers) return '';
  const key = Object.keys(headers).find(k => k.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key]) : '';
}

// Normalizes the level out of a console/log/exception event's own summary
// text (rather than re-parsing its JSON payload) — console rows are tagged
// `[type]` from Runtime.consoleAPICalled's own `type` field, log rows
// `[level]` from Log.entryAdded's `entry.level` (CDP spells it "warning",
// normalized here to "warn" to match the console side). An uncaught
// exception always counts as an error for filtering purposes, even though
// it renders with its own distinct styling instead of console-error's.
export function getConsoleLevel(e) {
  if (e.kind === 'exception') return 'error';
  if (e.kind !== 'console' && e.kind !== 'log') return null;
  const m = e.summary.match(/^\[(\w+)\]/);
  if (!m) return null;
  const raw = m[1].toLowerCase();
  return raw === 'warning' ? 'warn' : raw;
}

export function wirePillGroup(containerEl, onChange) {
  containerEl.querySelectorAll('.filter-pill').forEach(btn => {
    btn.setAttribute('aria-pressed', String(btn.classList.contains('on')));
    btn.addEventListener('click', () => {
      btn.classList.toggle('on');
      btn.setAttribute('aria-pressed', String(btn.classList.contains('on')));
      onChange();
    });
  });
}

// A panel's `?` button + help popover (Spoof, Diff): aria-expanded mirrors
// the open state, a click outside the popover closes it, and Escape anywhere
// inside scopeEl closes it and returns focus to the button. Returns setOpen.
export function wireHelpPopover(btn, popover, scopeEl) {
  const setOpen = (open) => {
    popover.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(popover.hidden);
  });
  document.addEventListener('click', (e) => {
    if (!popover.hidden && !popover.contains(e.target)) setOpen(false);
  });
  scopeEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !popover.hidden) {
      setOpen(false);
      btn.focus();
    }
  });
  return setOpen;
}

export function activePillValues(containerEl, dataAttr) {
  return new Set([...containerEl.querySelectorAll('.filter-pill.on')].map(el => el.dataset[dataAttr]));
}

// True for an explicit scheme, or (no whitespace, so not a search phrase)
// a host that looks like a real domain, localhost, or an IPv4 address —
// anything else is treated as a search query rather than a doomed
// navigation to e.g. https://weather%20today.
export function looksLikeUrl(v) {
  const trimmed = v.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return true;
  if (/\s/.test(trimmed)) return false;
  const host = trimmed.split(/[/?#]/)[0].split(':')[0];
  if (host === 'localhost') return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  return /\.[a-z]{2,}$/i.test(host);
}

export function buildSearchUrl(engine, query) {
  const q = encodeURIComponent(query.trim());
  return engine === 'duckduckgo' ? `https://duckduckgo.com/?q=${q}` : `https://www.google.com/search?q=${q}`;
}

// Space-separated terms combine: every positive term must match and any
// negative (`-term`) match excludes. A lone `-` (length 1) is a literal
// character, not a negation, so it is matched as-is. Case-insensitive;
// callers pass raw text, matching happens against its lowercased form.
export function matchesFreeText(text, filterText) {
  const terms = filterText.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const textLower = text.toLowerCase();
  for (const term of terms) {
    const termLower = term.toLowerCase();
    if (termLower.length > 1 && termLower.startsWith('-')) {
      if (textLower.includes(termLower.slice(1))) return false;
    } else if (!textLower.includes(termLower)) {
      return false;
    }
  }
  return true;
}

// Merges newly-polled recorded steps into the tester's local, possibly
// hand-edited list (a step removed with × in record-playback.js, or an
// assertion inserted via the context menu) without discarding those edits.
// The main-process buffer (sessionManager.ts's pollRecordingSteps ->
// getBufferedSteps) returns everything accumulated so far on every poll —
// receivedCount is how many of those had already been merged in as of the
// previous call, so only the tail past that point is genuinely new.
export function mergeRecordedSteps(localSteps, remoteSteps, receivedCount) {
  return [...localSteps, ...remoteSteps.slice(receivedCount)];
}

// #226: shared by crash-report.js's formatCrashForIssue and bugreport.js's
// formatDiagnostics, so the markdown wrapper isn't duplicated between them.
// appLog is { text, truncated } — already capped to 30,000 chars server-side
// (src/main/logTail.ts's capLogBlock), so this only formats the wrapper.
export function formatAppLogBlock(appLog) {
  const lineCount = appLog.text ? appLog.text.split('\n').length : 0;
  const summary = `App log (last ${lineCount} lines${appLog.truncated ? ', truncated' : ''})`;
  return `<details><summary>${summary}</summary>\n\n\`\`\`\n${appLog.text}\n\`\`\`\n</details>`;
}

// #235: transport-layer headers from a captured response that don't belong
// on a mock fulfilment — content-length/content-encoding/transfer-encoding
// describe the *original* (often compressed) body, not the decoded,
// possibly-edited rule.body actually sent, and connection is equally not
// ours to echo. Filtered out of the "⇒ Mock" prefill (renderer/mock.js) so
// they never make it into a saved rule in the first place; sessionManager.ts
// keeps its own copy of this same list as a backstop for rules saved before
// this existed, rather than sharing one across the IPC boundary — two short
// lists, each tested where it lives.
export const MOCK_STRIPPED_RESPONSE_HEADERS = ['content-length', 'content-encoding', 'transfer-encoding', 'connection'];

export function cookieMatchesDomain(cookie, hostname) {
  if (!hostname) return true;
  const d = (cookie.domain || '').replace(/^\./, '');
  // Empty domain means a host-only cookie — include it since we cannot determine
  // which host set it from the cookie data alone.
  if (!d) return true;
  return hostname === d || hostname.endsWith('.' + d);
}

// #232: single-quoted bash string, with any embedded single quote closed,
// escaped, and reopened ('\'') — the standard trick, since bash has no
// escape character inside single quotes.
function bashQuote(str) {
  return `'${String(str).replace(/'/g, `'\\''`)}'`;
}

function nonRedactedHeaders(headers) {
  return Object.entries(headers || {}).filter(([, v]) => v !== '[REDACTED]');
}

function redactedNotice(headers, commentPrefix) {
  const count = Object.values(headers || {}).filter(v => v === '[REDACTED]').length;
  return count ? `${commentPrefix} ${count} redacted header${count === 1 ? '' : 's'} omitted\n` : '';
}

// req: { method, url, headers, postData }
export function toCurl(req) {
  const { method = 'GET', url = '', headers, postData } = req || {};
  let cmd = `curl ${bashQuote(url)}`;
  if (method && method.toUpperCase() !== 'GET') cmd += ` -X ${method.toUpperCase()}`;
  for (const [name, value] of nonRedactedHeaders(headers)) {
    cmd += ` -H ${bashQuote(`${name}: ${value}`)}`;
  }
  if (postData) cmd += ` --data-raw ${bashQuote(postData)}`;
  return redactedNotice(headers, '#') + cmd;
}

// #233: with "Redact sensitive headers" on, a recorded Authorization/Cookie
// value is the literal string '[REDACTED]' — sending that back to the
// server is worse than useless, so both the Replay prefill and the main
// process's own fetch (as a backstop) drop any header whose value is
// exactly that.
export function stripRedactedHeaders(headers) {
  return Object.fromEntries(Object.entries(headers || {}).filter(([, v]) => v !== '[REDACTED]'));
}

// #246: default view for "Active tabs at crash time" in a public GitHub
// issue — strips query strings, fragments and userinfo (which can carry
// tokens/session ids) down to origin+pathname. A non-http(s) URL (e.g.
// file:) has no origin worth sharing at all, so only its scheme is shown.
// Falls back to the raw string for anything that isn't a parseable URL.
export function redactUrlForReport(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return u.protocol;
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

// #261: pure so it's unit-testable without a DOM — mirrors DevTools' own
// Timing breakdown. CDP's Network.ResourceTiming fields are all offsets in
// milliseconds relative to the response's `requestTime`, with -1 meaning
// "not applicable to this request" (e.g. dnsStart/connectStart are -1 for a
// reused connection). `durationMs` is the recorder's own wall-clock delta
// (Network.responseReceived - Network.requestWillBeSent), used as the total
// against which the final "Receive" phase is measured.
export function timingPhases(timing, durationMs) {
  const phase = (start, end) =>
    (typeof start === 'number' && typeof end === 'number' && start >= 0 && end >= 0)
      ? Math.max(0, end - start)
      : null;

  const receiveHeadersEnd = timing?.receiveHeadersEnd;
  const hasHeadersEnd = typeof receiveHeadersEnd === 'number' && receiveHeadersEnd >= 0;

  return {
    dns:     phase(timing?.dnsStart, timing?.dnsEnd),
    connect: phase(timing?.connectStart, timing?.connectEnd),
    tls:     phase(timing?.sslStart, timing?.sslEnd),
    send:    phase(timing?.sendStart, timing?.sendEnd),
    wait:    phase(timing?.sendEnd, receiveHeadersEnd),
    receive: (hasHeadersEnd && typeof durationMs === 'number')
      ? Math.max(0, durationMs - receiveHeadersEnd)
      : null,
  };
}

export function toFetch(req) {
  const { method = 'GET', url = '', headers, postData } = req || {};
  const opts = { method: method || 'GET', headers: Object.fromEntries(nonRedactedHeaders(headers)) };
  if (postData) opts.body = postData;
  return redactedNotice(headers, '//') + `fetch(${JSON.stringify(url)}, ${JSON.stringify(opts, null, 2)});`;
}

// #299: label for the Network toolbar's Method menu button — "Method: Any"
// when every method is on, otherwise the selected ones in the menu's order.
export function methodFilterLabel(allMethods, active) {
  const on = allMethods.filter((m) => active.has(m));
  if (on.length === allMethods.length) return 'Method: Any';
  return on.length ? `Method: ${on.join(', ')}` : 'Method: None';
}

// "0 B", "0.2 kB", "84.2 kB", "470 kB", "1.3 MB" — one decimal below 100 kB,
// whole kilobytes above it.
export function formatSize(n) {
  if (n <= 0) return '0 B';
  if (n < 100000) return `${(n / 1000).toFixed(1)} kB`;
  if (n < 1e6) return `${Math.round(n / 1000)} kB`;
  return `${(n / 1e6).toFixed(1)} MB`;
}

// #299: "12 requests · 739 kB · 2.71 s" — request count, summed
// Content-Length of recorded responses (omitted when none reported one) and
// the time from the first request to the last event. `events` are timeline
// rows ({ kind, ts, payload }).
export function networkSummary(events) {
  let count = 0, bytes = 0, first = null, last = null;
  for (const e of events) {
    if (e.kind !== 'network-request' && e.kind !== 'network-response' && e.kind !== 'network-failed') continue;
    if (first === null || e.ts < first) first = e.ts;
    if (last === null || e.ts > last) last = e.ts;
    if (e.kind === 'network-request') count++;
    if (e.kind === 'network-response' && e.payload) {
      try {
        const headers = JSON.parse(e.payload).response?.headers || {};
        const key = Object.keys(headers).find((k) => k.toLowerCase() === 'content-length');
        const n = key ? Number(headers[key]) : NaN;
        if (Number.isFinite(n) && n >= 0) bytes += n;
      } catch { /* malformed payload: skip its size */ }
    }
  }
  if (count === 0) return '';
  const parts = [`${count} request${count === 1 ? '' : 's'}`];
  if (bytes > 0) parts.push(formatSize(bytes));
  const span = last - first;
  parts.push(span >= 1000 ? `${(span / 1000).toFixed(2)} s` : `${Math.round(span)} ms`);
  return parts.join(' · ');
}

// #301: the five phases the detail pane's Timing tab draws bars for. Same
// CDP source as timingPhases(); "Queued" is the time before any network
// activity started (the earliest dns/connect/send offset). `ms` is null for
// a phase the browser doesn't report (e.g. DNS on a reused connection).
export function timingBars(timing, durationMs) {
  const p = timingPhases(timing, durationMs);
  const starts = [timing?.dnsStart, timing?.connectStart, timing?.sendStart]
    .filter((n) => typeof n === 'number' && n >= 0);
  return [
    { key: 'queued',  label: 'Queued',         ms: starts.length ? Math.max(0, Math.min(...starts)) : null },
    { key: 'dns',     label: 'DNS lookup',     ms: p.dns },
    { key: 'connect', label: 'Connection',     ms: p.connect },
    { key: 'wait',    label: 'Waiting (TTFB)', ms: p.wait },
    { key: 'receive', label: 'Download',       ms: p.receive },
  ];
}

// #301: a request's Cookie header → [{ name, value }].
export function parseCookieHeader(header) {
  if (!header) return [];
  return String(header).split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const eq = part.indexOf('=');
    return eq === -1 ? { name: part, value: '' } : { name: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim() };
  });
}

// #301: a response's Set-Cookie header (CDP joins several with "\n") →
// [{ name, value, attrs }], attrs being the remaining ";"-separated parts.
export function parseSetCookies(header) {
  if (!header) return [];
  return String(header).split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [pair, ...attrs] = line.split(';').map((s) => s.trim());
    const eq = pair.indexOf('=');
    return {
      name: eq === -1 ? pair : pair.slice(0, eq),
      value: eq === -1 ? '' : pair.slice(eq + 1),
      attrs: attrs.filter(Boolean),
    };
  });
}

// #302: where a Console row came from — { label: "jquery.min.js:4", url, line }
// — or null when the event carries no source location. CDP reports line
// numbers 0-based; the label shows the 1-based line DevTools would. Reads the
// first stack frame of a console call, the exception's own url/line, or a Log
// entry's url/line, whichever the payload has.
export function getConsoleSource(e) {
  if (!e.payload) return null;
  let p;
  try { p = JSON.parse(e.payload); } catch { return null; }
  let url, line;
  if (e.kind === 'console') {
    const frame = p.stackTrace?.callFrames?.[0];
    url = frame?.url; line = frame?.lineNumber;
  } else if (e.kind === 'exception') {
    const d = p.exceptionDetails;
    url = d?.url ?? d?.stackTrace?.callFrames?.[0]?.url;
    line = d?.lineNumber ?? d?.stackTrace?.callFrames?.[0]?.lineNumber;
  } else if (e.kind === 'log') {
    url = p.entry?.url; line = p.entry?.lineNumber;
  }
  if (!url || typeof url !== 'string') return null;
  let name = url;
  try {
    const u = new URL(url);
    name = u.pathname.split('/').filter(Boolean).pop() || u.host;
  } catch { /* not a URL: use as-is */ }
  const label = typeof line === 'number' && line >= 0 ? `${name}:${line + 1}` : name;
  return { label, url, line: typeof line === 'number' ? line + 1 : null };
}

// #310: "Never" / "2 s ago" / "5 min ago" / "3 h ago" / "2 d ago" for a Mock
// rule's last-hit column. `now` is injectable so it stays unit-testable.
export function formatAgo(ts, now = Date.now()) {
  if (!ts) return 'Never';
  const sec = Math.max(0, Math.round((now - ts) / 1000));
  if (sec < 60) return `${sec} s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/**
 * Relative time to an expiry: "in 7 days" for the future, "3 d ago" once passed (#321).
 * @param {number} ts epoch ms
 * @param {number} [now]
 */
export function formatRelativeExpiry(ts, now = Date.now()) {
  if (ts < now) return formatAgo(ts, now);
  if (ts - now < 60000) return 'in <1 min';
  const min = Math.round((ts - now) / 60000);
  if (min < 60) return `in ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `in ${h} ${h === 1 ? 'hour' : 'hours'}`;
  const d = Math.round(h / 24);
  return `in ${d} ${d === 1 ? 'day' : 'days'}`;
}
