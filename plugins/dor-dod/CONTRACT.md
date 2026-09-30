# dor-dod — build contract (read this fully before writing your skill)

You are authoring **one** skill of the `dor-dod` Claude Code plugin. Three skills share this
contract so they compose cleanly. Build **only your assigned skill's `SKILL.md`**; do not touch
the other skills, `definitions.md`, the manifest, or run any git commands — the orchestrator
handles git and review.

## Plugin layout (already scaffolded)

```
plugins/dor-dod/
  .claude-plugin/plugin.json      # manifest (done)
  definitions.md                  # ★ source of truth — the 9 DoR/DoD checklists (done)
  CONTRACT.md                     # this file
  README.md                       # done
  skills/
    spec/SKILL.md                 # ← worker W0
    check/SKILL.md                # ← worker W1
    promote/SKILL.md              # ← worker W2
```

Your deliverable is exactly one file: `plugins/dor-dod/skills/<your-skill>/SKILL.md`
(absolute path given in your brief). Use the **Write** tool. Do not commit.

## The source of truth

Every skill reads the checklists from `${CLAUDE_PLUGIN_ROOT}/definitions.md` **at runtime** —
that env var resolves to the plugin's install dir wherever it lands. Your SKILL.md must instruct
Claude to **Read `${CLAUDE_PLUGIN_ROOT}/definitions.md`** to get the authoritative checklist items
rather than hard-coding them. Quote at most a short illustrative snippet; never paste the whole
checklist into the skill (it would drift from the source). The scope you operate on is the five
**★ in-scope** checklists; the reference ones exist for lookup only.

## SKILL.md format (match the kit's existing skills)

Frontmatter (YAML), then a markdown body of numbered steps. Example shape:

```markdown
---
name: <spec|check|promote>
description: >-
  <2–5 sentences. What it does + WHEN to trigger. Include natural trigger phrases the
  user would type, and how it relates to the sibling skills. This text is how the skill
  gets auto-selected, so make the triggers concrete.>
allowed-tools: Read, Write, Edit, Bash   # plus MCP tool globs your skill needs (see below)
---

# <Title>

<one-paragraph purpose>

## Step 1 — …
## Step 2 — …
```

Style: concise, imperative, terminal-friendly markdown. Look at the sibling skills in this kit
(`plugins/cmux-swarm/skills/code-check/SKILL.md`) for tone. Keep it tight — no filler.

## Conventions to bake in (these are the user's standing rules — non-negotiable)

1. **Acceptance Criteria are QA-testable, end-to-end *observable* outcomes only.** Write ACs in
   **Gherkin** (`Given/When/Then`). An AC describes what a tester can observe from outside the
   system. Implementation/technical requirements (refactors, which library, internal structure,
   test-coverage targets, telemetry wiring) are **NOT** acceptance criteria — they belong in a
   separate **Definition of Done** section of the artifact. Enforce this split everywhere.
2. **Azure DevOps tickets use bare numbers** — e.g. `42695`, never a `DXPSM-` prefix (DXPSM is the
   Confluence service-management space, not the work-tracker). Commit/branch/reference style:
   `fix [42695]: …`.
3. **Tool-agnostic by default.** The primary output is **markdown** the user can read, paste, or
   hand to `promote`. Never require an MCP to be present to produce the core result.
4. **MCP is optional — degrade gracefully.** When a needed MCP (Atlassian/Rovo for Confluence,
   `azure-devops` for work items) is **absent**, do not fail: explain it's not available and fall
   back (work from pasted content / emit the markdown payload for manual paste). When it IS
   present, use it. Discover MCP tools via `ToolSearch` rather than assuming exact names.

## The canonical draft format (shared interface between `spec` and `promote`)

`spec` **produces** this; `promote` **parses** it. Keep headings exact so promote can map them.

```markdown
# <Type: Story | Bug | Spec> — <Title>

## Story            # (Story only) one or more "As a <role>, I want <capability>, so that <value>."
## Description      # specification at a rational detail level; context, scope, in/out of scope
## Acceptance Criteria   # Gherkin scenarios — QA-observable outcomes ONLY
## Definition of Done    # technical / implementation requirements (the non-AC stuff)
## QA Requirements   # unit tests / test automation expectations
## Dependencies      # cross-domain / cross-initiative dependencies, linked tickets (bare numbers)
## Open Questions    # gaps the skill could not fill — estimations (story points), vertec phase, etc.
```

For **Bug** type, `## Story` is replaced by `## Problem` (what happens vs. what should happen),
and `## Steps to Reproduce`, `## Expected Behavior`, and `## Evidence` (screenshots/logs) are
included; `## Acceptance Criteria` may be a short "fixed when" Gherkin.

## How the three skills relate (cross-reference these in your `description` and closing step)

- `/dor-dod:spec` — **author** a draft to the relevant DoR. Ends by offering `/dor-dod:check`
  (audit it) or `/dor-dod:promote` (publish it).
- `/dor-dod:check` — **audit** any artifact (draft, ADO item, Confluence page, branch/PR) against
  the matching DoR/DoD; report PASS/GAP per item + an overall verdict.
- `/dor-dod:promote` — **publish** a canonical-format draft to an ADO work item or Confluence page.

Do not duplicate a sibling's job. If the user's ask is really another skill's, say so and point to it.
