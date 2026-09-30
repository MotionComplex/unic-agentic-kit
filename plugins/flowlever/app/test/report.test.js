'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Must be set BEFORE requiring the module under test (and ledger, which reads it at require time).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowlever-test-'));
process.env.FLOWLEVER_DATA = tmpDir;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const ledger = require('../src/ledger');
const { generateReport } = require('../src/report');

function mkFinding(over = {}) {
  return {
    dimension: 'dor',
    severity: 'blocker',
    title: 'boom',
    detail: 'it goes boom',
    locus: 'x',
    suggestion: 'defuse it',
    ...over,
  };
}

before(() => {
  ledger.initDataDir();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ----- C-9: posted/unaddressed blocker must not produce a self-contradicting report -----

test('C-9: a posted, unaddressed blocker never contradicts the READY badge', () => {
  const id = 'c9-posted-blocker';
  ledger.createFeature({ id, title: 'C9 Posted Blocker', kind: 'pr-review' });
  // Not a duplicate-detection test: assert up front that this PR carries no comments,
  // which is what the ingest gate requires a PR workspace to have established.
  ledger.setPriorThreads(id, []);
  ledger.ingestRound(id, [mkFinding()]);
  const [fp] = ledger.loadLedger(id).findings.map((f) => f.fp);
  ledger.markPosted(id, [fp]);

  const ready = ledger.readiness(id);
  // Sanity: this is exactly the scenario REVIEW.md's C-9 describes — score-wise READY, but a
  // blocker is still sitting on the board (reworking / posted, not resolved).
  assert.equal(ready.score, 100);
  assert.equal(ready.gate, 'ready');
  assert.equal(ready.openCount, 0);

  const report = generateReport(id);

  // The scored metric says 0 — that part alone used to look like the whole truth (C-9's bug).
  assert.match(report, /Open findings \(scored\)\s*\|\s*0 \(◆ 0 blocker/);
  // But the report must ALSO say, explicitly, that something is still on the board and why the
  // score doesn't reflect it — no reader should have to reconcile two tables themselves.
  assert.match(report, /On the board \(incl\. posted\/applied\/pending\)\s*\|\s*1 \(1 not scored/);
  assert.match(report, /finding on the board is posted, applied, or pending.*excluded from the score/);
  assert.match(report, /including 1 blocker that would otherwise gate readiness/);

  // Blocking section: no *gating* blocker, but the posted one is named, not hidden.
  assert.match(report, /No blockers are gating the readiness score right now\./);
  assert.match(report, /1 more blocker on the board, not gating the score \(posted\/applied\/pending\)/);
  assert.match(report, /### ◆ boom _\(posted — awaiting author\)_/);

  // Dimension section: must not call this "open" (that's the word that caused the contradiction);
  // it should be legible as "on board" with an honest per-row "Scored" column.
  assert.match(report, /## Findings on the board, by dimension/);
  assert.match(report, /### dor \(1 on board · 0 scored\)/);
  assert.match(report, /⏸ no — posted — awaiting author/);

  // The literal C-9 repro from REVIEW.md must be impossible now: nowhere does the document
  // claim "0 blocker" in a way that omits the still-open boom finding from the same document.
  assert.ok(!/Open findings\s*\|\s*0 \(.*0 blocker.*\)[\s\S]*### dor \(1 open\)/.test(report));
});

// ----- Clean workspace: nothing open, everything resolved/waived -> coherently READY -----

test('clean workspace (resolved + waived, nothing open) reports READY coherently', () => {
  const id = 'clean-workspace';
  ledger.createFeature({ id, title: 'Clean Workspace' });
  ledger.ingestRound(id, [
    mkFinding({ title: 'will resolve', severity: 'major' }),
    mkFinding({ title: 'will waive', severity: 'minor' }),
  ]);
  const findings = ledger.loadLedger(id).findings;
  const resolveFp = findings.find((f) => f.title === 'will resolve').fp;
  const waiveFp = findings.find((f) => f.title === 'will waive').fp;
  ledger.setFindingStatus(id, resolveFp, { status: 'resolved' });
  ledger.setFindingStatus(id, waiveFp, { status: 'waived', reason: 'accepted risk' });

  const report = generateReport(id);
  assert.match(report, /🟢 `READY`/);
  assert.match(report, /Open findings \(scored\)\s*\|\s*0 /);
  assert.match(report, /On the board \(incl\. posted\/applied\/pending\)\s*\|\s*0/);
  assert.match(report, /Nothing on the board — no unresolved findings\./);
  assert.match(report, /No blockers are gating the readiness score right now\./);
  // Nothing should read "not scored" when there's nothing to explain away.
  assert.ok(!report.includes('not scored'));
  assert.match(report, /## Waived findings/);
  assert.match(report, /will waive/);
});

// ----- Genuinely open blockers -> NOT READY, and the two blocker lists agree -----

test('genuinely open (untouched) blocker reports NOT READY with no shadow blockers', () => {
  const id = 'open-blocker';
  ledger.createFeature({ id, title: 'Open Blocker', kind: 'pr-review' });
  // Not a duplicate-detection test: assert up front that this PR carries no comments,
  // which is what the ingest gate requires a PR workspace to have established.
  ledger.setPriorThreads(id, []);
  ledger.ingestRound(id, [mkFinding({ title: 'still open boom' })]);

  const ready = ledger.readiness(id);
  assert.equal(ready.gate, 'not-ready');
  assert.equal(ready.openCount, 1);

  const report = generateReport(id);
  assert.match(report, /🔴 `NOT READY`/);
  assert.match(report, /Open findings \(scored\)\s*\|\s*1 \(◆ 1 blocker/);
  // No "not scored" note — the board count and the scored count agree exactly.
  assert.ok(!report.includes('not scored'));
  assert.match(report, /### ◆ still open boom/);
  // No shadow-blocker callout since there's nothing posted/applied/pending.
  assert.ok(!report.includes('not gating the score (posted/applied/pending)'));
});

// ----- Posted vs applied vs pending are each represented honestly, not merged -----

test('posted, applied, and pending findings are each labeled distinctly on the board', () => {
  const id = 'mixed-lanes';
  ledger.createFeature({ id, title: 'Mixed Lanes', kind: 'pr-review' });
  // Not a duplicate-detection test: assert up front that this PR carries no comments,
  // which is what the ingest gate requires a PR workspace to have established.
  ledger.setPriorThreads(id, []);
  ledger.ingestRound(id, [
    mkFinding({ title: 'posted one', severity: 'major', locus: 'a' }),
    mkFinding({ title: 'applied one', severity: 'major', locus: 'b' }),
    mkFinding({ title: 'pending one', severity: 'major', locus: 'c' }),
    mkFinding({ title: 'truly open one', severity: 'major', locus: 'd' }),
  ]);
  const byTitle = (t) => ledger.loadLedger(id).findings.find((f) => f.title === t).fp;
  ledger.markPosted(id, [byTitle('posted one')]);
  ledger.markApplied(id, [byTitle('applied one')]);
  ledger.setFindingPending(id, [byTitle('pending one')], 'post');

  const ready = ledger.readiness(id);
  assert.equal(ready.openCount, 1); // only "truly open one" is scored

  const report = generateReport(id);
  assert.match(report, /On the board \(incl\. posted\/applied\/pending\)\s*\|\s*4 \(3 not scored/);
  assert.match(report, /⏸ no — posted — awaiting author/);
  assert.match(report, /⏸ no — applied — awaiting re-audit/);
  assert.match(report, /⏸ no — pending — run in flight/);
  assert.match(report, /✅ yes/); // the truly-open one is scored
  assert.match(report, /### dor \(4 on board · 1 scored\)/);
});

// ----- Legacy bare-array ledger must render, not crash -----

test('a legacy bare-array ledger file still renders a report', () => {
  const id = 'legacy-array';
  ledger.createFeature({ id, title: 'Legacy Array' });
  // Write the ledger file directly as a bare array — the pre-normalization on-disk shape some
  // older ledgers still have. ledger.js's loadLedger/normalizeLedger now tolerate this; confirm
  // report.js does too (it only ever goes through ledger.loadLedger / ledger.readiness).
  const legacyFindings = [
    {
      dimension: 'dor', severity: 'blocker', title: 'legacy boom', status: 'open',
      fp: 'legacy-fp-1', firstSeenRound: 1, locus: 'legacy:1',
    },
  ];
  fs.writeFileSync(path.join(tmpDir, 'ledger', `${id}.json`), JSON.stringify(legacyFindings));

  assert.doesNotThrow(() => generateReport(id));
  const report = generateReport(id);
  assert.match(report, /legacy boom/);
  assert.match(report, /🔴 `NOT READY`/);
});

// ----- Zero findings, zero rounds: brand-new feature must render without crashing -----

test('a brand-new feature with zero findings and zero rounds renders without crashing', () => {
  const id = 'brand-new';
  ledger.createFeature({ id, title: 'Brand New' });

  assert.doesNotThrow(() => generateReport(id));
  const report = generateReport(id);
  assert.match(report, /🟢 `READY`/);
  assert.match(report, /Nothing on the board — no unresolved findings\./);
  assert.match(report, /No audit rounds yet\./);
  assert.match(report, /No coverage data yet — run an audit with coverage mapping\./);
  assert.ok(!report.includes('## Waived findings'));
});
