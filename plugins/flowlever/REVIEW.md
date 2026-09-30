# FlowLever — Full Review

**Date:** 2026-08-17 · **Reviewed at commit:** `207f569` · **Scope:** `plugins/flowlever/**` (app + 12 skills + docs)

Four independent reviewers, each in a fresh context, none of whom wrote the code. Every reviewer
worked against its own sandboxed copy of the app on its own port; the repo was not modified. **No
fixes were applied in this pass** — this document is the input to a later fix run.

| Topic | Model | Verdict | Blocker | Major | Minor | Nit |
|---|---|---|---|---|---|---|
| Correctness | Opus | Request-changes | 5 | 7 | 6 | 7 |
| Functionality | Sonnet | Request-changes | 2 | 2 | 1 | 1 |
| Usability (UX/UI) | Sonnet | Request-changes | 0 | 4 | 2 | 2 |
| Completeness / gaps | Sonnet | Notable-gaps | 0 | 4 | 4 | 1 |

**Test suite is green throughout:** `node --test` → 98 passed, 0 failed (~1.6s), confirmed
independently by two reviewers. Every blocker below exists *underneath* a green suite — which is
itself the headline finding.

---

## Fix-first shortlist

Ranked by blast radius, not by discovery order.

1. **S-1 — Path traversal: remote arbitrary `.json` deletion and disclosure** (`C-1`)
2. **S-2 — No auth + binds every interface + a route that spawns an agent with permission checks disabled** (`G-4`, `C-12`)
3. **S-3 — Concurrent writers silently lose data; queue claims aren't exclusive** (`C-2`, `C-3`)
4. **S-4 — The fix gate can be disarmed, and its own audit erased, by an everyday command** (`C-4`, `F-4`)
5. **S-5 — Fingerprint collision silently destroys a distinct finding forever** (`C-5`)
6. **S-6 — A scoped re-review auto-resolves every finding outside its scope and flips the gate green** (`C-6`)
7. **S-7 — `node src/cli.js` with no args crashes; Figma sources cannot be added at all** (`F-1`, `F-2`)
8. **S-8 — The UI can present unsaved decisions as ready to apply** (`U-2`)

Items 1–3 are security/durability and should land before FlowLever is used anywhere other than a
single trusted machine. Items 4–6 are integrity: they make the tool quietly lie about the state of
your review, which is the one thing this product exists to get right.

---

## 1. Correctness (Opus)

Verdict: **Request-changes.** `CONFIRMED` = reproduced by running code; `PLAUSIBLE` = strong
code-reading evidence only.

### Blockers

**C-1 · CONFIRMED · Path traversal → arbitrary `*.json` read and arbitrary `*.json` DELETE**
`app/src/server.js:537-538,559` + `app/src/ledger.js:65-67,138-143,1111-1117`

`featureId` is validated **only** in `createFeature` (`ledger.js:102`). Every other read/write/delete
path builds `path.join(DATA_DIR,'features',` + "`${id}.json`" + `)` straight from the URL segment, and
`route()` percent-decodes segments (`server.js:526`) — so `%2f` becomes a real path separator.

```
$ curl -X DELETE ".../api/features/..%2f..%2foutside%2fsecret"
{"id":"../../outside/secret","deleted":true}          # file gone

$ curl -X POST ".../api/features/..%2f..%2foutside%2fleak/status" -d '{"status":"done"}'
{"someAppConfig":true,"apiToken":"sk-SUPER-SECRET-TOKEN","db":{"password":"p@ss"},...}
```

The *static* handler (`server.js:508-512`) **is** correctly guarded — this is the API path only.
Combined with S-2 (no auth, all interfaces), this is remote arbitrary-file deletion.
**Fix:** apply the `createFeature` id validator at every entry point, or resolve-and-confine to `DATA_DIR`.

**C-2 · CONFIRMED · Concurrent writers silently lose data — every mutation is an unguarded read-modify-write**
`app/src/ledger.js:75-80` (`writeJson`), `249-260`, `1008-1017`

`writeJson` is atomic per file (tmp+rename) but there's no lock and no version check, so overlapping
processes discard each other's changes. The server (browser decisions), the CLI, and the
`/flowlever:watch` runner all write the same files **by design** — `runner.js:160` pins the child to
the same `FLOWLEVER_DATA`. Real-world case: you click Approve in the cockpit while the runner stamps
`postedAt`; one side's writes vanish with no error.

```
6 processes × 40 addRequest():  expected 240 requests, got 47   # 193 enqueued jobs lost
2 processes, disjoint findings: expected 60 decisions, persisted 32 | LOST: 28
```

**C-3 · CONFIRMED · Queue claim is not atomic — every runner claims every job → duplicate ADO posts**
`app/src/ledger.js:1090-1106` (`setRequestStatus`), `1075-1084` (`listRequests`)

A runner does `listRequests({status:'queued'})` then `setRequestStatus(id,{status:'running'})` — load,
mutate, save, with no compare-and-swap on the prior status. A launchd `/flowlever:poll` and a
cockpit-started `watch` both see the same `queued` rows and both execute them, so **the same PR
comments get posted twice**. `runner.js:87-89` (`isRunning`) is in-memory only and cannot prevent
this across processes.

```
claims: 47 47 47 | jobs claimed by MORE THAN ONE runner: 47
```

**C-4 · CONFIRMED · The fix gate is disarmed by any status change, and accepts a non-sha as a sha**
`app/src/ledger.js:490` (`delete finding.decision`), `516-523` (`isAgreedCodeFix`), `555` (`assertFixCommit`)

(a) `setFindingStatus` deletes `decision` on *any* status change. A finding signed off at
finding-level (`edit`/`fix-only`) with no per-hunk accepts therefore stops being an "agreed code fix"
the moment its status moves — including via the documented finish-screen call
`POST /api/features/:id/review/apply {fps, status:'reworking'}` (`server.js:352`). `markPosted` then
requires no sha, and `unbackedFixes` reports clean: you're told "fixed" with nothing on the branch,
and the audit built to catch exactly that returns 0.

(b) `assertFixCommit` accepts *any* non-empty string (`typeof sha === 'string' && sha.trim()`) and
`markPosted:615` writes it verbatim. The CLI validates hex shape (`cli.js:403`); the HTTP path does not.

```
decision after open->reworking: undefined | isAgreedCodeFix: false
posted with NO sha now? postedAt: true  fixCommit: null   unbackedFixes: 0  (should be 1)
POST .../review/apply {"status":"posted","sha":"lol-no-commit"} → fixCommit {'sha': 'lol-no-commit'}
```

Independently confirmed by the functionality reviewer as **F-4** via the CLI path
(`finding set <fp> --status resolved`). Note the same `delete finding.decision` line also causes **C-8**.

**C-5 · CONFIRMED · Fingerprint collision destroys a distinct finding with no trace**
`app/src/ledger.js:264-275` (80-char truncation), `386-389` (`if (seenFps.has(fp)) continue;`)

`normTitle` truncates to 80 chars, so two genuinely different findings sharing dimension + locus and
an 80-char prefix — routine for audit titles — hash identically. `ingestRound` then `continue`s past
the second: no insert, no warning, `stats.new` counts 1, and nothing in the round record hints
anything was dropped. The finding is gone forever.

```
fpA aecdab1946   fpB aecdab1946     # "…do not match the ADO story for Twint" / "…for Apple Pay"
ingest stats: {"new":1,...}         ledger findings: ['…for Twint']   # Apple Pay blocker never existed
```

`ledger.test.js:109-114` asserts the truncation *is* intended, but no test covers two distinct
findings colliding in one round. **Minimum fix:** hash the full title (truncation buys nothing)
and/or surface collisions in `stats`.

### Majors

**C-6 · CONFIRMED · A scoped/partial re-ingest silently auto-resolves every other open finding** — `ledger.js:440-448`.
`ingestRound` has no notion of scope; anything absent from the batch is auto-resolved. But
`instructions` is a documented per-run scope ("front-end only", `SCHEMA.md:338-341`) that the runner
honors and copies to `reviewBrief`. A front-end-scoped re-review closes every back-end finding as
`by:'reconcile'`, `statusReason: null`, and flips the gate to green. Only `pinned` protects; the sole
safeguard is prose in `skills/audit/SKILL.md:44`.
```
round2 stats: {"new":0,"stillOpen":1,"autoResolved":2}  → the 2 blockers: ['resolved/null','resolved/null']
readiness after scoped re-review: {"score":95,"gate":"ready"}
```

**C-7 · CONFIRMED · `ingestRound` isn't atomic across ledger+rounds → round numbers get reused** — `ledger.js:463-464`.
`saveLedger` then `saveRounds`, two separate writes. If the second fails, the ledger keeps the full
mutation while round *n* was never recorded, so the next ingest reuses *n*. `firstSeenRound` /
`resolvedInRound` then point at a round whose stats describe a different pass, breaking the report's
"since round" column and the UI's NEW/REGRESSED badge (`app.js:1045`). `SCHEMA.md:351` claims "All
writes are atomic."

**C-8 · CONFIRMED · "Mark N findings in-flight" wipes every persisted approve/edit decision** — `app/web/app.js:1974-1983` → `server.js:352` → `ledger.js:490`.
The spec finish screen's secondary button POSTs `review/apply {status:'reworking'}` for all
accepted/edited/redirected findings; `setFindingStatus` then deletes each `decision`.
`hydrateDecisions` (`app.js:653-675`) can only recover a decision from `draft.review.hunks`, so
suggestion-only findings (no draft — the common spec case before `/flowlever:propose` runs) return as
**Undecided**, and the finish screen reads "No applicable changes to export" (`app.js:1549`) — exactly
the failure the comment at `app.js:662` says it guards against. Contradicts `SCHEMA.md:43-46`
("a decision survives a page refresh").

**C-9 · CONFIRMED · The report contradicts itself and shows READY with an unaddressed blocker** — `report.js:92` vs `121-146`.
The summary table uses `ready.openCount` (excludes posted/applied/pending) while "Open findings by
dimension" uses `isLive` (includes them).
```
| Readiness score | 100 / 100 |   | Gate | 🟢 READY |   | Open findings | 0 (◆ 0 blocker …) |
### dor (1 open)
| ◆ blocker | boom | `x` | reworking | 1 |
```

**C-10 · CONFIRMED · A legacy/array-shaped or truncated ledger crashes the cockpit with a 500** — `ledger.js:249-252,348` vs `report.js:63-64`.
`loadLedger` returns whatever JSON is on disk, unvalidated; `computeReadiness` does
`ledger.findings.filter(...)` and throws `TypeError` (not EUSER). `report.js:63` explicitly tolerates
an array-shaped ledger — that legacy shape is *known* — but calls `ledger.readiness()` two lines
earlier, which doesn't. `GET /api/features/:id`, `GET /api/report/:id` and `readiness` all 500 /
exit 2 with "Internal server error" and no hint the ledger file is the problem.

**C-11 · CONFIRMED · A partial `config.json` bricks the whole cockpit with a 500** — `ledger.js:94-97`.
`loadConfig` returns the raw file with **no merge against `DEFAULT_CONFIG`**. `config.json` is the
documented user-editable surface (`SCHEMA.md:353-359`); dropping `gates` or `dimensions` while editing
weights makes every readiness call and every ingest throw `TypeError`, so board, inbox, report and CLI
all fail with "Internal server error".

**C-12 · PLAUSIBLE · `POST /api/runner` is unauthenticated arbitrary-code execution** — `server.js:467-474` → `runner.js:147-152`.
The prompt allowlist is sound, but the *effect* isn't bounded by it: the handler spawns a `claude`
session **with permission checks disabled** in a login shell with the user's full environment. Anyone
who can reach the port can start it, and it then acts on whatever the queue contains. Filed as the
additional consequence of S-2, not the trust boundary itself.

### Minors

- **C-13 · PLAUSIBLE ·** `stop()` kills the shell, not the process group, and liveness is in-memory — `runner.js:200-207,87-89`. Child is spawned `detached: true` (new process group) but `stop()` signals `state.pid` alone; if the login shell doesn't `exec` the final command, the `claude` grandchild survives while `state` records it finished, so the next `start()` spawns a second runner posting the same comments. Should be `process.kill(-state.pid, …)`. A server restart also forgets `state`, evaporating the "one run at a time" guard. *(Note: the functionality reviewer verified the group-kill working in its environment — see F "what works" — so this is shell-dependent.)*
- **C-14 · CONFIRMED ·** Bad input on a GET reported as 404 — `server.js:600`. The top-level catch maps any EUSER on a GET to 404 without consulting `euserStatus`, so `GET /api/requests?status=bogus` returns `404 {"error":"invalid status \"bogus\"…"}` and clients can't distinguish "no such resource" from "you sent nonsense".
- **C-15 · CONFIRMED ·** `severityWeights` is configurable but the normalizing constant is hardcoded — `ledger.js:355,353-354`. `score = 100 - penalty*100/40`; the `40` isn't derived from config, so scaling the documented weights collapses every score to 0 and silently changes what `readyThreshold: 85` means (currently penalty ≤ 6, i.e. at most one open major). Separately `severityWeights[f.severity] ?? 0` makes a severity missing from config **free** — a blocker with no configured weight adds 0 penalty while still tripping the blocker gate. `2 majors → 75`; same 2 majors at ×10 weights → `0`.
- **C-16 · CONFIRMED ·** Destructive commands with no guard — `demo.js:17-25`, `cli.js:282-286`. `node src/cli.js demo` calls `resetDemo()`, which unconditionally `fs.rmSync`s features/ledger/rounds for three fixed ids including `checkout-redesign` and `pr-482-checkout-api` — plausible *real* workspace names. No prompt, no `--force`, no backup. `feature delete <id>` likewise deletes three files with no confirmation and no `--yes`.
- **C-17 · PLAUSIBLE ·** `deleteFeature` orphans queue entries — `ledger.js:1111-1117`. Requests carrying `wsId` are untouched, so a queued `apply`/`re-audit` for a deleted workspace stays `queued`; the runner picks it up and fails (or an `audit` re-creates the id). The cockpit shows a permanently stalled job for a workspace that no longer exists.
- **C-18 · PLAUSIBLE ·** The stale-server banner blames the wrong half when the server is newer — `app/web/app.js:5198-5223`. The check only tests inequality: bump `API_VERSION` (`src/version.js:13`), restart, and a browser with a cached `app.js` is told "**The cockpit server is running an older build than this page** … Restart it" — inverted, sending the user to restart the component that's already correct instead of hard-reloading the page. It's also a one-shot check at boot, so a tab left open across an upgrade never re-checks.

### Nits

- **C-19 ·** `writeJson` has no `fsync`; `SCHEMA.md:351`'s atomicity claim is broader than the code — `ledger.js:75-80`. tmp+rename gives atomic *replacement*, but neither file nor directory is fsynced, so an OS crash can lose the write entirely. With C-2/C-3/C-7, "All writes are atomic" isn't true at the level a reader would take it.
- **C-20 ·** `addSource` throws `TypeError` on an old-schema feature and never dedupes — `ledger.js:242,133-136`. `normalizeFeature` back-fills only `kind`, so a feature written before `sources` existed makes `feature.sources[type].push` throw → 500/exit 2 rather than EUSER. Adding the same Confluence page twice appends a duplicate that double-counts in `sourceCounts` (`server.js:102-106`).
- **C-21 · CONFIRMED ·** `parseArgs` swallows the following flag as a value — `cli.js:107-114`. Any non-boolean flag consumes `argv[i+1]` unconditionally: `finding set ws fp --status --pin` yields `status:'--pin'` and silently drops `--pin`. The enum check catches it here; for free-text flags (`--reason --pin`, `--note --json`) it's stored verbatim and the trailing flag vanishes.
- **C-22 ·** Bulk post/apply silently skips findings and reports a smaller count — `ledger.js:655,689`, `server.js:353`. `markApplied`/`setFindingPending` skip `waived`/`resolved` fps without recording which; the response's `updated` count is simply lower and the toast (`app.js:1992`, `3367`) reports the smaller number, so posting 5 and seeing "4 updated" gives no way to learn which was dropped.
- **C-23 ·** `loadRequests` counter fallback can reuse ids — `ledger.js:1013`. If `counter` is absent it falls back to `requests.length`; after deletions (`deleteRequest` splices without touching the counter) length drops below the highest issued id, so the next `addRequest` mints a duplicate — and `setRequestStatus`/`deleteRequest` use `find`/`findIndex`, so they hit the wrong request.
- **C-24 ·** Background poll re-render leaves an open modal stale — `app/web/app.js:3182-3186,3206-3209`. `ensureFeatureJobPolling` re-renders the detail view when the job signature changes (including when `isStaleJob` flips purely with time), but `rerenderDetail()` never calls `syncModal()`. A propose/apply job finishing while the finding modal is open reloads `state.detail` behind it while the modal keeps rendering the pre-reload finding. The dialog itself is safe (`app.js:3847`), so staleness not data loss.
- **C-25 ·** The stepper's item list never picks up newly ingested findings — `app/web/app.js:898-911,940-950`. `initFlow` only rebuilds `state.flow.items` when `featureId` changes or `items` isn't an array. A re-review landing mid-stepper adds findings the rail and `x of N` counter never show; a finding removed by reconciliation renders "This finding is no longer available." (`app.js:1000`) with the count still including it. Only `retryPost` (`app.js:1796`) forces a rebuild.

### Test-coverage gaps

- **Nothing exercises concurrency or durability at all** — the two worst-blast-radius failures (C-2 lost updates, C-3 double-claim) are untested; no test that `requests.json`/`ledger.json` survive interleaved writers or that a claim is exclusive.
- **No test for the fix gate's escape hatches.** `ledger.test.js:360-443` covers happy paths well but never sends a malformed sha through `markPosted` (only `setFindingFixCommit` gets a shape test at `:435`), nor changes a status *between* decision and post — which is what actually disarms the gate.
- **`ledger.test.js:100-115` asserts the 80-char collision as correct** but never ingests two distinct colliding findings, so C-5's silent discard has no coverage and isn't treated as a hazard.
- **No test ingests a partial/scoped round** (C-6). Reconciliation is tested with full sets only (`:182`, `:282`).
- **No test for malformed persisted state** — array/legacy ledgers, ledger missing `findings`, feature missing `sources`, partial `config.json` (C-10, C-11, C-20). Each is an unhandled `TypeError` → 500.
- **No id-validation test on the HTTP surface** — no traversal/weird-id case anywhere in `server.test.js`, which is why C-1 is live. The static handler's traversal guard is likewise untested.
- **`report.js` has no test file at all.** C-9's self-contradiction would be caught by one assertion.
- **`cli.js` has no test file at all** — no arg-parsing edge cases (C-21), no exit-code assertions (the documented 0/1/2 contract is unverified), no coverage of destructive `demo`/`feature delete` (C-16).
- **`ingestRound`'s two-file write is untested for partial failure** (C-7); nothing asserts a round number is never reused.
- **Nothing asserts the persisted-decision contract survives the finish screen** (C-8). `ledger.test.js:301` proves a status change *clears* the decision — the behavior is deliberate and tested — but nothing checks the documented finish-screen flow doesn't therefore destroy the reviewer's triage.
- **Client `app.js` (~5.2k lines) is entirely untested** — flow state machine, `hydrateDecisions`, shared single-poller invalidation, optimistic-vs-server reconciliation: zero coverage.

---

## 2. Functionality (Sonnet)

Verdict: **Request-changes.** Checks: `node --test` → tests 98, pass 98, fail 0.

### Blockers

**F-1 · `node src/cli.js` with no arguments crashes instead of showing usage** — `cli.js:730`
```
$ node src/cli.js
TypeError: Cannot read properties of undefined (reading 'includes') at run (cli.js:730:37)   # exit 2
```
`cmd` is `undefined` on empty argv, so `cmd.includes(' ')` throws before the switch's
`case undefined: console.log(USAGE)` (`:763`) can ever run — that handler is dead code.
`node src/cli.js help` works fine; only the bare invocation crashes. **Expected:** print usage, exit 0.

**F-2 · `source add --type figma` cannot succeed by any route** — `cli.js:288-301`, `ledger.js:226-245`, `skills/audit/SKILL.md:68`

Both documented invocations fail:
- Exactly as the audit skill instructs (`--fileKey aBc123 --nodeId "1:23"`) → `Error: Missing --id.` — `cli.js` unconditionally requires `--id` and never reads `--fileKey`/`--nodeId`.
- Exactly as the CLI's own USAGE documents (`--id` only) → `Error: figma source requires "fileKey"` from `ledger.addSource`.

`cmdSourceAdd` only ever builds `{type, id, title?, url?}`. The ledger layer is fine — `demo.js:60-66`
adds figma sources successfully by calling `addSource` directly, **bypassing the broken CLI wrapper**,
which is why the demo looks healthy. As shipped there is no way to register a Figma source via the
CLI, one third of the documented three-source model that `/flowlever:audit` is built on.

### Majors

**F-3 · `source add --type ado --itemType "…"` is silently dropped — no error, no data** — `cli.js:288-301`, `ledger.js:226-245,232-237`, `skills/audit/SKILL.md:67`
```
$ node src/cli.js source add fp-test --type ado --id 99999 --itemType "User Story" …
Added ado source 99999 to fp-test                       # exit 0
$ node src/cli.js feature show … --json
"sources": … {"id":99999,"title":"Test WI","url":"…","lastFetched":null}    # no "type" field
```
`ledger.addSource` *does* support this (maps `itemType`→`type` at `ledger.js:234-236`) but
`cmdSourceAdd` never reads `flags.itemType`. `SCHEMA.md` documents ado sources carrying
`"type": "User Story"` and `skills/audit/SKILL.md:67` explicitly instructs passing it — so following
the skill's own instruction produces no error and no stored data. Worse than F-2 because nothing
signals the loss.

**F-4 · Fix gate bypassable *and* audit trail erased via the general status-change path** — `ledger.js:470-505` (`:491 delete finding.decision`) vs `:516-523`, `:599-629`.
Same root cause as **C-4**, found independently via the CLI: a finding with `decision:'fix-only'`
(no hunk accepts) marked resolved through the ordinary `finding set <fp> --status resolved` exits 0
with no sha required, and `finding unbacked` afterwards reports **"No unbacked fixes"**.
Hunk-level agreements are *not* affected — `draft.review.hunks` survives a status change and is still
caught.

### Minor / nit

- **F-5 · minor ·** Web UI hardcodes severity weights/threshold; no endpoint serves `config.json` — `app/web/app.js:26-29`; no `GET /api/config` in `server.js`. The comment at `app.js:26` admits it "Mirrors config.json defaults". An operator editing the documented `severityWeights`/`readyThreshold` gets a wrong optimistic score/gate flash until the next `/api/features` refetch (server-side `ledger.readiness` stays correct). Related: **C-15**.
- **F-6 · nit ·** `HEAD` on static files returns 405 instead of a header-only response — `server.js:501`. `curl -sI …/app.js` → 405. Nothing in-app issues HEAD, so impact is nil.

### Verified working (don't regress these)

- All 98 tests pass. `demo` seeds three coherent workspaces spanning all three kinds (spec / pr-review / pr-respond).
- **Fingerprint stability:** identical re-ingest across rounds → `new:0, stillOpen:2`, fingerprints unchanged.
- **Reconciliation:** an omitted finding auto-resolves; a manually-resolved finding reappearing is flagged `regressions:1` and left closed without `--reopen-resolved`, correctly reopened with it.
- **Readiness math is arithmetically self-consistent** with `config.json` (3 major + 2 minor open → penalty 19 → score 53), and the gate keys only off open blockers + threshold, exactly as `SCHEMA.md` documents.
- **The fix gate's primary path works:** `finding posted` / `POST review/apply` hard-blocks an agreed code fix with no `--sha` and accepts once provided.
- `finding unbacked` correctly catches an agreed-fix-via-hunk-accept resolved with no commit.
- **Request queue lifecycle end-to-end over HTTP:** create → pending-post marker → `review/cancel` releases it back to the review queue, matching `SCHEMA.md`'s "stranded in-flight" semantics.
- **Runner control** (verified with a stubbed `claude` via `FLOWLEVER_CLAUDE_BIN`): spawns; 409 on a second concurrent start; 400 on unknown action; `running`→`exitCode:0`; log tailing works; `DELETE` SIGTERMs the whole process group with **no orphaned child** (no leaked `sleep 30`).
- **Server routing is robust:** clean 400/404/405/413 on malformed JSON, unknown ids, wrong methods, empty bodies — no 500s or crashes under adversarial input.
- **Path-traversal protection on the static server verified** (`/../../etc/passwd` and percent-encoded variants → 404). *(The API path is not protected — see C-1.)*
- Every `fetch(...)` call site in `web/app.js` resolves to a real implemented route.
- `skills/watch` and `skills/poll` reference only CLI commands, flags and ledger exports that actually exist.
- CLI error handling is uniformly clean: bad enum, unknown fp, malformed sha, missing file, invalid JSON, missing flags → readable `Error: …` + exit 1, never a stack trace.

---

## 3. Usability — UX/UI (Sonnet)

Verdict: **Request-changes.** Driven in a real browser; 25 screenshots captured and read across
empty state, all three workspace kinds, the stepper, the apply screen, server-down behavior,
narrow widths (900px/500px) and a 40-step keyboard traversal.

### Majors

**U-1 · Stale `/lever:audit` shown at the highest-trust moments** — `app/web/app.js:458, 464, 1676, 2159, 2236, 4837, 4941`

The first-run empty state ("Seed the demo with `node src/cli.js demo`, or run `/lever:audit`…"), the
Guide tab's step-1 Audit card, and the **pre-Apply explainer** ("then `/lever:audit` reconciles the
ledger") all name a command that doesn't exist. Nearby text correctly says `/flowlever:propose`,
`/flowlever:watch`, `/flowlever:pr-review` — a rename applied inconsistently. Same root cause as
**G-1**; these line numbers are the precise in-app locations.
**Fix:** replace `/lever:` → `/flowlever:` in `web/app.js` (check `report.js` too) and add a test
asserting no `/lever:` references remain.

**U-2 · Decisions made while the server is unreachable render as "ready to apply" though never persisted** — `app/web/app.js` `decide()`/`persistDecisionField()` (~1310-1414); Decision Summary reads client-only `state.flow.decisions`

Killed the server mid-stepper and clicked Accept. A toast appeared ("Could not save decision: network
unreachable") **but the click also auto-advanced to the Decision Summary**, where that finding shows a
green APPLY chip under "3 Apply as proposed." After restarting, `GET /api/features/checkout-redesign`
shows `decision: null, status: "open"` — the summary misrepresents what will actually be applied. The
toast is the only signal: it fades in 4.5s, top-right, while attention is centered on the card.
**Fix:** reconcile the summary against the server's persisted `decision`, or mark persist-failed items
("not saved — retry"); block or warn on Apply when shown-as-decided ≠ server state.

**U-3 · Three overlapping, same-named decision affordances stacked in one card, one unlabeled** — `app.js:1214-1242` (finding-level: Accept/Edit/Redirect/Waive/Skip), `app.js:4074-4133` (draft verdict: Proposed/Redirect/Reject), `app.js:4208-4225` (per-hunk ✅Accept/❌Reject/✏️Edit, **no section heading**)

All three render top-to-bottom in the same card with near-identical button styling; at 500px they're
visually adjacent. The 40-step Tab probe confirms a user tabs through **three different "Accept"
buttons and two "Reject"-flavored controls within a single finding**.
**Fix:** caption the hunk row ("Per-change:") and visually demote it, so the hierarchy
(hunk edit ⊂ draft verdict ⊂ finding triage) reads at a glance.

**U-4 · Irreversible write-back is single-click for Spec but double-gated for PR** — `app.js:1910-1969` (`applySpec` → `enqueueApply`, called straight from the Decision Summary button at `app.js:1596`) vs `app.js:2919-2932` (`renderRunnerZone`'s `showConfirm`)

`grep -n "confirm(" web/app.js` returns **zero matches** — the custom `showConfirm` in
`renderRunnerZone` ("Run the queued jobs now? Approved comments get posted to Azure DevOps.") is the
app's *only* are-you-sure gate, and `enqueueApply` calls `startRunner('watch', {silent:true})`
directly, skipping it. One click on "Apply N changes → ADO / Confluence" both queues the write-back
and spawns the runner that executes it. Both paths hit live Confluence/ADO.

### Minors / nits

- **U-5 · minor ·** No shortcuts for the actual decide loop — `app.js:5175-5189` is the entire global keydown handler; only `/` (focus search) and `Escape` are bound. Reviewing dozens of findings is mouse-driven or a long Tab chain (~14 Tabs just to reach the first hunk control). Full keyboard *reachability* works, so this is friction, not a blocker. **Fix:** stepper-scoped one-key bindings (`a`/`r`/`e`, `j`/`k` or arrows) with a hint in the step-top bar.
- **U-6 · minor ·** No light theme / `prefers-color-scheme` handling — `style.css:8-33` is a single hardcoded dark OKLCH palette. Consistent with `ARCHITECTURE.md`'s "Dark, calm, fast", so likely deliberate; flagged for completeness only.
- **U-7 · nit ·** Large dead vertical space on list views — ~600-700px of empty canvas below 1-3 cards at 1440×900 on Home / PR Review / PR Respond.
- **U-8 · nit ·** Severity glyphs (◆▲●○) appear decoratively on the empty cockpit before any legend exists (`app.js:2157-2159`); the explanation lives one click away in the Guide.

### What works well

- **Severity is coded by shape *and* color** (◆ blocker / ▲ major / ● minor / ○ info), not color alone — a real colorblind-accessibility win, applied consistently across cards, filter chips and rail items in all three workspace kinds.
- **The Guide tab is unusually strong onboarding** for a local dev tool: explains the loop, job lifecycle states, the two "review clocks", and how to read the dashboard, all in place.
- **Full keyboard operability of the decide flow is real** — every stepper control (rail items, verdict toggle, hunk buttons, decision buttons, Undo, Next/Prev) is a genuine focusable `<button>` with visible focus rings and a sane tab order, verified over a 40-step traversal.
- **Kanban status lanes** (Open / Reworking / Applying / Applied-awaiting-re-audit / Resolved / Waived) give clear at-a-glance state; NEW/REGRESSED badges and duplicate/pin chips layer in without clutter.
- **Kind-specific copy is genuinely tuned, not relabeled:** pr-review says "Approved comments are posted only when you click Post — nothing is sent until then"; pr-respond distinguishes "Fix + reply" from "Fix only" and explains what each does to the thread.
- Responsive layout holds structurally down to 500px (chips wrap, cards stay readable, stepper rail stacks) though clearly desktop-optimized.
- **The Decision Summary blocks Apply until every accepted finding has a writable draft**, offering "Draft N proposals first" instead of a silently-broken Apply — good guardrail design, aside from U-2/U-4.

---

## 4. Completeness & gaps (Sonnet)

Verdict: **Notable-gaps.**

### Majors

**G-1 · `/lever:*` vs `/flowlever:*` naming drift across docs *and* the live UI** — `app/README.md:83-86`; `app/docs/ARCHITECTURE.md:44`; `app/web/app.js:458,462,464,466` vs `451,474,477,484,513,530`
The root README and all 12 `SKILL.md` frontmatters consistently use `/flowlever:*` (matching
`plugin.json`). `app/README.md` and `ARCHITECTURE.md` were never updated after the rename, and the
dashboard's own help panel mixes both forms in one section a user reads top to bottom.
`ARCHITECTURE.md:44`'s module path (`.claude/skills/`) is also wrong — the real path is top-level
`skills/`. Both docs' skill tables list only 4 of 12 skills. See **U-1** for exact UI locations.

**G-2 · `app/README.md`'s quickstart is stale** — `app/README.md:51` claims "`node --test` (16 passing)"; actual is **98 passing**. The file was last touched Jun 15 while `cli.js`/`ledger.js`/`server.js`/`runner.js` were all touched Aug 17, and it never mentions the runner / start-jobs-from-UI feature, the `finding fixed`/`unbacked`/`applied` commands, or `--kind` workspaces. It reads as a snapshot of a much earlier, smaller product. **Fix:** regenerate it from current reality, or delete it in favour of the root README + `SCHEMA.md` to avoid two competing sources of truth.

**G-3 · `SCHEMA.md`'s own "CLI surface" reference is incomplete versus the actual CLI — and versus its own prose** — `SCHEMA.md:366-389` vs `cli.js:735-762`, and `SCHEMA.md:67-92`. The list omits `finding fixed`, `finding unbacked`, `finding applied`, `finding edit` and `start` — all real, working subcommands; three are described in prose *earlier in the same file* and are load-bearing for the apply-spec and pr-respond workflows. `GET /api/version` (tested in `server.test.js`, used for staleness detection) is likewise absent from the HTTP API section (`:392-419`). For a file headed "THE CONTRACT", this matters.

**G-4 · No authentication and no localhost-only binding, despite an internal comment claiming otherwise** — `server.js:611`, `runner.js:14-17`
`server.listen(PORT, cb)` with no host argument binds the unspecified address (`::`, all interfaces) —
verified empirically. `runner.js:14-17` says "Localhost-only server, no CORS — same trust boundary as
the CLI that starts it", while the root README's own "Friendly hostname" section admits the server
"binds the wildcard interface and ignores the Host header". There is no token, session, or origin
check anywhere. Combined with `POST /api/runner` (spawns a `claude` session with permission checks
disabled, able to post comments and code fixes to ADO) and `POST /api/requests`, **anyone who can
reach the host's IP on the LAN can enqueue jobs and trigger writes to your ADO account with zero
authentication.** See **C-1** for what else that reachability buys, and **C-12**.
**Fix:** bind `127.0.0.1` explicitly (matching the stated intent) or add a real trust boundary.

### Minors / nit

- **G-5 · minor ·** Dangling reference to a nonexistent process doc — `SCHEMA.md:4` ("Changes to this file require updating PROGRESS.md decisions log"); no `PROGRESS.md` exists anywhere in the repo.
- **G-6 · minor ·** Two skills hardcode an absolute path under the current developer's home — `skills/pr-review/SKILL.md:~742`, `skills/pr-respond/SKILL.md:~503` reference `~/development/agentic-kit/skills/…`. This only resolves where the monorepo sits at exactly that path; a standalone plugin install hits a dead end with no fallback. `${CLAUDE_PLUGIN_ROOT}` is used correctly everywhere else in those same files.
- **G-7 · minor ·** `plugin.json`'s description lists 9 of 12 skills — missing `stop`, `propose`, `apply-spec`, the latter two central to the spec-side accept/edit/reject loop that `SCHEMA.md` spends ~60 lines documenting.
- **G-8 · minor ·** No consolidated troubleshooting or env-var reference anywhere (`grep -rni troubleshoot` over all `.md` → nothing). `FLOWLEVER_DATA`, `FLOWLEVER_ADO_PROJECT`, `FLOWLEVER_REVIEWER_EMAIL`, `FLOWLEVER_POLL_CAP`, `FLOWLEVER_CLAUDE_BIN` and `PORT` are each documented once, inline, wherever they happen to come up; failure modes are buried as asides (the Keychain "Not logged in" fix sits inside the launchd section).
- **G-9 · nit ·** No root `.gitignore`; `app/.gitignore` only excludes `data/`. `.DS_Store` files and `temp/` directories exist on disk and are untracked **by luck** (never `git add`ed) rather than by rule — a `git add -A` would ship them.

### Positive finding: the skill suite has no dead ends

Both lifecycles were traced end to end — `audit → propose → apply-spec` (via watch's `apply`
dispatch) `→ rework → track`, and `poll → watch`'s `pr-review`/`pr-respond` `→ apply` — including the
counter/redirect scoped re-audit loop, the unbacked-fix healing loop, and the in-flight `pending`
marker healing loop. Every cross-reference between skills points at a real file, there is no orphaned
skill, and no workspace `kind` lacks an adapter. **This is the most encouraging structural result in
the review** — the architecture is sound; the defects are in implementation and hygiene.

### Top missing capabilities

1. **A trust boundary on the local server** — highest priority; see G-4 / C-1 / C-12.
2. **Ledger/findings export (CSV/JSON)** beyond markdown work-orders, for reporting to stakeholders outside the cockpit — odd absence given the product's whole purpose is tracking issues across rounds.
3. **Multi-user / team awareness** — no concept of who reviewed or owns a finding beyond a single `FLOWLEVER_REVIEWER_EMAIL`; a team sharing conventions or a server has no data model for it.
4. **CI integration** — `/flowlever:pr-review` and the fix gate are compelling as a merge-quality signal, but there's no documented headless pipeline mode to, say, block a PR on open blockers.
5. **Notifications beyond macOS** — the day-to-day poll story is entirely `terminal-notifier`/`osascript`; Linux users (explicitly supported for cron in the README) get only a log file to tail.

---

## Cross-cutting themes

1. **A green suite hides everything above.** 98 tests pass while five blockers sit live. The gaps are structural, not incidental: no concurrency tests, no malformed-input tests, no HTTP id-validation tests, and **no test files at all** for `cli.js` or `report.js` — which is exactly where F-1, F-2, F-3, C-9 and C-21 live. The single highest-leverage fix in this document is adding tests along those axes, because they'd have caught most of the rest.
2. **`delete finding.decision` (`ledger.js:490`) is one line causing three separate defects** — C-4 (gate disarmed), C-8 (decisions wiped by the finish screen), F-4 (CLI bypass). A deliberate, tested behavior for the triage-supersede case, load-bearing in two others where it's wrong. Fix it once, carefully, with the three call sites in view.
3. **The trust boundary is documented as something it isn't.** `runner.js:14-17` says localhost-only; the code binds everything; the README half-admits it. Everything downstream (C-1's remote file deletion, C-12's permission-disabled agent spawn) inherits from that gap.
4. **Documentation drift is systematic, not incidental** — the rename that stopped halfway (G-1/U-1), a test count off by 82 (G-2), a "CONTRACT" file missing five real commands (G-3), a required doc that doesn't exist (G-5). The root README and `SCHEMA.md`'s prose sections are current and good; `app/README.md` and `ARCHITECTURE.md` are stale enough to mislead.
5. **The architecture is genuinely sound.** Fingerprinting, reconciliation, the fix gate's primary path, the queue lifecycle, runner process management, the skill graph, and the cockpit's core interaction model all hold up under adversarial testing. Nothing here calls for a redesign.

---

## Review method and coverage limits

- Four fresh independent contexts, none of which wrote the code; each in its own sandboxed copy on its own port, repo untouched (`git status` clean).
- Reviewers were barred from firing Apply/runner paths against live Azure DevOps or Confluence; the runner was exercised with a stubbed `claude` binary via `FLOWLEVER_CLAUDE_BIN`.
- **Not verified:** any real write to ADO/Confluence/Figma (all live-write paths were deliberately stubbed), so the actual field-patching behavior of `/flowlever:apply-spec` and comment-posting of `pr-review` remains unexercised end to end. Figma source ingestion couldn't be tested through the CLI at all (F-2).
- The correctness reviewer's C-13 (process-group kill) and the functionality reviewer's live verification of a clean group kill disagree; the behavior is likely shell-dependent. Worth resolving during the fix pass rather than assuming either result.
- An earlier attempt at three of these reviews was terminated mid-run by an API session limit and was restarted from scratch; findings here come only from the completed runs.
