// Pure helper behind the second-instance handler in index.ts — kept apart so
// it's testable without booting Electron. `argv` is whatever the OS/second
// launch passed on the command line (electron-builder's installed exe path
// or `electron .` in dev, plus any flags Electron/Chromium itself prepends),
// so this has to pick the first thing that's actually a navigable http(s)
// URL and ignore everything else (flags, the exe path, file:/javascript: URIs).
export function firstHttpUrl(argv: string[]): string | null {
  for (const arg of argv) {
    if (/^https?:\/\//i.test(arg)) return arg;
  }
  return null;
}
