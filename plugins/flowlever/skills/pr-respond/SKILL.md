---
name: pr-respond
description: >
  Load the reviewer feedback on YOUR Azure DevOps pull request into the FlowLever cockpit as a
  `pr-respond` workspace: pull the comment threads that await your response, ingest each as a finding
  with a proposed reply/fix, so you can step through and decide thread-by-thread in the same review UI —
  then post the replies (and apply code fixes) back. Use when the user says "respond to PR X in the
  cockpit", "load my PR threads into flowlever", "/flowlever:pr-respond X", or "work through PR X feedback".
  For a plain interactive/one-shot response without the cockpit, use the standalone `/pr-respond` skill.
---

# /flowlever:pr-respond — respond to PR feedback, in the cockpit

Bridges the existing `/pr-respond` skill into the cockpit. The **fetch + thread-triage is identical to
`/pr-respond`** — if this monorepo also has that standalone skill checked out (a sibling of `plugins/`,
typically at `skills/pr-respond/SKILL.md` relative to the repo root; `${CLAUDE_PLUGIN_ROOT}` won't
resolve it, since it points inside `plugins/flowlever`), read it there for the fuller methodology
(how it finds threads awaiting the author's response and reads the current code at each anchor). A
standalone plugin install won't have it, so don't depend on it: §2 below inlines what you need to
fetch and triage threads. The difference: each thread becomes a finding in a `pr-respond`
**workspace**, reviewed in the same stepper, and your decisions are posted as replies / applied as
code fixes on **Apply**.

## Review scope (per-run instructions)
If the request carries `instructions` (the user's free-text scope/focus for this run, e.g. "front-end
only", "focus on the import validation"), treat them as the **review scope/focus**: restrict or
prioritize the threads you work accordingly — handle only threads anchored to in-scope files and say which
you skipped, or lead with the focus area. **Spec discovery (mandatory) still applies**, scoped to what's
relevant. State the applied scope in the run summary, and record it on the workspace by setting
`feature.reviewBrief` to the instruction (via a small node script using
`require("${CLAUDE_PLUGIN_ROOT}/app/src/ledger.js")` → `getFeature`/`saveFeature`). With no instructions,
work all threads awaiting your reply as usual.

## 1. Resolve / create the workspace
- Input = a PR id/URL, or auto-detect from the current git branch (as `/pr-respond` does). Ask if unclear.
- Workspace id `pr-<id>-<short-slug>`, `--kind pr-respond`:
  `FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" feature add <wsId> --title "PR #<id> — <pr title> (your PR)" --kind pr-respond`
- Register the PR as a source — `--type ado --itemType "Pull Request" --url "<pr url>"`. Register the
  **linked work item** too (`--itemType "<its real type>"`, `--title "<its own System.Title>"`,
  `--url "<work item url>"`, and `--vertecPhase "<Custom.Vertec>"` when that field has a value —
  ask for `expand:"Fields"` to get it). That is what gives this workspace the same source badges,
  Vertec booking line and PR quick-link the review side has; without it they are simply absent.
- **Write the workspace summary** once you have read the PR and its ticket:
  `... cli.js feature summary <wsId> --text "<2–4 sentences: what this change is and why>"`. Write it
  from the sources, never by paraphrasing the PR title — see `/flowlever:pr-review` §2 step 5.
- If the request carried `instructions`, persist them onto the workspace as `feature.reviewBrief` here.

> **When run from the cockpit queue (`/flowlever:watch`), emit phases** with the request id `<reqId>`:
> `requests set <reqId> --phase "<step>"` at each step, and flag `needsInput` *before* the first Azure
> DevOps fetch (it can pop a 2FA/auth prompt in another window), then clear it once unblocked. Skip these
> calls when invoked directly (no `<reqId>`).

## 2. Fetch the threads needing a response (reuse /pr-respond)
**Before the first ADO call** (may trigger 2FA/auth):
`requests set <reqId> --phase "fetching reviewer threads (may need your approval)" --needs-input --note "If a 2FA/auth prompt appears in another window, approve it to continue."`
Via the ADO MCP: `repo_list_pull_request_threads` → filter to **active** threads whose latest comment is
**not** from you (i.e. awaiting your response). **Clear the prompt after the first fetch succeeds:**
`requests set <reqId> --no-needs-input --phase "reading code at thread anchors"`. Read the current code at
each thread's anchor so the proposed response reflects the latest state.

**Register the thread set on the workspace before ingesting** — `ingest` refuses a `pr-respond`
workspace whose threads were never recorded. Record **all** of them (not just the ones awaiting
your reply): the already-answered ones are what stop a later round re-raising a settled point.
```
FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" \
  threads set <wsId> --file <threads.json>     # or --none if the PR has no comments at all
```
`threads.json` is `[{ "threadId", "author", "locus", "excerpt?", "url?" }]`. Findings here are
anchored to `pr:<id>:thread:<threadId>` anyway, so they never trip the positional gate — the
registration is what makes "who already said what" available to this round and the next.

## 3. Map threads → ingest shape

**Duplicate-thread detection (do this FIRST, across the whole thread set):** reviewers often raise
the same point twice — the same ask on two anchors, or two reviewers flagging the same thing. Group
threads that are materially the same ask (same rule/topic/requested change; anchors may differ).
Per group, pick the **canonical thread** — the one with the most context, else the oldest — and
draft the full answer there. Every other thread in the group becomes a **cross-reference finding**:
- Set **`duplicateOf`** on the finding (first-class field — the cockpit shows an amber DUPLICATE
  chip linking to the canonical comment):
  `"duplicateOf": { "label": "<reviewer> on <file:line>", "url": "<canonical deep link>", "fp": "<canonical finding fp, once known>" }`
  Deep-link format: `https://dev.azure.com/<org>/<project>/_git/<repo>/pullRequest/<prId>?discussionId=<threadId>`.
- `suggestion` = the **generic duplicate message with the link** — this is what gets posted, and it
  is a REPLY TO THE REVIEWER, so address them correctly:
  - canonical thread is by the **same reviewer** you're replying to →
    `Same point as [your comment on <file:line>](<deep link>) — handling it there to keep the discussion in one place.`
  - canonical thread is by **someone else** →
    `Same point as [<name>'s comment on <file:line>](<deep link>) — handling it there to keep the discussion in one place.`
  NEVER name the person you are replying to in the third person — telling Oriol his comment
  duplicates "Oriol's comment" reads as if you don't know who you're talking to.
  Add at most one short thread-specific sentence when that thread contains something the canonical
  one doesn't (e.g. a factual correction) — never a second full answer.
- No code draft on the duplicate; the fix (if any) belongs to the canonical finding.
Judge duplication by substance, not wording — two threads asking for the same behavioural change
are duplicates even if one cites a test and the other the implementation. Two threads on the same
file that ask *different* things are NOT duplicates.

Each thread → one finding:
- `title`: the reviewer's ask, one line. `detail`: the reviewer comment(s) + the current code at the anchor.
- `locus`: **`pr:<id>:thread:<threadId>`** (stable across re-runs).
- `dimension`: best-fit from the existing set; `severity`: how blocking the reviewer's ask is.
- `suggestion` = **the drafted reply text — it IS what gets posted to the thread**, so every finding has
  one (even code-fix threads get a short reply saying what was changed and why).
  Same hard length rule as `/flowlever:pr-review`, sourced from `conventions/code-review.md`'s
  Length section (inlined here so a standalone plugin install works without that file):
  **≤300 characters, ≤2 sentences**, answer first, say it once, plain words for technical things,
  no recapping the reviewer's own comment back at them.
  A reply that agrees and fixes is one sentence ("Fixed in `<sha>` — capped at `MAX_RETRIES`.");
  a push-back is the disagreement plus one clause of why, and nothing else.
- Attach a **draft** ONLY when the response includes a code change: `before`/`after` = the anchored code →
  its fix, **code only — never put reply prose, dividers, or commentary inside `before`/`after`** (the
  draft renders as a red/green code diff; prose in it shows up as fake added lines). Reply-only threads
  get NO draft — the suggestion carries the reply. Use `setFindingDraft(wsId, fp, {...})`.
  (`requests set <reqId> --phase "drafting replies"`)
Then (`requests set <reqId> --phase "ingesting threads"`) ingest:
`FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" ingest <wsId> --file <findings.json> --note "PR #<id> open threads @ <iteration>"`.

**Then stamp the reviewer-activity clock** — you just read every thread, so record the newest
reviewer comment (here the counterpart is the *reviewer*, not the author):
```
... cli.js feature activity <wsId> --at "<ISO ts of the newest reviewer comment>" --by "<reviewer>"
```
The ingest is the "Reviewed <when>" side of the cockpit's stamp pair; this is the "PR updated
<when>" side, so the workspace reads correctly right away instead of waiting for the next poll.

The runner then marks the request `done --phase "threads ready" --wsId <wsId>`.

## 4. Hand to the cockpit
Open **Home → PR Respond → this workspace**. Step through each thread; the decision row maps to the
`/pr-respond` actions:
- **Accept** = apply the proposed fix/reply as drafted · **Edit** = adjust the reply/fix ·
  **Redirect/Reject + note** = push back (explain why) · **Waive** = defer/won't-address (reason) ·
  **Skip** = decide later. Decisions persist.

## 5. Apply (post replies / code fixes) — explicit confirmation required
When run as an `apply` request, emit phases: `--phase "posting replies (may need your approval)"
--needs-input --note "Approve the auth prompt in your other window if asked."` before the first post,
clear it after, then `--status done --phase "posted to PR"`.
### ⛔ The rule this skill exists to not break
**A code fix is not done until it is pushed. You may not say otherwise, in any channel.**

Why the rule is absolute rather than a best effort: the ledger used to record no link between a finding
and the commit that fixed it, so a delivered fix and a missing one were indistinguishable — an audit
found 11 findings across 5 workspaces closed as handled with no commit on file. Answering "did this
actually ship?" then took a commit-by-commit read of the repo, and a first attempt reached a confident
wrong conclusion. Replying is the easy half and succeeds on its own, so a run that skips the commit
still *looks* complete everywhere downstream. A required sha removes the ambiguity entirely.

So the order is **fix → push → verify → only then speak**, and the ledger enforces it: `finding posted`
**refuses** to stamp any finding whose agreed response is a code change unless you pass `--sha <pushed
commit>`. You cannot mark such an item done without a commit. Do not work around that error — it is the
guard rail. If the fix did not happen, `finding cancel` it and let it stay in the user's queue.

Which findings are gated: any with a before→after `draft` that changes something AND was signed off —
`decision: edit` / `fix-only`, or accepted/edited hunks in `draft.review` (going straight from per-hunk
Accept to Post never sets `decision`, so **do not** use `decision` alone to decide whether a fix is owed).

### The sequence (per apply run)
When the user asks to post: read decisions (`finding list <wsId> --json` + each `draft.review`). Then,
**only on an explicit yes**:

1. **Resolve the repo + branch from the PR itself** — `repo_pull_request action:"get"` → `repository.name`
   and `sourceRefName`. Never assume the session's cwd is the right checkout; PR 5751 lives in
   `DXP-ProfileServices` while the cockpit runs from another repo entirely. If you cannot get a working
   checkout of that repo on that branch, **stop before replying**: `finding cancel` + `requests set
   --status error --note "no checkout for <repo>@<branch>"`.
2. **Apply** every agreed fix to the working tree (Edit/Write) on the PR's source branch. Check the branch
   out if needed; abort to manual mode rather than clobber unrelated local work. Stage ONLY the files the
   fixes touched. Never force-push.
3. **Verify the edit is really on disk** before going near git: re-read each edited file and confirm the
   draft's `after` text is present (and its `before` gone). An Edit that silently matched nothing is
   indistinguishable from success until you check.
4. **Verify** with the project's quick checks when they exist locally (build / affected tests); if the
   toolchain isn't available (CI-only builds), say so in the run summary instead of skipping silently.
5. **Commit + push**, then **capture the sha**: `git rev-parse HEAD`. Confirm the push landed —
   `git ls-remote origin <branch>` must return that sha (or fetch it via `repo_search_commits`). A commit
   that exists only locally is not a fix as far as the reviewer is concerned.
6. **Verify the fix is in the pushed commit**, not just that a commit exists:
   `repo_file action:"get_content" path:<the draft's target path> version:<sha> versionType:"Commit"`
   and check the `after` text is present. This is the step that would have caught the production failure,
   and it costs one call per file.
7. **Record the commit** — this is also what unlocks the stamp in step 9:
   `... cli.js finding fixed <wsId> --fps <fp>[,<fp>...] --sha <sha> --repo <repo> --branch <branch>`
8. **Only now reply** per thread via `repo_reply_to_comment` (edited text if present), citing the real
   commit (`Fixed in <short-sha>.`) for fix threads. Push-backs post the user's note as the reply.
   **Never write "Fixed"/"Done"/"Addressed" for a finding you have no sha for.** **AI disclosure line —
   honor the request's `instructions`:** the cockpit's Post toggle (default ON) arrives as `instructions`
   on the apply request; unless it says `disclosure: off`, append `🤖 AI comment posted by Claude` as the
   last line of every posted reply (blank line before it). Beyond that one line add nothing — no other
   signature/attribution/footer.
9. **Stamp** each finding: `... cli.js finding posted <wsId> --fps <fp> --sha <sha>` — per finding, right
   after its own reply/status update succeeds (never batched at the end of the run).

**If any step 2–6 fails for a finding**: do not reply about it, do not stamp it. `finding cancel <wsId>
--fps <fp> --reason "<what failed>"` so it returns to the user's queue, and report it. A finding left in
the queue is a small annoyance; a reply claiming a fix that isn't on the branch destroys the reviewer's
trust in every future reply.

**In the run summary, state per finding: the sha its fix landed in, or why no fix went out.** "Fixes
applied" as a bare phrase is exactly the claim that hid the failure — it is not an acceptable summary.

### `decision: "fix-only"` — apply the fix and write NO reply
A finding whose persisted `decision` is `fix-only` (the cockpit's **✎ Fix only** button; the apply
request's `instructions` also names the fps) means the user wants the code change and **no comment
at all**. For those threads:
1. Run **steps 1–7 of the sequence above in full** — resolve repo/branch, apply, verify on disk, build,
   commit, push, confirm the sha is on the remote, confirm the `after` text is in that commit, record it
   with `finding fixed`. "Fix only" removes the *reply*, not the fix: it is the one decision where the
   code change is the entire deliverable, so skipping any of this makes the button a lie about the only
   thing it promised. No sha ⇒ nothing goes out: `finding cancel` it and report why.
2. **Do not call `repo_reply_to_comment` for it.** Not a short reply, not "Fixed in <sha>", nothing.
3. Instead close the loop silently: `repo_pull_request_thread_write action:"update_status"
   threadId:<n> status:"Fixed"`. This is not optional bookkeeping — a thread left `Active` whose
   newest comment is still the reviewer's gets re-detected as "awaiting your reply" by step 2 of
   every later run, so the item would come back forever and the user would keep re-deciding it.
4. **Stamp it — this is the step that gets forgotten, and it is not optional.** Immediately after the
   `update_status` call for a thread, run:
   ```
   ... cli.js finding posted <wsId> --fps <fp> --sha <sha>
   ```
   `finding fixed` (step 7) records the commit; it does **not** complete the item. Skipping this leaves
   the finding sitting in the cockpit's "Posting…" lane forever even though the fix is pushed and the
   thread is resolved — observed in the wild: a fix-only run pushed both fixes, set both threads to
   Fixed, and stamped neither, so the cockpit reported "not confirmed as posted" for work that was
   genuinely done. Treat `update_status` and `finding posted` as one indivisible pair, per finding.
   The user's response *is* out — a pushed commit plus a resolved thread — so it belongs in the
   "awaiting reviewer" lane, not back in the queue. (Without `--sha` the ledger rejects the call, which
   is the point: a silently-resolved thread with no commit behind it would be invisible to everyone,
   including the reviewer who is no longer being asked to look.)
Say in the run summary which threads were fixed silently, so the user can see what went out without
a comment. If a `fix-only` finding somehow has no code draft there is nothing to push: leave it
open, don't reply, and flag it — never quietly resolve a thread you did nothing about.

**Why setting the status is right here**, when the general rule (and the standalone `/pr-respond`
skill) is *don't auto-resolve — that's the reviewer's prerogative*: `Fixed` is specifically the
**author's** signal in Azure DevOps ("I've addressed this"), which is exactly what a pushed fix
asserts; the reviewer still verifies and `Closed`s it. And choosing **Fix only** IS the user
explicitly asking for the silent path, which is the documented exception to that rule. `Closed` /
`WontFix` / `ByDesign` remain off-limits — never set those on the user's behalf.

### Stamping is not optional — you are the ONLY thing that can confirm a reply
The cockpit's Post button sets a transient `pending: "post"` marker (the "Posting…" lane) and enqueues
the `apply` request; it **cannot** stamp anything. `postedAt` is written exactly once — by you, after
ADO accepted the reply. So **stamp each thread the moment its reply lands, one call per finding,
never batched to the end of the run**:
```
FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" finding posted <wsId> --fps <fp>
```
Batch at the end and any interruption (dead session, 2FA timeout, failed call) leaves replies that are
really on the PR marked "Posting…" forever.

**Before replying, check the thread's latest comment.** A finding marked `pending: "post"` with no
`postedAt` means a previous attempt was interrupted, not that the reply is missing: if the thread's
newest comment is already yours and matches the drafted reply, **don't post again** — just stamp it.

**If the apply fails or is abandoned, release what you did not post**, or those findings stay stuck
in the "Posting…" lane with no way back:
```
... cli.js finding cancel <wsId> [--fps <fp>,...] --reason "post failed: <short reason>"
... cli.js requests set <reqId> --status error --note "<short reason>"
```
(No `--fps` = release every still-pending finding; already-stamped ones are never touched, so it is
safe after a partial success.)

A re-run reconciles as the reviewer responds again — same loop.
