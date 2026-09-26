// #254: unifies emulation.js's showStatus and record-playback.js's
// showFormStatus — the same "show a message in a designated status element,
// color it ok/error, auto-clear after 4s" pattern, previously two
// near-identical copies. emulation.js's own version styled via an inline
// `el.style.color` fallback to --err-color/--ok-color, which were never
// actually defined anywhere in style.css — it always fell back to a fixed
// hardcoded color, ignoring the light/dark theme. Both panels' status
// elements now share the .status-msg/.status-msg-error CSS pair instead, so
// this is a strict improvement for the spoof panel, not just a refactor.
export function showStatus(elementId, msg, isError) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('status-msg-error', !!isError);
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.textContent = ''; }, 4000);
}
