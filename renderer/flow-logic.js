// Pure "where is the user in this workflow" helpers behind flow-steps.js — no
// DOM, no IPC, so they are unit-testable under plain Jest/node
// (src/__tests__/flow-logic.test.ts). Each returns the index of the *current*
// step, derived from state the feature already holds; steps before it render
// as done, steps after it as todo. Nothing is persisted or dismissed.

/**
 * Record & Playback: Record → Assert → Save → Run.
 * Idle with nothing recorded → Record (or Run, once tests are saved);
 * recording → Assert; stopped with unsaved steps → Save.
 * @param {{ isRecording: boolean, unsavedSteps: number, savedCount: number }} s
 * @returns {number}
 */
export function recordFlowStep({ isRecording, unsavedSteps, savedCount }) {
  if (isRecording) return 1;
  if (unsavedSteps > 0) return 2;
  return savedCount > 0 ? 3 : 0;
}

/**
 * UI diff after a comparison: Compare → Review changes → Ignore noise
 * (optional) → Save / export. Before any comparison the pre-compare guide
 * owns the panel, so this rests on step 0. Reviewing is current until a
 * changed region has been visited, then the flow jumps to Save / export.
 * `hasBaseline` and `baselineSaved` don't change the position; they only
 * drive the Save / export button's wording in the caller.
 * @param {{ hasBaseline: boolean, hasResult: boolean, regionVisited: boolean, baselineSaved: boolean }} s
 * @returns {number}
 */
export function vrFlowStep({ hasBaseline, hasResult, regionVisited }) {
  if (!hasBaseline || !hasResult) return 0;
  return regionVisited ? 3 : 1;
}

/**
 * Jira: Connect → Load ticket or report bug → Attach evidence. Not configured
 * wins even if the bug-form flag is stale.
 * @param {{ configured: boolean, bugFormOpen: boolean }} s
 * @returns {number}
 */
export function jiraFlowStep({ configured, bugFormOpen }) {
  if (!configured) return 0;
  return bugFormOpen ? 2 : 1;
}
