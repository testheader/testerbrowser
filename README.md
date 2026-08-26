# TesterBrowser

A desktop browser built for manual testers — isolated sessions, always-on network recording, and a built-in console panel, without ever opening DevTools.

## Features

### Isolated sessions
Each tab is its own browser session with separate cookies, localStorage, and cache. Test multiple accounts or environments side by side without interference. Sessions can be:
- **Persistent** — survive across restarts
- **In-memory** — clean slate every time
- **Cloned** — copy cookies from one session into a new one to duplicate a login state

Tabs opened via middle-click or `window.open` automatically inherit the parent session's colour, so related tabs stay visually grouped.

### Always-on recording
Network requests, console output, and JS errors are captured the moment a session is created — no need to open DevTools first and miss the early requests.

The **Console panel** at the bottom of the window shows a live, merged timeline for the active session. Filter by event type with one click:

| Pill | What it shows |
|------|---------------|
| Req  | Outgoing requests |
| Res  | Responses (status, timing) |
| Err  | Network errors |
| JS   | `console.*` calls from the page |
| Log  | Browser log messages |

Export any session's traffic as a **HAR file** with the export button.

### Storage inspector
The **Storage tab** (next to Console) shows the active session's cookies and localStorage in a table — no DevTools, no extensions needed. Refresh on demand or on every session switch.

### Tab management
- Create, close, pin, rename, clone, and drag-reorder tabs
- Reopen recently closed tabs (`Ctrl+Shift+T`)
- Cycle by most-recently-used order (`Ctrl+Tab`)
- Right-click a tab for the full context menu
- Per-session scratch notes

### Bookmarks
Bookmark the current page with `Ctrl+D`. Toggle the bookmarks bar with `Ctrl+Shift+B` or from the **View** menu.

### Keyboard shortcuts

| Keys | Action |
|------|--------|
| `Ctrl+T` | New tab |
| `Ctrl+W` | Close tab |
| `Ctrl+Shift+T` | Reopen last closed tab |
| `Ctrl+Tab / Ctrl+Shift+Tab` | Cycle tabs (MRU) |
| `Ctrl+1–9` | Switch to tab by position |
| `Ctrl+L` | Focus URL bar |
| `Ctrl+F` | Find in page |
| `Ctrl+D` | Bookmark / unbookmark |
| `Ctrl+Shift+B` | Toggle bookmarks bar |
| `F5` | Reload |
| `F12` | Toggle DevTools |
| `Alt+← / Alt+→` | Back / Forward |

### Auto-updates
TesterBrowser checks for updates on launch and installs them in the background. You'll be prompted to restart when a new version is ready.

---

## Installation

Download the latest build from the [releases page](https://github.com/testheader/testerbrowser/releases/tag/latest). Every push to `main` publishes a fresh build there — bookmark it for the latest version.

| Platform | File |
|----------|------|
| Windows  | `.exe` (NSIS installer) |
| Linux    | `.AppImage` |

> **Windows note:** the installer is currently unsigned, so Windows SmartScreen will show a warning on first run. Click "More info → Run anyway" to proceed.

**Linux:** make the AppImage executable before running:
```bash
chmod +x TesterBrowser-*.AppImage
./TesterBrowser-*.AppImage
```

---

## Development

```bash
npm install
npm run typecheck   # fast type-check, no output files
npm run dev         # build + launch Electron
```

Building installers locally requires the matching platform toolchain. The reliable path for Windows builds is CI:

```bash
npm run dist:win    # Windows (on a Windows machine)
npm run dist:linux  # Linux AppImage (any platform)
npm run dist:mac    # macOS (on macOS)
```

---

## Roadmap

1. Visual regression panel (screenshot diffing against stored baselines)
2. Accessibility tree panel
3. Network request/response mocking UI
4. Environment diffing (compare timelines across two sessions)
5. Test data generators injectable into forms
6. Code signing for the Windows installer

---

## License

MIT
