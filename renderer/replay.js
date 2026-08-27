/* global testerBrowser */
import { state } from './state.js';
import { escHtml, cookieMatchesDomain } from './utils.js';

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

function addKvRow(container, key, val) {
  const row    = document.createElement('div');
  row.className = 'kv-row';
  const kInput = document.createElement('input');
  kInput.className   = 'kv-key';
  kInput.type        = 'text';
  kInput.value       = key;
  kInput.placeholder = 'Name';
  const vInput = document.createElement('input');
  vInput.className   = 'kv-val';
  vInput.type        = 'text';
  vInput.value       = val;
  vInput.placeholder = 'Value';
  const del = document.createElement('button');
  del.className   = 'kv-del';
  del.textContent = '×';
  del.title       = 'Remove';
  del.onclick     = () => row.remove();
  row.appendChild(kInput);
  row.appendChild(vInput);
  row.appendChild(del);
  container.appendChild(row);
}

function readKvTable(container) {
  const obj = {};
  for (const row of container.querySelectorAll('.kv-row')) {
    const k = row.querySelector('.kv-key').value.trim();
    const v = row.querySelector('.kv-val').value;
    if (k) obj[k] = v;
  }
  return obj;
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

export async function openReplay(evt) {
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

  const hdrTable = document.getElementById('replayHeadersTable');
  const ckTable  = document.getElementById('replayCookiesTable');
  hdrTable.innerHTML = '';
  ckTable.innerHTML  = '';

  let cookieStr = '';
  for (const [k, v] of Object.entries(allHdrs)) {
    if (k.toLowerCase() === 'cookie') { cookieStr = v; continue; }
    addKvRow(hdrTable, k, v);
  }
  for (const [n, v] of parseCookieHeader(cookieStr)) {
    addKvRow(ckTable, n, v);
  }

  const sessionPick = document.getElementById('replayCookieSessionPick');
  sessionPick.innerHTML = '<option value="">Load from session…</option>';
  try {
    const sessions = await testerBrowser.sessions.list();
    for (const s of sessions) {
      const opt = document.createElement('option');
      opt.value       = s.id;
      opt.textContent = s.name;
      sessionPick.appendChild(opt);
    }
  } catch {}
  let reqHost = '';
  try { reqHost = new URL(url.startsWith('http') ? url : 'https://' + url).hostname; } catch {}
  sessionPick.dataset.reqHost = reqHost;

  await testerBrowser.layout.setViewerVisible(false);
  document.getElementById('replayOverlay').classList.add('open');
  document.getElementById('replayUrl').focus();
}

function closeReplay() {
  document.getElementById('replayOverlay').classList.remove('open');
  testerBrowser.layout.setViewerVisible(true);
}

export function initReplay() {
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

  document.getElementById('closeReplayBtn').onclick = closeReplay;
  document.getElementById('replayOverlay').onclick   = (e) => {
    if (e.target === document.getElementById('replayOverlay')) closeReplay();
  };

  document.getElementById('sendReplayBtn').onclick = async () => {
    const method = document.getElementById('replayMethod').value;
    const url    = document.getElementById('replayUrl').value.trim();
    const body   = document.getElementById('replayBody').value;
    if (!url) return;

    const headers  = readKvTable(document.getElementById('replayHeadersTable'));
    const cookieVal = readCookiesTable();
    if (cookieVal) headers['Cookie'] = cookieVal;

    const spinner = document.getElementById('replaySpinner');
    const resArea = document.getElementById('replayResponse');
    spinner.classList.add('visible');
    resArea.innerHTML = '';

    const result = await testerBrowser.recording.replay({ method, url, headers, body: body || undefined });
    spinner.classList.remove('visible');

    if (!result.ok) {
      resArea.innerHTML = `<div class="replay-res-status err">Error: ${escHtml(result.error || 'Unknown error')}</div>`;
      return;
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

    const bodyOut = document.createElement('pre');
    bodyOut.id = 'replayBodyOut';
    const ct = (result.headers['content-type'] || '').toLowerCase();
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
  };

  document.getElementById('exportHarBtn').onclick = async () => {
    if (!state.activeId) return;
    const har = await testerBrowser.recording.exportHAR(state.activeId);
    if (!har) return;
    const blob = new Blob([JSON.stringify(har, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `session-${state.activeId}.har`;
    a.click();
    URL.revokeObjectURL(url);
  };
}
