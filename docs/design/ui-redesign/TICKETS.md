# UI redesign — ticket drafts

Ordered. Create issues in this order (see `AGENT_CREATE_TICKETS.md`). Each ticket follows the repo's Definition of Ready; `groom-ticket` verifies the implementation notes against current `main` before marking Ready.

Applies to every ticket (implementers: read once):
- Spec is `docs/design/ui-redesign/README.md`; tokens are in `tokens.css`; open the prototype to see the state.
- All styling goes in `renderer/style.css` (CSP has no `'unsafe-inline'`). Use `--tb-*` tokens, never hard-coded colours.
- Keep every existing element ID and the `.active` class contract; e2e specs depend on them.
- Check both themes (`body.light-mode` and dark) before committing.
- If a visual-regression or snapshot spec compares app chrome, update its baseline in the same commit and say so in the commit message.

---

## T01 — chore: vendor Lucide icons and JetBrains Mono, allow local fonts in CSP
**Labels:** infrastructure, ui
**Problem / motivation**
The redesign uses the Lucide icon font and JetBrains Mono. The page CSP (`default-src 'none'`) blocks fonts, and nothing may load from a CDN.
**Acceptance criteria**
- [ ] `renderer/vendor/lucide/` contains `lucide.css` + `lucide.woff2` from `lucide-static` (pinned version, MIT licence file included).
- [ ] `renderer/vendor/fonts/` contains JetBrains Mono 400/500/600 woff2 + OFL licence; `@font-face` rules are in `style.css`.
- [ ] CSP in `renderer/index.html` and `renderer/newtab.html` adds `font-src 'self'`; no other CSP directive is loosened.
- [ ] An element with class `icon-globe` renders the glyph (no tofu) and computed `font-family` resolves JetBrains Mono for a test element using `--tb-font-mono`.
- [ ] No network requests to external hosts at startup (existing security/CSP specs stay green).
**Implementation notes**
`renderer/index.html`, `renderer/newtab.html` (CSP meta), `renderer/style.css` (`@font-face`), new `renderer/vendor/lucide/`, `renderer/vendor/fonts/`. `lucide.css` must be linked with `<link rel="stylesheet">` (style-src 'self' allows it). Check that `package.json` build `files` include `renderer/vendor/**`.
**Test plan**
Extend `e2e/security.spec.ts` (or `smoke.spec.ts`) with: CSP contains `font-src 'self'`; `document.fonts.check('12px "JetBrains Mono"')` is true after load; the icon glyph width is > 0.
**Out of scope**
Using the icons anywhere (later tickets). Changing colours.

## T02 — feat: new theme tokens for light and dark
**Labels:** ui, enhancement
**Problem / motivation**
The current palette is near-monochrome grey with no hierarchy. The redesign defines a new token set (README § Design tokens) that every later ticket uses.
**Acceptance criteria**
- [ ] The `:root` and `body.light-mode` token blocks at the top of `style.css` are replaced by `tokens.css` from the handoff (legacy names re-pointed, `--tb-*` added).
- [ ] `body` uses `--tb-font-ui`; elements that showed data in `monospace` use `--tb-font-mono`.
- [ ] Theme toggle and Settings › Theme still switch both themes; System default still follows the OS.
- [ ] No rule outside the token block hard-codes a neutral or status colour that has a token (grep `#[0-9a-f]{3,6}` outside the block: only documented exceptions remain).
**Implementation notes**
`renderer/style.css` (token block, lines ~16–98 at `b275bcd`), `renderer/theme.js` (class toggling, unchanged unless needed). Some rules use literal `rgba(127,200,255,…)` tints (filter pills, storage buttons); swap them for `--tb-accent-soft` / `--tb-*-soft`.
**Test plan**
`e2e/a11y-self-check.spec.ts` contrast checks must pass in both themes; add a test that toggles theme and asserts `getComputedStyle(body).getPropertyValue('--tb-surface')` changes. Update any app-chrome screenshot baselines.
**Out of scope**
Layout or component changes; those belong to T03 onward.

## T03 — feat: restyle title bar and browser tabs
**Labels:** ui, sessions, enhancement
**Problem / motivation**
Session colour is shown as heavy borders (3px bottom border plus a 2px outline on the active tab), which reads as noise. README § 1 Window chrome.
**Acceptance criteria**
- [ ] Title bar 40px, `--tb-chrome`, no bottom border; logo 18px high.
- [ ] Browser tab 196×34, top radius 8; active = `--tb-surface` bg + 600 weight; inactive transparent + `--tb-text-2`.
- [ ] Session colour is shown only as an 8px dot before the name; `.tab` no longer has the coloured bottom border or 3-side outline.
- [ ] "+" new-tab button 28px square, radius 6, Lucide `plus`; theme toggle shows `moon` (light) / `sun` (dark); system mode keeps its small accent dot.
- [ ] Drag reorder, pin, throttled indicator, spinner, rename input and middle-click close still work.
**Implementation notes**
`renderer/tabs.js` (tab DOM: `.tab-dot`, `.tab-favicon`, `.tab-close`), `renderer/index.html` `#titlebar`, `#newSessionBtn`, `#themeToggleBtn`, `renderer/theme.js` (icon swap), `style.css` `.tab*`, `#titlebar*`. The dot reuses `--tab-color`.
**Test plan**
Existing tab specs in `e2e/app.spec.ts`, `pin-persistence.spec.ts`, `clone-session.spec.ts` must stay green. Add an assertion that `.tab.active` computed `border-bottom-width` is `0px` and `.tab-dot` background equals the session colour.
**Out of scope**
URL bar and toolbar (T04).

## T04 — feat: restyle toolbar and URL bar with session chip
**Labels:** ui, enhancement
**Problem / motivation**
Toolbar has a 2px session-colour border, a permanent zoom readout, and text/emoji buttons. README § 1.
**Acceptance criteria**
- [ ] Toolbar 46px on `--tb-surface`; back/forward/reload are 30px Lucide icon buttons (`arrow-left`, `arrow-right`, `rotate-cw`).
- [ ] URL bar 32px, radius 8, `--tb-sunken`; scheme/host/path styled as specced; lock uses `lock` / `lock-open` with ok/err colour; security popover still opens.
- [ ] Session chip at the right inside the URL bar: dot + "Session N · Persistent|In-memory"; updates on tab switch.
- [ ] `#toolbar` no longer has the 2px session-colour bottom border.
- [ ] Zoom indicator hidden at 100%, visible (and still click-to-reset) otherwise.
- [ ] Right side: bookmark `star`, downloads `download` (badge kept), report bug `bug` (opens existing bug report), ⋯ `ellipsis` opening a menu with the existing View items (Console panel, Bookmarks bar), DevTools (F12) and Settings.
**Implementation notes**
`renderer/index.html` `#toolbar`, `#urlbarWrap`, `#viewWrapper`, `#devtoolsBtn`; `renderer/toolbar.js`, `renderer/urlbar-security.js`, `renderer/view-dropdown.js`, `renderer/app-menu.js`, `renderer/bugreport.js`. Keep `#urlbar` / `#urlbarDisplay` overlay logic. Keep `#viewDropdown` IDs for `e2e/menus.spec.ts`.
**Decision (resolved by spec):** remove the visible DevTools gear (recommended: yes; F12 + ⋯ menu remain).
**Test plan**
`e2e/urlbar-display.spec.ts`, `urlbar-search.spec.ts`, `menus.spec.ts`, `shortcuts.spec.ts` stay green; add tests for the session chip text and zoom indicator visibility at 100% / 110%.
**Out of scope**
App logo menu contents, bookmarks bar styling.

## T05 — feat: grouped tool tab strip with Lucide icons and sentence case
**Labels:** ui, console-panel, enhancement
**Problem / motivation**
14 uppercase emoji tabs with no grouping. README § 2 Tool panel shell.
**Acceptance criteria**
- [ ] Tabs ordered and grouped exactly as the README table (Inspect / Compare / Simulate / Automate / Connect) with 1px dividers between groups.
- [ ] Labels and icons as specced; emoji `::before` content removed; no `text-transform: uppercase`.
- [ ] Every existing `#consoleTab*` ID, `role="tab"`, `aria-selected` and `.active` behaviour is preserved.
- [ ] Settings › Tools visibility toggles still hide/show tabs (dividers collapse when a whole group is hidden).
- [ ] Overflow chevrons still work when the window is narrow.
**Implementation notes**
`renderer/index.html` `#consoleTabsStrip`, `renderer/console-tabs.js`, `renderer/settings.js` (tab toggles, `data-tab-toggle`), `style.css` `.console-tab*`. Group wrappers can be `<div role="presentation">` inside the tablist.
**Test plan**
`e2e/a11y-self-check.spec.ts` (tab list at lines ~97–100) and `a11y.spec.ts` green; add an e2e asserting DOM order of tab IDs and that `.console-tab` computed `text-transform` is `none`.
**Out of scope**
Badges (T07), collapse (T06), panel toolbars.

## T06 — feat: tool panel collapses to just the tab strip
**Labels:** ui, console-panel, enhancement
**Problem / motivation**
Minimising the panel should leave only the tabs visible, and a tab click should restore it. README § 2 Collapsed state.
**Acceptance criteria**
- [ ] Chevron at the right of the tab strip (`chevron-down` / `chevron-up`) replaces `#consolePanelMinBtn`'s glyph (ID kept).
- [ ] Collapsed: panel height = tab strip height (39px); the toolbar row and body are hidden; the page view gets the freed space.
- [ ] Clicking any tab while collapsed expands the panel and selects it.
- [ ] Collapsed state and last height persist across restart, as today.
- [ ] The `?` help button (`#consoleHelpBtn`) is removed from the strip.
**Implementation notes**
`renderer/layout.js` (panel bounds / native view resize), `renderer/console-tabs.js`, `renderer/index.html` `#consoleHeader`, `src/main/ipc/layout.ts` if persisted bounds change shape. `#consoleDragHandle` becomes a 5px invisible grip on the top edge.
**Decision (resolved by spec):** remove `#consoleHelpBtn` / `panel-help-content.js` entirely or keep it reachable from ⋯ › Help (recommended: remove and rely on empty states; delete `src/__tests__/panel-help-content.test.ts` with it).
**Test plan**
`e2e/timeline-layout.spec.ts`, `app.spec.ts` panel tests green; add an e2e: collapse → panel height ≈ 39px and web-view bounds grow; click `#consoleTabMock` → panel expanded and Mock active.
**Out of scope**
Detaching or docking the panel elsewhere.

## T07 — feat: count badges on Console, A11y and Security tabs
**Labels:** ui, console-panel, enhancement
**Problem / motivation**
Errors and findings are invisible until you open a tab. README § 2.
**Acceptance criteria**
- [ ] Console tab shows the session's console error + exception count (err-soft/err pill); hidden at 0.
- [ ] A11y tab shows the last scan's issue count; Security tab shows the last scan's finding count (warn-soft/warn); hidden at 0 or before a scan.
- [ ] Counts update live and reset on tab (session) switch.
- [ ] Badge has an accessible label (e.g. `aria-label="2 errors"`).
**Implementation notes**
`renderer/console-tabs.js`; counts from `renderer/timeline.js` (pill counts already computed), `renderer/a11y.js`, `renderer/security.js`.
**Test plan**
Use `test-pages/console/js-error.html` in an e2e: badge shows ≥1; switch to a clean tab, badge hidden.
**Out of scope**
Badges on other tabs.

## T08 — feat: Network toolbar in a single row
**Labels:** ui, network, enhancement
**Problem / motivation**
Network filters span two rows (type pills, method pills, min ms, from/to dates). README § 3 toolbar.
**Acceptance criteria**
- [ ] One 44px row: search · Errors / Mocked / Resilience chips with counts · Method: Any ▾ (multi-select menu) · More filters (popover: Min duration, From, To) · summary "N requests · size · span" · Export HAR · Clear.
- [ ] Filters behave as today (AND-combined); "Method: GET, POST" label reflects the selection.
- [ ] `#networkControlsRow2` is no longer visible; its inputs live in the popover with their IDs kept (`#networkMinDuration` etc.).
- [ ] Export HAR still produces a file (existing HAR tests).
**Implementation notes**
`renderer/index.html` `#networkControls`, `#networkControlsRow2`, `#networkPills`, `#networkMethodPills`, `#harExportBtn`; `renderer/timeline.js` filter state (`src/__tests__/timeline-filters.test.ts` covers the logic).
**Test plan**
`timeline-filters.test.ts` unchanged and green; extend the e2e for network filtering in `app.spec.ts` to drive the chips and the Method menu.
**Out of scope**
The row rendering (T09).

## T09 — feat: Network rows as a table, one row per request
**Labels:** ui, network, enhancement
**Problem / motivation**
Requests, responses and bodies appear as separate monospace timeline lines. README § 3 table.
**Acceptance criteria**
- [ ] Network tab renders a header row and one 30px row per request: Status · Method · Name (path + host + tag) · Type · Size · Time, with the README's grid.
- [ ] Pending requests show "—" status and update in place when the response arrives; failed requests show the error text in err.
- [ ] Mocked / Resilience requests carry the tag.
- [ ] Selected row style as specced; keyboard ↑/↓ moves selection; Enter opens detail.
- [ ] Performance: `e2e/perf.spec.ts` (network flood) stays within its current budget.
**Implementation notes**
`renderer/timeline.js` (network branch: `.evt.network-request` / `-response` / `-body`), pairing by `requestId` already present in recorded events; `renderer/detail-panel.js` for selection. Console tab rendering is untouched here.
**Decision (resolved by spec):** response bodies no longer appear as inline timeline rows (only in the detail Response tab). Recommended: yes.
**Test plan**
Update `e2e/app.spec.ts` network assertions that look for `.evt-line2` text; add a test that one request → exactly one row containing status and path. Unit-test the row model (pairing) in `src/__tests__/`.
**Out of scope**
Detail pane (T10). A waterfall column (explicitly rejected).

## T10 — feat: request detail pane redesign
**Labels:** ui, network, enhancement
**Problem / motivation**
README § 3 detail pane: status pill, meta, URL, four actions, tabbed sections.
**Acceptance criteria**
- [ ] Header: status pill + mono meta (time · size · type); URL with method.
- [ ] Actions: Replay, Mock, Resilience, Copy as cURL. Mock and Resilience open those tabs with the inline form pre-filled (existing `⇒ Mock` / `⇒ Resilience` behaviour). The label reads "Resilience", not "⇒ Resilience".
- [ ] Section tabs Headers (count) / Response / Timing / Cookies (count); headers grouped and collapsible.
- [ ] Timing tab shows the five phases with bars.
- [ ] Pane width 480px default, still resizable via `#detailPanelResizeHandle`.
**Implementation notes**
`renderer/detail-panel.js`, `renderer/replay.js`, `renderer/index.html` `#detailPanel`, `#detailPanelTabBar`; timing data from the recorder's `Network.responseReceived` timing.
**Decision (resolved by spec):** today `#detailPanelTabBar` holds one tab per opened request. Recommended: replace with single-selection + section tabs (the prototype); keep middle-click on a row to "pin" as a follow-up if wanted.
**Test plan**
`src/__tests__/detail-timing.test.ts`, `copy-as-curl.test.ts` green; e2e: select a row → pill text matches status; click Mock → Mock tab active with pattern pre-filled (extend `app.spec.ts` lines ~322–349).
**Out of scope**
Replay modal redesign.

## T11 — feat: Console rows and level filter
**Labels:** ui, console-panel, enhancement
**Problem / motivation**
README § 4.
**Acceptance criteria**
- [ ] Toolbar: search + segmented All / Errors / Warnings / Info / Debug with counts; clear button.
- [ ] Rows: level icon, message (mono), clickable source link, time; error and warn rows tinted.
- [ ] Uncaught exceptions still visually distinct (err text 600) and counted as errors.
- [ ] The existing per-level pill behaviour (`#consoleLevelPills`) maps onto the segmented control; the IDs of the inputs are kept.
**Implementation notes**
`renderer/timeline.js` console branch, `renderer/index.html` `#consoleControls`; `src/__tests__/get-console-level.test.ts`.
**Test plan**
`e2e/app.spec.ts` console tests with `test-pages/console/logs.html` + `js-error.html`; add segmented-filter assertions.
**Out of scope**
HAR button placement (moves to Network in T08).

## T12 — feat: shared empty-state component; remove in-panel explanations
**Labels:** ui, refactor
**Problem / motivation**
Panels open with long help paragraphs (e.g. the green Resilience box). README § Shared patterns › Empty state.
**Acceptance criteria**
- [ ] `renderer/empty-state.js` exports `renderEmptyState({icon, tone, title, text, actionLabel, onAction})` producing the specced markup (classes in `style.css`).
- [ ] Inline explanation blocks are removed from the Resilience, Mock, Spoof, Security, A11y, Diff and VR panels (later panel tickets replace them with toolbars and empty states).
- [ ] Copy is limited to one sentence per empty state.
**Implementation notes**
New `renderer/empty-state.js`; grep `renderer/*.js` for help/intro blocks (e.g. `resilience.js` intro markup).
**Test plan**
Unit test for the generated DOM (role, button label). e2e: Resilience tab shows no element matching the old intro text.
**Out of scope**
Panel-specific layouts.

## T13 — feat: Storage panel with section nav and tables
**Labels:** ui, enhancement
**Problem / motivation**
README § 5.
**Acceptance criteria**
- [ ] Toolbar and left nav (Cookies / Local storage / Session storage / IndexedDB with counts) as specced.
- [ ] Cookie table columns and 1st/3rd-party tags as specced; flags as outline tags.
- [ ] Inline edit, click-to-copy, + Add, × delete, Clear all and Auto-refresh keep their current behaviour.
- [ ] IndexedDB tree with record counts; read-only note.
**Implementation notes**
`renderer/storage.js`, `renderer/index.html` `#storagePanel`, `#storageControls`, `#domainFilterBtn`, `#storageAutoRefreshBtn`; `src/__tests__/cookie-matches-domain.test.ts`.
**Test plan**
`e2e/app.spec.ts` storage tests (lines ~565, ~848) with `test-pages/storage/*.html` stay green; add nav-switch assertions.
**Out of scope**
New storage capabilities.

## T14 — feat: A11y panel tree and detail pane
**Labels:** ui, accessibility, enhancement
**Problem / motivation**
README § 6.
**Acceptance criteria**
- [ ] Toolbar: Inspect element, search, issues chip, node count, refresh.
- [ ] Tree with role (mono accent), name, issue tags; selection opens the right pane with properties and the page's issue cards.
- [ ] Hover-inspect still highlights the matching node.
- [ ] Issues come from the existing axe/contrast/focus checks.
**Implementation notes**
`renderer/a11y.js`, `src/main/a11yService.ts`, `src/main/a11yContrast.ts`, `renderer/vendor/axe.min.js`.
**Test plan**
`e2e/a11y.spec.ts` (all `#consoleTabA11y` flows) green; `src/__tests__/a11y-structure.test.ts` green.
**Out of scope**
New rule sets.

## T15 — feat: Security findings list and detail pane
**Labels:** ui, security, enhancement
**Problem / motivation**
README § 7.
**Acceptance criteria**
- [ ] Segmented severity filter with counts; scan time and Scan again.
- [ ] Finding rows and detail pane (why, evidence, Open request, Report to Jira) as specced.
- [ ] Open request switches to Network and selects the request.
- [ ] Before the first scan: empty state "Security scan" / one sentence / **Scan session**.
**Implementation notes**
`renderer/security.js`; analysis in `src/__tests__/security-analyze.test.ts` scope (logic unchanged). Jira hand-off via `renderer/jira.js`.
**Test plan**
`e2e/security.spec.ts` green; add Open request navigation test.
**Out of scope**
New heuristics.

## T16 — feat: Network diff layout
**Labels:** ui, network, enhancement
**Problem / motivation**
README § 8.
**Acceptance criteria**
- [ ] Toolbar session pickers A ⇄ B, Match full URL / Match path, Export JSON, Compare.
- [ ] Result chips with counts filter the table; table columns and result tags as specced.
- [ ] Selecting a row shows the body line diff and header diff in the right pane.
- [ ] Ignore-params list and >5,000-event banner keep working.
**Implementation notes**
`renderer/diff.js`, `renderer/diff-logic.js`, `src/__tests__/diff-logic.test.ts`, `diff-presentation.test.ts`.
**Test plan**
`e2e/diff.spec.ts` green; extend for chip filtering.
**Out of scope**
Changing the diff algorithm.

## T17 — feat: UI diff (visual regression) layout
**Labels:** ui, testing, enhancement
**Problem / motivation**
README § 9.
**Acceptance criteria**
- [ ] Segmented view (Baseline / Current / Diff / Side by side), Full page checkbox, New baseline, Compare.
- [ ] Side-by-side shows three equal panes with headers; stats column with % changed, pixel count, threshold, baselines list.
- [ ] No baseline yet: empty state "Visual comparison" / one sentence / **Capture baseline**.
**Implementation notes**
`renderer/visual-regression.js`, `renderer/vr-diff.js`, `renderer/vr-logic.js`, `src/main/visualRegressionStore.ts`.
**Test plan**
`e2e/vr.spec.ts` green (uses `test-pages/vr/solid-color.html`); `src/__tests__/vr-*.test.ts` green.
**Out of scope**
Diff algorithm.

## T18 — feat: Spoof panel as three section cards
**Labels:** ui, enhancement
**Problem / motivation**
README § 10.
**Acceptance criteria**
- [ ] Toolbar shows applied overrides as chips, Reset all, Apply and reload.
- [ ] Device, Location and time, Advanced cards with pick-chip presets and fields as specced; each card's Reset clears only that section.
- [ ] Nothing applies until Apply and reload (current behaviour); the page reloads after applying.
**Implementation notes**
`renderer/emulation.js`, `src/main/emulationManager.ts`, `deviceEmulation.ts`, `networkConditions.ts`; `src/__tests__/device-presets.test.ts`.
**Decision (resolved by spec):** the button currently says "Apply to tab" and asks the user to reload by hand. Recommended: "Apply and reload", reloading automatically.
**Test plan**
`e2e/spoof.spec.ts` green; `src/main/__tests__/emulation.test.ts` green.
**Out of scope**
New presets.

## T19 — feat: Mock rules table and inline form
**Labels:** ui, network, enhancement
**Problem / motivation**
README § 11.
**Acceptance criteria**
- [ ] Toolbar subtitle + New rule; inline form (method, pattern, status, body, Add CORS headers) as specced.
- [ ] Rules table with toggle, hits, last hit, edit, delete; disabled rows at 55%.
- [ ] Reorder and per-session persistence keep working.
**Implementation notes**
`renderer/mock.js`, `src/main/mockManager.ts`, tests `applyMockRulePatch`, `moveMockRule`, `mockRulePersistence`.
**Test plan**
`e2e/mock.spec.ts` green.
**Out of scope**
Rule semantics.

## T20 — feat: Resilience rules table and failure-type chips
**Labels:** ui, network, enhancement
**Problem / motivation**
README § 12. "Resilience" is the user-facing name everywhere (no "make it fail").
**Acceptance criteria**
- [ ] Add rule form with the eight failure-type chips, one-line description, pattern / probability / delay.
- [ ] Rules table as specced; hits update live; toggle, edit, delete work.
- [ ] The intro box, numbered steps and footnotes are gone.
**Implementation notes**
`renderer/resilience.js`, `src/main/resilienceManager.ts`; tests `resilienceMatch`, `mockResilienceSessionScope`.
**Test plan**
`e2e/resilience.spec.ts` green.
**Out of scope**
New failure types.

## T21 — feat: Record & playback empty state and recording view
**Labels:** ui, testing, enhancement
**Problem / motivation**
README § 13.
**Acceptance criteria**
- [ ] No saved tests: empty state with **Start recording**.
- [ ] Recording: pulsing dot + step count in the toolbar, Add assertion, Stop and save; live step list as specced.
- [ ] Saved tests list, Run ×N, results and failure replay restyled with the shared table/toolbar styles; behaviour unchanged.
**Implementation notes**
`renderer/record-playback.js`, `src/main/recordingManager.ts`, `recorder.ts`; tab ID `#consoleTabTests` stays (label "Record").
**Test plan**
`e2e/tests.spec.ts` green.
**Out of scope**
Recorder logic.

## T22 — feat: Follow along live view
**Labels:** ui, sessions, enhancement
**Problem / motivation**
README § 14.
**Acceptance criteria**
- [ ] Unpaired: empty state with **Pair with a tab**.
- [ ] Paired: Live indicator, leader → follower chips, Pause, Stop following; mirrored-event rows with result; divergences highlighted.
**Implementation notes**
`renderer/followalong.js`, `src/main/followAlongManager.ts`.
**Test plan**
`e2e/followalong.spec.ts` green.
**Out of scope**
Mirroring logic.

## T23 — feat: Jira ticket view and bug form
**Labels:** ui, integrations, enhancement
**Problem / motivation**
README § 15.
**Acceptance criteria**
- [ ] Not configured: empty state **Connect Jira** opening the existing settings form.
- [ ] Loaded ticket view (key, status, summary, configured fields, acceptance criteria) and the right-hand "Report a bug" form with attach checklist as specced.
- [ ] Customisable field layout still drives which fields show.
**Implementation notes**
`renderer/jira.js`, `src/main/jira.ts`, `src/main/ipc/jira.ts`.
**Test plan**
`e2e/jira.spec.ts` green; `src/main/__tests__/jira.test.ts` green.
**Out of scope**
New Jira API calls (attachments use what `bugreport` already produces).

## T24 — feat: Debug log filters and rows
**Labels:** ui, infrastructure, enhancement
**Problem / motivation**
README § 16.
**Acceptance criteria**
- [ ] Debug mode off: empty state with **Open settings**.
- [ ] Toolbar: search, level segmented, source chips, Copy; rows as specced, error rows tinted.
**Implementation notes**
`renderer/debuglog.js`, `src/main/debugLogStore.ts`, `appLogger.ts`.
**Test plan**
`e2e/debug-mode.spec.ts` and `bugreport.spec.ts` (they click `#consoleTabDebugLog`) green.
**Out of scope**
Log format.

## T25 — feat: Settings modal redesign
**Labels:** ui, enhancement
**Problem / motivation**
Settings descriptions are paragraphs; Features pane duplicates the README. README § 17.
**Acceptance criteria**
- [ ] Modal 780×560 with left nav General / Tools / Shortcuts / About.
- [ ] General rows use the exact shortened copy from the README; all existing settings remain (incl. GitHub sign-in, idle-install minutes).
- [ ] Tools replaces Features: one toggle row per tool (Network, Console locked on); existing `consoleTabToggle-*` IDs kept.
- [ ] Shortcuts list generated from the existing shortcut table.
- [ ] About keeps version, update status and update actions.
**Implementation notes**
`renderer/index.html` `#settingsModal`, `renderer/settings.js`, `renderer/shortcut-table.js`, `src/main/shortcutTable.ts`, `src/main/settingsPatch.ts`.
**Test plan**
`e2e/app.spec.ts` settings tests, `update-pill.spec.ts`, `src/main/__tests__/shortcutTableSync.test.ts`, `settingsPatch.test.ts` green.
**Out of scope**
New settings.

## T26 — feat: Speed Dial new-tab page restyle
**Labels:** ui, enhancement
**Problem / motivation**
README § 18.
**Acceptance criteria**
- [ ] Centred search box and 7-column tile grid as specced, both themes.
- [ ] Add site tile, remove ×, and favicon/initial fallback keep working.
- [ ] Search placeholder names the configured engine.
**Implementation notes**
`renderer/newtab.html` (own CSP and styles), `src/preload/newtab.ts`, `src/main/newtabUrl.ts`. Needs T01 fonts and T02 tokens (shared `style.css` or a copied token block).
**Test plan**
Existing new-tab coverage in `e2e/app.spec.ts` / `smoke.spec.ts`; add add/remove tile assertions if missing.
**Out of scope**
Syncing tiles.

## T27 — docs: update README, CLAUDE.md and in-app copy for the redesign
**Labels:** docs
**Problem / motivation**
Docs refer to old tab names (VR, Tests, uppercase pills, "⇒ Resilience", the ☀ button, View ▾).
**Acceptance criteria**
- [ ] README feature sections use the new tab labels and group names.
- [ ] `CLAUDE.md` / `.github/copilot-instructions.md` panel descriptions match.
- [ ] No remaining references to removed UI (help `?` button, View ▾ button, waterfall).
**Implementation notes**
`README.md`, `CLAUDE.md`, `.github/copilot-instructions.md`.
**Test plan**
Docs only; CI green.
**Out of scope**
Code changes.
