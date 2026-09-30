/* global testerBrowser */
import { getActiveId } from './tabs.js';
import { showStatus as showStatusMsg } from './status-msg.js';
import { wireHelpPopover } from './utils.js';

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

// #271: device/viewport presets — a small hardcoded table, similar in spirit
// to Chrome DevTools' own device list rather than a byte-for-byte match.
// Resolved to concrete width/height/deviceScaleFactor/mobile numbers here,
// in the renderer, so the main process's setEmulation() never needs to know
// preset names — it only ever sees whichever numbers this panel already
// picked.
export const DEVICE_PRESETS = {
  'iPhone 14':     { width: 390,  height: 844,  deviceScaleFactor: 3,     mobile: true },
  'iPhone SE':     { width: 375,  height: 667,  deviceScaleFactor: 2,     mobile: true },
  'Pixel 7':       { width: 412,  height: 915,  deviceScaleFactor: 2.625, mobile: true },
  'iPad':          { width: 820,  height: 1180, deviceScaleFactor: 2,     mobile: true },
  'Galaxy S21':    { width: 360,  height: 800,  deviceScaleFactor: 3,     mobile: true },
  'Desktop 1080p': { width: 1920, height: 1080, deviceScaleFactor: 1,     mobile: false },
  'Desktop 1440p': { width: 2560, height: 1440, deviceScaleFactor: 1,     mobile: false },
};

// group is the <optgroup> label; a rendered dropdown, not buttons, is what
// scales past a handful of entries (#184). "This browser"'s userAgent is
// resolved live from this window's own navigator.userAgent right before the
// dropdown is built, rather than a hardcoded string that would rot on the
// next Electron/Chromium bump.
function buildUaPresets() {
  return [
    { group: 'This browser', label: 'TesterBrowser (this app)', userAgent: navigator.userAgent },
    { group: 'Desktop', label: 'Chrome (Windows)', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
    { group: 'Desktop', label: 'Firefox (Windows)', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0' },
    { group: 'Desktop', label: 'Safari (macOS)', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15' },
    { group: 'Desktop', label: 'Edge (Windows)', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0' },
    { group: 'Mobile', label: 'iOS Safari', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1' },
    { group: 'Mobile', label: 'Android Chrome', userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36' },
    { group: 'Mobile', label: 'Android 8 (older)', userAgent: 'Mozilla/5.0 (Linux; Android 8.0.0; SM-G930F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/62.0.3202.84 Mobile Safari/537.36' },
    { group: 'Bots', label: 'Googlebot', userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
    { group: 'Bots', label: 'Bingbot', userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Safari/537.36' },
  ];
}

let initialized = false;
// Overrides actually applied to the currently displayed session, as last
// confirmed by the backend — drives both the "currently applied" summary and
// the dirty-field detection (edited-but-not-applied) below it.
let appliedForActiveSession = null;
// Built once at init (navigator.userAgent doesn't change at runtime) and
// looked up by option index when the UA dropdown changes.
let uaPresets = [];


// The panel's raw fields are grouped into three collapsible sections. `keys`
// are the EmulationOverrides fields each one owns — used for its applied-
// value badge, its dirty flag, and the partial patch its own Reset sends
// (null = clear just that key; keys left out are untouched by setEmulation).
// Device and Location & time start expanded; Advanced (rarely used media
// preferences) starts collapsed but expands on its own whenever the active
// session has one of its values applied, so an applied override is never
// hidden behind a closed section.
const SECTIONS = {
  device:   { title: 'Device',          open: true,  keys: ['deviceMetrics', 'touch', 'userAgent'] },
  location: { title: 'Location & time', open: true,  keys: ['timezone', 'locale', 'latitude', 'longitude', 'timeOffsetMs'] },
  advanced: { title: 'Advanced',        open: false, keys: ['colorScheme', 'reducedMotion'] },
};
const SECTION_NAMES = Object.keys(SECTIONS);

function sectionHtml(name, bodyHtml) {
  const { title, open } = SECTIONS[name];
  return `
    <section class="spoof-sec" id="spoofSec-${name}" aria-labelledby="spoofSecToggle-${name}">
      <div class="spoof-sec-head">
        <button type="button" class="spoof-sec-toggle" id="spoofSecToggle-${name}"
                aria-expanded="${open}" aria-controls="spoofSecBody-${name}">
          <span class="spoof-sec-chev" aria-hidden="true"></span>
          <span class="spoof-sec-title">${title.replace('&', '&amp;')}</span>
          <span class="spoof-sec-badge" id="spoofSecBadge-${name}" hidden></span>
          <span class="spoof-sec-edited" id="spoofSecEdited-${name}" hidden>edited</span>
        </button>
        <button type="button" class="spoof-sec-reset" id="spoofSecReset-${name}"
                title="Clear this section's overrides on the active tab"
                aria-label="Reset ${title.replace('&', '&amp;')}">Reset</button>
      </div>
      <div class="spoof-sec-body" id="spoofSecBody-${name}"${open ? '' : ' hidden'}>${bodyHtml}</div>
    </section>`;
}

export function initSpoof() {
  const panel = document.getElementById('spoofPanel');
  if (initialized) return;
  initialized = true;

  const deviceBody = `
    <div class="spoof-fields">
      <div class="spoof-field">
        <label class="spoof-label" for="spoofDevicePreset">Viewport</label>
        <select class="spoof-input" id="spoofDevicePreset" aria-describedby="spoofDeviceHint"></select>
        <span class="spoof-hint" id="spoofDeviceHint"></span>
      </div>
      <div class="spoof-field spoof-field-toggle">
        <label class="spoof-label" id="spoofTouchLabel" for="spoofTouch">Touch input</label>
        <label class="toggle-switch">
          <input type="checkbox" id="spoofTouch" aria-describedby="spoofTouchHint" />
          <span class="toggle-slider"></span>
        </label>
        <span class="spoof-hint" id="spoofTouchHint">Emulates a touch screen instead of a mouse.</span>
      </div>
      <div class="spoof-field spoof-field-wide" id="spoofCustomSizeRow" hidden>
        <span class="spoof-label" id="spoofCustomSizeLabel">Custom size (px) and pixel ratio</span>
        <div class="spoof-offset-row" role="group" aria-labelledby="spoofCustomSizeLabel">
          <input class="spoof-input" id="spoofCustomWidth" type="number" min="1" step="1" placeholder="width" aria-label="Custom width (px)" />
          <input class="spoof-input" id="spoofCustomHeight" type="number" min="1" step="1" placeholder="height" aria-label="Custom height (px)" />
          <input class="spoof-input" id="spoofCustomDpr" type="number" min="0.5" step="0.25" placeholder="DPR 1" aria-label="Device pixel ratio" />
        </div>
        <span class="spoof-hint">Pixel ratio defaults to 1; the Touch toggle also marks the device as mobile.</span>
      </div>
      <div class="spoof-field spoof-field-wide">
        <label class="spoof-label" for="spoofUserAgent">User-Agent</label>
        <input class="spoof-input" id="spoofUserAgent" type="text" placeholder="Empty = browser default" spellcheck="false" aria-describedby="spoofUaHint" />
        <span class="spoof-hint" id="spoofUaHint">Sent with every request and exposed as navigator.userAgent. Pick one under Presets or paste your own.</span>
      </div>
    </div>`;

  const locationBody = `
    <div class="spoof-fields">
      <div class="spoof-field">
        <label class="spoof-label" for="spoofTimezone">Timezone</label>
        <input class="spoof-input" id="spoofTimezone" type="text" placeholder="e.g. America/New_York" spellcheck="false" aria-describedby="spoofTimezoneHint" />
        <span class="spoof-hint" id="spoofTimezoneHint">IANA name; affects Date and Intl in the page.</span>
      </div>
      <div class="spoof-field">
        <label class="spoof-label" for="spoofLocale">Locale</label>
        <input class="spoof-input" id="spoofLocale" type="text" placeholder="e.g. en-US" spellcheck="false" aria-describedby="spoofLocaleHint" />
        <span class="spoof-hint" id="spoofLocaleHint">Also sets navigator.language and Accept-Language.</span>
      </div>
      <div class="spoof-field">
        <label class="spoof-label" for="spoofLat">Latitude</label>
        <input class="spoof-input" id="spoofLat" type="number" step="any" placeholder="e.g. 40.7128" aria-describedby="spoofGeoHint" />
      </div>
      <div class="spoof-field">
        <label class="spoof-label" for="spoofLon">Longitude</label>
        <input class="spoof-input" id="spoofLon" type="number" step="any" placeholder="e.g. -74.006" aria-describedby="spoofGeoHint" />
      </div>
      <span class="spoof-hint spoof-field-wide" id="spoofGeoHint">What navigator.geolocation reports; set both to override the location.</span>
      <div class="spoof-field spoof-field-wide">
        <label class="spoof-label" for="spoofOffsetValue">Clock offset</label>
        <div class="spoof-offset-row">
          <input class="spoof-input" id="spoofOffsetValue" type="number" step="any" placeholder="e.g. 7 or -1" aria-describedby="spoofOffsetHint" />
          <select class="spoof-input spoof-offset-unit" id="spoofOffsetUnit" aria-label="Clock offset unit">
            <option value="1000">seconds</option>
            <option value="60000">minutes</option>
            <option value="3600000">hours</option>
            <option value="86400000" selected>days</option>
          </select>
        </div>
        <span class="spoof-hint" id="spoofOffsetHint">Shifts Date.now() forward (+) or back (−); takes effect on the next page load.</span>
      </div>
      <div class="spoof-field-wide">
        <button type="button" class="spoof-btn spoof-btn-quiet" id="spoofUseCurrent" title="Fill the fields with this machine's real timezone, locale and location">Use this machine's values</button>
      </div>
    </div>`;

  const advancedBody = `
    <div class="spoof-fields">
      <div class="spoof-field">
        <label class="spoof-label" for="spoofColorScheme">prefers-color-scheme</label>
        <select class="spoof-input" id="spoofColorScheme" aria-describedby="spoofMediaHint">
          <option value="">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>
      <div class="spoof-field">
        <label class="spoof-label" for="spoofReducedMotion">prefers-reduced-motion</label>
        <select class="spoof-input" id="spoofReducedMotion" aria-describedby="spoofMediaHint">
          <option value="">System</option>
          <option value="no-preference">No preference</option>
          <option value="reduce">Reduce</option>
        </select>
      </div>
      <span class="spoof-hint spoof-field-wide" id="spoofMediaHint">Overrides the page's CSS media queries and matchMedia() only.</span>
    </div>`;

  panel.innerHTML = `
    <div class="spoof-wrap">
      <div class="spoof-summary">
        <div class="spoof-current" id="spoofCurrent" role="status" aria-live="polite"></div>
        <button type="button" class="spoof-btn spoof-reset" id="spoofReset" title="Clear every override on the active tab">Reset all</button>
        <button type="button" class="spoof-help-btn" id="spoofHelpBtn" aria-label="About spoofing" aria-expanded="false" aria-controls="spoofHelp">?</button>
        <div class="spoof-help" id="spoofHelp" role="note" hidden>
          <p><b>Spoofing</b> changes what web pages see about their device and environment (screen size, browser, touch, timezone, language, location, clock, colour scheme) without touching your real machine.</p>
          <p>Overrides apply <b>per tab</b>: to the active tab and any other tab sharing its session. Other sessions are unaffected. Pick presets or edit fields, then click <b>Apply to tab</b>; reload the page so it sees every change.</p>
        </div>
      </div>

      <div class="spoof-presets-block" role="group" aria-labelledby="spoofPresetsHeading">
        <h3 class="spoof-heading" id="spoofPresetsHeading">Presets</h3>
        <div class="spoof-preset-row">
          <span class="spoof-preset-row-label" id="spoofDeviceChipsLabel">Device</span>
          <div class="spoof-presets" id="spoofDeviceChips" role="group" aria-labelledby="spoofDeviceChipsLabel"></div>
        </div>
        <div class="spoof-preset-row">
          <span class="spoof-preset-row-label" id="spoofCityChipsLabel">Location</span>
          <div class="spoof-presets" id="spoofPresets" role="group" aria-labelledby="spoofCityChipsLabel"></div>
        </div>
        <div class="spoof-preset-row">
          <label class="spoof-preset-row-label" for="spoofUaPresets">Browser</label>
          <select class="spoof-input spoof-ua-select" id="spoofUaPresets"></select>
        </div>
      </div>

      ${sectionHtml('device', deviceBody)}
      ${sectionHtml('location', locationBody)}
      ${sectionHtml('advanced', advancedBody)}

      <div class="spoof-actions">
        <button type="button" class="spoof-btn spoof-apply" id="spoofApply">Apply to tab</button>
        <span class="spoof-dirty" id="spoofDirty" hidden>Unsaved changes. Click Apply to use them.</span>
        <span class="status-msg" id="spoofStatus" role="status" aria-live="polite"></span>
      </div>
    </div>`;

  // Location chips: a pressed chip means the four location fields currently
  // hold exactly that city's values; clicking a pressed chip clears them.
  const presetsEl = document.getElementById('spoofPresets');
  PRESETS.forEach((p, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'spoof-preset-btn';
    btn.dataset.city = String(i);
    btn.setAttribute('aria-pressed', 'false');
    btn.textContent = p.label;
    btn.title = `${p.timezone} · ${p.locale} · ${p.latitude}, ${p.longitude}`;
    btn.addEventListener('click', () => {
      if (btn.getAttribute('aria-pressed') === 'true') clearLocationPresetFields();
      else fillPreset(p);
    });
    presetsEl.appendChild(btn);
  });

  const deviceChipsEl = document.getElementById('spoofDeviceChips');
  const devicePresetSelect = /** @type {HTMLSelectElement} */ (document.getElementById('spoofDevicePreset'));
  for (const [name, m] of Object.entries(DEVICE_PRESETS)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'spoof-preset-btn';
    btn.dataset.device = name;
    btn.setAttribute('aria-pressed', 'false');
    btn.textContent = name;
    btn.title = describeMetrics(m);
    btn.addEventListener('click', () => {
      // Routed through the Viewport select's own change handler so the chip
      // and the dropdown can never disagree (Touch default, custom-size row).
      devicePresetSelect.value = devicePresetSelect.value === name ? '' : name;
      devicePresetSelect.dispatchEvent(new Event('change'));
      setSectionOpen('device', true);
    });
    deviceChipsEl.appendChild(btn);
  }

  uaPresets = buildUaPresets();
  const uaSelect = /** @type {HTMLSelectElement} */ (document.getElementById('spoofUaPresets'));
  uaSelect.innerHTML = '<option value="">Custom / none</option>' +
    Object.entries(
      uaPresets.reduce((groups, p, i) => {
        (groups[p.group] ??= []).push([p, i]);
        return groups;
      }, {})
    ).map(([group, entries]) => `<optgroup label="${group}">${
      entries.map(([p, i]) => `<option value="${i}">${p.label}</option>`).join('')
    }</optgroup>`).join('');
  uaSelect.addEventListener('change', () => {
    if (uaSelect.value === '') return; // "Custom / none" — leave the field as-is
    fillUaPreset(uaPresets[Number(uaSelect.value)]);
    setSectionOpen('device', true);
  });

  for (const name of SECTION_NAMES) {
    document.getElementById(`spoofSecToggle-${name}`).addEventListener('click', () => {
      setSectionOpen(name, document.getElementById(`spoofSecBody-${name}`).hidden);
    });
    document.getElementById(`spoofSecReset-${name}`).addEventListener('click', () => resetSection(name));
  }

  wireHelpPopover(document.getElementById('spoofHelpBtn'), document.getElementById('spoofHelp'), panel);

  /** @type {HTMLButtonElement} */ (document.getElementById('spoofApply')).addEventListener('click', applySpoof);
  /** @type {HTMLButtonElement} */ (document.getElementById('spoofReset')).addEventListener('click', resetSpoof);
  document.getElementById('spoofUseCurrent').addEventListener('click', useCurrentValues);
  for (const id of ['spoofTimezone', 'spoofLocale', 'spoofLat', 'spoofLon', 'spoofOffsetValue']) {
    document.getElementById(id).addEventListener('input', updateDirtyState);
  }
  // Hand-editing the UA field means it's no longer exactly whatever preset
  // was last chosen (if any) — fall the dropdown back to "Custom / none"
  // rather than leave it pointing at a preset the field no longer matches.
  /** @type {HTMLInputElement} */ (document.getElementById('spoofUserAgent')).addEventListener('input', () => {
    uaSelect.value = '';
    updateDirtyState();
  });
  /** @type {HTMLSelectElement} */ (document.getElementById('spoofOffsetUnit')).addEventListener('change', updateDirtyState);

  devicePresetSelect.innerHTML = '<option value="">System (no override)</option>' +
    `<optgroup label="Presets">${
      Object.keys(DEVICE_PRESETS).map(name => `<option value="${name}">${name}</option>`).join('')
    }</optgroup>` +
    '<option value="__custom">Custom…</option>';
  devicePresetSelect.addEventListener('change', () => {
    document.getElementById('spoofCustomSizeRow').hidden = devicePresetSelect.value !== '__custom';
    // Defaults the Touch toggle to the picked preset's own mobile flag, but
    // stays overridable afterward — this only runs on the preset dropdown's
    // own change event, never touching the checkbox on unrelated input.
    const preset = DEVICE_PRESETS[devicePresetSelect.value];
    if (preset) /** @type {HTMLInputElement} */ (document.getElementById('spoofTouch')).checked = preset.mobile;
    updateDirtyState();
  });
  for (const id of ['spoofCustomWidth', 'spoofCustomHeight', 'spoofCustomDpr']) {
    document.getElementById(id).addEventListener('input', updateDirtyState);
  }
  /** @type {HTMLInputElement} */ (document.getElementById('spoofTouch')).addEventListener('change', updateDirtyState);
  /** @type {HTMLSelectElement} */ (document.getElementById('spoofColorScheme')).addEventListener('change', updateDirtyState);
  /** @type {HTMLSelectElement} */ (document.getElementById('spoofReducedMotion')).addEventListener('change', updateDirtyState);

  // Enter in any text/number field applies, like submitting a form.
  panel.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !(e.target instanceof HTMLInputElement)) return;
    if (e.target.type !== 'text' && e.target.type !== 'number') return;
    e.preventDefault();
    applySpoof();
  });

  refreshSpoofStatus();
}

function setSectionOpen(name, open) {
  document.getElementById(`spoofSecBody-${name}`).hidden = !open;
  document.getElementById(`spoofSecToggle-${name}`).setAttribute('aria-expanded', String(open));
}

function describeMetrics({ width, height, deviceScaleFactor, mobile }) {
  return `${width}×${height} @${deviceScaleFactor}x${mobile ? ', mobile' : ''}`;
}

// Resolves the Device section's current form state to a
// { width, height, deviceScaleFactor, mobile } object, or null when
// "System (no override)" is selected or a Custom size has no valid
// width/height yet. An empty or invalid Custom pixel ratio falls back to 1
// (applySpoof() rejects an invalid one before it's ever sent).
function readDeviceMetricsFromFields() {
  const preset = /** @type {HTMLSelectElement} */ (document.getElementById('spoofDevicePreset')).value;
  if (preset === '') return null;
  if (preset !== '__custom') return DEVICE_PRESETS[preset] ?? null;
  const width = parseInt(/** @type {HTMLInputElement} */ (document.getElementById('spoofCustomWidth')).value, 10);
  const height = parseInt(/** @type {HTMLInputElement} */ (document.getElementById('spoofCustomHeight')).value, 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const dpr = parseFloat(/** @type {HTMLInputElement} */ (document.getElementById('spoofCustomDpr')).value);
  const deviceScaleFactor = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return { width, height, deviceScaleFactor, mobile: /** @type {HTMLInputElement} */ (document.getElementById('spoofTouch')).checked };
}

// Formats a signed offset in ms as the largest whole unit that evenly
// divides it (e.g. 604800000 -> "+7d"), matching the "clock +7d" style the
// panel's "currently applied" summary uses.
function formatOffsetMs(ms) {
  const sign = ms < 0 ? '-' : '+';
  const abs = Math.abs(ms);
  /** @type {[string, number][]} */
  const units = [['d', 86400000], ['h', 3600000], ['m', 60000], ['s', 1000]];
  for (const [label, unitMs] of units) {
    if (abs % unitMs === 0) return `${sign}${abs / unitMs}${label}`;
  }
  return `${sign}${abs}ms`;
}

function fillPreset(p) {
  /** @type {HTMLInputElement} */ (document.getElementById('spoofTimezone')).value = p.timezone;
  /** @type {HTMLInputElement} */ (document.getElementById('spoofLocale')).value   = p.locale;
  /** @type {HTMLInputElement} */ (document.getElementById('spoofLat')).value      = p.latitude;
  /** @type {HTMLInputElement} */ (document.getElementById('spoofLon')).value      = p.longitude;
  setSectionOpen('location', true);
  updateDirtyState();
}

function clearLocationPresetFields() {
  for (const id of ['spoofTimezone', 'spoofLocale', 'spoofLat', 'spoofLon']) {
    /** @type {HTMLInputElement} */ (document.getElementById(id)).value = '';
  }
  updateDirtyState();
}

function fillUaPreset(p) {
  /** @type {HTMLInputElement} */ (document.getElementById('spoofUserAgent')).value = p.userAgent;
  updateDirtyState();
}

// Only fills the input fields, same as fillPreset() — "Apply to tab" is
// still a separate, explicit step. Timezone/locale are synchronous and need
// no permission; geolocation can fail or hang (this window's session has no
// permission handler attached), so it's handled independently and never
// blocks the timezone/locale fill.
function useCurrentValues() {
  /** @type {HTMLInputElement} */ (document.getElementById('spoofTimezone')).value = Intl.DateTimeFormat().resolvedOptions().timeZone;
  /** @type {HTMLInputElement} */ (document.getElementById('spoofLocale')).value   = navigator.language;
  /** @type {HTMLInputElement} */ (document.getElementById('spoofOffsetValue')).value = '0';
  updateDirtyState();

  if (!navigator.geolocation) {
    showStatus('Filled timezone and locale. Geolocation is unavailable here.', true);
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      /** @type {HTMLInputElement} */ (document.getElementById('spoofLat')).value = String(pos.coords.latitude);
      /** @type {HTMLInputElement} */ (document.getElementById('spoofLon')).value = String(pos.coords.longitude);
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
// fields happened to say. `sections` limits the rewrite to those sections'
// fields — a per-section Reset must not discard unapplied edits elsewhere.
// A section that holds an applied value is expanded (never auto-collapsed).
function populateFields(a, sections = SECTION_NAMES) {
  if (sections.includes('location')) {
    /** @type {HTMLInputElement} */ (document.getElementById('spoofTimezone')).value = a?.timezone ?? '';
    /** @type {HTMLInputElement} */ (document.getElementById('spoofLocale')).value = a?.locale ?? '';
    /** @type {HTMLInputElement} */ (document.getElementById('spoofLat')).value = a?.latitude !== undefined ? String(a.latitude) : '';
    /** @type {HTMLInputElement} */ (document.getElementById('spoofLon')).value = a?.longitude !== undefined ? String(a.longitude) : '';
    const offsetValueEl = /** @type {HTMLInputElement} */ (document.getElementById('spoofOffsetValue'));
    const offsetUnitEl = /** @type {HTMLSelectElement} */ (document.getElementById('spoofOffsetUnit'));
    if (a?.timeOffsetMs !== undefined) {
      const { value, unitMs } = splitOffsetMs(a.timeOffsetMs);
      offsetValueEl.value = String(value);
      offsetUnitEl.value = String(unitMs);
    } else {
      offsetValueEl.value = '';
      offsetUnitEl.value = '86400000';
    }
  }

  if (sections.includes('device')) {
    /** @type {HTMLInputElement} */ (document.getElementById('spoofUserAgent')).value = a?.userAgent ?? '';
    const uaSelectEl = /** @type {HTMLSelectElement} */ (document.getElementById('spoofUaPresets'));
    if (uaSelectEl) uaSelectEl.value = ''; // switching sessions is never "the same preset was just picked"
    const devicePresetSelect = /** @type {HTMLSelectElement} */ (document.getElementById('spoofDevicePreset'));
    const customSizeRow = document.getElementById('spoofCustomSizeRow');
    if (a?.deviceMetrics) {
      const presetName = findDevicePresetName(a.deviceMetrics);
      if (presetName) {
        devicePresetSelect.value = presetName;
        customSizeRow.hidden = true;
      } else {
        devicePresetSelect.value = '__custom';
        customSizeRow.hidden = false;
        /** @type {HTMLInputElement} */ (document.getElementById('spoofCustomWidth')).value = a.deviceMetrics.width;
        /** @type {HTMLInputElement} */ (document.getElementById('spoofCustomHeight')).value = a.deviceMetrics.height;
        /** @type {HTMLInputElement} */ (document.getElementById('spoofCustomDpr')).value = a.deviceMetrics.deviceScaleFactor;
      }
    } else {
      devicePresetSelect.value = '';
      customSizeRow.hidden = true;
      /** @type {HTMLInputElement} */ (document.getElementById('spoofCustomWidth')).value = '';
      /** @type {HTMLInputElement} */ (document.getElementById('spoofCustomHeight')).value = '';
      /** @type {HTMLInputElement} */ (document.getElementById('spoofCustomDpr')).value = '';
    }
    /** @type {HTMLInputElement} */ (document.getElementById('spoofTouch')).checked = !!a?.touch;
  }

  if (sections.includes('advanced')) {
    /** @type {HTMLSelectElement} */ (document.getElementById('spoofColorScheme')).value = a?.colorScheme ?? '';
    /** @type {HTMLSelectElement} */ (document.getElementById('spoofReducedMotion')).value = a?.reducedMotion ?? '';
  }

  for (const name of sections) {
    if (sectionAppliedParts(name, a).length > 0) setSectionOpen(name, true);
  }
}

// Finds the preset name (if any) a resolved deviceMetrics object matches —
// used both to populate the dropdown from applied state and to build the
// "currently applied" summary, so an applied Custom size that happens to
// equal a preset's own numbers still shows under its recognizable name.
function findDevicePresetName(metrics) {
  return Object.entries(DEVICE_PRESETS).find(([, m]) =>
    m.width === metrics.width && m.height === metrics.height &&
    m.deviceScaleFactor === metrics.deviceScaleFactor && m.mobile === metrics.mobile
  )?.[0];
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

function uaLabel(ua) {
  const preset = uaPresets.find(p => p.userAgent === ua);
  if (preset) return preset.label;
  return ua.length > 40 ? `${ua.slice(0, 40)}…` : ua;
}

// Short, human-readable pieces of what's applied in one section — drives the
// section header badge (and whether the section auto-expands).
function sectionAppliedParts(name, a) {
  if (!a) return [];
  const parts = [];
  if (name === 'device') {
    if (a.deviceMetrics) parts.push(findDevicePresetName(a.deviceMetrics) ?? `${a.deviceMetrics.width}×${a.deviceMetrics.height}`);
    if (a.touch) parts.push('touch');
    if (a.userAgent !== undefined) parts.push(uaLabel(a.userAgent));
  } else if (name === 'location') {
    if (a.timezone !== undefined) parts.push(a.timezone);
    if (a.locale !== undefined) parts.push(a.locale);
    if (a.latitude !== undefined && a.longitude !== undefined) parts.push('geo set');
    if (a.timeOffsetMs !== undefined) parts.push(`clock ${formatOffsetMs(a.timeOffsetMs)}`);
  } else if (name === 'advanced') {
    if (a.colorScheme) parts.push(a.colorScheme);
    if (a.reducedMotion) parts.push('reduced motion');
  }
  return parts;
}

// The summary strip: one chip per applied override. Each chip's text reads
// "<what> <value>" (e.g. "timezone Europe/Berlin", "clock +7d"), with the
// full detail in its tooltip.
function renderCurrent() {
  const current = document.getElementById('spoofCurrent');
  if (!current) return;
  const a = appliedForActiveSession;
  const chips = [];
  if (a) {
    if (a.deviceMetrics) {
      const presetName = findDevicePresetName(a.deviceMetrics);
      const { width, height, deviceScaleFactor, mobile } = a.deviceMetrics;
      chips.push(['viewport', presetName ?? `${width}×${height} @${deviceScaleFactor}x${mobile ? ' mobile' : ''}`, describeMetrics(a.deviceMetrics)]);
    }
    if (a.touch) chips.push(['touch', '', 'Touch input emulated']);
    if (a.userAgent !== undefined) chips.push(['UA', uaLabel(a.userAgent), a.userAgent]);
    if (a.timezone !== undefined) chips.push(['timezone', a.timezone]);
    if (a.locale !== undefined) chips.push(['locale', a.locale]);
    if (a.latitude !== undefined && a.longitude !== undefined) chips.push(['geo', `${a.latitude}, ${a.longitude}`]);
    if (a.timeOffsetMs !== undefined) {
      const spoofedNow = new Date(Date.now() + a.timeOffsetMs).toLocaleString();
      chips.push(['clock', formatOffsetMs(a.timeOffsetMs), `Page clock reads ${spoofedNow}`]);
    }
    if (a.colorScheme) chips.push(['prefers-color-scheme:', a.colorScheme]);
    if (a.reducedMotion) chips.push(['prefers-reduced-motion:', a.reducedMotion]);
  }

  current.replaceChildren();
  if (chips.length === 0) {
    current.textContent = 'Nothing spoofed. No overrides applied to this tab.';
    current.classList.remove('spoof-current-active');
  } else {
    const lead = document.createElement('span');
    lead.className = 'spoof-current-lead';
    lead.textContent = 'Applied to this tab:';
    current.append(lead);
    for (const [key, value, title] of chips) {
      const chip = document.createElement('span');
      chip.className = 'spoof-chip';
      if (title) chip.title = title;
      const k = document.createElement('span');
      k.className = 'spoof-chip-key';
      k.textContent = key;
      chip.append(' ', k);
      if (value) chip.append(` ${value}`);
      current.append(chip);
    }
    current.classList.add('spoof-current-active');
  }

  for (const name of SECTION_NAMES) {
    const badge = document.getElementById(`spoofSecBadge-${name}`);
    const parts = sectionAppliedParts(name, a);
    badge.textContent = parts.join(' · ');
    badge.hidden = parts.length === 0;
  }
}

// Current form state, normalised the same way applySpoof() sends it, with
// `undefined` standing in for "no override" — compared against the applied
// overrides to find unapplied edits.
function readFormState() {
  const offsetRaw = /** @type {HTMLInputElement} */ (document.getElementById('spoofOffsetValue')).value.trim();
  const unitMs    = Number(/** @type {HTMLSelectElement} */ (document.getElementById('spoofOffsetUnit')).value);
  const offsetNum = offsetRaw !== '' ? parseFloat(offsetRaw) : NaN;
  return {
    timezone: /** @type {HTMLInputElement} */ (document.getElementById('spoofTimezone')).value.trim(),
    locale:   /** @type {HTMLInputElement} */ (document.getElementById('spoofLocale')).value.trim(),
    latRaw:   /** @type {HTMLInputElement} */ (document.getElementById('spoofLat')).value.trim(),
    lonRaw:   /** @type {HTMLInputElement} */ (document.getElementById('spoofLon')).value.trim(),
    userAgent: /** @type {HTMLInputElement} */ (document.getElementById('spoofUserAgent')).value.trim(),
    offsetMs: offsetRaw !== '' && !isNaN(offsetNum) && offsetNum !== 0 ? offsetNum * unitMs : undefined,
    deviceMetrics: readDeviceMetricsFromFields(),
    touch: /** @type {HTMLInputElement} */ (document.getElementById('spoofTouch')).checked,
    colorScheme: /** @type {HTMLSelectElement} */ (document.getElementById('spoofColorScheme')).value || undefined,
    reducedMotion: /** @type {HTMLSelectElement} */ (document.getElementById('spoofReducedMotion')).value === 'reduce' ? 'reduce' : undefined,
  };
}

function sectionDirty(name, f, a) {
  if (name === 'device') {
    return JSON.stringify(f.deviceMetrics) !== JSON.stringify(a.deviceMetrics ?? null) ||
      f.touch !== !!a.touch ||
      f.userAgent !== (a.userAgent ?? '');
  }
  if (name === 'location') {
    return f.timezone !== (a.timezone ?? '') ||
      f.locale !== (a.locale ?? '') ||
      f.latRaw !== (a.latitude !== undefined ? String(a.latitude) : '') ||
      f.lonRaw !== (a.longitude !== undefined ? String(a.longitude) : '') ||
      f.offsetMs !== a.timeOffsetMs;
  }
  return f.colorScheme !== a.colorScheme || f.reducedMotion !== a.reducedMotion;
}

function updateDirtyState() {
  const dirty = document.getElementById('spoofDirty');
  if (!dirty) return;
  const a = appliedForActiveSession ?? {};
  const f = readFormState();

  let anyChanged = false;
  for (const name of SECTION_NAMES) {
    const changed = sectionDirty(name, f, a);
    anyChanged ||= changed;
    document.getElementById(`spoofSecEdited-${name}`).hidden = !changed;
    // Reset is only meaningful when there's something applied to clear or
    // an unapplied edit to discard.
    /** @type {HTMLButtonElement} */ (document.getElementById(`spoofSecReset-${name}`)).disabled =
      !changed && sectionAppliedParts(name, appliedForActiveSession).length === 0;
  }
  dirty.hidden = !anyChanged;
  /** @type {HTMLButtonElement} */ (document.getElementById('spoofApply')).classList.toggle('spoof-apply-pending', anyChanged);

  // Preset chips mirror the fields they fill.
  const devicePreset = /** @type {HTMLSelectElement} */ (document.getElementById('spoofDevicePreset')).value;
  for (const btn of document.querySelectorAll('#spoofDeviceChips .spoof-preset-btn')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.device === devicePreset));
  }
  for (const btn of document.querySelectorAll('#spoofPresets .spoof-preset-btn')) {
    const p = PRESETS[Number(btn.dataset.city)];
    const match = f.timezone === p.timezone && f.locale === p.locale &&
      f.latRaw !== '' && f.lonRaw !== '' &&
      parseFloat(f.latRaw) === p.latitude && parseFloat(f.lonRaw) === p.longitude;
    btn.setAttribute('aria-pressed', String(match));
  }

  const hint = document.getElementById('spoofDeviceHint');
  const preset = DEVICE_PRESETS[devicePreset];
  hint.textContent = preset ? describeMetrics(preset)
    : devicePreset === '__custom' ? 'Enter a width and height below.'
    : "Changes the page's viewport, not the window size.";
}

// #241: every field's error key, mapped to the label used in the
// "Could not apply <field>: <reason>" status message.
const FIELD_ERROR_LABELS = {
  timezone: 'timezone',
  locale: 'locale',
  latitude: 'location',
  userAgent: 'User-Agent',
  timeOffsetMs: 'clock offset',
  deviceMetrics: 'device/viewport',
  touch: 'touch emulation',
  colorScheme: 'prefers-color-scheme',
  reducedMotion: 'prefers-reduced-motion',
};

function reportErrors(errors, okMsg) {
  const failedFields = Object.keys(errors ?? {});
  if (failedFields.length > 0) {
    showStatus(
      failedFields.map(f => `Could not apply ${FIELD_ERROR_LABELS[f] ?? f}: ${errors[f]}`).join('; '),
      true
    );
  } else {
    showStatus(okMsg, false);
  }
}

async function applySpoof() {
  if (!getActiveId()) { showStatus('No active session.', true); return; }
  const timezoneRaw  = /** @type {HTMLInputElement} */ (document.getElementById('spoofTimezone')).value.trim();
  const localeRaw    = /** @type {HTMLInputElement} */ (document.getElementById('spoofLocale')).value.trim();
  const latRaw    = /** @type {HTMLInputElement} */ (document.getElementById('spoofLat')).value.trim();
  const lonRaw    = /** @type {HTMLInputElement} */ (document.getElementById('spoofLon')).value.trim();
  const latitude  = latRaw !== '' ? parseFloat(latRaw)  : null;
  const longitude = lonRaw !== '' ? parseFloat(lonRaw) : null;
  const userAgentRaw = /** @type {HTMLInputElement} */ (document.getElementById('spoofUserAgent')).value.trim();
  const offsetRaw = /** @type {HTMLInputElement} */ (document.getElementById('spoofOffsetValue')).value.trim();
  const unitMs    = Number(/** @type {HTMLSelectElement} */ (document.getElementById('spoofOffsetUnit')).value);
  const offsetNum = offsetRaw !== '' ? parseFloat(offsetRaw) : NaN;
  const dprRaw    = /** @type {HTMLInputElement} */ (document.getElementById('spoofCustomDpr')).value.trim();
  const dprNum    = dprRaw !== '' ? parseFloat(dprRaw) : NaN;

  if (latRaw !== '' && isNaN(latitude))  { showStatus('Invalid latitude.',  true); return; }
  if (lonRaw !== '' && isNaN(longitude)) { showStatus('Invalid longitude.', true); return; }
  if (offsetRaw !== '' && isNaN(offsetNum)) { showStatus('Invalid clock offset.', true); return; }
  if (/** @type {HTMLSelectElement} */ (document.getElementById('spoofDevicePreset')).value === '__custom' && dprRaw !== '' && !(dprNum > 0)) {
    showStatus('Invalid pixel ratio.', true); return;
  }

  // Every Apply sends the full current form state, mapping an empty field
  // to null (explicitly clear that one override) rather than omitting the
  // key — omitting a key means "leave whatever was already applied alone,"
  // which is exactly the bug this ticket fixes: clearing a field and
  // clicking Apply now actually clears it.
  /** @type {import('../src/main/emulationManager').EmulationPatch} */
  const patch = {
    timezone: timezoneRaw !== '' ? timezoneRaw : null,
    locale: localeRaw !== '' ? localeRaw : null,
    latitude,
    longitude,
    timeOffsetMs: offsetRaw !== '' && !isNaN(offsetNum) && offsetNum !== 0 ? offsetNum * unitMs : null,
    userAgent: userAgentRaw !== '' ? userAgentRaw : null,
    deviceMetrics: readDeviceMetricsFromFields(),
    touch: /** @type {HTMLInputElement} */ (document.getElementById('spoofTouch')).checked,
    colorScheme: /** @type {import('../src/main/deviceEmulation').ColorScheme} */ (/** @type {HTMLSelectElement} */ (document.getElementById('spoofColorScheme')).value) || null,
    // "No preference" is offered as its own option for clarity (it's the
    // actual CSS media-feature value name), but setEmulation only has a
    // real override state for 'reduce' — picking "No preference" clears the
    // override the same as "System" does, rather than the panel needing a
    // third backend state neither CDP's success/failure reporting nor the
    // rest of this API distinguishes from "unset."
    reducedMotion: /** @type {HTMLSelectElement} */ (document.getElementById('spoofReducedMotion')).value === 'reduce' ? 'reduce' : null,
  };

  const btn = /** @type {HTMLButtonElement} */ (document.getElementById('spoofApply'));
  btn.disabled = true;
  try {
    const errors = await testerBrowser.emulation.set(getActiveId(), patch);
    await refreshSpoofStatus();
    reportErrors(errors, 'Overrides applied. Reload the page for full effect.');
  } catch {
    showStatus('Failed to apply overrides.', true);
  } finally {
    btn.disabled = false;
  }
}

async function resetSpoof() {
  if (!getActiveId()) { showStatus('No active session.', true); return; }
  const btn = /** @type {HTMLButtonElement} */ (document.getElementById('spoofReset'));
  btn.disabled = true;
  try {
    await testerBrowser.emulation.set(getActiveId(), { clear: true });
    await refreshSpoofStatus();
    showStatus('Overrides cleared.', false);
  } finally {
    btn.disabled = false;
  }
}

// Clears just one section's overrides (null for each of its keys; every
// other key is omitted, so setEmulation leaves it alone) and rewrites only
// that section's fields — unapplied edits in other sections survive.
async function resetSection(name) {
  const id = getActiveId();
  if (!id) { showStatus('No active session.', true); return; }
  const btn = /** @type {HTMLButtonElement} */ (document.getElementById(`spoofSecReset-${name}`));
  btn.disabled = true;
  try {
    const patch = Object.fromEntries(SECTIONS[name].keys.map(k => [k, null]));
    const errors = await testerBrowser.emulation.set(id, patch);
    appliedForActiveSession = await testerBrowser.emulation.get(id);
    populateFields(appliedForActiveSession, [name]);
    renderCurrent();
    reportErrors(errors, `${SECTIONS[name].title} overrides cleared.`);
  } catch {
    showStatus('Failed to reset overrides.', true);
  } finally {
    updateDirtyState(); // also recomputes this Reset button's disabled state
  }
}

function showStatus(msg, isError) {
  showStatusMsg('spoofStatus', msg, isError);
}
