# Handoff: TesterBrowser UI redesign

## Overview
A full visual and structural refresh of the TesterBrowser renderer (`renderer/`). Goals, in the product owner's words: friendly enough that first-time users aren't scared off, while power users can still reach every feature. Concretely:
- Clear visual hierarchy (weight, size, colour) instead of uniform 11–12px monospace.
- The 14 console-panel tabs become one grouped, sentence-case tab strip with Lucide icons. The panel collapses down to **just the tab strip**.
- Long explanatory copy is replaced by self-explanatory UI and empty states with one call to action.
- Every tool panel gets a consistent toolbar row (search → filter chips/segmented control → spacer → summary → actions).
- Light and dark themes are both first-class.

## About the design files
Files in `prototype/` are **design references built in HTML** — they show intended look and behaviour; they are not code to paste. Recreate them inside the existing renderer: vanilla JS modules + `renderer/style.css`, under the page CSP (`style-src 'self'`, no `'unsafe-inline'`). **All styling must live in `style.css`** — the prototypes use inline styles only because of the tool they were made in.

Open `prototype/TesterBrowser Redesign.dc.html` in a browser (keep `support.js` and `renderer/` next to it). Everything is clickable: browser tabs (the third is "New tab" → Speed Dial), every tool tab, network rows, detail tabs, filter chips, rule toggles, "New rule"/"Add rule" forms, "Start recording", the ⋯ button (opens Settings) and the theme toggle in the title bar. `prototype/Current UI.dc.html` is a recreation of today's Network view for comparison.

## Fidelity
**High fidelity.** Colours, type sizes, spacing, radii and copy are final. Match them; deviate only where the native page view or CSP forces it.

## Global rules
- **Keep every existing element ID and the `.active` class contract.** e2e specs click `#consoleTabNetwork`, `#consoleTabA11y`, etc. and assert `toHaveClass(/active/)`. Restyle; don't rename.
- **Fonts and icons are vendored**, never loaded from a CDN: Lucide icon font (`lucide-static`, MIT) and JetBrains Mono (OFL) under `renderer/vendor/`. The CSP needs `font-src 'self'` added (today `default-src 'none'` blocks fonts).
- Theme tokens: `tokens.css` in this folder replaces the token blocks at the top of `style.css`. Legacy variable names are re-pointed so un-migrated panels follow the new palette immediately.
- Sentence case everywhere (no `text-transform: uppercase` on tabs, labels or section titles).
- Monospace (`--tb-font-mono`) is only for data: URLs, paths, header names/values, status codes, methods, timings, sizes, selectors, cookie names/values, log lines. All UI chrome uses `--tb-font-ui`.
- Icons are Lucide glyphs at 13–17px, colour `--tb-text-2` unless stated.

## Design tokens
See `tokens.css` for exact values (dark default, `body.light-mode` overrides).

**Type scale** (`--tb-font-ui`):
| Use | Size | Weight |
|---|---|---|
| Modal / empty-state title, detail title | 15px | 600 |
| Ticket summary (Jira) | 17px | 600 |
| Body, buttons, tabs, rows | 13px / 12.5px | 400; 500 for emphasis; 600 for active tab/selected nav |
| Secondary, chips, table headers | 12px / 11.5px | 400 |
| Tags and badges | 10.5px | 600 |
| Big stat (UI diff %) | 26px | 600 |
Monospace data is 12–12.5px (rows), 11.5px (secondary data, timings).

**Spacing:** 4px base. Common values: 2, 4, 6, 8, 10, 12, 14, 16, 18, 24px. Panel content padding 14–16px; toolbar row padding `0 12px 0 14px`; table cell gap 12px.

**Radii:** tags 4px · icon buttons 6px · buttons/inputs 7px · URL bar & segmented track 8px · cards/forms/rule tables 10px · modal 14px · chips pill (13px on 26px height).

**Control heights:** chips 26px · buttons/inputs 28px (forms 30px) · segmented items 22px inside a 2px-padded track · icon buttons 28–30px · table rows 30px (network) / 32px (storage) / 42–44px (rule tables) · toggles 30×18 (tables) or 34×20 (settings), knob 14px white.

**Shared patterns**
- *Chip (toggle filter):* off = transparent bg, 1px `--tb-line`, `--tb-text-2`; on = bg and border `--tb-text`, text `--tb-surface`. Optional count in mono 11px at 75% opacity.
- *Pick chip (single choice, e.g. presets):* on = bg `--tb-accent-soft`, border and text `--tb-accent`.
- *Segmented control:* track bg `--tb-sunken`, 1px `--tb-line`, radius 8, padding 2; selected item bg `--tb-surface`, `box-shadow: 0 1px 2px rgba(0,0,0,.12)`, text `--tb-text`.
- *Primary button:* bg `--tb-accent`, text `--tb-on-accent` (white in light, near-black #101318 in dark), 500. Same ink on `--tb-err` fills (Start recording). *Strong neutral button:* bg `--tb-text`, text `--tb-surface` (Replay, Inspect element, Stop and save, Open request). *Outline button:* 1px `--tb-line-strong` (detail actions) or `--tb-line` (toolbar actions).
- *Selected row:* bg `--tb-accent-soft` + `box-shadow: inset 2px 0 0 var(--tb-accent)`. Hover row: `--tb-hover`.
- *Status colour:* ≥400 `--tb-err` (weight 600), 3xx `--tb-warn`, else `--tb-ok`; preceded by a 6px dot of the same colour.
- *Tag:* 10.5px/600, padding 1px 6px, radius 4. Mocked = accent-soft/accent; Resilience = warn-soft/warn; 1st-party = accent-soft/accent; 3rd-party = sunken/text-3.
- *Empty state:* centred column, gap 12: 44px rounded-12 icon tile (tinted bg + icon 20px) → 15px/600 title → one 13px `--tb-text-2` sentence (max-width 360–380px) → one 32px button. **No other explanatory text.**
- *Section card:* 1px `--tb-line`, radius 10, padding 14, header row = icon 15px + 13px/600 title + right-aligned 12px `--tb-text-3` "Reset".

## Screens

### 1. Window chrome
**Title bar** (40px, bg `--tb-chrome`, no bottom border): app logo 18px high at left (10px inset, 10px gap) → browser tabs → "+" (28px square, radius 6) → drag spacer → theme toggle (moon in light, sun in dark) + minimise / maximise / close, each 44px wide.
**Browser tab:** 196px wide, 34px high, top radius 8, aligned to the bottom of the bar. Contents: 8px session-colour dot, name (13px; active 600 `--tb-text`, inactive 400 `--tb-text-2`), close ✕ 13px `--tb-text-3`. Active tab bg `--tb-surface` (merges into the toolbar); inactive transparent. **The thick coloured bottom border and 3-side outline are removed**: session colour lives only in the dot and the URL-bar chip.
**Toolbar** (46px, bg `--tb-surface`, 1px bottom `--tb-line`, padding 0 10px, gap 4): back / forward / reload (30px icon buttons, 16px icons; disabled at 50% opacity) → URL bar → star, downloads, bug (Report bug), ⋯ (menu; contains the current View ▾ items and Settings).
**URL bar:** flex 1, 32px high, margin 0 8px, bg `--tb-sunken`, 1px `--tb-line`, radius 8, padding 0 6 0 12. Lock icon 13px (secure `--tb-ok` `icon-lock`; insecure `--tb-err` `icon-lock-open`; new tab `icon-search` `--tb-text-3`). URL text 13.5px: scheme `--tb-text-3`, host `--tb-text` 500, path `--tb-text-2`. At the right, a session chip: 22px high, bg `--tb-surface`, 1px `--tb-line`, radius 5, 11.5px `--tb-text-2`, 7px dot + "Session 1 · Persistent" / "· In-memory".
**Removed:** the 2px session-colour border under the toolbar, the separate zoom readout at 100% (show it only when zoom ≠ 100%), the "View ▾" text button and the DevTools gear (F12 still works and stays in the menu).

### 2. Tool panel shell
Bottom-docked, full width, bg `--tb-surface`, 1px top `--tb-line`, default height 470px, 5px resize grip on the top edge.
**Tab strip** (38px, padding 0 4, 1px bottom `--tb-line`). Groups are separated by a 1px `--tb-line` left border; 3px padding per group:
| Group | Tabs (label · Lucide icon · existing ID) |
|---|---|
| Inspect | Network `globe` `#consoleTabNetwork` · Console `terminal` `#consoleTabConsole` · Storage `database` `#consoleTabStorage` · A11y `accessibility` `#consoleTabA11y` · Security `shield-check` `#consoleTabSecurity` |
| Compare | Network diff `git-compare` `#consoleTabDiff` · UI diff `scan-eye` `#consoleTabVR` |
| Simulate | Mock `replace` `#consoleTabMock` · Resilience `zap-off` `#consoleTabResilience` · Spoof `map-pin` `#consoleTabSpoof` |
| Automate | Record `circle-dot` `#consoleTabTests` · Follow `users` `#consoleTabFollow` |
| Connect | Jira `ticket` `#consoleTabJira` · Debug log `scroll-text` `#consoleTabDebugLog` |
Tab: padding 0 8, gap 6, 12.5px, icon 14px. Inactive `--tb-text-2` 400 (hover `--tb-text`); active `--tb-text` 600 with a 2px `--tb-accent` bottom border. Optional count badge after the label: 16px pill, 10.5px/600 — Console = error count (err-soft/err); A11y = issue count and Security = finding count (warn-soft/warn). Hidden when 0. Far right: collapse chevron (34px wide; `chevron-down` when open, `chevron-up` when collapsed).
**Collapsed state:** the panel shrinks to exactly the tab strip (39px including the border). No active underline is shown while collapsed. Clicking any tab expands the panel and selects that tab; clicking the chevron toggles.
**Toolbar row** (44px, padding 0 12 0 14, gap 8, 1px bottom `--tb-line`), described per tool below. Hidden when collapsed. The old `?` help button and in-panel explanation blocks are removed.

### 3. Network
Toolbar: search (280×28, bg sunken, `search` icon, placeholder "Filter URL, header or body") · chips **Errors n**, **Mocked n**, **Resilience n** · "Method: Any ▾" chip (dropdown: GET POST PUT DELETE PATCH Other, multi-select) · "More filters" chip with `sliders-horizontal` (popover: Min duration ms, From, To) · spacer · summary mono 11.5 `--tb-text-3` "12 requests · 739 kB · 2.71 s" · "Export HAR" outline button (`file-down`) · clear icon button (`ban`).
Table: header row 28px bg sunken, 11.5px `--tb-text-3`; grid `64px 52px minmax(0,1fr) 78px 64px 64px`, gap 12, padding 0 14. Columns: Status (dot + mono code) · Method (mono 11.5 `--tb-text-2`) · Name (path 12.5px 500 `--tb-text`, then host 11.5px `--tb-text-3`, both ellipsised, then an optional Mocked/Resilience tag) · Type (12px `--tb-text-3`) · Size (right, mono) · Time (right, mono; >1 s in `--tb-warn`, formatted "2.00 s", otherwise "315 ms"). Rows 30px. **One row per request** (request and response merged); a response body is not its own row.
Detail pane (right, 480px, 1px left `--tb-line`): header block (padding 14 16 12, gap 10): status pill ("500 Internal Server Error", 12px/600, radius 5, err-soft/err or ok-soft/ok) + mono meta "315 ms · 1.7 kB · document"; URL in mono 12.5px (method in `--tb-text-3`); actions **Replay** (strong neutral, `rotate-ccw`), **Mock** (outline, `replace`), **Resilience** (outline, `zap-off`), **Copy as cURL** (outline, `copy`). Then a tab row (36px): Headers (count) · Response · Timing · Cookies (count). Headers tab: collapsible groups "Response headers" / "Request headers" (12px/600 + count), key/value grid `150px 1fr`, mono 11.5, keys `--tb-text-3`. Response tab: pretty-printed body, mono 11.5 / line-height 1.6. Timing tab: rows Queued / DNS lookup / Connection / Waiting (TTFB) / Download with 8px bars (TTFB bar accent, others `--tb-text-3`) and ms values. Empty Cookies tab: one centred line "No cookies were sent or set by this request."

### 4. Console
Toolbar: search "Filter messages" · segmented **All 7 · Errors 2 · Warnings 2 · Info 2 · Debug 1** (Errors count in `--tb-err`) · spacer · clear. Rows: grid `16px 1fr auto 64px`, padding 7 16, 1px bottom line. Level icon 14px (error `circle-x` err; warn `triangle-alert` warn; info `info` accent; log `chevron-right` text-3; debug `bug` text-3). Message mono 12 / 1.5 (error text in err, debug in text-3). Source link 12px accent (e.g. `jquery-1.11.3.min.js:4`). Time mono 11 text-3. Row bg: error = err-soft, warn = warn-soft.

### 5. Storage
Toolbar: search "Filter name or value" · "Current domain" chip (on by default) · "Auto-refresh" chip (`refresh-cw`) · spacer · "Add" (`plus`) · "Clear all" (`trash-2`, text err). Left nav (200px, bg sunken, padding 8): Cookies `cookie` · Local storage `hard-drive` · Session storage `timer` · IndexedDB `database`, each with a mono count; selected item bg surface, 600. Cookies table grid `170px 1fr 190px 40px 96px 200px`: Name (mono 500) · Value (mono text-2, ellipsis) · Domain (+ 1st/3rd tag) · Path · Expires · Flags (outline tags: HttpOnly, Secure, Lax/Strict/None). Third-party rows when "Current domain" is on: 60% opacity. Local/Session storage: grid `260px 1fr 60px` Key · Value · Size. IndexedDB: expandable tree database → object stores with record counts, footnote "IndexedDB is read-only." Keep inline edit (double-click) and click-to-copy.

### 6. A11y
Toolbar: **Inspect element** (strong neutral, `mouse-pointer-2`) · search "Find role or name" · issues chip "2 issues" (warn-soft/warn, `triangle-alert`) · spacer · "142 nodes · updated on navigation" · refresh. Tree: 28px rows, indent 14px + 18px per depth, caret, role in mono accent, name in quotes 12.5px, optional issue tag (warn). Right pane 400px: role + name title; property grid `120px 1fr` (Name from, Level, Focusable, Hidden, Selector); "Issues on this page" cards (`triangle-alert` warn, title 12.5/500, selector mono 11.5 text-3, impact text-3 right).

### 7. Security
Toolbar: segmented **All 6 · High 1 · Medium 2 · Low 3** (each with a 6px severity dot) · spacer · "Scanned 12 requests · 21:01:18" · "Scan again". List rows (padding 10 16): severity (dot + 12px/600 label; High err, Medium warn, Low text-3) · title 13/500 + target mono 11.5 text-3 · category right. Detail pane 460px: severity pill + category · title 15/600 · one-sentence "why" in 13px text-2 · "Evidence" mono block (bg sunken, radius 8) · **Open request** (strong neutral; jumps to Network with that row selected) · **Report to Jira** (outline).

### 8. Network diff
Toolbar: Session A picker ("A ● Session 1 · staging ▾") · `arrow-left-right` · Session B picker · segmented **Match full URL / Match path** · spacer · "Export JSON" · **Compare** (primary). Filter chips row (padding 10 14): Different n · Only in A n · Only in B n · Same n, each with a 7px square colour key (warn / err / ok / text-3). Table grid `1fr 56px 64px 72px 64px 72px 72px 140px`: Path · Method · A status · A time · B status · B time · Δ time (>200 ms in warn) · Result tag (Same = sunken/text-3; "Same · ≠ body" = accent; Different status = warn; Only in A = err; Only in B = ok). Detail pane 420px for the selected row: "GET /api/flags", "Response body · 2 lines differ", unified line diff (removed lines err-soft/err with "-", added ok-soft/ok with "+"), then "Headers · 1 differs" as a 3-column grid name / A / B. Keep the existing >5,000-event warning banner.

### 9. UI diff
Toolbar: segmented **Baseline / Current / Diff / Side by side** · "Full page" checkbox · spacer · "New baseline" (`camera`) · **Compare** (primary). Body: one pane, or three equal panes in side-by-side; each pane has a 12px header (label 600 + meta text-3, e.g. "14:02 · 1440×2210") above the image (1px line, radius 8). Diff pane outlines changed regions in err. Right column 260px: "2.4%" (26/600 err) + "of pixels changed · 31,204 px", Threshold slider, "Baselines" list (selected row accent-soft).

### 10. Spoof
Toolbar: "Active on Session 1" + applied-override chips (accent-soft/accent with icon, e.g. "iPhone 15 · 393×852", "London · Europe/London", "Fast 3G") · spacer · "Reset all" (text button) · **Apply and reload** (primary). Body: three section cards in a 3-column grid (gap 12, padding 14):
- **Device** (`smartphone`): pick chips Desktop / iPhone 15 / Pixel 8 / iPad Air; fields Width, Height, Pixel ratio (3 columns); User agent; Touch input toggle.
- **Location and time** (`map-pin`): pick chips London / New York / Tokyo / São Paulo; fields Timezone, Locale, Latitude, Longitude (2 columns); Clock select ("Real time" / offset / frozen).
- **Advanced** (`sliders-horizontal`): Color scheme, Reduced motion, Network (throttling), CPU (throttling) as label + 120px select rows.
Field: label 11.5px text-3 above a 28px input (1px line-strong, radius 6, mono 12).

### 11. Mock
Toolbar: "Replace responses for Session 1" (12px text-3) · spacer · **New rule** (primary, `plus`). Inline form (shown on New rule or on "Mock" from a request; bg sunken, 1px line-strong, radius 10, padding 14, grid `110px 1fr 110px`): Method select · URL pattern (focused, accent border) · Status; full-width Response body; footer: "Add CORS headers" checkbox · spacer · Cancel (text) · **Add rule** (primary). Rules table (1px line, radius 10): header row sunken; grid `44px 64px 1fr 70px 90px 90px 56px`: toggle · Method · Pattern (mono 12.5) with body preview below (mono 11 text-3) · Status (mono ok) · Hits · Last hit ("2 s ago" / "Never") · edit/delete icons. Disabled rule rows at 55% opacity.

### 12. Resilience
Toolbar: "Inject failures into Session 1" · spacer · **Add rule** (primary). Inline form: failure type pick chips with icons — 500 error `server-crash` · Gateway timeout `hourglass` · Hang `pause` · Offline `wifi-off` · 404 `file-x` · Corrupt body `file-warning` · Latency `timer` · Random 500 `dices`; one-line description of the selected type below (e.g. "Returns HTTP 500 Internal Server Error."); row grid `1fr 110px 110px auto`: URL pattern · Probability (%) · Delay (ms) · Cancel / **Add rule**. Rules table grid `44px 120px 56px 1fr 90px 80px 70px 56px`: toggle · Failure (warn, icon + label) · Method · Pattern · Probability · Delay · Hits · edit/delete. The green explanation box and footnotes are removed.

### 13. Record (record & playback)
Empty state: icon `circle-dot` on err-soft · "No recorded tests yet" · "Clicks, typing and navigation in this tab become replayable steps." · **Start recording** (bg err, `circle` icon). Toolbar while empty: "No saved tests". Recording: toolbar shows a pulsing 8px err dot + "Recording · n steps" (12.5/500 err) · spacer · "Add assertion" (outline, `badge-check`) · **Stop and save** (strong neutral, `square`). Steps list rows 40px, grid `28px 28px 140px 1fr auto`: number (mono text-3) · 26px icon tile (sunken; assertions ok-soft/ok) · action 13/500 · selector or URL mono 12 text-2 · value mono 11.5 text-3. Saved tests, run-N-times and results keep their current behaviour and get the same table and toolbar styling.

### 14. Follow
Toolbar: pulsing ok dot + "Live" · chip "● Session 2 leads" → chip "● Session 1 follows" · "Mirroring navigation, clicks and input" (text-3) · spacer · "Pause" (outline) · **Stop following** (strong neutral). Event rows 38px, grid `72px 28px 120px 1fr 150px`: time · icon · action · target (mono) · result right ("✓ Mirrored" text-3; "⚠ Element not found" warn on a warn-soft row). Unpaired state uses the empty-state pattern ("Follow along" / "Mirror another tab's navigation in this one." / **Pair with a tab**).

### 15. Jira
Toolbar: ticket key input (160px, mono, `ticket` icon) · **Load** (outline) · spacer · connection status (6px ok dot + host) · settings icon (`settings-2`). Left: key (mono accent) + status pill (warn-soft/warn "In testing") + "Open in Jira"; summary 17/600; fields grid (5 columns: label 11.5 text-3, value 12.5/500, as configured by the user's field layout); "Acceptance criteria" checklist. Right pane 420px (bg sunken): "Report a bug on QA-1432", Summary, Steps, "Attach" checklist (Network log (HAR) · Console log · Screenshot · Session snapshot, each with a right-aligned count), full-width **Create bug** (primary). Not-configured state uses the empty-state pattern ("Connect Jira" / one sentence / **Connect Jira**).

### 16. Debug log
Toolbar: search "Filter log" · segmented All / Errors / Warnings / Debug · source chips in mono (main, ipc, recorder, mock, updater) · spacer · "Copy". Rows: mono 12 / 1.5, grid `100px 56px 84px 1fr`: time (text-3) · level (error err 600, warn warn 600, info text-2, debug text-3) · source (accent) · message. Error rows err-soft. When Debug mode is off, use the empty state ("Debug log" / "TesterBrowser's own internal logs. Turn on Debug mode to collect them." / **Open settings**).

### 17. Settings (modal)
Scrim `rgba(10,12,16,.38)`; modal 780×560, radius 14, `--tb-shadow-pop`, 1px line. Left nav 200px (bg sunken, padding 18 10): "Settings" 15/600, then General `sliders-horizontal` · Tools `layout-grid` · Shortcuts `keyboard` · About `info` (32px items, radius 7; selected = surface bg, 600). Header 56px: pane title 15/600 + close ✕. Content padding 8 24 24.
**General** sections (title 11.5/600 text-3, padding 18 0 4); rows padding 12 0, 1px bottom line, label 13/500, description 12px text-3 (one sentence max), control on the right:
- Browser: Theme (segmented Light/Dark; keep System as a third option if the current System default stays) · Search engine (select) · Allow real popups — "Keeps window.opener for OAuth and payment flows. Popup traffic is not recorded." · Open downloads panel automatically (no description).
- Recording: Redact sensitive headers — "Hides Authorization, Cookie and Set-Cookie values." · Events kept per tab (number) · Keep recordings for — "Applies to closed tabs." · Debug mode — "Collects TesterBrowser's own logs."
- Updates: Install updates when idle — "Never while recording, playing back or downloading." (plus the idle-minutes field).
- GitHub (bug reporter) sign-in keeps its current behaviour in this pane.
**Tools** replaces "Features": "Choose which tools appear in the panel." then one row per tool (icon, label, group name in text-3, toggle). Network and Console are always on (toggle at 50% opacity). The long feature descriptions are dropped.
**Shortcuts:** two-column list; label text-2, key in a mono 11.5 keycap (1px line-strong, bg sunken, radius 5).
**About:** logo 40px, "TesterBrowser 0.77.1", status ("✓ Up to date" in ok), "Check for updates". Update error/restart actions keep their current behaviour.

### 18. Speed Dial (`newtab.html`)
bg sunken; centred column, padding-top 56, gap 28. Search box 520×42, radius 10, 1px line-strong, `search` icon, "Search Google or enter an address" (engine name follows the setting). Tile grid: 7 columns × 104px, gap 12; tile 96px high, radius 10, bg surface, 1px line (hover line-strong): 36px rounded-9 favicon/initial tile + 12px name text-2. Last tile is dashed "Add site". Keep the existing × remove on hover and the add-site form.

## Interactions & behaviour
- Tab strip: click selects + expands; chevron toggles collapse; panel height and collapsed state persist as they do today (layout IPC).
- Network: chips are independent toggles combined with AND; search filters URL + headers + body; selecting a row opens the detail pane; "Mock" / "Resilience" in the detail pane switch to that tab with the inline form open and pre-filled (existing `⇒ Mock` / `⇒ Resilience` behaviour).
- Security "Open request" switches to Network and selects the request.
- Rule toggles enable/disable live; disabled rows dim to 55%.
- Recording dot pulse: opacity 1 → .3 → 1, 1.2 s ease-in-out infinite (Live dot in Follow: 1.6 s).
- Hover: rows/icon buttons → `--tb-hover`; tabs → text `--tb-text`. Focus: 2px `--tb-accent` outline, offset 1px, on every interactive element (existing a11y self-check must stay green).
- No new animations beyond the pulses and existing panel transitions.

## Assets
- `renderer/app-logo.png` (existing).
- Lucide icon font — `lucide-static` (MIT); vendor `lucide.woff2` + CSS into `renderer/vendor/lucide/`. Glyph names used are listed in each section above (classes `icon-<name>`).
- JetBrains Mono 400/500/600 woff2 (SIL OFL) → `renderer/vendor/fonts/`.
- Segoe UI Variable / Segoe UI are Windows system fonts — nothing to ship.

## Files in this package
- `README.md` — this spec.
- `TICKETS.md` — ordered ticket drafts in the repo's Definition-of-Ready format.
- `AGENT_CREATE_TICKETS.md` — instructions for the agent that turns `TICKETS.md` into GitHub issues.
- `tokens.css` — drop-in theme tokens.
- `prototype/TesterBrowser Redesign.dc.html` — interactive reference (open in a browser; needs `support.js` and `renderer/` beside it).
- `prototype/Current UI.dc.html` — today's Network view, for comparison.
- `screenshots/` — 1440×900 captures of every state (dark unless prefixed `light-`). Tickets reference them by file name:
  - `00-current-ui-before.png` (today, for comparison)
  - `01–03` Network (Headers / Response / Timing tabs) · `04` Console · `05–07` Storage (Cookies / Local / IndexedDB) · `08` A11y · `09` Security · `10` Network diff · `11` UI diff · `12` Spoof · `13–14` Mock (list / new-rule form) · `15–16` Resilience (list / add-rule form) · `17–18` Record (empty / recording) · `19` Follow · `20` Jira · `21` Debug log · `22` panel collapsed to tabs · `23` Speed Dial · `24–27` Settings (General / Tools / Shortcuts / About)
  - `light-01` Network · `light-02` Console · `light-03` Security · `light-04` Spoof · `light-05` Resilience form · `light-06` Record empty · `light-07` Speed Dial · `light-08` Settings
  - Screenshots of the Settings modal don't show the dimmed scrim (a capture limitation); the scrim is specced in § 17.
