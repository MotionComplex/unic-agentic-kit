---
name: watch
description: >
  The session-side runner for FlowLever's UI-triggered jobs. Polls the cockpit's request queue and
  executes each queued request — starting a PR review/respond from a PR id, or posting reviewed
  decisions back — by delegating to the matching /flowlever:* adapter. Use when the user says
  "/flowlever:watch", "watch the cockpit", "run the flowlever runner", or sets it on a loop
  ("/loop /flowlever:watch"). This is what lets the user kick off PR reviews from the web UI.
---

# /flowlever:watch — run UI-triggered cockpit jobs

The browser can't reach Confluence/ADO (MCP), so when the user enqueues a job from the UI (e.g. "+ New PR
review"), THIS skill — running in the Claude session — picks it up and executes it. Typically run on a
loop: **`/loop /flowlever:watch`** (or a longer interval). One pass = drain the currently-queued requests.
Scheduled sibling: **`/flowlever:poll`** additionally *discovers* PRs to review (reviewer assignments,
author-responded re-reviews, threads on your own PRs) and enqueues them before draining — that's the one
to run from cron.

## Each pass
Run (self-contained — app at `${CLAUDE_PLUGIN_ROOT}/app`, data in `~/.flowlever`):

0. **Stop check.** If `${FLOWLEVER_DATA:-$HOME/.flowlever}/.watch-stop` exists, delete it, say "watch loop
   stopped", and **end the loop — do NOT reschedule another pass.** (`/flowlever:stop` drops this sentinel.)
   Otherwise continue:
1. **Claim the next request — do NOT list-then-set.** Listing queued requests and separately
   marking one `running` is a race: two runners (a scheduled `/flowlever:poll` and a
   manually-started `/flowlever:watch`) can both see the same queued row and both execute it,
   posting every PR comment twice. Instead take work with the compare-and-swap claim, which only
   ever succeeds for one caller:
   ```
   FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" requests claim --json
   ```
   Prints "Nothing queued." (JSON `null`) when the queue is empty — say "no queued requests" and
   stop (the loop will check again). Otherwise the printed request is now **exclusively yours**
   (already `running`, with `claimedBy`/`claimedAt` stamped) — dispatch it per step 2 below, then
   loop back and claim again (it always takes the oldest queued row) until the queue is empty.
2. **Dispatch the claimed request by `action`** — set a starting phase, then on completion mark it
   `done` (or `error` with a short note):
   ```
   FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" requests set <reqId> --phase "starting"
   ```
   - **`pr-review`** (has `prId`): run the **`/flowlever:pr-review <prId>`** procedure — create/locate the
     `pr-review` workspace, fetch + review, ingest findings. On success:
     `requests set <reqId> --status done --phase "review ready" --wsId <workspaceId>` (so the UI links the request to the workspace).
   - **`pr-respond`** (has `prId`): run **`/flowlever:pr-respond <prId>`** — create the `pr-respond` workspace,
     fetch threads, ingest. Then `requests set <reqId> --status done --phase "threads ready" --wsId <workspaceId>`.
   - **`audit`** — two shapes, branch on `wsId`:
     - **No `wsId`** (source URLs are in `instructions`): start a NEW spec analysis. Run
       **`/flowlever:audit`** — parse the Confluence / ADO / Figma URLs (and any focus) from `instructions`,
       derive a kebab `featureId` (from the request `title` or the spec page title), create the `spec`
       workspace, register the sources, run the sweep, and ingest. On success:
       `requests set <reqId> --status done --phase "audit ready" --wsId <newWorkspaceId>`.
     - **Has `wsId`** (the cockpit's "↻ Re-audit" button on an applied spec): **full re-audit of that
       existing workspace.** Run **`/flowlever:audit <wsId>`** (NOT scoped mode) — re-fetch its already-
       registered sources, run the full sweep, and ingest into the SAME workspace. Reconciliation
       auto-resolves the findings the spec now reflects (the applied ones), keeps any still-open, and
       flags regressions. On success: `requests set <reqId> --status done --phase "re-audited" --wsId <wsId>`.

   **Pass the request's `instructions` to the adapter.** Each queued request may carry an `instructions`
   string (visible in `requests list --json`) — the user's free-text scope/focus for THIS run (e.g.
   "front-end only", "focus on the import validation"). When present, hand it to the `pr-review` /
   `pr-respond` procedure as the **review scope**: the adapter restricts/prioritizes accordingly AND copies
   it onto the created workspace as `feature.reviewBrief` (so the cockpit shows the applied scope). Apply
   requests inherit the scope already recorded on the workspace — no extra handling needed.
   - **`apply`** (has `wsId`): run the **Apply** step for that workspace's `kind`, reading the user's
     decisions from the ledger — **branch on kind** (check `feature list --json` / the feature file):
     - `pr-review` / `pr-respond` → post inline comments / replies back to the PR
       (`/flowlever:pr-review` / `/flowlever:pr-respond` Apply step). Then `--phase "posted to PR"`.
     - `spec` → run **`/flowlever:apply-spec <wsId>`**: write the accepted change proposals back to ADO
       work-item fields / Confluence sections **surgically** (patch one node, never regenerate the page).
       Then `--phase "applied to spec"`.
     On success: `requests set <reqId> --status done --phase "<as above>"`.
   - **`summarize`** (has `wsId`): the cockpit's **"Generate summary"** button on a workspace whose
     "What this is about" panel is empty. Run **`/flowlever:summarize <wsId>`**: read the sources
     the workspace ALREADY carries (PR description, work items, Confluence pages), write
     `feature.summary`, and — since the work items are open anyway — backfill each ado source's
     `--itemType` and `--vertecPhase`. READ ONLY toward ADO/Confluence: it posts nothing, writes no
     work item, and ingests no round. Emit phases (`--phase "reading the registered sources"`). On
     success: `requests set <reqId> --status done --phase "summary written" --wsId <wsId>`.
   - **`re-audit`** (has `wsId`): the user **Rejected a proposal with a counter**. Run
     **`/flowlever:audit <wsId>` in Scoped re-audit mode** (see that skill) — re-evaluate ONLY the
     findings whose `draft.review.verdict === "redirect"`, honoring each one's counter `note` (and the
     request `instructions`), and re-draft or waive them. Don't run the full sweep. Then
     `requests set <reqId> --status done --phase "re-audited"`.
   - **`poll`** (the cockpit's **"↻ Refresh"** button; optional `kind` = `pr-review` | `pr-respond`,
     absent = both): the user knows a new PR exists or comments changed and doesn't want to wait for
     the scheduled pass. Run **`/flowlever:poll`**'s discover → decide → enqueue steps (1–4),
     restricted to the requested `kind` when set (`pr-review` → set A only, `pr-respond` → set B
     only), then continue draining — the reviews it enqueues are ordinary `pr-review`/`pr-respond`
     requests this same pass picks up. Emit phases (`--phase "scanning active PRs"` →
     `"checking PR #1481 for updates"`). Read-only toward ADO. On success:
     `requests set <reqId> --status done --phase "<n> new · <m> updated"` (say "nothing new" when
     that's the answer — a quiet refresh must still report back, or the button looks broken).
   - **`propose`** (has `wsId`): the cockpit's "Draft proposals first" button — the user accepted
     findings but none carry a writable before→after draft yet. Run **`/flowlever:propose <wsId>`**:
     draft the mechanically-applicable edits (ADO field / Confluence section before→after with a
     `targetRef`) for the accepted/open findings and attach them to the ledger (READ ONLY — writes
     nothing external). Structural / decision-only findings that can't be a surgical patch get a
     no-targetRef hand-off draft instead; say so. Emit phases (`--phase "drafting proposals"`). On
     success: `requests set <reqId> --status done --phase "proposals drafted" --wsId <wsId>` (the UI
     then flips the button from "Draft proposals first" to "Apply").
3. If a request fails (fetch error, bad PR id, auth), set `--status error --note "<short reason>"` and move
   on — never let one bad request block the rest. **For a failed `apply`, also release what you did not
   write** — `finding cancel <wsId> --reason "<short reason>"` — or its findings stay stuck in the
   "Posting…/Applying…" lane forever: excluded from the review queue and never stamped.

3b. **Heal stranded in-flight findings (run this every pass, before step 4).** A finding carrying
   `pending: "post"`/`"apply"` with no `postedAt`/`appliedAt` is claiming a write is in flight. If no
   `apply` request for that workspace is queued or running, that claim is false — the job was dropped,
   or a previous session died mid-flight — and the cockpit is showing "Posting…" for work nobody is
   doing. Find them and resolve the ambiguity honestly:
   ```
   FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node -e '
     const L=require(process.env.CLAUDE_PLUGIN_ROOT+"/app/src/ledger.js");
     const live=new Set(L.listRequests({}).filter(r=>r.action==="apply"&&(r.status==="queued"||r.status==="running")).map(r=>r.wsId));
     for (const f of L.listFeatures()) {
       const p=L.pendingFindings(f.id);
       if (p.length && !live.has(f.id)) console.log(f.id, f.kind, p.map(x=>x.fp).join(","));
     }'
   ```
   For each workspace it lists, check the PR (`repo_pull_request_thread action:list`) for each pending
   finding's comment:
   - **the comment IS on the PR** → the write happened and only the stamp was lost:
     `finding posted <wsId> --fps <fp>` (this is the case that leaves the cockpit saying "Posting…"
     when the PR already has the comment).
   - **the comment is NOT there** → nothing was written: `finding cancel <wsId> --fps <fp>
     --reason "apply job never ran"`, which returns it to the review queue for the user to Post again.
   Report what you healed in the pass summary. This is read-only toward ADO apart from those local
   stamps, so it is safe on every pass.

3c. **Audit for unbacked fixes (every pass).** A finding whose agreed response is a code change, closed
   as handled, with **no commit behind it**, means a reviewer was told their point was addressed while
   the branch never changed. Check:
   ```
   FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" finding unbacked --json
   ```
   Anything it returns is a defect. For each: confirm against the branch
   (`repo_file action:"get_content" path:<draft target> version:<source branch> versionType:"Branch"` —
   is the draft's `after` text there?).
   - **Not there** → the fix genuinely never happened: reopen it
     (`finding set <wsId> <fp> --status open --reason "closed as fixed but no commit carries the change"`)
     and say so prominently in the summary. Do NOT quietly re-fix and re-reply as if nothing happened —
     the user needs to know a previous run misreported.
   - **There** (fixed by hand, or by a commit we failed to record) → record the commit that introduced
     it: `finding fixed <wsId> --fps <fp> --sha <sha>`.
   Ideally this always prints nothing. It exists because it once wouldn't have.

4. **Author-activity check (waiting-on-author detection).** After draining the queue, for each `pr-review`/
   `pr-respond` workspace that is **waiting on the author** — `feature list --json` rows where
   `review.lastPostedAt` is set and `review.authorRespondedAt` is null — check the PR for new activity
   **since `review.lastPostedAt`**, authored by someone **other than you** (the reviewer):
   - new replies on the threads you posted, or any new comment threads (`repo_list_pull_request_threads` /
     `repo_list_pull_request_thread_comments`), and/or
   - new commits / a new iteration pushed (`repo_get_pull_request_by_id` / the PR's iterations).

   If you find any, flip the workspace to "author responded" with a short human note so the cockpit lights
   **Re-review** — and **always pass `--at` + `--by`**: the ISO timestamp of the NEWEST such update and who
   made it, straight from ADO (`comment.publishedDate` / `lastUpdatedDate`, or the iteration's
   `createdDate`). `--at` is what the cockpit shows as "PR updated <when>" beside "Reviewed <when>", and
   what it compares against the last round to decide a re-review is worth running. Without it the UI can
   only say "we noticed something", which is the vaguer, less useful fact:
   ```
   FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" \
     feature activity <wsId> --responded --note "2 new replies · 1 new commit" \
     --at "2026-08-17T09:42:11Z" --by "Oriol Puig"
   ```
   Record `--at`/`--by` even for workspaces **already flagged** as responded, whenever the newest update is
   more recent than the stored `review.lastActivityAt` — the stamp should track the latest activity, not
   just the first one seen (`feature activity <wsId> --at … --by …` without `--responded` updates only the
   stamp). This check is **read-only** (safe to run every pass). It only flags; the user (or a queued
   re-review) does the actual reconcile. Posting again (a re-review) re-anchors `lastPostedAt` and clears
   the flag automatically. Like the fetches above, flag `needsInput` before the first ADO call if it can
   pop a 2FA/auth prompt.

## Keep the UI honest: emit phases + flag when you need the user
As you run each adapter, call `requests set <reqId> --phase "<current step>"` at every step so the UI's job
row shows what's happening live (`Running · reviewing changes`) instead of an opaque spinner. The adapter
procedures below spell out the exact phases. **The one rule that matters most:** whenever the runner is
about to do something that needs the user — an **auth/2FA approval** in another window, or a decision —
set `needsInput` + a clear `note` *before* the call so the UI shows the amber "⚠ needs your input" banner,
then clear it once unblocked:
```
# Before the FIRST Azure DevOps fetch (which may pop a 2FA/auth prompt in another window):
requests set <reqId> --phase "fetching PR #<prId> (may need your approval)" --needs-input \
  --note "If a 2FA/auth prompt appears in another window, approve it to continue."
# …after it succeeds:
requests set <reqId> --no-needs-input --phase "fetching linked ticket/spec"
```
A silent block waiting on 2FA is the exact pain this prevents — never make an MCP call that can prompt the
user without first flagging `needsInput`.

## Important
- **Writes still gate on intent:** `pr-review`/`pr-respond` ingest are read-only (safe to run
  automatically). The **`apply`** action posts to ADO — it only exists because the user clicked
  "Post comments/replies" in the UI, which IS their confirmation; still, surface what was posted.
- Keep each pass quick and idempotent: a request already `running`/`done` is skipped. The UI polls request
  status, so the user watches queued → running (with live phase + any needs-input prompt) → done in the
  browser while this runs in the session.
- This is the bridge that makes the cockpit **UI-driven, session-reactive**: user clicks in the browser →
  this runner does the MCP work → results show up back in the UI.
