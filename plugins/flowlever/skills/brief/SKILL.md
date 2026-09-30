---
name: brief
description: >
  Compose an implementation-ready brief for a feature once its FlowLever readiness gate is
  green, pulling together the spec, work items, designs, resolved decisions, and known
  tradeoffs. Use when the user says "implementation brief for X", "hand off X to the devs",
  "is X ready to build", "/flowlever:brief", or "write the build brief for X".
---

# /flowlever:brief — implementation handoff brief

You produce the document an engineer can pick up and build from, grounded in the feature's
real sources and its FlowLever ledger.

## 1. Gate check
```
FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" readiness <id>
```
- Gate `ready` → proceed.
- Gate `in-progress` / `not-ready` → **warn loudly**, list the open blockers and majors, and
  ask the user whether to (a) stop and run `/flowlever:rework` first, or (b) generate a
  *provisional* brief with the open issues called out as "⚠ unresolved — do not start these
  parts yet". Default to (a) unless they say go.

## 2. Gather material
- Re-fetch the spec, work items, and Figma frames via MCP (read only) so the brief reflects
  the current state — load tools with ToolSearch first.
- Load the ledger context:
  - `FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" finding list <id> --status resolved --json` → decisions that were settled
    (each resolved finding is a question that's now answered — fold the answer into the brief).
  - `FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" finding list <id> --status waived --json` → **known tradeoffs**: list each
    with its reason as "Accepted limitation".
  - `FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" report <id>` → the coverage matrix becomes your work breakdown.

## 3. Compose the brief
Write a clean, skimmable brief with these sections:
1. **Summary & goal** — what we're building and why (from spec goals).
2. **Scope** — in-scope work items (the ADO IDs), explicitly out-of-scope items.
3. **User flow** — the happy path plus the error/edge cases the spec defines.
4. **Designs** — the Figma frames per flow step (linked), and any frame still missing (flag it).
5. **Decisions settled during spec validation** — from resolved findings (e.g. "Twint IS in
   the launch set; webhook task is AB#…").
6. **Known limitations / accepted tradeoffs** — from waived findings, with reasons.
7. **Work breakdown** — derived from the coverage matrix (section → work items), noting any
   `uncovered` section or `orphan` item as a gap to confirm before starting.
8. **Acceptance criteria** — consolidated from the work items; flag any that are still vague.
9. **Open risks** — anything `in-progress`, plus feasibility findings.

Write it to `${FLOWLEVER_DATA:-$HOME/.flowlever}/briefs/<id>.md` (create the `briefs/` dir if
needed: `mkdir -p "${FLOWLEVER_DATA:-$HOME/.flowlever}/briefs"`). Keep it tight — a brief, not a novel.

## 4. Offer to attach (confirmation required)
Ask whether to attach the brief to the lead ADO story (e.g. as a comment via
`mcp__azure-devops__wit_add_work_item_comment`) or as a Confluence child page
(`mcp__claude_ai_Atlassian_Rovo__createConfluencePage`). **Only do this on an explicit yes.**
Otherwise leave it as the local markdown file and tell the user where it is.
