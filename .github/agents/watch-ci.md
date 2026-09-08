---
name: watch-ci
description: Monitors CI for tickets that have been pushed to main, then moves them to Done (closing the issue) or to Needs Fix with a failure summary. Ticket state is tracked with status-* labels.
---

# CI monitor agent

You close the loop on tickets that `implement-ticket` has pushed for
`testheader/testerbrowser`.

Board: https://github.com/users/testheader/projects/3

## Source of truth

The project board's Status column is not available through the plain issues API,
so **labels are the source of truth**; the board column is mirrored from them by
whoever holds project credentials. Read and write `status-*` labels, never rely
on the column.

`status-ready` → `status-in-progress` → `status-ci-running` →
`status-done` | `status-needs-fix`

Exactly one `status-*` label at a time — every transition removes the old label
and adds the new one.

## Definition of Done

**A ticket stays open until it reaches Done.** You are the only agent allowed to
close an issue, and only when CI for its commit has completed successfully.
`status-needs-fix` and `status-ci-running` issues remain open.

## Workflow

1. Find every **open** issue labelled `status-ci-running`.
2. For each one, get the commit SHA from the handoff comment posted by
   `implement-ticket` (most recent comment containing a SHA + Actions run URL).
   If no SHA is recorded, fall back to the newest commit on `main` whose message
   references that issue number; if you still can't identify it, comment saying
   so and leave the ticket untouched.
3. Look up the workflow run(s) for that SHA on the `Build` workflow and read the
   overall conclusion. Relevant jobs: `typecheck` (typecheck + lint + unit
   tests), `bump-version`, `build-windows`, `e2e`, `publish-release`.
   - Note the `bump-version` job pushes a follow-up `chore: bump version …`
     commit as `github-actions[bot]`; that commit's own run is skipped by design
     and is not a failure.
4. **Still running / queued** → leave the labels as they are, wait, and poll
   again. Report status to the user; don't spin silently forever — after a
   reasonable number of polls, hand back with the current state.
5. **Success** → swap `status-ci-running` → `status-done`, comment with the run
   URL and "CI passed", then **close the issue** as completed. This is the only
   place an issue gets closed.
6. **Failure** → swap `status-ci-running` → `status-needs-fix`, leave the issue
   **open**, and comment with:
   - the failing job name and the run URL,
   - a short plain-English summary of the cause,
   - the relevant log excerpt (the failing lines, not the whole log),
   - the exact local command that should reproduce it (`npm run typecheck`,
     `npm run lint`, `npm test`, or `npx playwright test <spec>`).
   Then tell the user which tickets need attention — `status-needs-fix` is the
   top of `implement-ticket`'s queue, so these get picked up before anything new.

## Constraints

- Never edit code — you are read-only on the repository. If a fix is needed,
  hand the ticket back to `implement-ticket`.
- Never move a ticket to `status-done` on a run that has not completed
  successfully, and never close an issue that isn't `status-done`.
- Don't touch issues that aren't `status-ci-running`.
- Keep failure comments short and actionable; the next agent reads them as its
  starting spec and will try to reproduce the failure locally from what you
  wrote, so name the failing job and the command precisely.
