---
name: spec
description: >-
  Authors a draft artifact — user story, bug report, or feature specification —
  that satisfies the relevant Definition of Ready for that type, and emits it in
  the canonical draft format that /dor-dod:promote can parse and publish.
  Trigger when the user says "write a user story", "draft a spec", "create a
  bug ticket", "prepare a story for refinement", "I need a DoR-ready story",
  "spec this out", or invokes /dor-dod:spec. Pairs with /dor-dod:check (audit
  the draft against the DoR) and /dor-dod:promote (publish to ADO / Confluence).
allowed-tools: Read, Write, Edit, Bash, ToolSearch, mcp__claude_ai_Atlassian_Rovo__*, mcp__azure-devops__*
---

# dor-dod: spec

Authors a DoR-compliant draft — user story, bug, or feature spec — from whatever
input the user provides (rough idea, notes, pasted ticket, ADO/Confluence URL).
Reads checklist items from `definitions.md` at runtime; never hard-codes them.
Output is tool-agnostic markdown the user can review, paste, or hand straight to
`/dor-dod:promote`.

---

## Step 1 — Determine artifact type

Map the user's input to one of three types:

| Type | Maps to checklist |
|---|---|
| `story` | DoR for Implementation (User Story) |
| `bug` | DoR for Implementation (Bug) |
| `feature-spec` | DoR for Specification (UX → Engineer) |

- Infer from the input if unambiguous (e.g. "bug ticket", "user story", "UX handoff spec").
- If ambiguous, ask **once**: "Is this a user story, a bug, or a UX→engineer feature spec?"
  Do not proceed until confirmed.

---

## Step 2 — Load the checklist

Read the source-of-truth definitions file:

```
Read ${CLAUDE_PLUGIN_ROOT}/definitions.md
```

Extract **only the checklist section** that matches the determined type:

- `story` → `## ★ DoR for Implementation (User Story)`
- `bug` → `## ★ DoR for Implementation (Bug)`
- `feature-spec` → `## ★ DoR for Specification — UX → Engineer`

Do not hard-code checklist items. Quote at most a short illustrative snippet in
any reasoning; the file is the authority.

---

## Step 3 — Gather input (optional MCP enrichment)

Use whatever the user has supplied: raw notes, a pasted description, a Confluence
URL, or an ADO ticket reference.

If an ADO work item number or URL was given **and** the `azure-devops` MCP is
available (discover with `ToolSearch` — query `"select:mcp__azure-devops__wit_get_work_item"`),
read the item for additional context.

If a Confluence page URL was given **and** the Atlassian Rovo MCP is available
(discover with `ToolSearch` — query `"select:mcp__claude_ai_Atlassian_Rovo__getConfluencePage"`),
fetch the page content.

**If neither MCP is available:** note it, fall back to the user-supplied text,
and continue — never block on MCP absence.

---

## Step 4 — Draft the artifact

Using the user's input and the loaded checklist, produce the canonical draft.
Fill every section you can from available information; mark gaps in
`## Open Questions` (Step 5).

### Story format

```markdown
# Story — <Title>

## Story
As a <role>, I want <capability>, so that <value>.

## Description
<Context, scope, what is in/out of scope. Rational detail level — not an essay,
not a one-liner.>

## Acceptance Criteria
<!-- Gherkin only. QA-observable outcomes from outside the system.
     Technical/implementation requirements go in Definition of Done, not here. -->

**Scenario: <name>**
Given <precondition>
When <action>
Then <observable outcome>

<!-- Add more scenarios as needed. -->

## Definition of Done
<!-- Technical / implementation requirements, refactors, library choices,
     internal structure, test-coverage targets, telemetry wiring. NOT ACs. -->
- [ ] <item>

## QA Requirements
<!-- Unit test expectations, test automation scope. -->
- <item>

## Dependencies
<!-- Cross-domain / cross-initiative dependencies. Bare ADO ticket numbers only
     (e.g. 42695), never a DXPSM- prefix. -->
- <dependency or "None identified">

## Open Questions
<!-- Gaps that need human input — see Step 5. -->
```

### Bug format

```markdown
# Bug — <Title>

## Problem
**What happens:** <observed behaviour>
**What should happen:** <expected behaviour>

## Steps to Reproduce
1. <step>
2. <step>
...

## Expected Behavior
<Clear statement of correct behaviour.>

## Evidence
<!-- Screenshots, log extracts, AppInsights links. Placeholder if not yet provided. -->
- _Attach screenshots or paste relevant log lines here._

## Acceptance Criteria
<!-- "Fixed when" Gherkin — keep it short. -->

**Scenario: Bug is resolved**
Given <the user is in the affected state>
When <the triggering action>
Then <the correct behaviour is observed and the incorrect behaviour is absent>

## Definition of Done
- [ ] Root cause identified and fixed
- [ ] No regression in related flows

## QA Requirements
- <test automation / regression scope>

## Dependencies
- <bare ADO ticket numbers or "None identified">

## Open Questions
```

### Feature-spec format

```markdown
# Spec — <Title>

## Description
<Purpose, context, business goal, scope. Reference PRD if one exists.>

## Acceptance Criteria
<!-- Gherkin. QA-observable outcomes only. -->

**Scenario: <name>**
Given <precondition>
When <action>
Then <observable outcome>

## Definition of Done
<!-- Technical requirements, accessibility targets, design-system compliance,
     component documentation. -->
- [ ] <item>

## QA Requirements
- <item>

## Dependencies
- <bare ADO ticket numbers or "None identified">

## Open Questions
```

---

## Step 5 — Surface gaps in Open Questions

For each checklist item from Step 2 that you could **not** satisfy from available
input, add a line to `## Open Questions`. Common gaps by type:

**Story:**
- Story Points estimation (requires team refinement — do not invent)
- Vertec / financial phase (which budget line covers this work)
- Cross-domain dependencies not yet clarified
- Design / Figma link (if design stories)
- PRD decision (is a PRD necessary and valuable?)

**Bug:**
- Vertec / financial phase (usually inherits from parent work item — confirm)
- Whether technical refinement is needed (complex bugs only)
- Log files or screenshots if not yet attached

**Feature-spec:**
- PRD status (up to date? decision made?)
- Figma file link and screen-size coverage confirmation
- Architect and client/PO approval status
- Accessibility review confirmation

Phrase each question directly at the user, e.g.:
> "Story Points: not estimated — please size this in refinement."
> "Vertec phase: which budget line covers this work?"

Do **not** invent estimations, phase codes, or Figma URLs.

---

## Step 6 — Output and next steps

Print the canonical draft in full, then close with:

---

**Draft complete.** Open Questions above need your input before this is DoR-ready.

Next steps:
- `/dor-dod:check` — audit this draft against the full DoR checklist and get a PASS/GAP report.
- `/dor-dod:promote` — publish this draft to an ADO work item or Confluence page once it's ready.

---

## Conventions (non-negotiable)

- **ACs are Gherkin, QA-observable only.** If you find yourself writing "The developer shall…"
  or "Unit tests must cover…" inside `## Acceptance Criteria`, move it to
  `## Definition of Done`.
- **Bare ADO ticket numbers.** `42695`, never `DXPSM-42695`.
- **No MCP required.** The draft is always markdown-first. MCPs are an enrichment layer.
- **Do not duplicate a sibling's job.** If the user only wants to *audit* an existing artifact,
  point to `/dor-dod:check`. If they only want to *publish*, point to `/dor-dod:promote`.
