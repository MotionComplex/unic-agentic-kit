---
name: promote
description: >-
  Publishes a canonical-format markdown draft to Azure DevOps (create a new work
  item or update an existing one by bare ticket number) or to a Confluence spec
  page (create or update by URL/title). Trigger with: "promote this draft",
  "create the work item", "push this to Azure DevOps", "create the story in ADO",
  "publish to Confluence", "update ticket 42695 with this draft",
  "/dor-dod:promote". Sits at the end of the spec→check→promote pipeline:
  /dor-dod:spec authors the draft, /dor-dod:check audits it, and this skill
  publishes it. If the user wants to author or audit rather than publish, point to
  the sibling skill instead.
allowed-tools: Read, ToolSearch, mcp__azure-devops__*, mcp__claude_ai_Atlassian_Rovo__*
---

# dor-dod: Promote

Parses a canonical draft (produced by `/dor-dod:spec` or hand-written), maps its
sections to the target system's fields, previews exactly what will be
created/updated, and writes it only after explicit user confirmation. Degrades to
a ready-to-paste payload when the required MCP is unavailable.

## Step 1 — Accept the draft

Accept the draft in one of two ways:

- **Pasted inline:** the user pastes the markdown directly in the prompt.
- **File path:** the user gives an absolute or relative path — Read the file.

The draft must follow the canonical format:

```
# <Type: Story | Bug | Spec> — <Title>

## Story            (Story only — omitted for Bug)
## Problem          (Bug only)
## Steps to Reproduce   (Bug only)
## Expected Behavior    (Bug only)
## Evidence         (Bug only)
## Description
## Acceptance Criteria
## Definition of Done
## QA Requirements
## Dependencies
## Open Questions
```

Parse the H1 to extract **Type** (`Story`, `Bug`, `Spec`) and **Title**. Extract
each `##` section by heading. **The H1 (Type + Title) is the only hard requirement**
— if it is missing, stop and tell the user what is required. A `## Description` is
expected for Story and Spec; a Bug instead carries `## Problem` / `## Steps to
Reproduce` / `## Expected Behavior` (no `## Description`), so do **not** block a Bug
draft for a missing `## Description`. Map whatever sections are present.

## Step 2 — Determine the target and operation

Infer from the user's phrasing, or ask if ambiguous:

| Target | Operation | Signal |
|---|---|---|
| **Azure DevOps work item** | Create new | "create", "new ticket", "push to ADO" |
| **Azure DevOps work item** | Update existing | bare number given: "update 42695" |
| **Confluence page** | Create new | "publish to Confluence", "create the spec page" |
| **Confluence page** | Update existing | Confluence URL or page title given |

For ADO updates or Confluence updates, record the identifier (bare number or
URL/title) — you will need it in Step 4.

## Step 3 — Build the payload and show a preview

Construct the payload before touching any MCP.

### Azure DevOps mapping

| Draft section | ADO field |
|---|---|
| H1 Type | Work-item type: `Story` → **User Story**; `Bug` → **Bug**; `Spec` → **Task** |
| H1 Title | **Title** |
| `## Story` / `## Problem` + `## Description` | **Description** (concatenated, Story/Problem first) |
| `## Acceptance Criteria` | **Acceptance Criteria** field |
| `## Definition of Done` | Appended to Description under a `### Definition of Done` subheading |
| `## QA Requirements` | Appended to Description under a `### QA Requirements` subheading |
| `## Dependencies` | Appended to Description under a `### Dependencies` subheading |
| `## Open Questions` | Appended to Description under a `### Open Questions` subheading |

For Bug type, include `## Steps to Reproduce`, `## Expected Behavior`, and
`## Evidence` in the Description before Definition of Done.

Use **bare ticket numbers** throughout (e.g. `42695`, never `DXPSM-42695`).

### Confluence mapping

| Draft section | Confluence field |
|---|---|
| H1 Title | **Page title** |
| Full body (all `##` sections) | **Page content** — preserve section structure verbatim |
| Target space | **DXP** (default); confirm with user if a different space is needed |

Show the user the complete preview:

```
Target:  Azure DevOps — new User Story   (or: update #42695 / Confluence page …)
Title:   <title>
Type:    <work-item type>

--- Description (preview) ---
<first 20 lines>
…

--- Acceptance Criteria (preview) ---
<first 10 lines>
…

Proceed? [yes / no / edit target]
```

**Do not write anything until the user confirms with "yes" (or equivalent).**
If they say "no" or ask for changes, revise and re-preview.

## Step 4 — Discover the MCP and write

### Attempt to find the MCP

Use `ToolSearch` to look up the required tools:

- **ADO:** query `"select:mcp__azure-devops__wit_create_work_item,mcp__azure-devops__wit_update_work_item,mcp__azure-devops__wit_get_work_item"`
- **Confluence:** query `"select:mcp__claude_ai_Atlassian_Rovo__createConfluencePage,mcp__claude_ai_Atlassian_Rovo__updateConfluencePage,mcp__claude_ai_Atlassian_Rovo__getConfluencePage"`

### If the MCP is available — write

**Azure DevOps — create:**
Call `mcp__azure-devops__wit_create_work_item` with the mapped fields. Use the
project/team context from any previous conversation turns, or ask the user if
unknown.

**Azure DevOps — update:**
Call `mcp__azure-devops__wit_get_work_item` first to confirm the item exists and
show the user the current title. Then call
`mcp__azure-devops__wit_update_work_item` to overwrite the mapped fields.

**Confluence — create:**
Call `mcp__claude_ai_Atlassian_Rovo__createConfluencePage` with the DXP space,
the H1 as title, and the full body. Ask the user for a parent page if not
specified.

**Confluence — update:**
Resolve the page by URL or title with
`mcp__claude_ai_Atlassian_Rovo__getConfluencePage`, confirm the page ID, then
call `mcp__claude_ai_Atlassian_Rovo__updateConfluencePage`.

### If the MCP is absent — degrade gracefully

Do not fail. Tell the user which MCP is unavailable and emit the ready-to-paste
payload:

**ADO:**
```
MCP azure-devops is not available. Paste the following into a new/existing ADO work item:

**Work item type:** User Story

**Title:**
<title>

**Description:**
<full description block>

**Acceptance Criteria:**
<AC block>
```

**Confluence:**
```
MCP Atlassian/Rovo is not available. Paste the following as a new Confluence page
in the DXP space:

**Title:** <title>

**Body:**
<full page body>
```

## Step 5 — Report and offer next step

On success, output:

```
✓ Published: <work-item type> #<id> — <title>
  URL: <url>
```

or for Confluence:

```
✓ Published: Confluence page "<title>"
  URL: <url>
```

Then suggest:

> Run `/dor-dod:check` on the published artifact to confirm it still passes its
> Definition of Ready.

If the write failed (MCP error), show the error verbatim, emit the manual payload
(same as the degrade-gracefully path), and do not retry silently.

---

**Do not author or audit the draft here.** Authoring is `/dor-dod:spec`;
auditing is `/dor-dod:check`. If the user's intent is either of those, say so and
point them to the right skill.
