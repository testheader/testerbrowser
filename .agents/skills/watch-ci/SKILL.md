---
name: watch-ci
description: Use when asked to watch CI, monitor a running build, or check whether a pushed ticket passed — for the TesterBrowser kanban board. Reconciles the board from labels, polls every CI Running ticket until it resolves, then moves it to Done (closing the issue) or Needs Fix with a failure summary. Runs unattended to completion.
---

# Watch CI — TesterBrowser

You close the loop on tickets that `implement-ticket` has pushed for
`testheader/testerbrowser`.

Board: https://github.com/users/testheader/projects/3

**This is an automated process.** Once invoked you run to completion without
checking in: reconcile the board, poll every CI Running ticket, and resolve each
one to Done or Needs Fix. Being asked to watch CI is authority to do all of
that, including pushing a trivial fix to keep `main` green. Nothing here waits
for a human — every branch of the decision tree ends in a label the next agent
can act on. Report once, at the end.

## Source of truth

`status-*` **labels are the source of truth**; the board column is the view.
You have project credentials, so you update **both** on every transition — and
in Step 0 you repair any board column that has drifted from its label.

`status-backlog` → `status-ready` → `status-in-progress` → `status-ci-running`
→ `status-done` | `status-needs-fix`

Exactly one `status-*` label per issue at a time.

## Definition of Done

**A ticket stays open until it reaches Done.** You are the only agent that
closes an issue, and only when CI for its commit has completed successfully.
`status-ci-running` and `status-needs-fix` issues stay open.

Commits use `refs #N`, never `closes #N`, precisely so that pushing to `main`
cannot close a ticket before CI has proved it.

---

## Step 0 — Check the token budget

**Do this first, and again before each polling round.** Read `total_tokens`
remaining from the system reminder.

| Tokens left | Action |
|---|---|
| **> 20,000** | Run the full sweep and poll normally. |
| **8,000–20,000** | Finish the tickets you are already tracking, but don't start a Case A inline fix — go straight to Needs Fix so nothing is left half-done. |
| **< 8,000** | **Stop.** Report the state of every ticket you were watching and hand back. |

Polling is cheap per round but unbounded in length — a slow CI run can drain a
session by attrition. Two things keep that in check: wait the full 180 s between
rounds rather than polling tightly, and read only what you need from the API
(`--jq` filters, `--log-failed` rather than whole logs).

Ending a watch session early is safe: labels hold all the state, so a fresh
session resumes cleanly. Leaving a ticket **mid-Case-A** is not safe — the fix
may be pushed but unmonitored — so never begin an inline fix you cannot see
through to its next verdict.

## Step 0a — Reconcile the board from labels

Before anything else, correct any ticket whose board column doesn't match its
label. Labels win.

```bash
gh project item-list 3 --owner @me --format json --limit 500
```

For each item carrying a `status-*` label, compare it against the board `status`
field. Also fix any item whose board `status` is `null` — newly added items that
were never placed in a column; their label decides where they go. Use the option
IDs in Board reference.

**Do not change any labels in this step — only the board.**

## Step 0b — Sweep closed issues into Done

For every board item **not** already in Done, check whether its issue is closed.
If it is, the user closed it by hand; move it to Done (board + label + comment)
per Step 4, skipping `gh issue close` since it is already closed.

```bash
gh project item-list 3 --owner @me --format json --limit 500 \
  --jq '.items[] | select(.status != null)
        | select(.status | ascii_downcase != "done")
        | {id, number: .content.number, title: .content.title, status: .status}'

gh issue view <N> --repo testheader/testerbrowser \
  --json state,closedAt --jq '{state, closedAt}'
```

## Step 1 — Find every CI Running ticket

Run **both** queries and union the results, deduplicating by issue number.

```bash
# A — board query
gh project item-list 3 --owner @me --format json --limit 500 \
  --jq '.items[] | select(.status != null)
        | select(.status | ascii_downcase == "ci running")
        | {id, number: .content.number}'

# B — label query (catches issues not on the board, or past the board limit)
gh issue list --repo testheader/testerbrowser --label status-ci-running \
  --state open --json number,title --jq '.[]'
```

For issues found only by label, add them to the project first, then re-run
query A to get their `PVTI_*` item ID:

```bash
gh project item-add 3 --owner @me \
  --url https://github.com/testheader/testerbrowser/issues/<N>
```

If neither query returns anything after Step 0b, report "No CI Running tickets
— board is clear" and stop.

## Step 2 — Get each ticket's commit SHA

`implement-ticket` posts a comment containing `Commit: <SHA>`. Read the
comments and parse the 40-char hex SHA from the most recent one.

```bash
gh issue view <N> --repo testheader/testerbrowser --json comments \
  --jq '.comments[-1].body'
```

If no SHA is recorded, fall back to the newest commit on `main` whose message
references that issue number. If you still can't identify it, comment saying so
and leave the ticket untouched.

Note whether that handoff comment says **e2e was not run locally** — it changes
how you report an e2e failure in Step 5.

## Step 3 — Poll the Actions run

```bash
gh run list --repo testheader/testerbrowser --commit <SHA> \
  --json databaseId,status,conclusion,url --jq '.'
```

| `status` | `conclusion` | Action |
|---|---|---|
| `queued` / `in_progress` | — | Wait 180 s, then retry |
| `completed` | `success` | → Step 4 (Done) |
| `completed` | `failure` / `cancelled` | → Step 3b |

Poll at 180 s intervals. A full pipeline (typecheck → bump-version →
build-windows + e2e → publish-release) normally resolves within ~20 rounds; if a
ticket is still unresolved after **30 rounds (~90 minutes)**, treat it as stuck:
leave it on `status-ci-running`, comment with the run URL and the job that never
finished, and move on to the other tickets rather than blocking on it. Note it
in the final report.

While waiting, work another ticket's poll rather than idling — the waits
interleave.

## Step 3b — On failure, check whether main has since gone green

Trunk-based: if the **latest** run on `main` is green, everything before it is
in that build and shipping, including this ticket's code.

```bash
gh run list --repo testheader/testerbrowser --branch main --limit 1 \
  --json databaseId,status,conclusion,url --jq '.[0]'
```

| Latest main run | Action |
|---|---|
| `completed` / `success` | Feature is live in a green build → Step 4, noting the superseding run URL in the comment |
| anything else | → Step 5 |

## Step 4 — On success, move to Done

Board → Done (`07528d57`), label → `status-done`, comment, then **close the
issue**. This is the only place an issue gets closed.

```bash
# Label — remove whichever status-* labels are actually present, then add done
CURRENT_LABELS=$(gh issue view <N> --repo testheader/testerbrowser \
  --json labels --jq '.labels[].name')
REMOVE_ARGS=""
for L in status-ci-running status-needs-fix status-in-progress \
         status-ready status-backlog; do
  echo "$CURRENT_LABELS" | grep -qx "$L" && REMOVE_ARGS="$REMOVE_ARGS --remove-label $L"
done
gh issue edit <N> --repo testheader/testerbrowser $REMOVE_ARGS --add-label status-done

gh issue comment <N> --repo testheader/testerbrowser \
  --body "CI passed. Run: <RUN_URL>"

gh issue close <N> --repo testheader/testerbrowser
```

## Step 5 — On failure, triage

Scan the issue comments for prior `watch-ci` failure logs to pick a path.

### Case A — trivial fix, first failure

Only when there is **no prior `watch-ci` failure comment** on this issue *and*
the cause is genuinely small (typo, missing import, config line):

1. Apply the fix and commit it: `fix: <what> (refs #N)` — `refs`, never
   `closes`.
2. Verify it: `npm run typecheck`, `npm run lint`, `npm test`, and
   `npm run test:e2e` if the failing job was `e2e`. Never push a red tree.
3. Push it. This project is trunk-based, the fix goes straight onto `main`, and
   monitoring a run implies authority to keep it green — do not stop to ask.
   Never push to a branch or open a PR instead:
   ```bash
   git stash -u && git pull --rebase origin main && git stash pop && git push origin main
   ```
4. **Leave the status as CI running** — board and label unchanged — and comment,
   then loop back to Step 3 to monitor the new commit:
   ```
   CI failed — root cause fixed inline: <NEW_SHA>. Re-monitoring new pipeline run.
   ```

If the fix isn't obviously trivial, don't attempt it. Case B is not a failure.

### Case B — persistent or complex failure

If a Case A comment already exists, or the fix needs real design work:

```bash
gh run view <RUN_ID> --repo testheader/testerbrowser --log-failed
```

Move the ticket to Needs Fix — board (`211b4ce4`) **and** label — leaving the
issue **open**:

```bash
CURRENT_LABELS=$(gh issue view <N> --repo testheader/testerbrowser \
  --json labels --jq '.labels[].name')
REMOVE_ARGS=""
for L in status-ci-running status-done status-in-progress \
         status-ready status-backlog; do
  echo "$CURRENT_LABELS" | grep -qx "$L" && REMOVE_ARGS="$REMOVE_ARGS --remove-label $L"
done
gh issue edit <N> --repo testheader/testerbrowser $REMOVE_ARGS --add-label status-needs-fix
```

Then comment with everything the implementer needs as its starting spec:

- the failing **job name** and the run URL;
- a short plain-English summary of the cause;
- the relevant log excerpt — the failing lines in a code block, not the whole
  log;
- the exact local command that reproduces it (`npm run typecheck`,
  `npm run lint`, `npm test`, or `npx playwright test e2e/<name>.spec.ts`);
- **how many times this ticket has already been through Needs Fix**, so the
  implementer can count attempts without re-reading every comment;
- if the handoff said e2e was not run locally and `e2e` is what failed, say so —
  that is unverified work, not a regression.

## Step 6 — Loop, then stop

Process every CI Running ticket, then re-check the budget (Step 0) and the
board. If new items appeared and you have budget, handle them; otherwise report
which tickets went to Done, which need attention, and terminate cleanly.

Between rounds, drop the log excerpts and API output you have already acted on —
keep only each ticket's number, verdict and run URL for the final report.

`status-needs-fix` is the top of `implement-ticket`'s queue, so anything you
park there gets picked up before new work.

## Constraints

- **Never edit code except in Case A**, and never for anything beyond a genuinely
  trivial first-time failure. Otherwise hand back to `implement-ticket`.
- Never move a ticket to Done on a run that has not completed successfully
  (Step 3b's green-main rule is the one exception), and never close an issue
  that isn't Done.
- Don't touch tickets that aren't `status-ci-running`, except in the Step 0/0b
  sweeps.
- Always update **both** the label and the board column.
- Check the budget before each round; never begin a Case A inline fix you cannot
  monitor through to its next verdict.
- Trunk-based only: a Case A fix is committed onto `main`. Never create a branch
  or open a PR.
- Run unattended once started — never pause mid-loop to ask. Anything you cannot
  decide autonomously becomes Case B, which is a normal outcome, not a failure.
- Keep failure comments short and actionable — the next agent reads them as its
  spec and will try to reproduce from what you wrote, so name the failing job
  and the command precisely.

## Board reference

```
Project number:  3   (owner @me)
Project ID:      PVT_kwHOA2Pe484BiHJY
Status field ID: PVTSSF_lAHOA2Pe484BiHJYzhhAV-0
Repo:            testheader/testerbrowser
```

| Column | Option ID | Label |
|---|---|---|
| Backlog | `adf7ac3d` | `status-backlog` |
| Ready | `70a64391` | `status-ready` |
| In progress | `978f4b40` | `status-in-progress` |
| CI running | `78882a20` | `status-ci-running` |
| Needs Fix | `211b4ce4` | `status-needs-fix` |
| Done | `07528d57` | `status-done` |

```bash
gh api graphql \
  -f query='mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){projectV2Item{id}}}' \
  -f p="PVT_kwHOA2Pe484BiHJY" -f i="<ITEM_ID>" \
  -f f="PVTSSF_lAHOA2Pe484BiHJYzhhAV-0" -f o="<OPTION_ID>"
```

## Common issues

- **Run not listed yet** — `gh run list` can be empty right after a push. Wait
  5–10 s and retry.
- **Multiple runs for one SHA** — take the most recent (`.[0]`, the default
  sort).
- **No SHA in the comments** — `implement-ticket` may still be running. Wait and
  retry, or fall back to matching `refs #N` in recent `main` commit messages.
