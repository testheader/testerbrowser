// #265: per-tab network/CPU throttling — pure preset/conversion logic, kept
// Electron-free so it's unit-testable without a debugger session.

export type NetworkPresetKey = 'none' | 'fast3g' | 'slow3g' | 'offline';

export interface CustomNetwork {
  latency: number;
  downloadKbps: number;
  uploadKbps: number;
}

export type NetworkSelection = NetworkPresetKey | { custom: CustomNetwork };

export interface TabConditions {
  network: NetworkSelection;
  /** Direct CDP Emulation.setCPUThrottlingRate value — 1 means no slowdown. */
  cpuRate: number;
}

export interface CdpNetworkConditions {
  latency: number;
  downloadThroughput: number;
  uploadThroughput: number;
  offline: boolean;
}

// DevTools' own preset values (throughput in bytes/s) — see
// https://chromedevtools.github.io/devtools-protocol/tot/Network/#method-emulateNetworkConditions
// -1 for a throughput field means "don't throttle that direction."
export const NETWORK_PRESETS: Record<NetworkPresetKey, CdpNetworkConditions> = {
  none:    { latency: 0,     downloadThroughput: -1,               uploadThroughput: -1,                   offline: false },
  fast3g:  { latency: 562.5, downloadThroughput: 180 * 1024 * 0.9, uploadThroughput: 84.375 * 1024 * 0.9,  offline: false },
  slow3g:  { latency: 2000,  downloadThroughput: 50 * 1024 * 0.9,  uploadThroughput: 50 * 1024 * 0.9,      offline: false },
  offline: { latency: 0,     downloadThroughput: -1,               uploadThroughput: -1,                   offline: true },
};

export const NETWORK_LABELS: Record<NetworkPresetKey, string> = {
  none: 'No throttling',
  fast3g: 'Fast 3G',
  slow3g: 'Slow 3G',
  offline: 'Offline',
};

// Custom throughput is entered in kbps (kilobits/second, the unit ISPs
// advertise speeds in) — CDP wants bytes/second, so ÷8 for bits→bytes and
// ×1000 for the decimal "kilo".
export function toCdpNetworkConditions(network: NetworkSelection): CdpNetworkConditions {
  if (typeof network === 'string') return NETWORK_PRESETS[network];
  const { latency, downloadKbps, uploadKbps } = network.custom;
  return {
    latency: Math.max(0, latency),
    downloadThroughput: Math.max(0, downloadKbps) * 1000 / 8,
    uploadThroughput: Math.max(0, uploadKbps) * 1000 / 8,
    offline: false,
  };
}

function networkLabel(network: NetworkSelection): string {
  return typeof network === 'string' ? NETWORK_LABELS[network] : 'Custom';
}

// The tab-strip indicator's title — null once both network and CPU are back
// to "no throttling," which clears the indicator entirely.
export function describeConditions(c: TabConditions | undefined | null): string | null {
  if (!c) return null;
  const parts: string[] = [];
  const label = networkLabel(c.network);
  if (label !== 'No throttling') parts.push(label);
  if (c.cpuRate && c.cpuRate !== 1) parts.push(`CPU ${c.cpuRate}×`);
  return parts.length ? `Throttled: ${parts.join(' · ')}` : null;
}
