import path from 'path';

// Pure guards for renderer-supplied values that end up in filesystem paths
// (baseline ids, session ids → recorder SQLite filenames, bug-report
// screenshot paths). Defence in depth: the renderer is CSP-locked, but a
// value from IPC is still never trusted to stay inside its directory.

// Letters, digits, '_' and '-' only — no '.', '/', '\\' or ':' — so the id
// can never climb out of (or name something other than a file in) the
// directory it's joined onto. 128 covers generated baseline ids (a slug of
// up to 60 chars plus a timestamp/random suffix).
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && SAFE_ID_RE.test(id);
}

// True only when `candidate` resolves to a path strictly inside `parentDir`
// (not the directory itself, not a sibling that merely shares its prefix,
// not anything reached via '..').
export function isPathInside(candidate: unknown, parentDir: string): candidate is string {
  if (typeof candidate !== 'string' || !candidate) return false;
  const rel = path.relative(path.resolve(parentDir), path.resolve(candidate));
  return !!rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
