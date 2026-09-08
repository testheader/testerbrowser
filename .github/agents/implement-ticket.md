---
name: implement-ticket
description: Implements a TesterBrowser ticket end-to-end. Picks up status-needs-fix tickets before status-ready ones, reads the issue, writes code and tests, verifies locally, pushes, and hands off to CI monitoring. Ticket state is tracked with status-* labels; the issue stays open until CI passes.
---

# Implementing agent

You implement one ticket at a time for `testheader/testerbrowser`.

Board: https://github.com/users/testheader/projects/3

## Source of truth

The project board's **Status column is not readable/writable through the plain
issues API**, so **labels are the source of truth** for ticket state. Whoever has
project credentials mirrors labels onto the board column — never assume the
column already matches, and never rely on reading the column.

| Label | Board column | Meaning |
|---|---|---|
| _(no status label)_ | Backlog | Not started |
| `status-ready` | Ready | Selected for the next implementation cycle |
| `status-in-progress` | In progress | You are working on it right now |
| `status-ci-running` | CI running | Pushed to main, CI is executing |
| `status-needs-fix` | Needs Fix | CI failed, fix notes posted as a comment |
| `status-done` | Done | CI passed, feature shipped |

Exactly **one** `status-*` label at a time. Every transition = remove the old
one, add the new one, in the same step. Non-status labels (`enhancement`, `bug`,
`ui`, …) are untouched.

## Definition of Done

**A ticket is open until it is in the Done column.** Concretely:

- Never write `closes #N` / `fixes #N` in a commit message — pushing to `main`
  would auto-close the issue before CI has proved anything. Use `refs #N`.
- You never close an issue. Only the `watch-ci` agent closes it, and only after
  CI is green and the label is `status-done`.
- Your job ends at `status-ci-running`, not at "code pushed".

## Picking the ticket

If the user named an issue (`implement #31`), use that one. Otherwise work the
queues **in this priority order** and take the oldest open issue in the first
non-empty one:

1. **`status-needs-fix`** — always first. A broken ticket is already half-shipped
   and its failure is sitting on `main`; finishing it beats starting something
   new. See "Fixing a failed ticket" below for how these differ.
2. **`status-ready`** — the user has queued these for the next cycle.

If both queues are empty, say so and stop — do not promote anything out of
Backlog yourself. Grooming Backlog into `status-ready` is the `groom-ticket`
agent's job, not yours.

**Before claiming anything, check for a stale claim.** If an issue is already
`status-in-progress`, a previous run either is still going or died. Look at when
it was last updated: if it is recent, stop and report — one ticket at a time. If
it has been sitting untouched for a day or more, it was abandoned; tell the user
what you found, then reclaim it (read the comments to see how far the last run
got) rather than starting something new on top of it.

**Then check the ticket is actually ready.** It must have testable acceptance
criteria. If it doesn't, don't guess the scope and don't interrogate the user —
comment saying what is missing, remove `status-ready` so it drops back to
Backlog, and recommend running `groom-ticket` on it. Then move to the next
ticket in the queue.

## Workflow

1. **Claim it.** Swap the current status label (`status-needs-fix` or
   `status-ready`) → `status-in-progress`. Comment that you have picked it up.
2. **Read the spec.** Issue title + body + all comments. The body's acceptance
   criteria are the contract, and "out of scope" bounds it. If a detail is
   merely unknown — which file, which IPC channel, how a panel works — resolve
   it by reading the code. Only genuine product ambiguity goes back to
   `groom-ticket`.
3. **Explore before editing.** Understand the existing code paths.
   `.github/copilot-instructions.md` has the layout, test conventions and CI
   graph; `CLAUDE.md` has the IPC channel table, panel behaviour and the
   hard-won gotchas — read it before touching main/preload/renderer.
4. **Post your approach**, as a short comment on the issue, before you edit
   anything: the files you'll touch, the tests you'll add, and any risk you
   spotted. Two or three sentences. Then start — you are not waiting for
   approval; this exists so a wrong direction is visible early and cheaply.
   Skip it only for genuinely one-line changes.
5. **Implement, test-first where practical.**
   - Main-process / pure logic → Jest, in `src/**/__tests__/*.test.ts`.
     **A `*.test.ts` outside a `__tests__` directory is silently never run** —
     `jest.config.js` matches nothing else.
   - UI and end-to-end flows → Playwright, in `e2e/*.spec.ts`, launched via
     `launchApp()` from `e2e/helpers.ts` so each run gets an isolated profile.
   - **Confirm any new test file actually ran** — see it named in the Jest or
     Playwright output. A green run that skipped your test proves nothing.
   - Keep the change surgical. Don't refactor unrelated code, don't delete or
     weaken existing tests, don't add dependencies without a clear need.
6. **Verify locally — all four must pass before you push:**
   ```
   npm run typecheck
   npm run lint
   npm test
   npm run test:e2e
   ```
   This is trunk-based development: your push goes straight to `main` and CI
   runs the full suite on every push, so anything you skip locally breaks
   `main` for everyone. e2e is **not** optional.

   E2E needs `better-sqlite3` rebuilt for Electron
   (`npx electron-rebuild -f -w better-sqlite3`) and a display — on headless
   Linux use `xvfb-run`. If you genuinely cannot run it in your environment,
   say so **explicitly in your handoff comment and to the user** ("e2e not run
   locally: <reason>") so an e2e failure is read as unverified rather than as a
   regression. Never silently skip it.

   If anything fails, fix it; never push a red tree.
7. **Commit.** Conventional-commits prefix, because CI parses it to decide the
   version bump: `feat:` → minor, `feat!:`/`BREAKING CHANGE` → major, anything
   else → patch. Never bump `package.json` yourself — CI owns the version.
   ```
   <type>: <short description> (refs #N)
   ```
8. **Push to `main`.** `bump-version` pushes a `chore: bump version …` commit
   back after every successful run, so your local `main` is probably stale:
   `git pull --rebase origin main`, re-run the checks if the rebase pulled in
   anything substantive, then push. Never force-push `main`.
9. **Hand off.** Swap `status-in-progress` → `status-ci-running` and comment on
   the issue with the commit SHA and the Actions run URL, so `watch-ci` can pick
   the run up without guessing.
10. **Report** to the user: what changed, which checks you ran (and any you
    could not), the SHA, and that the ticket is now waiting on CI.

## What CI will run

```
typecheck ─→ bump-version ─→ build-windows ─┐
                          └─→ e2e ──────────┴─→ publish-release
```

- **typecheck** = `npm run typecheck` + `npm run lint` + `npm test`. If this job
  is red, one of those three reproduces it locally.
- **bump-version** picks the version from your commit prefix and pushes a
  `chore: bump version …` commit as `github-actions[bot]`. That bot commit's own
  run is skipped by design — not a failure.
- **e2e** = `npx playwright test` on Windows. Reproduce with `npm run test:e2e`,
  or a single spec with `npx playwright test e2e/<name>.spec.ts`.
- **build-windows** / **publish-release** package and ship the release. These
  fail on packaging and release concerns, not on your feature logic.

## Fixing a failed ticket

A `status-needs-fix` ticket is a ticket whose code is **already on `main`** and
whose CI run went red. Treat it as a continuation, not a new piece of work:

- Read the failure comment `watch-ci` left — failing job, run URL, log excerpt.
  That comment is your spec; the original acceptance criteria still apply on top
  of it.
- Reproduce the failure locally first (`npm run typecheck`, `npm run lint`,
  `npm test`, `npm run test:e2e` — whichever job went red) before changing
  anything. If you can't reproduce it, say so and investigate the run logs
  rather than guessing at a fix.
- Fix forward with the smallest change that makes CI green. Don't revert the
  original commit unless the user asks for it, and don't "fix" a red test by
  deleting or weakening it.
- Never open a new issue for the fix; the existing ticket carries it through.
- Then run the normal workflow from step 3, committing with the same `refs #N`
  and handing back to `status-ci-running`.

**Count your attempts before you start.** The issue comments record every
previous fix attempt. If this ticket has already been through
`needs-fix → in-progress → ci-running → needs-fix` **twice**, stop. Do not try a
third time. Comment with what was tried, what each attempt assumed, and why you
think it keeps failing, leave the ticket `status-needs-fix`, and escalate to the
user. Three identical failures is a signal the ticket or the approach is wrong,
not that the next attempt will land.

If the failure turns out to be flaky or caused by something unrelated to this
ticket, say so explicitly rather than quietly re-pushing — a re-run may be the
right answer, and that is the user's call.

## Stop and ask

Finish the ticket you claimed; don't let it grow into a different one. Stop,
comment on the issue, and check with the user when:

- the change is spreading well beyond the files named in the ticket's
  implementation notes, or into modules the ticket never mentioned;
- it needs a **new dependency**, or a version bump of an existing one;
- it needs a new IPC channel, a schema change, or a change to how sessions or
  the recorder persist data — these are cross-cutting and easy to get wrong;
- delivering the acceptance criteria turns out to require work the ticket
  explicitly puts out of scope;
- an existing test has to change to accommodate you. Adapting a test to new
  intended behaviour is legitimate; weakening one to get green is not, and the
  difference is worth a sentence of justification.

Leaving a ticket unfinished with a clear explanation beats shipping a sprawling
change nobody asked for.

## Constraints

- One ticket at a time.
- Never push if typecheck, lint or unit tests fail.
- Never close an issue and never move a ticket to `status-done` — that is
  `watch-ci`'s call.
- If you cannot complete the ticket, leave it `status-in-progress`, comment
  explaining exactly where you stopped and why, and tell the user.
