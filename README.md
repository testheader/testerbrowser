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

### The tool panel
The panel at the bottom of the window is a single tab strip, grouped by what you are doing. The chevron at its right edge collapses it to just the strip; clicking any tab expands it again.

| Group | Tabs |
|-------|------|
| Inspect | Network · Console · Storage · A11y · Security |
| Compare | Network diff · UI diff |
| Simulate | Mock · Resilience · Spoof |
| Automate | Record · Follow |
| Connect | Jira · Debug log |

Tabs can be hidden in **Settings → Tools** (Network and Console are always shown). Console, A11y and Security show a count badge when there is something to look at.

### Always-on recording
Network requests, console output, and JS errors are captured the moment a session is created — no need to open DevTools first and miss the early requests.

The **Network** tab is a table with one row per request (status, method, URL, type, time, size). A single toolbar row has a search box (URL, headers and body), a method filter, an **Errors** chip (failed requests and 4xx/5xx), **Mock** and **Resilience** chips for intercepted requests, a minimum-duration filter and **HAR** export. Selecting a row opens a detail pane with Headers, Response, Timing and Cookies, plus **Replay**, **Mock**, **Resilience** and **Copy as cURL**.

The **Console** tab shows `console.*` calls, JS exceptions and browser log messages with an All / Errors / Warnings / Info / Debug level filter. Export any session's traffic as a **HAR file** from the Network tab.

### Storage inspector
The **Storage** tab lists the active session's cookies, localStorage, sessionStorage, IndexedDB and saved site permissions, with a section nav on the left. Cookies are labelled 1st-party vs 3rd-party and can be added, edited and deleted; localStorage is editable too.

### Security indicators
The **Security** tab scans captured traffic for:
- Missing security headers
- Insecure cookies
- Plain-HTTP and mixed content
- CORS problems
- Authentication/session issues
- Exposed sensitive data in API responses

Findings are listed by severity; selecting one shows why it matters, the evidence, and **Open request** / **Report to Jira** actions.

### Network mocking
The **Mock** tab lets you define rules to intercept and replace network requests in real time:
- URL glob pattern, HTTP method, response status, delay and body, set in an inline form
- A rules table with live hit counts; toggle, reorder, edit and delete without restarting
- Active rules shown in the timeline with a **Mock** badge
- Rules persist per session and can be exported/imported as JSON

### Resilience testing
The **Resilience** tab injects failure conditions to test how the app handles them. Pick a failure type — 500 error, gateway timeout, hang, offline, 404, corrupt body, latency or random 500 — then a URL pattern, probability and delay. The rules table shows live hit counts. Per-tab network and CPU throttling live here too.

### Accessibility tree
The **A11y** tab fetches the full accessibility tree for the active page using `Accessibility.getFullAXTree` via CDP:
- Collapsible node tree showing role, name, description, and states
- A detail pane for the selected node, and a count badge for issues found by the background axe-core run

### Visual regression
The **UI diff** tab captures baseline screenshots and diffs them against the current state using `Page.captureScreenshot` + pixel matching:
- Baseline / Current / Diff / Side by side / Overlay views
- Pixel-difference count and percentage, with ignore regions

### Environment diffing
The **Network diff** tab lets you pick two sessions and compare their network timelines:
- Result chips with counts: Different / Only in A / Only in B / Same
- A table with status and time for both sides, plus a detail pane per row
- Export of the diff

### Test data generators
Right-click any form field → **Fill with test data** to inject generated values:
- Random name, email, UUID, date, phone, address
- Custom template strings (e.g. `{firstName} {lastName}`)

### Time & space travel
The **Spoof** tab overrides what the browser reports to the page, without changing your system, in three cards — Device, Location & time, and Advanced:
- Viewport/device, user agent, touch
- Date and time (clock offset), timezone, locale
- Geolocation (GPS coordinates, country, city)
- CSS media preferences

**Apply and reload** applies the overrides and reloads the page so it picks them up.

### Jira integration
The **Jira** tab connects to your Jira instance so the ticket under test is always visible:
- Load a ticket by key to see its status, fields and acceptance criteria
- Report a bug from the right-hand form with a screenshot, HAR, console errors and recorded steps attached

### Record / Playback
The **Record** tab provides a browser-native test recorder — no AI, no external tools:
- Record clicks, navigation, form input, and keyboard interactions as structured steps
- Robust selector generation (prefers `data-testid`, then stable IDs, then semantic attributes)
- Condition-based playback waits (element visible/enabled, URL change, network complete)
- Assertions: element visible/hidden, text content, attribute value, URL match
- Run a test 10/50/100/N times to detect flaky behaviour
- Aggregate results: pass rate, per-step failure counts, console and network diagnostics
- Per-run failure replay
- A live step list while recording, with **Add assertion** and **Stop and save** in the toolbar
- Sensitive credentials stored via a safe mechanism — not as plain text

### Follow along
The **Follow** tab mirrors one tab's clicks, typing and (optionally) navigation onto another, live, so you can drive two sessions at once. Pause and resume a pairing, or stop following.

### Debug log
The **Debug log** tab shows TesterBrowser's own internal logs (turn on **Debug mode** in Settings): filter by level and source, search, and copy.

### Tab management
- Create, close, pin, rename, clone, and drag-reorder tabs
- Reopen recently closed tabs (`Ctrl+Shift+T`)
- Cycle by most-recently-used order (`Ctrl+Tab`)
- Right-click a tab for the full context menu
- Per-session scratch notes

### Bookmarks & Speed Dial
Bookmark the current page with `Ctrl+D`. Toggle the bookmarks bar with `Ctrl+Shift+B` or from the **⋯** menu next to the address bar, which also holds DevTools and Settings.

The **Speed Dial** new-tab page has a search box (using your default search engine) and editable quick-access tiles for your most-used URLs.

### Light & dark mode
Toggle between light and dark themes at any time with the theme button in the title bar, or set your preference in **Settings → General**.

### Keyboard shortcuts

The same list is in **Settings → Shortcuts**.

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
