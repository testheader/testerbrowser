# TesterBrowser

A desktop browser purpose-built for software testers: isolated, side-by-side
sessions with **always-on** network + console recording, built on real
Chromium via Electron (not a Chromium fork — see "Why Electron, not a fork"
below).

## Status: MVP scaffold

This is a working starting point, not a finished product. It currently
implements the two top-priority features:

1. **Isolated multi-session browsing** — each session is its own Electron
   `session` partition (own cookies/localStorage/cache), shown as a tab, with
   a "clone session" API to copy cookies from one session into a new one.
2. **Always-on recording** — as soon as a session is created, its CDP
   `Network`, `Log`, and `Runtime.consoleAPICalls` events are captured to a
   local SQLite DB, independent of whether any UI panel is open. The bottom
   panel is a live, merged, timestamp-correlated view of network + console
   for the active session. HAR export is included (minimal format — extend
   as needed).

Not yet implemented (see original feature list): visual regression diffing,
accessibility tree panel, request/response mocking UI, test-data generators,
environment diffing. The recording/session core was built first deliberately,
since it's the part that's expensive to retrofit later.

## Architecture

```
src/main/index.ts          Electron main process entry, IPC handlers
src/main/sessionManager.ts Creates/switches/clones isolated BrowserViews
src/main/recorder.ts       Attaches CDP debugger, logs to SQLite ring buffer
src/preload/index.ts       contextBridge API exposed to renderer
renderer/                  Session tabs + live timeline panel (plain HTML/JS)
```

Each session = one `BrowserView` + one `session` partition + one
`SessionRecorder` (its own SQLite file under Electron's userData directory).
Persistent sessions use a `persist:` partition prefix; throwaway sessions use
an in-memory partition.

## Why Electron, not a Chromium fork

A real Chromium fork means tracking upstream security patches indefinitely,
your own build farm, and 6–12 months to a usable v1 — a cost that mainly
comparable projects (Brave, Arc) pay through multi-year funded teams.
Electron embeds real Chromium (so pages render identically) while giving
full control of the surrounding UI and full access to the Chrome DevTools
Protocol (Network, DOM, Accessibility, Performance, Console, Emulation) —
which covers essentially everything on the feature list without owning
Chromium's maintenance burden.

## Development

```bash
npm install
npm run dev        # builds + launches Electron
```

## Building the installer

Windows builds require a Windows toolchain (or Wine); the reliable path is
CI, not this sandbox/dev machine:

```bash
npm run dist:win    # on a Windows machine
npm run dist:linux  # AppImage, any platform
npm run dist:mac    # on macOS
```

### CI (GitHub Actions)

`.github/workflows/build.yml` builds the Windows `.exe` (NSIS installer) on
a `windows-latest` runner and the Linux AppImage on `ubuntu-latest`, on every
push to `main`, every tag, and via manual dispatch.

**Getting the latest build for testing:** every push to `main` also
republishes a rolling pre-release tagged `latest` with the fresh `.exe` and
`.AppImage` attached — so there's one stable URL:

```
https://github.com/<you>/<repo>/releases/tag/latest
```

Bookmark that. It always has the most recent build, no need to dig through
the Actions tab or worry about artifact expiry. Tagged releases (`v1.0.0`
etc.) still work normally alongside it for actual versioned releases.

## Roadmap (suggested order)

1. Visual regression panel (`Page.captureScreenshot` + `pixelmatch` diffing
   against stored baselines)
2. Accessibility tree panel (`Accessibility.getFullAXTree`)
3. Network request/response mocking UI (`Fetch.enable` + `Fetch.fulfillRequest`)
4. Environment diffing (compare recorded timelines across two sessions)
5. Test data generators injectable into forms
6. Code signing for the Windows installer (currently unsigned — Windows
   SmartScreen will warn on install until this is added)

## License

MIT
