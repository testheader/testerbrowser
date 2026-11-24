/* global testerBrowser */
import { getActiveId, refreshTabs } from './tabs.js';

// Per-tab network + CPU throttling. The controls live in Spoof › Advanced
// (markup in emulation.js); the element ids keep their historical `res` prefix.

// #341: the tab's network/CPU throttling lives in Spoof › Advanced (markup in
// emulation.js); this wires its controls. Changes apply immediately, no reload.
export function initThrottleControls() {
  const networkSelect = /** @type {HTMLSelectElement} */ (document.getElementById('resNetworkSelect'));
  const cpuSelect      = /** @type {HTMLSelectElement} */ (document.getElementById('resCpuSelect'));
  const customFields   = document.getElementById('resCustomNetworkFields');

  networkSelect.addEventListener('change', () => {
    customFields.classList.toggle('res-hidden', networkSelect.value !== 'custom');
    if (networkSelect.value !== 'custom') applyConditionsFromForm();
  });
  cpuSelect.addEventListener('change', applyConditionsFromForm);
  document.getElementById('resCustomApplyBtn').addEventListener('click', applyConditionsFromForm);

  loadConditions();
}

// #265: reflects the active tab's own network/CPU conditions in the two
// selects (and the custom fields, if a custom network is active) — a null
// result (never touched) is shown as "No throttling" / rate 1, same as a
// brand-new tab's real, unthrottled state.
export async function loadConditions() {
  if (!getActiveId()) return;
  const networkSelect = /** @type {HTMLSelectElement} */ (document.getElementById('resNetworkSelect'));
  const cpuSelect      = /** @type {HTMLSelectElement} */ (document.getElementById('resCpuSelect'));
  const customFields   = document.getElementById('resCustomNetworkFields');
  if (!networkSelect) return; // panel not yet built
  const c = (await testerBrowser.resilience.getConditions(getActiveId())) || { network: 'none', cpuRate: 1 };

  cpuSelect.value = String(c.cpuRate);
  if (typeof c.network === 'string') {
    networkSelect.value = c.network;
    customFields.classList.add('res-hidden');
  } else {
    networkSelect.value = 'custom';
    customFields.classList.remove('res-hidden');
    /** @type {HTMLInputElement} */ (document.getElementById('resCustomLatency')).value  = c.network.custom.latency;
    /** @type {HTMLInputElement} */ (document.getElementById('resCustomDownload')).value = c.network.custom.downloadKbps;
    /** @type {HTMLInputElement} */ (document.getElementById('resCustomUpload')).value   = c.network.custom.uploadKbps;
  }
}

async function applyConditionsFromForm() {
  if (!getActiveId()) return;
  const networkSelect = /** @type {HTMLSelectElement} */ (document.getElementById('resNetworkSelect'));
  const cpuSelect      = /** @type {HTMLSelectElement} */ (document.getElementById('resCpuSelect'));
  /** @type {import('../src/main/networkConditions').NetworkSelection} */
  const network = networkSelect.value === 'custom'
    ? { custom: {
        latency:      parseInt(/** @type {HTMLInputElement} */ (document.getElementById('resCustomLatency')).value, 10) || 0,
        downloadKbps: parseInt(/** @type {HTMLInputElement} */ (document.getElementById('resCustomDownload')).value, 10) || 0,
        uploadKbps:   parseInt(/** @type {HTMLInputElement} */ (document.getElementById('resCustomUpload')).value, 10) || 0,
      } }
    : /** @type {import('../src/main/networkConditions').NetworkPresetKey} */ (networkSelect.value);
  await testerBrowser.resilience.setConditions(getActiveId(), { network, cpuRate: Number(cpuSelect.value) });
  // setConditions() only updates main-process state — nothing pushes a
  // session-list refresh to the renderer on its own (unlike title/favicon,
  // which have their own dedicated push channels), so the tab strip's
  // throttled indicator would otherwise sit stale until some unrelated
  // action happened to call refreshTabs() next.
  await refreshTabs();
}
