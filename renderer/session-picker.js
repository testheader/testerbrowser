/* global testerBrowser */
import { escHtml } from './utils.js';

function hostOf(url) {
  if (!url) return '';
  try {
    return new URL(url).host; // '' for file:// URLs (e.g. newtab.html) — no host to show
  } catch {
    return '';
  }
}

// #258: two tabs on the same site, or two tabs sharing a partition (e.g. a
// middle-clicked link), used to be visually indistinguishable in these
// pickers — a tester could easily compare/pair the wrong two sessions.
// Exported standalone (pure, no DOM) for unit testing.
export function pickerLabel(session, allSessions) {
  const host = hostOf(session.url);
  const shared = allSessions.some(s => s.id !== session.id && s.partition === session.partition);
  return `${session.name}${host ? ` — ${host}` : ''}${shared ? ' · shared session' : ''}`;
}

// Builds a <select>'s <option> list from a session array — the one bit
// diff.js/followalong.js's paired pickers and visual-regression.js's single
// "compare against" picker all actually share. `excludeId` drops one
// session (used by the paired pickers, below, so A can't also be B);
// `extraFirstOption` prepends a synthetic non-session choice (a "— pick
// session —" placeholder here, "This session" in visual-regression.js).
// `allSessions` (defaulting to `sessions` itself) is the pool pickerLabel()
// checks for a shared partition — passed separately so an excluded session
// is still considered when flagging "shared session".
export function buildSessionOptions(select, sessions, opts = {}) {
  const { excludeId, extraFirstOption, allSessions = sessions } = opts;
  const current = select.value;
  const filtered = excludeId ? sessions.filter(s => s.id !== excludeId) : sessions;
  const optsHtml = filtered.map(s => `<option value="${s.id}">${escHtml(pickerLabel(s, allSessions))}</option>`).join('');
  const firstHtml = extraFirstOption ? `<option value="${extraFirstOption.value}">${escHtml(extraFirstOption.label)}</option>` : '';
  select.innerHTML = firstHtml + optsHtml;
  if (current && current !== excludeId) select.value = current;
}

function buildPickerOptions(select, sessions, excludeId) {
  buildSessionOptions(select, sessions, { excludeId, extraFirstOption: { value: '', label: '— pick session —' } });
}

// #269 CI: tabs.js's refreshTabs() calls refreshDiffPickers()/
// refreshFollowPickers() on every session-changing event (new tab,
// navigate, rename, ...) without awaiting them, so several
// populateSessionPickers() calls for the same pair of picker ids can be
// in flight at once — and their `sessions.list()` IPC round-trips can
// resolve out of order under load. Applying a stale (earlier-started,
// later-resolving) call's session list after a fresher call already
// rebuilt the pickers would silently overwrite the current selection with
// options that may not even include it (e.g. a just-created session B,
// invisible to the older snapshot) — the `<select>`'s value assignment
// then just silently fails, clearing the picker. Keyed by the pair of
// element ids so diff.js's and followalong.js's own pickers each track
// their own latest call independently.
const pickerCallSeq = new Map();

// Wires up a pair of <select> elements as complementary session pickers:
// each excludes whatever the other has selected, and changing one re-filters
// the other's options. Shared by diff.js (session A vs B) and
// followalong.js (leader vs follower) — same logic, previously two copies
// that only differed in element ids. Returns the session list so the caller
// can cache it for its own other lookups (e.g. resolving a name by id), or
// null when a newer call for this same pair of picker ids has since
// started — the caller should skip anything it would otherwise do with a
// stale list (e.g. diff.js caching it for name lookups).
export async function populateSessionPickers(pickAId, pickBId) {
  const key = `${pickAId}\u0000${pickBId}`;
  const mySeq = (pickerCallSeq.get(key) ?? 0) + 1;
  pickerCallSeq.set(key, mySeq);

  const sessions = await testerBrowser.sessions.list();
  if (pickerCallSeq.get(key) !== mySeq) return null; // superseded while awaiting

  const pickA = /** @type {HTMLSelectElement} */ (document.getElementById(pickAId));
  const pickB = /** @type {HTMLSelectElement} */ (document.getElementById(pickBId));
  if (!pickA || !pickB) return sessions;

  const prevA = pickA.value;
  const prevB = pickB.value;

  buildPickerOptions(pickA, sessions, prevB);
  buildPickerOptions(pickB, sessions, prevA);

  // Restore previous selections if still valid; otherwise default to first two
  const validIds = new Set(sessions.map(s => s.id));
  if (prevA && validIds.has(prevA) && prevA !== pickB.value) {
    pickA.value = prevA;
  } else if (!pickA.value && sessions.length >= 1) {
    pickA.value = sessions[0].id;
  }
  if (prevB && validIds.has(prevB) && prevB !== pickA.value) {
    pickB.value = prevB;
  } else if (!pickB.value && sessions.length >= 2) {
    pickB.value = sessions[1].id;
  }

  pickA.onchange = () => {
    buildPickerOptions(pickB, sessions, pickA.value);
    if (pickB.value === pickA.value) pickB.value = '';
  };
  pickB.onchange = () => {
    buildPickerOptions(pickA, sessions, pickB.value);
    if (pickA.value === pickB.value) pickA.value = '';
  };

  return sessions;
}
