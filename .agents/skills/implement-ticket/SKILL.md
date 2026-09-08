---
name: implement-ticket
description: Use when the user says "implement next ticket", "implement #N", or asks you to pick up the next ready item — for the TesterBrowser kanban board (GitHub Projects #3, testheader/testerbrowser). Picks up Needs Fix tickets before Ready ones, implements with tests, verifies locally, pushes to main, and hands off to CI monitoring.
---

# Implement a ticket — TesterBrowser

You implement **one ticket at a time** for `testheader/testerbrowser`.

Board: https://github.com/users/testheader/projects/3

## Source of truth

`status-*` **labels are the source of truth** for ticket state — the board's
Status column is not reachable from the plain issues API. But you have project
credentials, so **update both on every transition**: the label first (it is
canonical), then the board column (it is the view). See "Board reference" at the
end for the IDs and the exact mutation.

| Label | Board column | Meaning |
|---|---|---|
| `status-backlog` _(or no status label)_ | Backlog | Not groomed / not selected |
| `status-ready` | Ready | Groomed and queued for implementation |
| `status-in-progress` | In progress | You are working on it right now |
| `status-ci-running` | CI running | Pushed to main, CI is executing |
| `status-needs-fix` | Needs Fix | CI failed, notes posted as a comment |
| `status-done` | Done | CI passed, feature shipped, issue closed |

Exactly **one** `status-*` label at a time. Every transition removes the old one
and adds the new one in the same step. Non-status labels (`enhancement`, `bug`,
`ui`, …) are untouched.

## Definition of Done

**A ticket stays open until it reaches Done.**

- Never write `closes #N` / `fixes #N` in a commit message — pushing to `main`
  would auto-close the issue before CI has proved anything. Use `refs #N`.
- You never close an issue. Only `watch-ci` closes it, and only once CI is green
  and the label is `status-done`.
- Your job ends at `status-ci-running`, not at "code pushed".

## Step 1 — Pick the ticket

If the user named an issue (`implement #31`), use that one. Otherwise work the
queues **in priority order** and take the lowest-numbered open issue in the
first non-empty one:

1. **`status-needs-fix`** — always first. That work is already on `main` and
   already red; finishing it beats starting something new.
2. **`status-ready`** — groomed and queued.

```bash
gh issue list --repo testheader/testerbrowser --state open \
  --label status-needs-fix --json number,title --jq '.[]'
gh issue list --repo testheader/testerbrowser --state open \
  --label status-ready --json number,title --jq '.[]'
```

If both queues are empty, say so and stop. Promoting Backlog → Ready is the
`groom-ticket` skill's job, not yours.

**Check for a stale claim first.** If an issue is already `status-in-progress`,
a previous run is either still going or died. If it was updated recently, stop
and report — one ticket at a time. If it has been untouched for a day or more,
it was abandoned: say so, read its comments to see how far the last run got, and
reclaim it rather than starting something new on top of it.

**Check the ticket is ready.** It must have testable acceptance criteria. If it
doesn't, don't guess the scope and don't interrogate the user — comment saying
what is missing, move it back to Backlog (`status-backlog`), recommend running
`groom-ticket` on it, and move to the next ticket in the queue.

## Step 2 — Claim it

Swap the current status label → `status-in-progress`, update the board, and
comment that you have picked it up.

```bash
gh issue edit <N> --repo testheader/testerbrowser \
  --add-label status-in-progress \
  --remove-label status-ready --remove-label status-needs-fix
```

Then move the board item to **In progress** (`978f4b40`) — see Board reference.

## Step 3 — Read the spec

```bash
gh issue view <N> --repo testheader/testerbrowser --comments
```

The acceptance criteria are the contract and "out of scope" bounds it. Implement
against them, not against assumptions. If a detail is merely *unknown* — which
file, which IPC channel, how a panel works — resolve it by reading the code.
Only genuine product ambiguity goes back to `groom-ticket`.

## Step 4 — Explore, then post your approach

Read the relevant modules first. `.github/copilot-instructions.md` has the
layout, test conventions and CI graph; `CLAUDE.md` has the IPC channel table,
panel behaviour and the hard-won gotchas — read it before touching
main/preload/renderer.

Then comment on the issue with two or three sentences: the files you'll touch,
the tests you'll add, any risk you spotted. You are **not** waiting for
approval; this exists so a wrong direction is visible early. Skip it only for
genuinely one-line changes.

## Step 5 — Implement

Where things go in the current architecture:

| Change | Where |
|---|---|
| Backend / session logic | `src/main/sessionManager.ts` |
| IPC handler | `src/main/index.ts` (`ipcMain.handle`) |
| Preload exposure | `src/preload/index.ts` (`contextBridge`) |
| New renderer module | create `renderer/<feature>.js`, export `init<Feature>()`, import and call it from `renderer/main.js` |
| New console-panel tab | `renderer/index.html` (tab button + panel div), `renderer/console-tabs.js` (switch + init), `renderer/style.css` |

**`renderer/renderer.js` is the legacy monolith** — superseded by the module
split, no longer loaded by `index.html`, and ESLint-ignored. Never add to it;
code you put there will not run. `renderer/main.js` is the entry point.

Test-first where practical:

- Main-process / pure logic → Jest, in `src/**/__tests__/*.test.ts`.
  **A `*.test.ts` outside a `__tests__` directory is silently never run** —
  `jest.config.js` matches nothing else.
- UI and end-to-end flows → Playwright, in `e2e/*.spec.ts`, launched via
  `launchApp()` from `e2e/helpers.ts` so each run gets an isolated profile.
- **Confirm any new test file actually ran** — see it named in the Jest or
  Playwright output. A green run that skipped your test proves nothing.

Keep the change surgical. Don't refactor unrelated code, don't delete or weaken
existing tests, don't add dependencies without a clear need.

## Step 6 — Verify locally (all four must pass)

```bash
npm run typecheck
npm run lint
npm test
npm run test:e2e
```

This is trunk-based development: your push goes straight to `main` and CI runs
the full suite on every push, so anything you skip locally breaks `main` for
everyone. **e2e is not optional.**

E2E needs `better-sqlite3` rebuilt for Electron
(`npx electron-rebuild -f -w better-sqlite3`) and a display — on headless Linux
use `xvfb-run`. If you genuinely cannot run it, say so **explicitly in your
handoff comment and to the user** ("e2e not run locally: `<reason>`") so an e2e
failure is read as unverified work rather than a regression. Never silently skip
it.

If anything fails, fix it. Never push a red tree.

## Step 7 — Commit

Conventional-commits prefix, because CI parses it to choose the version bump:
`feat:` → minor, `feat!:` / `BREAKING CHANGE` → major, anything else → patch.
Never bump `package.json` yourself — CI owns the version.

```bash
git add <specific files>
git commit -m "<type>: <ticket title> (refs #<N>)"
```

`refs #N`, never `closes #N` — see Definition of Done.

## Step 8 — Push to main

`bump-version` pushes a `chore: bump version …` commit back after every
successful run, so your local `main` is probably stale:

```bash
git stash -u && git pull --rebase origin main && git stash pop && git push origin main
```

Re-run the checks if the rebase pulled in anything substantive. Never
force-push `main`.

## Step 9 — Hand off to CI

Swap `status-in-progress` → `status-ci-running`, move the board item to
**CI running** (`78882a20`), and post the SHA and run URL so `watch-ci` can find
the run without guessing.

```bash
gh issue edit <N> --repo testheader/testerbrowser \
  --add-label status-ci-running --remove-label status-in-progress

SHA=$(git rev-parse HEAD)
RUN_URL=$(gh run list --repo testheader/testerbrowser --commit "$SHA" \
  --json url --jq '.[0].url')
gh issue comment <N> --repo testheader/testerbrowser \
  --body "Implemented. Commit: $SHA
Actions: $RUN_URL"
```

If the run isn't listed yet, wait 5–10 s and retry.

## Step 10 — Report and stop

Report to the user: what changed, which checks you ran (and any you could not),
the SHA, the run URL, and that the ticket is now waiting on CI. Then run
`watch-ci`, or hand back.

Do **not** loop straight into another ticket in the same session — start a fresh
one so context stays bounded.

## Fixing a failed ticket

A `status-needs-fix` ticket is code **already on `main`** whose CI run went red.
Treat it as a continuation, not new work:

- Read the failure comment `watch-ci` left — failing job, run URL, log excerpt.
  That comment is your spec; the original acceptance criteria still apply.
- **Reproduce the failure locally first** (`npm run typecheck`, `npm run lint`,
  `npm test`, `npm run test:e2e` — whichever job went red) before changing
  anything. If you can't reproduce it, say so and read the run logs rather than
  guessing.
- Fix forward with the smallest change that makes CI green. Don't revert the
  original commit unless asked, and don't "fix" a red test by deleting or
  weakening it.
- Never open a new issue for the fix; the existing ticket carries it through.
- Then run Steps 4–9 as normal, committing with the same `refs #N`.

**Count your attempts before you start.** The issue comments record every
previous attempt. If this ticket has already been through
`needs-fix → in-progress → ci-running → needs-fix` **twice**, stop. Comment with
what was tried, what each attempt assumed, and why you think it keeps failing;
leave it `status-needs-fix` and escalate. Three identical failures means the
ticket or the approach is wrong, not that the next attempt will land.

If the failure is flaky or unrelated to this ticket, say so explicitly rather
than quietly re-pushing — a re-run may be the right answer, and that is the
user's call.

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
  or one spec with `npx playwright test e2e/<name>.spec.ts`.
- **build-windows** / **publish-release** package and ship the release; they fail
  on packaging concerns, not on your feature logic.

## Stop and ask

Finish the ticket you claimed; don't let it grow into a different one. Stop,
comment on the issue, and check with the user when:

- the change is spreading well beyond the files named in the ticket's
  implementation notes, or into modules it never mentioned;
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
- Never push if typecheck, lint, unit tests or e2e fail.
- Never close an issue and never set `status-done` — that is `watch-ci`'s call.
- Never add to `renderer/renderer.js`.
- Always update **both** the label and the board column on every transition.
- If you cannot complete the ticket, leave it `status-in-progress`, comment
  explaining exactly where you stopped and why, and tell the user.

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

To move a board item:

```bash
ITEM_ID=$(gh project item-list 3 --owner @me --format json \
  --jq ".items[] | select(.content.number == <N>) | .id")

gh api graphql \
  -f query='mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){projectV2Item{id}}}' \
  -f p="PVT_kwHOA2Pe484BiHJY" -f i="$ITEM_ID" \
  -f f="PVTSSF_lAHOA2Pe484BiHJYzhhAV-0" -f o="<OPTION_ID>"
```

If the issue isn't on the board yet, add it first:

```bash
gh project item-add 3 --owner @me \
  --url https://github.com/testheader/testerbrowser/issues/<N>
```

If a mutation fails, the label is still correct — say so and carry on; `watch-ci`
reconciles the board from labels on its next run.
