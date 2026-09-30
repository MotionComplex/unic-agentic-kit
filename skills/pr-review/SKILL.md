---
name: pr-review
description: >
  Performs a spec-aware code review of an Azure DevOps pull request. Required input: a PR ID or
  PR URL. Optional inputs: a Confluence specification page (URL/ID/title) and/or an ADO work item
  (ID/URL) — if not provided, the skill auto-discovers them: the linked work item is read off the
  PR, and Confluence spec links are extracted from the PR description and the ticket
  description/acceptance criteria, then auto-fetched. Pulls the PR diff via the Azure DevOps MCP,
  fetches spec/ticket context via the Atlassian Rovo and Azure DevOps MCPs, and produces a review
  that ties findings to specific changed files and line ranges. Use this skill when the user asks
  to "review PR X", "code review PR X against spec/ticket Y", "check PR X meets the requirements",
  or similar. Supports three delivery modes: markdown-first (async iteration via review file),
  interactive (walk through findings one-by-one in chat), and one-shot (draft → confirm → post).
compatibility: "Requires Azure DevOps MCP (PR access + commenting) and Atlassian Rovo MCP (Confluence). The /review and /context-brief skills are related but distinct: /review is a generic PR review, /context-brief only fetches context. This skill combines both into a spec-aware PR review with optional posting."
---

# Spec-Aware PR Review Skill

Reviews an Azure DevOps pull request against its specification (Confluence) and ticket (ADO work
item). Produces findings anchored to specific files and line ranges, then delivers them via one
of three modes (markdown-first, interactive, or one-shot) — based on the user's choice.

---

## When to use this skill

Trigger when the user asks for a code review of a specific PR, especially when they reference a
spec or ticket. Examples:

- "Review PR 12345"
- "Code review https://dev.azure.com/.../pullrequest/12345 against story 67890"
- "Check that PR 12345 actually implements the spec on Confluence page ABC"
- "Do a proper review of PR 12345, here is the ticket and the confluence page"

If the user only asks for a generic "review my changes" without referencing a PR, prefer the
existing `/review` skill instead.

---

## Required & optional inputs

| Input | Required | Forms accepted |
|---|---|---|
| PR reference | **Yes** | PR ID (e.g. `12345`) or full Azure DevOps PR URL |
| Confluence spec | No — **auto-discovered** if not given | Page URL, page ID, or page title |
| ADO work item | No — **auto-discovered** if not given | Work item ID or URL |

If the PR reference is missing, **ask the user** for it before proceeding — do not guess.

**Auto-discovery behavior** (when the user provides only a PR ref):
- The **linked ADO work item** is read directly off the PR (via `repo_get_pull_request_by_id`,
  which returns linked work items) and auto-fetched in Step 3.
- The **Confluence spec** is auto-discovered by scanning the PR description and the linked
  ticket's description / acceptance criteria for Confluence URLs (any `*.atlassian.net/wiki/…`
  or configured Confluence host). The first match is auto-fetched in Step 3. If multiple
  distinct Confluence pages are found, list them and ask the user which one(s) to use.
- **Recursive sub-spec discovery (depth=2):** also scan the fetched Confluence page for further
  Confluence links to sub-specs (event matrices, error tables, contract docs). Sub-specs often
  hold the actual acceptance criteria. Fetch the most-relevant ones; don't go deeper than 2.
- If auto-discovery finds nothing, proceed but note in the review that the requirements context
  is limited — do not block on it.

---

## Step-by-step instructions

### Step 1: Parse inputs

From the user's message, extract:
- `pr_ref` (required) — numeric ID or URL
- `confluence_ref` (optional)
- `ado_ref` (optional)

For an Azure DevOps PR URL like
`https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}`, capture `org`, `project`,
`repo`, and `id`. The MCP tools generally need at least the PR id and a repo identifier.

If `pr_ref` is missing, ask: *"Which PR should I review? Share the PR ID or the Azure DevOps PR
URL."* and stop until they reply.

---

### Step 2: Fetch PR metadata and diff

Use the **Azure DevOps MCP**:

1. `repo_get_pull_request_by_id` — title, description, source/target branches, status, author,
   reviewers, linked work items, **source commit SHA** (needed for the large-diff fallback).
2. `repo_get_pull_request_changes` — the diff (changed files, added/removed line ranges, hunks).
   **Large-diff fallback:** if this exceeds the response token limit (typical on PRs with >3MB
   diff), skip it and instead use the changed-file list from step 1, then read each file via
   `repo_get_file_content` at the source commit SHA.
3. **Auto-discover the ticket:** if no `ado_ref` was provided, take the first linked work item
   from the PR (or any work-item ID referenced in the PR description) and treat it as the
   `ado_ref` for Step 3. Note in the review's Sources block that it was auto-discovered.
4. **Pre-scan for Confluence links:** if no `confluence_ref` was provided, scan the PR
   description and title for Confluence URLs. Hold any matches for use in Step 3.

If the PR is already merged or abandoned, surface that to the user **before continuing** and
confirm the scope (advisory comments only, or expected to drive a follow-up PR?). See Step 8c.

---

### Step 3: Fetch spec and ticket context (provided or auto-discovered)

This step mirrors the `context-brief` skill but is **scoped to what the review needs**, not a full
brief. Both the ticket and the Confluence spec can be auto-discovered — the user does not need
to supply them explicitly.

**Azure DevOps work item** — if `ado_ref` provided **or auto-discovered from PR links** (Step 2.3):
- Fetch via `wit_get_work_item`.
- Extract: title, type, description/repro, acceptance criteria field, state, linked items.
- After fetching, **scan the work item's description, acceptance criteria, and remote/issue
  links for Confluence URLs** — these feed the auto-discovery below.

**Confluence (Atlassian Rovo MCP)** — if `confluence_ref` provided **or auto-discovered**:
- Auto-discovery sources (in order): the PR description/title (Step 2.4), then the linked
  ticket's description / acceptance criteria / remote links.
- Match any Confluence URL — typically `*.atlassian.net/wiki/spaces/.../pages/{id}/...` or
  `*.atlassian.net/l/...` short links. Resolve the page ID from the URL.
- If exactly one distinct Confluence page is found, fetch it and proceed.
- If multiple distinct pages are found, list them in the conversation and ask the user which
  one(s) to use before fetching — don't silently pick.
- If `confluence_ref` was a title (not a URL/ID), search by title first, then fetch by ID.
- **Recursive sub-spec scan (depth=2):** after fetching the main spec, scan it for further
  Confluence links to sub-specs (event matrices, error tables, API contracts). Fetch the ones
  obviously relevant to the PR's changes; skip the rest.
- Extract: page title, last-updated date, the sections relevant to the PR's changes (acceptance
  criteria, business rules, API contracts, UI behavior). Skip unrelated sections.

In the review's **Sources** block, mark auto-discovered items so the user knows what was inferred
(e.g. *"Ticket: ADO #67890 — auto-discovered from PR links"*, *"Spec: {page title} —
auto-discovered from ticket description"*).

If a source can't be fetched, tell the user which one failed and continue with what's available.
If neither a ticket nor a spec is found after auto-discovery, proceed but say so explicitly in
the Summary — the review's requirements coverage will be limited.

---

### Step 4: Build the requirements checklist

From the spec + ticket, derive a concrete **requirements checklist** before reading the diff in
detail. Each item should be something you can check against the code.

Examples:
- "Adds a `cancel` button to the booking dialog that calls `POST /bookings/{id}/cancel`"
- "Field `customerId` is validated as non-empty before submit"
- "Logs the failure with severity `Warning`, not `Error`"

If acceptance criteria are vague, infer narrower checks and **flag the inferred ones** in the
review's "Open Questions" section so the user can confirm.

---

### Step 5: Review the diff against the checklist

For each changed file in the PR diff:

1. Read the changed hunks. For non-trivial files, also read the surrounding code (via `Read` or
   `repo_get_file_content`) so feedback isn't isolated from context. The diff alone often
   misses why a change is wrong.
2. Map changes to checklist items: which requirement does this hunk implement? Which requirements
   are unaddressed? Which changes are not covered by any requirement (potentially out of scope)?
3. Note issues independent of the spec: bugs, regressions, security risks (OWASP-style), missing
   error handling at boundaries, dead code, broken types, test coverage gaps, conventions
   violations evident from neighbouring files.

**Anchoring rule:** every finding must reference `path/to/file.ext:line` or
`path/to/file.ext:start-end`. Findings without a code anchor are unactionable — drop them or find
the right anchor.

---

### Step 6: Draft findings

Internally produce a list of findings with the structure below. The full markdown document is
only materialized in **markdown-first** mode (Step 7a); other modes consume the findings list
directly.

```
- anchor: path/to/file.ts:88
  label:  issue (blocking)
  topic:  null-pointer in cancel handler
  body:   "If `booking` is undefined, line 88 crashes — guard with early return."
  decision-required: false   # true if user input is needed before this can be posted
```

Use **[Conventional Comments](https://conventionalcomments.org/)** labels:
- `issue` — a problem in the code. Add `(blocking)` if it must be fixed before merge.
- `suggestion` — a concrete proposed change that isn't strictly required.
- `question` — something the reviewer needs the author to answer/clarify.
- `nitpick` — trivial, non-blocking preference (style, naming, wording).

**Length: ≤300 characters, ≤2 sentences.** Label, then the ask, then at most one clause of
consequence — in that order, so the ask never waits behind a paragraph of reasoning. `body` **is**
the comment that gets posted, so this budget governs it directly: reasoning that does not fit
belongs in the review document's surrounding prose, which the author never receives as a thread —
not appended to `body`. Say it once, use plain words for technical specifics, and split a comment
that needs more than 300 characters into two findings rather than stacking points on one anchor.
See [Length][cc-length] in the code-review convention for the full rule, the measured cost of
skipping it, and a worked example.

[cc-length]: ../../conventions/code-review.md#length

Also produce, separately:
- **Summary** — 2–4 sentences, overall recommendation.
- **Requirements coverage** — `[x]` met, `[~]` partial, `[ ]` missing, each with file anchor.
- **Out of scope changes** — diff items not covered by spec/ticket.
- **Open questions** — fully framed (context + options + recommended default), each one ready to
  be answered without further back-and-forth.

---

### Step 6.5: Choose delivery mode

Ask the user which mode they want:

> "How would you like to handle review iteration?
> 1. **Markdown-first** — I write the review to `docs/reviews/pr-{id}-review.md` with reply
>    blocks under each finding. You annotate it asynchronously, I read it back, we converge,
>    then post final comments to the PR. Best for large/complex reviews.
> 2. **Interactive** — We walk through findings one at a time in chat. For each: I present the
>    finding + recommended action, we clarify together, the output is an immediate decision
>    (post / drop / defer). Best for medium reviews where you want fast convergence.
> 3. **One-shot** — I draft the full review in-conversation, you confirm, I post everything.
>    Best for small reviews or when you trust the draft."

Default suggestion: **Interactive** for 5–15 findings, **Markdown-first** for >15 or
spec-heavy reviews, **One-shot** only for trivial ones.

Do not produce or post anything until the user picks a mode.

---

### Step 7a: Markdown-first delivery

Write the review to `docs/reviews/pr-{id}-review.md` (create the directory if missing). Use this
structure:

```markdown
# PR Review: !{PR_ID} — {PR Title}

> **Decision Log** — append a one-liner each time the user resolves a question or overrides a
> finding. Format: `YYYY-MM-DD — {decision} ({finding ref})`.

> **How to use this doc**
> - Reply to each finding by filling the `> **You:**` block underneath it.
> - 🔴 markers indicate findings/questions that need a decision before we can post.
> - Claude responses appear as: <span style="color:#1f6feb">🤖 **Claude:** …</span>

**Sources**
- PR: !{PR_ID} ({source_branch} → {target_branch}, {state}, by {author})
- Spec: {Confluence page title} (updated {date})            ← omit if absent
- Ticket: ADO #{id} {title} ({type} · {state})              ← omit if absent

## Summary
2–4 sentences: what the PR does, whether it meets the requirements, and the overall recommendation
(approve / approve with comments / request changes).

## 🔴 Decisions required
Front-load anything blocking convergence here as a numbered list, each linking to the relevant
finding/question below.

## Requirements coverage
- [x] Requirement 1 — implemented in `path/file.ts:42-58`
- [ ] Requirement 2 — **missing**: no code addresses the cancel-button behavior
- [~] Requirement 3 — **partially**: `path/other.ts:120` covers the happy path, error path absent

## Findings

### issue
#### 🔴 `path/to/file.ts:88` — issue (blocking): null-pointer in cancel handler
Description and suggested fix.

> **You:** _your reply here_

### suggestion
#### `path/to/file.ts:42` — suggestion: extract retry policy
…

> **You:** _your reply here_

### question
…

### nitpick
…

## Out of scope changes
Changes in the diff that don't map to any spec/ticket requirement. List with file anchors.

## Open questions
Each one fully framed: context, options, recommended default. The user should be able to answer
without follow-up clarifications.
```

After writing, tell the user the path and wait for their annotations. When they reply, re-read
the file, append `🤖 **Claude:**` responses inline (color-coded), and update the Decision Log.
Iterate until no 🔴 markers remain, then move to Step 8.

Omit empty sections rather than writing "None". If there are zero blocking issues, say so
explicitly in the Summary so the user knows the review was thorough, not lazy.

---

### Step 7b: Interactive delivery

Walk through findings one at a time in chat. For each finding:

1. Present it: `**{anchor}** — {label}: {body}`. If it has no decision required, end with "Post
   this? (y/n/edit)" — minimize friction.
2. If decision required (e.g. depends on spec interpretation, scope question), present options
   with a recommended default and resolve **before** moving on.
3. On `y`, post immediately via Step 8. On `n`, drop. On edit, revise and re-confirm.
4. Maintain a running tally in chat: `Posted: 3 · Dropped: 1 · Deferred: 0 · Remaining: 5`.

At the end, summarize what was posted, dropped, and deferred so the user has a record without
scrolling back through chat.

---

### Step 7c: One-shot delivery

Draft the full review in chat (use the markdown structure from Step 7a but inline, no file).
Ask the user to confirm. On confirm, post everything via Step 8.

---

### Step 8: Post to the PR

Use **Azure DevOps MCP**. Each finding gets its own thread to keep conversations clean and
independently resolvable:

- **Code-anchored findings** → inline thread via `repo_create_pull_request_thread`. Anchor to the
  **RIGHT (new) file**, 1-based: pass `rightFileStartLine` (+ `rightFileEndLine` to span a snippet).
  **Get the line from the live diff, not memory** — re-check `repo_get_pull_request_changes`
  (includeLineContent:true) and anchor to the line whose content matches the code you cite; an
  off-by-N or old-vs-new-file line lands the comment on unrelated code (e.g. a JSDoc block). The cited
  code is a pure deletion (old file only)? ADO can't right-anchor it — use the nearest surviving new-file
  line and name the removed code in the body, or post it file-level. Verify the returned thread anchored
  where you intended.
- **Cross-cutting findings without a single anchor** (e.g. spec ambiguity, scope question,
  test-coverage gap that spans files) → one **top-level PR thread per topic**. Don't bundle
  unrelated topics into a single overview thread — separate threads keep each conversation
  resolvable independently.

Do **not** post a summary/overview thread. The PR description, the markdown review file (if
used), and the per-thread context are sufficient.

**Do not duplicate existing threads.** Before posting, compare each finding against the PR's
existing threads (other reviewers' and your own). Same point already raised → drop yours and note
`covered by <author>'s thread on <file:line>` in the summary. Point raised but you add something
material → reply into that thread with only the increment (`Adding to <author>'s point: …`), never
a parallel new thread.

**AI disclosure line:** by default, append `🤖 AI comment posted by Claude` as the last line of
each posted comment (blank line before it) — Elias wants AI-drafted comments disclosed since they
post under his identity. Skip it only if the user says to post verbatim / without the disclosure.
Beyond that one line, add nothing — no other signature/attribution/footer ("_AI-generated…_",
"🤖 Generated with…", "Posted via …"). The body is exactly the finding text or the user's edit.

Do **not** vote on the PR (`repo_vote_pull_request`) unless the user explicitly asked for it —
voting is a stronger action than commenting and should be opt-in.

Surface any threads that fail to post (e.g. line moved, file deleted) so the user can post them
manually.

---

### Step 8c: Merged or abandoned PRs

If the PR is already merged (Step 2), confirm scope **before** drafting:

> "This PR is already merged. Should the review be:
> 1. **Comment-only** — leave findings as PR/ticket comments without expecting code changes, or
> 2. **Drives a follow-up PR** — findings get bundled into a fix branch?"

Default: comment-only. **Don't propose a follow-up PR unless the user asks for one.** For
comment-only mode, post inline threads on the merged PR (Azure DevOps allows this) and/or
comments on the linked work item.

Findings that map to a sub-task or future phase belong as a comment on the parent user story or
the relevant sub-task — match the user's request; don't guess.

---

## Tooling notes

- **Diff size limit:** `repo_get_pull_request_changes` may exceed the response token limit on
  large PRs (>3MB diff). Fallback: use `repo_get_pull_request_by_id` to identify changed files
  and the source commit SHA, then read each file via `repo_get_file_content` at that SHA.
- **Recursive spec discovery:** scan not only the PR/ticket descriptions but also any Confluence
  pages they link to (depth=2). Sub-specs (event-tracking matrices, error-handling tables) are
  often where the actual acceptance criteria live.
- **Azure DevOps mentions (UNRESOLVED):** neither `@Display Name` nor `@<Display Name>` produces
  a real ADO mention with notification — both render as plain text. Until resolved, write
  comments with the person's name in plain text and ping them out-of-band (Teams/email) if the
  comment is time-sensitive. Revisit when a working syntax is identified.

---

## Tips

- **Read code around the diff.** A diff-only review misses regressions in callers and inconsistent
  patterns elsewhere in the file. Use `Read` on the full file when a change is non-trivial.
- **Be concrete.** "Consider error handling here" is noise. "If `fetch` rejects, `data` is
  undefined and line 88 crashes — wrap in try/catch and return early" is a review.
- **Don't invent requirements.** If something isn't in the spec or ticket, say so — flag it as Out
  of scope or Open questions, don't reject the PR for missing it.
- **Anchor every finding.** No file:line, no finding.
- **Use `issue (blocking)` sparingly.** Reserve it for correctness, security, data loss, or hard
  requirement misses. Style and naming preferences are `nitpick`, not `issue`.
- **Prefer `question` over `issue` when uncertain.** If you're not sure the code is wrong, ask
  rather than assert.
- **Confidence floor.** If a finding requires speculation about runtime behavior or external
  state you can't verify, drop it or convert to a `question`. Speculative `issue`s waste the
  author's time and erode review trust. When in doubt, read the surrounding code first; if still
  uncertain, ask.
- **Unfold open questions in one pass.** Each open question should be fully framed (context,
  options, recommended default) the first time it's raised — not dribbled across iterations.
  If you don't have enough info to frame it fully, read more code before asking.
- **One review pass, not many.** Don't dribble follow-up comments after the user picks a delivery
  mode — finalize before delivering.
