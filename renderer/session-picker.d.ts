export interface PickerSession {
  id: string;
  name: string;
  url?: string;
  partition?: string;
}

export function pickerLabel(session: PickerSession, allSessions: PickerSession[]): string;

export function buildSessionOptions(
  select: HTMLSelectElement,
  sessions: PickerSession[],
  opts?: {
    excludeId?: string;
    extraFirstOption?: { value: string; label: string };
    allSessions?: PickerSession[];
  }
): void;

export function populateSessionPickers(pickAId: string, pickBId: string): Promise<PickerSession[]>;
