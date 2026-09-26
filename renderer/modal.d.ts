export function initModal(
  overlayId: string,
  close: () => unknown,
  opts?: { confirmClose?: () => boolean | Promise<boolean>; backdrop?: boolean }
): void;
export function requestClose(overlayId: string): Promise<void>;
export function openModal(overlayId: string, onOpen?: () => void): Promise<void>;
export function closeModal(overlayId: string): Promise<void>;
