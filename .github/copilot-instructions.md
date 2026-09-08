# TesterBrowser — project context

Instructions for any AI agent working in this repository. Deeper architecture
notes (IPC channel table, renderer panel behaviour, keyboard shortcuts) live in
`CLAUDE.md`.

## What this is

An Electron desktop browser purpose-built for software testers. Two core
features:

1. **Isolated sessions** — each tab is its own Electron `session` partition
   (own cookies, localStorage, cache). Sessions can be persistent or in-memory,
   and cloned.
2. **Always-on recording** — CDP Network + Console + Log events captured to a
   per-session SQLite ring buffer the moment a session is created, regardless of
   whether any UI panel is open.

**Stack:** Electron, TypeScript (main + preload), plain ESM JavaScript
(renderer), better-sqlite3, electron-updater, electron-builder.

## Layout

```
src/main/          Main process: window, IPC handlers, session manager, recorder
src/preload/       contextBridge → window.testerBrowser
renderer/*.js      Renderer, split into ES modules (main.js is the entry point)
renderer/index.html  Shell markup;  renderer/style.css  all styling
test-pages/        Static HTML fixtures for exercising the browser itself
e2e/               Playwright specs + fixtures/server.ts (HTTP server for tests)
```

`renderer/renderer.js` is the **legacy monolith** — superseded by the module
split, no longer loaded, and ESLint-ignored. Never add to it.

## Commands

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # eslint renderer/*.js
npm test             # Jest unit tests
npm run test:e2e     # build + Playwright (drives Electron's bundled Chromium)
npm run build        # tsc -p tsconfig.json → dist/
npm run dev          # build + launch Electron locally
```

`npm run test:e2e` needs `better-sqlite3` rebuilt for Electron's ABI
(`npx electron-rebuild -f -w better-sqlite3`) and a display; on a headless Linux
box run it under `xvfb-run`.

## Tests — where they go

**This matters: a test file in the wrong place is silently never run.**

- **Unit tests → `src/**/__tests__/*.test.ts`.** `jest.config.js` uses
  `testMatch: ['**/src/**/__tests__/**/*.test.ts']`, so a `.test.ts` outside a
  `__tests__` directory is invisible to Jest and passes by not existing.
  (`src/main/ci.test.ts` is exactly this bug and does not currently run.)
- **E2E tests → `e2e/*.spec.ts`**, launched via `launchApp()` from
  `e2e/helpers.ts` — never call `electron.launch()` directly. The helper gives
  each launch a throwaway `--user-data-dir`; without it, persisted tab state
  leaks between spec files and produces intermittent, run-order-dependent
  failures.
- Electron is mocked for unit tests via `src/__mocks__/electron.ts`.
- Playwright runs with `workers: 1` and `retries: 0` by design — a flaky test is
  a bug to fix, not to retry away.

**After adding a test file, confirm it actually ran** (see it named in the Jest
or Playwright output). A green run that never executed your test proves nothing.

## CI

`.github/workflows/build.yml`, on every push:

```
typecheck ─→ bump-version ─→ build-windows ─┐
                          └─→ e2e ──────────┴─→ publish-release
```

- **typecheck** runs `npm run typecheck`, `npm run lint` **and** `npm test`.
  When this job fails, one of those three is the cause.
- **bump-version** (main only) parses the commit message and pushes a
  `chore: bump version …` commit back to `main` as `github-actions[bot]`:
  `feat:` → minor, `feat!:` / `BREAKING CHANGE` → major, everything else →
  patch. **Never edit the version in `package.json` by hand.**
- **e2e** runs Playwright on Windows.
- **publish-release** promotes the draft release once the others are green.

Because `bump-version` pushes to `main`, your local clone goes stale after every
successful run — pull with rebase before pushing.

## Conventions

- **Commit messages** use conventional-commit prefixes, because CI parses them
  to pick the version bump.
- **Trunk-based:** work goes straight to `main` — no feature branches, no PRs —
  so `main` must stay green. Run typecheck, lint, unit tests and e2e before
  pushing.
- **`implement-ticket` and `watch-ci` are automated runs.** Consent is taken
  once, when the user asks for the work; after that they loop unattended and
  push to `main` without pausing per ticket. Anything an agent cannot decide
  safely is parked on the issue with a comment and a label so the run continues.
  Never route around trunk-based flow with a branch or a PR.
- **Issue commits reference, never close:** use `refs #N`, not `closes #N` —
  see the ticket workflow below.

## Ticket workflow

Work is tracked on the board at
https://github.com/users/testheader/projects/3. The board's Status column is
**not reachable from the plain issues API**, so `status-*` **labels are the
source of truth**; agents with project credentials update the board column to
match in the same step.

`status-backlog` → `status-ready` → `status-in-progress` → `status-ci-running`
→ `status-done` (or → `status-needs-fix` → back to `status-in-progress`)

Exactly one `status-*` label per issue at a time. A ticket stays **open** until
it reaches Done; only `watch-ci` closes issues, which is why commits use
`refs #N` and never `closes #N`.

**Agent definitions live in `.agents/skills/<name>/SKILL.md`** — one canonical
copy each:

| Skill | Transition |
|---|---|
| `groom-ticket` | Backlog → Ready |
| `implement-ticket` | Ready / Needs Fix → CI running |
| `watch-ci` | CI running → Done / Needs Fix |

Each skill takes **one ticket at a time and loops** until its queue is empty or
its remaining token budget hits the floor documented in the skill. Because
labels hold all the state, stopping for budget is safe and a fresh session
resumes where the last stopped — but stopping *mid-ticket* is not, so no agent
starts a unit of work it cannot finish through its handoff.

`.github/agents/` and `.claude/agents/` hold thin pointer files so each tool can
discover them from its own conventional directory. **Never put policy in a
pointer file** — edit the skill. Full design in
`docs/superpowers/specs/2026-09-01-kanban-workflow-design.md`.

## Gotchas learned the hard way

- **`prompt()` is blocked** in renderers with `contextIsolation: true` — returns
  null silently. Use inline HTML input instead.
- **A focused WebContentsView swallows keyboard events** — `document.keydown` in
  the renderer never fires. Intercept with
  `webContents.on('before-input-event')` and forward over IPC.
- **`layout:setConsoleHeight(0)` is special** — the handler clamps to a minimum
  for drag-resize but accepts 0 explicitly to hide the console entirely.
- **`getLocalStorage` is page-scoped** — `executeJavaScript` runs in the
  currently loaded page's origin, so navigating changes what is visible.
- **Session colour inheritance** — `setWindowOpenHandler` (window.open,
  middle-click, "open link in new tab") creates the child session with the
  parent's colour captured in the `createSession` closure.
- **electron-builder defaults to draft releases** and `electron-updater` ignores
  drafts — hence `"releaseType": "prerelease"`.
- **`bump-version` must not retrigger itself** — guarded by
  `github.actor != 'github-actions[bot]'`.
