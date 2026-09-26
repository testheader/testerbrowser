export interface ShortcutEntry {
  action: string;
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  direct?: boolean;
}

export const SHORTCUTS: ShortcutEntry[];

export function matchShortcut(input: { ctrl?: boolean; shift?: boolean; alt?: boolean; key: string }): ShortcutEntry | undefined;
