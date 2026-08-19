# TesterBrowser — project context for Claude

## What this is

Electron desktop app purpose-built for software testers. Two core features:
1. **Isolated sessions** — each tab is its own Electron `session` partition (own cookies, localStorage, cache). Sessions can be persistent or in-memory, and cloned.
2. **Always-on recording** — CDP Network + Console + Log events captured to a per-session SQLite ring buffer the moment a session is created, regardless of whether any UI panel is open.

**GitHub repo:** https://github.com/testheader/testerbrowser (public)  
**Stack:** Electron 31, TypeScript (main + preload), plain HTML/JS (renderer), better-sqlite3, electron-updater, electron-builder

---

## File map

```
src/main/index.ts          Main process entry: BrowserWindow, IPC handlers, autoUpdater
src/main/sessionManager.ts BrowserView lifecycle, switching, navigation, CDP event forwarding
src/main/recorder.ts       CDP debugger → SQLite ring buffer (20 000 events/session cap)
src/preload/index.ts       contextBridge → window.testerBrowser
renderer/index.html        Top bar (tabs, URL bar, Export HAR) + timeline panel shell
renderer/renderer.js       All renderer logic: MRU stack, tab UI, URL bar, timeline polling
.github/workflows/build.yml CI: version bump → build Windows + Linux → publish GitHub release
```

---

## Architecture

```
Main process (Node.js / Electron)
  SessionManager
    per session: BrowserView + Electron session partition + SessionRecorder
      SessionRecorder: CDP debugger attach → better-sqlite3 WAL writes
  IPC handlers (ipcMain.handle)

Renderer (contextIsolation: true, nodeIntegration: false)
  window.testerBrowser (contextBridge)
    sessions.{list, create, switchTo, navigate, clone, destroy, onNavigated, onTabCycle}
    recording.{timeline, exportHAR}
  MRU stack (mruStack[]) — most-recently-used tab order
  pollTimeline() — 1 s interval, fetches events since lastTs
```

---

## IPC channels

| Channel | Direction | What it does |
|---|---|---|
| `sessions:list` | renderer → main | list metadata for all sessions |
| `sessions:create` | renderer → main | create BrowserView + partition + recorder |
| `sessions:switch` | renderer → main | show session BrowserView in window |
| `sessions:navigate` | renderer → main | loadURL on session (auto-prepends https://) |
| `sessions:clone` | renderer → main | copy cookies into a new session |
| `sessions:destroy` | renderer → main | destroy BrowserView, close SQLite |
| `recording:timeline` | renderer → main | query events (with optional `since` timestamp) |
| `recording:exportHAR` | renderer → main | return HAR-formatted JSON of network events |
| `session:navigated` | main → renderer | fired on did-navigate / did-navigate-in-page |
| `tabs:cycle` | main → renderer | Ctrl+Tab intercepted in BrowserView, forwarded here |

---

## Keyboard shortcuts

| Keys | Behaviour |
|---|---|
| `Ctrl+Tab` | Switch to `mruStack[1]` (previously active tab) |
| `Ctrl+Shift+Tab` | Switch to `mruStack[last]` (least recently used) |

Implemented via `before-input-event` on each BrowserView's webContents (fires before the page sees it) + `document.addEventListener('keydown')` for when the renderer top bar has focus.

---

## CI / CD pipeline

Every push to `main` runs three sequential jobs:

1. **bump-version** — parses the commit message, runs `npm version [patch|minor|major] --no-git-tag-version`, pushes a `[skip ci]` commit back to main.
   - `feat:` → minor
   - `feat!:` or `BREAKING CHANGE` → major
   - anything else → patch

2. **build-windows** (after bump-version, `ref: main`) — `npm run dist:win`, publishes to GitHub release via electron-builder.

3. **build-linux** (after bump-version, `ref: main`) — `npm run dist:linux`, same.

electron-builder publish config: `provider: github, releaseType: prerelease`. Each release gets `latest.yml` + installer + blockmap uploaded automatically.

---

## Auto-update

`electron-updater` (`autoUpdater.checkForUpdatesAndNotify()`) runs on startup, guarded with `app.isPackaged` so it's a no-op in `npm run dev`.

Flow: fetches `latest.yml` from the GitHub release → compares version to running app → if newer, downloads installer in background → shows system notification prompting restart → on restart the new installer runs silently.

**Requires the version to actually change between releases** — the bump-version CI job handles this automatically.

---

## Gotchas learned the hard way

- **`prompt()` is blocked** in Electron renderers with `contextIsolation: true` — returns null silently. Use auto-naming or an inline HTML input instead.
- **BrowserView swallows all keyboard events** — `document.keydown` in the renderer doesn't fire when a BrowserView has focus. Use `webContents.on('before-input-event')` to intercept and forward via IPC.
- **electron-builder defaults to draft releases** — `electron-updater` ignores drafts. Set `"releaseType": "prerelease"` in the publish config.
- **electron-builder needs `GH_TOKEN`** in CI even with `--publish always` — pass it as env on the `npm run dist:*` step. Use `secrets.GITHUB_TOKEN`.
- **Calling `electron-builder` directly in workflow steps fails** — it's in `node_modules/.bin`, not on PATH. Always invoke via `npm run dist:win` / `npm run dist:linux` (npm adds `.bin` to PATH when running scripts).
- **`[skip ci]` prevents infinite bump loops** — the version-bump commit has `[skip ci]` in its message; GitHub Actions skips workflow runs for such commits.
- **Build jobs must `ref: main`** after bump-version pushes — without it they'd checkout the pre-bump SHA and publish the old version number.

---

## Development

```bash
npm install
npm run dev      # TypeScript compile + launch Electron (no auto-update, no publish)
```

## Roadmap (not yet built)

1. Visual regression panel (`Page.captureScreenshot` + `pixelmatch` diffing)
2. Accessibility tree panel (`Accessibility.getFullAXTree`)
3. Network request/response mocking UI (`Fetch.enable` + `Fetch.fulfillRequest`)
4. Environment diffing (compare timelines across two sessions)
5. Test data generators injectable into forms
6. Code signing for Windows installer (currently unsigned — SmartScreen warns)
