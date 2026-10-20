/* global testerBrowser */
import { escHtml } from './utils.js';
import { getActiveId } from './tabs.js';
import { beginPageOverlay, endPageOverlay } from './layout.js';

// `icon` is a Lucide class name: lock / lock-open for real connections, and
// search for the new-tab page (or no URL yet), per the redesign spec.
function classify(url) {
  if (!url || /newtab\.html/i.test(url)) return { cls: 'neutral', icon: 'icon-search', proto: '', rest: url || '' };
  let proto;
  try { proto = new URL(url).protocol; } catch { return { cls: 'neutral', icon: 'icon-lock', proto: '', rest: url }; }
  if (proto === 'https:') return { cls: 'secure',   icon: 'icon-lock',      proto: 'https://', rest: url.slice('https://'.length) };
  if (proto === 'http:')  return { cls: 'insecure', icon: 'icon-lock-open', proto: 'http://',  rest: url.slice('http://'.length) };
  // Internal schemes (file:, chrome-error:, devtools:, about:, data:, …) get a neutral lock.
  return { cls: 'neutral', icon: 'icon-lock', proto: '', rest: url };
}

// Tracks the URL the lock icon currently reflects, so the click handler
// knows the scheme without re-parsing the urlbar's own display state.
let lastUrl = '';

export function updateUrlbarSecurity(url) {
  lastUrl = url;
  const lock = document.getElementById('urlbarLock');
  const display = document.getElementById('urlbarDisplay');
  const { cls, icon, proto, rest } = classify(url);

  lock.className = cls;
  const glyph = document.createElement('i');
  glyph.className = icon;
  glyph.setAttribute('aria-hidden', 'true');
  lock.replaceChildren(glyph);

  display.innerHTML = '';
  if (proto) {
    const protoSpan = document.createElement('span');
    protoSpan.className = 'url-proto';
    protoSpan.textContent = proto;
    display.appendChild(protoSpan);
    // scheme text-3, host text 500, path/query text-2 (the CSS carries the colours).
    const hostEnd = rest.search(/[/?#]/);
    const host = hostEnd === -1 ? rest : rest.slice(0, hostEnd);
    const path = hostEnd === -1 ? '' : rest.slice(hostEnd);
    const hostSpan = document.createElement('span');
    hostSpan.className = 'url-host';
    hostSpan.textContent = host;
    display.appendChild(hostSpan);
    if (path) {
      const pathSpan = document.createElement('span');
      pathSpan.className = 'url-path';
      pathSpan.textContent = path;
      display.appendChild(pathSpan);
    }
  } else {
    display.appendChild(document.createTextNode(rest));
  }
}

// #266: 'ok' at 30+ days out, 'soon' (warning style) under 30 days including
// the day it expires, 'expired' (error style) once validTo is in the past.
// validToSec is CDP's own TimeSinceEpoch (epoch seconds); nowMs is a plain
// Date.now()-style epoch-ms value, taken as a parameter so this stays a pure
// function for the unit tests rather than reading the clock itself.
export function certExpiryState(validToSec, nowMs) {
  const diffMs = validToSec * 1000 - nowMs;
  if (diffMs < 0) return { state: 'expired', days: Math.floor(diffMs / 86400000) };
  const days = Math.floor(diffMs / 86400000);
  return { state: days < 30 ? 'soon' : 'ok', days };
}

function formatDate(validSec) {
  if (!validSec) return 'Unknown';
  return new Date(validSec * 1000).toLocaleDateString();
}

function buildPopoverHtml(scheme, state) {
  if (scheme === 'http:') {
    return `<div class="sec-pop-section sec-pop-error">Connection is not secure</div>`;
  }
  if (!state || !state.validTo) {
    return `<div class="sec-pop-section sec-pop-muted">Connection details unavailable</div>`;
  }
  const connLine = [state.protocol, state.keyExchange, state.cipher].filter(Boolean).join(' · ') || 'Unknown';
  const expiry = certExpiryState(state.validTo, Date.now());
  let expiryLine = '';
  if (expiry.state === 'expired') {
    expiryLine = `<div class="sec-pop-expiry sec-pop-error">expired</div>`;
  } else if (expiry.state === 'soon') {
    const dayWord = expiry.days === 1 ? 'day' : 'days';
    expiryLine = `<div class="sec-pop-expiry sec-pop-warn">expires in ${expiry.days} ${dayWord}</div>`;
  }
  const urls = state.mixedContentUrls || [];
  const mixedBody = urls.length
    ? `<div>${urls.length} insecure (http:) subresource${urls.length === 1 ? '' : 's'} on this page</div>
       <ul class="sec-pop-mixed-list">${urls.slice(0, 10).map(u => `<li>${escHtml(u)}</li>`).join('')}</ul>`
    : `<div>None</div>`;

  return `
    <div class="sec-pop-section">
      <div class="sec-pop-title">Connection</div>
      <div>${escHtml(connLine)}</div>
    </div>
    <div class="sec-pop-section">
      <div class="sec-pop-title">Certificate</div>
      <div>Subject: ${escHtml(state.subjectName || 'Unknown')}</div>
      <div>Issuer: ${escHtml(state.issuer || 'Unknown')}</div>
      <div>Valid: ${formatDate(state.validFrom)} – ${formatDate(state.validTo)}</div>
      ${expiryLine}
    </div>
    <div class="sec-pop-section">
      <div class="sec-pop-title">Mixed content</div>
      ${mixedBody}
    </div>
  `;
}

async function openSecurityPopover() {
  const { cls } = classify(lastUrl);
  if (cls === 'neutral') return; // file:, new-tab page, etc. — no popover
  const scheme = cls === 'secure' ? 'https:' : 'http:';
  const popover = document.getElementById('securityPopover');
  const state = await testerBrowser.security.pageState(getActiveId());
  popover.innerHTML = buildPopoverHtml(scheme, state);
  popover.classList.add('open');
  document.getElementById('urlbarLock').setAttribute('aria-expanded', 'true');
  beginPageOverlay();
}

function closeSecurityPopover() {
  const popover = document.getElementById('securityPopover');
  if (!popover.classList.contains('open')) return;
  popover.classList.remove('open');
  document.getElementById('urlbarLock').setAttribute('aria-expanded', 'false');
  endPageOverlay();
}

export function initUrlbarSecurity() {
  const lock = document.getElementById('urlbarLock');
  lock.addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('securityPopover').classList.contains('open')
      ? closeSecurityPopover()
      : openSecurityPopover();
  });
  lock.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      lock.click();
    }
  });
  document.addEventListener('click', (e) => {
    const popover = document.getElementById('securityPopover');
    if (!popover.contains(/** @type {Node} */ (e.target)) && e.target !== lock) closeSecurityPopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSecurityPopover();
  });
}
