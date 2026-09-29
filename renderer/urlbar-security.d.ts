export function updateUrlbarSecurity(url: string): void;
export function initUrlbarSecurity(): void;

export interface CertExpiryState {
  state: 'ok' | 'soon' | 'expired';
  days: number;
}
export function certExpiryState(validToSec: number, nowMs: number): CertExpiryState;
