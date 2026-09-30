import type { AppLog } from './appLogger';
import { DeviceMetrics, ColorScheme, ReducedMotion, buildMediaFeatures } from './deviceEmulation';

/**
 * Owns per-tab emulation overrides (#255, extracted from sessionManager.ts
 * once #241/#271 had landed and set the field's final shape). Unlike Mock/
 * Resilience, the CDP dispatch itself (setEmulation) moves here too — per
 * the ticket, this class owns "setEmulation/getEmulation and the
 * per-partition storage", not just storage — since a tab's own debugger is
 * needed to actually apply a spoof, `getSession` resolves a tab id to just
 * enough of its TestSession (partition, webContents, defaultUserAgent) for
 * that, narrower than exposing SessionManager's whole session map.
 */

export interface EmulationOverrides {
  timezone?: string;
  locale?: string;
  latitude?: number;
  longitude?: number;
  timeOffsetMs?: number;
  userAgent?: string;
  // #271: device/viewport, touch and media-query emulation.
  deviceMetrics?: DeviceMetrics;
  touch?: boolean;
  colorScheme?: ColorScheme;
  reducedMotion?: ReducedMotion;
}

// #241: a patch, not the applied state — undefined (the key absent) means
// "leave this field's current override alone" (used when re-applying a
// partition's existing overrides to a fresh same-partition tab, and when
// restoring from disk), null explicitly clears just that one field, and a
// real value sets it. `clear: true` is sugar for "clear every field."
// Latitude/longitude are one combined field in practice — CDP has no way to
// override just one coordinate — so either being null/absent while the
// other is a real number clears geolocation entirely; both present as
// numbers sets it.
export interface EmulationPatch {
  timezone?: string | null;
  locale?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  accuracy?: number;
  timeOffsetMs?: number | null;
  userAgent?: string | null;
  // #271: same null=clear/undefined=unchanged rules as the fields above.
  deviceMetrics?: DeviceMetrics | null;
  touch?: boolean | null;
  colorScheme?: ColorScheme | null;
  reducedMotion?: ReducedMotion | null;
  clear?: boolean;
}

// e.g. 'fr-FR' -> 'fr-FR,fr' — CDP's acceptLanguage takes a plain
// comma-separated preference list with no quality values; Chromium derives
// the real Accept-Language header's descending ";q=" weights from position
// itself. Adding our own here double-appends one (observed empirically:
// "fr-FR,fr;q=0.9;q=0.9" over the wire) rather than being an inert no-op.
function acceptLanguageForLocale(locale: string): string {
  const base = locale.split('-')[0];
  return base && base !== locale ? `${locale},${base}` : locale;
}

function emulationErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Overrides window.Date/Date.now() on every new document with a fixed
// offset from real wall-clock time, so the spoofed clock keeps advancing
// at normal speed instead of freezing at one instant.
function buildDateOverrideScript(offsetMs: number): string {
  return `(() => {
    if (window.__tbDateOverridden) return;
    window.__tbDateOverridden = true;
    const __tbOffset = ${offsetMs};
    const RealDate = Date;
    function TBDate(...args) {
      if (!new.target) return new RealDate(RealDate.now() + __tbOffset).toString();
      if (args.length === 0) return new RealDate(RealDate.now() + __tbOffset);
      return new RealDate(...args);
    }
    TBDate.prototype = RealDate.prototype;
    TBDate.now = () => RealDate.now() + __tbOffset;
    TBDate.parse = RealDate.parse;
    TBDate.UTC = RealDate.UTC;
    Object.defineProperty(window, 'Date', { value: TBDate, writable: true, configurable: true });
  })();`;
}

// Chromium's CDP Emulation.setUserAgentOverride only touches navigator.userAgent
// (and the request header, alongside webContents.setUserAgent()) — it leaves
// navigator.userAgentData / Sec-CH-UA-* Client Hints reporting the *real*
// browser unless userAgentMetadata is supplied too, which would silently
// contradict the spoofed UA on any site that reads them. Derive a plausible
// metadata object from the UA string itself rather than requiring a second
// field the tester would have to keep in sync by hand.
function buildUserAgentMetadata(ua: string): {
  brands: { brand: string; version: string }[];
  platform: string;
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
} {
  const mobile = /Mobi|Android|iPhone|iPad/i.test(ua);
  const platform =
    /iPhone|iPad|iPod/i.test(ua) ? 'iOS' :
    /Android/i.test(ua) ? 'Android' :
    /Windows/i.test(ua) ? 'Windows' :
    /Mac OS X/i.test(ua) ? 'macOS' :
    /Linux/i.test(ua) ? 'Linux' : '';
  const chromeMatch = ua.match(/Chrome\/(\d+)/);
  const brands = chromeMatch
    ? [{ brand: 'Chromium', version: chromeMatch[1] }, { brand: 'Google Chrome', version: chromeMatch[1] }]
    : [];
  return { brands, platform, platformVersion: '', architecture: '', model: '', mobile };
}

export interface EmulationSessionRef {
  partition: string;
  webContents: Electron.WebContents;
  defaultUserAgent: string;
}

export class EmulationManager {
  private log: AppLog;
  private getSession: (id: string) => EmulationSessionRef | undefined;
  private byPartition = new Map<string, EmulationOverrides>();
  // CDP script identifier of the injected Date-override shim, keyed by
  // session id (a tab's own debugger, not shared across a partition).
  private dateOverrideScripts = new Map<string, string>();

  constructor(log: AppLog, getSession: (id: string) => EmulationSessionRef | undefined) {
    this.log = log;
    this.getSession = getSession;
  }

  private warnCdpFailure(sessionId: string, command: string, e: unknown) {
    this.log.warn('sessions', `CDP command '${command}' failed`, { sessionId, error: String(e) });
  }

  // Raw read with no lazy-creation side effect — for createSession()'s
  // "re-apply existing overrides to a new same-partition tab" check and
  // saveSessions()'s persistence dump.
  getByPartition(partition: string): EmulationOverrides | undefined {
    return this.byPartition.get(partition);
  }

  getEmulation(id: string): EmulationOverrides | null {
    const s = this.getSession(id);
    if (!s) return null;
    return this.byPartition.get(s.partition) ?? null;
  }

  // #236-style cleanup: called from destroySession() — a closed tab's own
  // injected date-override script identifier is meaningless once its
  // debugger is gone.
  cleanupSession(id: string): void {
    this.dateOverrideScripts.delete(id);
  }

  // #241: returns a per-field error map (empty when everything requested
  // actually succeeded) — a field only lands in the partition's recorded
  // state (and getEmulation()'s result) if its own CDP command resolved;
  // a rejected command leaves that one field exactly as it was before this
  // call, so the panel can never claim an override that never took effect.
  async setEmulation(id: string, opts: EmulationPatch): Promise<Record<string, string>> {
    const s = this.getSession(id);
    if (!s) return {};
    const clearingEverything = !!opts.clear;
    if (clearingEverything) {
      opts = {
        timezone: null, locale: null, latitude: null, longitude: null, timeOffsetMs: null, userAgent: null,
        deviceMetrics: null, touch: null, colorScheme: null, reducedMotion: null,
      };
    }
    const dbg = s.webContents.debugger;
    const partition = s.partition;
    const applied: EmulationOverrides = { ...(this.byPartition.get(partition) ?? {}) };
    const errors: Record<string, string> = {};

    if (opts.timezone !== undefined) {
      const ok = await dbg.sendCommand('Emulation.setTimezoneOverride', { timezoneId: opts.timezone ?? '' })
        .then(() => true)
        .catch((e) => { this.warnCdpFailure(id, 'Emulation.setTimezoneOverride', e); errors.timezone = emulationErrorMessage(e); return false; });
      if (ok) { if (opts.timezone === null) delete applied.timezone; else applied.timezone = opts.timezone; }
    }

    if (opts.latitude !== undefined || opts.longitude !== undefined) {
      const bothSet = typeof opts.latitude === 'number' && typeof opts.longitude === 'number';
      if (bothSet) {
        const latitude = opts.latitude as number;
        const longitude = opts.longitude as number;
        const ok = await dbg.sendCommand('Emulation.setGeolocationOverride', { latitude, longitude, accuracy: opts.accuracy ?? 10 })
          .then(() => true)
          .catch((e) => { this.warnCdpFailure(id, 'Emulation.setGeolocationOverride', e); errors.latitude = emulationErrorMessage(e); return false; });
        if (ok) { applied.latitude = latitude; applied.longitude = longitude; }
      } else {
        // A lone coordinate (the other left null/absent) is meaningless —
        // clear geolocation entirely rather than half-apply it.
        const ok = await dbg.sendCommand('Emulation.clearGeolocationOverride')
          .then(() => true)
          .catch((e) => { this.warnCdpFailure(id, 'Emulation.clearGeolocationOverride', e); errors.latitude = emulationErrorMessage(e); return false; });
        if (ok) { delete applied.latitude; delete applied.longitude; }
      }
    }

    if (opts.timeOffsetMs !== undefined) {
      const existingScriptId = this.dateOverrideScripts.get(id);
      if (existingScriptId) {
        await dbg.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: existingScriptId }).catch((e) => this.warnCdpFailure(id, 'Page.removeScriptToEvaluateOnNewDocument', e));
        this.dateOverrideScripts.delete(id);
      }
      if (opts.timeOffsetMs === null) {
        delete applied.timeOffsetMs;
      } else {
        const offsetMs = opts.timeOffsetMs;
        await dbg.sendCommand('Page.enable').catch((e) => this.warnCdpFailure(id, 'Page.enable', e));
        // The CDP command occasionally fails transiently under system load
        // (observed in CI) — retry once before giving up, and only report the
        // offset as applied if the script genuinely got registered, so the UI
        // never claims an override is active when it silently isn't.
        let result: { identifier: string } | null = null;
        for (let attempt = 0; attempt < 2 && !result; attempt++) {
          result = await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
            source: buildDateOverrideScript(offsetMs),
          }).catch(() => null) as { identifier: string } | null;
        }
        if (result?.identifier) {
          this.dateOverrideScripts.set(id, result.identifier);
          applied.timeOffsetMs = offsetMs;
        } else {
          this.log.error('sessions', 'Failed to apply clock offset override', { sessionId: id });
          errors.timeOffsetMs = 'Failed to register the clock override script';
        }
      }
    }

    // Locale and User-Agent both ultimately funnel through the same single
    // CDP command — Accept-Language only ever travels as
    // Network.setUserAgentOverride's own acceptLanguage parameter, never a
    // separate call — so issue exactly one combined call reflecting the
    // *final* state whenever either is touched. Two separate calls (one per
    // field) would have the second silently clobber the first's
    // acceptLanguage, since each call fully replaces the prior override.
    if (opts.locale !== undefined || opts.userAgent !== undefined) {
      const nextLocale = opts.locale !== undefined ? (opts.locale === null ? undefined : opts.locale) : applied.locale;
      const nextUa = opts.userAgent !== undefined
        ? (opts.userAgent === null ? s.defaultUserAgent : opts.userAgent)
        : (applied.userAgent ?? s.defaultUserAgent);

      s.webContents.setUserAgent(nextUa);
      const params: Record<string, unknown> = { userAgent: nextUa, userAgentMetadata: buildUserAgentMetadata(nextUa) };
      if (nextLocale) params.acceptLanguage = acceptLanguageForLocale(nextLocale);
      let uaError: string | undefined;
      const uaOk = await dbg.sendCommand('Emulation.setUserAgentOverride', params)
        .then(() => true)
        .catch((e) => { this.warnCdpFailure(id, 'Emulation.setUserAgentOverride', e); uaError = emulationErrorMessage(e); return false; });

      if (opts.userAgent !== undefined) {
        if (uaOk) { if (opts.userAgent === null) delete applied.userAgent; else applied.userAgent = opts.userAgent; }
        else errors.userAgent = uaError ?? 'Failed to apply User-Agent override';
      }

      // Intl/navigator.language is a separate CDP surface from the header
      // above — apply it independently so a failure in one doesn't also
      // block the other from taking effect.
      if (opts.locale !== undefined) {
        const localeOk = await dbg.sendCommand('Emulation.setLocaleOverride', { locale: opts.locale ?? '' })
          .then(() => true)
          .catch((e) => { this.warnCdpFailure(id, 'Emulation.setLocaleOverride', e); errors.locale = emulationErrorMessage(e); return false; });
        if (localeOk) { if (opts.locale === null) delete applied.locale; else applied.locale = opts.locale; }
      }
    }

    // #271: viewport/device metrics — only re-issue the clear command when a
    // metrics override was actually previously applied, so picking "System"
    // on a tab that was never overridden doesn't send a pointless CDP call.
    if (opts.deviceMetrics !== undefined) {
      if (opts.deviceMetrics === null) {
        if (applied.deviceMetrics) {
          const ok = await dbg.sendCommand('Emulation.clearDeviceMetricsOverride')
            .then(() => true)
            .catch((e) => { this.warnCdpFailure(id, 'Emulation.clearDeviceMetricsOverride', e); errors.deviceMetrics = emulationErrorMessage(e); return false; });
          if (ok) delete applied.deviceMetrics;
        }
      } else {
        const { width, height, deviceScaleFactor, mobile } = opts.deviceMetrics;
        const ok = await dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile })
          .then(() => true)
          .catch((e) => { this.warnCdpFailure(id, 'Emulation.setDeviceMetricsOverride', e); errors.deviceMetrics = emulationErrorMessage(e); return false; });
        if (ok) applied.deviceMetrics = { width, height, deviceScaleFactor, mobile };
      }
    }

    // #271: touch is a plain enable/disable toggle, not an "override" CDP
    // needs an explicit clear command for — clearing just means re-issuing
    // the same command with enabled:false, the same as it never having been
    // turned on.
    if (opts.touch !== undefined) {
      const enabled = !!opts.touch;
      const ok = await dbg.sendCommand('Emulation.setTouchEmulationEnabled', { enabled })
        .then(() => true)
        .catch((e) => { this.warnCdpFailure(id, 'Emulation.setTouchEmulationEnabled', e); errors.touch = emulationErrorMessage(e); return false; });
      if (ok) { if (enabled) applied.touch = true; else delete applied.touch; }
    }

    // #271: prefers-color-scheme and prefers-reduced-motion both ultimately
    // funnel through the same single Emulation.setEmulatedMedia call (its
    // `features` array carries both) — same reasoning as the combined
    // locale/User-Agent call above, and CDP reports success/failure for the
    // call as a whole, not per feature, so a failure here is attributed to
    // whichever of the two fields this patch actually touched.
    if (opts.colorScheme !== undefined || opts.reducedMotion !== undefined) {
      const nextColorScheme = opts.colorScheme !== undefined
        ? (opts.colorScheme === null ? undefined : opts.colorScheme) : applied.colorScheme;
      const nextReducedMotion = opts.reducedMotion !== undefined
        ? (opts.reducedMotion === null ? undefined : opts.reducedMotion) : applied.reducedMotion;
      let mediaError: string | undefined;
      const ok = await dbg.sendCommand('Emulation.setEmulatedMedia', { features: buildMediaFeatures(nextColorScheme, nextReducedMotion) })
        .then(() => true)
        .catch((e) => { this.warnCdpFailure(id, 'Emulation.setEmulatedMedia', e); mediaError = emulationErrorMessage(e); return false; });

      if (opts.colorScheme !== undefined) {
        if (ok) { if (opts.colorScheme === null) delete applied.colorScheme; else applied.colorScheme = opts.colorScheme; }
        else errors.colorScheme = mediaError ?? 'Failed to apply media emulation';
      }
      if (opts.reducedMotion !== undefined) {
        if (ok) { if (opts.reducedMotion === null) delete applied.reducedMotion; else applied.reducedMotion = opts.reducedMotion; }
        else errors.reducedMotion = mediaError ?? 'Failed to apply media emulation';
      }
    }

    if (clearingEverything) this.byPartition.delete(partition);
    else this.byPartition.set(partition, applied);
    return errors;
  }
}
