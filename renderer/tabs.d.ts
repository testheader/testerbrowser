export function pushMru(stack: string[], id: string): string[];
export function nextMruId(stack: string[], reverse: boolean): string | null;
export function getActiveId(): string | null;
export function recordVisit(id: string): void;
export function cycleTab(reverse: boolean): void;
