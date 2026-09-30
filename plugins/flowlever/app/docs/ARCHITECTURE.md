# FlowLever Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Claude Code session (has MCP auth: Atlassian Rovo, ADO, Figma) │
│                                                                 │
│  /flowlever:audit ──fetch spec/tickets/designs──► swarm analysis│
│        │                                          │             │
│        └──────────── findings.json ───────────────┘             │
│                           │                                     │
│                    POST /api/ingest/:id   (or CLI ingest)       │
└───────────────────────────┼─────────────────────────────────────┘
                            ▼
                 ┌─────────────────────┐         ┌──────────────┐
                 │  Ledger (src/)      │◄───────►│ data/*.json  │
                 │  fingerprint +      │         └──────────────┘
                 │  reconcile + score  │
                 └─────────┬───────────┘
                           ▼
                 ┌─────────────────────┐
                 │ Dashboard :4173     │  features · findings kanban ·
                 │ (web/, vanilla JS)  │  readiness · coverage · timeline
                 └─────────────────────┘
```

## Principles
1. **Offline-pure core.** Ledger/CLI/server never call the network. All fetching happens in
   Claude Code skills, which have the user's MCP auth. Clean seam = testable + portable.
2. **Findings are durable.** The fingerprint + reconciliation rules (SCHEMA.md) are the heart
   of the product: re-running an audit NEVER loses track of what was flagged, what got fixed,
   what regressed. This kills the "tired of cross-checking what was already found" pain.
3. **Zero runtime deps.** Node 24 built-ins only (node:http, node:crypto, node:fs, node:test).
4. **Skills are thin orchestrators.** They fetch → prompt the swarm → emit ingest-shaped JSON
   → call the API/CLI. All state logic stays in the core.

## Modules
- `src/ledger.js` — load/save stores, cross-process file locking, fingerprint(), ingestRound()
  (with optional scoped reconciliation), setFindingStatus(), the fix gate (isAgreedCodeFix/
  assertFixCommit/unbackedFixes), readiness(), the requests queue (incl. claimRequest/
  claimNextRequest), coverage helpers. Pure functions + a small fs layer; see SCHEMA.md for
  the full contract.
- `src/cli.js` — arg parsing (hand-rolled), maps to ledger ops. `--json` for machine output on
  list/show/readiness. Run `node src/cli.js help` for the current command list.
- `src/report.js` — markdown report generator (exec summary, blockers, per-dimension, coverage table, round timeline).
- `src/server.js` — node:http server, JSON API per SCHEMA.md, serves `web/`. Binds loopback
  (`127.0.0.1`) by default — see the root README's env-var reference for `FLOWLEVER_HOST`.
- `src/runner.js` — starts/stops the session-side `/flowlever:watch` or `/flowlever:poll` process
  from the cockpit's "▶ Run N jobs" button; tracks the one-at-a-time run and tails its log.
- `src/demo.js` — seeds the three demo workspaces (spec / pr-review / pr-respond) `cli.js demo` uses.
- `src/version.js` — the HTTP API's wire-contract version (`API_VERSION`), so the browser can
  detect a server older than the page it's serving (`GET /api/version`).
- `web/` — index.html + app.js + style.css. No framework. Views: feature list, feature detail
  (findings board grouped by status, filterable by dimension/severity; readiness dial; coverage
  matrix; rounds timeline). Dark, calm, fast. Actions: change finding status, pin, waive w/ reason.
- `skills/` (top-level, sibling of `app/` — **not** `.claude/skills/`) — the 12 `/flowlever:*`
  skills: `audit`, `propose`, `apply-spec`, `rework`, `brief`, `track` (the spec-review loop);
  `start`, `stop` (cockpit lifecycle); `watch`, `poll` (the session-side runner + its scheduled
  autopilot); `pr-review`, `pr-respond` (the PR-review/respond cockpit adapters). See each
  `SKILL.md` for its procedure.

## Audit swarm design (inside /flowlever:audit)
Dimensions run as parallel agents, each returns ingest-shaped findings:
consistency (spec↔ADO↔Figma contradictions), completeness (gaps, missing ACs/edge cases),
testability (vague/unmeasurable statements), design-match (Figma frames vs spec sections),
dor (Definition of Ready checklist), ambiguity (multi-interpretable wording), feasibility
(technical risk flags). A final dedup/synthesis step merges near-duplicates before ingest.
