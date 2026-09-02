# TesterBrowser

A desktop browser built for manual testers — isolated sessions, always-on network recording, and a comprehensive suite of QA tools, without ever opening DevTools.

## Features

### Isolated sessions
Each tab is its own browser session with separate cookies, localStorage, and cache. Test multiple accounts or environments side by side without interference. Sessions can be:
- **Persistent** — survive across restarts
- **In-memory** — clean slate every time
- **Cloned** — copy cookies from one session into a new one to duplicate a login state
- **Snapshotted** — save the full session state (cookies, storage, IndexedDB, open tabs) and restore it later

Tabs opened via middle-click or `window.open` automatically inherit the parent session's colour, so related tabs stay visually grouped.

### Always-on recording
Network requests, console output, and JS errors are captured the moment a session is created — no need to open DevTools first and miss the early requests.

The **Console tab** at the bottom of the window shows a live, merged timeline for the active session. Filter by event type with one click:

| Pill | What it shows |
|------|---------------|
| Req  | Outgoing requests |
| Res  | Responses (status, timing) |
| Err  | Network errors |
| JS   | `console.*` calls from the page |
| Log  | Browser log messages |

Export any session's traffic as a **HAR file** with the export button.

### Storage inspector
The **Storage tab** (next to Console) shows the active session's cookies and localStorage in a table — no DevTools, no extensions needed. Cookies are labelled 1st-party vs 3rd-party. Refresh on demand or on every session switch.

### Security indicators
The **Security tab** flags issues in captured traffic automatically:
- Missing security headers
- Insecure cookies
- Mixed content
- CORS problems
- Authentication/session issues
- Exposed sensitive data in API responses

### Network mocking
The **Mock tab** lets you define rules to intercept and replace network requests in real time:
- URL glob pattern, HTTP method, response status, and body
- Add/remove/toggle rules without restarting
- Active rules shown in the timeline with a **mocked** badge
- Rules persist per session

### Resilience testing
The **Resilience tab** injects failure conditions to test how the app handles them:
- API failures, 500 errors, timeouts, slow responses
- Offline mode, missing assets, corrupted responses
- Latency injection, random failure rate
- Manually or randomly triggered

### Accessibility tree
The **A11y tab** fetches the full accessibility tree for the active page using `Accessibility.getFullAXTree` via CDP:
- Collapsible node tree showing role, name, description, and states
- Refreshes on navigation

### Visual regression
The **VR tab** captures baseline screenshots and diffs them against current state using `Page.captureScreenshot` + pixel matching:
- Before / after / diff overlay shown side by side
- Pixel-difference count and percentage

### Environment diffing
The **Diff tab** lets you pick two sessions and compare their network timelines side by side:
- Colour-coded rows: same / only-in-A / only-in-B / different-response
- HAR export of the diff

### Test data generators
Right-click any form field → **Fill with test data** to inject generated values:
- Random name, email, UUID, date, phone, address
- Custom template strings (e.g. `{firstName} {lastName}`)

### Time & space travel
The **Spoof tab** overrides what the browser reports to the page, without changing your system:
- Date and time
- Geolocation (GPS coordinates, country, city, timezone, language)

### Resilience & Jira integration
The **Jira tab** connects to your Jira instance so the ticket under test is always visible:
- Customisable field layout (not all boards are the same)
- Quick-add a bug to the current ticket with session state snippets attached

### Record / Playback
The **Tests tab** provides a browser-native test recorder — no AI, no external tools:
- Record clicks, navigation, form input, and keyboard interactions as structured steps
- Robust selector generation (prefers `data-testid`, then stable IDs, then semantic attributes)
- Condition-based playback waits (element visible/enabled, URL change, network complete)
- Assertions: element visible/hidden, text content, attribute value, URL match
- Run a test 10/50/100/N times to detect flaky behaviour
- Aggregate results: pass rate, per-step failure counts, console and network diagnostics
- Per-run failure replay
- Sensitive credentials stored via a safe mechanism — not as plain text

### Tab management
- Create, close, pin, rename, clone, and drag-reorder tabs
- Reopen recently closed tabs (`Ctrl+Shift+T`)
- Cycle by most-recently-used order (`Ctrl+Tab`)
- Right-click a tab for the full context menu
- Per-session scratch notes

### Bookmarks & Speed Dial
Bookmark the current page with `Ctrl+D`. Toggle the bookmarks bar with `Ctrl+Shift+B` or from the **View** menu.

The **Speed Dial** new-tab page gives you editable quick-access tiles for your most-used URLs.

### Light & dark mode
Toggle between light and dark themes at any time with the ☀ button in the title bar, or set your preference in **Settings**.

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
| `Ctrl++ / Ctrl+-` | Zoom in / out |
| `Ctrl+0` | Reset zoom |
| `F5 / Ctrl+R` | Reload |
| `F12` | Toggle DevTools |
| `Alt+← / Alt+→` | Back / Forward |
| `Middle-click tab` | Close tab |
| `Middle-click link` | Open in new tab (same session) |
| `Right-click tab` | Rename, pin, clone, notes, close |

### Auto-updates
TesterBrowser checks for updates on launch and installs them in the background. You'll be prompted to restart when a new version is ready.

---

## Installation

Download the latest build from the [releases page](https://github.com/testheader/testerbrowser/releases/tag/latest). Every push to `main` publishes a fresh build there — bookmark it for the latest version.

| Platform | File |
|----------|------|
| Windows  | `.exe` (NSIS installer, signed) |

---

## Development

```bash
npm install
npm run typecheck   # fast type-check, no output files
npm run dev         # build + launch Electron
```

Building the installer locally requires the Windows toolchain. The reliable path is CI:

```bash
npm run dist:win    # Windows installer build + publish
```

---

## License

MIT
