# Kanban Board Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate the @Testerbrowser GitHub Projects board with backfill issues (Done) and roadmap items (Backlog), then write the workflow spec doc.

**Architecture:** All work done via `gh` CLI and GitHub GraphQL API. No code changes to the repo itself beyond adding the spec doc.

**Tech Stack:** `gh` CLI, GitHub Projects v2 GraphQL API, GitHub Issues API.

**Spec:** `docs/superpowers/specs/2026-09-01-kanban-workflow-design.md`

## Global Constraints

- Project number: 3, owner: @me (testheader)
- Project ID: `PVT_kwHOA2Pe484BiHJY`
- Repo: `testheader/testerbrowser`
- Status field ID: `PVTSSF_lAHOA2Pe484BiHJYzhhAV-0`
- Status option IDs: Backlog=`f75ad846`, Ready=`61e4505c`, In progress=`47fc9ee4`, CI running=`df73e18b`, Done=`98236657`
- "Needs Fix" must be added as a new Status option before use

---

### Task 1: Add "Needs Fix" Status option

**Files:** None (board configuration only)

- [ ] **Step 1: Add the Needs Fix option via GraphQL**

```bash
gh api graphql -f query='
mutation {
  updateProjectV2Field(input: {
    projectId: "PVT_kwHOA2Pe484BiHJY"
    fieldId: "PVTSSF_lAHOA2Pe484BiHJYzhhAV-0"
    singleSelectOptions: [
      {name: "Backlog",     color: GRAY,   description: ""}
      {name: "Ready",       color: BLUE,   description: ""}
      {name: "In progress", color: YELLOW, description: ""}
      {name: "CI running",  color: ORANGE, description: ""}
      {name: "Needs Fix",   color: RED,    description: ""}
      {name: "Done",        color: GREEN,  description: ""}
    ]
  }) {
    projectV2Field {
      ... on ProjectV2SingleSelectField {
        options { id name }
      }
    }
  }
}'
```

- [ ] **Step 2: Capture the new option IDs from the response**

Record the ID assigned to "Needs Fix" — needed for Task 5 if any item must be set to that status.

- [ ] **Step 3: Verify**

```bash
gh project field-list 3 --owner @me --format json | grep -A2 '"Needs Fix"'
```

Expected: Needs Fix appears in the Status field options.

---

### Task 2: Create backfill feature issues

**Files:** None (GitHub Issues)

For each issue: create it, capture the URL, add to board, set Status=Done.

Helper pattern used throughout Tasks 2–4:
```bash
# 1. Create issue → capture URL
URL=$(gh issue create --repo testheader/testerbrowser \
  --title "<TITLE>" --label <LABEL> --body "<BODY>" \
  --assignee testheader 2>&1 | tail -1)
# 2. Add to board → capture item ID
ITEM=$(gh api graphql -f query="mutation { addProjectV2ItemById(input: {projectId:\"PVT_kwHOA2Pe484BiHJY\" contentId:\"$(gh api repos/testheader/testerbrowser/issues/$(basename $URL) --jq .node_id)\"}) { item { id } } }" --jq '.data.addProjectV2ItemById.item.id')
# 3. Set status
gh api graphql -f query="mutation { updateProjectV2ItemFieldValue(input: {projectId:\"PVT_kwHOA2Pe484BiHJY\" itemId:\"$ITEM\" fieldId:\"PVTSSF_lAHOA2Pe484BiHJYzhhAV-0\" value:{singleSelectOptionId:\"98236657\"}}) { projectV2Item { id } } }"
```

- [ ] **Step 1: Create core browser features issue**

```bash
gh issue create --repo testheader/testerbrowser \
  --title "feat: core browser features — loading indicator, downloads, bookmarks, permissions, context menu, zoom, tab switching" \
  --label enhancement \
  --body "Implemented in v0.8.0. Tab drag/reorder, MRU cycling, URL bar with history autocomplete, loading bar, favicon, downloads panel, bookmarks bar, permission notification banners, context menu, zoom display."
```

- [ ] **Step 2: Create stability pass issue**

```bash
gh issue create --repo testheader/testerbrowser \
  --title "feat: stability and completeness pass" \
  --label enhancement \
  --body "Implemented in v0.9.0. Session pinning, tab renaming, session clone, reopen-closed-tab, notes modal, Settings modal, always-on recording wired to UI."
```

- [ ] **Step 3: Create Storage tab + View dropdown issue**

```bash
gh issue create --repo testheader/testerbrowser \
  --title "feat: console Storage tab, View dropdown, UI polish" \
  --label enhancement \
  --body "Implemented in v0.10.0. Console panel with Console/Storage tabs. View dropdown toggles console panel and bookmarks bar visibility."
```

- [ ] **Step 4: Create Speed Dial issue**

```bash
gh issue create --repo testheader/testerbrowser \
  --title "feat: Speed Dial new-tab homepage (Opera-style)" \
  --label enhancement \
  --body "Implemented in v0.11.0. New-tab page (newtab.html) with editable speed-dial tiles. Guarded IPC — only the newtab page may write tiles."
```

- [ ] **Step 5: Create console/storage flesh-out issue**

```bash
gh issue create --repo testheader/testerbrowser \
  --title "feat: flesh out console and storage panels" \
  --label enhancement \
  --body "Implemented in v0.12.0. Console tab with pill filters (Req/Res/Err/JS/Log), HAR export, timeline clear. Storage tab with cookies and localStorage tables."
```

- [ ] **Step 6: Create request detail panel + header redaction issue**

```bash
gh issue create --repo testheader/testerbrowser \
  --title "feat: request detail panel with tabs, header redaction setting, 30-day recording cleanup" \
  --label enhancement \
  --body "Implemented in v0.13.0. Request detail side panel with Request/Response/Headers tabs, horizontal resize. Settings modal option to redact sensitive headers. Automatic cleanup of SQLite recordings older than 30 days."
```

- [ ] **Step 7: Create replay modal redesign issue**

```bash
gh issue create --repo testheader/testerbrowser \
  --title "feat: redesign replay modal — two-column layout, editable headers/body tables" \
  --label enhancement \
  --body "Implemented in v0.14.0. Larger two-column replay modal. Editable request headers and body. Method/URL/status display."
```

- [ ] **Step 8: Create session cookie picker issue**

```bash
gh issue create --repo testheader/testerbrowser \
  --title "feat: session cookie picker in replay modal" \
  --label enhancement \
  --body "Implemented in v0.15.0. Replay modal lets you pick which session's cookies to inject into the replayed request. Dropdown populated from all active sessions."
```

- [ ] **Step 9: Create 1st/3rd party cookie distinction issue**

```bash
gh issue create --repo testheader/testerbrowser \
  --title "feat: distinguish 1st-party vs 3rd-party cookies in Storage tab" \
  --label enhancement \
  --body "Implemented in v0.16.0. Storage tab cookie table gains a 1st/3rd party column. 1st-party = cookie domain matches current page domain."
```

- [ ] **Step 10: Create domain filter + storage-on-navigate issue**

```bash
gh issue create --repo testheader/testerbrowser \
  --title "feat: domain filter on by default, storage refreshes on navigate" \
  --label enhancement \
  --body "Implemented in v0.17.0. Timeline domain filter enabled by default. Storage tab auto-refreshes cookies and localStorage when the active session navigates."
```

- [ ] **Step 11: Create editable cookies/localStorage issue**

```bash
gh issue create --repo testheader/testerbrowser \
  --title "feat: editable cookies and localStorage in Storage tab" \
  --label enhancement \
  --body "Implemented in v0.19.0. Inline editing of cookie values and localStorage values directly in the Storage tab table. Changes applied via sessions:setCookie / sessions:setLocalStorage IPC."
```

- [ ] **Step 12: Create new-tab-in-session button issue**

```bash
gh issue create --repo testheader/testerbrowser \
  --title "feat: new-tab-in-session button" \
  --label enhancement \
  --body "Implemented in v0.20.0. Plus button on each tab opens a new tab sharing the same session partition and colour — stays in the same session context."
```

- [ ] **Step 13: Create retain replay session + Ctrl+scroll zoom issue**

```bash
gh issue create --repo testheader/testerbrowser \
  --title "feat: retain selected session in replay picker; add Ctrl+scroll zoom" \
  --label enhancement \
  --body "Implemented in v0.19.1. Replay modal remembers last chosen session across opens. Ctrl+scroll wheel adjusts zoom in the active BrowserView."
```

- [ ] **Step 14: Add all feature issues to board as Done**

For each issue number created above, run:
```bash
# Replace N with each issue number
NODEID=$(gh api repos/testheader/testerbrowser/issues/N --jq .node_id)
ITEM=$(gh api graphql -f query="mutation{addProjectV2ItemById(input:{projectId:\"PVT_kwHOA2Pe484BiHJY\" contentId:\"$NODEID\"}){item{id}}}" --jq '.data.addProjectV2ItemById.item.id')
gh api graphql -f query="mutation{updateProjectV2ItemFieldValue(input:{projectId:\"PVT_kwHOA2Pe484BiHJY\" itemId:\"$ITEM\" fieldId:\"PVTSSF_lAHOA2Pe484BiHJYzhhAV-0\" value:{singleSelectOptionId:\"98236657\"}}){projectV2Item{id}}}"
```

---

### Task 3: Create backfill fix + chore issues

- [ ] **Step 1: Security hardening fix**

```bash
gh issue create --repo testheader/testerbrowser \
  --title "fix: harden security before public release" \
  --label bug \
  --body "Implemented in v0.11.1. CSP hardening, contextIsolation enforcement, removed unsafe nodeIntegration paths, webSecurity enabled."
```

- [ ] **Step 2: Webview overlay + detail panel fix**

```bash
gh issue create --repo testheader/testerbrowser \
  --title "fix: webview overlay on popups, detail panel request+response, boot layout sync" \
  --label bug \
  --body "Implemented in v0.13.1. Popup windows (window.open) no longer obscured by overlay div. Detail panel shows both request and response body. Console height synced on boot."
```

- [ ] **Step 3: Replay cookie domain filtering fix**

```bash
gh issue create --repo testheader/testerbrowser \
  --title "fix: filter session cookies by request domain in replay modal" \
  --label bug \
  --body "Implemented in v0.17.4. Cookie picker in replay modal filters to cookies whose domain matches the request being replayed."
```

- [ ] **Step 4: Show all session cookies fix**

```bash
gh issue create --repo testheader/testerbrowser \
  --title "fix: show all session cookies in replay picker, not just domain-matched ones" \
  --label bug \
  --body "Implemented in v0.17.1. Replay picker now lists all cookies for the selected session so the user can choose which subset to send."
```

- [ ] **Step 5: CI pipeline chore**

```bash
gh issue create --repo testheader/testerbrowser \
  --title "chore: set up CI pipeline — typecheck → bump-version → build-windows → build-linux" \
  --label infrastructure \
  --body "Implemented as part of initial scaffolding. GitHub Actions workflow: typecheck on every push, semver bump from commit prefix, Windows installer and Linux AppImage built and published to GitHub Releases."
```

- [ ] **Step 6: Electron 43 upgrade chore**

```bash
gh issue create --repo testheader/testerbrowser \
  --title "chore: upgrade to Electron 43, electron-builder 26, better-sqlite3 13" \
  --label infrastructure \
  --body "Implemented in v0.11.2. Rebuilt native modules (electron-rebuild), fixed CI native build after upgrade."
```

- [ ] **Step 7: Jest + Playwright e2e test suite chore**

```bash
gh issue create --repo testheader/testerbrowser \
  --title "chore: add Jest unit tests and Playwright e2e test suite" \
  --label testing \
  --body "Implemented in v0.17.2. Jest unit tests for main-process logic. Playwright e2e suite driving the full Electron app: tab lifecycle, storage CRUD, recording, replay, cookie picker."
```

- [ ] **Step 8: Renderer ES module split chore**

```bash
gh issue create --repo testheader/testerbrowser \
  --title "refactor: split renderer.js (1961 lines) into 21 ES modules" \
  --label refactor \
  --body "Implemented in v0.19.1. renderer.js → 21 focused ES modules (state.js, tabs.js, timeline.js, replay.js, …). Entry point: main.js. CSS extracted to style.css. CSP updated to style-src 'self'."
```

- [ ] **Step 9: DownloadManager/PermissionManager extraction chore**

```bash
gh issue create --repo testheader/testerbrowser \
  --title "refactor: extract DownloadManager and PermissionManager from SessionManager" \
  --label refactor \
  --body "Implemented in v0.19.1. downloadManager.ts and permissionManager.ts extracted as separate classes. sessionManager.ts delegates via thin wrappers."
```

- [ ] **Step 10: JsonStore<T> refactor chore**

```bash
gh issue create --repo testheader/testerbrowser \
  --title "refactor: JsonStore<T> replaces 4 near-identical manager classes" \
  --label refactor \
  --body "Implemented in v0.19.1. BookmarkManager, URLHistoryManager, SpeedDialManager, SettingsManager → single generic JsonStore<T>. Named instances: bookmarkStore, urlHistoryStore, speedDialStore, settingsStore."
```

- [ ] **Step 11: Add all fix/chore issues to board as Done**

Same pattern as Task 2 Step 14 — add each issue and set Status=Done (`98236657`).

---

### Task 4: Create backlog issues

- [ ] **Step 1: Visual regression panel**

```bash
gh issue create --repo testheader/testerbrowser \
  --title "feat: visual regression panel" \
  --label enhancement \
  --body "Use CDP \`Page.captureScreenshot\` to capture a baseline screenshot of the current session, then capture again after an action. Diff with \`pixelmatch\`. Show side-by-side comparison with diff overlay in a new console panel tab.\n\n**Acceptance criteria:**\n- Capture baseline button in UI\n- Compare button diffs current screenshot against baseline\n- Diff panel shows: before / after / diff overlay images\n- Pixel-difference count and percentage shown"
```

- [ ] **Step 2: Accessibility tree panel**

```bash
gh issue create --repo testheader/testerbrowser \
  --title "feat: accessibility tree panel" \
  --label enhancement \
  --body "Use CDP \`Accessibility.getFullAXTree\` to fetch the a11y tree for the active session. Display as collapsible tree in a new console panel tab.\n\n**Acceptance criteria:**\n- New 'A11y' tab in console panel\n- Tree renders role, name, description, states for each node\n- Nodes are collapsible\n- Refreshes on navigate"
```

- [ ] **Step 3: Network request/response mocking**

```bash
gh issue create --repo testheader/testerbrowser \
  --title "feat: network request/response mocking UI" \
  --label enhancement \
  --body "Use CDP \`Fetch.enable\` + \`Fetch.fulfillRequest\` to intercept and mock network requests. UI to define mock rules (URL pattern → status code + body).\n\n**Acceptance criteria:**\n- Mock rules panel (URL glob, method, response status, body)\n- Add/remove/toggle rules\n- Active rules shown in timeline with a 'mocked' badge\n- Rules persist per session (stored in JsonStore)"
```

- [ ] **Step 4: Environment diffing**

```bash
gh issue create --repo testheader/testerbrowser \
  --title "feat: environment diffing — compare timelines across two sessions" \
  --label enhancement \
  --body "Select two sessions and view their timeline events side-by-side. Highlight requests that appear in one but not the other, or differ in status/response.\n\n**Acceptance criteria:**\n- Session picker to choose session A and session B\n- Side-by-side timeline view\n- Rows colour-coded: same / only-in-A / only-in-B / different-response\n- HAR export of the diff"
```

- [ ] **Step 5: Test data generators**

```bash
gh issue create --repo testheader/testerbrowser \
  --title "feat: test data generators injectable into forms" \
  --label enhancement \
  --body "Sidebar or context-menu option to inject generated test data (names, emails, addresses, UUIDs, dates) into focused form fields.\n\n**Acceptance criteria:**\n- Right-click form field → 'Fill with test data' submenu\n- Generator types: random name, email, UUID, date, phone, address\n- Custom template strings with handlebars (e.g. \`{{firstName}} {{lastName}}\`)\n- Injected via executeJavaScript into active session"
```

- [ ] **Step 6: Code signing for Windows installer**

```bash
gh issue create --repo testheader/testerbrowser \
  --title "feat: code signing for Windows installer (remove SmartScreen warning)" \
  --label infrastructure \
  --body "Currently the Windows installer is unsigned, triggering SmartScreen 'unrecognized app' warning on first run.\n\n**Acceptance criteria:**\n- Installer signed with a valid Authenticode certificate\n- SmartScreen warning does not appear for signed builds\n- Certificate and signing step integrated into CI build-windows job\n- Signing secrets stored as GitHub Actions secrets"
```

- [ ] **Step 7: ESLint for renderer JS**

```bash
gh issue create --repo testheader/testerbrowser \
  --title "chore: add ESLint for renderer JS modules" \
  --label infrastructure \
  --body "Renderer is plain JS (no bundler, no linting). Add ESLint with a sensible config for browser ES modules.\n\n**Acceptance criteria:**\n- \`npm run lint\` runs ESLint over renderer/*.js\n- Lint step added to CI (runs after typecheck, before bump-version)\n- Zero errors on current codebase at merge\n- Rules: no-unused-vars, no-undef, prefer-const, eqeqeq"
```

- [ ] **Step 8: Add all backlog issues to board as Backlog**

Same pattern as Task 2 Step 14 — add each issue and set Status=Backlog (`f75ad846`).

---

### Task 5: Write and commit the workflow spec doc

- [ ] **Step 1: Write spec doc**

Write `docs/superpowers/specs/2026-09-01-kanban-workflow-design.md` (see spec template in that file).

- [ ] **Step 2: Commit**

```bash
cd testerbrowser
git add docs/superpowers/
git commit -m "docs: add kanban workflow design spec and board setup plan"
```

- [ ] **Step 3: Verify board**

```bash
gh project item-list 3 --owner @me --format json --jq '.items | length'
```

Expected: 30+ items across Done and Backlog columns.
