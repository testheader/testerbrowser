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

export function cookieMatchesDomain(cookie, hostname) {
  if (!hostname) return true;
  const d = (cookie.domain || '').replace(/^\./, '');
  // Empty domain means a host-only cookie — include it since we cannot determine
  // which host set it from the cookie data alone.
  if (!d) return true;
  return hostname === d || hostname.endsWith('.' + d);
}
