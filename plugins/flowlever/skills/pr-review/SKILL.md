---
name: pr-review
description: >
  Load an Azure DevOps pull request into the FlowLever cockpit as a `pr-review` workspace: fetch the
  PR diff + spec/ticket, produce review findings anchored to file:line, and ingest them so you can
  step through and decide each one in the same review UI as specs — then post the kept comments back
  to the PR. Use when the user says "review PR X in the cockpit", "load PR X into flowlever",
  "/flowlever:pr-review X", or "PR review X with the stepper". For a plain markdown/interactive review
  without the cockpit, use the standalone `/pr-review` skill instead.
---

# /flowlever:pr-review — PR review, in the cockpit

Bridges the existing `/pr-review` skill into the FlowLever review cockpit. The **fetch + analysis is
identical to `/pr-review`** — if this monorepo also has that standalone skill checked out (a sibling
of `plugins/`, typically at `skills/pr-review/SKILL.md` relative to the repo root; `${CLAUDE_PLUGIN_ROOT}`
won't resolve it, since it points inside `plugins/flowlever`), read it there for the fuller
methodology. A standalone plugin install won't have it, so don't depend on it: everything you
actually need is inlined below — spec-aware review methodology (§2's mandatory spec discovery),
auto-discovery of ticket/spec, and severity calibration (§3). The difference from the standalone
skill: findings go into a `pr-review` **workspace** so they're reviewed in the same stepper as
specs, and decisions are posted back as inline PR comments on **Apply**.

## Review scope (per-run instructions)
If the request carries `instructions` (the user's free-text scope/focus for this run, e.g. "front-end
only", "back-end only", "focus on the import validation"), treat them as the **review scope/focus**:
restrict or prioritize accordingly — review only the changed files in scope and say which you skipped, or
lead with the focus area. **Spec discovery (mandatory, below) still applies**, scoped to what's relevant.
State the applied scope explicitly in the run summary, and record it on the workspace so the cockpit shows
it: set `feature.reviewBrief` to the instruction (via a small node script using
`require("${CLAUDE_PLUGIN_ROOT}/app/src/ledger.js")` → `getFeature`/`saveFeature`). With no instructions,
review the whole diff as usual.

## 1. Resolve / create the workspace
- Input = a PR id or URL (ask if missing — don't guess).
- **Reuse an existing workspace for this PR when one exists** — this is what makes a re-review
  reconcile into the same ledger instead of forking a duplicate:
  1. If the request carries a `wsId` (the cockpit's "↻ Re-review" passes the workspace to re-run),
     use exactly that workspace.
  2. Otherwise list workspaces and reuse any whose id starts with `pr-<id>-`
     (`FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" feature list`).
  3. Only if none exists, create one with id `pr-<id>-<short-slug>` (e.g. `pr-482-checkout-api`):
     `FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" feature add <wsId> --title "PR #<id> — <pr title>" --kind pr-review`
- Register sources: the PR, plus any auto-discovered ticket/spec, via `source add` (use `ado`/`confluence`).
  **Always pass `--itemType`** on an ado source (`"Pull Request"` for the PR itself, `"User Story"` /
  `"Bug"` / `"Feature"` for the work items) — the cockpit badges and colour-codes each source by it, and
  an untyped work item is drawn as a generic "Work item" that the user has to read the title to identify.
- If the request carried `instructions`, persist them onto the workspace as `feature.reviewBrief` here.

> **When run from the cockpit queue (`/flowlever:watch`), emit phases as you go** so the job row shows
> live progress instead of an opaque spinner. With the request id as `<reqId>`:
> `requests set <reqId> --phase "<step>"` at each step below, AND — critically — flag `needsInput`
> *before* the first Azure DevOps fetch (it can pop a 2FA/auth prompt in another window), then clear it.
> Skip these `requests set` calls when invoked directly (no `<reqId>`).

## 2. Fetch + review (reuse /pr-review)
**Before the first ADO call** (may trigger 2FA/auth):
`requests set <reqId> --phase "fetching PR #<id> (may need your approval)" --needs-input --note "If a 2FA/auth prompt appears in another window, approve it to continue."`
Load the ADO MCP tools via ToolSearch, then exactly as `/pr-review`:
`repo_get_pull_request_by_id` (PR + linked work items), `repo_get_pull_request_changes` (diff) **and
`repo_get_pull_request_threads` (the comments the PR already carries)**. Both, not either — the diff
tells you what changed, the threads tell you what has already been said about it. **Once the first
fetch succeeds, clear the prompt:** `requests set <reqId> --no-needs-input --phase "fetching linked ticket/spec"`.

**Register the existing threads on the workspace before you ingest anything** — `ingest` refuses a
PR workspace whose threads were never recorded, so this is not optional:
```
FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" \
  threads set <wsId> --file <threads.json>     # or --none if the PR genuinely has no comments
```
`threads.json` is `[{ "threadId", "author", "locus", "excerpt?", "url?" }]`, one entry per existing
thread — **other reviewers' and your own from earlier rounds**. Use the same
`pr:<id>:<path>:L<line>` grammar for `locus` as findings use, taken from the thread's file anchor
(omit it for a PR-level comment with no anchor). Deep link: `.../pullRequest/<prId>?discussionId=<threadId>`.

**MANDATORY spec discovery — do NOT skip (this is the whole point of a *spec-aware* review):**
1. Read the **linked work item** off the PR; fetch its Description + Acceptance Criteria **and the
   `Custom.Vertec` field** (the "Vertec" field under the work item's *Administration* section — it
   carries the booking phase). Use `expand:"Fields"` on `wit_work_item` so custom fields come back;
   `fields:[...]` and `expand` cannot be combined.
2. **Scan the ticket Description/AC for every Confluence link** (`*.atlassian.net/wiki/...` incl. tiny
   `/wiki/x/<id>` links). Recurse one level into those pages for sub-spec links (contracts, matrices).
   Fetch each via `getConfluencePage`.
3. **Register every source you used as a workspace source** so the UI's Sources strip is complete and
   honest — the PR (`--type ado --itemType "Pull Request"`), the ticket (`--type ado --itemType "User
   Story"` — or its real type: Bug / Task / Feature / Epic), and **each Confluence spec**
   (`--type confluence --id <pageId> --title "<page title>" --url "<url>"`). A code-only review with
   zero confluence sources is a FAILURE of this skill — if the ticket has spec links, they must be
   fetched AND registered.
   **Pass `--vertecPhase "<Custom.Vertec>"` on the ticket** when the field has a value, and always
   pass `--url` (the cockpit derives the `FZAG-` booking prefix from the ADO organisation in it):
   ```
   ... cli.js source add <wsId> --type ado --id 43057 --itemType "User Story" \
       --title "<work item title>" --url "https://dev.azure.com/<org>/<project>/_workitems/edit/43057" \
       --vertecPhase "<the Custom.Vertec value, verbatim>"
   ```
   `--title` must be the work item's **own** `System.Title`, unedited — the cockpit builds the
   copy-to-clipboard Vertec booking line (`FZAG-43057 <title>`) out of it, and that string is pasted
   into a real booking. Do not prefix, summarise or "improve" it.
4. If the ticket genuinely has no spec links, say so explicitly in the run summary (so "no specs" is a
   stated finding, never a silent omission).
5. **Write the workspace summary.** You have just read the PR description, the work item and the
   specs; the cockpit has no model of its own, so this is the only chance anything gets written:
   ```
   ... cli.js feature summary <wsId> --text "<2–4 sentences>"     # or --file <md> for longer
   ```
   Answer the question a reviewer has *before* reading the diff: **what is this change, and why**.
   Lead with the change in one plain sentence (feature added / bug fixed / refactor), then the
   mechanism, then anything that meaningfully narrows the scope (deferred parts, blocked
   dependencies, what the ticket rescoped). Markdown is rendered — short paragraphs or a few
   bullets. Write it from the sources; **never paraphrase the PR title back**, which is the text
   already on screen. Re-write it on every re-review so it tracks what the PR has become.
   **A run that finishes with `feature.summary` still null is a FAILURE of this skill** — same bar
   as step 3's registered specs. Check it before §4: `... cli.js feature show <wsId> --json` must
   show a non-null `summary`, and the run summary must say so.

Then `requests set <reqId> --phase "reviewing changes"` and run the spec-aware review: check the PR's
implementation against the fetched specs (contract/schema/column/AC compliance), not just code quality →
findings anchored to specific changed files + line ranges, with spec-mismatch findings citing the spec
locus (`confluence:<pageId>#<section>`).

## 3. Map findings → ingest shape

**Duplicate-comment detection (before ingesting) — ENFORCED, not advisory.** `ingest` compares
every finding's locus against the threads you registered in §2 and **rejects the whole round** if a
finding lands on an existing thread (same file, within 5 lines) without saying what it is relative
to that thread. You cannot post a second comment on a point somebody already made by forgetting to
check. The error names each colliding finding and thread, so a rejection is a to-do list, not a
puzzle.

That gate is positional and therefore blunt — it catches "same place", not "same point". It cannot
catch a duplicate anchored 40 lines away, and it will flag two genuinely different points that
happen to share a line. **You still owe the substantive judgement.** Compare every candidate against
the PR's existing threads (other reviewers' comments AND your own previously posted ones) and judge
by substance, not wording:
- Existing thread already makes the point → **drop the finding** and list it in the run summary as
  `covered by <author>'s thread on <file:line>` — never open a parallel thread for the same point.
  If it is worth keeping visible in the cockpit (e.g. the user should still triage it), ingest it
  with **`duplicateOf`** set (`{ "label": "<author> on <file:line>", "url": "<deep link>" }` — deep
  link: `.../pullRequest/<prId>?discussionId=<threadId>`; the cockpit shows an amber DUPLICATE chip
  linking there) and `suggestion` = the generic
  `Duplicate of [<author>'s comment on <file:line>](<deep link>) — already being handled there.`
- Existing thread touches the point but you add something material (a failure case, a concrete fix
  they missed) → keep the finding, but give it locus **`pr:<id>:thread:<threadId>`** and write the
  suggestion as a **reply into that thread** that adds ONLY the increment (open with
  `Adding to <author>'s point:`), not a restatement. On Apply, a thread-locus finding posts via
  thread reply, not a new thread.
- Genuinely a different point that merely sits near an existing thread → keep it and set
  **`notDuplicate`** to a one-line reason (`"Oriol is about the null check; this is the swallowed
  exception"`). This is what clears the positional gate; the cockpit shows a muted DISTINCT chip
  carrying your reason. It must be a real sentence — a bare `true` is rejected. Do NOT reach for
  this to make a rejection go away: if the reason you'd write is thin, it IS the duplicate.
- Your own earlier findings are already reconciled by fingerprint — this check is about threads
  from OTHER surfaces (human reviewers, other tools).

Report the outcome in the run summary: how many findings were dropped as covered, how many were
re-anchored as thread replies, how many were kept as DISTINCT. "0 duplicates found" on a PR that
already has comments is a claim worth double-checking before you state it.

For each review finding:
- `dimension`: reuse the existing set (correctness→`feasibility`/`consistency`, missing-thing→`completeness`,
  spec-mismatch→`consistency`, unclear→`ambiguity`, test gap→`testability`, DoR/process→`dor`,
  design→`design-match`). Severity per `/pr-review` calibration (blocker = must-fix before merge).
- `title`: a stable **label, ≤60 chars** — this is a FlowLever ledger field (what the cockpit's
  rail and summary rows show), not part of the posted PR comment, so it isn't in the code-review
  convention's Length rule below; it must survive truncation on its own terms. Name the defect,
  don't argue it ("Retry loop has no ceiling", not "The retry loop never stops because retryCount
  is compared after the increment").
- `detail`: what's wrong + why, quoting the relevant diff hunk. This is the **evidence**, collapsed
  behind "Why this was raised" in the cockpit — so write it for the reader who is *not* yet convinced
  by the comment, and do not repeat the ask that already appears in `suggestion`.
- `locus`: **`pr:<id>:<path>:L<line>`** (or `L<start>-<end>`). The line is the **new-file (right-side)
  line number of the exact code the comment is about**, read from the diff (`@@ … +<start>,<count> @@`
  counting down the new side) — never eyeballed/estimated. Point at the line whose content matches the
  snippet you quote in the body, not a nearby JSDoc/blank line. Stable loci = stable fingerprints across
  re-reviews (the diff moves — same reconcile model as spec re-audit).
- `suggestion`: **the proposed PR comment body — it IS what gets posted, so write it as a
  [Conventional Comment](https://conventionalcomments.org/)**: start with a label, then the concrete fix.
  Format: `<label>[ (blocking)]: <body>` (lowercase label, colon, space). Labels:
  - `issue` — a problem in the code (add `(blocking)` when it must be fixed before merge, i.e. severity blocker).
  - `suggestion` — a concrete change that isn't strictly required.
  - `question` — something the author must clarify/answer.
  - `nitpick` — trivial, non-blocking preference (style/naming/wording).
  - (also valid when they fit: `praise`, `thought`, `chore`.)
  Map from severity/dimension: blocker→`issue (blocking)`, major→`issue`, a proposed improvement→`suggestion`,
  `ambiguity`→`question`, minor style→`nitpick`. Examples:
  `issue (blocking): Cap retries — `if (retryCount >= MAX_RETRIES) return;` — or a persistently failing endpoint retries forever.`
  · `nitpick: rename `buf` → `baseBuffer` to match the deployed FTD field name.`

  **Length is a hard rule: ≤300 characters, ≤2 sentences.** Sourced from the Length section of
  `conventions/code-review.md` (this monorepo's canonical comment convention — inlined in full
  below so a standalone plugin install, which won't have that file, still gets the whole rule).
  Label, then the ask, then at most one clause of consequence — in that order, so the author knows
  what to do from the first line. Then stop.
  - **The ask goes first, not last.** Never build to it through a paragraph of reasoning; the reasoning
    belongs in `detail`. If the comment opens with "`x` loops over `y`, which is…", it is a `detail`
    that lost its way.
  - **Say it once.** If a sentence restates something the previous sentence or `detail` already said,
    cut it. Prose that reruns the same point is the single biggest cost a reviewer pays per finding.
  - **No essays, no scene-setting, no meta.** Drop "That is the failure mode this set exists to
    remove", "It is worth noting that", and anything recapping the PR's purpose back to its author.
  - **Plain words for technical things.** Stay precise — keep the identifier, the file, the number —
    but say "this passes when the list is empty" rather than "this exhibits a vacuous-pass boundary
    condition". Precision is in the specifics, not the register.
  - **Split, don't stack.** A comment that needs more than 300 characters is almost always two
    findings (e.g. "this check is vacuous" + "portalled roots escape it") — file them separately, each
    on its own `locus`. One comment, one ask.
  - Over budget and genuinely inseparable? Keep the ask in `suggestion` and move every supporting
    sentence into `detail`. `suggestion` is what your colleague reads in Azure DevOps; treat its
    length as their time.
Where you have a concrete code change, attach a **draft** so it shows as a red/green diff in the stepper:
`setFindingDraft(wsId, fp, { target: "<path>:L<line>", format: "text", before: "<current code>", after: "<suggested code>" })`
(via a small node script using `require("${CLAUDE_PLUGIN_ROOT}/app/src/ledger.js")`, or a future CLI cmd).
Dedup near-duplicates, then (`requests set <reqId> --phase "ingesting findings"`) ingest:
`FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" ingest <wsId> --file <findings.json> --note "PR #<id> review @ <commit/iteration>"`.

**Then stamp the PR's activity clock** — you just read the PR, so you know when the author last
touched it. Record the newest author comment / pushed iteration:
```
... cli.js feature activity <wsId> --at "<ISO ts of the author's newest update>" --by "<author>"
```
The ingest itself is the "Reviewed <when>" side of the cockpit's stamp pair (a round IS a review
pass); this is the "PR updated <when>" side. Stamping it here means the workspace reads correctly
the moment the review lands, instead of waiting for the next poll pass. Omit it only if the PR
genuinely has no author activity to point at.

The runner then marks the request `done --phase "review ready" --wsId <wsId>`.

## 4. Hand to the cockpit
Before handing over, confirm the three things the cockpit's header reads and cannot derive itself —
each one is a `source add` / `feature summary` you were told to make in §2, and each shows as a
visible gap if it was skipped:
`... cli.js feature show <wsId>` → a non-null **Summary**, every ado source carrying a `[type]`,
and a **Vertec phase** on the ticket (unless `Custom.Vertec` is genuinely empty — then say so).
An untyped ticket suppresses the Vertec booking line entirely, by design: the cockpit will not
guess which work item to book or trust a title it cannot confirm.

Tell the user to open **Home → PR Review → this workspace** (or `/flowlever:start`) and step through:
each finding shows the diff + decision row (Accept · Edit · Redirect · Waive · Skip). Decisions persist.

## 5. Apply (post comments back) — explicit confirmation required
When run as an `apply` request, emit phases too: `--phase "posting comments (may need your approval)"
--needs-input --note "Approve the auth prompt in your other window if asked."` before the first post,
clear it after, then `--status done --phase "posted to PR"`.
When the user has reviewed and asks to post: read their decisions
(`FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" finding list <wsId> --json` → use each finding's status + `draft.review` verdict/edited
text, or the exported work order). For every **accepted/edited** finding (skip rejected/waived), post an
inline PR comment via `repo_create_pull_request_thread` (use the user's edited text if present, else the
suggestion) — EXCEPT findings whose locus is `pr:<id>:thread:<threadId>` (duplicate-increment findings):
those post as a **reply into that existing thread**, never a new one. **Never post without an explicit
yes.**

**AI disclosure line — honor the request's `instructions`.** The cockpit's Post button carries a
disclosure toggle (default ON) as `instructions` on the apply request:
- `disclosure: append …` (or no instructions at all) → append `🤖 AI comment posted by Claude` as
  the **last line** of every posted comment, separated by a blank line.
- `disclosure: off` → post the reviewed text verbatim.
Beyond that one line, add NOTHING else — no other signature, attribution, or footer (no
"_AI-generated…_", "🤖 Generated with…", "Posted via FlowLever"). The body is exactly the finding's
suggestion or the user's edited text (+ the disclosure line when on).

### Anchoring — get the line right (this is what makes a comment land on the code it's about)
A finding's `locus` line is a *hint*; **verify it against the live diff before posting**, because an
off-by-N or old-vs-new-file line lands the comment on unrelated code (e.g. a JSDoc block instead of the
call it discusses). For each finding:
1. Re-fetch the latest diff once: `repo_get_pull_request_changes` (includeLineContent:true). For the
   finding's file, find the line whose **content actually matches the code the comment cites** (the
   symbol/snippet quoted in the body) — don't trust the stored number blindly.
2. Anchor to that line in the **RIGHT (new) file**, 1-based: pass `rightFileStartLine` (and
   `rightFileEndLine` to span a multi-line snippet; add `rightFileStartOffset`/`rightFileEndOffset` only
   if you need a sub-line span). ADO line numbers are the new-file lines, NOT the old-file or the diff's
   visual row.
3. The cited code is a **deleted** line (only in the old file)? ADO can't right-anchor a pure deletion —
   anchor to the nearest surviving new-file line (usually the replacement) and name the removed code in the
   body, or post it as a file-level thread (`filePath` only, no line) if there's no sensible line.
4. After posting, sanity-check the returned thread's `rightFileStart.line` matches your intended line;
   surface any that fell back to file-level so the user knows.
### Stamping is not optional — you are the ONLY thing that can confirm a post
**The cockpit cannot stamp a post; only you can.** When the user clicks Post, the UI sets a transient
`pending: "post"` marker (the "Posting…" lane) and enqueues the `apply` request — nothing more. The
`postedAt` stamp exists exactly once: when *you* record it after ADO accepted the comment. So:

**Stamp each finding the moment its comment lands — one call per finding, immediately after the
`repo_create_pull_request_thread` for it succeeds. Never batch this to the end of the run.**
```
FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" finding posted <wsId> --fps <fp>
```
Batching is what strands work: if the session dies, 2FA times out, or an ADO call fails halfway, every
comment you already posted is left marked "Posting…" forever — the cockpit shows in-flight work that
will never resolve while the comments are actually sitting on the PR. Per-finding stamping makes any
interruption leave a truthful partial state instead.

A posted finding stays `reworking` but is stamped `postedAt` → it moves to the cockpit's **"Posted —
awaiting author"** lane, stops being re-counted as "to review", and no longer drags the readiness score
down. Do **not** set posted comments to `resolved` — that would hide them from the re-review reconcile.

**Before posting anything, check what is already there (resume-safe / no double posts).** A finding
marked `pending: "post"` with no `postedAt` means a previous attempt was interrupted — it does NOT tell
you whether the comment made it. List the PR's threads first
(`repo_pull_request_thread action:list`) and compare against the findings you are about to post:
- a thread whose body already matches the finding's comment (same anchor + text, authored by you) →
  **do not post again**; just stamp it (`finding posted <wsId> --fps <fp>`) — the write did happen,
  only the stamp was lost.
- no matching thread → post it normally, then stamp.
Skipping this check is how a retried apply ends up posting the same comment twice.

**If the apply fails or you abandon it, release what you did NOT post** — otherwise those findings stay
stuck in the "Posting…" lane with no way back:
```
... cli.js finding cancel <wsId> --fps <fp>[,<fp>...] --reason "post failed: <short reason>"
... cli.js requests set <reqId> --status error --note "<short reason>"
```
(`finding cancel` with no `--fps` releases every still-pending finding in the workspace. It never
touches ones already stamped `postedAt`, so it is safe to run after a partial success.)

## 6. Re-review (after the author responds) — same reconcile loop as specs
When the author has replied or pushed new commits, **re-run this exact skill against the SAME `<wsId>`**
(the cockpit's "↻ Re-review" button on the `(re-run)` stage enqueues a fresh `pr-review` request for the
same PR; `/flowlever:watch` then runs this skill again). Re-fetch the PR diff + threads, re-run the
spec-aware review, and re-`ingest` into the same workspace. Reconciliation does the rest, keyed on the
stable `pr:<id>:<path>:L<line>` loci:
- a posted finding the author **addressed** drops out of the new set → **auto-resolves** (moves to Resolved);
- one **still flagged** stays (its `postedAt` and lane are preserved);
- anything **new** is inserted as `open` for a fresh triage pass.
The reviewer can also close a posted finding manually at any time from the board (Mark resolved / Reopen /
Dismiss) when no author response is needed.
