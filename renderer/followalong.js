/* global testerBrowser */
import { escHtml } from './utils.js';
import { populateSessionPickers } from './session-picker.js';

let cachedSessions = [];

export function initFollow() {
  const panel = document.getElementById('followPanel');
  if (panel.dataset.initialized) { refreshFollowPanel(); return; }
  panel.dataset.initialized = '1';

  panel.innerHTML = `
    <div class="follow-toolbar">
      <label class="diff-label">Leader
        <select class="diff-pick" id="followPickLeader"></select>
      </label>
      <label class="diff-label">Follower
        <select class="diff-pick" id="followPickFollower"></select>
      </label>
      <label class="follow-nav-toggle">
        <input type="checkbox" id="followMirrorNav" />
        Mirror navigation
      </label>
      <button class="diff-run-btn" id="followStartBtn">Start Follow Along</button>
      <button class="diff-har-btn" id="followClearLogBtn">Clear log</button>
    </div>
    <div class="follow-hint">Pick a leader and a follower session, then Start. Clicks and field input on the leader are mirrored live onto the follower via its equivalent element — not raw coordinates. "Mirror navigation" also sends the follower to whatever page the leader navigates to (link clicks, redirecting form submits, address-bar changes); leave it off to mirror only in-page interactions.</div>
    <div class="follow-pairs" id="followPairs"></div>
    <div class="follow-log" id="followLog"></div>`;

  populatePickers();
  document.getElementById('followStartBtn').addEventListener('click', startFollow);
  document.getElementById('followClearLogBtn').addEventListener('click', () => {
    document.getElementById('followLog').innerHTML = '';
  });

  testerBrowser.followAlong.onStepResult(({ step, result }) => logStepResult(step, result));

  refreshFollowPanel();
}

export async function refreshFollowPickers() {
  const pick = document.getElementById('followPickLeader');
  if (!pick) return; // panel not yet initialised
  await populatePickers();
  await refreshFollowPanel();
}

async function populatePickers() {
  cachedSessions = await populateSessionPickers('followPickLeader', 'followPickFollower');
}

async function startFollow() {
  const leaderId   = document.getElementById('followPickLeader')?.value;
  const followerId = document.getElementById('followPickFollower')?.value;
  const mirrorNavigation = document.getElementById('followMirrorNav')?.checked ?? false;
  const hint = document.getElementById('followLog');
  if (!leaderId || !followerId) { setLog('Pick both a leader and a follower session.', true); return; }
  if (leaderId === followerId) { setLog('Pick two different sessions.', true); return; }

  const result = await testerBrowser.followAlong.start(leaderId, followerId, mirrorNavigation);
  if (!result.ok) { setLog(result.error || 'Could not start Follow Along.', true); return; }
  if (hint) hint.innerHTML = '';
  await refreshFollowPanel();
}

async function stopFollow(leaderId) {
  await testerBrowser.followAlong.stop(leaderId);
  await refreshFollowPanel();
}

async function toggleMirrorNav(leaderId, checked) {
  await testerBrowser.followAlong.setMirrorNavigation(leaderId, checked);
}

async function refreshFollowPanel() {
  const pairsEl = document.getElementById('followPairs');
  if (!pairsEl) return;
  const pairings = await testerBrowser.followAlong.list();
  const sessions = cachedSessions.length ? cachedSessions : await testerBrowser.sessions.list();
  const nameOf = (id) => sessions.find(s => s.id === id)?.name || '(closed session)';

  if (pairings.length === 0) {
    pairsEl.innerHTML = '<div class="follow-hint">No active Follow Along links.</div>';
    return;
  }

  pairsEl.innerHTML = pairings.map(p => `
    <div class="follow-pair" data-leader="${p.leaderId}">
      <span class="follow-pair-desc"><b>${escHtml(nameOf(p.leaderId))}</b> &rarr; <b>${escHtml(nameOf(p.followerId))}</b></span>
      <label class="follow-nav-toggle">
        <input type="checkbox" class="follow-nav-check" ${p.mirrorNavigation ? 'checked' : ''} />
        Mirror navigation
      </label>
      <button class="follow-stop-btn">Stop</button>
    </div>`).join('');

  for (const row of pairsEl.querySelectorAll('.follow-pair')) {
    const leaderId = row.dataset.leader;
    row.querySelector('.follow-stop-btn').onclick = () => stopFollow(leaderId);
    row.querySelector('.follow-nav-check').onchange = (e) => toggleMirrorNav(leaderId, e.target.checked);
  }
}

function setLog(text, isError) {
  const log = document.getElementById('followLog');
  if (!log) return;
  log.innerHTML = `<div class="follow-log-line ${isError ? 'err' : 'ok'}">${escHtml(text)}</div>`;
}

// Long URLs would otherwise wrap the whole log line and push older lines
// out of view; the full URL is still visible via a tooltip on the line
// itself if truncated.
function truncateUrl(url, max = 60) {
  return url.length > max ? url.slice(0, max - 1) + '…' : url;
}

function logStepResult(step, result) {
  const log = document.getElementById('followLog');
  if (!log) return;
  const desc = step.type === 'click' ? `click ${step.selector}`
    : step.type === 'fill' ? `fill ${step.selector}`
    : step.type === 'navigate' ? `navigate to ${truncateUrl(step.url || '')}`
    : step.type === 'navigate-in-page' ? `in-page navigate to ${truncateUrl(step.url || '')}`
    : step.type;
  const line = document.createElement('div');
  line.className = 'follow-log-line ' + (result.success ? 'ok' : 'err');
  line.textContent = result.success
    ? `✓ mirrored ${desc}`
    : `✗ failed to mirror ${desc}: ${result.error || 'unknown error'}`;
  if (step.url) line.title = step.url;
  log.prepend(line);
  while (log.children.length > 50) log.removeChild(log.lastChild);
}

