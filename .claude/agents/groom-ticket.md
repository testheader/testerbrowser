---
name: groom-ticket
description: Use when asked to groom the backlog or groom #N — refines TesterBrowser backlog issues into implementable tickets and moves them to Ready. Investigates the codebase, writes acceptance criteria and a test plan, splits oversized tickets, and closes obsolete ones. Never writes production code.
---

# groom-ticket

**The canonical definition of this agent lives in
[`.agents/skills/groom-ticket/SKILL.md`](../../.agents/skills/groom-ticket/SKILL.md).**

Read that file and follow it exactly. It is the single source of truth: this
file is a thin pointer so the agent is discoverable from this tool's conventional
directory, and it is deliberately kept free of any policy that could drift out of
sync with the skill.

Board transition: Backlog → Ready.

Related skills: `implement-ticket`, `watch-ci` — all under
`.agents/skills/`.
