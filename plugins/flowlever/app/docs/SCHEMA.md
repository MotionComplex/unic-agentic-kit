# FlowLever Data Schema (v1) — THE CONTRACT

All data lives in `data/` as JSON. Node-only, zero deps. All timestamps ISO-8601 strings.
Every module MUST conform to this — keep it in sync with `src/ledger.js`/`src/server.js`/`src/cli.js`
whenever their on-disk shapes, routes or commands change.

## Files
```
data/
  features/<featureId>.json      # one workspace per feature
  ledger/<featureId>.json        # findings ledger per feature
  rounds/<featureId>.json        # audit round history per feature
  config.json                    # global settings (weights, gates)
  requests.json                  # UI-triggered job queue (one file, all requests)
```
Every one of the files above (and `config.json`) may transiently have a sibling
`<file>.lock/` **directory** next to it while a writer holds the cross-process lock described
under "Writes are locked, not just atomic" below. A lock directory that outlives its writer (a
crashed process) is reclaimed automatically once it's provably stale — see that section.

## featureId
Kebab-case slug, e.g. `checkout-redesign`. `[a-z0-9-]{1,64}` (`assertFeatureId` in `ledger.js`).
This is validated at **every** point an id becomes a filename — `featurePath`/`ledgerPath`/
`roundsPath` all call it, not only `createFeature` — because the HTTP layer percent-decodes route
segments, so an unvalidated id would let `%2f` become a real path separator and reach outside
`data/`. An invalid id is `EUSER` (400 over HTTP, exit 1 on the CLI) on every route/command,
including read paths, delete, ingest and every finding op.

## Writes are locked, not just atomic
The server (browser decisions), the CLI, and the `/flowlever:watch`/`/flowlever:poll` runner all
mutate the same JSON files by design — the runner is even pinned to the same `FLOWLEVER_DATA`.
Every mutation is a read-modify-write, so without a lock two overlapping writers silently discard
each other's changes. Every ledger/feature/requests write therefore runs under a cross-process
`mkdir`-based lock (`<file>.lock/`, e.g. `ledger/<id>.json.lock/`) — `mkdir` is atomic on every
platform and, unlike a lockfile, leaves something a crashed holder's lock can be told apart from a
live one by:
- A holder stamps `<lock>/owner` with its pid + acquire time. A waiter treats the lock as **stale**
  (safe to break) only once that stamp is provably older than **30s** — a lock with a *missing*
  stamp is NOT stale on that basis (it may be mid-acquire, microseconds old; deleting it there is
  exactly what loses a write). Such a lock is instead aged by its own **directory mtime** against a
  much longer **60s** grace, so a lock orphaned by a process that died between `mkdir` and its stamp
  is eventually reclaimed rather than blocking that file's writes forever.
- Breaking a stale lock is an atomic rename, so if several waiters decide to break it at once
  exactly one wins; the rest get `ENOENT` and retry.
- A waiter that can't acquire the lock within its ceiling gives up with `EUSER` carrying
  `lockTimeout: true`, which the HTTP layer answers as **503 with `Retry-After: 1`** (transient — retry;
  it is not a bad request). The ceiling is `FLOWLEVER_LOCK_WAIT_MS`, default **10s** for the CLI and the
  runner (where blocking costs nothing) but **1.5s in the server**, which sets its own via
  `configureLocking` because a wait there blocks every other request. Setting the env var overrides
  BOTH, so raising it also raises the server's worst-case stall. The message reads: *"timed out waiting for a lock on `<file>` — another FlowLever process is writing
  it. If nothing is running, remove `<lock>` and retry."* — that message names the exact directory
  to delete.
- Re-entrant within one process (the module is fully synchronous), so nested internal calls never
  self-deadlock.
- **This blocks the event loop.** The module is synchronous by design, so on the server a request
  waiting for a contended lock stalls *every* request until it clears. A write costs ~5 ms, so this
  is normally invisible; the wait timeout bounds the pathological case into a retryable error.
- `writeJson` fsyncs the **file** before renaming, so a visible rename implies visible contents.
  The **directory** fsync — which would additionally make the rename itself crash-durable — is
  opt-in via `FLOWLEVER_FSYNC_DIR=1`, because it doubles the time spent holding the lock
  (measured 5.16 → 10.05 ms/write). Without it, an OS-level crash can lose the most recent write
  and leave the previous good file in place; it can never produce a torn file.

## kind — the workflow a workspace hosts
Every workspace declares a `kind`. All three kinds ride the **same** finding model, ledger,
reconciliation and review stepper; only the UI label/icon differs.
- `spec` — spec-readiness audit of a feature (Confluence/ADO/Figma). The default and the back-compat
  value: a feature on disk with no `kind` field is treated as `spec` everywhere.
- `pr-review` — reviewing someone else's pull request; findings model review comments (locus like
  `pr:<n>:<path>:<line>`).
- `pr-respond` — responding to reviewer threads on your own PR; findings model the threads awaiting a
  reply (locus like `pr:<n>:thread:<m>`).
`createFeature({ id, title, kind })` validates the enum and defaults to `spec`. The live PR adapters
(`/pr-review`, `/pr-respond`) land in a later phase; the engine is kind-agnostic today.

### Comment triage (pr-review / pr-respond)
A finding may carry **`duplicateOf`** — a marker that the same point was already raised elsewhere
(`{ "label": "Oriol on OktaErrorHelper.cs:39", "url": "<ADO deep link>", "fp": "<canonical fp>" }`,
label required). The cockpit renders an amber DUPLICATE chip linking to `url`; the posted reply
should be the generic cross-reference (`Duplicate of [<label>](<url>) — already being handled
there.`), never a second full answer. Validated on ingest and via `setFindingDetails`.

### The duplicate gate — a PR review cannot restate what a reviewer already said
`duplicateOf` used to be purely descriptive: a review that *noticed* a duplicate could mark it, and a
review that simply never looked produced a finding indistinguishable from any other. The rule lived
only as prose in the review skill, so its failure mode was invisible. Both halves are now structural,
enforced in `ingestRound` for `pr-review` / `pr-respond` workspaces (`spec` workspaces are untouched —
they have no PR comments to collide with):

**1. The threads must have been fetched.** `features/<id>.json` carries `priorThreads`:
`null` (never recorded) or `{ recordedAt, threads: [{ threadId, author, locus, excerpt, url, status }] }`.
Ingest **refuses** while it is `null`. Recording an empty array is allowed and satisfies the gate — it
asserts *the PR genuinely has no comments*, which is a different claim from never having looked. A
feature file written before this field existed normalizes to `null`, i.e. it fails closed.
Set via `setPriorThreads(featureId, threads)` / `threads set <id> --file <json> | --none`.

**2. A finding on an existing thread must say what it is.** For each incoming finding, the locus is
compared against every registered thread anchor: same file (tail-matched, case-insensitive, so ADO's
`/src/Foo.cs` matches a finding's `src/Foo.cs`) and line ranges overlapping or within
`THREAD_PROXIMITY_LINES` (5) of each other. A collision is rejected unless the finding carries one of:
- **`duplicateOf`** → the same point, kept visible as a cross-reference;
- a **`pr:<id>:thread:<threadId>`** locus → an increment, posted as a reply into that thread;
- **`notDuplicate: "<reason>"`** → a genuinely different point that happens to sit nearby. Must be a
  non-empty string; a bare `true` is rejected, because silencing the gate has to say something. The
  cockpit shows a muted DISTINCT chip carrying the reason, so the judgement stays reviewable.

The rejection lists every colliding finding with the author and thread it lands on, and **writes
nothing** — no round is consumed, so a rejected ingest can be corrected and retried.

The check is positional, so it is deliberately blunt: it catches "same place", not "same point". It
cannot see a duplicate anchored far from the original, and it will flag two distinct points that share
a line. It closes the *silent* failure — the review that never checked — and leaves the substantive
judgement where it belongs, in the skill.

`parseLocus` accepts `pr:<id>:<path>:L<line>`, `pr:<id>:<path>:L<a>-<b>`, the bare-number
`pr:<id>:<path>:<line>`, and `pr:<id>:thread:<id>`. The `L` is optional only under a `pr:` prefix —
otherwise `ado:42695` would read as line 42695 of a file named `ado`.

For PR kinds a finding's **`suggestion` IS the proposed PR comment / reply body** — the cockpit shows it
as "Proposed comment" / "Proposed reply" and the decision row is comment triage rather than spec rework:
- **pr-review** → **Approve** (will post) · **Edit comment** · **Dismiss** (won't post). "Edit comment"
  opens the `suggestion` in a textarea; saving persists it via `setFindingDetails({ suggestion })`
  (`POST /api/features/:id/findings/:fp` now accepts `suggestion`) and marks the comment Approved (edited).
Every decision is **persisted immediately**, from whichever surface it's made (board modal or stepper):
Approve/Edit set the finding's `decision` field, Dismiss sets `status:waived`. The review flow's
in-memory decision map is hydrated from this persisted state, so the board, the stepper and the Post
screen always agree and a decision survives a page refresh.
- **pr-respond** → **Reply** · **Fix + reply** · **Fix only** · **Push back** · **Skip**. **Fix only**
  (`decision: "fix-only"`) pushes the code change and writes no comment at all — the runner resolves the
  reviewer's thread via `update_status: Fixed` instead. It requires a code draft (there is nothing to push
  otherwise) and is counted separately on the Post button ("Post 2 replies + 1 fix (no reply)") so the
  button never claims a reply it won't send.
A finding is **reviewable** (counted by the "Review N comments" CTA + walked by the stepper) when it is
open/reworking, is NOT yet posted (no `postedAt`), AND carries a `draft` OR a non-empty `suggestion` — a
code-diff `draft` is optional. At the finish/Post screen, approved/edited items are stamped **posted**
(`review/apply` with `status:'posted'` → stays `reworking` + sets `postedAt`) and dismissed items `waived`,
then an `apply` request is enqueued for the runner to post the comments back.

### Posted lifecycle (pr-review / pr-respond) — "awaiting author" + re-review
A **posted** finding is one whose comment/reply has been sent back to the PR: it keeps status `reworking`
(so reconciliation can still auto-resolve it) but carries a `postedAt` stamp. Semantically it's *awaiting
the author*, not open reviewer work, so it:
- sits in its own **"Posted — awaiting author"** board lane (PR kinds; rendered out of the Reworking lane),
- is excluded from the "to review" CTA/stepper and from the home `toReview`/`reworking` counts (counted
  under a separate `posted` count instead),
- does **not** penalize the readiness score (`computeReadiness` skips posted findings; they remain `isOpen`
  for reconciliation only).
### The fix gate — a claimed code fix must point at a real pushed commit
**Invariant: a `pr-respond` finding whose agreed response is a CODE CHANGE cannot be marked posted
without a shape-valid sha for the commit that carries it.** `markPosted` throws EUSER otherwise (→ 400
on the HTTP path, exit 1 on the CLI), validating the whole batch before writing anything so a mixed
batch cannot half-apply. **Limit:** the sha is recorded and shape-checked, never verified against a
repository — the ledger has no checkout — so a well-formed invention (`deadbeef`) satisfies the gate and
`unbackedFixes` then reports that finding as delivered. It raises the cost of a false claim and leaves a
machine-checkable record; it is not proof. Verification against the branch belongs to `/flowlever:watch`,
which has the checkout.

This exists because the ledger previously recorded no link between a finding and the commit that carried
its fix, so a delivered fix and a missing one were indistinguishable. An audit found 11 findings across
5 workspaces closed as handled with no commit on file; establishing what had actually shipped required a
commit-by-commit read of the repo, and a first attempt at that reached a confident wrong conclusion. The
gate turns "was this really done?" from an investigation into a lookup.

- **`isAgreedCodeFix(finding)`** — the gate's trigger: a `draft` whose `after` differs from `before`,
  not vetoed by a `redirect`/`reject` verdict, AND signed off either finding-level (`decision` or the
  durable `agreedCodeFix` of `edit` / `fix-only`) **or** hunk-by-hunk (a `draft.review.hunks` entry
  `accepted`/`edited`). The hunk path is essential: going straight from per-hunk Accept to Post never
  sets `decision`, so keying only off `decision` would leave the commonest case ungated.
- **`agreedCodeFix: "edit" | "fix-only"`** — the DURABLE half of the sign-off, stamped by
  `setFindingDecision` alongside `decision` and, unlike `decision`, **never cleared by an ordinary
  status change** (only by explicitly undoing the decision via `setFindingDecision(..., null)`).
  `decision` itself IS still cleared on an ordinary status change (see the ledger findings schema below) —
  that used to silently disarm the gate the moment a signed-off finding's status moved (e.g. the
  finish screen's "mark in-flight"), because the gate read `decision` alone. `setFindingStatus`
  accepts a `{ keepDecision: true }` option for WORKFLOW transitions (queueing a post/apply, a
  runner advancing a finding) that are not the reviewer re-triaging — as opposed to a plain status
  change from a user, which still supersedes the transient `decision` (but never `agreedCodeFix`).
- **`fixCommit: { sha, repo, branch, at }`** — set via `markPosted({ sha })` or `setFindingFixCommit`
  (CLI `finding fixed --sha`). Rendered as a green `✔ fix <sha>` chip. `sha` must look like a real
  git sha — `isValidSha`/`SHA_RE` requires **7–40 hex characters** — checked on **every** path that
  can set it, HTTP included (the API used to accept any non-empty string, e.g. `"lol-no-commit"`,
  and write it verbatim; only the CLI validated the shape).
- **Scope:** `pr-respond` only (`owesGitCommit`). A `pr-review` workspace is a review of someone else's
  PR — a before→after there is a suggestion for *their* author to commit, so demanding a sha stranded
  the finding in "Posting…". A `spec` workspace's drafts are Confluence/ADO edits whose proof of
  delivery is `appliedAt` (`markApplied`). An **unrecognised** kind and an **unreadable** feature file
  both fail **closed** (gate on); `unbackedFixes` uses the same predicate, so the audit and the
  enforcement always agree about which workspaces owe a commit.
- **`unbackedFixes(featureId)`** (CLI `finding unbacked [--json]`) audits the inverse: agreed code fixes
  closed as handled with no commit behind them. The cockpit shows a red banner + `⚠ fix not pushed`
  chips and offers to reopen them; `/flowlever:watch` runs the audit every pass and reopens confirmed
  ones. Findings stamped before the gate existed surface here, which is intended.
- Reply-only findings are untouched — there a reply IS the whole deliverable.

### In-flight markers and who is allowed to claim a write
`pending: "post" | "apply"` is a **transient claim that a write is in flight**, set by the cockpit when
the user confirms Post/Apply. It is deliberately NOT a completion: the browser cannot reach ADO, so it
cannot know anything landed. Only the runner may claim the write, by stamping `postedAt` / `appliedAt`
(`markPosted` / `markApplied`, i.e. `finding posted` / `finding applied`).

That split makes one failure mode possible and it must be handled everywhere: a pending finding whose
runner never arrived, died mid-flight, or failed. It is excluded from the review queue (`isInFlightOrOut`)
and never stamped, so without a way out it is stranded in the "Posting…/Applying…" lane forever — the
cockpit showing work in progress that nobody is doing.
- **`clearFindingPending(featureId, fps, { reason })`** (CLI `finding cancel`, HTTP `review/cancel`) is
  the way out: it drops the marker, keeps the finding `reworking` with its `decision` intact (so a retry
  re-posts the same items), records the release in `history`, and **never** sets `postedAt`/`appliedAt`.
  Findings already stamped are left untouched, so it is safe after a partial success.
- **`pendingFindings(featureId)`** lists what a workspace currently has in flight.
- **`markPosted`/`markApplied`/`setFindingPending`** silently pass over `fp`s that are already
  `waived`/`resolved` (nothing to post/apply for a closed finding) — they always did, but a caller
  previously only saw a smaller `updated` count with no way to learn *which* fp was dropped. All
  three now accept `{ detailed: true }`, returning `{ updated, skipped: [{ fp, reason }] }` instead
  of the bare `updated` array, so a batch call can report exactly which findings it passed over
  and why.
- The runner MUST stamp **per finding, immediately after each write succeeds** — never batched at the
  end of a run — and MUST `finding cancel` whatever it did not write when an apply fails. `/flowlever:watch`
  additionally heals strays each pass: pending findings with no queued/running `apply` are checked against
  the PR and either stamped (the comment is there, only the stamp was lost) or released.
- The cockpit treats a queued/running job untouched for **3 minutes** as *stalled* and says so — "no
  runner picked this up · nothing has been posted" — instead of spinning indefinitely, and a request that
  reached `done` while findings are still pending is reported as **not confirmed**, never as posted.

### The two review clocks — "when can I re-review?"
The cockpit answers that question by showing two timestamps side by side on every PR workspace (its
row, on Home and in its section, and its detail header), via `ledger.reviewStamps(feature, lastRoundAt)`:
- **Reviewed** = `lastRoundAt`, the `at` of the workspace's last ingest round. A round IS a review pass,
  so there is deliberately **no separate stored stamp** for this — it can never drift out of sync.
- **PR updated** = `review.lastActivityAt` (+ `lastActivityBy`), the real ADO timestamp of the newest
  update by the *other* side: the author on a `pr-review` workspace, the reviewer on `pr-respond`.

`reviewStamps` derives **`newSinceReview`** = `lastActivityAt` parses later than `lastReviewedAt`. That is
the "you can re-review now, and it will actually see something" signal: the UI badges the stamp
("● new since your review"), the row's review line says "Author responded <when>", and `reviewWait()`
treats it exactly like the runner's explicit `authorRespondedAt` flag → the prominent **↻ Re-review** CTA.
Timestamps are compared with `Date.parse`, not string order, since ADO's offsets/precision differ from ours.

**Re-review** = re-running `/flowlever:pr-review` against the same workspace (the cockpit's "↻ Re-review"
button on the `(re-run)` loop stage enqueues a fresh `pr-review` request for the same PR). On the next
ingest, reconciliation auto-resolves posted findings the author addressed (gone from the new set), keeps
the still-flagged ones (stamp preserved), and inserts anything new as `open`. The reviewer can also close a
posted finding manually at any time (Mark resolved / Reopen — reopening drops the `postedAt` stamp / Dismiss).

### Workspace state — the one string every list view ranks by
`ledger.workspaceState(feature, findings, lastRoundAt)` reduces a whole workspace to **one** state, and
both list endpoints (`/api/home`, `/api/features`) serve it as `state`. It is computed here, not in the
browser, so the Home row and the section row for the same workspace can never tell different stories.

`ledger.WORKSPACE_STATES` is the single ordered table behind it — `[{ state, band, label }, …]`, ranked by
index, bands in contiguous runs. One table on purpose: a separate "which band" list and "which sorts
first" list drift, and the symptom is a row drawn in one band but sorted as if it were in another.

| band | states, in rank order | means |
|---|---|---|
| `needs-you` | `ready-to-post` | everything decidable is decided, nothing is out yet — press Post |
| | `needs-review` | undecided items, nothing ever posted — first pass |
| | `needs-rereview` | undecided items and this workspace has posted before |
| | `author-responded` | comments are out and the other side moved (flag or clocks) |
| `in-progress` | `posting` | a runner is mid-write (`pending`), so every other stamp is stale |
| | `needs-approval` | the review is finished — the PR is yours to approve (see "The approval signal") |
| `waiting` | `awaiting-author` | comments out, no response yet |
| | `awaiting-reaudit` | spec changes applied, waiting on a re-audit to reconcile |
| | `settled` | nothing open, nothing out, not closed |
| `done` | `done` | `feature.status === 'done'` — outranks everything |

### The approval signal
`ledger.approvalSignal(feature, findings, lastRoundAt)` → `{ vote, reason, outstanding }`, served on
every list row and on the feature detail. **FlowLever never casts a vote** — the reviewer does that
on the pull request. This is a recommendation and nothing else: no ADO read, no ADO write.

`vote` is `'approve' | 'approve-with-suggestions' | 'wait-for-author' | null`, decided from the
findings that are **posted and still open** (`isPosted`) — a finding resolved or waived has been
handled (fixed, pushed back, or accepted), and one that never went out was never the author's to
answer. `outstanding` splits those into `{ blocking, questions, suggestions }`, a partition:

- **blocking** — severity `blocker` or `major`, **or any severity the config does not define**.
  `major` sits here on the reviewer's rule, not Azure DevOps': an approve says "my feedback was
  handled", and a major IS feedback. An unknown severity fails toward withholding the vote rather
  than quietly counting as a suggestion.
- **questions** — dimension `ambiguity` (what `/flowlever:pr-review` posts as a `question`
  conventional comment) at any lesser severity. An unanswered question is never an approve.
- **suggestions** — everything else: minor/info, non-question. These ride along under
  "Approved with suggestions".

Any blocking or question ⇒ `wait-for-author`; else any suggestion ⇒ `approve-with-suggestions`;
else `approve`.

`vote` is **null** — and `reason` says which — whenever the honest answer is "not yet": the
workspace is not a `pr-review`; no round has run (`lastRoundAt` null — a fresh workspace with no
findings would otherwise look exactly like a clean review); a post is in flight (`isPending`); the
review is unfinished (any `isLiveFinding`); or **the PR moved after the last round**, where whether
the feedback was handled is precisely what is unknown.

Each of those is asked of the **ledger directly**, never of `workspaceState`'s return value, and
that is load-bearing rather than stylistic. Gating on the state string shipped a false Approve:
`workspaceState` only reaches its `author-responded` rule from inside the "something is still
posted" branch, so a review whose findings were *all resolved* — the clean, finished one — walked
straight past it, and the state string answered "did the PR move?" with "no" for exactly the
workspaces where it matters most. A denylist of states also fails open, and its failure direction
is "recommend Approve". `prMovedSinceRound(feature, lastRoundAt)` is the shared fact; `done` is not
exempt from it, since `done` outranks every state and would otherwise shield the stalest
workspaces.

`workspaceState` reads the same facts, so the band agrees with the chip: a `pr-review` that would
be `settled`, **has had a round, and whose PR has not moved since** is `needs-approval` instead,
and one that would be `awaiting-author` with only suggestions out (same two conditions) is
`needs-approval` too — with nothing blocking, the
reviewer is not waiting on anybody and can approve-with-suggestions now. Anything blocking stays
`awaiting-author`. Note `reason` deliberately says "blocking **comments**": the readiness gate
beside it says "nothing blocking" about a different set (the reviewer's own open queue, which a
posted finding has left), and without distinct subjects the two read as a contradiction.

Order is the contract: the first rule that matches claims the workspace. `done` wins outright, then
`posting` (while the runner writes, the ledger's other stamps still describe the pre-post world).

The `band` column is a **shared vocabulary**, not a private one. `web/app.js` keeps its own ordered
table for the list views and layers extra, browser-only states (what a live runner is doing right
now) into these same band names — so adding a state here, or moving one between bands, is a two-file
change. `test/server.test.js` pins the agreement: every non-runner state the browser knows must be a
state this table serves, in the *same* band, and every state served here except `done` must have a
band there (`done` keeps a collapsed disclosure instead). A consumer that meets a `state` it doesn't
recognise must fall back to a band rather than render it unlabelled — an older client reading a
newer server is the case that makes this a contract and not a convention.

`settled` is guarded: a workspace with any **live** finding (open/reworking, not posted, not applied, not
`pending` — the same set `counts.open` reports) can never reach it, and falls to `needs-review` /
`needs-rereview` on the same ever-posted split. Without the guard a finding with no `draft` and an empty
`suggestion` — the `ingestFindings` default — is invisible to the undecided test and lands the workspace in
the `waiting` band while its own row says there is open work.

**`ledger.decisionOf(finding)`** backs the undecided test: `'approve' | 'edit' | 'fix-only' | 'waive' |
'redirect' | 'reject' | null`, from persisted state only — `status:'waived'`, then the finding-level
`decision`, then the draft's `redirect`/`reject` verdict, then the hunk path (every recorded
`draft.review.hunks` entry `accepted`/`edited` → `edit` if any is `edited`, else `approve`). The hunk path
is not optional: per-hunk Accept never writes `decision`, so ignoring it reads the commonest PR-review
flow as undecided forever. **Known skew:** the ledger has no diff engine, so it reads the hunk ids off the
recorded `review.hunks` keys, while the browser walks the hunk list it recomputes from `before`/`after`.
A draft whose hunks are only *partly* decided therefore reads decided here and undecided there. The skew
runs **one way only** and is bounded to a label: such a workspace states `ready-to-post` where the browser
would say `needs-review`/`needs-rereview`, and all three sit in the same **`needs-you`** band — so it can
change the wording and the rank within that band, never the band, and it can never hide a workspace. The
dominant path cannot skew at all: Approve (`acceptAll`) writes an entry for every hunk id, so reaching the
disagreement takes a strict-subset accept with the remainder left untouched.

## features/<featureId>.json
```jsonc
{
  "id": "checkout-redesign",
  "title": "Checkout Redesign",
  "kind": "spec",                  // spec | pr-review | pr-respond — the workflow this workspace hosts (default spec)
  "status": "auditing",            // draft | auditing | reworking | ready | implementing | done
  "createdAt": "2026-06-13T01:10:00Z",
  "updatedAt": "2026-06-13T01:10:00Z",
  "summary": null,                 // OPTIONAL — the plain-language "what this change is about" blurb
                                   // shown at the top of the workspace, as markdown. Written ONLY by
                                   // the review skills (`feature summary`), which have just read the
                                   // PR, the work item and the specs; the app has no model, so it
                                   // never invents one. null ⇒ nobody has written one yet, which the
                                   // cockpit says outright rather than paraphrasing the title.
                                   // Absent / blank / non-string all normalize to null.
  "sources": {
    "confluence": [ { "id": "123456", "title": "Checkout Redesign Spec", "url": "https://...", "version": 14, "lastFetched": null } ],
    "ado":        [ { "id": 42695, "type": "User Story", "title": "...", "url": "https://...", "state": "New", "lastFetched": null } ],
    "figma":      [ { "fileKey": "abc123", "nodeId": "1:23", "title": "Checkout flow v3", "url": "https://...", "lastFetched": null } ]
  },
  // ado sources carry two more OPTIONAL fields, both fed by `source add`:
  //   "type"        — the WORK-ITEM type ("Pull Request" | "User Story" | "Bug" | "Task" | "Feature" |
  //                   "Epic" | anything else the ADO instance defines), set via --itemType. The
  //                   cockpit's Sources strip badges, colours and ORDERS each source by it, so the PR
  //                   and the story it implements are distinguishable before their titles are read.
  //                   Untyped is tolerated: a source at a `/pullrequest/<id>` url reads as a PR, and
  //                   anything else as a generic work item — never guessed into a story.
  //   "vertecPhase" — the work item's `Custom.Vertec` field (ADO, under Administration): the Vertec
  //                   booking phase, shown beside the booking line as information only, never copied.
  //   "vertecKey"   — OPTIONAL override for the booking prefix. By default the cockpit derives it
  //                   from the ADO ORGANISATION in `url` (dev.azure.com/<org>/… → "FZAG"), and the
  //                   booking line is `<PREFIX>-<id> <title>` built from `id` + the item's own
  //                   `title`. No org and no override ⇒ NO booking line: a guessed prefix would be
  //                   pasted into a real booking. Validated as a key ([A-Za-z0-9][A-Za-z0-9._-]*).
  //
  // THE BOOKING LINE REQUIRES A RECORDED `type`. An ado source with no `type` is NOT bookable —
  // the cockpit will not pick which work item to book (story vs. the epic above it) nor trust that
  // `title` is the item's own `System.Title` rather than the audit skill's paraphrase of it
  // ("FOAN00 #42700" is a real example on disk). Such a workspace shows the Vertec row with an
  // explanation and NO copy button, until a review round records the type. This is the same rule
  // as the prefix: unverified ⇒ no line, because the line gets pasted into a real booking.
  "priorThreads": null,             // PR kinds: the comments the PR ALREADY carries. null = never
                                    // fetched (ingest refuses); { recordedAt, threads: [] } = a
                                    // positive "this PR has no comments". See "The duplicate gate".
                                    // threads[]: { threadId, author, locus, excerpt, url, status }
  "specSections": [                 // extracted outline of the spec, used by coverage matrix
    { "key": "goals", "title": "Goals & Non-goals" },
    { "key": "flow-payment", "title": "Payment flow" }
  ],
  "coverage": [                     // spec section ↔ ado ↔ figma mapping (filled by audit)
    { "sectionKey": "flow-payment", "adoIds": [42695], "figmaNodeIds": ["1:23"], "status": "covered" }
    // status: covered | partial | uncovered | orphan (ado/figma with no section)
  ],
  "review": {                       // OPTIONAL (pr-review/pr-respond) — the "waiting on author" tracker
    "lastPostedAt": "2026-06-16T…",  //   when comments were last posted (the "since" anchor); set by markPosted
    "authorRespondedAt": null,       //   set by the /flowlever:watch runner when it sees new author activity;
                                     //   null ⇒ still waiting. Cleared on re-post and on re-review.
                                     //   NOTE: this is DETECTION time — when the runner noticed.
    "lastActivityAt": null,          //   the REAL ISO ts of the newest counterpart update on the PR (their
                                     //   latest comment / pushed commit), as reported by ADO. Set by the
                                     //   runner via `feature activity --at`. Survives re-review (it stays
                                     //   true) — it's the last-round comparison, not the flag, that decides
                                     //   whether it still counts as "new".
    "lastActivityBy": null,          //   who made that update (display name), for "PR updated 20m ago by X"
    "note": null                     //   human summary of the activity, e.g. "2 new replies · 1 new commit"
  },
  "notes": "",
  "reviewBrief": ""                 // OPTIONAL — per-run review scope/focus this workspace was launched
                                    // with (copied from the enqueuing request's `instructions`, e.g.
                                    // "front-end only"); surfaced as a "Review scope" note in the UI
}
```

## ledger/<featureId>.json
```jsonc
{
  "featureId": "checkout-redesign",
  "lastRound": 2,                       // the highest round number this ledger reflects; derived from
                                         // max(rounds.length, lastRound) on ingest so a lost rounds-file
                                         // write can never cause a round number to be reused
  "findings": [
    {
      "fp": "a1b2c3d4e5",                 // fingerprint: sha1(featureId|dimension|normTitle|locus).slice(0,10)
      "dimension": "consistency",         // consistency | completeness | testability | design-match | dor | ambiguity | feasibility
      "severity": "blocker",              // blocker | major | minor | info
      "title": "Spec says 3 payment methods, ADO story lists 4",
      "detail": "Section 'Payment flow' lists card/PayPal/invoice; AB#42695 AC adds Twint.",
      "locus": "confluence:123456#flow-payment vs ado:42695",  // free-form but stable; part of fingerprint
      "suggestion": "Align: either add Twint to spec section or remove from AC.",
      "status": "open",                   // open | reworking | resolved | waived
      "statusReason": null,               // required when waived
      "postedAt": null,                   // OPTIONAL (pr-review/pr-respond) ISO ts — set when the comment/reply
                                          // was posted back to the PR. Present ⇒ "Posted — awaiting author":
                                          // stays reworking (reconcile-eligible) but its own lane, no penalty,
                                          // excluded from "to review". Cleared on reopen (status→open).
      "decision": "approve",              // OPTIONAL (pr-review/pr-respond) approve | edit | fix-only — the
                                          // reviewer's PERSISTED triage decision on a not-yet-posted comment
                                          // ("will post"). `fix-only` (pr-respond) = push the code fix and
                                          // post NO reply; the runner resolves the thread by setting its ADO
                                          // status to Fixed instead of commenting (a thread left Active would
                                          // be re-detected as "awaiting your reply" on every later sweep).
                                          // Dismiss is modelled by status:waived, not here. Cleared on any
                                          // status change (waive/resolve/reopen/post) UNLESS the caller
                                          // passes setFindingStatus's { keepDecision: true } (workflow
                                          // transitions, not a re-triage). Hydrated into the review flow
                                          // so board + stepper + Post agree and survive a refresh.
      "agreedCodeFix": "edit",            // OPTIONAL — DURABLE twin of `decision`, set alongside it when
                                          // decision is 'edit'/'fix-only'. Unlike `decision` this survives
                                          // every status change — only an explicit undo clears it — so the
                                          // fix gate (isAgreedCodeFix) and unbackedFixes keep working after
                                          // a signed-off finding's status moves. See "The fix gate" above.
      "pinned": false,                    // pinned findings never auto-resolve on reconciliation
      "firstSeenRound": 1,
      "lastSeenRound": 2,
      "resolvedInRound": null,
      "createdAt": "...", "updatedAt": "...",
      "history": [ { "at": "...", "from": "open", "to": "reworking", "by": "user|audit|reconcile", "note": "" } ],
      "draft": {                          // OPTIONAL — a proposed before→after fix, shown as a PR-style red/green diff
        "target": "AB#42695 — Acceptance Criteria",  // human/locus label for what the change touches
        "targetRef": {                    // OPTIONAL — machine write target for /flowlever:apply-spec (surgical apply)
          "system": "ado",                //   ado | confluence
          "adoId": 42695,                 //   ado: work item id + field reference name…
          "field": "Microsoft.VSTS.Common.AcceptanceCriteria"
          // confluence form: { "system":"confluence", "pageId":"123456", "anchor":"flow-payment", "version":14 }
          //   version = the page version `before` was read from → optimistic-concurrency on write.
          // Omitted for Figma / hand-off drafts (no auto-write target). Set/preserved by setFindingDraft;
          // re-drafting text only keeps the prior targetRef.
        },
        "format": "text",                 // text | gherkin | markdown (display hint only)
        "before": "current text…",        // multi-line strings; diffed line-by-line in the cockpit
        "after": "proposed text…",
        "updatedAt": "...",
        "review": {                         // OPTIONAL — the reviewer's decisions on this draft
          "hunks": { "0": { "status": "accepted|rejected|edited", "editedText": "…", "at": "..." } },
          "note": "",                       // FINDING-level free-text counter-proposal for the coding agent
          "verdict": "proposed",            // proposed (default) | redirect (apply differently/elsewhere) | reject (don't apply)
          "updatedAt": "..."
        }
      }
    }
  ]
}
```
The `draft` is purely descriptive: it never touches identity fields (dimension/title/locus), so the
fingerprint is unaffected. `setFindingDraft`/`clearFindingDraft` set/remove it and append a history entry.
`setDraftReview` records per-hunk Accept/Reject/Edit decisions AND the finding-level `note`/`verdict`
counter-proposal; `redirect`/`reject` override the per-hunk proposal in the exported work order.

### Spec change proposals (spec workspaces) — Accept / Edit / Reject+counter → Apply
The same `draft` + `draft.review` model powers reviewable **spec change proposals**, the spec-side
mirror of PR-review comments. `/flowlever:propose` drafts a before→after edit bound to a `targetRef`
(an ADO field or a Confluence section); the cockpit's decision row is:
- **Accept** → `draft.review.verdict` stays `proposed` (and/or hunk `accepted`); apply writes `after`.
- **Edit** → the hunk's `status:"edited"` + `editedText`; apply writes the edited text. No re-audit.
- **Reject + counter** → `draft.review.verdict:"redirect"` + the counter `note`, AND a scoped
  **`re-audit`** request is enqueued (see actions below) so `/flowlever:audit` re-evaluates ONLY the
  redirected findings against the counter and re-drafts — a per-item refine loop.
On the user's **Apply**, an `apply` request for the spec workspace runs `/flowlever:apply-spec`, which
writes the accepted/edited drafts back **surgically** (patch one ADO field / one Confluence node with
optimistic-concurrency via `targetRef.version`; never regenerate a page). `redirect`/`reject`/`waived`
drafts and drafts without a `targetRef` (Figma/hand-off) are skipped by apply.

### Fingerprint normalization
`normTitle` = title lowercased, whitespace collapsed, punctuation stripped — **the full title, no
truncation.** Fingerprint = `sha1(featureId + "|" + dimension + "|" + normTitle + "|" + locus)` hex,
first 10 chars (`fingerprint()` in `ledger.js`).

`normTitle` used to be truncated to 80 chars before hashing, so two genuinely different findings
sharing a dimension, a locus and an 80-character title prefix — routine for audit titles — hashed
identically, and `ingestRound` silently dropped the second one with no warning. `legacyFingerprint()`
computes the OLD (truncated) hash purely so `ingestRound` can recognise a finding already on disk
under it: on the first ingest after upgrading, a finding stored under its legacy fingerprint is
adopted and re-keyed to the new one (history, pins and decisions carried forward, a `history` entry
records the migration, and the round's `stats.migratedFps` counts it) instead of being auto-resolved
as gone and re-inserted as new.

### Reconciliation rule (audit round N ingests a fresh finding set)
- Finding in new set, fp not in ledger (and not adopted from a legacy fp — see above) → insert
  (status open, firstSeenRound=N).
- The **same fp twice in one batch** (same dimension/locus/full title) → counted in
  `stats.duplicatesInBatch`, second one dropped (this is a genuine in-batch dupe, not a hash collision).
- fp in ledger & status open/reworking → update lastSeenRound=N, refresh detail/suggestion.
- fp in ledger & status resolved/waived → reopen ONLY if `reopenResolved: true` passed; else log "still-flagged-but-closed" in round summary (regression alert).
- fp in ledger (open/reworking), NOT in new set:
  - **no `scope` passed** (the default — a full sweep) → auto-resolve (by:"reconcile") unless pinned.
  - **`scope` passed** (a partial/scoped pass — see below) → auto-resolve **only if in scope**;
    an absent finding OUTSIDE the scope was never looked at this round and is left exactly as it
    was, counted in `stats.outOfScopeSkipped` instead.

### Scoped (partial) rounds — `ingestRound(..., { scope })`
`ingestRound`'s auto-resolve is otherwise indiscriminate: anything absent from the batch is treated
as fixed. A re-review that only actually re-examined part of the workspace (e.g. the runner's
`instructions` scope "front-end only", or the counter-loop's per-item redirect re-check) MUST say so
via `scope`, or it silently auto-resolves — and readiness-gates green on — every finding outside the
part it looked at. `scope` is `{ fps: [...] }` or `{ dimensions: [...] }` (mutually exclusive with
each other, not with the *rest* of ingest); a finding is in-scope if its `fp` is listed, or its
`dimension` is listed. CLI: `ingest <id> --file f.json [--scope-fps <fp>[,<fp>...] | --scope-dimensions
<dim>[,<dim>...]]`. The round record persists whatever `scope` (or `null`) was passed, so the trail
shows a partial pass as partial rather than looking like a full sweep.

## rounds/<featureId>.json
```jsonc
{
  "featureId": "checkout-redesign",
  "rounds": [
    {
      "n": 1, "at": "...",
      "trigger": "audit",                  // audit | manual
      "stats": {
        "new": 12, "stillOpen": 0, "autoResolved": 0, "regressions": 0, "totalOpen": 12,
        "duplicatesInBatch": 0,             // same fp twice in this batch (dropped, counted not silent)
        "outOfScopeSkipped": 0,             // open findings outside `scope` — left untouched, not auto-resolved
        "migratedFps": 0                    // findings adopted from their pre-fix (80-char) legacy fingerprint
      },
      "readiness": { "score": 41, "gate": "not-ready", "openBySeverity": { "blocker": 2, "major": 4, "minor": 5, "info": 1 } },
      "note": "Initial swarm audit, 7 dimensions",
      "scope": null                         // null = full sweep; else { fps: [...] } | { dimensions: [...] } — see above
    }
  ]
}
```

## requests.json — UI-triggered job queue
A single JSON file holding a monotonic counter + the queue. The web UI enqueues a **request**; a
session-side runner skill (`/flowlever:watch`) claims and runs the matching adapter, and flips the
request through `running → done` (or `error`). The engine never runs adapters itself.
```jsonc
{
  "counter": 3,                        // monotonic; the next id is req-<counter+1>. NOT derived from a clock.
  "requests": [
    {
      "id": "req-3",                   // short slug: `req-<counter>`
      "action": "pr-review",           // pr-review | pr-respond | apply | re-audit | audit | propose | poll
                                       //   | summarize — the cockpit's "Generate summary" button on a
                                       //     workspace whose summary is null. Names ONE workspace by
                                       //     wsId (like `apply`), so any kind can host it and it is
                                       //     admitted by jobBindsTo's wsId arm, never by the kind arm.
                                       //     /flowlever:summarize reads the sources ALREADY on the
                                       //     workspace and writes feature.summary (+ backfills each ado
                                       //     source's itemType/vertecPhase). Read-only toward
                                       //     ADO/Confluence: posts nothing, ingests no round.
      "prId": "1481",                  // PR id — required for pr-review/pr-respond, else null
      "wsId": "pr-1481-review",        // target workspace id — required for apply + re-audit, set by the runner once it creates the ws
      "kind": null,                    // `poll` only: pr-review | pr-respond narrows the refresh to one
                                       // section; null = both. Ignored for other actions.
      "title": "Checkout PR",          // optional human label, else null
      "instructions": "front-end only",// optional per-run scope/focus the runner honors (string), else null
      "status": "queued",              // queued | running | done | error
      "claimedBy": null,               // OPTIONAL — set by claimRequest/claimNextRequest to whatever
                                       // caller-supplied label identifies the runner; null if unclaimed
      "claimedAt": null,               // OPTIONAL — ISO ts of the claim
      "phase": null,                   // short live label of the runner's current step (e.g. "fetching PR diff"); null when not running
      "needsInput": false,             // true when the job is BLOCKED waiting on the user (e.g. a 2FA/auth prompt); `note` carries the instruction
      "note": null,                    // optional free text — error reason, progress note, or the needs-input instruction
      "createdAt": "...", "updatedAt": "..."
    }
  ]
}
```

### Claiming work — exclusive, not list-then-set
A runner used to do `listRequests({status:'queued'})` then `setRequestStatus(id,{status:'running'})` —
load, mutate, save, with nothing checking the status it thought it saw. Two runners (e.g. a scheduled
`/flowlever:poll` and a manually-started `/flowlever:watch`) could therefore both see the same queued
row and both execute it — posting every PR comment twice. `runner.js`'s in-memory "is one already
running" guard cannot help: it is per-process, not per-queue-item.
- **`claimRequest(id, { by?, phase? })`** (CLI: none — internal) — compare-and-swap: succeeds only if
  the request is STILL `queued`; a loser gets `EUSER` ("already \"running\" — another runner claimed
  it"). Sets `status: running`, `claimedBy`, `claimedAt`.
- **`claimNextRequest({ actions?, by?, phase? })`** (CLI `requests claim [--actions a,b] [--json]`) —
  the operation a runner actually wants: atomically takes the OLDEST queued request (optionally
  filtered to one or more `actions`), removing the list-then-claim window entirely. Returns `null`
  (CLI: prints "Nothing queued.", exit 0) when the queue is empty — a drain loop is
  `while ((r = claim())) { …run r… }`. `/flowlever:watch` and `/flowlever:poll` MUST use this (or
  `claimRequest`) to take work, never `requests list --status queued` followed by `requests set … running`.

The **actions**:
- `pr-review` — start a PR review (requires `prId`). The runner runs the `/flowlever:pr-review` adapter,
  creates a `pr-review` workspace, and sets the request's `wsId` + `status: done`.
- `pr-respond` — start a reviewer-thread response (requires `prId`). Same flow via `/flowlever:pr-respond`.
- `apply` — write the reviewed output of an existing workspace back to its source (requires `wsId`).
  The runner **branches on the workspace `kind`**: PR kinds post kept comments/replies back to the PR
  (`/flowlever:pr-review`/`pr-respond` Apply); a `spec` workspace runs `/flowlever:apply-spec`, writing
  accepted change proposals to ADO fields / Confluence sections surgically. Enqueued from a workspace's
  review finish screen.
- `re-audit` — scoped re-audit of a `spec` workspace (requires `wsId`). Enqueued when the user **Rejects
  a proposal with a counter**: `/flowlever:audit` re-evaluates ONLY the findings whose
  `draft.review.verdict === "redirect"`, honoring each one's counter `note` (+ the request `instructions`),
  and re-drafts or waives them — the per-item refine loop. Does not run the full sweep or ingest a round.
- `audit` — start a **new spec analysis** from the UI's "+ New spec analysis" button (requires
  `instructions` = the Confluence / ADO / Figma URLs, + optional focus; optional `title`). The runner runs
  `/flowlever:audit`: it parses the URLs, creates the `spec` workspace, registers the sources, runs the
  sweep, and sets the request's `wsId` + `status: done` so the cockpit links to the new workspace.
- `poll` — the cockpit's **"↻ Refresh"** button: run a discovery pass NOW instead of waiting for the
  scheduled `/flowlever:poll` (optional `kind` scopes it to one PR section; no target ids needed). The
  runner executes `/flowlever:poll` steps 1–4 — find PRs with no workspace, re-check known ones for
  counterpart updates (stamping `review.lastActivityAt`), enqueue the resulting reviews — then keeps
  draining. Read-only toward ADO: it never posts. Reported back via `phase` (e.g. "2 new · 1 updated").

`POST /api/requests` accepts an extra **`dedupe: true`** (mirroring the CLI's `--dedupe`): if a
queued/running request already matches the same action + `prId`/`wsId`/`kind`, the existing one is
returned with `deduped: true` and HTTP 200 instead of stacking a second job. The Refresh button uses this,
so a double-click cannot fan out two passes.

The optional **`instructions`** is free-text scope/focus for THAT run (e.g. "front-end only", "focus on
the import validation"). `addRequest` validates it's a string when present and stores it (trimmed, else
null). The `/flowlever:watch` runner passes it to the adapter, which honors it as the review scope and
copies it onto the created workspace as `reviewBrief` (see features schema) so the applied scope stays
visible. For a re-audit this is also where a partial-scope focus belongs — see "Scoped (partial) rounds"
above; the adapter must translate it into `ingestRound`'s `scope`, not just a prose hint.

Lifecycle: every request begins `queued` (`phase: null`, `needsInput: false`). The runner sets
`running` while working and advances `phase` step-by-step ("fetching PR diff" → "reviewing changes" →
…) so the UI shows what it's doing live. When the runner is about to do something that needs the user —
an auth/2FA approval, a decision — it sets `needsInput: true` + a human-facing `note`; the UI then
shows a prominent "⚠ needs your input" banner. It clears `needsInput` once unblocked. On success it
sets `done`, on failure `error` (with a `note`). `addRequest` validates the action enum + the
action-specific required field; `setRequestStatus` validates the status enum and merges any of
`status`/`note`/`wsId`/`phase`/`needsInput` (unspecified fields untouched), bumps `updatedAt`, and
clears `needsInput` whenever a terminal status (done/error) is set. Every write (here, on the ledger,
and on each feature file) is an fsynced tmp+rename AND runs under the cross-process lock described
under "Writes are locked, not just atomic" above — the lock is what actually makes a
read-modify-write safe across the server/CLI/runner; the fsynced rename alone only makes a single
write atomic.

## config.json
```jsonc
{
  "severityWeights": { "blocker": 10, "major": 5, "minor": 2, "info": 0.5 },
  "gates": { "blockerOpenMeansNotReady": true, "readyThreshold": 85, "scoreZeroAtPenalty": 40 },
  "dimensions": ["consistency","completeness","testability","design-match","dor","ambiguity","feasibility"]
}
```
`scoreZeroAtPenalty` is the penalty total at which readiness hits 0 — the constant the score is
normalized against (see "Readiness scoring" below). It lives in config because `severityWeights`
does: scaling the weights without scaling this would silently redefine what `readyThreshold` means
(scale every weight ×10 with `scoreZeroAtPenalty` left at 40 and 2 open majors alone collapses the
score to 0).

**This file is merged onto defaults, not read raw.** `loadConfig`/`mergeConfig` take whatever is on
disk, keep each key that is present and validly-shaped, and fall back to the default for anything
missing, malformed, or out of range (`severityWeights[sev]` must be a finite number ≥ 0 — never 0,
which would make that severity free while still tripping the blocker gate; `readyThreshold` 0–100;
`scoreZeroAtPenalty` > 0; `dimensions` a non-empty array of non-empty strings). A hand-edited
`config.json` that drops `gates` entirely, or ships a typo'd weight, therefore degrades to the
default for that key instead of breaking every readiness call and every ingest with a `TypeError`.

## Readiness scoring
`penalty = Σ open findings (weight by severity, falling back to the default weight for a severity
missing from config)`; `score = max(0, round(100 − penalty * 100 / scoreZeroAtPenalty))` (default
`scoreZeroAtPenalty` 40, i.e. 40 weighted points ⇒ 0 — see `config.json` above for how that
constant is configured). Gate: any open blocker ⇒ `not-ready`. score ≥ readyThreshold & no blockers
⇒ `ready`. else `in-progress`.

## CLI surface (src/cli.js) — `node src/cli.js <cmd>`
This table is generated by hand from `cli.js`'s dispatch table and USAGE string — re-check both
whenever a command is added, and prefer `node src/cli.js help` for the exact current wording.
```
feature add <id> --title "..." [--kind spec|pr-review|pr-respond]    create workspace
feature list [--json] | feature show <id> [--json]
feature delete <id> --yes                 delete workspace (features + ledger + rounds files).
                                          --yes is required — without it the command lists exactly
                                          which files it would remove and refuses.
feature activity <id> [--responded] [--note "..."] [--at <iso>] [--by "<name>"] | --clear   mark/clear "author responded" on a posted PR review (watch runner); --at/--by record the REAL time + author of the newest counterpart update on the PR (review.lastActivityAt/lastActivityBy) — the "PR updated <when>" clock the cockpit pairs with "Reviewed <when>". Stamp-only (no --responded) is allowed.
feature summary <id> --text "..." | --file <md> | --clear    set/clear the workspace's plain-language
                                          "what this change is about" blurb (feature.summary). Written
                                          by the review skills — the app has no model, so nothing else
                                          fills it. Exactly one of the three flags; blank ⇒ null.
source add <featureId> --type confluence|ado --id <id> [--itemType "..."] [--title ...] [--url ...]
                               [--vertecPhase "..."] [--vertecKey <KEY>]
                               [--clear-vertec-phase] [--clear-vertec-key]
source add <featureId> --type figma --fileKey <key> [--nodeId <node>] [--title ...] [--url ...]
                                          confluence/ado are keyed by --id; figma is keyed by
                                          --fileKey (--nodeId optional) — figma has no --id.
                                          --itemType (ado) is the work-item type the cockpit badges
                                          each source by; --vertecPhase / --vertecKey are ado-only
                                          (a hard error elsewhere) and feed the Vertec booking line.
                                          A blank --vertecPhase/--vertecKey is DROPPED, not stored,
                                          so re-registering a source never wipes a phase on file
                                          by interpolating an empty shell variable;
                                          --clear-vertec-phase / --clear-vertec-key remove one
                                          explicitly (and contradict the value flags).
threads set <featureId> --file threads.json | --none
                                          record the comment threads the PR already carries.
                                          REQUIRED before `ingest` on a pr-review/pr-respond
                                          workspace; --none asserts the PR has no comments.
                                          entries: { threadId, author, locus?, excerpt?, url? }
threads list <featureId> [--json]         show recorded threads, or that none were recorded
ingest <featureId> --file findings.json [--reopen-resolved] [--note "..."]
                    [--scope-fps <fp>[,<fp>...] | --scope-dimensions <dim>[,<dim>...]]
                                          audit round ingest + reconcile. The --scope-* flags
                                          (mutually exclusive) mark this as a PARTIAL pass — see
                                          "Scoped (partial) rounds" above. Omit for a full sweep.
finding list <featureId> [--status open] [--dimension x] [--severity y] [--json]
finding edit <featureId> <fp> [--detail "..."] [--suggestion "..."] [--severity blocker|major|minor|info] [--note "..."]   refine text/severity (fingerprint stays stable — identity fields aren't editable here)
finding set <featureId> <fp> --status open|reworking|resolved|waived [--reason "..."] [--pin|--unpin]
finding posted <featureId> --fps <fp>[,<fp>...] [--sha <commit>] [--repo <r>] [--branch <b>]   mark PR comment(s)/repl(ies) posted (reworking + postedAt). RUNNER ONLY, and per finding right after each write succeeds — never batched at the end of a run. --sha is REQUIRED for any finding whose agreed response is a code fix (7–40 hex chars) — the fix gate hard-errors otherwise.
finding fixed <featureId> --fps <fp>[,<fp>...] --sha <commit> [--repo <r>] [--branch <b>]   record the pushed commit a code fix landed in, without (or before) posting anything
finding unbacked [<featureId>] [--json]   audit: agreed code fixes claimed done with NO commit behind them. No arg = every workspace.
finding applied <featureId> --fps <fp>[,<fp>...]   spec mirror of `finding posted`: mark spec change(s) written back to Confluence/ADO (reworking + appliedAt)
finding cancel <featureId> [--fps <fp>[,<fp>...]] [--reason "..."]   release in-flight "Posting…/Applying…" markers (default: all) back to the review queue; claims nothing was written. Call on every failed/abandoned apply
finding draft <featureId> <fp> --before "..." --after "..." [--target "..."] [--format text|gherkin|markdown] [--target-ref '<json>']   attach a proposed before→after change (+ machine write target for apply)
finding draft-clear <featureId> <fp>      remove a finding's proposed change
finding review <featureId> <fp> [--verdict proposed|redirect|reject] [--note "..."] [--hunk <idx> --hunk-status accepted|rejected|edited [--edited-text "..."]]   record Accept/Edit/Reject+counter on a proposal
readiness <featureId> [--json]            print score + gate + blockers
report <featureId> [--out report.md]      markdown report
coverage set <featureId> --file coverage.json
requests list [--status queued|running|done|error] [--json]   list UI-triggered job requests
requests add --action <action> [--prId <id>] [--wsId <id>] [--kind pr-review|pr-respond] [--title "..."] [--instructions "..."] [--dedupe] [--json]   enqueue a job from the CLI (same queue as POST /api/requests; --kind scopes a `poll` refresh; --dedupe no-ops on an identical queued/running request)
requests claim [--actions a,b] [--json]   atomically claim the OLDEST queued request (optionally filtered to --actions) — the compare-and-swap a runner MUST use instead of list-then-set-running. "Nothing queued." + exit 0 when empty. See "Claiming work" above.
requests delete <id>                      remove a request from the queue
requests set <id> --status running|done|error [--note "..."] [--wsId <id>] [--phase "..."] [--needs-input|--no-needs-input]   update a request (runner skill); --phase = live step label, --needs-input = blocked on you (2FA/auth)
start [--port N] [--no-open]              launch the cockpit server + open it in the browser
demo [--force]                            seed demo feature. --force is required once any demo
                                          workspace already exists (it would be deleted + reseeded).
help                                      show usage. Also what a bare `node src/cli.js` (no args) prints — exit 0, not an error.
```
Exit codes: 0 ok, 1 user error (bad args/not found), 2 internal. All output human-readable; `--json` flag for machine output on list/show/readiness/finding list/finding unbacked/requests list/requests add.

## HTTP API (src/server.js, port 4173)
```
GET  /api/home                      → [{ id, title, kind, readiness:{score,gate}, counts:{toReview,open,reworking,posted,resolved,waived}, lastRoundAt, stamps, state }] cross-kind inbox, most-actionable first (posted = awaiting author, never double-counted as reworking/toReview)
GET  /api/features[?kind=spec|pr-review|pr-respond] → [featureSummary]  (incl. kind + readiness + stamps + counts + state; optional kind filter)
     stamps = { lastReviewedAt, lastActivityAt, lastActivityBy, lastPostedAt, authorRespondedAt, newSinceReview }
              — the two review clocks (see "The two review clocks" above); newSinceReview ⇒ re-review is worthwhile
     counts = the same tally on both endpoints (one helper serves them), so a Home row and a section row never disagree
     state  = the canonical workspace state (see "Workspace state" below) — ONE string, computed server-side
GET  /api/features/:id              → { feature, ledger, rounds, readiness }
DELETE /api/features/:id            → 200 { id, deleted: true, cancelledRequests: [<reqId>,...] }; 404 if missing. Removes features/<id>.json, ledger/<id>.json, rounds/<id>.json, and fails (status:'error') any queued/running request that targeted this workspace (`wsId`) instead of leaving it to stall forever or silently re-create the id.
POST /api/features/:id/findings/:fp → body { status?, reason?, pinned?, suggestion?, decision? }  (lifecycle ops + comment-body edit + persisted triage decision; suggestion → setFindingDetails, decision ('approve'|'edit'|'fix-only'|null) → setFindingDecision; a status change clears decision)
POST   /api/features/:id/findings/:fp/draft → body { target?, targetRef?, before, after, format? } (set rework draft; 400 w/o before+after; targetRef = machine write target {system:'ado',adoId,field?} | {system:'confluence',pageId,anchor?,version?})
DELETE /api/features/:id/findings/:fp/draft → clear the rework draft
POST /api/features/:id/findings/:fp/draft/review → body { hunk, status, editedText? } | { hunks } | { note? } | { verdict? } (merges)
POST /api/features/:id/findings/:fp/counter → body { note, scope? } Reject+counter a proposal: records verdict='redirect'+note on the draft AND enqueues a scoped re-audit request for this workspace. Returns { finding, request }. 400 if note empty; 400/404 if the finding has no draft.
POST /api/features/:id/review/apply → body { fps: [...], status?, sha?, repo?, branch? } sets the listed findings to reworking (default — keeps the reviewer's `decision`, since this is "mark in-flight", not a re-triage), resolved (close without author; supersedes `decision` as usual), posted (PR comment sent → reworking + postedAt; goes through the fix gate, so `sha` is required for any agreed code fix — 7–40 hex chars), pending-post, or pending-apply (transient in-flight marker; see setFindingPending). → { updated, status, findings, skipped } — `skipped` names any fp already waived/resolved that a bulk op passed over. 400 if any fp is unknown or the sha is missing/malformed for a gated finding. (review-flow finish screen)
POST /api/features/:id/review/cancel → body { fps?, requestId?, reason? } releases stranded in-flight markers (default: every pending finding in the workspace) so they return to the review queue, and optionally drops the dead request. Never stamps postedAt/appliedAt — it claims nothing was written. → { cancelled, requestDeleted, findings }. 400 on unknown fps.
POST /api/features/:id/status       → body { status } sets the workspace lifecycle status (draft|auditing|reworking|ready|implementing|done) — e.g. "Mark review complete". 400 on bad status.
POST /api/features/:id/activity     → body { authorResponded?, note?, lastPostedAt?, at?, lastActivityAt?, lastActivityBy? } updates the "waiting on author" tracker (feature.review). The /flowlever:watch runner sets authorResponded:true + note when it detects new PR activity, plus lastActivityAt/lastActivityBy = the REAL time + author of the newest counterpart update; the UI clears the flag on re-review. 400 if empty or if lastActivityAt is unparseable.
POST /api/ingest/:id                → body { findings: [...], note?, reopenResolved?, scope? } (used by skills). scope = { fps: [...] } | { dimensions: [...] } — marks a PARTIAL pass; see "Scoped (partial) rounds" above. 400 on a malformed scope or an invalid finding.
POST /api/requests                  → body { action, prId?, wsId?, kind?, title?, instructions?, dedupe? } → 201 created request (400 on bad/missing fields). instructions = optional per-run review scope/focus (string); kind scopes a `poll` refresh; dedupe:true returns the matching queued/running request as 200 { …, deduped:true } instead of stacking a duplicate
GET  /api/requests[?status=queued]  → [request]  (UI-triggered job queue; optional status filter)
POST /api/requests/:id              → body { status?, note?, wsId?, phase?, needsInput? } → updated request (runner skill drives this; phase=live step, needsInput=blocked on user)
DELETE /api/requests/:id            → 200 { id, deleted: true }; 404 if missing. Removes the request from the queue.
GET  /api/runner[?log=1]            → { available, reason, bin, binFrom, running, action, pid, startedAt, finishedAt, exitCode, signal, logPath, actions, log? } — is a session draining the queue? `log=1` tails <data>/runner.log
POST /api/runner                    → body { action?: "watch" | "poll" } spawns a headless `claude -p "/flowlever:<action>"` in a login shell → 202 + status. 400 unknown action · 409 one already running · 503 no `claude` binary (set FLOWLEVER_CLAUDE_BIN) · 403 if the server is bound to a non-loopback FLOWLEVER_HOST without FLOWLEVER_ALLOW_REMOTE_WRITES=1 — on such a bind the whole API is read-only, since both starting the runner AND enqueueing work it will execute grant ADO write access to anyone who can reach the port (see the root README's env-var table). The prompt comes from a fixed allowlist — never from the request body.
DELETE /api/runner                  → SIGTERM the running runner → 200 + status; 409 when idle
GET  /api/report/:id                → text/markdown report
GET  /api/version                   → { apiVersion, pid, startedAt } — the HTTP wire-contract version (src/version.js), checked first and matched before anything else so it answers even when the rest of the build is mismatched. The browser compares this against its own compiled-in expectation and tells the user to restart the cockpit instead of failing with a bare "Not found" when a plugin update lands mid-session.
GET  /api/config                    → the real, merged `config.json` (`ledger.loadConfig()` — defaults applied, out-of-range values dropped; see "config.json" above). Exists so the browser's optimistic readiness recompute uses the actual severity weights/gates/scoreZeroAtPenalty instead of a hardcoded copy that silently drifted the moment anyone hand-edited config.json.
GET  /api/diagnostics               → { dataDir, host, loopback, remoteWritesAllowed, lockWaitMs, fsyncDir, workspaces, skippedWorkspaces:[{file,reason}] }. Where a workspace file the server could NOT read shows up: the list routes keep their array shape and only flag a count on the `X-FlowLever-Skipped` header, so this is the place that names the file and why.
Static: / → web/index.html, /app.js, /style.css
```
GET request validation errors (e.g. `GET /api/requests?status=bogus`) return their real status
(400) via `euserStatus`, not a blanket 404 — a 404 is reserved for "no such resource" so a client
can tell the two apart.
Ingest findings shape (what skills/audit produce — fp computed server/CLI-side, do NOT send fp):
```jsonc
{ "dimension": "consistency", "severity": "major", "title": "...", "detail": "...", "locus": "...", "suggestion": "..." }
```
