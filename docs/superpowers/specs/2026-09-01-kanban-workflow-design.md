# Kanban Workflow Design — TesterBrowser

**Date:** 2026-09-01  
**Project board:** https://github.com/users/testheader/projects/3  
**Repo:** https://github.com/testheader/testerbrowser

---

## Board Columns (Status field) and their labels

The board's Status field is **not reachable from the plain issues API**, so
`status-*` **labels are the source of truth** for ticket state. Agents run with
project credentials, so every transition writes **both**: the label first (it is
canonical), then the board column via the Projects v2 GraphQL API. `watch-ci`
re-reconciles the board from labels on every run, so a failed mutation is
self-healing. Exactly one `status-*` label per issue at a time.

| Status | Label | Meaning |
|---|---|---|
| **Backlog** | `status-backlog` _(older issues: no status label)_ | Captured, not yet groomed or not yet selected. |
| **Ready** | `status-ready` | Groomed to the Definition of Ready and queued for implementation. |
| **In progress** | `status-in-progress` | Implementing agent is actively working. |
| **CI running** | `status-ci-running` | Committed and pushed to main. CI job is active. |
| **Needs Fix** | `status-needs-fix` | CI failed. Fix notes and log excerpt posted as a comment. |
| **Done** | `status-done` | CI passed. Feature shipped. |

## Definition of Ready

A ticket may only be labelled `status-ready` when an implementer who has never
seen it could finish it without asking a question. The body must carry:

1. **Problem / motivation** — what is wrong or missing, and for whom
2. **Acceptance criteria** — observable, testable statements
3. **Implementation notes** — the real files, modules and IPC channels involved
4. **Test plan** — which unit tests and which e2e specs prove the criteria
5. **Out of scope** — what this ticket deliberately does not do

`groom-ticket` owns this gate. `implement-ticket` bounces anything that fails it
back to Backlog rather than guessing the scope.

## Definition of Done

A ticket stays **open** until it is in the Done column. Commit messages must not
use `closes #N` (that would auto-close the issue on push, before CI has proved
anything) — use `refs #N`. Only the CI monitor agent closes an issue, and only
after CI is green and the label is `status-done`.

## Workflow Loop

```
Grooming agent (groom-ticket)
  → takes a Backlog issue (status-backlog)
  → investigates the code, writes acceptance criteria + test plan
  → splits or closes as needed
  → moves ticket: Backlog → status-ready

User reviews the ready queue

Implementing agent (implement-ticket)
  → picks oldest open issue: status-needs-fix queue first,
    then status-ready
  → moves ticket: that label → status-in-progress
  → reads title + body for spec
  → implements code + tests (TDD)
  → typecheck + lint + unit tests + e2e must pass
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

Each agent has **one canonical definition**, at
`.agents/skills/<name>/SKILL.md`. `.github/agents/<name>.md` and
`.claude/agents/<name>.md` are thin pointer files carrying only frontmatter and
a link, so each tool discovers the agent from its own conventional directory
without the policy being duplicated. Policy changes go in the skill; the
pointers never carry behaviour.

None has a restricted tool list — they may use every tool available to them.
Shared project context (layout, commands, test conventions, CI graph) lives in
`.github/copilot-instructions.md`, which loads automatically.

### Grooming agent (`.agents/skills/groom-ticket/SKILL.md`)

**Trigger:** User says "groom the backlog" or "groom #N"

Takes a Backlog issue (no `status-*` label) and rewrites it into an
implementable ticket: problem statement, testable acceptance criteria,
implementation notes naming real files and IPC channels, a test plan, and an
explicit out-of-scope list. Splits oversized tickets into independently
shippable slices, closes ones that are already built or duplicated, fixes the
title to conventional-commits form, then applies `status-ready`.

Never writes production code. Where a genuine product decision is needed it
leaves the ticket in Backlog and asks one specific question with a recommended
default — everything merely *unknown* it resolves by reading the code.

### Implementing agent (`.agents/skills/implement-ticket/SKILL.md`)

**Trigger:** User says "implement next ticket" or "implement #N"

**Steps:**
1. Pick the ticket (or use the named issue). Queue priority: **`status-needs-fix`
   first**, then `status-ready`; oldest open issue in the first non-empty queue
2. Swap that label → `status-in-progress`, read title + body + comments as the spec
   (for a needs-fix ticket the `watch-ci` failure comment is part of the spec)
3. Post a short approach comment (files, tests, risks) before editing
4. Implement with tests — Jest in `src/**/__tests__/`, Playwright in `e2e/`;
   confirm any new test file actually ran
5. `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:e2e` → all
   must pass before commit (trunk-based: CI runs the full suite on every push)
6. `git commit -m "feat/fix: <title> (refs #N)"`
7. `git pull --rebase origin main`, then `git push origin main`
8. Swap `status-in-progress` → `status-ci-running`
9. Post comment with commit SHA and Actions run URL

**Constraints:**
- One ticket at a time
- Finish broken work before starting new work — `status-needs-fix` outranks `status-ready`
- Must not push if typecheck, lint or tests fail
- Must reproduce a CI failure locally before fixing it; fix forward, never delete
  or weaken a failing test
- Stops and escalates after two failed fix attempts on the same ticket
- Bounces an unready ticket back to Backlog for `groom-ticket` rather than
  guessing the scope
- Reclaims a `status-in-progress` ticket left stale by a crashed run
- Must not use `closes #N`, must not close the issue, must not set `status-done`
- Must not bump `package.json` — CI owns versioning

### CI monitor agent (`.agents/skills/watch-ci/SKILL.md`)

**Trigger:** User invokes it, or it runs as a loop after the implementing agent

**Steps:**
0. Reconcile the board from labels; sweep manually-closed issues into Done
1. Find all open issues labelled `status-ci-running` (board query ∪ label query)
2. For each: get the commit SHA from the handoff comment
3. Look up the `Build` workflow run for that SHA
4. Success → `status-done`, comment run URL, **close the issue**
5. Failure, but the latest `main` run is green → Done (trunk-based: a green head
   contains every earlier commit), noting the superseding run
6. Failure, first time and trivially fixable → fix inline, push, stay in CI
   running and re-monitor
7. Failure otherwise → `status-needs-fix`, issue stays open, comment failure
   summary + log excerpt + repro command + attempt count
8. Still in progress → leave labels alone, poll again

## Token Budget

Each agent works **one ticket at a time and loops** until its queue is empty or
its context runs low, so every one of them checks its remaining `total_tokens`
before picking up the next item and stops cleanly above a floor.

| Skill | Full-speed above | Floor — stop below | Why the floor is where it is |
|---|---|---|---|
| `groom-ticket` | 20,000 | 10,000 | Investigation-heavy; a half-read codebase produces a thin ticket |
| `implement-ticket` | 25,000 | 12,000 | Full cycle is explore → implement → four verification commands → push → handoff |
| `watch-ci` | 20,000 | 8,000 | Polling is cheap per round but unbounded in length |

Stopping early is safe **because all state lives in labels**, not in the agent's
context — a fresh session resumes exactly where the last one stopped. What is
*not* safe is stopping mid-ticket: a ticket stranded on `status-in-progress`, or
code pushed to `main` that never reached `status-ci-running`, is invisible to the
next agent in the chain. Hence the rule shared by all three: never start a unit
of work you cannot finish through its handoff.

On stopping for budget, an agent reports what it completed, what remains, and
that it stopped for budget rather than because the queue was empty.

---

## Issue Conventions

- **Title format:** `<type>: <description>` (conventional commits — feat/fix/chore/refactor/test)
- **Body:** Must meet the Definition of Ready above before `status-ready` is applied
- **Size:** One focused change — a handful of files, one coherent behaviour. Bigger items get split into independently shippable slices by `groom-ticket`.
- **Labels:** enhancement, bug, infrastructure, testing, refactor
- **Closing:** Commits use `refs #N`, never `closes #N`. The CI monitor agent closes the issue once CI passes and the ticket reaches Done.

---

## Board IDs

Agents use these to write the Status column. Verified against the working
skills; the *setup plan* doc records a different, stale set — ignore it. Re-read
from the API if a mutation starts failing:

```
gh project field-list 3 --owner @me --format json
```

```
Project number:    3   (owner @me)
Project ID:        PVT_kwHOA2Pe484BiHJY
Status field ID:   PVTSSF_lAHOA2Pe484BiHJYzhhAV-0
Repo:              testheader/testerbrowser
```

| Column | Option ID |
|---|---|
| Backlog | `adf7ac3d` |
| Ready | `70a64391` |
| In progress | `978f4b40` |
| CI running | `78882a20` |
| Needs Fix | `211b4ce4` |
| Done | `07528d57` |

---

## Backfill Summary

30 issues created on 2026-09-01:
- **Issues #2–24** (23 issues): Implemented features, fixes, and refactors → Status: Done
- **Issues #25–31** (7 issues): Roadmap items from CLAUDE.md → Status: Backlog

See `docs/superpowers/plans/2026-09-01-kanban-board-setup.md` for the setup execution plan.
