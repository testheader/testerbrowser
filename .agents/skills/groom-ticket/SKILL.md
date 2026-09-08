---
name: groom-ticket
description: Use when asked to groom the backlog or groom #N — refines TesterBrowser backlog issues into implementable tickets and moves them to Ready. Investigates the codebase, writes acceptance criteria and a test plan, splits oversized tickets, and closes obsolete ones. Works through the backlog one ticket at a time until it is empty or the token budget runs low. Never writes production code.
---

# Groom a ticket — TesterBrowser

You turn vague backlog issues in `testheader/testerbrowser` into tickets
`implement-ticket` can execute without asking anyone a question.

Board: https://github.com/users/testheader/projects/3

## Source of truth

`status-*` **labels are the source of truth**; the board column is the view.
You have project credentials, so update **both** on every transition. An issue
labelled `status-backlog` — or carrying no `status-*` label at all, as older
issues do — is in Backlog.

Your job is the Backlog → `status-ready` transition, and only when the ticket
genuinely meets the bar below.

## Definition of Ready

A ticket is ready when a competent implementer who has never seen it can finish
it without asking a question. The issue body must contain:

1. **Problem / motivation** — what is wrong or missing, and for whom. One
   paragraph.
2. **Acceptance criteria** — a checklist of observable, testable statements.
   "Console panel remembers its height across restarts" is testable. "Improve
   the console panel" is not. If a criterion can't become an assertion, rewrite
   it until it can.
3. **Implementation notes** — the actual files, modules and IPC channels
   involved, discovered by reading the code, not guessed. Name them.
4. **Test plan** — which unit tests (`src/**/__tests__/*.test.ts`) and which e2e
   specs (`e2e/*.spec.ts`) prove the criteria. Say whether an existing spec
   should be extended or a new one added.
5. **Out of scope** — what this ticket deliberately does not do. This is what
   stops the implementer's change sprawling.

## Step 0 — Check the token budget

**Do this first, and again before each ticket.** Read `total_tokens` remaining
from the system reminder.

| Tokens left | Action |
|---|---|
| **> 20,000** | Groom the next ticket in full — investigate the code properly. |
| **10,000–20,000** | One more ticket only, and only if it is narrow enough to investigate honestly. |
| **< 10,000** | **Stop.** Report what you groomed and hand back. |

Grooming is investigation-heavy: most of the cost is reading code, not writing
the issue. That makes running dry mid-ticket a real risk, and a half-investigated
ticket is the exact failure this skill exists to prevent — **never** apply
`status-ready` to a ticket you did not have the budget to investigate properly.
Leave it in Backlog and say so.

When the budget runs out, report which tickets you groomed, which you closed, and
which are still waiting, then recommend a fresh session — labels hold all the
state, so nothing is lost.

## Workflow

1. **Pick the issue.** The one the user named, or the most valuable open Backlog
   issue. Never groom something already past Backlog.

   ```bash
   gh issue list --repo testheader/testerbrowser --state open \
     --label status-backlog --json number,title --jq '.[]'
   ```

   Older issues predate the label — list open issues carrying no `status-*`
   label as well, and give each one `status-backlog` as you touch it.

2. **Investigate the code first.** Read the relevant modules before writing a
   word. `.github/copilot-instructions.md` has the layout, test conventions and
   CI graph; `CLAUDE.md` has the IPC channel table and panel behaviour. The
   value you add over the original one-line issue *is* this investigation — a
   groomed ticket that names no files has not been groomed.

3. **Check it's still real.** The repo has moved fast and some backlog items are
   already built. If the feature exists, comment with the evidence (file, spec)
   and close the issue as `not planned`. If it duplicates another open issue,
   close it as a duplicate. In both cases move the board item to Done or remove
   it, so the board doesn't show phantom work.

4. **Size it.** A ticket should be one focused change — roughly a handful of
   files, one coherent behaviour, reviewable in a sitting. If it's bigger, split
   it into issues that each stand alone and deliver value, link them from the
   original, and groom them individually. Prefer a vertical slice ("panel
   renders with hardcoded data") over a horizontal one ("add the data layer") so
   every ticket is shippable.

5. **Rewrite the body** into the five sections above, editing the issue body
   directly — don't bury the spec in a comment where it competes with the
   original text. Preserve any of the user's original wording that carries
   intent.

   ```bash
   gh issue edit <N> --repo testheader/testerbrowser --body-file <file>
   ```

6. **Fix the title** to conventional-commits form: `<type>: <description>`
   (`feat`, `fix`, `chore`, `refactor`, `test`, `docs`). CI parses the commit
   prefix to choose the version bump, and the implementer derives it from your
   title.

7. **Label it and move it.** Apply topic labels (`ui`, `sessions`,
   `console-panel`, `network`, `testing`, `infrastructure`, …) and the right
   kind (`enhancement` / `bug` / `refactor`). Then:

   ```bash
   gh issue edit <N> --repo testheader/testerbrowser \
     --add-label status-ready --remove-label status-backlog
   ```

   and move the board item to **Ready** (`70a64391`) — see Board reference.

8. **Report, then loop.** Say what you groomed, what you split, what you closed
   as already-done, and anything you deliberately left in Backlog. Then go back
   to Step 0 and take the next Backlog ticket. Keep looping until Backlog is
   empty or the budget runs low.

   Drop each ticket's investigation notes once its issue body is written — carry
   forward only the issue number and a one-line summary for the final report.

   If the user asked for a single named ticket (`groom #31`), don't loop —
   finish it and hand back.

## When you can't make it ready

Some tickets need a decision only the user can make — a product choice, a UX
direction, a trade-off between two valid designs.

Don't guess, and don't stall silently. Leave the issue in Backlog, write up the
options you found with a **recommendation and your reasoning**, and ask the
single specific question that unblocks it. One crisp question with a default
answer attached is worth ten rounds of clarification.

Everything that is merely *unknown* — which file, which IPC channel, how the
existing panel works — is yours to resolve by reading the code, not the user's
to answer.

## Constraints

- Check the budget before each ticket; never mark a ticket `status-ready` on an
  investigation you had to cut short.
- **Never write production code**, never open a PR, never push. You edit issues
  only. If grooming reveals a trivial fix, say so and leave a ticket for it.
- Never label a ticket `status-ready` that you would not want handed to you. A
  thin ticket is worse than an ungroomed one, because it looks safe.
- Never touch tickets that are `status-in-progress`, `status-ci-running`,
  `status-needs-fix` or `status-done` — they belong to the other skills.
- Don't invent requirements the user never asked for. Ambitious tickets are the
  user's call; your job is to make the existing intent precise.
- Always update **both** the label and the board column.

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
ITEM_ID=$(gh project item-list 3 --owner @me --format json \
  --jq ".items[] | select(.content.number == <N>) | .id")

gh api graphql \
  -f query='mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){projectV2Item{id}}}' \
  -f p="PVT_kwHOA2Pe484BiHJY" -f i="$ITEM_ID" \
  -f f="PVTSSF_lAHOA2Pe484BiHJYzhhAV-0" -f o="<OPTION_ID>"
```

If the issue isn't on the board yet:

```bash
gh project item-add 3 --owner @me \
  --url https://github.com/testheader/testerbrowser/issues/<N>
```
