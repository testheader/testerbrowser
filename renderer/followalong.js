/* global testerBrowser */
import { escHtml } from './utils.js';
import { populateSessionPickers } from './session-picker.js';
import { renderEmptyState } from './empty-state.js';

let cachedSessions = [];
// #313: Pause is stop + remember the pair, Resume starts it again — there is
// no pause channel in the main process, and mirroring logic is out of scope.
/** @type {Map<string, {leaderId: string, followerId: string, mirrorNavigation: boolean}>} */
const pausedPairs = new Map();

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
      <span class="follow-spacer"></span>
      <button class="net-chip" id="followClearLogBtn" type="button">Clear log</button>
      <button class="follow-strong" id="followStartBtn" type="button">Start following</button>
    </div>
    <div class="follow-pairs" id="followPairs"></div>
    <div class="follow-log" id="followLog"></div>`;

  // #258: don't also fire-and-forget populatePickers() here — console-tabs.js
  // always calls refreshFollowPickers() right after initFollow(), which
  // awaits its own populatePickers() call. Racing an un-awaited call here
  // against that one let whichever resolved second read the other's
  // already-mutated picker value as its own "previous selection", excluding
  // a real session from the OTHER picker's option list entirely on the
  // panel's first-ever open in a session.
  document.getElementById('followStartBtn').addEventListener('click', startFollow);
  document.getElementById('followClearLogBtn').addEventListener('click', () => {
    document.getElementById('followLog').innerHTML = '';
  });

  testerBrowser.followAlong.onStepResult(({ step, result }) => logStepResult(step, result));

  refreshFollowPanel();
}

export async function refreshFollowPickers() {
  const pick = /** @type {HTMLSelectElement} */ (document.getElementById('followPickLeader'));
  if (!pick) return; // panel not yet initialised
  await populatePickers();
  await refreshFollowPanel();
}

async function populatePickers() {
  const sessions = await populateSessionPickers('followPickLeader', 'followPickFollower');
  if (sessions) cachedSessions = sessions; // null means a newer call already superseded this one
}

async function startFollow() {
  const leaderId   = /** @type {HTMLSelectElement} */ (document.getElementById('followPickLeader'))?.value;
  const followerId = /** @type {HTMLSelectElement} */ (document.getElementById('followPickFollower'))?.value;
  const mirrorNavigation = /** @type {HTMLInputElement} */ (document.getElementById('followMirrorNav'))?.checked ?? false;
  if (!leaderId || !followerId) { setLog('Pick both a leader and a follower session.', 'err'); return; }
  if (leaderId === followerId) { setLog('Pick two different sessions.', 'err'); return; }

  const result = await testerBrowser.followAlong.start(leaderId, followerId, mirrorNavigation);
  if (!result.ok) { setLog(result.error || 'Could not start Follow Along.', 'err'); return; }
  pausedPairs.delete(leaderId);

  // #258: leader and follower sharing a partition (e.g. a middle-clicked tab)
  // share cookies/storage too — mirrored logins and form posts then act on
  // the same account twice, silently, unless flagged here.
  const leaderSession = cachedSessions.find(s => s.id === leaderId);
  const followerSession = cachedSessions.find(s => s.id === followerId);
  if (leaderSession && followerSession && leaderSession.partition === followerSession.partition) {
    setLog('Leader and follower share cookies/storage — actions will affect the same account.', 'warn');
  } else {
    const log = document.getElementById('followLog');
    if (log) log.innerHTML = '';
  }
  await refreshFollowPanel();
}

async function stopFollow(leaderId) {
  pausedPairs.delete(leaderId);
  await testerBrowser.followAlong.stop(leaderId);
  await refreshFollowPanel();
}

async function pauseFollow(leaderId) {
  const pairing = (await testerBrowser.followAlong.list()).find(p => p.leaderId === leaderId);
  if (!pairing) return;
  pausedPairs.set(leaderId, { leaderId, followerId: pairing.followerId, mirrorNavigation: !!pairing.mirrorNavigation });
  await testerBrowser.followAlong.stop(leaderId);
  await refreshFollowPanel();
}

async function resumeFollow(leaderId) {
  const p = pausedPairs.get(leaderId);
  if (!p) return;
  const result = await testerBrowser.followAlong.start(p.leaderId, p.followerId, p.mirrorNavigation);
  if (!result.ok) { setLog(result.error || 'Could not resume Follow Along.', 'err'); return; }
  pausedPairs.delete(leaderId);
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

  if (pairings.length === 0 && pausedPairs.size === 0) {
    pairsEl.replaceChildren(renderEmptyState({
      icon: 'users', tone: 'accent', title: 'Follow along',
      text: "Mirror another tab's navigation in this one.",
      actionLabel: 'Pair with a tab', onAction: startFollow,
    }));
    return;
  }

  const live = pairings.map(p => `
    <div class="follow-pair" data-leader="${p.leaderId}">
      <span class="follow-live"><span class="follow-live-dot" aria-hidden="true"></span>Live</span>
      <span class="follow-chip">${escHtml(nameOf(p.leaderId))} leads</span>
      <i class="icon-arrow-right follow-arrow" aria-hidden="true"></i>
      <span class="follow-chip">${escHtml(nameOf(p.followerId))} follows</span>
      <span class="follow-sub">Mirroring ${p.mirrorNavigation ? 'navigation, ' : ''}clicks and input</span>
      <span class="follow-spacer"></span>
      <label class="follow-nav-toggle">
        <input type="checkbox" class="follow-nav-check" ${p.mirrorNavigation ? 'checked' : ''} />
        Mirror navigation
      </label>
      <button class="net-chip follow-pause-btn" type="button"><i class="icon-pause" aria-hidden="true"></i>Pause</button>
      <button class="follow-strong follow-stop-btn" type="button">Stop following</button>
    </div>`);
  const paused = [...pausedPairs.values()].map(p => `
    <div class="follow-pair paused" data-leader="${p.leaderId}">
      <span class="follow-live paused">Paused</span>
      <span class="follow-chip">${escHtml(nameOf(p.leaderId))} leads</span>
      <i class="icon-arrow-right follow-arrow" aria-hidden="true"></i>
      <span class="follow-chip">${escHtml(nameOf(p.followerId))} follows</span>
      <span class="follow-spacer"></span>
      <button class="net-chip follow-resume-btn" type="button"><i class="icon-play" aria-hidden="true"></i>Resume</button>
      <button class="follow-strong follow-stop-btn" type="button">Stop following</button>
    </div>`);
  pairsEl.innerHTML = [...live, ...paused].join('');

  for (const row of pairsEl.querySelectorAll('.follow-pair')) {
    const leaderId = row.dataset.leader;
    const isPaused = row.classList.contains('paused');
    /** @type {HTMLElement} */ (row.querySelector('.follow-stop-btn')).onclick = () => stopFollow(leaderId);
    if (isPaused) {
      /** @type {HTMLElement} */ (row.querySelector('.follow-resume-btn')).onclick = () => resumeFollow(leaderId);
    } else {
      /** @type {HTMLElement} */ (row.querySelector('.follow-nav-check')).onchange = (e) => toggleMirrorNav(leaderId, /** @type {HTMLInputElement} */ (e.target).checked);
      /** @type {HTMLElement} */ (row.querySelector('.follow-pause-btn')).onclick = () => pauseFollow(leaderId);
    }
  }
}

// One event row: time · icon · action · target (mono) · result on the right.
function buildLogLine(kind, { icon, action, target, result, title }) {
  const line = document.createElement('div');
  line.className = 'follow-log-line ' + kind;
  const cell = (cls, text) => { const c = document.createElement('span'); c.className = cls; c.textContent = text; return c; };
  line.appendChild(cell('fl-time', new Date().toLocaleTimeString([], { hour12: false })));
  const tile = document.createElement('span');
  tile.className = 'fl-icon';
  tile.innerHTML = `<i class="icon-${icon}" aria-hidden="true"></i>`;
  line.appendChild(tile);
  line.appendChild(cell('fl-action', action));
  line.appendChild(cell('fl-target', target));
  line.appendChild(cell('fl-result', result));
  if (title) line.title = title;
  return line;
}

function setLog(text, kind = 'ok') {
  const log = document.getElementById('followLog');
  if (!log) return;
  log.replaceChildren(buildLogLine(kind, { icon: kind === 'ok' ? 'info' : 'triangle-alert', action: kind === 'ok' ? 'Info' : 'Warning', target: text, result: '', title: '' }));
}

const STEP_LABELS = { click: ['mouse-pointer-click', 'Click'], check: ['square-check', 'Check'], fill: ['keyboard', 'Fill'],
  navigate: ['globe', 'Navigate'], 'navigate-in-page': ['globe', 'Navigate (in page)'] };

function logStepResult(step, result) {
  const log = document.getElementById('followLog');
  if (!log) return;
  const [icon, label] = STEP_LABELS[step.type] || ['circle', step.type];
  const action = step.type === 'check' ? (step.value ? 'Check' : 'Uncheck') : label;
  const target = step.type === 'navigate' || step.type === 'navigate-in-page' ? (step.url || '')
    : step.type === 'fill' && step.sensitive ? `${step.selector} (hidden \u2014 not relayed)`
    : (step.selector || step.url || '');
  const failMsg = result.error ? (/not found/i.test(result.error) ? 'Element not found' : result.error) : 'unknown error';
  const line = buildLogLine(result.success ? 'ok' : 'err', {
    icon, action, target,
    result: result.success ? '\u2713 Mirrored' : `\u26a0 ${failMsg}`,
    title: step.url || result.error || '',
  });
  log.prepend(line);
  while (log.children.length > 50) log.removeChild(log.lastChild);
}
