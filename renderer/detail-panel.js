import { state } from './state.js';
import { escHtml, getEventTabId } from './utils.js';

function statusClass(code) {
  if (!code) return 'detail-status-err';
  if (code < 300) return 'detail-status-ok';
  if (code < 400) return 'detail-status-redir';
  return 'detail-status-err';
}

function methodClass(method) {
  const m = String(method || '').toUpperCase();
  return ['GET','POST','PUT','DELETE','PATCH'].includes(m) ? `detail-method-${m}` : 'detail-method-other';
}

function getEventTabLabel(e) {
  if (e.kind === 'network-request' || e.kind === 'network-response') {
    const m = e.summary.match(/^([A-Z]+)\s+(.+)$/);
    if (m) {
      let path = m[2];
      try { path = new URL(m[2]).pathname || '/'; } catch {}
      return `${m[1]} ${path.length > 18 ? path.slice(0, 18) + '…' : path}`;
    }
  }
  return e.summary.length > 22 ? e.summary.slice(0, 22) + '…' : e.summary;
}

export function openDetailTab(e) {
  const tabId = getEventTabId(e);
  const existing = state.detailTabs.find(t => t.id === tabId);
  if (existing) {
    state.activeDetailTabId = tabId;
  } else {
    state.detailTabs.push({ id: tabId, event: e, label: getEventTabLabel(e) });
    state.activeDetailTabId = tabId;
  }
  renderDetailPanel();
}

export function closeDetailTab(tabId) {
  const idx = state.detailTabs.findIndex(t => t.id === tabId);
  if (idx === -1) return;
  state.detailTabs.splice(idx, 1);
  if (state.activeDetailTabId === tabId) {
    state.activeDetailTabId = state.detailTabs.length > 0
      ? state.detailTabs[Math.max(0, idx - 1)].id
      : null;
  }
  renderDetailPanel();
}

function renderDetailTabs() {
  const bar = document.getElementById('detailPanelTabBar');
  bar.innerHTML = '';
  for (const tab of state.detailTabs) {
    const btn = document.createElement('button');
    btn.className = `detail-tab${tab.id === state.activeDetailTabId ? ' active' : ''}`;
    btn.title = tab.event.summary;

    const lbl = document.createElement('span');
    lbl.className   = 'detail-tab-label';
    lbl.textContent = tab.label;

    const cls = document.createElement('span');
    cls.className   = 'detail-tab-close';
    cls.textContent = '×';
    cls.onclick = (ev) => { ev.stopPropagation(); closeDetailTab(tab.id); };

    btn.appendChild(lbl);
    btn.appendChild(cls);
    btn.onclick = () => { state.activeDetailTabId = tab.id; renderDetailPanel(); };
    btn.addEventListener('auxclick', (ev) => { if (ev.button === 1) { ev.preventDefault(); closeDetailTab(tab.id); } });
    bar.appendChild(btn);
  }
}

function renderDetailContent() {
  const content = document.getElementById('detailPanelContent');
  if (!state.activeDetailTabId) { content.innerHTML = ''; return; }
  const tab = state.detailTabs.find(t => t.id === state.activeDetailTabId);
  if (!tab) { content.innerHTML = ''; return; }

  const e = tab.event;
  let html = '';

  try {
    if (e.kind.startsWith('network-')) {
      const rid    = state.activeDetailTabId;
      const reqEvt  = state.timelineEvents.find(ev => ev.kind === 'network-request'  && getEventTabId(ev) === rid);
      const resEvt  = state.timelineEvents.find(ev => ev.kind === 'network-response' && getEventTabId(ev) === rid);
      const bodyEvt = state.timelineEvents.find(ev => ev.kind === 'network-body'     && getEventTabId(ev) === rid);
      const failEvt = state.timelineEvents.find(ev => ev.kind === 'network-failed'   && getEventTabId(ev) === rid);

      if (reqEvt && reqEvt.payload) {
        const req = (JSON.parse(reqEvt.payload).request) || {};
        html += `<div class="detail-section">
          <span class="detail-method ${methodClass(req.method)}">${escHtml(req.method || '?')}</span>
          <span class="detail-url">${escHtml(req.url || '')}</span>
        </div>`;
        if (req.headers && Object.keys(req.headers).length) {
          html += `<div class="detail-section"><h3>Request Headers</h3><table class="headers-table">`;
          for (const [k, v] of Object.entries(req.headers)) {
            html += `<tr><td>${escHtml(k)}</td><td>${escHtml(String(v))}</td></tr>`;
          }
          html += `</table></div>`;
        }
        if (req.postData) {
          html += `<div class="detail-section"><h3>Request Body</h3><pre class="detail-body-pre">${escHtml(req.postData)}</pre></div>`;
        }
      }

      if (resEvt && resEvt.payload) {
        const res = (JSON.parse(resEvt.payload).response) || {};
        html += `<div class="detail-section">
          <h3>Response</h3>
          <span class="${statusClass(res.status)}">${escHtml(String(res.status || ''))}</span>
          <span style="color:#666;margin:0 6px">${escHtml(res.statusText || '')}</span>
        </div>`;
        if (res.headers && Object.keys(res.headers).length) {
          html += `<div class="detail-section"><h3>Response Headers</h3><table class="headers-table">`;
          for (const [k, v] of Object.entries(res.headers)) {
            html += `<tr><td>${escHtml(k)}</td><td>${escHtml(String(v))}</td></tr>`;
          }
          html += `</table></div>`;
        }
      } else if (!resEvt && !failEvt) {
        html += `<div class="detail-section"><span style="color:#555;font-size:11px">Waiting for response…</span></div>`;
      }

      if (bodyEvt && bodyEvt.payload) {
        const bp = JSON.parse(bodyEvt.payload);
        html += `<div class="detail-section"><h3>Response Body</h3>`;
        if (bp.base64Encoded) html += `<div style="color:#555;font-size:11px;margin-bottom:4px">[base64 encoded]</div>`;
        html += `<pre class="detail-body-pre">${escHtml(String(bp.body || ''))}</pre></div>`;
      }

      if (failEvt && failEvt.payload) {
        const fp = JSON.parse(failEvt.payload);
        html += `<div class="detail-section"><h3 style="color:#ff8080">Request Failed</h3>
          <div style="color:#ff8080">${escHtml(fp.errorText || 'Unknown error')}</div>`;
        if (fp.canceled) html += `<div style="color:#555;font-size:11px;margin-top:4px">Request was canceled</div>`;
        html += `</div>`;
      }

      if (!html) html = `<pre class="detail-body-pre">${escHtml(e.payload || e.summary)}</pre>`;
    } else {
      const p = e.payload ? JSON.parse(e.payload) : null;
      html += `<div class="detail-section"><h3>${escHtml(e.kind)}</h3>
        <pre class="detail-body-pre">${escHtml(p ? JSON.stringify(p, null, 2) : e.summary)}</pre></div>`;
    }
  } catch {
    html += `<pre class="detail-body-pre">${escHtml(e.payload || e.summary)}</pre>`;
  }
  content.innerHTML = html;
}

export function renderDetailPanel() {
  const panel        = document.getElementById('detailPanel');
  const resizeHandle = document.getElementById('detailPanelResizeHandle');
  // The timeline is shared by the Console and Network tabs, so rows on either
  // can open a detail tab. Security findings link back to the network event
  // that produced them, so the Security tab shares the same detail panel.
  const showsDetail  = state.activeConsoleTab === 'console' || state.activeConsoleTab === 'network' || state.activeConsoleTab === 'security';
  const hasOpen      = state.detailTabs.length > 0 && showsDetail;
  panel.classList.toggle('open', hasOpen);
  resizeHandle.style.display = hasOpen ? '' : 'none';
  renderDetailTabs();
  renderDetailContent();
  // Update detail-row-active highlights without a full timeline re-render
  document.querySelectorAll('.evt').forEach(row => {
    row.classList.toggle('detail-row-active', state.detailTabs.some(t => t.id === row.dataset.tabId));
  });
}

export function initDetailPanel() {
  const handle = document.getElementById('detailPanelResizeHandle');
  const panel  = document.getElementById('detailPanel');
  const body   = document.getElementById('consolePanelBody');
  const MIN_W  = 120;

  try {
    const saved = localStorage.getItem('consoleDetailSplitRatio');
    if (saved) panel.style.width = saved;
  } catch {}

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panel.offsetWidth;
    const onMove = (ev) => {
      const maxW = (body.offsetWidth || window.innerWidth) - MIN_W;
      const newW = Math.max(MIN_W, Math.min(startW + (startX - ev.clientX), maxW));
      panel.style.width = newW + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      try { localStorage.setItem('consoleDetailSplitRatio', panel.style.width); } catch {}
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });
}
