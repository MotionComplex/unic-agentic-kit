# FlowLever app

This is the bundled, zero-dependency Node app (Node 24, no install) that powers the FlowLever
cockpit: the CLI (`src/cli.js`), the local server + dashboard (`src/server.js`, `web/`), and the
core ledger (`src/ledger.js`) that fingerprints findings and reconciles them across rounds.

This file is deliberately short. The product-level docs live one level up and are kept current;
duplicating them here just gives drift a second place to happen:

- **[`../README.md`](../README.md)** — what FlowLever is, the skill list, quickstart, the
  scheduled-autopilot (`/flowlever:poll`) guide, hosting recipes, and the env-var /
  troubleshooting reference.
- **[`docs/SCHEMA.md`](docs/SCHEMA.md)** — THE CONTRACT: every on-disk file shape, the CLI
  surface, the HTTP API, and the invariants (fingerprinting, reconciliation, the fix gate,
  locking) that the rest of the product depends on.
- **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** — module map and design principles.

## Working in this directory

```bash
cd app
node src/cli.js demo        # seed a realistic example workspace
node src/cli.js start       # boot the cockpit + open http://localhost:4173
node --test                 # run the test suite
```

`node --test` output includes a `pass`/`fail` summary line — read that rather than a number
quoted here, which would go stale the next time a test is added. `node src/cli.js help` is
likewise the source of truth for the current command list.
