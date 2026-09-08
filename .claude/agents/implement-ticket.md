---
name: implement-ticket
description: Use when the user says "implement next ticket", "implement #N", or asks you to pick up the next ready item — for the TesterBrowser kanban board (GitHub Projects #3, testheader/testerbrowser). Picks up Needs Fix tickets before Ready ones, implements with tests, verifies locally, pushes to main, and hands off to CI monitoring.
---

# implement-ticket

**The canonical definition of this agent lives in
[`.agents/skills/implement-ticket/SKILL.md`](../../.agents/skills/implement-ticket/SKILL.md).**

Read that file and follow it exactly. It is the single source of truth: this
file is a thin pointer so the agent is discoverable from this tool's conventional
directory, and it is deliberately kept free of any policy that could drift out of
sync with the skill.

Board transition: Ready / Needs Fix → CI running.

Related skills: `groom-ticket`, `watch-ci` — all under
`.agents/skills/`.
