# dor-dod

A specification & development toolkit built on the **FZAG DXP Definition of Ready/Done**
([Confluence](https://uniccom.atlassian.net/wiki/spaces/DXP/pages/117573747/Definition+of+Ready+Done)).
Three skills share one source-of-truth checklist file so authoring, auditing, and publishing all
speak the same definitions.

## Skills

| Command | Does |
|---|---|
| `/dor-dod:spec` | **Author** a user story, bug, or feature spec to the relevant Definition of Ready, as tool-agnostic markdown. Acceptance Criteria are written as Gherkin (QA-observable outcomes only); technical requirements go to a Definition of Done section. |
| `/dor-dod:check` | **Audit** any artifact — a draft, an Azure DevOps work item, a Confluence spec page, or a branch/PR — against the matching DoR/DoD. Auto-detects the lifecycle stage and reports PASS/GAP per item with concrete fixes and an overall ready/not-ready verdict. |
| `/dor-dod:promote` | **Publish** a draft (from `/dor-dod:spec` or hand-written) to an Azure DevOps work item or a Confluence spec page, mapping markdown sections to the target's fields. |

The loop they support: **author → audit → promote**.

## Source of truth

[`definitions.md`](./definitions.md) holds the nine DoR/DoD checklists verbatim from Confluence.
Every skill reads it at runtime via `${CLAUDE_PLUGIN_ROOT}/definitions.md`. **When the Confluence
page changes, update `definitions.md` only** — all three skills follow. The five dev + specification
checklists are actively driven (DoR for Specification, Implementation Story, Implementation Bug,
Testing, and DoD for User Story); the UX/Design and release/deployment checklists are kept for lookup.

## MCP dependencies (optional)

The skills work **without any MCP** — they take and produce markdown. Two MCP servers unlock the
fetch/publish integrations when present:

- **Atlassian (Confluence)** — read spec pages for `check`, publish pages with `promote`.
- **Azure DevOps** — read work items for `check`, create/update work items with `promote`.

When a server is absent, the relevant skill degrades gracefully (works from pasted content / emits
a payload for manual paste). The plugin does **not** bundle these servers, to avoid duplicating
servers you already have configured; configure them at the user level as usual.

## Install

This plugin lives in the `unic-agentic-kit` marketplace.

```
/plugin marketplace add MotionComplex/unic-agentic-kit
/plugin install dor-dod@unic-agentic-kit
```

For a one-session local load during development: `claude --plugin-dir plugins/dor-dod`.
