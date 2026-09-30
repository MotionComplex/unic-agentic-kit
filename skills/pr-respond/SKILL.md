---
name: pr-respond
description: >
  Helps the PR author react to reviewer feedback on an Azure DevOps pull request. Required input:
  a PR ID or PR URL — if not provided, the skill auto-detects the PR from the current git branch
  (matches active PRs by source branch). Fetches all comment threads via the Azure DevOps MCP,
  filters to threads that are awaiting an author response (active status, latest comment not from
  the user), reads the current code at each thread's anchor so the response reflects the latest
  state, and walks the threads with the user to decide per-thread: apply a code fix, draft a
  reply, push back, ask a clarifying question, or defer. Code changes are made via Edit/Write;
  replies are posted via `repo_reply_to_comment`. Sibling to `/pr-review` — that skill produces
  reviews, this one responds to them. Supports four delivery modes: markdown-first (async
  iteration via a responses file), interactive (walk threads one-by-one in chat), one-shot
  (draft everything → confirm → post), and critical (scrutinize each comment, flag
  clarifications, then one-shot-style confirm → post).
compatibility: "Requires Azure DevOps MCP (PR thread access + commenting). Sibling to `/pr-review`: /pr-review produces outbound reviews; this skill handles inbound reviewer feedback on the author's own PR. Does not commit or push code changes — leaves that to the user unless explicitly asked."
---

# PR Response Skill

Reacts to reviewer feedback on an Azure DevOps pull request from the author's side. Fetches
unresolved threads, reads the current code at each anchor, then walks the threads with the user
to decide per-thread: fix code, reply, push back, ask, or defer — and applies/posts the result.

---

## When to use this skill

Trigger when the user wants to address feedback on their own PR (or a PR they're driving).
Examples:

- "Respond to the review comments on PR 12345"
- "Walk me through the feedback on my PR"
- "Address the reviewer comments on this branch's PR"
- "Help me react to the comments on PR 12345"
- "What did the reviewers say on my PR and what should I do about it?"

If the user wants to **produce** a review of someone else's PR, use `/pr-review` instead. This
skill is the inverse — receiving feedback, not giving it.

---

## Required & optional inputs

| Input | Required | Forms accepted |
|---|---|---|
| PR reference | No — **auto-detected** from current git branch if absent | PR ID (e.g. `12345`) or full Azure DevOps PR URL |
| Thread filter | No | `unresolved` (default), `all`, or a specific thread ID |
| Reviewer filter | No | A reviewer's display name to focus on (e.g. "only respond to Alex's comments") |

**Auto-detection behavior** (when no PR ref is given):

1. Read the current git branch (`git rev-parse --abbrev-ref HEAD`).
2. Query `repo_list_pull_requests_by_repo_or_project` filtered by source branch and `active`
   status.
3. If exactly one active PR matches, use it (tell the user which one in one line).
4. If multiple match, list them and ask which one.
5. If none match, ask the user for the PR ID/URL — don't guess.

---

## Step-by-step instructions

### Step 1: Parse / detect PR

From the user's message, extract:
- `pr_ref` — numeric ID or URL (optional; auto-detect if missing)
- `thread_filter` — optional (default `unresolved`)
- `reviewer_filter` — optional

For an Azure DevOps PR URL like
`https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}`, capture `org`, `project`,
`repo`, and `id`.

If `pr_ref` is missing, run auto-detection (above). If auto-detection fails, ask the user.

---

### Step 2: Fetch PR metadata

Use **Azure DevOps MCP**:
- `repo_get_pull_request_by_id` — title, description, source/target branches, status, **author**,
  **reviewers**, linked work items, source commit SHA.

**Author sanity check:** if the PR's author is not the current user (from `userEmail` in context
or `git config user.email`), confirm with the user: *"This PR is by {author}, not you. Are you
helping them address feedback, or did you mean a different PR?"* — then proceed based on their
answer.

If the PR is merged or abandoned, surface that and confirm scope before proceeding — see
Step 8c.

---

### Step 3: Fetch and filter threads

Use `repo_list_pull_request_threads` to get all threads. For each thread, fetch comments via
`repo_list_pull_request_thread_comments` if not already inlined in the list response.

**Default filter (`unresolved`):** keep a thread if **all** of these hold:

1. Status is `active` (or `pending` if present). Skip `fixed`, `closed`, `byDesign`, `wontFix`.
2. It is a **discussion** thread — not a system/iteration-update thread. ADO marks system
   threads with a `properties` field or non-user comment type; skip those.
3. The thread has at least one comment from a reviewer (anyone other than the PR author).
4. The **latest** comment is **not** from the PR author. If the author already replied last,
   the ball isn't in their court — skip (but mention these in the run summary as "awaiting
   reviewer" so the user knows the state).

**Reviewer filter:** if specified, additionally restrict to threads whose latest non-author
comment is from that reviewer.

**Reopened threads:** a thread previously resolved but with a new reviewer comment counts as
active again. Treat by status + latest commenter, not by past state.

If zero threads pass the filter, tell the user clearly (*"No threads currently awaiting your
response on PR {id}."*) and stop — don't invent work.

---

### Step 4: Read current code at each thread's anchor

For each kept thread, gather context **from the current branch state**, not the snapshot the
reviewer commented on:

1. If the thread has a file/line anchor (inline thread), read the file via `Read` (preferred —
   the user is on the source branch) or `repo_get_file_content` at the latest source commit SHA.
2. **Stale anchor handling:** the reviewer may have anchored to a line that has since moved or
   been deleted. If the code at that line no longer matches what the reviewer was discussing,
   search the file (and adjacent files) for the substring the reviewer quoted. Note in the
   triage that the anchor is stale so the user can decide whether the comment is still
   applicable.
3. For top-level (non-anchored) threads, read whatever files the comment text references.

Read enough surrounding context that the response can be informed, not just literal-to-the-line.

---

### Step 5: Triage each thread

For each thread, internally produce:

```
- thread_id: 12345
  anchor:    path/to/file.ts:88  (or "PR-level" for non-anchored)
  reviewer:  Display Name
  summary:   one-line restatement of the reviewer's point
  category:  agree-fix | agree-already-addressed | disagree | clarify | defer
  action:
    code_change:  "describe the edit, or null"
    reply_text:   "draft reply, or null"
  anchor_stale: false
  needs_decision: false   # true if the user must confirm before this can move forward
```

**Categories:**
- `agree-fix` — reviewer is right; we'll edit the code and reply pointing at the fix.
- `agree-already-addressed` — already fixed in a later commit; reply with the commit SHA / link.
- `disagree` — push back with reasoning. Default to `category: clarify` if disagreement is
  weak — don't argue when you could ask.
- `clarify` — ask the reviewer a question back. Use when the request is ambiguous or you need
  more info.
- `defer` — valid point but out of scope for this PR; reply acknowledging and link a follow-up
  ticket if one exists (offer to create one if the user wants).

**Confidence floor:** if you can't tell whether the reviewer's point is valid without
speculation, default to `clarify` rather than `agree-fix` or `disagree`. The author has more
context than you do — surface the choice rather than committing them to a position.

**Duplicate threads:** when two or more threads raise materially the same ask (same
rule/topic/requested change — anchors and wording may differ, even across reviewers), answer
fully in ONE canonical thread (the one with the most context, else the oldest) and give each
duplicate a one-line cross-reference reply instead. The reply addresses the reviewer, so phrase
it by author: same reviewer on both threads → `Same point as your comment on <file:line> —
answered there to keep the discussion in one place.`; different reviewer → `Same point as
<name>'s comment on <file:line> — answered there…`. Never name the person you are replying to in
the third person. Never write two full answers to the same ask — they drift apart and the
reviewers end up reconciling them.

---

### Step 6: Choose delivery mode

Ask the user which mode they want:

> "How would you like to handle the {N} threads awaiting response?
> 1. **Markdown-first** — I write triage + drafts to `docs/reviews/pr-{id}-responses.md` with
>    reply blocks under each thread. You annotate it asynchronously, I read it back, we
>    converge, then I apply code changes and post replies. Best for >10 threads or
>    architecture-heavy feedback.
> 2. **Interactive** — We walk through threads one at a time in chat. For each: I show the
>    reviewer's comment + current code + recommended action, we agree on the response, I apply
>    the code change and post the reply immediately. Best for 3–10 threads.
> 3. **One-shot** — I draft all responses + code changes in chat, you confirm, I apply and
>    post everything. Best for trivial threads or when you trust the drafts.
> 4. **Critical** — Like one-shot, but with a scrutiny pass first: I critically assess each
>    reviewer comment against the current code, and explicitly flag anything I can't decide
>    confidently without your input (missing domain context, conflicting suggestions, intent
>    ambiguity). You see the assessment + proposed responses + open clarifications, resolve any
>    gaps, then I apply and post. Best when feedback mixes valid catches with shaky assumptions
>    or relies on context I might miss."

Default suggestion: **Interactive** for 3–10 threads, **Markdown-first** for >10, **One-shot**
only when threads are clearly trivial (typo fixes, nit acks), **Critical** when feedback mixes
valid catches with shaky assumptions, or when the user wants a scrutiny pass before committing
to responses (regardless of thread count).

Do not edit code or post anything until the user picks a mode.

---

### Step 7a: Markdown-first delivery

Write to `docs/reviews/pr-{id}-responses.md` (create the directory if missing):

```markdown
# PR Responses: !{PR_ID} — {PR Title}

> **Decision Log** — append a one-liner each time the user resolves a question or overrides a
> drafted response. Format: `YYYY-MM-DD — {decision} (thread #{id})`.

> **How to use this doc**
> - Reply to each thread by filling the `> **You:**` block underneath it.
> - 🔴 markers indicate threads that need a decision before we can apply/post.
> - Claude responses appear as: <span style="color:#1f6feb">🤖 **Claude:** …</span>

**PR**
- !{PR_ID} ({source_branch} → {target_branch}, {state}, by {author})
- Threads awaiting response: {N} (filtered from {total})

## 🔴 Decisions required
Front-load anything blocking apply/post here as a numbered list, each linking to the relevant
thread below.

## Threads

### thread #{id} — `path/to/file.ts:88` (reviewer: {name})
**Reviewer said:**
> {quoted reviewer comment}

**Current code:**
```{lang}
{snippet from current branch}
```

**Proposed action:** `agree-fix` — {one-line summary of the code change}
**Proposed reply:**
> {draft reply text}

> **You:** _your annotation here_

### thread #{id} — PR-level (reviewer: {name})
…
```

After writing, tell the user the path and wait for annotations. When they reply, re-read the
file, append `🤖 **Claude:**` responses inline, update the Decision Log. Iterate until no 🔴
markers remain, then move to Step 8.

Omit empty sections rather than writing "None".

---

### Step 7b: Interactive delivery

Walk through threads one at a time. For each:

1. Present: thread anchor, reviewer name, the reviewer's comment (quoted), current code
   snippet, proposed category + action + draft reply.
2. If `needs_decision`, present options with a recommended default. Resolve before moving on.
3. Otherwise, end with: `Apply this? (y / n / edit / defer)`.
4. On `y`: apply the code change (Step 8.1) and post the reply (Step 8.2). On `n`: drop (no
   reply, no edit). On `edit`: revise reply text or code change and re-confirm. On `defer`:
   skip but keep in the running list.
5. Running tally: `Applied: 3 · Replied-only: 2 · Pushed back: 1 · Dropped: 1 · Deferred: 0 ·
   Remaining: 4`.

At the end, summarize: code files changed, replies posted, threads deferred, threads where the
ball is now back with the reviewer.

---

### Step 7c: One-shot delivery

Draft all triage + responses in chat (use the markdown structure from 7a, inline). List code
changes and reply texts together. Ask the user to confirm the whole batch. On confirm, run
Step 8 for all threads.

If any thread has `needs_decision`, resolve those before listing — don't ask the user to
approve a batch that still has open questions.

---

### Step 7d: Critical delivery

Like one-shot, but with a scrutiny pass **before** drafting any reply or code change. The goal
is to surface bad assumptions, contradictions, and missing context up front rather than
producing plausible-sounding-but-wrong drafts and hoping the user catches them.

For each thread, run two passes:

**1. Critical assessment.** Evaluate the reviewer's point against the current code, not the
   snapshot they commented on:

   - Is the reviewer's premise still correct? (Stale anchors, post-comment edits, or refactors
     often invalidate the point entirely.)
   - Would the proposed change actually improve things, or trade one issue for another (e.g. a
     readability win that hurts perf, a "safer" pattern that adds a real race condition)?
   - Are there hidden assumptions in the suggestion that may not hold in this codebase (lib
     versions, framework conventions, established patterns elsewhere in the repo)?
   - Do two reviewers contradict each other on the same anchor or related code?

   This is where weak `agree-fix` triage gets re-classified to `clarify` or `disagree`. Don't
   default to agreement just because the reviewer is senior or the suggestion sounds plausible.

**2. Clarification gaps.** Identify everything you can't decide confidently without input from
   the user. Examples:

   - Domain knowledge the author has but you don't ("Is this API intentionally untyped because
     it's consumed by an external system?")
   - Intent ambiguity where the "right" fix depends on what the author was optimizing for
     (perf, readability, backwards compat, etc.)
   - Reviewer suggestions that contradict recent commits on the branch — was that deliberate?
   - Anything where you'd otherwise paper over uncertainty with a guess.

   Be explicit. "I'm not sure" is a clarification gap; silently picking a direction is not.

Present everything in chat using the Step 7a markdown structure, with two extra sections per
thread:

```
**Critical assessment:** {what's actually going on; whether the reviewer's point holds fully,
                          partially, or doesn't apply — and why}
**Clarifications needed:** {bulleted questions for the user, or "None"}
```

Lead the overall response with a **🔴 Decisions required** block listing every thread that has
open clarifications, so the user can resolve those first before reading the rest.

Then wait. The user can:

- Answer the clarifications inline, then approve the batch.
- Edit individual proposed code changes or replies.
- Approve as-is (treating "Clarifications needed" as informational rather than blocking).

Only after explicit batch approval, run Step 8 for all threads. If the user resolves
clarifications that change the triage (e.g. a `clarify` becomes an `agree-fix`), update the
drafts and re-present the affected threads — don't apply changes that no longer match the
final triage.

**Differs from one-shot** in two ways: (1) the critical-assessment pass happens *before*
drafting, so shaky reviewer points become `clarify` or `disagree` rather than uncritical
`agree-fix`; (2) clarification gaps are surfaced explicitly rather than papered over with
plausible defaults. The cost is more upfront chat volume; the payoff is fewer wrong replies
posted to the PR.

---

### Step 8: Apply code changes and post replies

Per thread, in this order:

1. **Code changes** — apply via `Edit` (preferred) or `Write` on the source-branch file paths,
   then **commit and push as part of the same confirmed pass** (the user's go-ahead to post
   covers the loop — a reply saying "Fixed" must be true on the PR when it lands):
   - Work in the PR's own repository on its source branch (check it out if needed; abort to
     manual mode rather than clobber unrelated local work).
   - Verify with the project's quick checks when the toolchain exists locally; if it doesn't
     (CI-only builds), say so in the summary.
   - Stage ONLY the files the fixes touched, commit in the repo's message convention, push —
     never force-push. Replies then cite the real sha (`Fixed in <short-sha>.`).
   - Skip the commit/push only if the user explicitly asked for replies-only or edits-only.
2. **Reply** — post via `repo_reply_to_comment` on the thread. The reply text should:
   - Be brief and factual.
   - Reference the fix concretely if applicable ("Fixed in the next commit." or "Done in
     {sha}." once committed).
   - Use Conventional Comments labels only when they fit (`question:` when asking back, plain
     prose otherwise — see Reply style below).
   - **AI disclosure line:** by default, append `🤖 AI comment posted by Claude` as the last
     line of each posted reply (blank line before it); skip only if the user says to post
     verbatim. Beyond that one line add nothing — no other footer ("_AI-generated_",
     "🤖 Generated with…", or similar).
3. **Thread status** — do **not** auto-resolve. Resolving is the reviewer's prerogative.
   Exception: if the user explicitly says to resolve a thread, use
   `repo_update_pull_request_thread` with status `fixed` (for agree-fix) or `byDesign` /
   `wontFix` (for disagree-with-reason).

If a reply fails to post (e.g. thread deleted, permission issue), surface it so the user can
post manually. Don't silently retry.

Do **not** vote on the PR (`repo_vote_pull_request`) — voting is out of scope for this skill.

---

### Step 8c: Special cases

**Merged or abandoned PR.** If the PR is already merged/abandoned (Step 2), confirm scope
before drafting:

> "This PR is already {merged/abandoned}. Should responses still:
> 1. **Post on the closed PR** — replies for the record but no code changes, or
> 2. **Drive a follow-up PR** — bundle fixes into a new branch?"

Default: post-on-closed-PR for replies, ask before opening a follow-up branch.

**Not the PR author.** If the user is helping someone else address feedback (Step 2 sanity
check failed), proceed but make clear in posted replies that the comment is on behalf of the
author when relevant (e.g. *"On behalf of {author}: …"*). Use judgment — most replies don't
need this caveat.

---

## Reply style

Responses to reviewer comments are **not** Conventional Comments themselves — they're
acknowledgments, refutations, or questions. Style guide:

- **Brief and factual.** "Fixed in the next commit." beats "Thanks for catching this, I've
  gone ahead and updated the code to handle the case you mentioned."
- **Reference commits concretely when fixed.** "Done in `abc1234`." Don't just say "fixed" —
  the reviewer has to go hunt for it otherwise.
- **For disagreements, lead with reasoning, not pushback.** "The current behavior is
  intentional because {X}. Happy to revisit if {Y} is more important than {Z}." Avoid
  rhetorical sparring.
- **Use `question:` when asking back.** This makes it explicit that the ball is moving back to
  the reviewer. Other Conventional Comments labels are optional on responses.
- **Acknowledge nits.** A simple "Done." or "Will fix in a follow-up — out of scope here" is
  fine for `nitpick` replies.
- **Keep it short: ≤300 characters, ≤2 sentences.** Answer first, say it once, plain words for
  technical specifics — the same budget the reviewer's own comment was held to. See
  [Length][cc-length] in the code-review convention for the full rule and a worked example.
- **No emojis or thank-yous as filler.** "Thanks!" alone is noise. If you actually want to
  acknowledge a particularly useful catch, say what specifically was useful.

See also: [Conventional Comments code-review.md][cc] — same conventions the reviewer used.

[cc]: ../../conventions/code-review.md
[cc-length]: ../../conventions/code-review.md#length

---

## Tooling notes

- **Thread states (ADO):** `active`, `fixed`, `closed`, `byDesign`, `wontFix`, `pending`,
  `unknown`. Treat `active` and `pending` as needing response; the others are done unless
  reopened with a new comment.
- **Latest-commenter heuristic:** ADO doesn't have a built-in "needs author response" flag;
  derive it from `status: active` + latest comment author ≠ PR author. Reopened threads with
  new reviewer comments fall out of this naturally.
- **Stale anchors:** when the reviewer's anchored line has moved/deleted, search by quoted
  content. The thread is still valid even if the line number isn't.
- **ADO @-mentions UNRESOLVED:** neither `@Display Name` nor `@<Display Name>` produces a
  real mention. Use plain names in reply text. See [`conventions/azure-devops.md`](../../conventions/azure-devops.md).
- **Do not commit on the user's behalf** unless they explicitly ask. Edits land in the
  working tree; the user decides when to commit. If they do ask to commit, follow the
  standard "create new commit" flow — never amend, never push unprompted.
- **Don't bulk-resolve threads.** Resolving a thread is a stronger action than replying.
  Default to leaving threads open so the reviewer can resolve when satisfied.

---

## Tips

- **Read the current code first, then the comment.** Anchor your understanding in what the
  code is now, not in the comment text alone — the code may already address the concern.
- **Group threads by file when triaging.** Multiple reviewers often hit related code; a
  single edit may close several threads. Plan edits before applying.
- **Don't argue.** If you'd argue, ask instead. The reviewer has context too; a `question:`
  reply is more productive than a defensive `disagree`.
- **Confidence floor (again).** You don't have the same context the author has. When in
  doubt about whether to agree or push back, surface the choice — don't decide for them.
- **One reply per thread.** Don't chain multiple replies into a single thread when one
  consolidated reply works. Multiple replies fragment the conversation.
- **Confirm before posting.** Replies are visible to reviewers immediately. In every mode,
  the user must explicitly approve (per-thread in interactive, the file annotations in
  markdown-first, the batch in one-shot) before anything posts.
- **Surface threads where the ball is with the reviewer.** Even if filtered out by default,
  end the session by listing threads where the author already replied and is waiting — the
  user often wants to nudge those out-of-band.
