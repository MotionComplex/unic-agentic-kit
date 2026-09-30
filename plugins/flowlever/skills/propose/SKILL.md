---
name: propose
description: >
  Draft concrete change proposals for a FlowLever spec workspace's open findings — before→after
  edits to Azure DevOps work-item fields and Confluence spec sections — and attach them to the
  ledger so the user can Accept / Edit / Reject-with-counter each one in the cockpit, exactly like
  PR-review comments. Read-only: it never writes to ADO/Confluence (that is /flowlever:apply-spec,
  on the user's explicit Apply). Use when the user says "propose fixes for X", "draft the spec
  changes", "/flowlever:propose X", or after an audit when they want reviewable change drafts
  rather than just a findings list.
---

# /flowlever:propose — draft reviewable spec change proposals

You are the **spec-proposal drafter** of FlowLever. The audit (`/flowlever:audit`) finds *what's
wrong*; you draft *the exact change that fixes it* — a before→after diff bound to a real write
target (an ADO field or a Confluence section) — and stash it on the finding as a `draft`. The user
then steps through proposals in the cockpit (Accept · Edit · Reject + counter), and **only on their
explicit Apply** does `/flowlever:apply-spec` write them back.

This is the spec-side mirror of `/flowlever:pr-review`'s draft step: same finding model, same
stepper, same decision row. **You read sources via MCP; you never mutate them here.**

## 0. Preconditions
Self-contained: app at `${CLAUDE_PLUGIN_ROOT}/app`, ledger at `~/.flowlever` (override
`FLOWLEVER_DATA`). All ledger writes go through the CLI. The argument is a spec `<wsId>` (the
feature audited). If the workspace has no findings yet, tell the user to run `/flowlever:audit <id>`
first — you propose fixes *for findings*, you don't re-discover them.

> **When run from the cockpit queue (`/flowlever:watch`), emit phases** so the job row shows live
> progress, and — critically — flag `needsInput` *before* the first ADO/Confluence fetch (it can pop
> a 2FA/auth prompt), then clear it. With the request id as `<reqId>`:
> `requests set <reqId> --phase "<step>"`. Skip these when invoked directly (no `<reqId>`).

## 1. Load the findings to propose for
```
FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" finding list <wsId> --status open --json
FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" finding list <wsId> --status reworking --json
```
Skip findings that already carry a `draft` (don't clobber a proposal the user is mid-reviewing)
unless the user asked to re-draft. Work blockers and majors first.

Decide each finding's **write target** from its `locus`:
- `confluence:<pageId>#<section>` → a Confluence spec edit.
- `ado:<workItemId>` → an ADO work-item field edit (usually Acceptance Criteria or Description).
- `figma:…` → **cannot auto-apply** — draft the change as a note for the designer (still a `draft`,
  but say in the `after`/target that this is a hand-off, not an auto-write). Don't fabricate a targetRef.
- cross-source (`A vs B`) → the contradiction must be fixed on **one** side. Pick the side the audit
  `suggestion` points to; if it's genuinely ambiguous, draft against the most likely side and say so —
  the user can **Reject + counter** to send you to the other side (that's the loop, below).

## 2. Fetch the CURRENT source text (READ ONLY) via MCP
Load the deferred MCP tools with ToolSearch first. Fetch the live text so `before` is reality (the
spec may have moved since the audit) — and, for Confluence, **capture the page `version`** for the
write target.
- **Confluence** (`mcp__claude_ai_Atlassian_Rovo__getConfluencePage`): fetch the page **in storage
  format** (`body.storage` / the storage representation) plus its `version.number`. Locate the target
  section by its heading/anchor. Quote the exact current section text as `before`.
- **Azure DevOps** (`mcp__azure-devops__wit_get_work_item`): fetch the work item; read the exact
  current value of the field you'll change (`Microsoft.VSTS.Common.AcceptanceCriteria`,
  `System.Description`, …) as `before`.

## 3. Attach the proposal as a draft (with a machine write target)
For each finding with a concrete fix, write a before→after change and bind it to a `targetRef` so
apply is surgical:
```
FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" \
  finding draft <wsId> <fp> \
  --target "AB#42695 — Acceptance Criteria" \
  --format gherkin \
  --before "<exact current text>" \
  --after  "<proposed text>" \
  --target-ref '{"system":"ado","adoId":42695,"field":"Microsoft.VSTS.Common.AcceptanceCriteria"}'
```
`targetRef` is what makes apply land in the right place — set it precisely:
- **ADO:** `{"system":"ado","adoId":<id>,"field":"<reference name>"}` — use the field **reference
  name** (`Microsoft.VSTS.Common.AcceptanceCriteria`, `System.Description`, `System.Title`).
- **Confluence:** `{"system":"confluence","pageId":"<id>","anchor":"<sectionKey>","version":<the version you fetched>}`
  — the `anchor` is the stable section key (matches the finding locus); the `version` is the page
  version your `before` was read from, so the writer can detect a concurrent edit before overwriting.
- **Figma / hand-off:** omit `--target-ref` (no auto-write target). Make the `after` a clear ask.

Keep `before`/`after` **surgical** — the smallest section/field that actually changes, not the whole
page. Use `--format gherkin` for ACs, `markdown` for prose, `text` otherwise (display hint only).

## 4. Hand to the cockpit
Tell the user to open the workspace in the cockpit (`/flowlever:start` → the spec workspace) and step
through each proposal. Per finding the decision row is:
- **Accept** — apply the proposed `after` as-is.
- **Edit** — tweak the text inline (persisted as the hunk's `editedText`); apply uses the edited text.
  No re-audit — it's a manual amendment of *this* proposal.
- **Reject + counter** — disagree with the target/approach and give a counter (e.g. "change the
  Confluence section, not the story"). This records `verdict=redirect` + the note **and enqueues a
  scoped re-audit** so you re-evaluate just that item against the counter and re-draft (see the loop
  in `/flowlever:audit` → "Scoped re-audit"). It's a per-item refine cycle, not one-shot.
When the user clicks **Apply accepted changes**, the cockpit enqueues an `apply` request and
`/flowlever:watch` runs **`/flowlever:apply-spec <wsId>`** to write them back surgically.

## 5. Summary
Report what you drafted: per finding, the target (`ado:<id>#<field>` / `confluence:<page>#<section>`),
and a one-line of the change. Name any findings you could **not** draft a concrete fix for (Figma,
genuinely-undecided scope) so they're a stated gap, not a silent omission. If from the queue, the
runner then marks the request `done --phase "proposals ready" --wsId <wsId>`.
