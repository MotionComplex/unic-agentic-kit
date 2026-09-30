---
name: track
description: >
  Give a fast status read on a feature's spec readiness from the FlowLever ledger — score,
  what's open, what moved since the last audit round, stale and pinned findings — without
  fetching or changing anything. Use when the user says "what's the status of X", "where are
  we on X", "what's still open on X", "/flowlever:track", or "spec status".
---

# /flowlever:track — fast spec-readiness status

A lightweight read-only status check. **No MCP fetching, no mutations** — purely the local
ledger. Fast enough to run any time the user wonders "where are we?".

## Gather (all local, all `--json`)
Run (self-contained — app at `${CLAUDE_PLUGIN_ROOT}/app`, data in `~/.flowlever`):
```
FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" readiness <id> --json
FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" finding list <id> --status open --json
FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" finding list <id> --status reworking --json
```
Also read `${FLOWLEVER_DATA:-$HOME/.flowlever}/rounds/<id>.json` for the round history (the last two rounds give you the
deltas).

## Report
A crisp status, not a wall of text:

1. **Headline** — `<score>/100 · <gate>`. If gate is `not-ready`, lead with the blocker count.
2. **Movement since last round** — compare the latest round's stats to the previous: score
   delta (▲/▼), new findings, auto-resolved, and **regressions** (call these out — a fixed
   thing came back). If there's only one round, say "initial audit".
3. **What's open now** — counts by severity, then list open blockers and majors by title
   (these gate readiness). Summarize minors/info as a count.
4. **In rework** — findings currently `reworking` (someone's on them).
5. **Stale findings** — open findings whose `lastSeenRound` is less than the current round
   number: they were flagged before but the most recent audit didn't re-confirm them (could
   be fixed-but-not-re-audited, or a locus/title drift). Flag for a re-audit.
6. **Pinned** — list pinned findings; they persist across audits by design, so remind the
   user they won't auto-resolve until unpinned.

End with the single most useful next action: `/flowlever:audit` (if stale / time for a fresh
pass), `/flowlever:rework` (open blockers to clear), or `/flowlever:brief` (gate is green). Point to
the dashboard for the full picture: http://localhost:4173.
