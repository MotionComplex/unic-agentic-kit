---
name: check
description: >-
  Audits any artifact against the matching Definition of Ready or Done and
  reports, per checklist item, whether it PASSES, has a GAP, or is N/A — plus
  an overall verdict and the blocking gaps in priority order. Accepts a pasted
  markdown draft (e.g. from /dor-dod:spec), an Azure DevOps work item (bare
  number or URL), a Confluence spec page (URL or title), or the current git
  branch / a PR. Auto-detects which checklist applies from the artifact type
  and the user's intent. Trigger phrases: "is this story ready", "check
  definition of ready", "audit this ticket", "ready for refinement?", "ready
  for testing?", "can I close this story?", "check the DoR", "check the DoD",
  "/dor-dod:check". Use /dor-dod:spec to draft or complete missing pieces;
  use /dor-dod:promote once the artifact passes.
allowed-tools: Read, ToolSearch, mcp__azure-devops__*, mcp__claude_ai_Atlassian_Rovo__*
---

# DoR / DoD Check

Audit an artifact against the matching DoR or DoD checklist. Report every item
as ✅ PASS / ⚠️ GAP / ➖ N/A, each GAP with a concrete fix. End with an overall
READY / NOT READY verdict and the top blocking gaps.

No MCP is required for the core path — pasted content works offline.

---

## Step 1 — Resolve the artifact

Determine what the user has provided and load the content:

**A) Pasted markdown / inline text** — use it directly. No MCP needed.

**B) Azure DevOps work item** (bare number like `42695`, or a full ADO URL):
- Use `ToolSearch` with query `"azure-devops work item"` to discover the
  `wit_get_work_item` tool (or equivalent). If found, fetch the item by ID.
- If the MCP is absent: tell the user, ask them to paste the ticket content,
  then continue with path A.

**C) Confluence page** (URL or title):
- Use `ToolSearch` with query `"atlassian confluence get page"` to discover
  the relevant Rovo tool. If found, fetch the page by URL or title.
- If the MCP is absent: tell the user, ask them to paste the page content,
  then continue with path A.

**D) Git branch / PR** — read the branch name (`git branch --show-current`),
  then inspect the commit messages, PR description (if available via ADO MCP),
  or any linked work items to extract the artifact content. Fall back to asking
  the user to paste the relevant content.

Once you have the content, proceed to Step 2.

---

## Step 2 — Detect artifact type and checklist

Identify which **★ in-scope** checklist applies. Use the artifact content and
the user's phrasing as signals:

| Signal | Checklist to apply |
|---|---|
| User story text; "is this ready for refinement/implementation?" | DoR for Implementation (User Story) |
| Bug report / bug ticket | DoR for Implementation (Bug) |
| UX handoff / Figma spec / design-to-engineer | DoR for Specification |
| "ready for testing?", "hand to QA?" | DoR for Testing |
| "can I close this story?", "is this done?" | DoD for User Story |
| Release / deployment question | DoR for productive deployment or DoD Release (reference — flag as out of active scope) |

If the correct checklist is **genuinely ambiguous** after reading the artifact,
ask the user **one** clarifying question and list the candidate checklist names.
The user may also force a specific checklist by name — honour that.

---

## Step 3 — Load the authoritative checklist

Read the definitions file at runtime:

```
${CLAUDE_PLUGIN_ROOT}/definitions.md
```

Extract **only** the section matching the chosen checklist. Do not hard-code
the items — always read from the file so the skill stays in sync with the
source of truth.

---

## Step 4 — Evaluate each item

Work through every checklist item and assign one of:

- ✅ **PASS** — the artifact clearly satisfies the item.
- ⚠️ **GAP** — the item is required and is missing or insufficient.
- ➖ **N/A** — the item does not apply to this artifact (state why in one phrase).

**Judging conventions (non-negotiable):**

1. **Acceptance Criteria must be Gherkin and QA-observable only.**
   - If an AC describes an implementation detail (which library, internal
     structure, refactor, test-coverage target, telemetry wiring), flag it as
     a GAP: `⚠️ GAP — AC line N describes an implementation detail; move it to
     the Definition of Done section.`
   - ACs must be written as `Given / When / Then` scenarios a tester can
     verify from outside the system.

2. **ADO references must be bare numbers** (e.g. `42695`), never `DXPSM-`
   prefixed. Flag any `DXPSM-` references as a GAP.

3. **Estimations and financial aspects** (Story Points, Vertec phase) — mark
   ➖ N/A with a note if you cannot determine them from the artifact alone;
   note them as open questions rather than blocking GAPs unless the user says
   estimations are required for the current gate.

---

## Step 5 — Render the audit report

Output a compact markdown table followed by a verdict block. Terminal-friendly;
no HTML.

```markdown
## DoR / DoD Audit — <Checklist Name>

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1 | <item summary> | ✅ PASS | |
| 2 | <item summary> | ⚠️ GAP | <concrete fix — one sentence> |
| 3 | <item summary> | ➖ N/A | <reason> |
...

---

### Overall verdict: READY ✅  /  NOT READY ❌

**Blocking gaps** (fix in this order):
1. <Gap description> → <concrete fix>
2. …

**Non-blocking notes:**
- <anything worth flagging that isn't a hard blocker>
```

Concrete fix format for GAPs: specific and actionable.
- Good: `Add a Gherkin scenario covering the empty-state error (Given the list
  is empty, When the user opens the page, Then an empty-state message is shown).`
- Bad: `Improve the acceptance criteria.`

If there are zero GAPs → verdict is READY ✅ and the blocking section is omitted.

---

## Step 6 — Close with next steps

End the response with:

```
---
**Next steps**
- To draft or complete the missing pieces → `/dor-dod:spec`
- Once the artifact passes → `/dor-dod:promote` to publish it to ADO / Confluence
```

If the artifact already passes (READY ✅), emphasise `/dor-dod:promote` as the
immediate next action.

---

## What this skill does NOT do

- **Draft** new content → that's `/dor-dod:spec`.
- **Publish** to ADO or Confluence → that's `/dor-dod:promote`.
- Audit reference-only checklists (DoR for UX/Design, DoR for productive
  deployment, DoD Release) — flag them as out of active scope and offer to do
  a read-only lookup if the user needs it.
