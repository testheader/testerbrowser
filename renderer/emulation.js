/* global testerBrowser */
import { state } from './state.js';

const PRESETS = [
  { label: 'New York',    timezone: 'America/New_York',      locale: 'en-US', latitude:  40.7128, longitude:  -74.0060 },
  { label: 'Los Angeles', timezone: 'America/Los_Angeles',   locale: 'en-US', latitude:  34.0522, longitude: -118.2437 },
  { label: 'London',      timezone: 'Europe/London',         locale: 'en-GB', latitude:  51.5074, longitude:   -0.1278 },
  { label: 'Paris',       timezone: 'Europe/Paris',          locale: 'fr-FR', latitude:  48.8566, longitude:    2.3522 },
  { label: 'Berlin',      timezone: 'Europe/Berlin',         locale: 'de-DE', latitude:  52.5200, longitude:   13.4050 },
  { label: 'Tokyo',       timezone: 'Asia/Tokyo',            locale: 'ja-JP', latitude:  35.6762, longitude:  139.6503 },
  { label: 'Shanghai',    timezone: 'Asia/Shanghai',         locale: 'zh-CN', latitude:  31.2304, longitude:  121.4737 },
  { label: 'Mumbai',      timezone: 'Asia/Kolkata',          locale: 'en-IN', latitude:  19.0760, longitude:   72.8777 },
  { label: 'Dubai',       timezone: 'Asia/Dubai',            locale: 'ar-AE', latitude:  25.2048, longitude:   55.2708 },
  { label: 'Sydney',      timezone: 'Australia/Sydney',      locale: 'en-AU', latitude: -33.8688, longitude:  151.2093 },
  { label: 'São Paulo',   timezone: 'America/Sao_Paulo',     locale: 'pt-BR', latitude: -23.5505, longitude:  -46.6333 },
  { label: 'Toronto',     timezone: 'America/Toronto',       locale: 'en-CA', latitude:  43.6532, longitude:  -79.3832 },
];

let initialized = false;

export function initSpoof() {
  const panel = document.getElementById('spoofPanel');
  if (initialized) return;
  initialized = true;

  panel.innerHTML = `
    <div class="spoof-wrap">
      <div class="spoof-section">
        <label class="spoof-label">Quick preset</label>
        <div class="spoof-presets" id="spoofPresets"></div>
      </div>
      <div class="spoof-section spoof-fields">
        <div class="spoof-field">
          <label class="spoof-label">Timezone</label>
          <input class="spoof-input" id="spoofTimezone" type="text" placeholder="e.g. America/New_York" spellcheck="false" />
        </div>
        <div class="spoof-field">
          <label class="spoof-label">Locale</label>
          <input class="spoof-input" id="spoofLocale" type="text" placeholder="e.g. en-US" spellcheck="false" />
        </div>
        <div class="spoof-field">
          <label class="spoof-label">Latitude</label>
          <input class="spoof-input" id="spoofLat" type="number" step="any" placeholder="e.g. 40.7128" />
        </div>
        <div class="spoof-field">
          <label class="spoof-label">Longitude</label>
          <input class="spoof-input" id="spoofLon" type="number" step="any" placeholder="e.g. -74.006" />
        </div>
      </div>
      <div class="spoof-actions">
        <button class="spoof-btn spoof-apply" id="spoofApply">Apply to session</button>
        <button class="spoof-btn spoof-reset" id="spoofReset">Reset overrides</button>
        <span class="spoof-status" id="spoofStatus"></span>
      </div>
    </div>`;

  const presetsEl = document.getElementById('spoofPresets');
  for (const p of PRESETS) {
    const btn = document.createElement('button');
    btn.className = 'spoof-preset-btn';
    btn.textContent = p.label;
    btn.addEventListener('click', () => fillPreset(p));
    presetsEl.appendChild(btn);
  }

  document.getElementById('spoofApply').addEventListener('click', applySpoof);
  document.getElementById('spoofReset').addEventListener('click', resetSpoof);
}

function fillPreset(p) {
  document.getElementById('spoofTimezone').value = p.timezone;
  document.getElementById('spoofLocale').value   = p.locale;
  document.getElementById('spoofLat').value      = p.latitude;
  document.getElementById('spoofLon').value      = p.longitude;
}

async function applySpoof() {
  if (!state.activeId) { showStatus('No active session.', true); return; }
  const timezone  = document.getElementById('spoofTimezone').value.trim() || undefined;
  const locale    = document.getElementById('spoofLocale').value.trim()   || undefined;
  const latRaw    = document.getElementById('spoofLat').value.trim();
  const lonRaw    = document.getElementById('spoofLon').value.trim();
  const latitude  = latRaw !== '' ? parseFloat(latRaw)  : undefined;
  const longitude = lonRaw !== '' ? parseFloat(lonRaw) : undefined;

  if (latitude !== undefined && isNaN(latitude))  { showStatus('Invalid latitude.',  true); return; }
  if (longitude !== undefined && isNaN(longitude)) { showStatus('Invalid longitude.', true); return; }

  const btn = document.getElementById('spoofApply');
  btn.disabled = true;
  try {
    await testerBrowser.emulation.set(state.activeId, { timezone, locale, latitude, longitude });
    showStatus('Overrides applied. Reload the page for full effect.', false);
  } catch {
    showStatus('Failed to apply overrides.', true);
  } finally {
    btn.disabled = false;
  }
}

async function resetSpoof() {
  if (!state.activeId) { showStatus('No active session.', true); return; }
  const btn = document.getElementById('spoofReset');
  btn.disabled = true;
  try {
    await testerBrowser.emulation.set(state.activeId, { clear: true });
    showStatus('Overrides cleared.', false);
  } finally {
    btn.disabled = false;
  }
}

function showStatus(msg, isError) {
  const el = document.getElementById('spoofStatus');
  el.textContent = msg;
  el.style.color = isError ? 'var(--err-color, #e05)' : 'var(--ok-color, #4c4)';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.textContent = ''; }, 4000);
}
