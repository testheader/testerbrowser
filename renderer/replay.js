/* global testerBrowser */
import { escHtml, cookieMatchesDomain, stripRedactedHeaders } from './utils.js';
import { openMockFromRequest } from './mock.js';
import { openResilienceFromRequest } from './resilience.js';
import { addKvRow, readKvTable } from './kv-table.js';
import { initModal, openModal, closeModal } from './modal.js';
import { buildSessionOptions } from './session-picker.js';

// Last successful ("ok") response from this Replay session's Send ↵, used to
// prefill status/response headers/body when handing off to Mock. Reset on
// every openReplay() so a stale response from a previous request never leaks
// into a hand-off for a different one.
let lastReplayResult = null;

// #233: the session id the currently-open request came from — recording:replay
// sends through *this* tab's partition (its Mock rules, cookie jar, HTTP
// cache), not the app's default session. Reset on every openReplay().
let currentSessionId = null;

function formatXml(xml) {
  let indent = 0;
  return xml
    .replace(/>\s*</g, '><')
    .replace(/(<[^/][^>]*[^/]>|<[^/][^>]*[^>]>)(?!<\/)/g, (m) => {
      const out = '  '.repeat(indent) + m;
      indent++;
      return out + '\n';
    })
    .replace(/<\/[^>]+>/g, (m) => {
      indent = Math.max(0, indent - 1);
      return '  '.repeat(indent) + m + '\n';
    })
    .replace(/(<[^>]+\/>)/g, (m) => '  '.repeat(indent) + m + '\n')
    .trim();
}

function parseCookieHeader(cookieStr) {
  if (!cookieStr) return [];
  return cookieStr.split(';').map(p => {
    const idx = p.indexOf('=');
    if (idx < 0) return [p.trim(), ''];
    return [p.slice(0, idx).trim(), p.slice(idx + 1).trim()];
  }).filter(([n]) => n);
}

function readCookiesTable() {
  const pairs     = [];
  const container = document.getElementById('replayCookiesTable');
  for (const row of container.querySelectorAll('.kv-row')) {
    const k = row.querySelector('.kv-key').value.trim();
    const v = row.querySelector('.kv-val').value.trim();
    if (k) pairs.push(`${k}=${v}`);
  }
  return pairs.join('; ');
}

// Live header state from the editor's kv-row tables, folding the separate
// cookie table into a Cookie header the same way sendReplayBtn's handler
// does — shared by Send and the Mock/Resilience hand-off buttons so all
// three act on what the tester currently has typed, not the original
// captured request.
function getEditorRequestHeaders() {
  const headers   = readKvTable(document.getElementById('replayHeadersTable'));
  const cookieVal = readCookiesTable();
  if (cookieVal) headers['Cookie'] = cookieVal;
  return headers;
}

export async function openReplay(evt, sessionId) {
  currentSessionId = sessionId ?? null;

  let reqData = {};
  try { reqData = JSON.parse(evt.payload ?? '{}'); } catch {}
  const req = reqData.request ?? {};

  const method   = req.method || 'GET';
  const url      = req.url    || '';
  const allHdrs  = req.headers || {};

  const methodSel = document.getElementById('replayMethod');
  methodSel.value = ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].includes(method) ? method : 'GET';
  document.getElementById('replayUrl').value    = url;
  document.getElementById('replayBody').value   = req.postData || '';
  document.getElementById('replayResponse').innerHTML = '';
  document.getElementById('replaySpinner').classList.remove('visible');
  lastReplayResult = null;

  const hdrTable = document.getElementById('replayHeadersTable');
  const ckTable  = document.getElementById('replayCookiesTable');
  hdrTable.innerHTML = '';
  ckTable.innerHTML  = '';

  // #233: a header recorded with "Redact sensitive headers" on is the
  // literal string '[REDACTED]' — never prefill (or send) that. If it was
  // specifically the Cookie header, fall back to the originating tab's own
  // cookies for this URL instead of leaving the table empty.
  let cookieStr = '';
  let cookieWasRedacted = false;
  const visibleHeaders = stripRedactedHeaders(allHdrs);
  for (const [k, v] of Object.entries(allHdrs)) {
    if (k.toLowerCase() === 'cookie') {
      if (v === '[REDACTED]') cookieWasRedacted = true;
      else cookieStr = v;
      continue;
    }
  }
  for (const [k, v] of Object.entries(visibleHeaders)) {
    if (k.toLowerCase() === 'cookie') continue;
    addKvRow(hdrTable, k, v);
  }
  for (const [n, v] of parseCookieHeader(cookieStr)) {
    addKvRow(ckTable, n, v);
  }

  const redactedNote = document.getElementById('replayRedactedNote');
  const headerWasRedacted = Object.values(allHdrs).some(v => v === '[REDACTED]');
  redactedNote.hidden = !headerWasRedacted;

  if (cookieWasRedacted && currentSessionId) {
    let reqHostForCookies = '';
    try { reqHostForCookies = new URL(url.startsWith('http') ? url : 'https://' + url).hostname; } catch {}
    try {
      const cookies = await testerBrowser.sessions.getCookies(currentSessionId);
      const relevant = reqHostForCookies ? cookies.filter(c => cookieMatchesDomain(c, reqHostForCookies)) : cookies;
      for (const c of relevant) addKvRow(ckTable, c.name, c.value);
    } catch {}
  }

  const sessionPick = document.getElementById('replayCookieSessionPick');
  try {
    const sessions = await testerBrowser.sessions.list();
    buildSessionOptions(sessionPick, sessions, { extraFirstOption: { value: '', label: 'Load from session…' } });
  } catch {
    sessionPick.innerHTML = '<option value="">Load from session…</option>';
  }
  let reqHost = '';
  try { reqHost = new URL(url.startsWith('http') ? url : 'https://' + url).hostname; } catch {}
  sessionPick.dataset.reqHost = reqHost;

  await openModal('replayOverlay', () => document.getElementById('replayUrl').focus());
}

function closeReplay() {
  closeModal('replayOverlay');
}

export function initReplay() {
  // No backdrop-click-to-close here: an in-flight replay request should not
  // be dismissed by an accidental click outside the modal.
  initModal('replayOverlay', closeReplay, { backdrop: false });
  document.getElementById('replayAddHeader').onclick = () =>
    addKvRow(document.getElementById('replayHeadersTable'), '', '');
  document.getElementById('replayAddCookie').onclick = () =>
    addKvRow(document.getElementById('replayCookiesTable'), '', '');

  document.getElementById('replayCookieSessionPick').onchange = async (e) => {
    const id = e.target.value;
    if (!id) return;
    try {
      const reqHost = e.target.dataset.reqHost || '';
      const cookies = await testerBrowser.sessions.getCookies(id);
      const relevant = reqHost ? cookies.filter(c => cookieMatchesDomain(c, reqHost)) : cookies;
      const ckTable = document.getElementById('replayCookiesTable');
      ckTable.innerHTML = '';
      for (const c of relevant) addKvRow(ckTable, c.name, c.value);
    } catch {}
  };

  document.getElementById('replayFormatBody').onclick = () => {
    const ta  = document.getElementById('replayBody');
    const raw = ta.value.trim();
    if (!raw) return;
    try { ta.value = JSON.stringify(JSON.parse(raw), null, 2); return; } catch {}
    try { ta.value = formatXml(raw); } catch {}
  };

  document.getElementById('closeReplayBtn').onclick  = closeReplay;
  document.getElementById('replayCloseXBtn').onclick = closeReplay;

  document.getElementById('sendReplayBtn').onclick = async () => {
    const method = document.getElementById('replayMethod').value;
    const url    = document.getElementById('replayUrl').value.trim();
    const body   = document.getElementById('replayBody').value;
    if (!url) return;

    const headers = getEditorRequestHeaders();
    const timeoutInput = document.getElementById('replayTimeout');
    const timeoutS = Math.min(600, Math.max(1, parseInt(timeoutInput.value, 10) || 30));
    timeoutInput.value = timeoutS;

    const spinner = document.getElementById('replaySpinner');
    const resArea = document.getElementById('replayResponse');
    spinner.classList.add('visible');
    resArea.innerHTML = '';

    const result = await testerBrowser.recording.replay({
      sessionId: currentSessionId, method, url, headers, body: body || undefined, timeoutMs: timeoutS * 1000,
    });
    spinner.classList.remove('visible');

    if (!result.ok) {
      resArea.innerHTML = `<div class="replay-res-status err">Error: ${escHtml(result.error || 'Unknown error')}</div>`;
      return;
    }

    lastReplayResult = result;

    if (result.servedBy?.mockRuleId) {
      const mockNote = document.createElement('div');
      mockNote.className   = 'replay-mock-note';
      mockNote.textContent = `Served by mock rule ${result.servedBy.urlPattern}`;
      resArea.appendChild(mockNote);
    }

    const sc = result.status >= 200 && result.status < 300 ? 'ok' : 'err';
    const statusLine = document.createElement('div');
    statusLine.className   = `replay-res-status ${sc}`;
    statusLine.textContent = `${result.status} ${result.statusText}`;
    resArea.appendChild(statusLine);

    const hdrToggle = document.createElement('div');
    hdrToggle.className   = 'replay-res-hdr-toggle';
    hdrToggle.textContent = '▸ Response headers';
    const hdrRows = document.createElement('div');
    hdrRows.className = 'replay-res-hdr-rows';
    const tbl = document.createElement('table');
    tbl.className = 'replay-res-hdr-table';
    for (const [k, v] of Object.entries(result.headers || {})) {
      const tr  = document.createElement('tr');
      const td1 = document.createElement('td'); td1.textContent = k;
      const td2 = document.createElement('td'); td2.textContent = v;
      tr.appendChild(td1); tr.appendChild(td2); tbl.appendChild(tr);
    }
    hdrRows.appendChild(tbl);
    hdrToggle.onclick = () => {
      const open = hdrRows.classList.toggle('open');
      hdrToggle.textContent = (open ? '▾' : '▸') + ' Response headers';
    };
    resArea.appendChild(hdrToggle);
    resArea.appendChild(hdrRows);

    const ct = (result.headers['content-type'] || '').toLowerCase();
    if (result.bodyBase64 && ct.startsWith('image/')) {
      const img = document.createElement('img');
      img.id  = 'replayBodyOut';
      img.className = 'detail-body-image';
      img.src = `data:${ct};base64,${result.bodyBase64}`;
      img.alt = 'Response image preview';
      resArea.appendChild(img);
    } else {
      const bodyOut = document.createElement('pre');
      bodyOut.id = 'replayBodyOut';
      if (ct.includes('json')) {
        try { bodyOut.textContent = JSON.stringify(JSON.parse(result.body), null, 2); }
        catch { bodyOut.textContent = result.body; }
      } else if (ct.includes('xml') || ct.includes('html')) {
        try { bodyOut.textContent = formatXml(result.body); }
        catch { bodyOut.textContent = result.body; }
      } else {
        bodyOut.textContent = result.body;
      }
      resArea.appendChild(bodyOut);
    }
  };

  document.getElementById('replayToMockBtn').onclick = () => {
    const method  = document.getElementById('replayMethod').value;
    const url     = document.getElementById('replayUrl').value.trim();
    const headers = getEditorRequestHeaders();
    closeReplay();
    if (lastReplayResult) {
      const binary = !!lastReplayResult.bodyBase64;
      openMockFromRequest(method, url, lastReplayResult.status, binary ? undefined : lastReplayResult.body, {
        requestHeaders:  headers,
        responseHeaders: lastReplayResult.headers || {},
        bodyUnavailable: binary,
      });
    } else {
      openMockFromRequest(method, url, undefined, undefined, {
        requestHeaders:  headers,
        responseHeaders: {},
        bodyUnavailable: true,
      });
    }
  };

  document.getElementById('replayToResilienceBtn').onclick = () => {
    const method  = document.getElementById('replayMethod').value;
    const url     = document.getElementById('replayUrl').value.trim();
    const headers = getEditorRequestHeaders();
    const body    = document.getElementById('replayBody').value;
    closeReplay();
    openResilienceFromRequest(method, url, headers, body || null);
  };

}
