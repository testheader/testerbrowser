---
name: watch-ci
description: Use when asked to watch CI, monitor a running build, or check if a pushed ticket passed — for the TesterBrowser kanban board. Polls all CI Running tickets until each resolves to Done or Needs Fix. Also sweeps all non-Done columns for issues that have been closed directly on GitHub.
---

# Watch CI — TesterBrowser Kanban

## Overview

1. Sweeps all non-Done board tickets: any whose GitHub issue is already **closed** gets moved to Done immediately.
2. Finds all CI Running tickets, polls their GitHub Actions runs, and updates their status based on completion.

Always updates **both** the Projects v2 board and the issue label on every status transition.

---

## Steps

### 0. Sync labels → board (labels are source of truth)
Before doing anything else, correct any ticket whose board column doesn't match its `status-*` label.

```bash
gh project item-list 3 --owner @me --format json --limit 500
```

For each item that has a `status-*` label, compare it against the board `status` field. Also fix any item whose board `status` is `null` — these are newly added items that haven't been placed in a column yet; their label decides the correct column:

| Label | Expected column | Option ID |
|---|---|---|
| `status-backlog` | Backlog | `adf7ac3d` |
| `status-ready` | Ready | `70a64391` |
| `status-in-progress` | In progress | `978f4b40` |
| `status-ci-running` | CI running | `78882a20` |
| `status-needs-fix` | Needs Fix | `211b4ce4` |
| `status-done` | Done | `07528d57` |

For every mismatch, move the board item to the column that matches the label:
```bash
gh api graphql \
  -f query='mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){projectV2Item{id}}}' \
  -f p="PVT_kwHOA2Pe484BiHJY" -f i="<ITEM_ID>" -f f="PVTSSF_lAHOA2Pe484BiHJYzhhAV-0" -f o="<OPTION_ID>"
```

Do **not** change any labels in this step — only fix the board.

---

### 0b. Sweep closed issues → Done
For every board item **not** already in Done, check if the GitHub issue is closed. If it is, move it to Done (board + label + close comment) using the same commands as Step 4. Do this for all columns: Ready, Backlog, In progress, CI Running, Needs Fix.

```bash
# Get all non-Done items with their issue numbers
gh project item-list 3 --owner @me --format json --limit 500 \
  --jq '.items[] | select(.status != null) | select(.status | ascii_downcase != "done") | {id, number: .content.number, title: .content.title, status: .status}'
```

For each result, check the issue state:
```bash
gh issue view <N> --repo testheader/testerbrowser --json state,closedAt --jq '{state, closedAt}'
```

If `state == "CLOSED"`: apply Step 4 (board → Done, label → status-done, comment, gh issue close — skip close if already closed).

---

### 1. Find all CI Running tickets
Run **both** queries and union the results (deduplicate by issue number):

**A — board query:**
```bash
gh project item-list 3 --owner @me --format json --limit 500 \
  --jq '.items[] | select(.status != null) | select(.status | ascii_downcase == "ci running") | {id, number: .content.number}'
```

**B — label query (catches issues not on the board or past the board limit):**
```bash
gh issue list --repo testheader/testerbrowser --label "status-ci-running" --state open \
  --json number,title --jq '.[]'
```

Process the union of both. For issues found only via label (not on the board), add them to the project first:
```bash
gh project item-add 3 --owner @me --url https://github.com/testheader/testerbrowser/issues/<N>
```
Then re-run the board query to get their `PVTI_*` item ID before updating.

If none found in either query after Step 0b, report "No CI Running tickets — board is clear." and stop.

### 2. Get the commit SHA for each ticket
The implementing agent posts a comment containing `Commit: <SHA>`. Extract it:
```bash
gh issue view <N> --repo testheader/testerbrowser --json comments \
  --jq '.comments[-1].body'
```
Parse the SHA from that comment body (40-char hex after `Commit: `).

### 3. Poll the Actions run
```bash
gh run list --repo testheader/testerbrowser --commit <SHA> \
  --json databaseId,status,conclusion,url \
  --jq '.'
```

| `status` | `conclusion` | Action |
|---|---|---|
| `in_progress` / `queued` | — | Wait 180 seconds (3 minutes), then retry loop. |
| `completed` | `success` | → Step 4 (Move to Done) |
| `completed` | `failure` / `cancelled` | → Step 3b (Check latest main run) |

---

### 3b. On failure — check if a subsequent main build is green
Before triaging, check whether the latest run on `main` succeeded (which would mean a later commit fixed the issue and this ticket's code is now shipping):
```bash
gh run list --repo testheader/testerbrowser --branch main --limit 1 \
  --json databaseId,status,conclusion,url --jq '.[0]'
```

| Latest main run | Action |
|---|---|
| `completed` / `success` | The feature is live in a green build. → Step 4 (Move to Done), noting the superseding run URL in the comment. |
| anything else | → Step 5 (Triage and Act) |

---

### 4. On success — move to Done (board + label)
```bash
# Board
gh api graphql \
  -f query='mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){projectV2Item{id}}}' \
  -f p="PVT_kwHOA2Pe484BiHJY" -f i="<ITEM_ID>" -f f="PVTSSF_lAHOA2Pe484BiHJYzhhAV-0" -f o="07528d57"

# Label — remove only the status-* labels currently on the issue, then add status-done
CURRENT_LABELS=$(gh issue view <N> --repo testheader/testerbrowser --json labels --jq '.labels[].name')
REMOVE_ARGS=""
for L in status-ci-running status-needs-fix status-in-progress status-ready status-backlog; do
  echo "$CURRENT_LABELS" | grep -qx "$L" && REMOVE_ARGS="$REMOVE_ARGS --remove-label $L"
done
gh issue edit <N> --repo testheader/testerbrowser $REMOVE_ARGS --add-label "status-done"

gh issue comment <N> --repo testheader/testerbrowser \
  --body "CI passed. Run: <RUN_URL>"

# Close the issue — only close when reaching Done
gh issue close <N> --repo testheader/testerbrowser
```

---

### 5. On failure — triage and act
Scan the issue comments for prior watch-ci logs to determine your execution path:

#### Case A: Trivial Fix (One-Line / Config / Typo)
If there is **no prior watch-ci failure comment** on this issue, and it's a simple change:
1. Apply the inline fix to the file.
2. Run `npm run typecheck` to ensure it passes.
3. Fetch latest upstream changes and push safely:
   ```bash
   git stash -u && git pull --rebase origin main && git stash pop && git push origin main
   ```
4. **Leave status as CI Running** (board and label stay as-is). Post **Comment 1** on the issue, then loop back to monitor the new commit:
   ```
   CI failed — root cause fixed inline: <NEW_COMMIT_SHA>. Re-monitoring new pipeline run.
   ```

#### Case B: Persistent Failure / Complex Bug
If **Comment 1 already exists** OR the bug requires architectural logic changes:
1. Extract the failure logs:
   ```bash
   RUN_ID=<databaseId from step 3>
   gh run view $RUN_ID --repo testheader/testerbrowser --log-failed
   ```
2. Move the ticket to **Needs Fix** — board AND label:
   ```bash
   # Board
   gh api graphql \
     -f query='mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){projectV2Item{id}}}' \
     -f p="PVT_kwHOA2Pe484BiHJY" -f i="<ITEM_ID>" -f f="PVTSSF_lAHOA2Pe484BiHJYzhhAV-0" -f o="211b4ce4"

   # Label — remove only the status-* labels currently on the issue, then add status-needs-fix
   CURRENT_LABELS=$(gh issue view <N> --repo testheader/testerbrowser --json labels --jq '.labels[].name')
   REMOVE_ARGS=""
   for L in status-ci-running status-done status-in-progress status-ready status-backlog; do
     echo "$CURRENT_LABELS" | grep -qx "$L" && REMOVE_ARGS="$REMOVE_ARGS --remove-label $L"
   done
   gh issue edit <N> --repo testheader/testerbrowser $REMOVE_ARGS --add-label "status-needs-fix"
   ```
3. Post **Comment 2** containing the log excerpt so the implementing agent can fix it:
   ```
   CI failed. Run: <RUN_URL>
   ```
   *(Include the last 50 relevant lines of the code crash or compilation error stack inside markdown code blocks)*.

---

### 6. Loop
After processing all current CI Running tickets, check the board again. If new items have appeared, process them; otherwise, terminate the session cleanly to save token context.

---

## Board Reference

| Status | Option ID | Label |
|---|---|---|
| CI Running | `78882a20` | `status-ci-running` |
| Needs Fix | `211b4ce4` | `status-needs-fix` |
| Done | `07528d57` | `status-done` |

```
Project number:  3
Project ID:      PVT_kwHOA2Pe484BiHJY
Status field ID: PVTSSF_lAHOA2Pe484BiHJYzhhAV-0
Repo:            testheader/testerbrowser
```

## Common Issues

- **Run not yet listed:** `gh api` or `gh run list` may return empty immediately after push. Wait 5–10 s and retry.
- **Multiple runs for the same SHA:** Pick the most recent (`.[0]` after sorting by `createdAt` desc, which is the default).
- **SHA not in comment:** The comment may not exist yet if `/implement` is still running. Wait and retry.
