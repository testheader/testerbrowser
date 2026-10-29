# Changelog

## v0.151.4 — 2026-10-29

### Fixes

- Follow — after stopping a pairing, the old log overlaps the "Pair with a tab" empty state (refs #351) (e78ffdb)

## v0.151.3 — 2026-10-29

### Other

- Record — split into "New recording" / "Saved recordings" tabs with standard buttons (refs #350) (360a393)

## v0.151.2 — 2026-10-29

### Other

- A11y — move per-view controls to a second toolbar row (tree tools, issues chip, focus tools) (refs #348) (7eb16b8)

## v0.151.1 — 2026-10-29

### Other

- Network diff — move ignored query params into a toolbar popover (refs #347) (c9656c4)

## v0.151.0 — 2026-10-29

### Features

- UI diff — guided two-step baseline/compare flow with one capture entry point (refs #346) (91dbfec)

## v0.150.16 — 2026-10-29

### Other

- Resilience/Mock — visually separate the add-rule form from the rules list (refs #345) (506e26e)

## v0.150.15 — 2026-10-29

### Fixes

- Mock/Resilience — primary buttons don't use the app's primary button style (refs #344) (4e885be)

## v0.150.14 — 2026-10-29

### Fixes

- Jira — panel content is not centred and only spans its content width (refs #343) (ebd1764)

## v0.150.13 — 2026-10-29

### Other

- Bug report screenshot for #352 (e00b259)

## v0.150.12 — 2026-10-29

### Other

- Bug report screenshot for #351 (e9ac280)

## v0.150.11 — 2026-10-29

### Other

- Bug report screenshot for #350 (3b88b75)

## v0.150.10 — 2026-10-29

### Other

- Bug report screenshot for #349 (7daaf69)

## v0.150.9 — 2026-10-29

### Other

- Bug report screenshot for #348 (842fceb)

## v0.150.8 — 2026-10-29

_No changes recorded._

## v0.150.7 — 2026-10-29

### Other

- Bug report screenshot for #347 (f07fa52)
- Bug report screenshot for #346 (7c5f933)

## v0.150.6 — 2026-10-29

### Other

- Bug report screenshot for #345 (eef8870)

## v0.150.5 — 2026-10-29

_No changes recorded._

## v0.150.4 — 2026-10-29

### Other

- Bug report screenshot for #344 (70076f1)
- Bug report screenshot for #343 (408e80f)

## v0.150.3 — 2026-10-28

### Fixes

- **e2e:** focus-order test matched "on" inside the button's own class (b95073f)
- four flaky e2e tests, and a 10s stall in snapshot import and tab clone (1212baa)

### Other

- Merge remote-tracking branch 'origin/main' into claude/project-state-assessment-gwx7o0 (e4a1b2b)

## v0.150.2 — 2026-10-28

### Fixes

- match the on class by word in the Focus order and Inspect e2e checks (c5eb8f3)

### Other

- Merge remote-tracking branch 'origin/main' into claude/cool-shannon-3xyfz9 (24d2efe)

## v0.150.1 — 2026-10-28

### Features

- migrate existing settings so idle install is on by default (06950f0)
- re-check for updates every 15 minutes and install idle updates by default (0213f1c)

### Other

- Merge origin/main into claude/cool-shannon-3xyfz9 (40549e6)
- use plain Spoof labels and a one-line viewport hint (279c219)

## v0.150.0 — 2026-10-28

### Features

- Focus view in the A11y panel (focus order and focus trap) (refs #342) (3066bbb)

## v0.149.1 — 2026-10-28

### Other

- move network and CPU throttling into Spoof › Advanced (refs #341) (873243c)

## v0.149.0 — 2026-10-28

### Features

- Speed Dial uses cached or initial-letter favicons and no google.com requests (refs #340) (ba1ec77)

## v0.148.12 — 2026-10-28

### Other

- Spoof uses plain labels and a one-line helper text (refs #331) (55fd129)

## v0.148.11 — 2026-10-28

_No changes recorded._

## v0.148.10 — 2026-10-28

### Other

- hide custom throttle fields unless the preset is Custom (refs #330) (db0bab6)
- move A11y, Mock and Resilience onto the shared controls (refs #328) (03f3f94)

## v0.148.9 — 2026-10-28

### Other

- one menu under the logo, and remove the ⋯ button (refs #326) (088b0d2)

## v0.148.8 — 2026-10-28

### Fixes

- update detail-actions e2e for the Copy split button (refs #336) (a47b48d)

## v0.148.7 — 2026-10-28

### Fixes

- chip labels and counts use a consistent 4px gap (refs #339) (4477540)

## v0.148.6 — 2026-10-28

_No changes recorded._

## v0.148.5 — 2026-10-28

### Fixes

- bug report footer stays visible; diagnostics collapsed by default (refs #338) (ed222c0)

### Other

- Settings shortcuts list uses a single column with keycap styling (refs #337) (f03b447)

## v0.148.4 — 2026-10-28

### Other

- combine Copy as cURL and Copy as fetch into one split button (refs #336) (ce93eb8)

## v0.148.3 — 2026-10-28

### Fixes

- browser tabs and the group "+" are reachable by keyboard (refs #335) (fbf2f63)

## v0.148.2 — 2026-10-28

### Other

- sentence case and one panel name across the app (refs #334) (9ee5510)

## v0.148.1 — 2026-10-28

### Fixes

- show the session-group "+" on hover and use the Lucide pin icon (refs #333) (f4a29af)

## v0.148.0 — 2026-10-28

### Features

- overflow menu for tool tabs hidden in narrow windows (refs #332) (fdd4659)

## v0.147.0 — 2026-10-28

### Features

- collapse the Mock new-rule form until New rule is pressed (refs #329) (900b23c)

## v0.146.13 — 2026-10-28

### Fixes

- hide empty-state filters and repeated actions; use verb labels for first actions (refs #327) (506f5d0)

## v0.146.12 — 2026-10-28

### Other

- Follow shows two competing ways to start pairing (refs #325) (1500cac)

## v0.146.11 — 2026-10-28

### Fixes

- keep request detail per tool and close it when the tool changes (refs #324) (7ae934f)

## v0.146.10 — 2026-10-28

### Fixes

- Jira not-connected state shows controls that do nothing (refs #323) (449e0cc)

## v0.146.9 — 2026-10-28

### Fixes

- Storage cookie table drops the Value column at narrow widths (refs #321) (e13aa64)

## v0.146.8 — 2026-10-28

### Fixes

- Network detail pane breaks the request table in narrow windows (refs #320) (342f0cf)

## v0.146.7 — 2026-10-28

### Fixes

- honour [hidden] in panels whose classes set display (Jira, Record) (refs #319) (addfcd9)

## v0.146.6 — 2026-10-26

### Fixes

- enlarge per-group new-tab (+) button hit target (a596596)

## v0.146.5 — 2026-10-21

### Fixes

- keep unit-test fakes working with the aborted-load catch (refs #317) (c3000b9)
- HAR export tolerates omitted binary bodies; clone and snapshot import tolerate an aborted new-tab load (refs #317) (9a72d65)

## v0.146.4 — 2026-10-21

### Fixes

- Network diff no longer throws when a captured response body has no text (refs #307) (7f65e9e)

## v0.146.3 — 2026-10-21

### Fixes

- stop the UI diff bar's Reset overlapping Compare on narrow windows; keep middle-click tab close working when the strip overflows (refs #308) (917ea16)

## v0.146.2 — 2026-10-21

### Other

- update README, CLAUDE.md and in-app copy for the redesign (refs #318) (cd645ac)

## v0.146.1 — 2026-10-21

### Features

- Speed Dial new-tab page restyle (refs #317) (c46177a)

### Fixes

- type-check exemption and CSP test update for the new-tab restyle (refs #317) (31f3ce2)

## v0.146.0 — 2026-10-21

### Features

- Settings modal redesign (refs #316) (d306696)

## v0.145.0 — 2026-10-21

### Features

- Debug log filters and rows (refs #315) (1b2ad4c)

## v0.144.0 — 2026-10-21

### Features

- Jira ticket view and bug form (refs #314) (cabd8b0)

## v0.143.0 — 2026-10-21

### Features

- Follow along live view (refs #313) (8cd59e4)

## v0.142.0 — 2026-10-21

### Features

- Record & playback empty state and recording view (refs #312) (5c81b73)

## v0.141.1 — 2026-10-21

### Fixes

- light-theme legacy colour aliases, contrast and ARIA row roles; adapt e2e specs to the redesign (refs #311) (d966021)

### Other

- fix resilience, security and mock e2e specs for the redesign; load network rows before focusing a finding's request (refs #311) (60127bc)

## v0.141.0 — 2026-10-21

### Features

- Resilience rules table and failure-type chips (refs #311) (db6ac95)

## v0.140.0 — 2026-10-20

### Features

- Mock rules table and inline form (refs #310) (8e3fbe4)

## v0.139.0 — 2026-10-20

### Features

- Spoof panel as three section cards (refs #309) (994b4ac)

## v0.138.0 — 2026-10-20

### Features

- UI diff (visual regression) layout (refs #308) (88d8fde)

## v0.137.0 — 2026-10-20

### Features

- Network diff layout (refs #307) (d9391e6)

## v0.136.0 — 2026-10-20

### Features

- Security findings list and detail pane (refs #306) (b701857)

## v0.135.0 — 2026-10-20

### Features

- A11y panel tree and detail pane (refs #305) (9a25eea)

## v0.134.0 — 2026-10-20

### Features

- Storage panel with section nav and tables (refs #304) (f578b82)

## v0.133.0 — 2026-10-20

### Features

- shared empty-state component; remove in-panel explanations (refs #303) (d017b79)

## v0.132.0 — 2026-10-20

### Features

- Console rows and level filter (refs #302) (6f5a86c)

## v0.131.0 — 2026-10-20

### Features

- request detail pane redesign (refs #301) (d61cfc0)

## v0.130.0 — 2026-10-20

### Features

- Network rows as a table, one row per request (refs #300) (b6a712a)

## v0.129.0 — 2026-10-20

### Features

- Network toolbar in a single row (refs #299) (a2b264f)

## v0.128.0 — 2026-10-20

### Features

- count badges on Console, A11y and Security tabs (refs #298) (44b6e20)

## v0.127.0 — 2026-10-20

### Features

- tool panel collapses to just the tab strip (refs #297) (28ea258)

## v0.126.0 — 2026-10-20

### Features

- grouped tool tab strip with Lucide icons and sentence case (refs #296) (7dcd064)

## v0.125.0 — 2026-10-20

### Features

- restyle toolbar and URL bar with session chip (refs #295) (0981e2d)

## v0.124.1 — 2026-10-20

### Other

- add UI redesign screenshots (a3223c5)

## v0.124.0 — 2026-10-20

### Features

- restyle title bar and browser tabs (refs #294) (3ccde21)

## v0.123.0 — 2026-10-20

### Features

- new theme tokens for light and dark (refs #293) (371c6ef)

## v0.122.4 — 2026-10-20

### Other

- vendor Lucide icons and JetBrains Mono, allow local fonts in CSP (refs #292) (a0f88ed)

## v0.122.3 — 2026-10-20

### Fixes

- crash when a Resilience rule hits (refs #286) (c42a975)

## v0.122.2 — 2026-10-20

### Other

- add UI redesign handoff (b1c930d)

## v0.122.1 — 2026-10-19

### Fixes

- log resilience rule hits for crash diagnosis (refs #289) (a855201)

## v0.122.0 — 2026-10-19

### Features

- configurable idle-install threshold (refs #288) (e473d9d)

## v0.121.0 — 2026-10-19

### Features

- resizable settings modal (refs #287) (ac8e792)
- feature toggles for console panel tabs (refs #285) (ddac8c0)

## v0.120.0 — 2026-10-19

### Features

- two-state UI diff bar with settings cog and diff export (#290) (63998b3)

## v0.119.1 — 2026-10-19

### Fixes

- stop e2e UI-state races and retry failed tests once in CI (d443b6a)

## v0.119.0 — 2026-10-19

### Features

- generate CHANGELOG.md and build status in release notes (a132ddd)

## v0.118.2 — 2026-09-30

### Features

- type-check the renderer JS (20f9407)

### Fixes

- sender-check every IPC channel centrally (default deny) (bab6cb2)
- only expose new-tab preload APIs to the new-tab page itself (0ad2626)

### Other

- set package.json author to Quality Crafters (e150fa5)

## v0.118.1 — 2026-09-30

### Fixes

- e2e shard 1 — allow http Jira base URL on loopback, explicit label for Spoof touch toggle (041a1e1)

## v0.118.0 — 2026-09-30

### Features

- UI diff — step flow, pass/fail summary, view modes, region navigation, baseline manager (e849648)

## v0.117.0 — 2026-09-30

### Features

- help popover for every console tab (? button in the console header) (0582269)

## v0.116.0 — 2026-09-30

### Features

- network diff — summary, filters, clearer rows, inline header/body diffs (6460a28)

## v0.115.1 — 2026-09-30

### Fixes

- security hardening — openExternal prompts, Jira https, newtab sender, log redaction, path ids, test URLs (ec4852b)

## v0.115.0 — 2026-09-30

### Features

- redesign Spoof panel with presets, collapsible sections and applied-state summary (3705923)

## v0.114.9 — 2026-09-30

### Other

- remove accidentally committed agent worktree, ignore .claude/worktrees (37eaab9)
- bring CLAUDE.md IPC table and file map up to date with src/main/ipc/*.ts (fe42f50)

## v0.114.8 — 2026-09-30

### Other

- delete the dead renderer/renderer.js legacy monolith (refs #284) (0b708ea)

## v0.114.7 — 2026-09-30

### Other

- split index.ts's IPC handlers into src/main/ipc/*.ts modules (refs #283) (ecff670)

## v0.114.6 — 2026-09-30

### Other

- extract A11yService from sessionManager.ts (refs #283) (9f0e251)

## v0.114.5 — 2026-09-30

### Other

- extract RecordingManager and FollowAlongManager from sessionManager.ts (refs #282) (00c13b9)

## v0.114.4 — 2026-09-30

### Fixes

- VR baseline ids can collide when save()/importBaseline() run within the same millisecond (2ed3049)

## v0.114.3 — 2026-09-30

### Other

- extract SnapshotManager and EmulationManager from sessionManager.ts (refs #281) (438414d)
- extract MockManager and ResilienceManager from sessionManager.ts (refs #255) (4edcd03)

## v0.114.2 — 2026-09-30

### Other

- cover snapshotScripts.ts collector scripts and extract index.ts's bug-report formatting for testability (refs #280) (3c14af8)

## v0.114.1 — 2026-09-30

### Other

- extract timeline filter predicates and tab-MRU logic, add unit coverage (refs #279) (a9ed732)

## v0.114.0 — 2026-09-29

### Features

- UI diff — saved/named baselines, configurable threshold, ignore regions (refs #277) (a47d28e)

## v0.113.1 — 2026-09-29

### Fixes

- Permissions — grants aren't persisted or revocable, unparseable URLs never match, no cleanup or timeout on prompts (refs #276) (1363d91)

## v0.113.0 — 2026-09-29

### Features

- Record/Playback — cancellable runs, prevent concurrent runs, honest "Run again" label, JSON export/import of saved tests (refs #274) (28afe0e)

## v0.112.5 — 2026-09-29

### Fixes

- Record/Playback loses steps taken right after navigation and never records inside iframes (refs #273) (20fb7be)

## v0.112.4 — 2026-09-29

### Fixes

- Record/Playback fill/check and Test Data fill used el.value=/el.checked= directly, invisible to React-controlled inputs (refs #272) (7724b56)

## v0.112.3 — 2026-09-29

### Fixes

- e2e — diff.spec.ts's setupDiffFreeTextComparison() could match a stale tab from an earlier run (refs #269) (5a71fe6)

## v0.112.2 — 2026-09-29

_No changes recorded._

## v0.112.1 — 2026-09-29

### Fixes

- viewport fixture missing a viewport meta tag broke the device-metrics e2e assertion (refs #271) (35c06ba)
- lock icon click never opened the security popover — CSS hid it on its own mousedown (refs #266) (0bea500)

## v0.112.0 — 2026-09-29

### Features

- Spoof panel — viewport/device presets, touch emulation, prefers-color-scheme and prefers-reduced-motion (refs #271) (38d4323)

## v0.111.0 — 2026-09-29

### Features

- optional "allow real popups" setting that keeps window.opener for OAuth/payment flows (refs #270) (58c819d)

## v0.110.1 — 2026-09-29

### Fixes

- Clone session only copies cookies — drops sameSite, storage, emulation and the current URL (refs #269) (7d7308c)

## v0.110.0 — 2026-09-29

### Features

- URL-bar lock icon popover with certificate details and a mixed-content count (refs #266) (9a85784)

## v0.109.0 — 2026-09-29

### Features

- per-tab network throttling presets, offline mode and CPU throttling (refs #265) (136dca1)

## v0.108.0 — 2026-09-28

### Features

- Test data — per-occurrence placeholder resolution, matching identities, and edge-case generators (refs #275) (244949c)

## v0.107.7 — 2026-09-28

### Fixes

- #262's "Load older events" e2e test raced its own flood and used an ambiguous selector (refs #262) (184b82a)

## v0.107.6 — 2026-09-28

### Fixes

- stale async result in refreshOlderEventsState could wrongly stop "Load older events" (refs #262), and a hardcoded export count in the #264 round-trip test (refs #264) (cc3799c)

## v0.107.5 — 2026-09-28

### Fixes

- "Load older events" fought the live poller, and a wrong DOM-position assertion (refs #262, refs #263) (2663c3f)

## v0.107.4 — 2026-09-28

### Fixes

- Export/Import buttons had no id, crashing the entire Mock panel init (refs #264) (4e01c94)

## v0.107.3 — 2026-09-28

### Other

- e2e coverage for Mock rule export/import and restart persistence (#264) (6e02793)

## v0.107.2 — 2026-09-28

### Fixes

- mock-delay a11y label, Load-older drop logic, and a test escaping bug (refs #263, refs #262); feat: Mock rules persistence + export/import (#264) (5942527)

## v0.107.1 — 2026-09-28

### Fixes

- redirect chain showed no status codes, and a flaky/slow Load-older e2e test (refs #261, refs #262) (481e26a)

## v0.107.0 — 2026-09-28

### Features

- Mock rules — per-rule response delay and explicit rule ordering (refs #263) (520d6c6)

## v0.106.1 — 2026-09-28

### Fixes

- redirect chain section locator strict-mode violation, and mock body timing (refs #261) (1735c56)

## v0.106.0 — 2026-09-28

### Features

- "Load older events" in the Console/Network timeline (refs #262) (d806bde)

## v0.105.6 — 2026-09-28

### Fixes

- e2e tests used .evt.network-response rows that are never rendered (refs #260, refs #261) (618b636)

## v0.105.5 — 2026-09-28

### Fixes

- detail panel — redirect hops collapse into one tab, missing POST bodies, no timing, stale tabs after session switch (refs #261) (40e3817)

## v0.105.4 — 2026-09-28

### Fixes

- recorder — capture Set-Cookie via ExtraInfo events and stop corrupting truncated binary bodies (refs #260) (b39a08c)

## v0.105.3 — 2026-09-28

### Fixes

- ELECTRON_SKIP_SINGLE_INSTANCE env var so the crash-log test can relaunch after SIGKILL (refs #257) (02a1bcc)

## v0.105.2 — 2026-09-28

### Fixes

- wait 1s after SIGKILL before relaunch — single-instance lock not released fast enough on Windows (refs #257) (7c38440)

## v0.105.1 — 2026-09-28

### Fixes

- pill-count opacity 0.85 still fails light-theme contrast check — remove it (refs #256) (ddb3a17)

## v0.105.0 — 2026-09-27

### Features

- optional "install updates automatically when idle" setting (refs #259) (5547f4d)

## v0.104.20 — 2026-09-27

### Fixes

- single-instance lock so a second launch focuses the running window instead of a false crash report (refs #257) (d6e6965)

## v0.104.19 — 2026-09-27

### Fixes

- accessibility of the chrome UI (aria labels/pressed/selected state) and a finished light theme (refs #256) (226d55f)

## v0.104.18 — 2026-09-26

### Fixes

- e2e — real races in diff.spec.ts's free-text setup helper and urlbar-display.spec.ts's slow-nav test (8086937)

## v0.104.17 — 2026-09-26

### Fixes

- e2e — wait for session URL to land before reading picker labels in followalong.spec.ts (c401e82)

## v0.104.16 — 2026-09-26

### Other

- one shortcut table for main + renderer, with a drift-detecting test (refs #254) (c6a2bb6)

## v0.104.15 — 2026-09-26

### Other

- migrate replay.js's cookie session picker onto session-picker.js (refs #254) (49d1d18)

## v0.104.14 — 2026-09-26

### Other

- consolidate mock/resilience/debuglog pollers into renderer/poll.js's pollWhileVisible (refs #254) (39c0d5a)

## v0.104.13 — 2026-09-26

### Other

- consolidate modal open/close/backdrop/Escape wiring into renderer/modal.js (refs #254) (9c21c2f)

## v0.104.12 — 2026-09-26

### Other

- consolidate showStatus/showFormStatus into shared renderer/status-msg.js (refs #254) (1b00fd3)

## v0.104.11 — 2026-09-26

### Other

- consolidate addKvRow/readKvTable into shared renderer/kv-table.js (refs #254) (9f2b049)

## v0.104.10 — 2026-09-26

### Fixes

- session notes are keyed per partition, so tabs sharing a partition overwrite each other's notes; no unsaved-changes guard (refs #268) (2037236)

## v0.104.9 — 2026-09-26

### Fixes

- Follow Along — overlapping relay ticks reorder mirrored steps; ambiguous session pickers; no shared-partition warning (refs #258) (9e48902)

## v0.104.8 — 2026-09-26

### Other

- fix flaky e2e patterns — wall-clock perf asserts, sleep-then-count, order-dependent tests (refs #253) (8cea8ee)

## v0.104.7 — 2026-09-26

### Other

- recorder and DebugLogStore — real SQLite in Jest, plus recorder body/redaction/trimming coverage (refs #252) (3d97623)

## v0.104.6 — 2026-09-26

### Other

- remove overlapping tests and merge launch-only specs into one smoke spec (refs #251) (2552293)

## v0.104.5 — 2026-09-26

### Fixes

- CI — drop e2e workers back to 1 per shard, concurrent electron.exe launches hit a Windows file lock (refs #249, #250) (947c5f2)

## v0.104.4 — 2026-09-26

### Other

- faster CI — npm cache, parallel check jobs, e2e not gated on bump-version, sharding, traces on failure (refs #250) (4dcbd07)

## v0.104.3 — 2026-09-26

### Fixes

- e2e — a remaining .last() staleness race in app.spec.ts's header-redaction test (refs #249) (2ad9f99)

## v0.104.2 — 2026-09-25

### Other

- speed up e2e — parallel workers and web-first waits instead of the 91 fixed waitForTimeout sleeps (refs #249) (e49e0bd)

## v0.104.1 — 2026-09-25

### Fixes

- settings — atomic JsonStore writes and live application of the header-redaction toggle (refs #248) (f41d732)

## v0.104.0 — 2026-09-25

### Features

- Downloads — stop forcing the panel open, show which session a download came from (refs #247) (b9ef1d8)

## v0.103.1 — 2026-09-25

### Fixes

- bug and crash report — wrong crash time, unredacted URLs in public issues, screenshot upload needs push access (refs #246) (adaccc2)

## v0.103.0 — 2026-09-25

### Features

- Jira — attach captured evidence (screenshot, HAR, console errors, recorded steps) to created bugs (refs #245) (e889759)

## v0.102.5 — 2026-09-25

### Fixes

- Jira — encrypt the API token and never send it to the renderer; safe error parsing; link, issue type and clickable key (refs #267) (50151e6)

## v0.102.4 — 2026-09-25

### Fixes

- Test data — reachable without a focused input, modal no longer renders behind the page (refs #244) (6cb3536)

## v0.102.3 — 2026-09-25

### Fixes

- restore snapshot storage before the page loads, guard export write, warn before exporting (refs #243) (1240671)

## v0.102.2 — 2026-09-25

### Fixes

- Record/Playback recording — wrong data-* selector attribute, literal "[hidden]" typed for passwords, checkboxes recorded as text fills (refs #242) (ad0f917)

## v0.102.1 — 2026-09-25

### Fixes

- Spoof/emulation — clearing a field is a no-op, failed CDP overrides still report as applied, per-tab not per-partition (refs #241) (0184592)

## v0.102.0 — 2026-09-25

### Features

- Security panel — header rules on document responses only, explain skipped cookie rules, truncation notice (refs #240) (a70e549)

## v0.101.8 — 2026-09-25

### Other

- fix real getTabPage ambiguity behind the "Path only" matching test's Windows CI failure (refs #237) (f342791)

## v0.101.7 — 2026-09-25

### Fixes

- real Windows CI failures — a11y highlight test race, diff host-matching test needs dual-stack fixture server (refs #237, #239) (1ae105e)

## v0.101.6 — 2026-09-25

### Other

- fix fall-through resilience test reading a stale hits badge instead of live state (refs #236) (11d5c6a)

## v0.101.5 — 2026-09-25

### Other

- fix storage filter leaking across e2e tests, breaking the failed-cookie-edit test (refs #234) (2e6504f)

## v0.101.4 — 2026-09-25

### Fixes

- A11y contrast checker — unescaped selectors, semi-transparent backgrounds, highlight clobbers page outline (refs #239) (d2f59dc)

## v0.101.3 — 2026-09-25

### Fixes

- UI diff — Compare hangs forever on a failed image load, no size-mismatch warning, pixel loop can freeze the app (refs #238) (29967a1)

## v0.101.2 — 2026-09-25

### Other

- fix fragile session-id lookups in the #237 diff e2e tests (93a0242)

## v0.101.1 — 2026-09-25

### Other

- fix nonexistent fixture paths in the 3-tabs-reopen-order e2e test (refs #231) (0c62ba4)

## v0.101.0 — 2026-09-25

### Features

- Network diff — host-agnostic matching for staging vs production, header/body comparison, truncation warning (refs #237) (1215171)

## v0.100.0 — 2026-09-25

### Features

- Resilience — real hanging requests, fall-through rule evaluation, no stale prefilled method (refs #236) (efea939)

## v0.99.1 — 2026-09-25

### Fixes

- Mock rules — prefilled encoding headers corrupt edited bodies, no default Content-Type/CORS, edits saved to the wrong tab (refs #235) (58eb86b)

## v0.99.0 — 2026-09-25

### Features

- Storage panel — debounce filter, full cookie editor, safe edit, sessionStorage/IndexedDB views (refs #234) (bf125d6)

## v0.98.5 — 2026-09-25

### Fixes

- Ctrl+Shift+T reopens a blank tab as example.com and loses pin/notes/emulation (refs #231) (1117268)

## v0.98.4 — 2026-09-25

### Fixes

- root-cause pin-persistence.spec.ts's getMainWindow race, not just its symptom (625b539)

## v0.98.3 — 2026-09-25

### Fixes

- correct e2e regressions surfaced by #232/#233's own CI run (c12486b)

## v0.98.2 — 2026-09-25

### Fixes

- Replay sends through the wrong session (no tab cookies or mocks) and sends literal [REDACTED] headers (refs #233) (161c560)

## v0.98.1 — 2026-09-25

### Fixes

- correct e2e test logic errors from #231's own test suite (e401edd)

## v0.98.0 — 2026-09-25

### Features

- real HAR 1.2 export from the Console tab, and Copy as cURL / fetch in the detail panel (refs #232) (7ddc97b)

## v0.97.1 — 2026-09-25

### Fixes

- Ctrl+Shift+T reopens a blank tab as example.com and loses pin/notes/emulation (refs #231) (8edde2c)

## v0.97.0 — 2026-09-25

### Features

- install updates silently with auto-relaunch while the app is open (refs #230) (9e62cce)

## v0.96.0 — 2026-09-24

### Features

- configurable recorder event cap and retention, with a notice when older events are evicted (refs #229) (c701eff)

## v0.95.1 — 2026-09-24

### Fixes

- give each crash-modal-app-log e2e test its own app instance (refs #226) (refs #227) (cf0c485)

## v0.95.0 — 2026-09-24

### Features

- structured app-log entries (source, session, context) with filters in the Debug log panel (refs #228) (db8530d)

## v0.94.0 — 2026-09-24

### Features

- lifecycle info breadcrumbs and triage of silent catch {} blocks in the main process (refs #227) (f4f13c8)

## v0.93.0 — 2026-09-24

### Features

- crash reporter and bug report include the app log tail, plus an "Open log folder" button (refs #226) (face992)

## v0.92.0 — 2026-09-24

### Features

- central app logger with a rotating plain-text main.log (refs #225) (1b4c7d7)

## v0.91.9 — 2026-09-24

### Fixes

- Resilience auto-refresh wipes in-progress rule edits; Record/Playback poll overwrites step edits and follows the wrong tab (refs #224) (775eda0)

## v0.91.8 — 2026-09-24

### Fixes

- Ctrl+W closes pinned tabs (refs #223) (42ad2d0)

## v0.91.7 — 2026-09-24

### Fixes

- A11y violations audit reports "No violations found" when axe fails or is missing (refs #222) (006a25a)

## v0.91.6 — 2026-09-24

### Fixes

- timeline silently drops events that share a millisecond (use an id cursor instead of ts) (refs #220) (80ed6c6)

## v0.91.5 — 2026-09-24

### Fixes

- tabs sharing a partition duplicate downloads and break loaded-domain tracking (refs #221) (e19470b)

## v0.91.4 — 2026-09-24

### Fixes

- wait for tab count before querying IDs in Ctrl+1/Ctrl+9 e2e test (flaky race on CI) (54f84e3)

## v0.91.3 — 2026-09-24

### Fixes

- mock/resilience rules never match URLs containing '?' (refs #219) (717ed9e)

## v0.91.2 — 2026-09-24

### Fixes

- escape rule text in Mock and Resilience rule rows (refs #218) (d887262)

## v0.91.1 — 2026-09-24

### Fixes

- stop tested websites from calling the new-tab page's privileged APIs (refs #217) (a093d12)

## v0.91.0 — 2026-09-23

### Features

- improve TesterBrowser's own app logging with levels and export (closes #213) (fca676a)

## v0.90.1 — 2026-09-23

### Fixes

- renew GitHub bug-reporter token via refresh token instead of forcing re-sign-in (#216) (4c84244)

## v0.90.0 — 2026-09-23

### Features

- persist TesterBrowser's own debug log to disk, capped by size/age (closes #214) (345f099)

## v0.89.1 — 2026-09-23

### Fixes

- click the visible toggle-slider instead of the hidden checkbox in debug-mode e2e test (ce69eca)

## v0.89.0 — 2026-09-23

### Features

- Settings toggle to view TesterBrowser's own internal debug logs (closes #212) (7ac259b)

## v0.88.6 — 2026-09-22

### Fixes

- correct #211's flake fix — root cause was app behavior, not CI timing (5166c2a)

## v0.88.5 — 2026-09-22

### Fixes

- flaky native double-click in tab-rename e2e tests (#211 follow-up) (c159c59)

## v0.88.4 — 2026-09-22

### Fixes

- tab bar crash when a re-render happens mid-rename (closes #211) (6003be0)

## v0.88.3 — 2026-09-22

### Other

- Bug report screenshot for #211 (96df37e)

## v0.88.2 — 2026-09-22

### Fixes

- flaky CI wait in urlbar-display e2e test (#207 follow-up) (100dc98)

## v0.88.1 — 2026-09-22

### Fixes

- resilience rules with broad non-wildcard URL patterns may still overload CDP Fetch (closes #210) (df52472)

## v0.88.0 — 2026-09-22

### Features

- scope mock and resilience rules to session partition, not per-tab id (closes #209) (b507bce)

## v0.87.3 — 2026-09-22

### Fixes

- crash log written after a hard crash has no recentErrors or sessionUrls (closes #208) (2fe264e)

## v0.87.2 — 2026-09-22

### Fixes

- URL bar shows the URL twice, slightly offset (closes #207) (b67fdd3)

## v0.87.1 — 2026-09-22

### Fixes

- crash report modal renders hidden behind the active tab view (closes #206) (40588f9)

## v0.87.0 — 2026-09-22

### Features

- send replay request to Mock or Resilience (closes #205) (b538c46)

## v0.86.10 — 2026-09-17

### Fixes

- focus order overlay badges scroll with the page (closes #204) (b56a8ec)
- skip mock auto-refresh while a rule is being edited (closes #203) (037311c)

## v0.86.9 — 2026-09-17

### Fixes

- validate GitHub token on settings open; auto-clear on 401 (closes #202) (3fd0174)

## v0.86.8 — 2026-09-17

### Fixes

- add separator between A11y view tabs and action buttons (refs #201) (3aefdd6)

## v0.86.7 — 2026-09-16

### Other

- Bug report screenshot for #204 (a219f2a)

## v0.86.6 — 2026-09-16

### Other

- Bug report screenshot for #203 (2347efc)

## v0.86.5 — 2026-09-16

### Other

- Bug report screenshot for #202 (9999d7f)

## v0.86.4 — 2026-09-16

### Other

- Bug report screenshot for #201 (f3a1a56)

## v0.86.3 — 2026-09-16

### Fixes

- track DevTools open state via events to fix F12 toggle flake (86a7131)

## v0.86.2 — 2026-09-16

### Fixes

- don't overwrite URL bar while user has it focused (fixes urlbar-search e2e flake) (d5a905b)

### Other

- retrigger CI after bump-version push conflict (1ee71ed)

## v0.86.1 — 2026-09-16

### Fixes

- prevent crash when resilience rule matches high-volume requests on busy sites (refs #199) (53d8fd2)

## v0.86.0 — 2026-09-16

### Features

- crash capture and reopen bug-report prompt with GitHub re-auth (closes #200) (3cbfece)

## v0.85.1 — 2026-09-16

### Fixes

- focus trap false cycle on pages with duplicate-selector elements, and shortcuts test race (a6b9760)

## v0.85.0 — 2026-09-16

### Features

- a11y tab — focus trap detector (closes #198) (2dc8fcf)

## v0.84.0 — 2026-09-16

### Features

- a11y tab — focus order overlay (closes #197) (12745c0)

## v0.83.0 — 2026-09-16

### Features

- a11y tab — image alt-text & form label audit (closes #196) (98e0a81)

## v0.82.0 — 2026-09-16

### Features

- a11y tab — heading & landmark outline (closes #195) (49dcd65)

## v0.81.1 — 2026-09-16

### Fixes

- axe-core violations audit returned nothing, ambiguous e2e body-row match (#193 follow-up) (ae68258)

## v0.81.0 — 2026-09-16

### Features

- a11y tab — color contrast checker (closes #194) (9db4d5f)

## v0.80.1 — 2026-09-16

### Fixes

- update e2e specs for the merged request/response row (#189 follow-up) (cab358a)

## v0.80.0 — 2026-09-16

### Features

- a11y tab — automated WCAG/ARIA violation audit via axe-core (closes #193) (bcdcdc7)

## v0.79.0 — 2026-09-16

### Features

- filter with a negative on the network tab (closes #192) (79d9774)

## v0.78.1 — 2026-09-16

### Fixes

- remove the 'from' and 'to' fields on the network tab filter (closes #191) (3c1e378)

## v0.78.0 — 2026-09-16

### Features

- filter on 'mock' and 'resilience' in pill form on the network tab (closes #190) (fe41833)

## v0.77.6 — 2026-09-16

### Fixes

- Every call is in the list twich. (closes #189) (60459a5)

## v0.77.5 — 2026-09-16

### Other

- Bug report screenshot for #192 (88761fe)

## v0.77.4 — 2026-09-16

_No changes recorded._

## v0.77.3 — 2026-09-16

### Other

- Bug report screenshot for #191 (c07acd0)
- Bug report screenshot for #190 (ae5783a)

## v0.77.2 — 2026-09-15

### Other

- Bug report screenshot for #189 (314c318)

## v0.77.1 — 2026-09-10

### Other

- Make session snapshot export/import more reliable, add best-effort React state capture (2f984f8)

## v0.77.0 — 2026-09-10

### Features

- replace manual GitHub token entry with OAuth device flow (49bfdec)

## v0.76.2 — 2026-09-09

### Fixes

- use the supplied logo everywhere — title bar mark and Windows app icon (#174, #171) (83e7145)

## v0.76.1 — 2026-09-09

### Fixes

- make the security "Configure checks" control a cog that toggles open and closed (#188) (66a2021)

## v0.76.0 — 2026-09-09

### Features

- per-severity master checkboxes with indeterminate state in the security check config (#187) (f2c1e48)

## v0.75.1 — 2026-09-09

### Fixes

- log mirrored navigations in the follow-along log (#186) (d124164)

## v0.75.0 — 2026-09-09

### Features

- show playback failure screenshots as click-to-enlarge thumbnails with a clear step error (closes #185) (1aba6f7)

## v0.74.0 — 2026-09-09

### Features

- turn the spoof user-agent presets into a dropdown and add more agents (closes #184) (2af1c3c)

## v0.73.0 — 2026-09-09

### Features

- give record/playback a wider, resizable saved-tests column next to Record new test (closes #183) (ff81ddf)

## v0.72.0 — 2026-09-09

### Features

- edit mock rules in place, and make a deactivated rule read as kept-but-unused (closes #182) (093ba30)

## v0.71.0 — 2026-09-09

### Features

- send a captured request to Resilience, scoped to its method (closes #181) (0f6f7a3)

## v0.70.0 — 2026-09-09

### Features

- carry request headers, response headers and response body into a mock created from a captured call (closes #180) (fd38ed5)

## v0.69.7 — 2026-09-09

### Other

- drop the per-row Replay button, move it into a Replay/Mock/Resilience detail-panel action row (closes #178, closes #179) (e4167d7)

## v0.69.6 — 2026-09-09

### Fixes

- clicking in the page should close the app menu and the View dropdown (closes #177) (0017f71)

## v0.69.5 — 2026-09-09

### Fixes

- default the Network Res and Err filter pills to off (closes #176) (9e06256)

## v0.69.4 — 2026-09-09

### Fixes

- show time only in timeline rows and drop the date (closes #175) (d1730e6)

## v0.69.3 — 2026-09-09

### Fixes

- overlay the app menu and View dropdown on the page instead of pushing the web view down (closes #173) (e281cea)

## v0.69.2 — 2026-09-09

### Fixes

- tab strip "+" button is unclickable — titlebar drag region swallows the click (closes #172) (e4c439d)

## v0.69.1 — 2026-09-08

### Fixes

- restore negative-term support in the console panel filter (refs #170) (6528c61)

## v0.69.0 — 2026-09-08

### Features

- move tabs onto the window-controls row and replace the wordmark with a logo (refs #169) (19dac36)

## v0.68.0 — 2026-09-08

### Features

- two-line timeline rows with hanging indent, replacing per-row horizontal scrollbars (refs #166) (26b528b)

## v0.67.0 — 2026-09-08

### Features

- add positive and negative free-text filtering to the network diff (refs #164) (1ff6e6b)

## v0.66.0 — 2026-09-08

### Features

- allow editing and deleting steps of a saved recorded test (refs #162) (2491404)

## v0.65.0 — 2026-09-08

### Features

- add per-session user-agent spoofing to the Spoof panel (refs #163) (efad56d)

## v0.64.1 — 2026-09-08

### Fixes

- persist and restore spoof overrides per session across tab switches and restarts (refs #161) (97fbf81)

## v0.64.0 — 2026-09-08

### Features

- replace absolute spoofed date/time with a signed clock offset (refs #167) (3a9f21d)

## v0.63.2 — 2026-09-08

### Other

- Add kanban ticket agents: groom, implement and watch-ci (#168) (0c47e9e)

## v0.63.1 — 2026-09-08

### Other

- Fix e2e checkout ref and two failing e2e specs (#165) (e6db2f7)

## v0.63.0 — 2026-09-08

### Features

- Add selector confidence indicator to Record Playback (closes #160) (babb69e)

## v0.62.2 — 2026-09-08

### Fixes

- Harden detail-panel Mock button e2e test against redraw race (closes #152) (afb4c39)

## v0.62.1 — 2026-09-08

### Fixes

- Harden urlbar-search e2e test against real-network flake (closes #150) (df6ed97)

## v0.62.0 — 2026-09-08

### Features

- Add step-by-step playback mode to Record Playback (closes #158) (2ac61d9)

## v0.61.1 — 2026-09-08

### Features

- Add per-session navigation history panel (closes #159) (d9740c6)
- Add request duration column to console/network timeline (closes #155) (3c89cb6)
- Add session export and import via File menu (closes #157) (839d48e)
- Add date/time spoofing alongside timezone, locale, and geolocation (closes #153) (5dc1226)

### Fixes

- remove unused getActiveId import in replay.js (f3f7fb6)
- Show date alongside time in timeline timestamps (closes #156) (1959096)
- Add missing icon to Follow Along tab (closes #154) (ccf0249)

### Other

- Temporarily remove HAR export from the Network tab (closes #152) (0ed0072)

## v0.61.0 — 2026-09-08

### Features

- Add negative free-text filter to console timeline (closes #151) (b0693e4)

## v0.60.3 — 2026-09-08

### Fixes

- replace remaining Record Playback alert()/prompt() with inline status; dedupe session-picker (closes #150) (ef55725)

## v0.60.2 — 2026-09-07

### Fixes

- capture chrome UI renderer errors for bug report diagnostics (closes #149) (d3f80b0)

## v0.60.1 — 2026-09-07

### Fixes

- give the urlbar-search e2e test more headroom on slow CI (ddf717f)

## v0.60.0 — 2026-09-07

### Features

- add default search engine (Google/DuckDuckGo) for the URL bar (closes #148) (88ce16e)

## v0.59.0 — 2026-09-07

### Features

- add Console level filter pills and smarter error-type coloring (closes #147) (765a93f)

## v0.58.1 — 2026-09-07

### Fixes

- give getMainWindow/getTabPage more headroom under slow CI (df8bb5b)

## v0.58.0 — 2026-09-07

### Features

- add "Clear log" button to Follow Along panel (closes #146) (8e700c1)

## v0.57.6 — 2026-09-07

### Fixes

- Run N× inline input, assert-attr field mismatch, and repeat-run state bleed (closes #145) (d28426f)

## v0.57.5 — 2026-09-07

### Fixes

- reduce timeline size before interacting, to stop a Windows CI flake in mock.spec.ts (597524c)

## v0.57.4 — 2026-09-07

### Features

- expand Security panel to ~28 rules with a Configure checks UI (closes #144) (603fbd9)
- add "Use current values" action to the Spoof panel (closes #143) (4e1c1cc)
- add reset, compare-time metadata, and category filter to Network diff (closes #142) (b7f4ff5)
- add method/duration/date-range filters to Network tab, broaden free-text search (closes #140) (ce7f115)

### Fixes

- lint error and a Windows CI flake introduced in recent commits (96658ca)
- long timeline entries scroll horizontally on one line instead of wrapping the whole panel (closes #141) (abfabae)
- Clear button on Network tab no longer lets cleared events reappear (closes #139) (617a909)
- permission notifications now push the BrowserView down instead of hiding under it (closes #138) (6100936)
- move "Mock" button to network detail panel and prefill status/body (closes #137) (f2196a8)

## v0.57.3 — 2026-09-07

### Fixes

- make the F3/Shift+F3 e2e test deterministic instead of CI-flaky (#135 follow-up) (601a42d)

## v0.57.2 — 2026-09-07

### Fixes

- closing the last tab opens a fresh New Tab page instead of leaving the window empty (closes #136) (e5a818e)

## v0.57.1 — 2026-09-07

### Other

- add e2e coverage for every keyboard shortcut; fix Ctrl+T crash (closes #135) (1995502)

## v0.57.0 — 2026-09-07

### Features

- reorganize UI diff toolbar into labeled Capture/View rows (closes #134) (e5255db)

## v0.56.0 — 2026-09-07

### Features

- submit bug report with Ctrl+Enter, close with Escape (closes #133) (fb73683)

## v0.55.0 — 2026-09-07

### Features

- edit existing resilience rules and jump to matching Network calls (closes #132) (aeb45e1)

## v0.54.0 — 2026-09-07

### Features

- add Send to Mock button on network request rows (closes #131) (2ab68c1)

## v0.53.1 — 2026-09-07

### Fixes

- show mock/resilience flag on the request event, not just the response (closes #130) (997d359)

## v0.53.0 — 2026-09-07

### Features

- show current session spoof state and unapplied edits (closes #129) (1396e12)

## v0.52.0 — 2026-09-07

### Features

- group duplicate calls and show cache hits in Network diff (closes #128) (3b293e5)

## v0.51.0 — 2026-09-07

### Features

- allow UI diff (VR) to compare screenshots across sessions (closes #127) (31093ac)

## v0.50.8 — 2026-09-07

### Fixes

- Follow Along only mirrors the first keystroke to the follower (closes #126) (78b78c9)

## v0.50.7 — 2026-09-07

### Other

- encapsulate renderer shared state per module (closes #125) (9c579a6)

## v0.50.6 — 2026-09-07

### Other

- dedupe escHtml across renderer modules (closes #124) (ca57875)

## v0.50.5 — 2026-09-06

### Other

- Fix sluggish tab switching and add chrome-side perf tests (4380b6a)

## v0.50.4 — 2026-09-06

### Other

- Isolate each e2e Electron launch with its own userData dir (e170f81)

## v0.50.3 — 2026-09-06

### Other

- Fix e2e failures caused by session accumulation across spec files (9e4172b)

## v0.50.2 — 2026-09-06

### Other

- Add real functional e2e coverage for Record Playback, Follow Along, A11y, and other console panels (321a54c)

## v0.50.1 — 2026-09-06

### Other

- Add test-pages/ fixtures for exercising TesterBrowser's own features (7893dbc)

## v0.50.0 — 2026-09-04

### Features

- surface Tests-playback/Follow-Along failures in bug-report diagnostics (closes #119) (cccb1f7)

## v0.49.15 — 2026-09-04

### Fixes

- tag mock/resilience hits under the correct network request id (closes #121) (c1e3d8c)

## v0.49.14 — 2026-09-04

_No changes recorded._

## v0.49.13 — 2026-09-04

### Fixes

- hide native spinner arrows on number inputs (closes #120) (d1b4151)
- repair syntax error in playback __wait helper breaking all mirrored steps (closes #118) (9b1a2b9)

## v0.49.12 — 2026-09-04

### Fixes

- move per-tab filter controls into their own panel (closes #103) (1626bfc)

## v0.49.11 — 2026-09-04

### Fixes

- persist tab order across restart (closes #102) (360f302)

## v0.49.10 — 2026-09-04

### Features

- add "Follow Along" — mirror clicks/fills live from a leader session to a follower (closes #116) (650a9a3)
- expand Settings Features pane with real per-feature descriptions (closes #113) (e3956d2)
- show response timing and render image bodies in network detail/replay (closes #110) (b360e26)

### Fixes

- resolve lint regressions blocking CI on main (closes #110) (8e0ef0c)
- unify titlebar theme toggle and Settings theme picker (closes #117) (fa188cb)
- A11y inspect click now refreshes tree and reports a true miss (closes #115) (3649dba)
- disabled A11y "Inspect element" button now looks disabled (closes #114) (d5969d1)
- capture bug-report screenshot before showing the modal, add retake/upload (closes #112) (89a8f0b)
- View/app menu dropdowns no longer blank out the whole page (closes #111) (3c330ab)
- network detail panel no longer leaves dead space when list narrows (closes #109) (a0e8667)

## v0.49.9 — 2026-09-04

_No changes recorded._

## v0.49.8 — 2026-09-04

_No changes recorded._

## v0.49.7 — 2026-09-04

### Fixes

- add field labels to resilience Add rule form (closes #108) (6e092d5)
- label console/network/storage filter controls (closes #107) (bbde955)
- keep same-session tabs grouped instead of scrambled (closes #106) (eee6959)
- titlebar maximize/restore button shows both icons at once (closes #105) (566daf1)

## v0.49.6 — 2026-09-04

### Fixes

- by default bugs should get the label 'status-ready' (closes #101) (f7cfdb0)

## v0.49.5 — 2026-09-03

### Fixes

- console/network timeline no longer sits empty for up to 1s after switching tabs (closes #86) (892faa3)

## v0.49.4 — 2026-09-03

### Fixes

- make bug report diagnostics editable and fix silent screenshot-attach failures (closes #85) (592576e)

## v0.49.3 — 2026-09-03

### Fixes

- app menu dropdown (Report Bug, Settings, New Temp Tab) hidden behind the web view (closes #84) (886bc73)

## v0.49.2 — 2026-09-03

### Fixes

- active tab gets a full border instead of just a top-edge color change (closes #75) (bfeb97a)

## v0.49.1 — 2026-09-03

### Fixes

- stop blocking quit with a confirmation for temporary tabs (closes #100) (c4e6398)

## v0.49.0 — 2026-09-03

### Features

- turn New Tab page into a dashboard with bookmarks and quick settings (closes #99) (3cbf334)

## v0.48.0 — 2026-09-03

### Features

- add bookmark folders and renaming for bookmarks/folders (closes #98) (6736259)

## v0.47.0 — 2026-09-03

### Features

- restructure settings modal into a sidebar/tabbed layout (closes #97) (16a24f9)

## v0.46.10 — 2026-09-03

### Fixes

- disable A11y Inspect element until the tree has loaded at least once (closes #96) (76840fa)

## v0.46.9 — 2026-09-03

### Fixes

- Downloads panel hidden behind web view, bookmark star silent no-op on blank URL (closes #95) (eb45f39)

## v0.46.8 — 2026-09-03

### Fixes

- minimized console panel stays visible instead of being covered by the web view (closes #94) (0382b6d)

## v0.46.7 — 2026-09-03

### Fixes

- Security findings not cleared when switching sessions or navigating (closes #93) (38c34d7)

## v0.46.6 — 2026-09-03

### Fixes

- UI diff baseline scoped per session instead of a single global variable (closes #92) (c8851ba)

## v0.46.5 — 2026-09-03

### Fixes

- Resilience panel doesn't refresh when switching sessions (closes #91) (17af814)

## v0.46.4 — 2026-09-03

### Fixes

- A11y tree not refreshed when switching sessions (closes #89) (7118af1)

## v0.46.3 — 2026-09-03

### Fixes

- detail panel resize handle stays hidden due to empty display value (closes #87) (584f7ce)

## v0.46.2 — 2026-09-03

### Fixes

- console panel minimize state and View ▾ toggle no longer disagree on panel height (closes #83) (0caac10)

## v0.46.1 — 2026-09-03

### Fixes

- Record Playback captures keystrokes live and survives navigation mid-recording (closes #82) (9cd9075)

## v0.46.0 — 2026-09-03

### Features

- tag Mock/Resilience-intercepted requests in the Network tab and show rule hit counts (closes #81) (4808f8c)

## v0.45.1 — 2026-09-03

### Fixes

- theme toggle button icon now reflects current mode (closes #80) (9e151c7)
- titlebar maximize button gets a clearer icon that swaps to a restore glyph (closes #79) (89319fa)

## v0.45.0 — 2026-09-03

### Features

- Security panel gets severity/text filtering and click-to-drilldown into findings (closes #78) (ebd8cee)

## v0.44.1 — 2026-09-03

### Other

- rename console-panel tabs: Diff → Network diff, VR → UI diff, Tests → Record Playback (closes #77) (168e0fe)

## v0.44.0 — 2026-09-03

### Features

- A11y tab explicit "Inspect element" toggle instead of always-on hover (closes #76) (14e5bd9)

## v0.43.2 — 2026-09-03

### Fixes

- restored tabs keep their original session color (closes #74) (3d60f82)

## v0.43.1 — 2026-09-03

### Fixes

- new tabs default to persistent, warn before discarding ephemeral ones (closes #73) (c6124fd)

## v0.43.0 — 2026-09-03

### Features

- separate session color from tab selection state (closes #72) (e7472b7)

## v0.42.1 — 2026-09-03

### Fixes

- light mode now themes every panel and the new tab page (closes #71) (43076b0)

## v0.42.0 — 2026-09-03

### Features

- numbered guide and two-column layout for resilience tab (closes #70) (77472d4)

## v0.41.0 — 2026-09-03

### Features

- full-page capture and single-image views for visual regression (closes #69) (cefdbb0)

## v0.40.6 — 2026-09-03

### Fixes

- console tab shows network filter controls on startup (closes #68) (7d0ab25)

## v0.40.5 — 2026-09-03

### Fixes

- network tab request detail view stays hidden until switching tabs (closes #67) (cac4ba6)

## v0.40.4 — 2026-09-03

### Fixes

- tests tab recording always alerts "No active session" (closes #66) (e42d946)

## v0.40.3 — 2026-09-03

### Fixes

- security scan always reports no issues (closes #65) (a2aa5ea)

## v0.40.2 — 2026-09-03

### Fixes

- help menu is unavailable (closes #64) (bcfd7f3)

## v0.40.1 — 2026-09-03

### Fixes

- stop update download from proceeding on non-newer version (closes #51) (582eeec)

## v0.40.0 — 2026-09-03

### Features

- modal polish — close buttons, open animation, naming (closes #59) (210922a)

## v0.39.1 — 2026-09-03

### Fixes

- console panel tab icons and overflow navigation (closes #54) (9327cbe)

## v0.39.0 — 2026-09-03

### Features

- URL bar security and protocol indicator (closes #57) (b85d886)

## v0.38.0 — 2026-09-03

### Features

- session color as active orientation system (closes #55) (8b7cf2e)

## v0.37.0 — 2026-09-03

### Features

- console panel tab icons and overflow navigation (closes #54) (2d3d0f6)

## v0.36.0 — 2026-09-03

### Features

- in-app bug reporter — log Testerbrowser bugs to the GitHub project board (closes #53) (921dd3e)

## v0.35.4 — 2026-09-03

### Fixes

- resolve e2e title flake from wrong-window race in Electron launch (f74f35b)

## v0.35.3 — 2026-09-03

### Other

- ignore Playwright test-results and report directories (b32af20)

## v0.35.2 — 2026-09-03

### Fixes

- remove duplicate a11y:setInspect IPC handler crashing startup (closes #63) (ed36fae)

## v0.35.1 — 2026-09-03

### Fixes

- treat older release found while scanning for latest.yml as up to date (closes #61) (9eec154)

## v0.35.0 — 2026-09-03

### Features

- interaction detail refinements (closes #60) (21946a6)

## v0.34.0 — 2026-09-03

### Features

- empty states for console and feature panels (closes #58) (8dd9072)

## v0.33.0 — 2026-09-03

### Features

- active tab visual hierarchy (closes #56) (22091fb)

## v0.32.0 — 2026-09-02

### Features

- record playback — add assertion UI and styles (closes #42) (4570980)

## v0.31.0 — 2026-09-02

### Features

- a11y hover functionality (closes #46) (7cc077f)

## v0.30.0 — 2026-09-02

### Features

- make response window width adjustable (closes #45) (601fd3a)

## v0.29.4 — 2026-09-02

### Fixes

- replay buttons not visible in Console tab (closes #50) (c568a8c)

### Other

- resolve merge conflicts from concurrent session manager changes (f15517f)

## v0.29.3 — 2026-09-02

### Fixes

- resilliance rules UX — add guidance text (closes #50) (746ae9e)

## v0.29.2 — 2026-09-02

### Fixes

- skip download when already on current version (closes #51) (b300c50)

## v0.29.1 — 2026-09-02

### Fixes

- call initRecordPlayback in main init sequence and fix settings.json (2cb5bed)
- compare functionality doesn't do anything (closes #49) (7e2ef71)
- resizing console panel height (closes #48) (b65c5b8)
- Diff session selection (closes #47) (e2b10c1)
- storage tab scrollable after recording panel added (closes #42) (a40ed6f)

## v0.29.0 — 2026-09-02

### Features

- separate network and console panels (closes #52) (d6bc3f4)

### Other

- document features in README and add help panel to settings (closes #44) (88ac219)

## v0.28.1 — 2026-09-02

### Fixes

- remove accidental #42 code from #41 commit, keep only window frame changes (c992577)

## v0.28.0 — 2026-09-02

### Features

- record playback (closes #42) (da14120)
- sleaker look and light/dark mode (closes #41) (c820b72)

## v0.27.1 — 2026-09-02

### Fixes

- add resilience mode e2e tests and verify startup safety (closes #37) (a31fa7c)

## v0.27.0 — 2026-09-02

### Features

- jira integration mode (closes #38) (ac8aca7)

## v0.26.0 — 2026-09-02

### Features

- resilliance mode (closes #37) (b351899)

## v0.25.3 — 2026-09-02

### Fixes

- latest version not found (closes #43) (0a976be)

## v0.25.2 — 2026-09-02

### Fixes

- correct tab bar selector in snapshot e2e test (ee2cd8b)
- correct element IDs in diff e2e tests (closes #28) (056f899)

## v0.25.1 — 2026-09-01

### Other

- always on logger (closes #40) (14061e5)

## v0.25.0 — 2026-09-01

### Features

- network request/response mocking UI (closes #27) (9cec471)
- security indicators (closes #39) (ce6ee14)
- test data generators injectable into forms (closes #29) (04f2dd7)
- session snapshot (closes #35) (b9aff42)

### Other

- kill the linux builds (closes #34) (54f4212)

## v0.24.0 — 2026-09-01

### Features

- environment diffing (closes #28) (2a9c3d5)

## v0.23.0 — 2026-09-01

### Features

- minimize bottom panel (closes #33) (8566798)
- visual regression panel (closes #25) (e21df49)

### Fixes

- scrollbar in always-available console (closes #32) (f089a1e)

## v0.22.0 — 2026-09-01

### Features

- time and space travel (closes #36) (4ccb07b)

## v0.21.1 — 2026-09-01

### Features

- session snapshot export/import (closes #35) (55f8264)
- visual regression panel (closes #25) (8ee7c02)
- minimize bottom panel with persisted state (closes #33) (c5c6885)
- test data generators injectable into forms (closes #29) (9edede9)
- environment diffing — compare timelines across two sessions (closes #28) (05bb901)

### Fixes

- remove unused state import in diff.js (lint) (28d9d99)
- scrollbar in always-available console (closes #32) (8e3b0b7)

### Other

- kill linux builds (closes #34) (cafa50c)

## v0.21.0 — 2026-09-01

### Features

- accessibility tree panel (closes #26) (a0e1578)

## v0.20.10 — 2026-09-01

### Fixes

- truncate update error message shown in settings UI (closes #1) (fe692dc)

## v0.20.9 — 2026-09-01

### Other

- deliberate e2e break for CI failure testing (83e807a)

## v0.20.8 — 2026-09-01

### Fixes

- correct Windows code-signing CI integration (65362e6)

## v0.20.7 — 2026-09-01

### Other

- add ESLint for renderer JS modules (closes #31) (ee3d28e)

## v0.20.6 — 2026-09-01

### Other

- code signing for Windows installer (closes #30) (cc30827)

## v0.20.5 — 2026-09-01

### Fixes

- graceful update failure with draft releases and error log (closes #1) (7abeae3)

### Other

- update kanban spec with correct Status option IDs (6de3ef9)
- add kanban workflow design spec and board setup plan (f39828c)

## v0.20.4 — 2026-09-01

### Fixes

- **e2e:** increase expect timeout and wait for load state to fix flaky test 1 (cac1d35)

## v0.20.3 — 2026-09-01

### Other

- **e2e:** extract activeSession helper, harden URL-match (5228530)

## v0.20.2 — 2026-09-01

### Fixes

- **e2e:** fix test 15 session identity mismatch in localStorage add (234f207)

## v0.20.1 — 2026-09-01

### Fixes

- **e2e:** fix tests 14 and 16 session identity mismatch (8ecf2ae)

## v0.20.0 — 2026-09-01

### Features

- add new-tab-in-session button; fix e2e storage tests; ci on all branches (41ab24a)

## v0.19.1 — 2026-08-27

### Features

- retain selected session in replay picker; add Ctrl+scroll zoom (9115c06)

### Other

- split renderer into ES modules; extract DownloadManager/PermissionManager (ee1cff1)

## v0.19.0 — 2026-08-27

### Features

- editable cookies and localStorage in Storage tab, with e2e tests (9481b42)

## v0.18.0 — 2026-08-27

### Features

- **e2e:** add replay cookie picker tests + fix domain filtering for IP cookies (6ad78ad)

## v0.17.8 — 2026-08-27

### Other

- add e2e tests for replay overlay and cookie session picker (c36242d)

## v0.17.7 — 2026-08-27

### Other

- upgrade GitHub Actions to v7 (Node.js 24) (53ed8a6)

## v0.17.6 — 2026-08-27

### Fixes

- prevent bump-version push rejection on concurrent pushes (ccf6b6a)

## v0.17.5 — 2026-08-26

### Other

- restore Actions to v4 (v5 tags don't exist yet) (131998a)
- bump GitHub Actions to v5 (Node.js 24) (32cdab2)

## v0.17.4 — 2026-08-26

### Fixes

- filter session cookies by request domain in replay modal (2af97af)

## v0.17.3 — 2026-08-26

### Fixes

- **e2e:** use toHaveTitle for polling assertion, drop silent retries (3881ebd)

## v0.17.2 — 2026-08-26

### Other

- add Jest unit tests and Playwright e2e suite (954966c)

## v0.17.1 — 2026-08-26

### Fixes

- show all session cookies in replay picker, not just domain-matched ones (b14d70b)

## v0.17.0 — 2026-08-26

### Features

- domain filter on by default, storage refreshes on navigate (1f8fbcc)

## v0.16.0 — 2026-08-26

### Features

- distinguish 1st-party vs 3rd-party cookies in Storage tab (b0e1730)

## v0.15.0 — 2026-08-25

### Features

- add session cookie picker to replay modal (a920e4b)

## v0.14.0 — 2026-08-25

### Features

- redesign replay modal with larger two-column layout and editable tables (b80b0cf)

## v0.13.1 — 2026-08-25

### Fixes

- webview overlay on popups, detail panel shows request+response, boot layout sync (6a39fd4)

## v0.13.0 — 2026-08-25

### Features

- header redaction setting, request detail panel with tabs, 30-day recording cleanup (ff8c9cc)

## v0.12.4 — 2026-08-25

### Fixes

- **ci:** read package.json via fs not require in node shell script (b3aca6f)

## v0.12.3 — 2026-08-25

### Fixes

- **ci:** generate latest.yml manually, rename exe artifacts before upload (7ecfdaa)

## v0.12.2 — 2026-08-25

### Fixes

- use npx electron-builder so PATH includes node_modules/.bin on Windows (d73a89b)

## v0.12.1 — 2026-08-25

### Fixes

- replace electron-builder publish with gh release upload to fix missing latest.yml (f110fd7)

## v0.12.0 — 2026-08-25

### Features

- flesh out console and storage panels (16da1a6)

## v0.11.4 — 2026-08-24

### Fixes

- push version tag in bump-version job so GitHub release can be created (94434ef)

## v0.11.3 — 2026-08-24

### Fixes

- repair CI native build after Electron 43 upgrade (5a828c8)

### Other

- upgrade to Electron 43, electron-builder 26, better-sqlite3 13 (1bc6b69)

## v0.11.1 — 2026-08-24

### Fixes

- harden security before public release (9532911)

## v0.11.0 — 2026-08-24

### Features

- Speed Dial new-tab homepage (Opera-style) (0e22ce0)

## v0.10.2 — 2026-08-24

### Other

- add project claude settings (a089755)

## v0.10.1 — 2026-08-24

### Other

- scaffolding, guardrails, and knowledge base (cd98eef)

## v0.10.0 — 2026-08-24

### Features

- console Storage tab, View dropdown, UI polish (0551595)

## v0.9.1 — 2026-08-24

### Features

- stability and completeness pass (1aaa835)

### Fixes

- regenerate package-lock.json with electron-rebuild entries (6de650c)
- update package-lock.json to include electron-rebuild (869bfbc)

### Other

- accept remote lock file before regenerating (710680d)

## v0.8.0 — 2026-08-21

### Features

- add core browser features - loading indicator, downloads, bookmarks, permissions, context menu, zoom display, tab switching (76c6016)

## v0.7.0 — 2026-08-19

### Features

- major QOL update - nav buttons, find bar, devtools, zoom, console filter, notes, session restore (6cd32d1)

## v0.6.0 — 2026-08-19

### Features

- drag-and-drop tab reordering, remove text selection on tab names (1578399)

## v0.5.0 — 2026-08-19

### Features

- new tabs open next to the active tab instead of at the end (001a13c)

## v0.4.1 — 2026-08-19

### Fixes

- delay tab single-click so dblclick can cancel it before DOM is rebuilt (f4d96fe)

## v0.4.0 — 2026-08-19

### Features

- tab rename (dblclick) and popup interception (window.open opens new tab sharing session) (a816cb7)

## v0.3.2 — 2026-08-19

### Fixes

- build-linux now waits for build-windows to prevent latest.yml race condition (dbaba14)

## v0.3.1 — 2026-08-19

### Fixes

- use exclusive timestamp filter in timeline query to stop last events repeating (f44aaf8)

## v0.3.0 — 2026-08-19

### Features

- fix layout - console/dialog no longer hidden by BrowserView, add tab close, resizable panels (526bdb7)

## v0.2.1 — 2026-08-19

### Fixes

- allow prerelease in auto-updater so electron-updater finds pre-release GitHub releases (1fc8cbb)

## v0.2.0 — 2026-08-19

### Features

- settings page in Help menu with version and update status (8247d8b)

## v0.1.1 — 2026-08-19

### Features

- Ctrl+Tab / Ctrl+Shift+Tab cycle tabs in MRU order (1dc46d2)

### Fixes

- use github.actor check to prevent infinite version bump loop (b9bb38e)

### Other

- auto-bump version on every push + add CLAUDE.md (1cfd9cc)

## v0.1.0 — 2026-08-19

### Features

- add auto-update on startup via electron-updater (9a2eb0e)

### Fixes

- publish releases immediately so electron-updater can find them (c553c43)
- new tab creation and URL bar navigation (2a6763c)
- use npm scripts for dist so node_modules/.bin is on PATH (f1787b7)
- pass --publish never to electron-builder in CI (ab5b3cc)

### Other

- auto-publish rolling 'latest' release on every push to main (5fb48e1)
- Initial scaffold: isolated sessions + always-on CDP recording (02f3283)
