/* global testerBrowser */
import { getActiveId } from './tabs.js';

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
// Overrides actually applied to the currently displayed session, as last
// confirmed by the backend — drives both the "currently applied" summary and
// the dirty-field detection (edited-but-not-applied) below it.
let appliedForActiveSession = null;

export function initSpoof() {
  const panel = document.getElementById('spoofPanel');
  if (initialized) return;
  initialized = true;

  panel.innerHTML = `
    <div class="spoof-wrap">
      <div class="spoof-current" id="spoofCurrent"></div>
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
        <div class="spoof-field spoof-field-offset">
          <label class="spoof-label">Clock offset</label>
          <div class="spoof-offset-row">
            <input class="spoof-input" id="spoofOffsetValue" type="number" step="any" placeholder="e.g. 7 or -1" />
            <select class="spoof-input spoof-offset-unit" id="spoofOffsetUnit">
              <option value="1000">seconds</option>
              <option value="60000">minutes</option>
              <option value="3600000">hours</option>
              <option value="86400000" selected>days</option>
            </select>
          </div>
        </div>
      </div>
      <div class="spoof-actions">
        <button class="spoof-btn spoof-apply" id="spoofApply">Apply to session</button>
        <button class="spoof-btn spoof-reset" id="spoofReset">Reset overrides</button>
        <button class="spoof-btn spoof-current-btn" id="spoofUseCurrent" title="Fill the fields with this machine's real timezone, locale and location">Use current values</button>
        <span class="spoof-dirty" id="spoofDirty" hidden>Unapplied changes</span>
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
  document.getElementById('spoofUseCurrent').addEventListener('click', useCurrentValues);
  for (const id of ['spoofTimezone', 'spoofLocale', 'spoofLat', 'spoofLon', 'spoofOffsetValue']) {
    document.getElementById(id).addEventListener('input', updateDirtyState);
  }
  document.getElementById('spoofOffsetUnit').addEventListener('change', updateDirtyState);

  refreshSpoofStatus();
}

// Formats a signed offset in ms as the largest whole unit that evenly
// divides it (e.g. 604800000 -> "+7d"), matching the "clock +7d" style the
// panel's "currently applied" summary uses.
function formatOffsetMs(ms) {
  const sign = ms < 0 ? '-' : '+';
  const abs = Math.abs(ms);
  const units = [['d', 86400000], ['h', 3600000], ['m', 60000], ['s', 1000]];
  for (const [label, unitMs] of units) {
    if (abs % unitMs === 0) return `${sign}${abs / unitMs}${label}`;
  }
  return `${sign}${abs}ms`;
}

function fillPreset(p) {
  document.getElementById('spoofTimezone').value = p.timezone;
  document.getElementById('spoofLocale').value   = p.locale;
  document.getElementById('spoofLat').value      = p.latitude;
  document.getElementById('spoofLon').value      = p.longitude;
  updateDirtyState();
}

// Only fills the input fields, same as fillPreset() — "Apply to session" is
// still a separate, explicit step. Timezone/locale are synchronous and need
// no permission; geolocation can fail or hang (this window's session has no
// permission handler attached), so it's handled independently and never
// blocks the timezone/locale fill.
function useCurrentValues() {
  document.getElementById('spoofTimezone').value = Intl.DateTimeFormat().resolvedOptions().timeZone;
  document.getElementById('spoofLocale').value   = navigator.language;
  document.getElementById('spoofOffsetValue').value = '0';
  updateDirtyState();

  if (!navigator.geolocation) {
    showStatus('Filled timezone and locale. Geolocation is unavailable here.', true);
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      document.getElementById('spoofLat').value = pos.coords.latitude;
      document.getElementById('spoofLon').value = pos.coords.longitude;
      updateDirtyState();
      showStatus('Filled timezone, locale and location from this machine.', false);
    },
    () => {
      showStatus('Filled timezone and locale. Location was unavailable.', true);
    },
    { timeout: 8000 }
  );
}

// Re-fetches what's actually applied to the active session's page (not just
// what the fields show) and refreshes the "currently applied" summary. Call
// this whenever the active session changes or the spoof tab is (re)shown, so
// the panel never silently shows a stale session's overrides as if they were
// the active one.
export async function refreshSpoofStatus() {
  const current = document.getElementById('spoofCurrent');
  if (!current) return; // panel not yet initialised

  const id = getActiveId();
  appliedForActiveSession = id ? await testerBrowser.emulation.get(id) : null;
  populateFields(appliedForActiveSession);
  renderCurrent();
  updateDirtyState();
}

// Writes the active session's applied overrides into the input fields (or
// clears them when it has none), so switching tabs shows *that* session's
// values instead of leaving behind whatever the previously active session's
// fields happened to say.
function populateFields(a) {
  document.getElementById('spoofTimezone').value = a?.timezone ?? '';
  document.getElementById('spoofLocale').value = a?.locale ?? '';
  document.getElementById('spoofLat').value = a?.latitude !== undefined ? String(a.latitude) : '';
  document.getElementById('spoofLon').value = a?.longitude !== undefined ? String(a.longitude) : '';
  const offsetValueEl = document.getElementById('spoofOffsetValue');
  const offsetUnitEl = document.getElementById('spoofOffsetUnit');
  if (a?.timeOffsetMs !== undefined) {
    const { value, unitMs } = splitOffsetMs(a.timeOffsetMs);
    offsetValueEl.value = String(value);
    offsetUnitEl.value = String(unitMs);
  } else {
    offsetValueEl.value = '';
    offsetUnitEl.value = '86400000';
  }
}

// Inverse of "value * unitMs" in applySpoof(): picks the largest whole unit
// that evenly divides the offset (matching formatOffsetMs's style), falling
// back to a fractional number of seconds for an offset with no clean unit.
function splitOffsetMs(ms) {
  for (const unitMs of [86400000, 3600000, 60000, 1000]) {
    if (ms % unitMs === 0) return { value: ms / unitMs, unitMs };
  }
  return { value: ms / 1000, unitMs: 1000 };
}

function renderCurrent() {
  const current = document.getElementById('spoofCurrent');
  if (!current) return;
  const a = appliedForActiveSession;
  if (!a || (a.timezone === undefined && a.locale === undefined && a.latitude === undefined && a.timeOffsetMs === undefined)) {
    current.textContent = 'No overrides applied to this session.';
    current.classList.remove('spoof-current-active');
    return;
  }
  const parts = [];
  if (a.timezone !== undefined) parts.push(`timezone ${a.timezone}`);
  if (a.locale !== undefined) parts.push(`locale ${a.locale}`);
  if (a.latitude !== undefined && a.longitude !== undefined) parts.push(`location ${a.latitude}, ${a.longitude}`);
  if (a.timeOffsetMs !== undefined) {
    const spoofedNow = new Date(Date.now() + a.timeOffsetMs).toLocaleString();
    parts.push(`clock ${formatOffsetMs(a.timeOffsetMs)} (${spoofedNow})`);
  }
  current.textContent = `Applied to this session: ${parts.join(' · ')}`;
  current.classList.add('spoof-current-active');
}

function updateDirtyState() {
  const dirty = document.getElementById('spoofDirty');
  if (!dirty) return;
  const a = appliedForActiveSession ?? {};
  const timezone = document.getElementById('spoofTimezone').value.trim();
  const locale   = document.getElementById('spoofLocale').value.trim();
  const latRaw   = document.getElementById('spoofLat').value.trim();
  const lonRaw   = document.getElementById('spoofLon').value.trim();
  const offsetRaw = document.getElementById('spoofOffsetValue').value.trim();
  const unitMs   = Number(document.getElementById('spoofOffsetUnit').value);
  const offsetNum = offsetRaw !== '' ? parseFloat(offsetRaw) : NaN;
  const offsetMs = offsetRaw !== '' && !isNaN(offsetNum) && offsetNum !== 0 ? offsetNum * unitMs : undefined;

  const changed =
    timezone !== (a.timezone ?? '') ||
    locale !== (a.locale ?? '') ||
    latRaw !== (a.latitude !== undefined ? String(a.latitude) : '') ||
    lonRaw !== (a.longitude !== undefined ? String(a.longitude) : '') ||
    offsetMs !== a.timeOffsetMs;

  dirty.hidden = !changed;
}

async function applySpoof() {
  if (!getActiveId()) { showStatus('No active session.', true); return; }
  const timezone  = document.getElementById('spoofTimezone').value.trim() || undefined;
  const locale    = document.getElementById('spoofLocale').value.trim()   || undefined;
  const latRaw    = document.getElementById('spoofLat').value.trim();
  const lonRaw    = document.getElementById('spoofLon').value.trim();
  const latitude  = latRaw !== '' ? parseFloat(latRaw)  : undefined;
  const longitude = lonRaw !== '' ? parseFloat(lonRaw) : undefined;
  const offsetRaw = document.getElementById('spoofOffsetValue').value.trim();
  const unitMs    = Number(document.getElementById('spoofOffsetUnit').value);
  const offsetNum = offsetRaw !== '' ? parseFloat(offsetRaw) : NaN;
  const timeOffsetMs = offsetRaw !== '' && !isNaN(offsetNum) && offsetNum !== 0 ? offsetNum * unitMs : undefined;

  if (latitude !== undefined && isNaN(latitude))  { showStatus('Invalid latitude.',  true); return; }
  if (longitude !== undefined && isNaN(longitude)) { showStatus('Invalid longitude.', true); return; }
  if (offsetRaw !== '' && isNaN(offsetNum)) { showStatus('Invalid clock offset.', true); return; }

  const btn = document.getElementById('spoofApply');
  btn.disabled = true;
  try {
    await testerBrowser.emulation.set(getActiveId(), { timezone, locale, latitude, longitude, timeOffsetMs });
    await refreshSpoofStatus();
    showStatus('Overrides applied. Reload the page for full effect.', false);
  } catch {
    showStatus('Failed to apply overrides.', true);
  } finally {
    btn.disabled = false;
  }
}

async function resetSpoof() {
  if (!getActiveId()) { showStatus('No active session.', true); return; }
  const btn = document.getElementById('spoofReset');
  btn.disabled = true;
  try {
    await testerBrowser.emulation.set(getActiveId(), { clear: true });
    await refreshSpoofStatus();
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
