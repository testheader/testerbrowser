# UX/UI review findings — design reference

Maps each finding in the UX/UI review (F1–F22) to its GitHub issue, the section
of `README.md` that specifies the intended design, the screenshot that shows
it, and whether the spec agrees with the review. Use it when grooming or
implementing a finding: the spec wins over the review wherever they disagree,
unless the table says the spec is silent.

Spec: [`README.md`](README.md) · tokens: [`tokens.css`](tokens.css) ·
prototype: [`prototype/TesterBrowser Redesign.dc.html`](prototype/TesterBrowser%20Redesign.dc.html)
· screenshots: [`screenshots/`](screenshots/)

"Agrees" means the spec asks for the review's fix. "Silent" means the spec does
not cover the case, so the ticket needs a decision. "Conflicts" means the spec
asks for something different, and the ticket must follow the spec.

| Finding | Issue | Spec section | Screenshot | Spec vs review |
|---|---|---|---|---|
| F1 Hidden elements still render | #319 | §15 Jira (not configured = empty state) | `20-jira.png` | Agrees (the global `[hidden]` rule the review assumes does not exist in `style.css`) |
| F2 Network detail pane breaks the table | #320 | §3 (detail pane fixed at 480px) | `01-network-dark.png` | Silent on narrow windows; spec keeps 480px |
| F3 Storage loses the Value column | #321 | §5 (cookie grid `170px 1fr 190px 40px 96px 200px`) | `05-storage-cookies.png` | Silent on narrow windows |
| F4 Record shows three UIs | #322 | §13 (empty state only; saved tests keep current behaviour) | `17-record-empty.png`, `light-06-record-empty.png` | Agrees |
| F5 Jira not-connected contradicts itself | #323 | §15 (not-configured = empty-state pattern) | `20-jira.png` | Agrees |
| F6 Request detail follows you to other tools | #324 | §3 (detail belongs to Network); Interactions | `04-console.png` | Silent on tab switching |
| F7 Follow has two ways to start | #325 | §14 (unpaired = empty state with **Pair with a tab**; live toolbar when paired) | `19-follow-along.png` | Agrees on the toolbar; popover is silent |
| F8 Two menus with overlapping items | #326 | §1 (⋯ holds View items and Settings; logo has no menu) | `00-current-ui-before.png` | Agrees; group names (Tab, View, Tools, App) are silent |
| F9 Empty states repeat actions | #327 | §8 (filters and counts shown in the toolbar area); §6 (refresh is an icon) | `10-network-diff.png`, `11-ui-diff-side-by-side.png`, `08-a11y.png` | Conflicts for Network diff (spec shows the chips with counts); silent on the A11y first-load label |
| F10 Older panels skip shared controls | #328 | §6 (A11y toolbar has no view switcher); §11, §12; README "Design tokens → Shared patterns"; Global rules (sentence case) | `08-a11y.png`, `13-mock.png`, `16-resilience-add-rule-form.png` | Conflicts on the A11y "Tree" control (not in spec); agrees on sentence case |
| F11 Mock form open on every visit | #329 | §11 (form shown on **New rule** or **Mock** from a request) | `13-mock.png`, `14-mock-new-rule-form.png` | Agrees |
| F12 Throttling in the wrong place | #330 | §10 Advanced (network and CPU throttling); §12 (Resilience has no throttling) | `12-spoof.png`, `15-resilience.png` | Agrees |
| F13 Spoof offers three ways to pick a device | #331 | §10 (pick chips, fields, Advanced labels "Color scheme", "Reduced motion") | `12-spoof.png` | Agrees on labels; the "Custom" reveal is silent |
| F14 Tools overflow below ~1100px | #332 | §2 (tab strip, no narrow-width behaviour) | none | Silent |
| F15 Identical plus buttons; emoji pin | #333 | §1 (one **+** = `#newSessionBtn`, 28px, Lucide `plus`); §1 browser tab (no pin indicator) | `00-current-ui-before.png` | Conflicts on the per-group "+" (not in spec); silent on pins |
| F16 Copy and casing drift | #334 | Global rules (sentence case, no uppercase); §2 ("tool panel"); §13 ("Record") | `26-settings-shortcuts.png` | Agrees |
| F17 Tabs not keyboard reachable | #335 | Interactions (2px focus outline on every interactive element) | none | Silent on tab semantics |
| F18 Detail actions wrap | #336 | §3 (Replay, Mock, Resilience, Copy as cURL) | `01-network-dark.png` | Silent on "Copy as fetch"; the split button is new |
| F19 Shortcuts list reads like a form | #337 | §17 (**two-column** list, mono keycaps) | `26-settings-shortcuts.png` | **Conflicts** with the review, which asks for single-column |
| F20 Bug report actions fall below the fold | #338 | none (bug report modal not in spec) | none | Silent |
| F21 Chip counts run into labels | #339 | README "Shared patterns → Chip" (count in mono 11px, 75% opacity) | `01-network-dark.png` | Silent on the 4px gap |
| F22 Speed Dial depends on google.com | #340 | §18 (favicon or initial tile; search and tile grid only; no dashboard) | `23-speed-dial.png` | Agrees on initial-letter fallback; removing Quick settings matches §18 |

## Where the review is wrong or incomplete

- **F1:** the review assumes a global `[hidden] { display: none }` rule. There isn't one. The `[hidden]` rules are scoped to selectors.
- **F10:** the review's "Shared patterns" pointer is valid (the README has the section under Design tokens), but the A11y "Tree" control it asks to restyle is not in the spec. Spec §6 removes it.
- **F14:** the 1100px breakpoint is not in `renderer/style.css`, and the spec has no narrow-width tab behaviour.
- **F19:** the review asks for a single-column Shortcuts list. The spec says two-column. Follow the spec.

## Decisions still needed

- **F9:** should the Network diff filter chips be hidden before a comparison, or shown with zero counts as the spec draws them?
- **F15:** should the per-group "+" stay (revealed on hover, as the review proposes), or be dropped as the spec implies? Recommended: keep it, revealed on hover and focus.
- **F18:** if "Copy as fetch" stays, the spec has no place for it. Recommended: a "Copy ▾" split button, as the review proposes.
- **F10 / F9:** the A11y first-load label. The spec shows only an icon refresh button. Recommended: an icon with the tooltip "Load tree" until a tree exists.
