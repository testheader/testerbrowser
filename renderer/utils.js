export function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
  containerEl.querySelectorAll('.filter-pill').forEach(btn =>
    btn.addEventListener('click', () => { btn.classList.toggle('on'); onChange(); }));
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

export function cookieMatchesDomain(cookie, hostname) {
  if (!hostname) return true;
  const d = (cookie.domain || '').replace(/^\./, '');
  // Empty domain means a host-only cookie — include it since we cannot determine
  // which host set it from the cookie data alone.
  if (!d) return true;
  return hostname === d || hostname.endsWith('.' + d);
}
