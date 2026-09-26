/* global testerBrowser */

// #254: consolidates the "hide the page view, toggle .open, backdrop-click-
// to-close, Escape-to-close" wiring that bug report, crash report, history,
// the image lightbox, notes, replay, settings and test data each previously
// copy-pasted with small, easy-to-drift-apart inconsistencies. Each modal
// keeps its own overlay element, its own field population/reset and any
// other modal-specific state — this only owns the shared plumbing.
//
// Backdrop-click and Escape wiring is opt-in per modal via initModal(), not
// automatic: crash report deliberately has neither (a "the app just
// crashed" notice you don't want dismissed by an errant click), and that
// behavior must survive this consolidation, not get flattened away.

const registry = new Map(); // overlayId -> { close, confirmClose }
// Registered lazily, on the first initModal() call, not at module load —
// several src/__tests__/*.test.ts files import a renderer module for its
// pure logic only and never call any init*() function, and only run under
// Jest's plain Node environment (no `document`), same as every other
// renderer module here that defers its own document.addEventListener() call
// into an init*() function instead of running it at import time.
let escapeListenerRegistered = false;

function ensureEscapeListener() {
  if (escapeListenerRegistered) return;
  escapeListenerRegistered = true;
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const overlayId of registry.keys()) {
      if (document.getElementById(overlayId)?.classList.contains('open')) {
        requestClose(overlayId);
        return; // at most one modal is ever open at a time
      }
    }
  });
}

// Registers Escape-to-close (always) and backdrop-click-to-close (unless
// `backdrop: false`) for `overlayId`, both routed through requestClose()
// below. `close` is the modal's own direct close function (e.g. what its
// Cancel/Done button already calls). `confirmClose`, if given, is an async
// predicate consulted only by requestClose() — a false return vetoes the
// close (notes.js's unsaved-text guard, #268) — never by a direct call to
// `close`/closeModal() itself, matching how each modal's Save-vs-Cancel
// distinction already worked. `backdrop: false` preserves replay.js's
// existing behavior (an in-flight request shouldn't be dismissed by an
// accidental click outside the modal, but Escape still closes it); a modal
// wanting neither (crash report — a "the app just crashed" notice you don't
// want dismissed by an errant click OR key) simply never calls initModal().
export function initModal(overlayId, close, { confirmClose, backdrop = true } = {}) {
  ensureEscapeListener();
  registry.set(overlayId, { close, confirmClose });
  if (backdrop) {
    const overlay = document.getElementById(overlayId);
    overlay.onclick = (e) => { if (e.target === overlay) requestClose(overlayId); };
  }
}

// The "soft" close entry point — backdrop click, Escape, and any button a
// modal wants to guard the same way (notes.js's Close/× buttons, per #268).
export async function requestClose(overlayId) {
  const cfg = registry.get(overlayId);
  if (!cfg) return;
  if (cfg.confirmClose && !(await cfg.confirmClose())) return;
  await cfg.close();
}

// Raw show/hide — no confirm check, for a modal's own direct open/close
// (including a flow like bugreport.js's screenshot retake, which briefly
// hides and re-shows its overlay outside the normal open/close lifecycle).
export async function openModal(overlayId, onOpen) {
  await testerBrowser.layout.setViewerVisible(false);
  document.getElementById(overlayId).classList.add('open');
  onOpen?.();
}

export async function closeModal(overlayId) {
  document.getElementById(overlayId).classList.remove('open');
  await testerBrowser.layout.setViewerVisible(true);
}
