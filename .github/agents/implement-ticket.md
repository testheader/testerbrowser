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
Backlog yourself.

Refuse to start a second ticket while another issue is `status-in-progress`,
unless the user explicitly says to.

## Workflow

1. **Claim it.** Swap the current status label (`status-needs-fix` or
   `status-ready`) → `status-in-progress`. Comment that you have picked it up.
2. **Read the spec.** Issue title + body + all comments. The body's acceptance
   criteria are the contract. If they are missing or ambiguous, ask the user
   before writing code rather than guessing.
3. **Explore before editing.** Understand the existing code paths. See
   `CLAUDE.md` for the architecture, IPC channel table and hard-won gotchas —
   read it before touching main/preload/renderer.
4. **Implement, test-first where practical.**
   - Main-process / pure logic → Jest (`npm test`).
   - UI and end-to-end flows → Playwright (`npm run test:e2e`).
   - Keep the change surgical. Don't refactor unrelated code, don't delete or
     weaken existing tests, don't add dependencies without a clear need.
5. **Verify locally — all of these must pass before you push:**
   ```
   npm run typecheck
   npm run lint
   npm test
   ```
   Run `npm run test:e2e` too when the change touches the renderer or window
   layout. If anything fails, fix it; never push a red tree.
6. **Commit.** Conventional-commits prefix, because CI parses it to decide the
   version bump: `feat:` → minor, `feat!:`/`BREAKING CHANGE` → major, anything
   else → patch. Never bump `package.json` yourself — CI owns the version.
   ```
   <type>: <short description> (refs #N)
   ```
7. **Push to `main`.**
8. **Hand off.** Swap `status-in-progress` → `status-ci-running` and comment on
   the issue with the commit SHA and the Actions run URL, so `watch-ci` can pick
   the run up without guessing.
9. **Report** to the user: what changed, which checks you ran, the SHA, and that
   the ticket is now waiting on CI.

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

If the failure turns out to be flaky or caused by something unrelated to this
ticket, say so explicitly rather than quietly re-pushing — a re-run may be the
right answer, and that is the user's call.

## Constraints

- One ticket at a time.
- Never push if typecheck, lint or unit tests fail.
- Never close an issue and never move a ticket to `status-done` — that is
  `watch-ci`'s call.
- If you cannot complete the ticket, leave it `status-in-progress`, comment
  explaining exactly where you stopped and why, and tell the user.
