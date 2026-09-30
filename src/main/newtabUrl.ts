import path from 'path';
import { fileURLToPath } from 'url';

// Resolved at runtime — points to renderer/newtab.html whether packaged or in dev
export const NEWTAB_FILE = path.join(__dirname, '..', '..', 'renderer', 'newtab.html');

// L1: true only for a file: URL that resolves to exactly the bundled new-tab
// page. The previous check (startsWith('file://') && includes('newtab.html'))
// also matched any other local file named newtab.html (e.g. in Downloads), a
// UNC path, or a URL with "?newtab.html" appended. Query/hash are ignored by
// fileURLToPath, so the real page with a fragment still matches.
export function isNewtabFileUrl(url: string, newtabFile: string = NEWTAB_FILE): boolean {
  if (typeof url !== 'string' || !url.toLowerCase().startsWith('file:')) return false;
  let filePath: string;
  try { filePath = fileURLToPath(url); } catch { return false; }
  const a = path.resolve(filePath);
  const b = path.resolve(newtabFile);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// L1: the privileged newtab IPC channels also require the call to come from
// a top-level frame — an iframe can never be the new-tab page itself.
export function isTrustedNewtabFrame(frame: { url: string; parent: unknown } | null | undefined, newtabFile: string = NEWTAB_FILE): boolean {
  if (!frame || frame.parent) return false;
  return isNewtabFileUrl(frame.url, newtabFile);
}
