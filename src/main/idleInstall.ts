// Pure decision behind the "install downloaded updates automatically when
// idle" setting (#259) — kept Electron-free so it's testable without booting
// Electron. index.ts gathers the real inputs (powerMonitor.getSystemIdleTime(),
// SessionManager.isBusy(), DownloadManager.list()) on a 60s interval and calls
// this; a `setInterval` itself isn't worth unit-testing, this decision is.

// #288: default and clamp bounds for the user-configurable idle threshold
// (settingsPatch.ts's idleInstallMinutes) — IDLE_INSTALL_MINUTES itself is no
// longer hardcoded into the decision below, only used as that setting's
// fallback/default value.
export const IDLE_INSTALL_MINUTES = 15;
export const IDLE_INSTALL_MINUTES_MIN = 1;
export const IDLE_INSTALL_MINUTES_MAX = 180;

export interface IdleInstallInputs {
  enabled: boolean;
  status: string;
  idleSeconds: number;
  idleMinutesThreshold: number;
  recording: boolean;
  following: boolean;
  playing: boolean;
  downloading: boolean;
}

export interface IdleInstallDecision {
  ok: boolean;
  reason?: string;
}

export function canAutoInstall(inputs: IdleInstallInputs): IdleInstallDecision {
  const { enabled, status, idleSeconds, idleMinutesThreshold, recording, following, playing, downloading } = inputs;
  if (!enabled) return { ok: false, reason: 'the setting is off' };
  if (status !== 'downloaded') return { ok: false, reason: `update status is "${status}", not "downloaded"` };
  if (idleSeconds < idleMinutesThreshold * 60) {
    return { ok: false, reason: `system idle for ${idleSeconds}s, needs ${idleMinutesThreshold * 60}s` };
  }
  if (recording) return { ok: false, reason: 'a Record/Playback recording is active' };
  if (following) return { ok: false, reason: 'a Follow Along pairing is active' };
  if (playing) return { ok: false, reason: 'a Record/Playback run is in progress' };
  if (downloading) return { ok: false, reason: 'a download is in progress' };
  return { ok: true };
}
