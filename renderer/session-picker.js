/* global testerBrowser */
import { escHtml } from './utils.js';

function buildPickerOptions(select, sessions, excludeId) {
  const current = select.value;
  const opts = sessions
    .filter(s => s.id !== excludeId)
    .map(s => `<option value="${s.id}">${escHtml(s.name)}</option>`)
    .join('');
  select.innerHTML = '<option value="">— pick session —</option>' + opts;
  if (current && current !== excludeId) select.value = current;
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
