# TesterBrowser — project context for Claude

## What this is

Electron desktop app purpose-built for software testers. Two core features:
1. **Isolated sessions** — each tab is its own Electron `session` partition (own cookies, localStorage, cache). Sessions can be persistent or in-memory, and cloned.
2. **Always-on recording** — CDP Network + Console + Log events captured to a per-session SQLite ring buffer the moment a session is created, regardless of whether any UI panel is open.

**GitHub repo:** https://github.com/testheader/testerbrowser (public)
**Stack:** Electron 31, TypeScript (main + preload), plain HTML/JS (renderer), better-sqlite3, electron-updater, electron-builder
**Current version:** ~0.10.x (CI bumps on every push)

---

## File map

```
src/main/index.ts          Main process: BrowserWindow, IPC handlers, app menu, autoUpdater
src/main/sessionManager.ts BrowserView lifecycle, tab mgmt, CDP forwarding, downloads, permissions
src/main/recorder.ts       CDP debugger → SQLite ring buffer (20 000 events/session cap)
src/preload/index.ts       contextBridge → window.testerBrowser (full API surface)
renderer/index.html        All CSS + HTML shell: topbar, console panel (Console+Storage tabs),
                           modals (settings, notes), View dropdown, permission notifications
renderer/renderer.js       All renderer logic: tabs, URL bar, find, bookmarks, downloads,
                           console filter pills, Storage tab, View dropdown, timeline polling
.github/workflows/build.yml  CI: typecheck → bump-version → build-windows → build-linux
```

---

## Architecture

```
Main process (Node.js / Electron)
  SessionManager
    per session: WebContentsView + Electron session partition + SessionRecorder
      SessionRecorder: CDP debugger attach → better-sqlite3 WAL writes
  IPC handlers (ipcMain.handle)

Renderer (contextIsolation: true, nodeIntegration: false)
  window.testerBrowser (contextBridge)
  Tab state: tabOrder[], mruStack[], tabFavicons{}, tabTitles{}, navState{}
  Console panel
    Console tab  — timeline events, pill filter toggles (Req/Res/Err/JS/Log), HAR export
    Storage tab  — cookies (via sessions:getCookies) + localStorage (via sessions:getLocalStorage)
  View dropdown  — toggle console panel visibility + bookmarks bar
  pollTimeline() — 1 s interval, fetches events since lastTs
```

---

## IPC channels

| Channel | Direction | What it does |
|---|---|---|
| `sessions:list` | R→M | list metadata for all sessions |
| `sessions:create` | R→M | create WebContentsView + partition + recorder |
| `sessions:switch` | R→M | show session view in window |
| `sessions:navigate` | R→M | loadURL (auto-prepends https://) |
| `sessions:clone` | R→M | copy cookies into new session |
| `sessions:destroy` | R→M | destroy view, close SQLite |
| `sessions:rename` | R→M | rename session |
| `sessions:pin` | R→M | pin/unpin session |
| `sessions:reopen` | R→M | recreate a closed session by partition |
| `sessions:back/forward/reload/stop` | R→M | navigation controls |
| `sessions:setZoom/resetZoom/getZoom` | R→M | zoom factor |
| `sessions:getCookies` | R→M | `session.cookies.get({})` for session partition |
| `sessions:getLocalStorage` | R→M | `executeJavaScript('JSON.stringify(localStorage)')` in active page |
| `sessions:notes:get/set` | R→M | per-session scratch notes |
| `sessions:contextMenu` | R→M | show tab right-click menu |
| `devtools:toggle` | R→M | open/close DevTools for session |
| `find:start/stop` | R→M | findInPage / stopFindInPage |
| `recording:timeline` | R→M | query events (optional `since` timestamp, `limit`) |
| `recording:exportHAR` | R→M | return HAR-formatted JSON |
| `layout:setConsoleHeight` | R→M | resize BrowserView; pass 0 to fully hide console |
| `layout:setTopBarHeight` | R→M | resize BrowserView top offset |
| `layout:setViewerVisible` | R→M | show/hide BrowserView (used by modals) |
| `download:list/open/reveal/cancel/clear` | R→M | download management |
| `permission:respond` | R→M | grant/deny browser permission request |
| `bookmarks:list/add/remove` | R→M | bookmark persistence |
| `urlHistory:get/add` | R→M | URL autocomplete history |
| `app:versionInfo` | R→M | current + latest version + update status |
| `app:checkForUpdates` | R→M | trigger autoUpdater |
| `app:restartAndInstall` | R→M | quitAndInstall |
| `session:navigated` | M→R | fired on did-navigate / did-navigate-in-page |
| `session:navState` | M→R | canBack / canForward |
| `session:titleUpdated` | M→R | page title changed |
| `session:faviconUpdated` | M→R | new favicon URL |
| `session:loading` | M→R | loading started/stopped |
| `session:loadFailed` | M→R | main-frame load failure |
| `session:zoomChanged` | M→R | zoom factor changed |
| `session:newTab` | M→R | new tab created (from window.open or middle-click) |
| `tabs:cycle` | M→R | Ctrl+Tab intercepted in BrowserView |
| `tab:action` | M→R | rename / close / notes / refresh from context menu |
| `find:result` | M→R | findInPage result (matches, activeMatch) |
| `app:shortcut` | M→R | keyboard shortcut forwarded from BrowserView |
| `update:status` | M→R | autoUpdater status |
| `show:settings` | M→R | open settings modal (from Help menu) |
| `download:update` | M→R | download progress/state |
| `download:cleared` | M→R | completed downloads cleared |
| `permission:request` | M→R | browser permission prompt needed |

---

## Keyboard shortcuts

| Keys | Behaviour |
|---|---|
| `Ctrl+T` | New tab |
| `Ctrl+W` | Close tab |
| `Ctrl+Shift+T` | Reopen last closed tab |
| `Ctrl+Tab / Ctrl+Shift+Tab` | Cycle tabs by MRU |
| `Ctrl+1–9` | Switch to tab by position (9 = last) |
| `Ctrl+L` | Focus URL bar |
| `Ctrl+F` | Toggle find bar |
| `Ctrl+D` | Bookmark / unbookmark current page |
| `Ctrl+Shift+B` | Toggle bookmarks bar |
| `F5 / Ctrl+R` | Reload |
| `Esc` | Stop loading / close find bar |
| `F3 / Shift+F3` | Find next / previous |
| `F12` | Toggle DevTools |
| `Alt+← / Alt+→` | Back / Forward |
| `Ctrl++ / Ctrl+-` | Zoom in / out |
| `Ctrl+0` | Reset zoom |
| `Middle-click tab` | Close tab (pinned tabs protected) |
| `Middle-click link` | Open in new tab, same session partition + colour |
| `Right-click tab` | Context menu: rename, pin, clone, notes, close |
| `Double-click tab name` | Inline rename |
| `Drag tab` | Reorder tabs |

---

## Renderer: console panel

The console panel sits fixed at the bottom of the window. Height is drag-resizable. `layout:setConsoleHeight(0)` tells the main process to give the BrowserView the full height (console hidden).

**Console tab** — streams timeline events polled every 1 s via `recording:timeline`. Five pill toggle buttons filter by event kind (Req/Res/Err/JS/Log). Click a pill to toggle. HAR export and clear buttons on the right.

**Storage tab** — fetches cookies + localStorage on demand (refresh button or session switch). Displays in tables: cookies have domain/name/value/path/secure/httpOnly columns; localStorage has key/value. `getLocalStorage` runs `executeJavaScript` in the active page — returns empty for pages with no content.

---

## Renderer: View dropdown

"View ▾" button in the toolbar (right of DevTools). Opens a dropdown with:
- **Console panel** — toggles `consolePanel.style.display` and calls `layout:setConsoleHeight`
- **Bookmarks bar** — same as `Ctrl+Shift+B`

Dropdown closes on any outside click.

---

## Session colours

Each session is assigned a colour from `TAB_COLORS` in `sessionManager.ts` (10 colours, cycling). New tabs opened via middle-click or window.open inherit the **same colour** as the parent session to make session grouping visually obvious.

---

## CI / CD pipeline

Every push to `main` (by a non-bot actor) runs four sequential jobs:

1. **typecheck** — `npm run typecheck` (`tsc --noEmit`). Fails fast on TypeScript errors before anything is built or published.
2. **bump-version** — parses commit message, runs `npm version [patch|minor|major]`, pushes `[skip ci]`-free commit back.
   - `feat:` → minor | `feat!:` / `BREAKING CHANGE` → major | anything else → patch
3. **build-windows** — `npm run dist:win`, publishes to GitHub release.
4. **build-linux** — `npm run dist:linux`, same.

---

## Development commands

```bash
npm install               # Install deps (runs electron-rebuild for better-sqlite3)
npm run typecheck         # Type-check only — no output files, fast feedback
npm run build             # Compile TypeScript → dist/
npm run dev               # build + launch Electron (no auto-update, no publish)
npm run dist:win          # Full Windows installer build + publish
npm run dist:linux        # Full Linux AppImage build + publish
```

---

## Auto-update

`electron-updater` runs on startup (packaged builds only). Fetches `latest.yml` from GitHub releases, downloads in background, notifies on restart. The bump-version CI job ensures every release has a unique version number.

---

## Gotchas learned the hard way

- **`prompt()` is blocked** in Electron renderers with `contextIsolation: true` — returns null silently. Use auto-naming or inline HTML input.
- **BrowserView swallows all keyboard events** — `document.keydown` in the renderer doesn't fire when a WebContentsView has focus. Use `webContents.on('before-input-event')` to intercept and forward via IPC.
- **electron-builder defaults to draft releases** — `electron-updater` ignores drafts. Set `"releaseType": "prerelease"`.
- **electron-builder needs `GH_TOKEN`** in CI even with `--publish always` — pass as env on the npm step.
- **Calling `electron-builder` directly in workflow steps fails** — always invoke via `npm run dist:*`.
- **Infinite bump loop prevention** — `if: github.actor != 'github-actions[bot]'` on bump-version.
- **Build jobs must `ref: main`** after bump-version pushes — without it they'd checkout the pre-bump SHA.
- **`setConsoleHeight(0)` is special** — the method clamps to min 80px for drag-resize, but explicitly accepts 0 to fully hide the console (BrowserView fills the window).
- **`getLocalStorage` is page-scoped** — `executeJavaScript` runs in the currently loaded page's origin. Navigating to a new page changes what localStorage is visible.
- **Session colour inheritance** — when `setWindowOpenHandler` fires (window.open or middle-click), the new session is created with the parent session's `color` captured in the `createSession` closure. Context-menu "Open link in new tab" does the same.

---

## Roadmap (not yet built)

1. Visual regression panel (`Page.captureScreenshot` + `pixelmatch` diffing)
2. Accessibility tree panel (`Accessibility.getFullAXTree`)
3. Network request/response mocking UI (`Fetch.enable` + `Fetch.fulfillRequest`)
4. Environment diffing (compare timelines across two sessions)
5. Test data generators injectable into forms
6. Code signing for Windows installer (currently unsigned — SmartScreen warns)
7. ESLint for renderer JS (currently plain JS, no linting)
8. Automated e2e test harness (Playwright with Electron driver)
