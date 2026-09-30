# FlowLever

A local **review cockpit** for specifications and pull requests. FlowLever turns spec-readiness
audits and PR reviews into a tracked, repeatable loop: findings are **fingerprinted** so the same
issue keeps the same identity across rounds (new ones surface, fixed ones auto-resolve, and
regressions get caught when a closed issue reappears). You review and decide each finding in a
guided **stepper UI**, export **work orders**, and trigger jobs from the browser that the Claude
session executes.

It bundles a zero-dependency Node app (Node 24, no install) under `app/` plus a set of
`/flowlever:*` skills that drive it via MCP (Confluence, Azure DevOps, Figma).

## Quick start

```
/flowlever:start
```

Boots the dashboard (default **http://localhost:4173**) and starts the watch loop so UI-triggered
jobs run. With no data yet, seed an example with the demo, or run `/flowlever:audit <feature>` to
populate a real one.

## Skills

| Skill | What it does |
| --- | --- |
| `/flowlever:start` | Launch the cockpit dashboard + the UI-job watch loop. |
| `/flowlever:audit <id>` | Fetch a feature's Confluence/ADO/Figma sources (read-only) and run a 7-dimension spec-readiness audit, ingesting fingerprinted findings. |
| `/flowlever:track <id>` | Fast, local-only status read: score, gate, what's open, what moved since the last round. |
| `/flowlever:rework <id>` | Draft fixes for open findings and apply them to the spec/work items — only on explicit confirmation. |
| `/flowlever:brief <id>` | Compose an implementation-ready handoff brief once the readiness gate is green. |
| `/flowlever:watch` | Session-side runner: drain the cockpit's UI request queue (PR reviews, applies). Usually run on a loop. |
| `/flowlever:poll` | Scheduled autopilot pass: discover reviewer PRs + threads on your own PRs, decide review/re-review/skip, enqueue + drain. See [Scheduled autopilot](#scheduled-autopilot-flowleverpoll). |
| `/flowlever:pr-review <prId>` | Load an ADO PR into a `pr-review` workspace, review against spec/ticket, step through findings, post kept comments back. |
| `/flowlever:pr-respond <prId>` | Load reviewer feedback on your PR into a `pr-respond` workspace, draft replies/fixes, post them back. |

## Triage bands — how every list is ordered

The Home inbox and the three kind sections (`#/spec`, `#/pr-review`, `#/pr-respond`) draw the same
four bands, top to bottom. A band with nothing in it isn't drawn at all:

| Band | What lands here | Card |
|---|---|---|
| **Needs you** | the next move is yours — everything decided and ready to post, findings still to decide (first pass or re-review), or the author has moved since your review | full: state pill, readiness dial, severity counts, both review clocks |
| **In progress** | a runner is mid-flight on it, or a Post is being written | compact |
| **Waiting on others** | comments are out with no reply yet, spec changes await a re-audit, or nothing is open at all (`settled`) | compact |
| **Done** | closed workspaces, in a collapsed disclosure you can sort by last-reviewed / last-modified date | — |

**One string decides the band.** The server reduces each workspace to a single `state` and serves it
on `/api/home` and `/api/features` alike, so the Home row and the section row for the same
workspace can never tell different stories. The full state list and which band each falls in is the
table in [`app/docs/SCHEMA.md`](app/docs/SCHEMA.md#workspace-state--the-one-string-every-list-view-ranks-by).

**A live job outranks that state.** While `/flowlever:watch` is reviewing, re-reviewing, polling or
posting a workspace, the band follows the *job* — what a runner is doing to it right now is the
truer answer than a state computed from the very stamps that runner is mid-way through invalidating.

**A stalled or errored job rises into "Needs you"** instead of staying under "In progress". That
looks like a bug and isn't: a job that errored, that is blocked waiting on input, or that has been
claiming to run for over three minutes with no runner going is not progressing — nothing more will
happen to it until *you* do something. Filing it under "In progress" is exactly how a failed Post
goes unnoticed for a day.

**The two middle bands drop the decision material** — no dial, no severity counts, no sources line;
just what identifies the workspace, one timestamp saying why it's parked, and the job line if
there's a job. Nothing in them is waiting on a judgement from you. The flat wall this replaces is
the one where the two PRs that need you looked exactly like the nine that don't.

## Scheduled autopilot (`/flowlever:poll`)

`/flowlever:poll` turns the cockpit into an unattended PR-review autopilot: one pass discovers the
Azure DevOps PRs where you're a reviewer (plus reviewer threads awaiting you on your own PRs),
decides per PR what to do, enqueues the work on the same queue the UI feeds, and drains it. Run it
manually anytime, or fire it from a scheduler every couple of hours.

**Decision rules** (first match wins): skip drafts/WIP · skip if a request for the PR is already
queued/running · skip if you approved and nothing changed · **re-review** when the author replied
or pushed *after* your posted review (`review.lastPostedAt`) · skip while ingested findings await
your triage · otherwise **new review**. Re-reviews reuse the PR's workspace, so reconciliation
auto-resolves what the author fixed and only the delta surfaces.

**Two review clocks, so you can see when a re-review is due.** Every PR workspace shows the pair
side by side — on its row (Home and its section alike) and its detail header:

| Stamp | Where it comes from |
|---|---|
| **Reviewed** `3h ago` | the workspace's last ingest round (a round *is* a review pass, so it can't drift) |
| **PR updated** `20m ago by Oriol` | `review.lastActivityAt` / `lastActivityBy` — the real Azure DevOps timestamp of the newest update by the *other* side (the author on a `pr-review`, the reviewer on `pr-respond`), recorded by the poll/watch runner |

When the second is newer than the first, the stamp turns blue with a **● new since your review**
badge and the workspace surfaces the prominent **↻ Re-review** action — that's the "you can
re-review now, and it will actually see something" signal. Hover any stamp for the exact time.
(`review.authorRespondedAt` still exists, but it only records when the runner *noticed*; the
activity stamp is the fact worth reading.)

**Don't want to wait for the next pass?** The cockpit has a **↻ Refresh** button on Home and on
both PR sections. It enqueues a `poll` job (scoped to that section) that your `/flowlever:watch`
session picks up and runs immediately: find PRs you have no workspace for, and re-check the known
ones for updates. The button itself is the progress indicator — queued → the live phase → done,
or the reason it failed with a retry. It de-dupes, so a double-click can't fan out two passes, and
like the scheduled pass it never posts anything.

### Running jobs straight from the UI — **▶ Run N jobs**

The queue only moves when a Claude Code session runs `/flowlever:watch`. The cockpit server is a local
process, so it can start that session for you: **▶ Run N jobs** (Home, both PR sections, and inside the
stalled banner on a workspace) spawns exactly the invocation the launchd schedule uses —
`claude -p "/flowlever:watch" --dangerously-skip-permissions` in a login shell — and the existing job
rows then animate queued → running (live phase) → done as it works. While it runs the control becomes
**Runner working… ■ Stop**.

Because this one *writes* to Azure DevOps (unlike Refresh), it asks once — "Run the queued jobs now?
Approved comments get posted" — before starting. Clicking Post was your approval of the *content*; this
confirms you want it to go out now. Details:

- **One at a time.** A second start is refused (409), so a double-click can't fork two sessions posting
  the same comments.
- **Fixed prompts only.** The action must be `watch` or `poll`; the command is built from constants and
  a resolved absolute binary path, never from request data.
- **Binary resolution:** `FLOWLEVER_CLAUDE_BIN` → `~/.local/bin/claude` → `command -v claude` in a login
  shell (a login shell is required — the OAuth token lives in the macOS Keychain). If none is found the
  button says so instead of failing silently.
- **Output** is appended to `~/.flowlever/runner.log` and tailable via `GET /api/runner?log=1`, so a
  headless failure (expired auth, missing MCP) is visible rather than mysterious.
- **↻ Refresh** now also starts a runner when none is going — otherwise it would just queue work nobody
  would do.

### A claimed fix must point at a real commit

**Fix + reply** and **Fix only** promise a code change, so on a **`pr-respond`** workspace the ledger
refuses to mark such an item done without the sha of the pushed commit carrying it. `finding posted`
hard-errors; the runner is told to either supply `--sha` or `finding cancel` the item.

**What this does and does not guarantee.** The sha is recorded and checked for *shape* (7–40 hex
characters) — it is **not** verified against the repository, because the ledger has no checkout to ask.
So a fabricated but well-formed sha (`deadbeef`) passes, and `finding unbacked` then reads that finding
as delivered. The guard turns "claim a fix and say nothing" into "claim a fix and invent a commit id",
which is a real change in cost and leaves a machine-checkable record — but it is a bookkeeping guard,
not proof. The verification that closes that gap lives in the runner, which has the checkout:
`/flowlever:watch` re-checks each unbacked candidate against the branch and reopens the ones that
never landed.

This is a bookkeeping guard, and it earned its place. The ledger used to record *no* link between a
finding and the commit that fixed it, so a delivered fix and a missing one looked identical. An audit
of PR 5751 and four other workspaces turned up 11 findings closed as handled with no commit on file —
and reconstructing what had actually shipped took a commit-by-commit read of the repo, during which a
run was wrongly blamed for replying without committing (the commit existed; the reviewer's re-raise was
a substantive disagreement with a push-back). If the record isn't machine-checkable, nobody — human or
agent — can audit it, and confident wrong conclusions are as likely as correct ones.

- The runner's apply step is now **fix → push → verify → then speak**: verify the edit is on disk, that
  the sha is on the remote, and that the anchor file *at that sha* contains the change — only then reply
  or resolve the thread, then stamp with `--sha`.
- A landed fix shows a green **`✔ fix <sha>`** chip. One closed as handled with no commit shows a red
  **`⚠ fix not pushed`** chip plus a workspace banner offering to reopen it.
- `node src/cli.js finding unbacked` audits the whole ledger for them; `/flowlever:watch` runs it every
  pass, checks each against the branch, and reopens the ones that genuinely never landed.
- **Scope:** `pr-respond` only — that is the flow where *you* are the PR author and owe the commit. A
  `pr-review` workspace is you reviewing someone else's PR, where a suggested diff is a comment for
  *their* author to commit, so no sha is owed. Spec workspaces prove delivery with `appliedAt`. An
  unrecognised or unreadable workspace kind fails **closed** (gate on).

**A Post can never silently look done.** Clicking Post in the cockpit writes nothing — the browser can't
reach Azure DevOps. It marks the items **“Posting…”** and queues an `apply` job; only the runner can
confirm a comment landed, by stamping it **Posted — awaiting author**. That means the runner has to be
running, so the cockpit is explicit whenever it isn't:

- a job queued (or claiming to run) for over 3 minutes with **no runner going** reads **⏸ Not running —
  nothing has been posted**, never a spinner, and offers **▶ Run it now**. (With a runner live the same
  job correctly reads "queued for the runner" — it's waiting its turn, not abandoned.)
- a job that reached `done` while items are still “Posting…” reads **finished, but N items not confirmed
  as posted** — a runner's own "done" is not treated as proof;
- both offer **↩ Back to the review queue**, which releases the items (keeping your Approve/Edit
  decisions) so you can Post again. It never pretends anything was written.

Each `/flowlever:watch` pass also heals strays: for any item stuck “Posting…” with no live job it checks
the PR and either stamps it (the comment is there — only the stamp was lost) or releases it.

**Safety:** the pass is ingest-only — it never posts comments, replies, or votes. Posting always
stays behind your explicit **Apply** in the cockpit. Auto-enqueued jobs are tagged
`instructions: "auto ..."` so you can tell them from manual runs.

**Tuning (env):** `FLOWLEVER_ADO_PROJECT` (project to scan), `FLOWLEVER_REVIEWER_EMAIL` (whose
reviews), `FLOWLEVER_POLL_CAP` (max heavy jobs per pass, default 3), `FLOWLEVER_DATA` (ledger dir).
The decision rules themselves live in `skills/poll/SKILL.md`.

**Pause / resume:** `touch ~/.flowlever/poll-pause` makes every pass exit immediately; delete the
file to resume. This pauses the automation without touching the scheduler.

### Scheduling on macOS — use launchd, not cron

Claude Code keeps its OAuth credentials in the macOS Keychain. Plain `cron` runs outside your GUI
login session and cannot unlock the Keychain, so headless `claude -p` fails with
`Not logged in · Please run /login`. A **LaunchAgent** runs inside your login session and works.
`~/Library/LaunchAgents/com.motioncomplex.flowlever.poll.plist` (every 2h, 07–17h; the command
skips weekends):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.motioncomplex.flowlever.poll</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string><string>-lc</string>
    <string>[ "$(date +%u)" -gt 5 ] &amp;&amp; exit 0; echo "=== poll $(date '+%F %T') ==="; FLOWLEVER_ADO_PROJECT=&lt;project&gt; FLOWLEVER_REVIEWER_EMAIL=&lt;you@example.com&gt; $HOME/.local/bin/claude -p "/flowlever:poll" --dangerously-skip-permissions</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>7</integer></dict>
    <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>7</integer></dict>
    <dict><key>Hour</key><integer>11</integer><key>Minute</key><integer>7</integer></dict>
    <dict><key>Hour</key><integer>13</integer><key>Minute</key><integer>7</integer></dict>
    <dict><key>Hour</key><integer>15</integer><key>Minute</key><integer>7</integer></dict>
    <dict><key>Hour</key><integer>17</integer><key>Minute</key><integer>7</integer></dict>
  </array>
  <key>StandardOutPath</key><string>/Users/&lt;you&gt;/.flowlever/poll.log</string>
  <key>StandardErrorPath</key><string>/Users/&lt;you&gt;/.flowlever/poll.log</string>
</dict>
</plist>
```

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.motioncomplex.flowlever.poll.plist  # install
launchctl kickstart gui/$(id -u)/com.motioncomplex.flowlever.poll                               # run a pass NOW (test)
launchctl bootout   gui/$(id -u)/com.motioncomplex.flowlever.poll                               # uninstall
```

Adjust the schedule by editing `StartCalendarInterval` and re-running bootout + bootstrap.
`--dangerously-skip-permissions` is required for unattended runs; it's acceptable here because
the poll pass is ingest-only by design. On Linux, plain cron works (no Keychain).

**Operating it day to day:** a macOS notification arrives only when a pass produced something for
you (findings ready, threads awaiting reply, a job errored/needs input). Install
`terminal-notifier` (`brew install terminal-notifier`) so clicking the notification opens the
cockpit directly (starting its server if needed) — without it the pass falls back to plain
osascript notifications, which open Script Editor when clicked. Or open the cockpit yourself
(`/flowlever:start`) to triage and Apply. The run log is `~/.flowlever/poll.log` — check it if
passes seem silent for too long. The first scheduled ADO fetch may require a one-time 2FA/auth
approval; run `/flowlever:poll` once from an interactive session if the log shows auth errors.

## Friendly hostname (optional): http://flowlever.test

Use the `.test` TLD, not `.local` — macOS routes `.local` lookups to Bonjour/mDNS at the socket
layer, so a `/etc/hosts` entry for it resolves in `dscacheutil` but times out in curl/browsers.

Hostname only (keeps the port, `http://flowlever.test:4173`):

```sh
sudo sh -c 'echo "127.0.0.1 flowlever.test flowlever.localhost" >> /etc/hosts'
```

`flowlever.localhost` rides along as an alias: browsers hardwire `*.localhost` to loopback even
without the hosts entry, but curl and most CLI tools don't — the entry makes it universal.

Hostname **without the port** (`http://flowlever.test`) additionally needs a loopback pf redirect
80 → 4173 and a LaunchDaemon so it survives reboots — macOS still reserves ports <1024 for root.
The pf ruleset must keep Apple's default anchors and slot the `rdr` into the translation block
(rule-order matters):

```
scrub-anchor "com.apple/*"
nat-anchor "com.apple/*"
rdr-anchor "com.apple/*"
rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port 80 -> 127.0.0.1 port 4173
dummynet-anchor "com.apple/*"
anchor "com.apple/*"
load anchor "com.apple" from "/etc/pf.anchors/com.apple"
```

Save as `/etc/pf-flowlever.conf`, apply with `pfctl -f /etc/pf-flowlever.conf && pfctl -e`, and
add a `RunAtLoad` LaunchDaemon running the same two commands for boot persistence. The server
itself needs no change for the plain `127.0.0.1 → 127.0.0.1` redirect above — it binds loopback
(`127.0.0.1`) by default, which the rule already targets, and the server ignores the Host header
so any hostname that resolves there works.

**pf reflection quirk:** if the `rdr` target is the same IP the rule matches (`127.0.0.1` →
`127.0.0.1`), direct connections to the target port (`:4173`) start timing out — replies collide
with the translation state. Fix: redirect to a dedicated loopback alias instead
(`ifconfig lo0 alias 127.94.41.73` + `rdr … -> 127.94.41.73 port 4173`; add the ifconfig to the
LaunchDaemon). **This alias trick DOES need a server change**, because the default loopback bind
listens on `127.0.0.1` specifically, not every loopback address: set
`FLOWLEVER_HOST=127.94.41.73` (matching the alias) wherever the server is started. The whole of
`127.0.0.0/8` counts as loopback, so an alias like this is treated exactly like `127.0.0.1`: no
startup warning, and the API stays fully writable.

**Keep the server up:** the cockpit dies with the session that started it. A user-level
`KeepAlive` LaunchAgent running `node app/src/cli.js start --no-open` (with `FLOWLEVER_DATA` set)
makes `flowlever.test` always-on and restarts the server if it crashes.

## Data location

Ledger state (features, findings, rounds, requests, briefs) lives **per-user** in `~/.flowlever`,
so it's shared across repositories and kept out of the plugin. Override the location with the
`FLOWLEVER_DATA` environment variable — every skill honors it.

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `FLOWLEVER_DATA` | Where the ledger (features/ledger/rounds/requests/config/briefs) lives. | Unset: `app/data` relative to the app directory (`src/ledger.js`'s `DATA_DIR`). Every `/flowlever:*` skill and this README explicitly set it to `~/.flowlever` before invoking the CLI, so from the cockpit/skills the effective default is `~/.flowlever`. |
| `PORT` | HTTP port for the cockpit server / `cli.js start --port`. | `4173` |
| `FLOWLEVER_HOST` | Bind address for the cockpit server. | `127.0.0.1` (loopback-only — the cockpit has no authentication, so anything else is reachable by anyone who can hit the port). A non-loopback value prints a startup warning and makes the API **read-only**: every mutation answers 403 unless paired with `FLOWLEVER_ALLOW_REMOTE_WRITES=1`. |
| `FLOWLEVER_ALLOW_REMOTE_WRITES` | Opt-in to allow **any** write — queue a job, decide a finding, start the runner — while `FLOWLEVER_HOST` is non-loopback. Guarding only the runner was not enough: the job queue is itself a write surface, so anyone reaching the port could enqueue work your next local runner would dutifully execute. | Unset (reads allowed, all mutations 403). Set to `1` only if you accept that anyone reaching the port can change your review data and trigger ADO writes. `FLOWLEVER_ALLOW_REMOTE_RUNNER=1` is still honoured as the older, narrower name. |
| `FLOWLEVER_READONLY` | Make this cockpit **read everything and change nothing**: no ledger write, no post to Azure DevOps, no runner. Enforced in three places, because one is not enough — `writeJson` in `src/ledger.js` (so the CLI and any other caller are covered, not just HTTP), a 403 on every non-GET in `src/server.js` (so a refusal reads as policy rather than a 500), and `runner.start()` in `src/runner.js` (the runner spawns a session that posts to real PRs while writing nothing locally, so the ledger guard cannot see it). The UI states the mode in a banner and disables the write controls, so you never compose a decision only to be told afterwards it was not recorded. | Unset (a normal, writable cockpit). Set to `1` to browse or demo against real review data safely — and note the trap it exists for: pointing `FLOWLEVER_DATA` at a throwaway copy isolates the *ledger*, **not** the outbound writes, so a runner started against a scratch copy still comments on real pull requests. |
| `FLOWLEVER_LOCK_WAIT_MS` | How long a write waits for a contended file lock before failing with a retryable 503. | `10000` for the CLI and the runner; **the server overrides this to `1500`** because a wait there blocks every other request. A write costs ~5 ms, so this is a safety net, not an expected latency. Setting the variable overrides BOTH — raising it also raises the server's worst-case stall to the value you choose. |
| `FLOWLEVER_FSYNC_DIR` | Also fsync the containing **directory** after each write, making the rename itself crash-durable. | Unset. Measured cost: 5.16 → 10.05 ms per write, and that time is spent holding a lock, so it is off by default. `tmp`+rename already guarantees a reader never sees a torn file; what this buys is not losing the *last* write in an OS-level crash (you keep the previous good file either way). |
| `FLOWLEVER_CLAUDE_BIN` | Explicit path to the `claude` binary the runner spawns. | Unset: auto-resolve via `~/.local/bin/claude`, then `command -v claude` in a login shell. |
| `FLOWLEVER_ADO_PROJECT` | Azure DevOps project `/flowlever:poll` scans. | Unset: derive from the current repo's git remote (skill-level behavior, `skills/poll/SKILL.md`); if neither is available, the pass stops and says so. |
| `FLOWLEVER_REVIEWER_EMAIL` | Whose PRs/reviews `/flowlever:poll` scans. | Unset: `git config user.email`, else the authenticated ADO identity. |
| `FLOWLEVER_POLL_CAP` | Max heavy jobs (review/re-review/respond ingests) `/flowlever:poll` enqueues per pass. | `3` — anything over the cap waits for the next pass, logged as deferred, never dropped. |

## Troubleshooting

- **A workspace is missing from the board** — the server could not read its file (truncated,
  hand-edited, or a name that isn't a valid workspace id). It is skipped rather than taking the whole
  board down with it, the count is flagged on the `X-FlowLever-Skipped` response header, and
  `curl localhost:4173/api/diagnostics` names the file and the reason. Fix or remove the file.
- **A write returns 503 "timed out waiting for a lock"** — another FlowLever process (the CLI, a
  runner) was writing the same file. It is transient: retry. If nothing is running, the message names
  the `.lock` directory to delete.
- **The cockpit hangs for a moment while the CLI or a runner is writing** — expected, and bounded.
  The ledger is synchronous and every write takes a cross-process lock, so a request that needs a
  file another process is mid-write on blocks the server's single thread until it clears. Real writes
  take about 5 ms, so this is normally invisible; a long stall means something is holding a lock.
  The server caps its own wait at 1.5s (the CLI and the runner use the longer default, since
  blocking costs them nothing) and then answers 503 with `Retry-After`. Measured worst case for an
  unrelated request behind a contended write: ~1.5s. It is bounded, not eliminated — that is
  inherent to a synchronous ledger in a single-threaded server.

- **`node src/cli.js` prints usage instead of doing anything** — that's correct: a bare invocation
  (or `help`) prints usage and exits 0. Run `node src/cli.js help` to see every command.
- **`Not logged in · Please run /login` from a scheduled pass** — you're running the poll/watch
  loop under plain `cron`, which runs outside the GUI login session and can't unlock the macOS
  Keychain where Claude Code's OAuth token lives. Use a **launchd LaunchAgent** instead (see
  [Scheduling on macOS](#scheduling-on-macos--use-launchd-not-cron) above); plain cron is fine on
  Linux, which has no Keychain.
- **`timed out waiting for a lock on <file> — another FlowLever process is writing it`** — two
  writers (server, CLI, runner) tried to touch the same file at once and one waited past the 10s
  timeout. If nothing is actually running (a process crashed mid-write and left a stale
  `<file>.lock/` directory that hasn't aged out past 30s yet, or genuinely never will because the
  holder is gone), delete the named `<file>.lock/` directory and retry. If something IS running,
  just retry — it will very likely have released the lock by then.
- **`invalid feature id "…"` on an otherwise-normal command** — feature ids must match
  `[a-z0-9-]{1,64}`; this is checked on every route/command that turns an id into a filename, not
  just on create, so a typo'd or copy-pasted id (stray whitespace, uppercase, a URL fragment)
  fails clearly instead of silently reading/writing the wrong file.
- **`finding posted`/the Post button refuses with "…cannot be marked posted without the commit
  that carries it"** — the finding's agreed response is a code change and no valid commit sha was
  given. Apply the fix, commit, push it, then pass `--sha <pushed commit sha>` (7–40 hex chars). If
  the fix genuinely wasn't made, run `finding cancel <ws> --fps <fp>` instead of forcing a stamp.
- **The runner button/`/flowlever:watch` won't start ("runner is disabled…")** — the server is
  bound to a non-loopback `FLOWLEVER_HOST`. Bind loopback (the default), or explicitly set
  `FLOWLEVER_ALLOW_REMOTE_WRITES=1` if you understand that this grants anyone reaching the port the
  ability to trigger writes to your Azure DevOps account.
- **"Could not find the `claude` CLI"** — install it, or point `FLOWLEVER_CLAUDE_BIN` at its full
  path; the runner refuses to guess.
- **A clicked notification opens Script Editor instead of the cockpit** — that's the `osascript`
  fallback; install `terminal-notifier` (`brew install terminal-notifier`) so notification clicks
  open the cockpit directly (starting the server if needed).
- **A `.test`/`.local` friendly hostname times out in curl/browsers but resolves in `dscacheutil`**
  — you used the `.local` TLD, which macOS routes to Bonjour/mDNS at the socket layer. Use `.test`
  instead (see [Friendly hostname](#friendly-hostname-optional-httpflowlevertest) above).
- **Anything else server-side** — `GET /api/version` and the cockpit's own staleness banner catch
  a browser tab running against an older/newer server build than expected; a hard reload (not just
  restarting the server) usually clears it.

## The bundled app

The cockpit app lives under `app/` (`app/src/cli.js`, `app/src/server.js`, `app/web/`, with
`app/docs/SCHEMA.md` and `app/docs/ARCHITECTURE.md` documenting the schema and design). Skills
invoke it via `${CLAUDE_PLUGIN_ROOT}/app/src/cli.js`. Run its tests with `cd app && node --test`.
