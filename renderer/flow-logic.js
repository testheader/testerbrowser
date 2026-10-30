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
 * Mock: Add rule → Enable → Verify. A rule that has matched at least one
 * request is the end of the flow.
 * @param {{ rules: Array<{ enabled?: boolean, hitCount?: number }> }} s
 * @returns {number}
 */
export function mockFlowStep({ rules }) {
  if (rules.length === 0) return 0;
  if (!rules.some((r) => r.enabled !== false)) return 1;
  return rules.some((r) => (r.hitCount || 0) > 0) ? 3 : 2;
}

/**
 * Resilience: Add rule → Enable → Reload and observe (same shape as Mock).
 * @param {{ rules: Array<{ enabled?: boolean, hitCount?: number }> }} s
 * @returns {number}
 */
export function resilienceFlowStep(s) {
  return mockFlowStep(s);
}
