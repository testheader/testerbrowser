/* global testerBrowser */
import { escHtml } from './utils.js';

// Builds a <select>'s <option> list from a session array — the one bit
// diff.js/followalong.js's paired pickers and visual-regression.js's single
// "compare against" picker all actually share. `excludeId` drops one
// session (used by the paired pickers, below, so A can't also be B);
// `extraFirstOption` prepends a synthetic non-session choice (a "— pick
// session —" placeholder here, "This session" in visual-regression.js).
export function buildSessionOptions(select, sessions, opts = {}) {
  const { excludeId, extraFirstOption } = opts;
  const current = select.value;
  const filtered = excludeId ? sessions.filter(s => s.id !== excludeId) : sessions;
  const optsHtml = filtered.map(s => `<option value="${s.id}">${escHtml(s.name)}</option>`).join('');
  const firstHtml = extraFirstOption ? `<option value="${extraFirstOption.value}">${escHtml(extraFirstOption.label)}</option>` : '';
  select.innerHTML = firstHtml + optsHtml;
  if (current && current !== excludeId) select.value = current;
}

function buildPickerOptions(select, sessions, excludeId) {
  buildSessionOptions(select, sessions, { excludeId, extraFirstOption: { value: '', label: '— pick session —' } });
}

// Wires up a pair of <select> elements as complementary session pickers:
// each excludes whatever the other has selected, and changing one re-filters
// the other's options. Shared by diff.js (session A vs B) and
// followalong.js (leader vs follower) — same logic, previously two copies
// that only differed in element ids. Returns the session list so the caller
// can cache it for its own other lookups (e.g. resolving a name by id).
export async function populateSessionPickers(pickAId, pickBId) {
  const sessions = await testerBrowser.sessions.list();
  const pickA = document.getElementById(pickAId);
  const pickB = document.getElementById(pickBId);
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
