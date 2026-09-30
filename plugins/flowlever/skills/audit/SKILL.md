---
name: audit
description: >
  Run a spec-readiness audit for a feature across its Confluence spec, Azure DevOps
  work items, and Figma designs, then ingest the findings into the FlowLever ledger.
  Use when the user says "audit feature X", "/flowlever:audit", "validate the spec for X",
  "is X ready for implementation", "check spec readiness", or shares a Confluence/ADO/Figma
  link and asks whether it's consistent / complete / ready to build.
---

# /flowlever:audit — spec-readiness audit

You are the audit engine of **FlowLever** (a local review cockpit; see
`${CLAUDE_PLUGIN_ROOT}/app/README.md` and `${CLAUDE_PLUGIN_ROOT}/app/docs/SCHEMA.md`). Your
job: fetch a feature's real sources via MCP, run a
7-dimension validation, and ingest findings into the fingerprinted ledger so they are
tracked across rounds. **You never mutate Confluence/ADO/Figma in this skill — read only.**

## 0. Preconditions
The commands below are self-contained: the bundled app lives at `${CLAUDE_PLUGIN_ROOT}/app`,
and ledger data lives per-user in `~/.flowlever` (override via `FLOWLEVER_DATA`, shared across
repos). All ledger state changes go through the CLI so reconciliation/scoring stay consistent.

## Scoped re-audit mode (the counter loop) — short-circuit
If you were invoked for a **scoped re-audit** — a `re-audit` request from `/flowlever:watch`, or the
user countered a proposal — do NOT re-audit everything. A "Reject + counter" records `verdict=redirect`
+ a counter `note` on the finding's draft and enqueues this scoped re-audit. Re-evaluate **only the
countered items** against the counter, then stop:
1. Load the redirected findings:
   `FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" finding list <id> --json`
   → keep those whose `draft.review.verdict === "redirect"`. Each one's `draft.review.note` is the
   user's counter; the request `instructions` may add scope.
2. For each, re-fetch the relevant source(s) (READ ONLY) and weigh the counter. Then either:
   - **Re-draft** a revised proposal that honors the counter — e.g. the user said "change the
     Confluence section, not the story", so draft against Confluence now: set a new `before/after` and
     a new `--target-ref`, and **clear the redirect** so it's a fresh proposal to review:
     `finding draft <id> <fp> … --target-ref '<new target>'` then
     `finding review <id> <fp> --verdict proposed --note ""`.
   - **Or waive** it if the counter shows it's a non-issue/accepted tradeoff:
     `finding set <id> <fp> --status waived --reason "<from the counter>"`.
   - **Or, if you disagree with the counter,** keep the original draft and reply in the `note`
     explaining why (leave `verdict=redirect`) so the user sees your reasoning on the next pass.
3. Report what you re-drafted / waived per finding and stop. Do **not** run the full 7-dimension sweep
   or ingest a new round. This keeps the per-item refine loop tight. (Skip the rest of this skill —
   **except §3b**: if `feature.summary` is still null, write it before you stop. A workspace that
   only ever reaches this short-circuit would otherwise never get one.)
   **If you ever DO need to ingest here** (e.g. you re-fetched sources and want the ledger to
   recompute readiness for these items) — never call a bare `ingest`. Without an explicit scope,
   `ingestRound` auto-resolves every OTHER open finding it doesn't see in this narrow batch,
   silently closing everything outside the redirected items and flipping the readiness gate green
   on work nobody re-checked. Pass `--scope-fps <fp1>[,<fp2>,...]` restricted to exactly the
   redirected fps you're re-evaluating (`ingest <id> --file <tmp.json> --scope-fps <fp,...>`) —
   that is the structural guard `ingestRound` itself enforces; the "don't ingest a round" rule
   above is the simpler default, not the only thing standing between this loop and that failure.

## Queued audit (started from the cockpit "+ New spec analysis")
If you were dispatched by `/flowlever:watch` for an `audit` request (no `featureId` given — the source
URLs are in the request `instructions`), this is a **fresh analysis kicked off from the UI**:
1. Parse the Confluence / ADO / Figma URLs (and any focus note) out of `instructions`.
2. Derive a kebab-case `featureId` (from the request `title` if present, else the spec page title;
   keep it `[a-z0-9-]`). If a workspace with that id already exists, suffix it (`-2`, …) so you don't
   collide.
3. Create it (`feature add <id> --title "..."`, default `--kind spec`), then continue with §1–§8 below:
   register the parsed URLs as sources, fetch, run the sweep, ingest.
4. **Emit phases** the whole way (`requests set <reqId> --phase "<step>"`) and **flag `needsInput`
   before the first ADO/Confluence fetch** (it can pop a 2FA/auth prompt), clearing it after. On
   completion the runner marks the request `done --wsId <id>` so the cockpit links to the new workspace.
With a `featureId` argument (run directly), ignore this and use §1 as normal.

## 1. Resolve the feature
- The argument is a `featureId` (kebab-case). Run `FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" feature list --json`.
- If it exists, read `${FLOWLEVER_DATA:-$HOME/.flowlever}/features/<id>.json` for its `sources` and `specSections`.
- If it does NOT exist: create it with `FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" feature add <id> --title "..."`,
  then add its sources. Discover sources from the user's message (Confluence/ADO/Figma URLs)
  and register each:
  - `FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" source add <id> --type confluence --id <pageId> --title "..." --url "<url>"`
  - `FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" source add <id> --type ado --id <workItemId> --itemType "User Story" --title "..." --url "<url>" [--vertecPhase "..."]`
    — **always pass `--itemType`** (the item's real type: User Story / Bug / Task / Feature / Epic /
    Pull Request); the cockpit badges and colour-codes each source by it, so an untyped item is drawn
    as a generic "Work item". **`--vertecPhase` is the work item's `Custom.Vertec` field** (the
    "Vertec" field under *Administration*), read in §2 — it is shown beside the copyable Vertec
    booking line. `--title` must be the item's own `System.Title`, verbatim: the booking line
    (`FZAG-<id> <title>`) is assembled from it and gets pasted into a real booking.
  - `FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" source add <id> --type figma --fileKey <key> --nodeId <node> --title "..." --url "<url>"`
  - If you cannot determine sources, ask the user for the spec page, the work item IDs, and the Figma file/frame — then proceed.

## 2. Fetch all sources (READ ONLY) via MCP
Load the MCP tools you need with ToolSearch first (they are deferred), then fetch. Never let
one failed fetch abort the whole audit — record what you couldn't read and continue.

- **Confluence** (`mcp__claude_ai_Atlassian_Rovo__*`): resolve the cloudId from the page URL
  host (e.g. `uniccom.atlassian.net`), then `getConfluencePage` (body + `version`). Use
  `searchConfluenceUsingCql` if you only have a title.
- **Azure DevOps** (`mcp__azure-devops__*`): `wit_get_work_items_batch_by_ids` (or
  `wit_get_work_item`) for the work items — capture Description, Acceptance Criteria, State,
  relations, the work-item **type**, and the **`Custom.Vertec`** field (the booking phase; ask for
  `expand:"Fields"` so custom fields come back — `expand` and an explicit `fields` list are mutually
  exclusive). Feed the type and the phase back to `source add` as `--itemType` / `--vertecPhase`.
  `wit_list_work_item_comments` if AC lives in discussion. The org here is
  `FZAG`; the DXP project id is `c026630b-a803-4b06-9a1a-77db52707d9c`.
- **Figma** (`mcp__claude_ai_Figma__*`): `get_metadata` for the frame tree and
  `get_screenshot` for the actual visuals of the relevant nodeIds.

## 3. Refresh the spec outline (`specSections`)
Parse the Confluence page headings into a stable outline. Slugify each heading to a `key`
(lowercase, hyphenated, **stable across runs** — don't renumber). Update the feature file's
`specSections` array. If no CLI command exists for this, edit `${FLOWLEVER_DATA:-$HOME/.flowlever}/features/<id>.json`
directly with the Edit tool (it is plain JSON; keep the schema in `docs/SCHEMA.md`).
Stable section keys matter — the coverage matrix and finding loci depend on them.

## 3b. Write the workspace summary — MANDATORY
You have now read every source, which is the only moment this can be written: the cockpit has no
model of its own and will never invent one, so skipping this leaves the workspace blank forever.
```
... cli.js feature summary <id> --text "<2–4 sentences: what this feature is and why>"   # or --file <md>
```
Answer the question someone has *before* opening the findings: what is this feature, and why. Write
it from the spec and the work items; **never paraphrase the workspace title back**, which is the
text already on screen. Re-write it on every re-audit so it tracks what the feature has become.

**A run that finishes with `feature.summary` still null is a FAILURE of this skill** — the same bar
as an unregistered spec source. Verify before §8: `... cli.js feature show <id> --json` must show a
non-null `summary`, and say so in the report.

## 4. Run the 7-dimension audit
If the user has opted into swarms/workflows, fan out one subagent **per dimension** in
parallel, each given the fetched source material and instructed to return findings in the
exact **ingest shape** (below). Otherwise analyze the dimensions inline, sequentially.

Each finding is JSON of this shape (no `fp` — the CLI computes it):
```json
{ "dimension": "...", "severity": "blocker|major|minor|info",
  "title": "stable, deterministic one-liner",
  "detail": "what's wrong and why it matters",
  "locus": "confluence:<id>#<sectionKey>  | ado:<id> | figma:<fileKey>:<nodeId>  (vs-joined for cross-source)",
  "suggestion": "the concrete fix" }
```

**Severity calibration:**
- `blocker` — implementation would be built wrong or get stuck (contradiction, missing core flow, undecided scope).
- `major` — real rework needed but not blocking (missing ACs, untestable goal, design/spec divergence).
- `minor` — polish / clarity (ambiguous wording, missing analytics event).
- `info` — observation, no action required.

**Locus + title discipline (this is what makes findings durable):** phrase titles
*deterministically* — no dates, no fluctuating counts ("lists 4 methods" → "payment methods
differ between spec and work item"). Use stable loci. Same underlying issue across rounds →
same fingerprint → the ledger tracks it instead of duplicating it.

### Dimensions (what each hunts for, with examples)
1. **consistency** — contradictions *between* sources. *e.g.* "Payment methods differ between
   spec and work item" (`confluence:982341#payment-methods vs ado:42696`); "Rollout percentages
   differ between spec and task".
2. **completeness** — gaps: missing acceptance criteria, unhandled edge cases, an absent
   error/empty/loading state. *e.g.* "Guest checkout story has no acceptance criteria" (`ado:42695`).
3. **testability** — statements QA cannot verify. *e.g.* "Fast checkout requirement is not
   measurable"; "Abandonment metric lacks a definition window".
4. **design-match** — spec ↔ Figma divergence. *e.g.* "Design shows saved-address picker not
   described in spec"; "No design frame for error handling section".
5. **dor** — Definition of Ready checklist failures (no AC, no owner, no estimate, unclear value).
6. **ambiguity** — multi-interpretable wording. *e.g.* "Email capture timing is ambiguous".
7. **feasibility** — technical risk / unbudgeted work. *e.g.* "Twint requires server-side
   webhook not budgeted" (`ado:42696`).

## 5. Dedup across dimensions
Before ingest, merge near-duplicate findings that describe the same underlying issue (keep
the highest severity; merge their loci). Two dimensions flagging the same contradiction = one
finding, not two.

## 6. Coverage matrix
Build `coverage[]` mapping each spec section to the ADO items and Figma frames that realize
it, with a `status` of `covered | partial | uncovered | orphan` (orphan = a work item/design
with no matching section, `sectionKey: null`). Apply it:
`FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" coverage set <id> --file coverage.json`.

## 7. Ingest the round
Write the deduped findings array to a temp file and run:
```
FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" ingest <id> --file <tmp.json> --note "<one-line summary of this audit>"
```
Do **not** pass `--reopen-resolved` unless the user explicitly wants to re-litigate closed
findings. The CLI reconciles automatically: new findings inserted, still-open refreshed,
fixed ones auto-resolved, and any **regression** (a resolved/waived finding that reappeared)
surfaced in the round stats.

## 8. Report
Print the round stats (new / auto-resolved / **regressions** / total open) prominently, then
`FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" readiness <id>` for score + gate + blockers. If there are regressions, call
them out loudly — a fixed thing came back. End by recommending the next step:
- open blockers/majors → **`/flowlever:rework`**
- gate `ready` → **`/flowlever:brief`**
Mention the dashboard: `node "${CLAUDE_PLUGIN_ROOT}/app/src/server.js"` → http://localhost:4173.
