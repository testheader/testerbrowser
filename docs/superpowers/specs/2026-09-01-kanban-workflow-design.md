# Kanban Workflow Design — TesterBrowser

**Date:** 2026-09-01  
**Project board:** https://github.com/users/testheader/projects/3  
**Repo:** https://github.com/testheader/testerbrowser

---

## Board Columns (Status field)

| Status | Meaning |
|---|---|
| **Backlog** | Planned, not started. Ticket has enough spec to implement. |
| **Ready** | User has selected this for the next implementation cycle. |
| **In progress** | Implementing agent is actively working. |
| **CI running** | Committed and pushed to main. CI job is active. |
| **Needs Fix** | CI failed. Fix notes and log excerpt posted as a comment. |
| **Done** | CI passed. Feature shipped. |

---

## Workflow Loop

```
User selects a ticket
  → moves it to Ready (or asks agent to pick next)

Implementing agent (/implement)
  → reads oldest Ready ticket from board
  → reads title + body for spec
  → implements code + tests (TDD)
  → commits with "closes #N" in message
  → pushes to main
  → moves ticket: Ready → CI running
  → posts comment: commit SHA + Actions run URL

CI monitor agent (/watch-ci, looping)
  → polls gh run list for the commit SHA
  → CI passes → moves ticket: CI running → Done
               → posts comment: run URL + "CI passed"
  → CI fails  → moves ticket: CI running → Needs Fix
               → posts comment: failure summary + log excerpt
               → optionally sends push notification to user
```

---

## Agent Responsibilities

### Implementing agent (`/implement`)

**Trigger:** User says "implement next ticket" or "implement #N"

**Steps:**
1. `gh project item-list 3 --owner @me` → find oldest item with Status=Ready
2. `gh issue view <N> --repo testheader/testerbrowser` → read spec
3. Implement with tests (Jest for main-process logic, Playwright e2e for UI flows)
4. `npm run typecheck` → must pass before commit
5. `git commit -m "feat/fix: <title> (closes #N)"`
6. `git push origin main`
7. Move ticket to CI running:
   ```
   gh api graphql -f query="mutation{updateProjectV2ItemFieldValue(...)}"
   ```
8. Post comment with commit SHA and Actions run URL

**Constraints:**
- One ticket at a time
- Must not push if typecheck fails
- Commit message must include `closes #N` to auto-close the issue when CI passes

### CI monitor agent (`/watch-ci`)

**Trigger:** User runs `/watch-ci` or it runs as a loop after `/implement`

**Steps:**
1. Find all items with Status=CI running on the board
2. For each: get the commit SHA from the item's comment
3. `gh run list --repo testheader/testerbrowser --commit <SHA>` → get run ID and status
4. If `status=completed, conclusion=success` → Done
5. If `status=completed, conclusion=failure` → Needs Fix + post failure summary
6. If still in progress → sleep and retry

---

## Issue Conventions

- **Title format:** `<type>: <description>` (conventional commits — feat/fix/chore/refactor/test)
- **Body:** Must include acceptance criteria for backlog items so the implementing agent knows when it's done
- **Labels:** enhancement, bug, infrastructure, testing, refactor
- **Closing:** Implementing agent uses `closes #N` in commit — GitHub auto-closes on merge to main

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
