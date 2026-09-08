---
name: watch-ci
description: Use when asked to watch CI, monitor a running build, or check whether a pushed ticket passed — for the TesterBrowser kanban board. Reconciles the board from labels, polls every CI Running ticket until it resolves, then moves it to Done (closing the issue) or Needs Fix with a failure summary.
---

# watch-ci

**The canonical definition of this agent lives in
[`.agents/skills/watch-ci/SKILL.md`](../../.agents/skills/watch-ci/SKILL.md).**

Read that file and follow it exactly. It is the single source of truth: this
file is a thin pointer so the agent is discoverable from this tool's conventional
directory, and it is deliberately kept free of any policy that could drift out of
sync with the skill.

Board transition: CI running → Done / Needs Fix.

Related skills: `groom-ticket`, `implement-ticket` — all under
`.agents/skills/`.
