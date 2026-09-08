# Kanban Workflow Design — TesterBrowser

**Date:** 2026-09-01  
**Project board:** https://github.com/users/testheader/projects/3  
**Repo:** https://github.com/testheader/testerbrowser

---

## Board Columns (Status field) and their labels

The board's Status field is **not reachable from the plain issues API**, so
`status-*` **labels are the source of truth** for ticket state. Agents read and
write labels; the board column is mirrored from the label by whoever holds
project credentials. Exactly one `status-*` label per issue at a time.

| Status | Label | Meaning |
|---|---|---|
| **Backlog** | _(no status label)_ | Planned, not started. Ticket has enough spec to implement. |
| **Ready** | `status-ready` | User has selected this for the next implementation cycle. |
| **In progress** | `status-in-progress` | Implementing agent is actively working. |
| **CI running** | `status-ci-running` | Committed and pushed to main. CI job is active. |
| **Needs Fix** | `status-needs-fix` | CI failed. Fix notes and log excerpt posted as a comment. |
| **Done** | `status-done` | CI passed. Feature shipped. |

## Definition of Done

A ticket stays **open** until it is in the Done column. Commit messages must not
use `closes #N` (that would auto-close the issue on push, before CI has proved
anything) — use `refs #N`. Only the CI monitor agent closes an issue, and only
after CI is green and the label is `status-done`.

## Workflow Loop

```
User selects a ticket
  → labels it status-ready (or asks agent to pick next)

Implementing agent (implement-ticket)
  → reads oldest open issue labelled status-ready
  → moves ticket: status-ready → status-in-progress
  → reads title + body for spec
  → implements code + tests (TDD)
  → typecheck + lint + unit tests must pass
  → commits with "refs #N" in message (never "closes #N")
  → pushes to main
  → moves ticket: status-in-progress → status-ci-running
  → posts comment: commit SHA + Actions run URL

CI monitor agent (watch-ci, looping)
  → polls the Build workflow run for the commit SHA
  → CI passes → moves ticket: status-ci-running → status-done
               → posts comment: run URL + "CI passed"
               → closes the issue (only place this happens)
  → CI fails  → moves ticket: status-ci-running → status-needs-fix
               → issue stays open
               → posts comment: failure summary + log excerpt
```

---

## Agent Responsibilities

Both agents live in `.github/agents/` so they are tool-agnostic and invokable by
name. Neither has a restricted tool list — they may use every tool available to
them.

### Implementing agent (`.github/agents/implement-ticket.md`)

**Trigger:** User says "implement next ticket" or "implement #N"

**Steps:**
1. Find the oldest open issue labelled `status-ready` (or the named issue)
2. Swap `status-ready` → `status-in-progress`, read title + body + comments as the spec
3. Implement with tests (Jest for main-process logic, Playwright e2e for UI flows)
4. `npm run typecheck`, `npm run lint`, `npm test` → all must pass before commit
5. `git commit -m "feat/fix: <title> (refs #N)"`
6. `git push origin main`
7. Swap `status-in-progress` → `status-ci-running`
8. Post comment with commit SHA and Actions run URL

**Constraints:**
- One ticket at a time
- Must not push if typecheck, lint or tests fail
- Must not use `closes #N`, must not close the issue, must not set `status-done`
- Must not bump `package.json` — CI owns versioning

### CI monitor agent (`.github/agents/watch-ci.md`)

**Trigger:** User invokes it, or it runs as a loop after the implementing agent

**Steps:**
1. Find all open issues labelled `status-ci-running`
2. For each: get the commit SHA from the handoff comment
3. Look up the `Build` workflow run for that SHA
4. Success → `status-done`, comment run URL, **close the issue**
5. Failure → `status-needs-fix`, issue stays open, comment failure summary + log excerpt
6. Still in progress → leave labels alone, poll again

## Issue Conventions

- **Title format:** `<type>: <description>` (conventional commits — feat/fix/chore/refactor/test)
- **Body:** Must include acceptance criteria for backlog items so the implementing agent knows when it's done
- **Labels:** enhancement, bug, infrastructure, testing, refactor
- **Closing:** Commits use `refs #N`, never `closes #N`. The CI monitor agent closes the issue once CI passes and the ticket reaches Done.

---

## Board IDs (for agent scripts)

```
Project number:    3
Project ID:        PVT_kwHOA2Pe484BiHJY
Status field ID:   PVTSSF_lAHOA2Pe484BiHJYzhhAV-0
Backlog option:    adf7ac3d
Ready option:      70a64391
In progress option: 978f4b40
CI running option: 78882a20
Needs Fix option:  211b4ce4
Done option:       07528d57
Repo:              testheader/testerbrowser
```

---

## Backfill Summary

30 issues created on 2026-09-01:
- **Issues #2–24** (23 issues): Implemented features, fixes, and refactors → Status: Done
- **Issues #25–31** (7 issues): Roadmap items from CLAUDE.md → Status: Backlog

See `docs/superpowers/plans/2026-09-01-kanban-board-setup.md` for the setup execution plan.
