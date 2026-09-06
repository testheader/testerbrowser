/* global testerBrowser */
// Dismissible banners for things the user should know about but that
// shouldn't interrupt them the way a modal would: an uncaught main-process
// error (recordAppError in index.ts) or a per-session recording failure
// (#21 — resilience), and a certificate error on the active tab (#19 — on
// top of Chromium's own interstitial, which already blocks the page).
import { state } from './state.js';

export function initErrors() {
  const errBanner = document.getElementById('mainErrorBanner');
  const errMsg    = document.getElementById('mainErrorMsg');
  testerBrowser.app.onMainError(({ message }) => {
    errMsg.textContent = message;
    errBanner.hidden = false;
  });
  document.getElementById('mainErrorDismiss').onclick = () => { errBanner.hidden = true; };

  const certBanner = document.getElementById('certErrorBanner');
  const certMsg    = document.getElementById('certErrorMsg');
  testerBrowser.sessions.onCertificateError(({ id, url }) => {
    if (id !== state.activeId) return; // only surface it for the tab currently in view
    try { certMsg.textContent = `Blocked an untrusted certificate on ${new URL(url).hostname}`; }
    catch { certMsg.textContent = 'Blocked an untrusted certificate.'; }
    certBanner.hidden = false;
  });
  document.getElementById('certErrorDismiss').onclick = () => { certBanner.hidden = true; };
}
