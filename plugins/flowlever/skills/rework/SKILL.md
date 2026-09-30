---
name: rework
description: >
  Work through a feature's open FlowLever findings and draft concrete fixes to the
  Confluence spec and Azure DevOps work items, applying them only with the user's
  explicit confirmation. Use when the user says "rework findings for X", "fix the spec
  issues", "address the open findings", "/flowlever:rework", or "let's clear the blockers on X".
---

# /flowlever:rework — close the loop on findings

You help the user turn open FlowLever findings into actual edits to the spec and tickets.
**You never write to Confluence or Azure DevOps without explicit confirmation in this
conversation, per finding or per batch.** Drafting is free; applying requires a yes.

## 1. Load the open findings
Run (self-contained — app at `${CLAUDE_PLUGIN_ROOT}/app`, data in `~/.flowlever`):
```
FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" finding list <id> --status open --json
FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" finding list <id> --status reworking --json
```
Group them by their target source, parsed from `locus`:
- `confluence:<pageId>#<section>` → spec edits
- `ado:<workItemId>` → work item edits (AC, description, scope)
- `figma:...` → cannot auto-edit; flag for the designer (draft the ask, don't apply)
- cross-source (`A vs B`) → decide which side is authoritative *with the user*, then edit that side.

Work blockers and majors first (they gate readiness), then minors.

## 2. For each finding, draft the fix
Fetch the current source text via MCP first (it may have changed since the audit), so your
edit applies to reality. Present a tight **before → after**:

> **Finding** (◆ blocker) Payment methods differ between spec and work item
> **Target** `confluence:982341#payment-methods`
> **Before:** "Supported methods: card, PayPal."
> **After:** "Supported methods: card, PayPal, Twint." *(aligns spec with AB#42696 AC)*
> Apply this edit? (y / edit / skip)

For cross-source findings, first resolve the decision ("Is Twint in the launch scope?") and
say which artifact you'll change. Never silently pick a side.

## 3. Apply ONLY on confirmation
- Confluence: `mcp__claude_ai_Atlassian_Rovo__updateConfluencePage` (fetch current version
  first; preserve the rest of the page — edit the target section only).
- ADO: `mcp__azure-devops__wit_update_work_item` (e.g. set Acceptance Criteria / Description),
  or `wit_add_work_item_comment` when a comment is the right move.
- Load these deferred tools with ToolSearch before calling them.

## 4. Mark the finding as reworking
After an edit is applied, record it so the ledger reflects in-flight work:
```
FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" finding set <id> <fp> --status reworking
```
Do **not** mark it `resolved` here. Resolution is earned by the next audit: when
`/flowlever:audit` re-runs and the issue is genuinely gone, reconciliation auto-resolves it — and
if your edit didn't actually fix it, it stays open (and a regression is caught if it later
reappears). That's the loop that makes "is it really fixed?" trustworthy.

If a finding is a non-issue or an accepted tradeoff rather than something to fix, waive it
instead (reason required):
```
FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" finding set <id> <fp> --status waived --reason "accepted: ..."
```

## 5. Close out
Summarize what was edited, what was waived, and what still needs a decision. Then recommend
re-running **`/flowlever:audit <id>`** to verify the fixes landed, auto-resolve what's done, and
catch any regressions. Remind the user they can watch it all on the dashboard
(`node "${CLAUDE_PLUGIN_ROOT}/app/src/server.js"` → http://localhost:4173).
