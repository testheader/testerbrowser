---
name: implement
description: Use when the user says "implement next ticket", "implement #N", or asks you to pick up the next ready item — for the TesterBrowser project kanban board (GitHub Projects #3, testheader/testerbrowser).
---

# Implement — TesterBrowser Kanban

## Overview

Implements Ready tickets from the kanban board. Scales parallelism based on token budget: spawns multiple worktree subagents when budget is ample, falls back to sequential inline work when tokens are low. Loops until all Ready tickets are done or budget is exhausted.

---

## Step 0 — Check token budget (do this first, every loop)

Read `total_tokens` from the system reminder. Choose a strategy:

| Tokens left | Strategy |
|---|---|
| > 30,000 | Parallel: spawn **2** worktree subagents |
| 12,000–30,000 | **Inline**: implement 1 ticket in this session, then loop |
| < 12,000 | **Stop.** Report board state & recap the work done. Do not start new work. |

---

## Step 1 — Pick tickets

```bash
gh project item-list 3 --owner @me --format json
```

Pick by priority (lowest issue number first):

**Priority 1 — Needs Fix** (`status = "Needs Fix"`): always pick these first (lowest issue number first). Read the latest CI failure from the issue comments to understand what broke, then fix it.

**Priority 2 — Ready** (`status = "Ready"`): pick oldest first.

Select N tickets where N = parallelism count from the token table.

---

## Step 2 — Move each picked ticket to In Progress (parallel)

For each ticket simultaneously — update **both** the board and the label:

```bash
ITEM_ID=$(gh project item-list 3 --owner @me --format json \
  --jq ".items[] | select(.content.number == <N>) | .id")

# Board
gh api graphql \
  -f query='mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){projectV2Item{id}}}' \
  -f p="PVT_kwHOA2Pe484BiHJY" -f i="$ITEM_ID" \
  -f f="PVTSSF_lAHOA2Pe484BiHJYzhhAV-0" -f o="978f4b40"

# Labels
gh issue edit <N> --repo testheader/testerbrowser \
  --add-label "status-in-progress" \
  --remove-label "status-ready" --remove-label "status-needs-fix"
```

---

## Step 3a — Inline path (1 ticket, tokens < 30,000)

Implement the ticket in this session (steps 4–9 below), then go back to Step 0.

---

## Step 3b — Parallel path (2 tickets, tokens > 30,000)

**Spawn one fork subagent per ticket in a single message** (parallel launch). Use `subagent_type: "fork"` so each inherits full context. Each fork runs **fully independently** — it implements, typechecks, commits, pushes, moves status, and posts its comment on its own.

Each fork uses the stash+rebase+push pattern to handle concurrent pushes safely:
```bash
git stash -u && git pull --rebase origin main && git stash pop && git push origin main
```
If push is rejected, retry the stash+rebase+push once more.

Forks report back their final commit SHA and CI run URL when done.

---

## Step 4 — Read the spec

```bash
gh issue view <N> --repo testheader/testerbrowser
```

Implement against acceptance criteria only — not assumptions.

**Key patterns:**
- New backend logic → `src/main/sessionManager.ts`
- New IPC handlers → `src/main/index.ts` (`ipcMain.handle`)
- New preload exposures → `src/preload/index.ts` (`contextBridge`)
- New renderer tab → `renderer/index.html` (tab button + panel div), `renderer/console-tabs.js` (switch + init), `renderer/renderer.js` (import + call), `renderer/style.css`
- New renderer module → create `renderer/<feature>.js`, export `init<Feature>()`

---

## Step 5 — Typecheck (must pass before commit)

```bash
npm run typecheck
```

Fix all TypeScript errors. **Never commit or push if this fails.**

---

## Step 6 — Commit

```bash
git add <specific files>
git commit -m "<type>: <ticket title> (closes #N)"
```

Commit type from issue title prefix: `feat`, `fix`, `chore`, `refactor`.

---

## Step 7 — Push (inline path)

```bash
git stash -u && git pull --rebase origin main && git stash pop && git push origin main
```

---

## Step 8 — Move to CI Running (board + label)

```bash
# Board
gh api graphql \
  -f query='mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){projectV2Item{id}}}' \
  -f p="PVT_kwHOA2Pe484BiHJY" -f i="$ITEM_ID" \
  -f f="PVTSSF_lAHOA2Pe484BiHJYzhhAV-0" -f o="78882a20"

# Label
gh issue edit <N> --repo testheader/testerbrowser \
  --add-label "status-ci-running" \
  --remove-label "status-in-progress"
```

---

## Step 9 — Post comment

```bash
SHA=$(git rev-parse HEAD)
RUN_URL=$(gh run list --repo testheader/testerbrowser --commit "$SHA" --json url --jq '.[0].url')
gh issue comment <N> --repo testheader/testerbrowser \
  --body "Implemented. Commit: $SHA
Actions: $RUN_URL"
```

If the run isn't listed yet, wait a few seconds and retry.

---

## Step 10 — Continue via fresh subagent

After finishing all N tickets in this batch, **do not loop in this session**. Instead:

1. Report: which tickets were completed, commit SHAs, CI run URLs.
2. Spawn a **non-fork** subagent (omit `subagent_type` to get a fresh context) with this prompt:

```
You are continuing a TesterBrowser kanban implementation run.
Working dir: C:\Users\vdlge\source\repos\QABrowse\testerbrowser_extracted\testerbrowser
Repo: testheader/testerbrowser

Invoke the `implement` skill and follow it from Step 0.
```

3. Exit this session. The fresh subagent starts with zero accumulated context, keeping every batch bounded.

---

## Subagent prompt template

When spawning a fork for ticket `#<N>`, use this self-contained prompt:

```
You are a worktree subagent implementing ticket #<N> for TesterBrowser.

Working dir: C:\Users\vdlge\source\repos\QABrowse\testerbrowser_extracted\testerbrowser
Repo: testheader/testerbrowser
Project ID: PVT_kwHOA2Pe484BiHJY
Field ID: PVTSSF_lAHOA2Pe484BiHJYzhhAV-0

## Your task
1. Call EnterWorktree with name "ticket-<N>" to get an isolated git branch.
2. Read the spec: gh issue view <N> --repo testheader/testerbrowser
3. Implement the feature. Common patterns:
   - Backend → src/main/sessionManager.ts
   - IPC → src/main/index.ts (ipcMain.handle) + src/preload/index.ts (contextBridge)
   - UI tab → renderer/index.html, renderer/console-tabs.js, renderer/renderer.js, renderer/style.css
   - New module → renderer/<feature>.js
4. Run typecheck: npm run typecheck — fix ALL errors before committing.
5. Stage and commit:
   git add <files>
   git commit -m "<type>: <title> (closes #<N>)"
6. Push to main (retry loop on conflicts):
   for i in {1..3}; do
     git stash -u && git pull --rebase origin main && git stash pop && git push origin main && break
     echo "Push rejected by concurrent push. Retrying in 10s..."
     sleep 10
   done
7. Move ticket to CI Running — board AND label:
   ITEM_ID=$(gh project item-list 3 --owner @me --format json --jq ".items[] | select(.content.number == <N>) | .id")
   gh api graphql -f query='mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){projectV2Item{id}}}' -f p="PVT_kwHOA2Pe484BiHJY" -f i="$ITEM_ID" -f f="PVTSSF_lAHOA2Pe484BiHJYzhhAV-0" -f o="78882a20"
   gh issue edit <N> --repo testheader/testerbrowser --add-label "status-ci-running" --remove-label "status-in-progress"
8. Post comment with commit SHA and Actions URL.
9. Report back: commit SHA, CI run URL, files changed, and status.
```

---

## Board Reference

| Status | Option ID | Label |
|---|---|---|
| Ready | `70a64391` | `status-ready` |
| In Progress | `978f4b40` | `status-in-progress` |
| CI Running | `78882a20` | `status-ci-running` |
| Needs Fix | `211b4ce4` | `status-needs-fix` |
| Done | `07528d57` | `status-done` |

```
Project number:  3
Project ID:      PVT_kwHOA2Pe484BiHJY
Status field ID: PVTSSF_lAHOA2Pe484BiHJYzhhAV-0
Repo:            testheader/testerbrowser
```

## Hard constraints

- Never push if typecheck fails.
- `closes #N` in the commit message is required (GitHub auto-closes on merge).
- Move to CI Running only after push succeeds.
- Always update both the board AND the label on every status transition.
- Fork subagents must handle their own pushes using the rebase safety loop.
- Stop the loop when tokens fall below 12,000.
