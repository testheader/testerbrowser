export function pollWhileVisible(
  fn: () => unknown,
  intervalMs: number,
  isVisible: () => boolean
): { stop: () => void };
