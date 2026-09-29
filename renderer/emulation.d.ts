export function initSpoof(): void;
export function refreshSpoofStatus(): Promise<void>;

export interface DevicePreset {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
}

export const DEVICE_PRESETS: Record<string, DevicePreset>;
