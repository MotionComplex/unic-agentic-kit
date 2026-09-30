---
name: summarize
description: >
  Fill in what a FlowLever workspace is missing from its ALREADY-REGISTERED sources: the
  plain-language "what this is about" summary, and — while the work items are open anyway — the
  work-item types and Vertec booking phase the cockpit needs to tell a PR from its user story.
  Read-only toward Azure DevOps and Confluence; writes nothing to the PR and ingests no findings.
  Use when the cockpit's "Generate summary" button enqueues a `summarize` request (the
  /flowlever:watch runner dispatches it), or when the user says "write the summary for X",
  "summarise this PR in flowlever", or "/flowlever:summarize X".
---

# /flowlever:summarize — say what a workspace is about, without re-reviewing it

The cockpit has no model of its own, so `feature.summary` is only ever written by a skill. A
workspace reviewed before that field existed therefore shows an empty panel forever, and a full
re-review is an expensive way to fix a missing paragraph — it re-runs the whole spec-aware review
and re-ingests a round. This skill is the cheap path: **read the sources the workspace already
carries, write what is missing, change nothing else.**

**Hard boundaries — this job is a read.**
- Never post to the PR, never write to a work item or Confluence page, never `ingest` a round,
  never change a finding's status. Those are other skills, behind the user's explicit Apply.
- Never invent. Everything written here comes from a source you actually fetched. If a fetch
  fails, say so and write the summary from what you did read — or write nothing and report why.

## 1. Read the workspace
```
FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" feature show <wsId> --json
```
That gives you `kind`, the current `summary` (may be null — that is why you are here) and
`sources` (confluence / ado / figma), each with its `url`. **The sources are the input.** Do not
go discovering new ones; if the workspace has none, stop and say so — the fix is a review round,
not a guess.

> **Run from the cockpit queue (`/flowlever:watch`) — emit phases** with the request id `<reqId>`:
> `requests set <reqId> --phase "<step>"` at each step, and flag `needsInput` *before* the first
> Azure DevOps / Confluence fetch (it can pop a 2FA/auth prompt in another window), clearing it
> once a fetch succeeds. Skip these calls when invoked directly.

## 2. Fetch those sources (READ ONLY)
Load the MCP tools with ToolSearch first — they are deferred. One failed fetch never aborts the
job: record what you could not read and continue with the rest.

- **Azure DevOps** (`mcp__azure-devops__*`): for the PR source, `repo_pull_request action:get` —
  the **description** is usually the single most useful input. For each work item,
  `wit_work_item action:get` with **`expand:"Fields"`** (not a `fields` list — the two are mutually
  exclusive) so you get Description, Acceptance Criteria, `System.WorkItemType` **and
  `Custom.Vertec`**.
- **Confluence** (`mcp__claude_ai_Atlassian_Rovo__*`): resolve the cloudId from the page URL host,
  then `getConfluencePage` for each registered spec page.

## 3. Write the summary
```
... cli.js feature summary <wsId> --text "<2–4 sentences>"      # or --file <md> for longer
```
Answer the question a reviewer has **before** reading the diff: *what is this change, and why.*
- Lead with the change in one plain sentence — feature added, bug fixed, refactor, migration.
- Then the mechanism, in the plainest words the subject allows.
- Then anything that materially narrows the scope: parts deferred, a blocked dependency, what the
  ticket rescoped. This is what stops a reviewer re-deriving the context from the diff.

Markdown renders — short paragraphs or a few bullets. **Never paraphrase the title back**: that is
the text already on screen, and a summary that restates it has told the reader nothing. Headings
are unnecessary in something this short.

## 4. While you are here: backfill what the header cannot derive
You have just fetched the work items, so record the two fields the cockpit needs and cannot guess.
This is most of the value on an older workspace — without them the Sources strip shows a row of
identical grey "Work item" chips and the Vertec booking line is suppressed entirely.

For **each** ado source, re-register it with what you read (`source add` merges — it updates the
entry rather than adding a second one):
```
... cli.js source add <wsId> --type ado --id <id> --itemType "<System.WorkItemType>" \
    --title "<System.Title, VERBATIM>" --url "<the url already on the source>" \
    --vertecPhase "<Custom.Vertec>"        # omit the flag entirely when the field is empty
```
- `--itemType` for the PR source is **`"Pull Request"`**.
- `--title` must be the work item's **own `System.Title`, unedited**. The cockpit builds the
  copy-to-clipboard Vertec booking line (`FZAG-<id> <title>`) from it and that string is pasted
  into a real booking — do not prefix, annotate or improve it. (An older workspace often carries an
  editorial title like `"FOAN00 #42700"`; replacing it with the real one is the point of this step.)
- Omit `--vertecPhase` when `Custom.Vertec` is empty. A blank value is dropped rather than stored,
  so it cannot wipe a phase already on file; `--clear-vertec-phase` is the explicit way to remove
  one that was emptied in ADO.

## 5. Report
Say what you wrote, in one short block: the summary (or why there is none), how many ado sources
gained a type, and whether a Vertec phase was found. **A run that ends with `feature.summary` still
null is a failure** unless you state plainly why — no readable sources, every fetch refused. Verify
before you finish: `... cli.js feature show <wsId> --json` must show a non-null `summary`.

The runner then marks the request done:
`requests set <reqId> --status done --phase "summary written" --wsId <wsId>`.
