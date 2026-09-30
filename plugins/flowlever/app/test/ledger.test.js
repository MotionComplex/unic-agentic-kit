'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Must be set BEFORE requiring the module under test.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowlever-test-'));
process.env.FLOWLEVER_DATA = tmpDir;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const ledger = require('../src/ledger');

function mkFinding(over = {}) {
  return {
    dimension: 'consistency',
    severity: 'major',
    title: 'Spec and ADO disagree on payment methods',
    detail: 'Spec lists 3, AC lists 4.',
    locus: 'confluence:1#flow vs ado:42695',
    suggestion: 'Align them.',
    ...over,
  };
}

before(() => {
  ledger.initDataDir();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('DATA_DIR honours FLOWLEVER_DATA and initDataDir scaffolds the layout', () => {
  assert.equal(ledger.DATA_DIR, tmpDir);
  for (const sub of ['features', 'ledger', 'rounds']) {
    assert.ok(fs.existsSync(path.join(tmpDir, sub)), `missing data/${sub}`);
  }
  const config = ledger.loadConfig();
  assert.equal(config.severityWeights.blocker, 10);
  assert.equal(config.gates.readyThreshold, 85);
  assert.equal(config.dimensions.length, 7);
});

test('feature CRUD: create, get, list, duplicate and bad id rejection', () => {
  const f = ledger.createFeature({ id: 'checkout-redesign', title: 'Checkout Redesign' });
  assert.equal(f.status, 'draft');
  assert.deepEqual(f.sources, { confluence: [], ado: [], figma: [] });

  const loaded = ledger.getFeature('checkout-redesign');
  assert.equal(loaded.title, 'Checkout Redesign');
  assert.ok(ledger.listFeatures().some((x) => x.id === 'checkout-redesign'));

  assert.throws(() => ledger.createFeature({ id: 'checkout-redesign', title: 'Dup' }), (e) => e.code === 'EUSER');
  assert.throws(() => ledger.createFeature({ id: 'Bad_ID!', title: 'x' }), (e) => e.code === 'EUSER');
  assert.throws(() => ledger.getFeature('nope'), (e) => e.code === 'EUSER');
});

test('kind: defaults to spec, validates the enum, accepts the three kinds', () => {
  // Default when omitted.
  const def = ledger.createFeature({ id: 'kind-default', title: 'No kind given' });
  assert.equal(def.kind, 'spec');
  assert.equal(ledger.getFeature('kind-default').kind, 'spec');

  // Each valid kind is stored verbatim.
  for (const kind of ledger.KINDS) {
    const id = `kind-${kind}`;
    const f = ledger.createFeature({ id, title: `A ${kind} workspace`, kind });
    assert.equal(f.kind, kind);
    assert.equal(ledger.getFeature(id).kind, kind);
  }

  // Bad kind is rejected as a user error.
  assert.throws(() => ledger.createFeature({ id: 'kind-bad', title: 'x', kind: 'nope' }), (e) => e.code === 'EUSER');
});

test('kind: a feature on disk with no kind field is treated as spec (back-compat)', () => {
  const id = 'legacy-no-kind';
  ledger.createFeature({ id, title: 'Legacy workspace' });
  // Simulate pre-`kind` data by stripping the field on disk.
  const file = path.join(tmpDir, 'features', `${id}.json`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete raw.kind;
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));

  assert.equal(ledger.getFeature(id).kind, 'spec');
  assert.equal(ledger.listFeatures().find((x) => x.id === id).kind, 'spec');
});

test('addSource validates type and stores entries with lastFetched=null', () => {
  ledger.addSource('checkout-redesign', { type: 'confluence', id: '123456', title: 'Spec', url: 'https://c' });
  ledger.addSource('checkout-redesign', { type: 'ado', id: 42695, itemType: 'User Story', title: 'Story', url: 'https://a', state: 'New' });
  const f = ledger.getFeature('checkout-redesign');
  assert.equal(f.sources.confluence[0].lastFetched, null);
  assert.equal(f.sources.ado[0].type, 'User Story');
  assert.throws(() => ledger.addSource('checkout-redesign', { type: 'jira', id: '1' }), (e) => e.code === 'EUSER');
});

test('fingerprint: 10-char sha1 slice, normalization-stable, locus-sensitive', () => {
  const a = ledger.fingerprint('feat', 'consistency', 'Hello,   World!', 'loc:1');
  const b = ledger.fingerprint('feat', 'consistency', 'hello world', 'loc:1');
  const c = ledger.fingerprint('feat', 'consistency', '  HELLO -- world??  ', 'loc:1');
  assert.match(a, /^[0-9a-f]{10}$/);
  assert.equal(a, b, 'case/punctuation/whitespace variants must share a fingerprint');
  assert.equal(a, c);
  assert.notEqual(a, ledger.fingerprint('feat', 'consistency', 'hello world', 'loc:2'), 'different locus');
  assert.notEqual(a, ledger.fingerprint('feat', 'completeness', 'hello world', 'loc:1'), 'different dimension');
  // The FULL title is hashed. Two findings that diverge only after character 80 are still two
  // findings — truncating first made them collide, and ingest then dropped the second silently.
  const long = 'x'.repeat(80);
  assert.notEqual(
    ledger.fingerprint('feat', 'dor', long + 'aaa', 'l'),
    ledger.fingerprint('feat', 'dor', long + 'bbb', 'l'),
    'divergence after char 80 must produce different fingerprints'
  );
  // The legacy (truncating) fingerprint is kept only so ingest can adopt findings already stored
  // under it; it still collides, which is exactly why it was replaced.
  assert.equal(
    ledger.legacyFingerprint('feat', 'dor', long + 'aaa', 'l'),
    ledger.legacyFingerprint('feat', 'dor', long + 'bbb', 'l')
  );
});

test('two findings sharing an 80-char title prefix are BOTH ingested (no silent collision drop)', () => {
  const id = 'fp-collide';
  ledger.createFeature({ id, title: 'Collision' });
  const prefix = 'Spec and ADO disagree on the payment method list for the checkout redesign flow, item ';
  assert.ok(prefix.length >= 80, 'prefix must exceed the old truncation length');

  const { stats } = ledger.ingestRound(id, [
    mkFinding({ title: `${prefix}Twint`, locus: 'confluence:1#pay' }),
    mkFinding({ title: `${prefix}Apple Pay`, locus: 'confluence:1#pay' }),
  ]);

  assert.equal(stats.new, 2, 'both findings must be inserted');
  assert.equal(stats.duplicatesInBatch, 0);
  const titles = ledger.loadLedger(id).findings.map((f) => f.title).sort();
  assert.deepEqual(titles, [`${prefix}Apple Pay`, `${prefix}Twint`]);
});

test('ingest ADOPTS a finding stored under the legacy truncated fingerprint (no orphan+re-insert)', () => {
  const id = 'fp-migrate';
  ledger.createFeature({ id, title: 'Migrate' });
  const longTitle = `${'y'.repeat(90)} tail`;
  const f = mkFinding({ title: longTitle, locus: 'x:1' });

  // Seed the ledger the way the previous version would have written it: legacy fp, real history.
  const legacyFp = ledger.legacyFingerprint(id, f.dimension, f.title, f.locus);
  const newFp = ledger.fingerprint(id, f.dimension, f.title, f.locus);
  assert.notEqual(legacyFp, newFp);
  fs.mkdirSync(path.join(tmpDir, 'ledger'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'ledger', `${id}.json`), JSON.stringify({
    featureId: id,
    findings: [{
      fp: legacyFp, dimension: f.dimension, severity: f.severity, title: f.title, detail: '',
      locus: f.locus, suggestion: '', duplicateOf: null, status: 'open', statusReason: null,
      pinned: true, firstSeenRound: 1, lastSeenRound: 1, resolvedInRound: null,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', history: [],
    }],
  }, null, 2));

  const { stats } = ledger.ingestRound(id, [f]);
  assert.equal(stats.migratedFps, 1, 'the legacy row must be adopted');
  assert.equal(stats.new, 0, 'not re-inserted as new');
  assert.equal(stats.autoResolved, 0, 'the original must not be orphaned and auto-resolved');

  const findings = ledger.loadLedger(id).findings;
  assert.equal(findings.length, 1);
  assert.equal(findings[0].fp, newFp, 're-keyed to the full-title fingerprint');
  assert.equal(findings[0].pinned, true, 'pins and history survive the migration');
  assert.equal(findings[0].firstSeenRound, 1, 'identity (first seen) is preserved');
});

test('validateIngestFinding rejects bad dimension/severity/missing fields', () => {
  assert.throws(() => ledger.validateIngestFinding(mkFinding({ dimension: 'vibes' })), (e) => e.code === 'EUSER');
  assert.throws(() => ledger.validateIngestFinding(mkFinding({ severity: 'huge' })), (e) => e.code === 'EUSER');
  assert.throws(() => ledger.validateIngestFinding(mkFinding({ title: '' })), (e) => e.code === 'EUSER');
  assert.throws(() => ledger.validateIngestFinding(mkFinding({ locus: '  ' })), (e) => e.code === 'EUSER');
  assert.throws(() => ledger.validateIngestFinding(mkFinding({ detail: 42 })), (e) => e.code === 'EUSER');
  assert.equal(ledger.validateIngestFinding(mkFinding()).severity, 'major');
});

test('duplicateOf: validated on ingest, stored on the finding, editable later', () => {
  assert.throws(() => ledger.validateIngestFinding(mkFinding({ duplicateOf: 'thread 7' })), (e) => e.code === 'EUSER');
  assert.throws(() => ledger.validateIngestFinding(mkFinding({ duplicateOf: { url: 'https://x' } })), (e) => e.code === 'EUSER'); // label required
  ledger.createFeature({ id: 'dup', title: 'Dup' });
  ledger.ingestRound('dup', [
    mkFinding({ title: 'Canonical', locus: 'a' }),
    mkFinding({ title: 'Copycat', locus: 'b', duplicateOf: { label: 'Oriol on a.cs:39', url: 'https://ado/pr?discussionId=1' } }),
  ]);
  const led = ledger.loadLedger('dup');
  assert.equal(led.findings.find((f) => f.title === 'Canonical').duplicateOf, null);
  assert.equal(led.findings.find((f) => f.title === 'Copycat').duplicateOf.label, 'Oriol on a.cs:39');
  const copy = led.findings.find((f) => f.title === 'Copycat');
  const updated = ledger.setFindingDetails('dup', copy.fp, { duplicateOf: { label: 'Marta on b.cs:12' } });
  assert.equal(updated.duplicateOf.label, 'Marta on b.cs:12');
  assert.equal(ledger.setFindingDetails('dup', copy.fp, { duplicateOf: null }).duplicateOf, null);
});

test('ingest round 1 inserts findings as open with firstSeenRound=1', () => {
  ledger.createFeature({ id: 'ing', title: 'Ingest' });
  const { round, stats } = ledger.ingestRound('ing', [
    mkFinding({ title: 'Finding A', locus: 'a' }),
    mkFinding({ title: 'Finding B', locus: 'b', severity: 'minor' }),
  ], { note: 'first audit' });

  assert.equal(stats.new, 2);
  assert.equal(stats.totalOpen, 2);
  assert.equal(round.n, 1);
  assert.equal(round.note, 'first audit');
  assert.equal(round.trigger, 'audit');

  const led = ledger.loadLedger('ing');
  assert.equal(led.findings.length, 2);
  const a = led.findings.find((f) => f.title === 'Finding A');
  assert.equal(a.status, 'open');
  assert.equal(a.firstSeenRound, 1);
  assert.equal(a.lastSeenRound, 1);
  assert.equal(a.pinned, false);
  assert.equal(a.resolvedInRound, null);
});

test('ingest round 2: same finding refreshes lastSeenRound without duplicating', () => {
  const { stats } = ledger.ingestRound('ing', [
    mkFinding({ title: 'Finding A', locus: 'a', detail: 'updated detail' }),
    mkFinding({ title: 'Finding B', locus: 'b', severity: 'minor' }),
  ]);
  assert.equal(stats.new, 0);
  assert.equal(stats.stillOpen, 2);

  const led = ledger.loadLedger('ing');
  assert.equal(led.findings.length, 2, 'no duplicate rows');
  const a = led.findings.find((f) => f.title === 'Finding A');
  assert.equal(a.lastSeenRound, 2);
  assert.equal(a.firstSeenRound, 1);
  assert.equal(a.detail, 'updated detail');
});

test('ingest: finding absent from the round auto-resolves via reconcile', () => {
  const { stats } = ledger.ingestRound('ing', [mkFinding({ title: 'Finding A', locus: 'a' })]);
  assert.equal(stats.autoResolved, 1);

  const b = ledger.loadLedger('ing').findings.find((f) => f.title === 'Finding B');
  assert.equal(b.status, 'resolved');
  assert.equal(b.resolvedInRound, 3);
  const h = b.history.at(-1);
  assert.equal(h.by, 'reconcile');
  assert.equal(h.from, 'open');
  assert.equal(h.to, 'resolved');
});

test('pinned findings are never auto-resolved', () => {
  ledger.createFeature({ id: 'pin', title: 'Pin' });
  ledger.ingestRound('pin', [mkFinding({ title: 'Pinned one', locus: 'p' })]);
  const fp = ledger.loadLedger('pin').findings[0].fp;
  ledger.setFindingStatus('pin', fp, { pinned: true });

  const { stats } = ledger.ingestRound('pin', []);
  assert.equal(stats.autoResolved, 0);
  const f = ledger.loadLedger('pin').findings[0];
  assert.equal(f.status, 'open');
  assert.equal(f.pinned, true);
});

test('regression: closed finding re-flagged without reopenResolved stays resolved but is counted', () => {
  const finding = mkFinding({ title: 'Finding B', locus: 'b', severity: 'minor' });
  const { stats } = ledger.ingestRound('ing', [mkFinding({ title: 'Finding A', locus: 'a' }), finding]);
  assert.equal(stats.regressions, 1);
  assert.equal(stats.new, 0);

  const b = ledger.loadLedger('ing').findings.find((f) => f.title === 'Finding B');
  assert.equal(b.status, 'resolved', 'stays resolved without reopenResolved');
});

test('regression with reopenResolved:true reopens and clears resolvedInRound', () => {
  const finding = mkFinding({ title: 'Finding B', locus: 'b', severity: 'minor' });
  const { stats } = ledger.ingestRound('ing', [mkFinding({ title: 'Finding A', locus: 'a' }), finding], { reopenResolved: true });
  assert.equal(stats.regressions, 1);

  const b = ledger.loadLedger('ing').findings.find((f) => f.title === 'Finding B');
  assert.equal(b.status, 'open');
  assert.equal(b.resolvedInRound, null);
  const h = b.history.at(-1);
  assert.equal(h.from, 'resolved');
  assert.equal(h.to, 'open');
  assert.equal(h.by, 'reconcile');
});

test('setFindingStatus: waive requires reason; transitions append history', () => {
  const fp = ledger.loadLedger('ing').findings.find((f) => f.title === 'Finding A').fp;
  assert.throws(() => ledger.setFindingStatus('ing', fp, { status: 'waived' }), (e) => e.code === 'EUSER');
  assert.throws(() => ledger.setFindingStatus('ing', 'ffffffffff', { status: 'open' }), (e) => e.code === 'EUSER');
  assert.throws(() => ledger.setFindingStatus('ing', fp, { status: 'banished' }), (e) => e.code === 'EUSER');

  const before = ledger.loadLedger('ing').findings.find((f) => f.fp === fp).history.length;
  const waived = ledger.setFindingStatus('ing', fp, { status: 'waived', reason: 'accepted risk' });
  assert.equal(waived.status, 'waived');
  assert.equal(waived.statusReason, 'accepted risk');
  assert.equal(waived.history.length, before + 1);
  assert.equal(waived.history.at(-1).by, 'user');

  const reopened = ledger.setFindingStatus('ing', fp, { status: 'open' });
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.resolvedInRound, null);
  assert.equal(reopened.history.length, before + 2);
});

test('markPosted: stamps postedAt, keeps finding reworking (open→reworking), idempotent', () => {
  ledger.createFeature({ id: 'posted', title: 'Posted', kind: 'pr-review' });
  // Not a duplicate-detection test: assert up front that this PR carries no comments,
  // which is what the ingest gate requires a PR workspace to have established.
  ledger.setPriorThreads('posted', []);
  ledger.ingestRound('posted', [
    mkFinding({ title: 'P1', locus: 'pr:9:a.ts:L1' }),
    mkFinding({ title: 'P2', locus: 'pr:9:b.ts:L2', severity: 'minor' }),
  ]);
  const fps = ledger.loadLedger('posted').findings.map((f) => f.fp);

  const updated = ledger.markPosted('posted', fps);
  assert.equal(updated.length, 2);
  const led = ledger.loadLedger('posted');
  for (const f of led.findings) {
    assert.equal(f.status, 'reworking', 'posted finding stays open for reconcile');
    assert.ok(f.postedAt, 'carries a postedAt stamp');
    assert.equal(f.history.at(-1).note, 'posted to PR');
    assert.equal(f.history.at(-1).by, 'post');
  }

  // Idempotent: re-posting refreshes the stamp without piling on history entries.
  const before = ledger.loadLedger('posted').findings[0].history.length;
  ledger.markPosted('posted', [fps[0]]);
  assert.equal(ledger.loadLedger('posted').findings[0].history.length, before);
});

test('readiness: posted findings do not penalize the score (awaiting author)', () => {
  const r = ledger.readiness('posted');   // both findings posted from the previous test
  assert.equal(r.score, 100, 'posted findings are excluded from the penalty');
  assert.equal(r.gate, 'ready');
  assert.equal(r.openCount, 0);
});

test('re-review reconcile: author-fixed posted finding auto-resolves, still-flagged stays', () => {
  // P1 still flagged (same locus), P2 dropped → P2 auto-resolves, P1 stays posted/reworking.
  const { stats } = ledger.ingestRound('posted', [mkFinding({ title: 'P1', locus: 'pr:9:a.ts:L1' })]);
  assert.equal(stats.autoResolved, 1);
  const led = ledger.loadLedger('posted');
  const p1 = led.findings.find((f) => f.title === 'P1');
  const p2 = led.findings.find((f) => f.title === 'P2');
  assert.equal(p1.status, 'reworking');
  assert.ok(p1.postedAt, 'still-flagged posted finding keeps its stamp');
  assert.equal(p2.status, 'resolved', 'addressed comment auto-resolves on re-review');
});

test('reopening a posted finding drops the postedAt stamp', () => {
  const fp = ledger.loadLedger('posted').findings.find((f) => f.title === 'P1').fp;
  const reopened = ledger.setFindingStatus('posted', fp, { status: 'open' });
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.postedAt, undefined, 'reopen pulls it back into the review flow');
});

test('setFindingDecision: stores approve/edit, clears on null, validates, cleared by status change', () => {
  ledger.createFeature({ id: 'dec', title: 'Decisions', kind: 'pr-review' });
  // Not a duplicate-detection test: assert up front that this PR carries no comments,
  // which is what the ingest gate requires a PR workspace to have established.
  ledger.setPriorThreads('dec', []);
  ledger.ingestRound('dec', [mkFinding({ title: 'D1', locus: 'pr:1:a.ts:L1' })]);
  const fp = ledger.loadLedger('dec').findings[0].fp;

  assert.equal(ledger.setFindingDecision('dec', fp, 'approve').decision, 'approve');
  assert.equal(ledger.loadLedger('dec').findings[0].decision, 'approve');
  assert.equal(ledger.setFindingDecision('dec', fp, 'edit').decision, 'edit');
  assert.throws(() => ledger.setFindingDecision('dec', fp, 'nope'), (e) => e.code === 'EUSER');

  // a status change supersedes (clears) the decision
  ledger.setFindingStatus('dec', fp, { status: 'waived', reason: 'dismissed' });
  assert.equal(ledger.loadLedger('dec').findings[0].decision, undefined);

  // reopen, set, then clear with null
  ledger.setFindingStatus('dec', fp, { status: 'open' });
  ledger.setFindingDecision('dec', fp, 'approve');
  assert.equal(ledger.setFindingDecision('dec', fp, null).decision, undefined);
});

test('markPosted anchors review.lastPostedAt; setFeatureReview flips/clears authorResponded', () => {
  ledger.createFeature({ id: 'wait', title: 'Waiting', kind: 'pr-review' });
  // Not a duplicate-detection test: assert up front that this PR carries no comments,
  // which is what the ingest gate requires a PR workspace to have established.
  ledger.setPriorThreads('wait', []);
  ledger.ingestRound('wait', [mkFinding({ title: 'W1', locus: 'pr:2:a.ts:L1' })]);
  const fp = ledger.loadLedger('wait').findings[0].fp;

  ledger.markPosted('wait', [fp]);
  let rev = ledger.getFeature('wait').review;
  assert.ok(rev.lastPostedAt, 'posting anchors lastPostedAt');
  assert.equal(rev.authorRespondedAt, null, 'starts waiting (not responded)');

  ledger.setFeatureReview('wait', { authorRespondedAt: '2026-06-16T12:00:00Z', note: '1 new reply' });
  rev = ledger.getFeature('wait').review;
  assert.equal(rev.authorRespondedAt, '2026-06-16T12:00:00Z');
  assert.equal(rev.note, '1 new reply');

  // re-posting clears the responded flag (back to waiting)
  ledger.markPosted('wait', [fp]);
  rev = ledger.getFeature('wait').review;
  assert.equal(rev.authorRespondedAt, null, 're-post resets to waiting');
  assert.equal(rev.note, null);
});

// ---------------------------------------------------------------------------
// The fix gate. A finding whose agreed response is a code change cannot be marked done without the
// commit that carries it. Regression cover for a real production failure: a run replied "Fixed" on
// two threads, reported done, never committed, and the reviewer re-raised both points days later.
// ---------------------------------------------------------------------------

function mkFixWorkspace(id) {
  ledger.createFeature({ id, title: id, kind: 'pr-respond' });
  // Not a duplicate-detection test: assert up front that this PR carries no comments,
  // which is what the ingest gate requires a PR workspace to have established.
  ledger.setPriorThreads(id, []);
  ledger.ingestRound(id, [
    mkFinding({ dimension: 'consistency', title: 'Raise the log level', locus: `pr:9:thread:1` }),
    mkFinding({ dimension: 'completeness', title: 'Reply-only question', locus: `pr:9:thread:2` }),
  ]);
  const [fix, reply] = ledger.loadLedger(id).findings.map((f) => f.fp);
  ledger.setFindingDraft(id, fix, { target: 'src/A.cs:L10', before: 'LogInformation(x);', after: 'LogWarning(x);' });
  return { fix, reply };
}

test('markPosted REFUSES an agreed code fix with no commit behind it', () => {
  const id = 'gate-hunk';
  const { fix } = mkFixWorkspace(id);
  // Signed off hunk-by-hunk — the commonest path, and the one that leaves `decision` empty. Keying
  // the gate off `decision` alone would let exactly this case through.
  ledger.setDraftReview(id, fix, { hunk: 0, status: 'accepted' });
  assert.equal(ledger.loadLedger(id).findings.find((f) => f.fp === fix).decision, undefined,
    'per-hunk accept intentionally leaves the finding-level decision unset');
  assert.equal(ledger.isAgreedCodeFix(ledger.loadLedger(id).findings.find((f) => f.fp === fix)), true);

  assert.throws(() => ledger.markPosted(id, [fix]), (e) => e.code === 'EUSER' && /cannot be marked posted without the commit/.test(e.message));
  // Nothing was written: the finding must not be half-stamped.
  const after = ledger.loadLedger(id).findings.find((f) => f.fp === fix);
  assert.equal(after.postedAt, undefined);
  assert.equal(after.status, 'open');
});

test('markPosted accepts the fix once a pushed commit is supplied, and records it', () => {
  const id = 'gate-sha';
  const { fix } = mkFixWorkspace(id);
  ledger.setFindingDecision(id, fix, 'fix-only');

  const [f] = ledger.markPosted(id, [fix], { sha: 'a1b2c3d4e5f6', repo: 'DXP-ProfileServices', branch: 'feature/x' });
  assert.ok(f.postedAt);
  assert.equal(f.fixCommit.sha, 'a1b2c3d4e5f6');
  assert.equal(f.fixCommit.repo, 'DXP-ProfileServices');
  assert.equal(f.fixCommit.branch, 'feature/x');
  assert.ok(f.history.some((h) => /fix pushed in a1b2c3d4e5/.test(h.note)));
  // Idempotent: a re-stamp needs no sha now that one is on record.
  assert.doesNotThrow(() => ledger.markPosted(id, [fix]));
});

test('the gate leaves reply-only findings alone — a reply IS the deliverable there', () => {
  const id = 'gate-reply';
  const { reply } = mkFixWorkspace(id);
  ledger.setFindingDecision(id, reply, 'approve');
  const [f] = ledger.markPosted(id, [reply]);
  assert.ok(f.postedAt, 'no draft ⇒ no fix owed ⇒ no sha required');
  assert.equal(f.fixCommit, undefined);
});

test('the gate ignores redirect/reject drafts (explicitly "do not apply this")', () => {
  const id = 'gate-redirect';
  const { fix } = mkFixWorkspace(id);
  ledger.setDraftReview(id, fix, { hunk: 0, status: 'accepted' });
  ledger.setDraftReview(id, fix, { verdict: 'redirect', note: 'do it in the service instead' });
  assert.equal(ledger.isAgreedCodeFix(ledger.loadLedger(id).findings.find((f) => f.fp === fix)), false);
  assert.doesNotThrow(() => ledger.markPosted(id, [fix]));
});

test('a mixed batch is all-or-nothing: one ungated fix blocks the whole markPosted', () => {
  const id = 'gate-batch';
  const { fix, reply } = mkFixWorkspace(id);
  ledger.setDraftReview(id, fix, { hunk: 0, status: 'accepted' });
  ledger.setFindingDecision(id, reply, 'approve');
  assert.throws(() => ledger.markPosted(id, [reply, fix]), (e) => e.code === 'EUSER');
  // The reply must NOT have been stamped on the way to the failure.
  assert.equal(ledger.loadLedger(id).findings.find((f) => f.fp === reply).postedAt, undefined,
    'the batch must not half-apply');
});

test('unbackedFixes finds a fix closed as handled with no commit; clean once recorded', () => {
  const id = 'gate-audit';
  const { fix } = mkFixWorkspace(id);
  ledger.setDraftReview(id, fix, { hunk: 0, status: 'accepted' });
  // Simulate the production failure: stamped posted before the gate existed.
  const doc = ledger.loadLedger(id);
  doc.findings.find((f) => f.fp === fix).postedAt = '2026-08-12T07:00:30.763Z';
  require('node:fs').writeFileSync(path.join(tmpDir, 'ledger', `${id}.json`), JSON.stringify(doc, null, 2));

  assert.deepEqual(ledger.unbackedFixes(id).map((f) => f.fp), [fix]);
  ledger.setFindingFixCommit(id, fix, { sha: 'deadbeef123' });
  assert.deepEqual(ledger.unbackedFixes(id), [], 'recording the real commit clears the audit');
});

test('setFindingFixCommit validates the sha shape', () => {
  const id = 'gate-shaval';
  const { fix } = mkFixWorkspace(id);
  for (const bad of ['', 'nope', 'zzzzzzz', '12345', undefined, null]) {
    assert.throws(() => ledger.setFindingFixCommit(id, fix, { sha: bad }), (e) => e.code === 'EUSER');
  }
  assert.doesNotThrow(() => ledger.setFindingFixCommit(id, fix, { sha: '0123abc' }));
});

test('setFindingDecision accepts fix-only (apply the fix, post no reply) and still rejects junk', () => {
  ledger.createFeature({ id: 'fixonly', title: 'Fix only', kind: 'pr-respond' });
  // Not a duplicate-detection test: assert up front that this PR carries no comments,
  // which is what the ingest gate requires a PR workspace to have established.
  ledger.setPriorThreads('fixonly', []);
  ledger.ingestRound('fixonly', [mkFinding({ title: 'FO1', locus: 'pr:13:thread:1' })]);
  const fp = ledger.loadLedger('fixonly').findings[0].fp;

  assert.equal(ledger.setFindingDecision('fixonly', fp, 'fix-only').decision, 'fix-only');
  // It survives a round-trip through disk, since the runner reads it back to know NOT to reply.
  assert.equal(ledger.loadLedger('fixonly').findings[0].decision, 'fix-only');
  assert.ok(ledger.loadLedger('fixonly').findings[0].history.some((h) => h.note === 'decided: fix-only'));

  assert.equal(ledger.setFindingDecision('fixonly', fp, null).decision, undefined, 'undo still works');
  assert.throws(() => ledger.setFindingDecision('fixonly', fp, 'fix only'), (e) => e.code === 'EUSER');
  assert.throws(() => ledger.setFindingDecision('fixonly', fp, 'reply'), (e) => e.code === 'EUSER');
});

test('clearFindingPending releases a stranded in-flight marker without claiming a write', () => {
  ledger.createFeature({ id: 'stuck', title: 'Stuck post', kind: 'pr-review' });
  // Not a duplicate-detection test: assert up front that this PR carries no comments,
  // which is what the ingest gate requires a PR workspace to have established.
  ledger.setPriorThreads('stuck', []);
  ledger.ingestRound('stuck', [
    mkFinding({ title: 'S1', locus: 'pr:9:a.ts:L1' }),
    mkFinding({ title: 'S2', locus: 'pr:9:b.ts:L2' }),
  ]);
  const [a, b] = ledger.loadLedger('stuck').findings.map((f) => f.fp);

  ledger.setFindingPending('stuck', [a, b], 'post');
  assert.equal(ledger.pendingFindings('stuck').length, 2, 'both are in flight');

  // One really did post; the other never left the queue.
  ledger.markPosted('stuck', [a]);
  assert.equal(ledger.pendingFindings('stuck').length, 1, 'a stamped finding is no longer pending');

  const released = ledger.clearFindingPending('stuck', [a, b], { reason: 'job never ran' });
  const byFp = Object.fromEntries(ledger.loadLedger('stuck').findings.map((f) => [f.fp, f]));
  assert.equal(byFp[b].pending, undefined, 'the marker is gone');
  assert.equal(byFp[b].postedAt, undefined, 'releasing must NOT claim it was posted');
  assert.equal(byFp[b].status, 'reworking', 'it stays triaged, back in the post queue');
  assert.ok(byFp[b].history.some((h) => h.note === 'job never ran'), 'the release is on the trail');
  assert.ok(byFp[a].postedAt, 'an already-posted finding keeps its stamp');
  // Only the still-stranded one is released — markPosted already cleared a's marker, so a
  // successful post is never "undone" by a cancel that arrives after it.
  assert.equal(released.length, 1);
  assert.equal(released[0].fp, b);

  // Idempotent: nothing pending left, so a second call changes nothing.
  assert.equal(ledger.clearFindingPending('stuck', [a, b]).length, 0);
  assert.equal(ledger.pendingFindings('stuck').length, 0);
});

test('clearFindingPending keeps the decision so a retry can re-post the same items', () => {
  ledger.createFeature({ id: 'stuck-dec', title: 'Stuck decisions', kind: 'pr-review' });
  // Not a duplicate-detection test: assert up front that this PR carries no comments,
  // which is what the ingest gate requires a PR workspace to have established.
  ledger.setPriorThreads('stuck-dec', []);
  ledger.ingestRound('stuck-dec', [mkFinding({ title: 'D1', locus: 'pr:11:a.ts:L1' })]);
  const fp = ledger.loadLedger('stuck-dec').findings[0].fp;

  ledger.setFindingDecision('stuck-dec', fp, 'approve');
  ledger.setFindingPending('stuck-dec', [fp], 'post');
  ledger.clearFindingPending('stuck-dec', [fp]);

  const f = ledger.loadLedger('stuck-dec').findings[0];
  assert.equal(f.decision, 'approve', 'the triage decision survives the release');
  assert.equal(ledger.isPending(f), false);
});

test('clearFindingPending throws EUSER for an unknown fp', () => {
  ledger.createFeature({ id: 'stuck-unknown', title: 'Unknown', kind: 'pr-review' });
  // Not a duplicate-detection test: assert up front that this PR carries no comments,
  // which is what the ingest gate requires a PR workspace to have established.
  ledger.setPriorThreads('stuck-unknown', []);
  ledger.ingestRound('stuck-unknown', [mkFinding({ title: 'U1', locus: 'pr:12:a.ts:L1' })]);
  assert.throws(() => ledger.clearFindingPending('stuck-unknown', ['nope']), (e) => e.code === 'EUSER');
});

test('setFeatureReview records lastActivityAt/lastActivityBy independently of the responded flag', () => {
  ledger.createFeature({ id: 'stamps-ws', title: 'Stamps', kind: 'pr-review' });
  // Not a duplicate-detection test: assert up front that this PR carries no comments,
  // which is what the ingest gate requires a PR workspace to have established.
  ledger.setPriorThreads('stamps-ws', []);
  // stamp-only: no --responded equivalent, just "the PR moved at T, by X"
  ledger.setFeatureReview('stamps-ws', { lastActivityAt: '2026-08-17T09:42:11Z', lastActivityBy: 'Oriol Puig' });
  let rev = ledger.getFeature('stamps-ws').review;
  assert.equal(rev.lastActivityAt, '2026-08-17T09:42:11Z');
  assert.equal(rev.lastActivityBy, 'Oriol Puig');
  assert.equal(rev.authorRespondedAt, null, 'stamping activity must not imply the responded flag');

  // a later update overwrites the stamp without touching the rest
  ledger.setFeatureReview('stamps-ws', { lastActivityAt: '2026-08-17T11:00:00Z' });
  rev = ledger.getFeature('stamps-ws').review;
  assert.equal(rev.lastActivityAt, '2026-08-17T11:00:00Z');
  assert.equal(rev.lastActivityBy, 'Oriol Puig', 'unspecified fields stay put');
});

test('reviewStamps pairs the two clocks and derives newSinceReview', () => {
  const feature = { review: { lastActivityAt: '2026-08-17T10:00:00Z', lastActivityBy: 'Oriol', lastPostedAt: '2026-08-16T08:00:00Z' } };

  // their update is newer than our last round → a re-review would see something
  let s = ledger.reviewStamps(feature, '2026-08-17T09:00:00Z');
  assert.equal(s.lastReviewedAt, '2026-08-17T09:00:00Z');
  assert.equal(s.lastActivityAt, '2026-08-17T10:00:00Z');
  assert.equal(s.lastActivityBy, 'Oriol');
  assert.equal(s.lastPostedAt, '2026-08-16T08:00:00Z');
  assert.equal(s.newSinceReview, true);

  // we reviewed after their update → nothing new
  s = ledger.reviewStamps(feature, '2026-08-17T12:00:00Z');
  assert.equal(s.newSinceReview, false);

  // never reviewed but the PR has activity → still "new"
  assert.equal(ledger.reviewStamps(feature, null).newSinceReview, true);

  // compared by parsed time, not string order: a +02:00 stamp is EARLIER than the 09:00Z round
  assert.equal(
    ledger.reviewStamps({ review: { lastActivityAt: '2026-08-17T10:30:00+02:00' } }, '2026-08-17T09:00:00Z').newSinceReview,
    false, 'offsets must be parsed, not string-compared');

  // no activity recorded at all → nothing new, no crash
  const bare = ledger.reviewStamps({}, '2026-08-17T09:00:00Z');
  assert.equal(bare.newSinceReview, false);
  assert.equal(bare.lastActivityAt, null);
});

test('addRequest supports the poll (manual refresh) action + optional kind scope', () => {
  const both = ledger.addRequest({ action: 'poll' });
  assert.equal(both.action, 'poll');
  assert.equal(both.kind, null, 'no kind = both PR sections');
  assert.equal(both.prId, null);
  assert.equal(both.wsId, null);

  const scoped = ledger.addRequest({ action: 'poll', kind: 'pr-respond', title: 'Refresh PR Respond' });
  assert.equal(scoped.kind, 'pr-respond');

  assert.throws(() => ledger.addRequest({ action: 'poll', kind: 'spec' }), (e) => e.code === 'EUSER');
  assert.throws(() => ledger.addRequest({ action: 'poll', kind: 'nonsense' }), (e) => e.code === 'EUSER');
});

test('setFeatureStatus: marks done, reopens, validates the enum', () => {
  ledger.createFeature({ id: 'lifecycle', title: 'Lifecycle', kind: 'pr-review' });
  // Not a duplicate-detection test: assert up front that this PR carries no comments,
  // which is what the ingest gate requires a PR workspace to have established.
  ledger.setPriorThreads('lifecycle', []);
  assert.equal(ledger.getFeature('lifecycle').status, 'draft');
  assert.equal(ledger.setFeatureStatus('lifecycle', 'done').status, 'done');
  assert.equal(ledger.getFeature('lifecycle').status, 'done');
  assert.equal(ledger.setFeatureStatus('lifecycle', 'reworking').status, 'reworking');
  assert.throws(() => ledger.setFeatureStatus('lifecycle', 'nonsense'), (e) => e.code === 'EUSER');
});

test('readiness math: 2 blockers + 1 major → 25 penalty → score 38, not-ready', () => {
  ledger.createFeature({ id: 'score', title: 'Score' });
  ledger.ingestRound('score', [
    mkFinding({ title: 'B1', locus: '1', severity: 'blocker' }),
    mkFinding({ title: 'B2', locus: '2', severity: 'blocker' }),
    mkFinding({ title: 'M1', locus: '3', severity: 'major' }),
  ]);
  const r = ledger.readiness('score');
  assert.equal(r.score, 38);
  assert.equal(r.gate, 'not-ready');
  assert.deepEqual(r.openBySeverity, { blocker: 2, major: 1, minor: 0, info: 0 });
  assert.equal(r.openCount, 3);
  assert.equal(r.blockers.length, 2);
});

test('readiness gates: zero open → 100/ready; minors straddle the threshold', () => {
  ledger.createFeature({ id: 'clean', title: 'Clean' });
  ledger.ingestRound('clean', []);
  const clean = ledger.readiness('clean');
  assert.equal(clean.score, 100);
  assert.equal(clean.gate, 'ready');

  // 3 minors → penalty 6 → score 85 → ready (>= threshold, no blockers)
  ledger.createFeature({ id: 'minors', title: 'Minors' });
  ledger.ingestRound('minors', [1, 2, 3].map((i) => mkFinding({ title: `m${i}`, locus: `${i}`, severity: 'minor' })));
  assert.deepEqual(
    [ledger.readiness('minors').score, ledger.readiness('minors').gate],
    [85, 'ready']
  );

  // 4th minor → penalty 8 → score 80 → in-progress
  ledger.ingestRound('minors', [1, 2, 3, 4].map((i) => mkFinding({ title: `m${i}`, locus: `${i}`, severity: 'minor' })));
  assert.deepEqual(
    [ledger.readiness('minors').score, ledger.readiness('minors').gate],
    [80, 'in-progress']
  );
});

test('rounds file records stats and readiness snapshot per round', () => {
  const rounds = ledger.loadRounds('ing');
  assert.ok(rounds.rounds.length >= 5);
  const r1 = rounds.rounds[0];
  assert.equal(r1.n, 1);
  assert.equal(r1.stats.new, 2);
  assert.ok(r1.readiness && typeof r1.readiness.score === 'number');
  assert.ok(r1.readiness.openBySeverity);
  assert.ok(rounds.rounds.every((r, i) => r.n === i + 1), 'round numbers are sequential');
  // empty-shape contract for unknown features
  assert.deepEqual(ledger.loadLedger('ghost'), { featureId: 'ghost', findings: [] });
  assert.deepEqual(ledger.loadRounds('ghost'), { featureId: 'ghost', rounds: [] });
});

test('setCoverage validates statuses and persists into the feature', () => {
  assert.throws(
    () => ledger.setCoverage('checkout-redesign', [{ sectionKey: 'x', status: 'maybe' }]),
    (e) => e.code === 'EUSER'
  );
  const cov = [
    { sectionKey: 'flow-payment', adoIds: [42695], figmaNodeIds: ['1:23'], status: 'covered' },
    { sectionKey: null, adoIds: [99], figmaNodeIds: [], status: 'orphan' },
  ];
  const f = ledger.setCoverage('checkout-redesign', cov);
  assert.deepEqual(f.coverage, cov);
  assert.deepEqual(ledger.getFeature('checkout-redesign').coverage, cov);
});

test('setFindingDetails refines text + severity, keeps fingerprint stable, logs history', () => {
  ledger.createFeature({ id: 'refine-me', title: 'Refine' });
  ledger.ingestRound('refine-me', [mkFinding()], {});
  const fp = ledger.fingerprint('refine-me', 'consistency', 'Spec and ADO disagree on payment methods', 'confluence:1#flow vs ado:42695');

  const updated = ledger.setFindingDetails('refine-me', fp, {
    detail: 'Refined detail.', suggestion: 'Refined suggestion.', severity: 'blocker', note: 'sharpened',
  });
  assert.equal(updated.fp, fp, 'fingerprint must not change');
  assert.equal(updated.title, 'Spec and ADO disagree on payment methods', 'title (identity) untouched');
  assert.equal(updated.detail, 'Refined detail.');
  assert.equal(updated.suggestion, 'Refined suggestion.');
  assert.equal(updated.severity, 'blocker');
  const last = updated.history[updated.history.length - 1];
  assert.equal(last.note, 'sharpened');
  assert.equal(last.from, last.to, 'refinement is not a status transition');

  // re-audit with the ORIGINAL finding still reconciles to the same record (identity held)
  const before = ledger.loadLedger('refine-me').findings.length;
  ledger.ingestRound('refine-me', [mkFinding()], {});
  assert.equal(ledger.loadLedger('refine-me').findings.length, before, 'no duplicate created');

  assert.throws(() => ledger.setFindingDetails('refine-me', fp, { severity: 'huge' }), /invalid severity/);
  assert.throws(() => ledger.setFindingDetails('refine-me', fp, {}), /nothing to refine/);
});

test('setFindingDraft sets a draft, logs history, keeps fingerprint stable', () => {
  ledger.createFeature({ id: 'draft-me', title: 'Draft' });
  ledger.ingestRound('draft-me', [mkFinding()], {});
  const fp = ledger.fingerprint('draft-me', 'consistency', 'Spec and ADO disagree on payment methods', 'confluence:1#flow vs ado:42695');

  const before = ledger.loadLedger('draft-me').findings.find((f) => f.fp === fp);
  const histLen = before.history.length;

  const updated = ledger.setFindingDraft('draft-me', fp, {
    target: 'Spec › Payment methods', format: 'markdown',
    before: 'card\nPayPal', after: 'card\nPayPal\nTwint',
  });
  assert.equal(updated.fp, fp, 'fingerprint must not change');
  assert.ok(updated.draft, 'draft is set');
  assert.equal(updated.draft.target, 'Spec › Payment methods');
  assert.equal(updated.draft.format, 'markdown');
  assert.equal(updated.draft.before, 'card\nPayPal');
  assert.equal(updated.draft.after, 'card\nPayPal\nTwint');
  assert.ok(updated.draft.updatedAt, 'draft carries updatedAt');
  assert.equal(updated.history.length, histLen + 1, 'history entry appended');
  assert.equal(updated.history.at(-1).note, 'drafted change');
  assert.equal(updated.history.at(-1).from, updated.history.at(-1).to, 'drafting is not a status transition');

  // persisted to disk
  const reread = ledger.loadLedger('draft-me').findings.find((f) => f.fp === fp);
  assert.equal(reread.draft.after, 'card\nPayPal\nTwint');

  // re-audit with the ORIGINAL finding still reconciles to the same record (identity held)
  const count = ledger.loadLedger('draft-me').findings.length;
  ledger.ingestRound('draft-me', [mkFinding()], {});
  assert.equal(ledger.loadLedger('draft-me').findings.length, count, 'no duplicate created');
});

test('setFindingDraft validates before/after and format; clearFindingDraft removes it', () => {
  const fp = ledger.fingerprint('draft-me', 'consistency', 'Spec and ADO disagree on payment methods', 'confluence:1#flow vs ado:42695');
  assert.throws(() => ledger.setFindingDraft('draft-me', fp, { before: 'x' }), (e) => e.code === 'EUSER');
  assert.throws(() => ledger.setFindingDraft('draft-me', fp, { before: 'x', after: 'y', format: 'rtf' }), /invalid draft format/);
  assert.throws(() => ledger.setFindingDraft('draft-me', 'ffffffffff', { before: 'x', after: 'y' }), (e) => e.code === 'EUSER');

  // target defaults to the finding's locus when omitted
  const noTarget = ledger.setFindingDraft('draft-me', fp, { before: 'a', after: 'b' });
  assert.equal(noTarget.draft.target, 'confluence:1#flow vs ado:42695');
  assert.equal(noTarget.draft.format, 'text', 'format defaults to text');

  const histLen = ledger.loadLedger('draft-me').findings.find((f) => f.fp === fp).history.length;
  const cleared = ledger.clearFindingDraft('draft-me', fp);
  assert.equal(cleared.draft, undefined, 'draft removed');
  assert.equal(cleared.history.length, histLen + 1, 'clear logs history');
  assert.equal(cleared.history.at(-1).note, 'cleared draft');

  // clearing again is a no-op (no extra history)
  const again = ledger.clearFindingDraft('draft-me', fp);
  assert.equal(again.history.length, histLen + 1, 'no-op clear adds no history');
  assert.throws(() => ledger.clearFindingDraft('draft-me', 'ffffffffff'), (e) => e.code === 'EUSER');
});

test('setFindingDraft stores + normalizes + validates targetRef; re-drafting text keeps it', () => {
  const fp = ledger.fingerprint('draft-me', 'consistency', 'Spec and ADO disagree on payment methods', 'confluence:1#flow vs ado:42695');

  // ADO target (adoId number + field reference name + optional label)
  const ado = ledger.setFindingDraft('draft-me', fp, {
    before: 'a', after: 'b',
    targetRef: { system: 'ado', adoId: 42695, field: 'Microsoft.VSTS.Common.AcceptanceCriteria', label: 'AC', junk: 'dropped' },
  });
  assert.deepEqual(ado.draft.targetRef, {
    system: 'ado', adoId: 42695, field: 'Microsoft.VSTS.Common.AcceptanceCriteria', label: 'AC',
  }, 'unknown keys dropped, known kept');

  // Confluence target — version coerced to a number
  const conf = ledger.setFindingDraft('draft-me', fp, {
    before: 'a', after: 'b',
    targetRef: { system: 'confluence', pageId: '123', anchor: 'flow', version: '14' },
  });
  assert.deepEqual(conf.draft.targetRef, { system: 'confluence', pageId: '123', anchor: 'flow', version: 14 });

  // re-drafting the text only preserves the prior machine target
  const again = ledger.setFindingDraft('draft-me', fp, { before: 'a', after: 'c' });
  assert.deepEqual(again.draft.targetRef, { system: 'confluence', pageId: '123', anchor: 'flow', version: 14 });
  assert.equal(again.draft.after, 'c');

  // validation
  assert.throws(() => ledger.setFindingDraft('draft-me', fp, { before: 'a', after: 'b', targetRef: 'nope' }), /targetRef must be an object/);
  assert.throws(() => ledger.setFindingDraft('draft-me', fp, { before: 'a', after: 'b', targetRef: { system: 'jira' } }), /targetRef.system must be one of/);
  assert.throws(() => ledger.setFindingDraft('draft-me', fp, { before: 'a', after: 'b', targetRef: { system: 'ado' } }), /requires "adoId"/);
  assert.throws(() => ledger.setFindingDraft('draft-me', fp, { before: 'a', after: 'b', targetRef: { system: 'confluence' } }), /requires "pageId"/);
  assert.throws(() => ledger.setFindingDraft('draft-me', fp, { before: 'a', after: 'b', targetRef: { system: 'confluence', pageId: '1', version: 'x' } }), /version must be a number/);

  ledger.clearFindingDraft('draft-me', fp); // reset for later draft tests on this finding
});

test('setDraftReview records hunk decisions, merges, clears, stays identity-stable', () => {
  const fp = ledger.fingerprint('draft-me', 'consistency', 'Spec and ADO disagree on payment methods', 'confluence:1#flow vs ado:42695');
  ledger.setFindingDraft('draft-me', fp, { before: 'a\nb\nc', after: 'a\nB\nc\nd' });
  const before = ledger.loadLedger('draft-me').findings.find((f) => f.fp === fp);
  const histLen = before.history.length;

  // single-hunk patch
  const r1 = ledger.setDraftReview('draft-me', fp, { hunk: 0, status: 'accepted' });
  assert.equal(r1.fp, fp, 'fingerprint must not change');
  assert.equal(r1.draft.review.hunks['0'].status, 'accepted');
  assert.ok(r1.draft.review.hunks['0'].at, 'hunk decision carries a timestamp');
  assert.ok(r1.draft.review.updatedAt, 'review carries updatedAt');
  assert.equal(r1.history.length, histLen + 1, 'history entry appended');
  assert.equal(r1.history.at(-1).note, 'reviewed draft');
  assert.equal(r1.history.at(-1).from, r1.history.at(-1).to, 'reviewing is not a status transition');

  // merge: a second hunk decision keeps the first
  const r2 = ledger.setDraftReview('draft-me', fp, { hunk: 1, status: 'edited', editedText: 'X' });
  assert.equal(r2.draft.review.hunks['0'].status, 'accepted', 'prior hunk preserved on merge');
  assert.equal(r2.draft.review.hunks['1'].status, 'edited');
  assert.equal(r2.draft.review.hunks['1'].editedText, 'X');

  // full review object also merges
  const r3 = ledger.setDraftReview('draft-me', fp, { hunks: { 2: { status: 'rejected' } } });
  assert.equal(r3.draft.review.hunks['0'].status, 'accepted');
  assert.equal(r3.draft.review.hunks['2'].status, 'rejected');

  // 'undecided' clears that hunk's decision, others remain
  const r4 = ledger.setDraftReview('draft-me', fp, { hunk: 0, status: 'undecided' });
  assert.equal(r4.draft.review.hunks['0'], undefined, 'undecided removes the hunk decision');
  assert.equal(r4.draft.review.hunks['1'].status, 'edited', 'other decisions remain');

  // accepting drops any prior editedText (decisions are mutually exclusive)
  const r5 = ledger.setDraftReview('draft-me', fp, { hunk: 1, status: 'accepted' });
  assert.equal(r5.draft.review.hunks['1'].status, 'accepted');
  assert.equal(r5.draft.review.hunks['1'].editedText, undefined, 'accept clears editedText');

  // persisted to disk
  const reread = ledger.loadLedger('draft-me').findings.find((f) => f.fp === fp);
  assert.equal(reread.draft.review.hunks['2'].status, 'rejected');

  // identity held across a re-audit with the original finding
  const count = ledger.loadLedger('draft-me').findings.length;
  ledger.ingestRound('draft-me', [mkFinding()], {});
  assert.equal(ledger.loadLedger('draft-me').findings.length, count, 'no duplicate created');
});

test('setDraftReview validation: enum, edited text, shape, missing draft/finding', () => {
  const fp = ledger.fingerprint('draft-me', 'consistency', 'Spec and ADO disagree on payment methods', 'confluence:1#flow vs ado:42695');
  assert.throws(() => ledger.setDraftReview('draft-me', fp, { hunk: 0, status: 'bogus' }), /invalid hunk status/);
  assert.throws(() => ledger.setDraftReview('draft-me', fp, { hunk: 0, status: 'edited', editedText: 123 }), (e) => e.code === 'EUSER');
  assert.throws(() => ledger.setDraftReview('draft-me', fp, { hunk: 0, status: 'edited' }), /edited hunk requires editedText/);
  assert.throws(() => ledger.setDraftReview('draft-me', fp, {}), (e) => e.code === 'EUSER');
  assert.throws(() => ledger.setDraftReview('draft-me', 'ffffffffff', { hunk: 0, status: 'accepted' }), (e) => e.code === 'EUSER');

  // empty-string editedText is allowed (means "delete the shown lines")
  const ok = ledger.setDraftReview('draft-me', fp, { hunk: 5, status: 'edited', editedText: '' });
  assert.equal(ok.draft.review.hunks['5'].editedText, '');

  // a finding with no draft cannot be reviewed
  const noDraft = mkFinding({ title: 'No draft on this one', locus: 'x:99' });
  ledger.ingestRound('draft-me', [mkFinding(), noDraft], {});
  const ofp = ledger.fingerprint('draft-me', 'consistency', 'No draft on this one', 'x:99');
  assert.throws(() => ledger.setDraftReview('draft-me', ofp, { hunk: 0, status: 'accepted' }), /no draft/);
});

test('setDraftReview persists finding-level note + verdict, merges with hunks, defaults', () => {
  ledger.createFeature({ id: 'note-me', title: 'Note' });
  ledger.ingestRound('note-me', [mkFinding()], {});
  const fp = ledger.fingerprint('note-me', 'consistency', 'Spec and ADO disagree on payment methods', 'confluence:1#flow vs ado:42695');
  ledger.setFindingDraft('note-me', fp, { before: 'a\nb\nc', after: 'a\nB\nc\nd' });
  const histLen = ledger.loadLedger('note-me').findings.find((f) => f.fp === fp).history.length;

  // a pure note/verdict counter-proposal (no hunk patch) persists both fields
  const r1 = ledger.setDraftReview('note-me', fp, { note: 'put these in systemProperties', verdict: 'redirect' });
  assert.equal(r1.fp, fp, 'fingerprint must not change');
  assert.equal(r1.draft.review.note, 'put these in systemProperties');
  assert.equal(r1.draft.review.verdict, 'redirect');
  assert.deepEqual(r1.draft.review.hunks, {}, 'hunks default to empty without a patch');
  assert.equal(r1.history.at(-1).note, 'reviewer note', 'pure note/verdict logs "reviewer note"');
  assert.equal(r1.history.length, histLen + 1, 'one history entry appended');
  assert.equal(r1.history.at(-1).from, r1.history.at(-1).to, 'a note is not a status transition');

  // a later hunk patch MERGES — it keeps the note + verdict
  const r2 = ledger.setDraftReview('note-me', fp, { hunk: 0, status: 'accepted' });
  assert.equal(r2.draft.review.hunks['0'].status, 'accepted');
  assert.equal(r2.draft.review.note, 'put these in systemProperties', 'note preserved across a hunk patch');
  assert.equal(r2.draft.review.verdict, 'redirect', 'verdict preserved across a hunk patch');
  assert.equal(r2.history.at(-1).note, 'reviewed draft', 'a hunk patch logs "reviewed draft"');

  // changing only the verdict keeps the note and the hunk decisions
  const r3 = ledger.setDraftReview('note-me', fp, { verdict: 'reject' });
  assert.equal(r3.draft.review.verdict, 'reject');
  assert.equal(r3.draft.review.note, 'put these in systemProperties', 'note preserved when only verdict changes');
  assert.equal(r3.draft.review.hunks['0'].status, 'accepted', 'hunk decision preserved');

  // null/empty clears: note '' and verdict back to 'proposed'
  const r4 = ledger.setDraftReview('note-me', fp, { note: '', verdict: null });
  assert.equal(r4.draft.review.note, '');
  assert.equal(r4.draft.review.verdict, 'proposed', 'null verdict resets to the default');

  // persisted to disk
  const reread = ledger.loadLedger('note-me').findings.find((f) => f.fp === fp);
  assert.equal(reread.draft.review.verdict, 'proposed');
  assert.equal(reread.draft.review.hunks['0'].status, 'accepted');

  // identity held across a re-audit
  const count = ledger.loadLedger('note-me').findings.length;
  ledger.ingestRound('note-me', [mkFinding()], {});
  assert.equal(ledger.loadLedger('note-me').findings.length, count, 'no duplicate created');
});

test('setDraftReview validates the verdict enum and note type', () => {
  const fp = ledger.fingerprint('note-me', 'consistency', 'Spec and ADO disagree on payment methods', 'confluence:1#flow vs ado:42695');
  assert.throws(() => ledger.setDraftReview('note-me', fp, { verdict: 'bogus' }), /invalid verdict/);
  assert.throws(() => ledger.setDraftReview('note-me', fp, { note: 123 }), /note must be a string/);
  // an empty review object (no hunks, no note, no verdict) is still rejected
  assert.throws(() => ledger.setDraftReview('note-me', fp, {}), (e) => e.code === 'EUSER');
});

// ---------- requests (UI-triggered job queue) ----------

test('addRequest: validates action enum and action-specific required fields', () => {
  // bad action
  assert.throws(() => ledger.addRequest({ action: 'nope', prId: '1' }), (e) => e.code === 'EUSER');
  // pr-review / pr-respond require prId
  assert.throws(() => ledger.addRequest({ action: 'pr-review' }), /requires "prId"/);
  assert.throws(() => ledger.addRequest({ action: 'pr-respond', prId: '' }), /requires "prId"/);
  // apply requires wsId
  assert.throws(() => ledger.addRequest({ action: 'apply' }), /requires "wsId"/);

  const r = ledger.addRequest({ action: 'pr-review', prId: '1481', title: 'Checkout PR' });
  assert.equal(r.action, 'pr-review');
  assert.equal(r.prId, '1481');
  assert.equal(r.wsId, null);
  assert.equal(r.title, 'Checkout PR');
  assert.equal(r.status, 'queued');
  assert.equal(r.note, null);
  assert.ok(r.createdAt && r.updatedAt);
});

test('addRequest: stores optional instructions (trimmed), defaults null, rejects non-string', () => {
  // omitted → null
  const none = ledger.addRequest({ action: 'pr-review', prId: '7000' });
  assert.equal(none.instructions, null);
  // blank/whitespace → null
  const blank = ledger.addRequest({ action: 'pr-review', prId: '7001', instructions: '   ' });
  assert.equal(blank.instructions, null);
  // present → trimmed and stored, surviving a reload
  const r = ledger.addRequest({ action: 'pr-review', prId: '7002', instructions: '  front-end only  ' });
  assert.equal(r.instructions, 'front-end only');
  const reloaded = ledger.listRequests().find((x) => x.id === r.id);
  assert.equal(reloaded.instructions, 'front-end only');
  // non-string → EUSER
  assert.throws(() => ledger.addRequest({ action: 'pr-review', prId: '7003', instructions: 42 }),
    /instructions must be a string/);
});

test('addRequest: ids increment monotonically from a stored counter (no clock)', () => {
  // continues from the request created in the previous test → req-2, req-3, …
  const a = ledger.addRequest({ action: 'pr-respond', prId: '99' });
  const b = ledger.addRequest({ action: 'apply', wsId: 'pr-99-respond' });
  assert.match(a.id, /^req-\d+$/);
  assert.match(b.id, /^req-\d+$/);
  const an = Number(a.id.slice(4));
  const bn = Number(b.id.slice(4));
  assert.equal(bn, an + 1, 'ids increment by one');

  // counter survives a reload and is not reused after entries are present
  const doc = ledger.loadRequests();
  assert.equal(doc.counter, bn);
  const c = ledger.addRequest({ action: 'apply', wsId: 'x' });
  assert.equal(Number(c.id.slice(4)), bn + 1);
});

test('addRequest: re-audit is a valid action and requires wsId', () => {
  assert.ok(ledger.REQUEST_ACTIONS.includes('re-audit'));
  assert.throws(() => ledger.addRequest({ action: 're-audit' }), /re-audit requires "wsId"/);
  const r = ledger.addRequest({ action: 're-audit', wsId: 'checkout-redesign', instructions: 'recheck redirected' });
  assert.equal(r.action, 're-audit');
  assert.equal(r.wsId, 'checkout-redesign');
  assert.equal(r.instructions, 'recheck redirected');
  assert.equal(r.status, 'queued');
});

test('addRequest: audit is a valid action and requires instructions (the source URLs)', () => {
  assert.ok(ledger.REQUEST_ACTIONS.includes('audit'));
  assert.throws(() => ledger.addRequest({ action: 'audit' }), /audit requires "instructions"/);
  assert.throws(() => ledger.addRequest({ action: 'audit', instructions: '   ' }), /audit requires "instructions"/);
  const r = ledger.addRequest({
    action: 'audit',
    title: 'Checkout redesign',
    instructions: 'https://uniccom.atlassian.net/wiki/x/abc\nhttps://dev.azure.com/FZAG/_workitems/edit/42695',
  });
  assert.equal(r.action, 'audit');
  assert.equal(r.prId, null);
  assert.equal(r.wsId, null);
  assert.equal(r.title, 'Checkout redesign');
  assert.match(r.instructions, /atlassian|azure/);
  assert.equal(r.status, 'queued');
});

test('listRequests: returns all, filters by status, validates the status enum', () => {
  const all = ledger.listRequests();
  assert.ok(all.length >= 4);
  const queued = ledger.listRequests({ status: 'queued' });
  assert.ok(queued.every((r) => r.status === 'queued'));
  assert.equal(queued.length, all.length, 'everything starts queued');
  assert.equal(ledger.listRequests({ status: 'done' }).length, 0);
  assert.throws(() => ledger.listRequests({ status: 'bogus' }), (e) => e.code === 'EUSER');
});

test('setRequestStatus: transitions, merges note/wsId, bumps updatedAt, validates', () => {
  const r = ledger.addRequest({ action: 'pr-review', prId: '2025' });
  const before = r.updatedAt;

  const running = ledger.setRequestStatus(r.id, { status: 'running' });
  assert.equal(running.status, 'running');
  assert.ok(running.updatedAt >= before);

  // runner attaches the workspace it created + marks done
  const done = ledger.setRequestStatus(r.id, { status: 'done', wsId: 'pr-2025-review' });
  assert.equal(done.status, 'done');
  assert.equal(done.wsId, 'pr-2025-review');

  // error carries a note
  const errored = ledger.setRequestStatus(r.id, { status: 'error', note: 'PR not found' });
  assert.equal(errored.status, 'error');
  assert.equal(errored.note, 'PR not found');

  // bad status + unknown id
  assert.throws(() => ledger.setRequestStatus(r.id, { status: 'bogus' }), (e) => e.code === 'EUSER');
  assert.throws(() => ledger.setRequestStatus('req-does-not-exist', { status: 'done' }), /not found/);

  // persisted to disk
  const reread = ledger.loadRequests().requests.find((x) => x.id === r.id);
  assert.equal(reread.status, 'error');
  assert.equal(reread.wsId, 'pr-2025-review');
});

test('addRequest: defaults phase=null and needsInput=false', () => {
  const r = ledger.addRequest({ action: 'pr-review', prId: '3001' });
  assert.equal(r.phase, null);
  assert.equal(r.needsInput, false);
});

test('setRequestStatus: merges phase + needsInput without clobbering other fields', () => {
  const r = ledger.addRequest({ action: 'pr-review', prId: '3002' });

  // flag a 2FA wait: phase + needsInput + instruction note, status unchanged from queued
  const waiting = ledger.setRequestStatus(r.id, {
    status: 'running',
    phase: 'fetching PR #3002 (may need your approval)',
    needsInput: true,
    note: 'Approve the auth prompt in your other window.',
  });
  assert.equal(waiting.status, 'running');
  assert.equal(waiting.phase, 'fetching PR #3002 (may need your approval)');
  assert.equal(waiting.needsInput, true);
  assert.equal(waiting.note, 'Approve the auth prompt in your other window.');

  // advancing the phase + clearing needsInput leaves the note untouched (merge, not clobber)
  const advanced = ledger.setRequestStatus(r.id, { phase: 'reviewing changes', needsInput: false });
  assert.equal(advanced.phase, 'reviewing changes');
  assert.equal(advanced.needsInput, false);
  assert.equal(advanced.note, 'Approve the auth prompt in your other window.');
  assert.equal(advanced.status, 'running', 'status untouched when not specified');

  // empty-string phase clears it back to null
  const cleared = ledger.setRequestStatus(r.id, { phase: '' });
  assert.equal(cleared.phase, null);
});

test('setRequestStatus: a terminal status clears needsInput', () => {
  const r = ledger.addRequest({ action: 'pr-respond', prId: '3003' });
  ledger.setRequestStatus(r.id, { status: 'running', needsInput: true, note: 'approve auth' });
  const done = ledger.setRequestStatus(r.id, { status: 'done', wsId: 'pr-3003-respond' });
  assert.equal(done.needsInput, false, 'done is never still waiting on the user');

  const r2 = ledger.addRequest({ action: 'pr-review', prId: '3004' });
  ledger.setRequestStatus(r2.id, { status: 'running', needsInput: true });
  const errored = ledger.setRequestStatus(r2.id, { status: 'error', note: 'timed out' });
  assert.equal(errored.needsInput, false);
});

// ---------- delete ----------

test('deleteFeature removes all three files and returns { id, deleted: true }', () => {
  const id = 'del-test-feature';
  ledger.createFeature({ id, title: 'Delete me' });
  ledger.ingestRound(id, [
    mkFinding({ title: 'Finding to delete', locus: 'del:1' }),
  ], { note: 'seed' });

  const result = ledger.deleteFeature(id);
  assert.deepEqual(result, { id, deleted: true, cancelledRequests: [] });

  assert.ok(!fs.existsSync(path.join(tmpDir, 'features', `${id}.json`)), 'feature file must be gone');
  assert.ok(!fs.existsSync(path.join(tmpDir, 'ledger', `${id}.json`)), 'ledger file must be gone');
  assert.ok(!fs.existsSync(path.join(tmpDir, 'rounds', `${id}.json`)), 'rounds file must be gone');

  assert.throws(() => ledger.getFeature(id), (e) => e.code === 'EUSER');
});

test('deleteFeature throws EUSER for a missing feature', () => {
  assert.throws(() => ledger.deleteFeature('does-not-exist-del'), (e) => e.code === 'EUSER');
});

test('deleteFeature ignores missing ledger/rounds files (feature with no rounds)', () => {
  const id = 'del-bare-feature';
  ledger.createFeature({ id, title: 'No rounds' });
  const result = ledger.deleteFeature(id);
  assert.deepEqual(result, { id, deleted: true, cancelledRequests: [] });
});

test('deleteRequest removes the request and returns { id, deleted: true }', () => {
  const r = ledger.addRequest({ action: 'pr-review', prId: '9999' });
  const result = ledger.deleteRequest(r.id);
  assert.deepEqual(result, { id: r.id, deleted: true });
  assert.ok(!ledger.listRequests().some((x) => x.id === r.id), 'request must be gone from the list');
});

test('deleteRequest throws EUSER for an unknown id', () => {
  assert.throws(() => ledger.deleteRequest('req-nope-xyz'), (e) => e.code === 'EUSER');
});

// ---------- decisionOf / workspaceState (the canonical per-workspace state) ----------

let fpSeq = 0;
// A finding as it sits ON DISK — these two functions read persisted shape only, so the fixtures
// are plain objects rather than round-tripped ledger writes. That is the point: the rules must
// hold for any finding the cockpit can load, including ones written by an older build.
function f(over = {}) {
  fpSeq += 1;
  return { fp: `fp-${fpSeq}`, status: 'open', suggestion: 'Say something about this.', ...over };
}
function withHunks(hunks, over = {}) {
  return f({ draft: { before: 'a', after: 'b', review: { hunks, note: '', verdict: 'proposed' } }, ...over });
}

test('decisionOf: a waived finding reads as waived whatever else is on it', () => {
  assert.equal(ledger.decisionOf(f({ status: 'waived' })), 'waive');
  // the waive outranks a stored decision AND a draft verdict
  assert.equal(ledger.decisionOf(withHunks({}, { status: 'waived', decision: 'approve' })), 'waive');
});

test('decisionOf: a stored finding-level decision passes straight through', () => {
  assert.equal(ledger.decisionOf(f({ decision: 'approve' })), 'approve');
  assert.equal(ledger.decisionOf(f({ decision: 'edit' })), 'edit');
  assert.equal(ledger.decisionOf(f({ decision: 'fix-only' })), 'fix-only');
});

test('decisionOf: nothing decided reads as null', () => {
  assert.equal(ledger.decisionOf(f()), null, 'a bare open finding is undecided');
  assert.equal(ledger.decisionOf(f({ draft: { before: 'a', after: 'b' } })), null, 'a draft nobody reviewed');
  assert.equal(ledger.decisionOf(withHunks({})), null, 'a review with no hunk decisions at all');
  assert.equal(ledger.decisionOf(null), null);
});

test('decisionOf: redirect and reject verdicts are decisions in their own right', () => {
  const redirect = f({ draft: { before: 'a', after: 'b', review: { hunks: {}, verdict: 'redirect', note: 'elsewhere' } } });
  assert.equal(ledger.decisionOf(redirect), 'redirect');
  const reject = f({ draft: { before: 'a', after: 'b', review: { hunks: {}, verdict: 'reject', note: 'no' } } });
  assert.equal(ledger.decisionOf(reject), 'reject');
});

test('decisionOf: every hunk accepted → approve; any edited → edit; any rejected → undecided', () => {
  assert.equal(ledger.decisionOf(withHunks({ 0: { status: 'accepted' }, 1: { status: 'accepted' } })), 'approve');
  assert.equal(ledger.decisionOf(withHunks({ 0: { status: 'accepted' }, 1: { status: 'edited', editedText: 'x' } })), 'edit');
  assert.equal(ledger.decisionOf(withHunks({ 0: { status: 'edited', editedText: 'x' } })), 'edit');
  // A rejected hunk is not a finding-level decision — the reviewer still owes an answer on the rest.
  assert.equal(ledger.decisionOf(withHunks({ 0: { status: 'accepted' }, 1: { status: 'rejected' } })), null);
});

test('WORKSPACE_STATES is one ordered table covering all ten states in band order', () => {
  assert.equal(ledger.WORKSPACE_STATES.length, 10);
  assert.deepEqual(ledger.WORKSPACE_STATES.map((s) => s.state), [
    'ready-to-post', 'needs-review', 'needs-rereview', 'author-responded', 'needs-approval',
    'posting',
    'awaiting-author', 'awaiting-reaudit', 'settled',
    'done',
  ]);
  assert.deepEqual(ledger.WORKSPACE_STATES.map((s) => s.band), [
    'needs-you', 'needs-you', 'needs-you', 'needs-you', 'needs-you',
    'in-progress',
    'waiting', 'waiting', 'waiting',
    'done',
  ]);
  // Every state carries a label, and the bands appear in contiguous runs — a consumer that ranks
  // by index must get the band grouping for free, or it needs a second list and they will drift.
  for (const row of ledger.WORKSPACE_STATES) {
    assert.ok(row.label && typeof row.label === 'string', `${row.state} needs a label`);
  }
  const bandsInOrder = [...new Set(ledger.WORKSPACE_STATES.map((s) => s.band))];
  assert.deepEqual(bandsInOrder, ['needs-you', 'in-progress', 'waiting', 'done']);
  assert.equal(new Set(ledger.WORKSPACE_STATES.map((s) => s.state)).size, 10, 'no duplicate states');
});

test('workspaceState: open finding + suggestion, never posted → needs-review', () => {
  const feature = { status: 'draft', review: {} };
  assert.equal(ledger.workspaceState(feature, [f(), f(), f()], '2026-09-14T09:15:32.153Z'), 'needs-review');
});

test('workspaceState: a pending post outranks everything but done', () => {
  const feature = { status: 'draft', review: { lastPostedAt: '2026-09-01T00:00:00.000Z' } };
  const findings = [
    f({ status: 'reworking', decision: 'approve', pending: 'post' }),
    f({ status: 'reworking', decision: 'approve', pending: 'post' }),
  ];
  assert.equal(ledger.workspaceState(feature, findings, '2026-09-14T06:47:22.104Z'), 'posting');
});

test('workspaceState: posted + newer PR activity than our last round → author-responded', () => {
  const feature = { status: 'draft', review: { lastPostedAt: '2026-09-14T08:55:30.961Z', lastActivityAt: '2026-09-11T06:06:36.250Z' } };
  const findings = [f({ status: 'reworking', postedAt: '2026-09-14T08:55:30.961Z' })];
  assert.equal(ledger.workspaceState(feature, findings, '2026-09-11T05:29:24.744Z'), 'author-responded');
});

test('workspaceState: posted with no newer activity → awaiting-author', () => {
  const feature = { status: 'draft', review: { lastPostedAt: '2026-09-14T08:48:58.633Z', lastActivityAt: '2026-09-10T11:19:29.815Z' } };
  const findings = [f({ status: 'reworking', postedAt: '2026-09-14T08:48:58.633Z' })];
  assert.equal(ledger.workspaceState(feature, findings, '2026-09-11T05:26:08.980Z'), 'awaiting-author');
  // the explicit runner flag reaches the same conclusion as the clocks do
  const flagged = { ...feature, review: { ...feature.review, authorRespondedAt: '2026-09-12T00:00:00.000Z' } };
  assert.equal(ledger.workspaceState(flagged, findings, '2026-09-11T05:26:08.980Z'), 'author-responded');
});

test('workspaceState: resolved+posted history alongside open undecided drafts → needs-rereview', () => {
  const feature = { status: 'draft', review: { lastPostedAt: '2026-08-17T11:47:58.373Z', authorRespondedAt: '2026-09-02T13:43:09.797Z' } };
  const findings = [
    f({ status: 'resolved', postedAt: '2026-08-17T11:47:58.373Z', draft: { before: 'a', after: 'b' } }),
    f({ status: 'resolved', postedAt: '2026-08-17T11:47:58.373Z' }),
    f({ status: 'open', draft: { before: 'a', after: 'b' } }),
    f({ status: 'open' }),
  ];
  assert.equal(ledger.workspaceState(feature, findings, '2026-08-18T09:13:13.685Z'), 'needs-rereview');
});

test('workspaceState: a first round with no posting history anywhere → needs-review, not needs-rereview', () => {
  // Same undecided shape as above; the ONLY difference is that nothing has ever gone out.
  const findings = [f({ status: 'open', draft: { before: 'a', after: 'b' } })];
  assert.equal(ledger.workspaceState({ status: 'draft', review: {} }, findings, null), 'needs-review');
  // a per-finding postedAt is enough evidence on its own — a workspace can predate feature.review
  const withStamp = [...findings, f({ status: 'resolved', postedAt: '2026-08-01T00:00:00.000Z' })];
  assert.equal(ledger.workspaceState({ status: 'draft', review: {} }, withStamp, null), 'needs-rereview');
});

test('workspaceState: everything decided and nothing out yet → ready-to-post', () => {
  const feature = { status: 'draft', review: {} };
  const findings = [
    f({ decision: 'approve' }),
    withHunks({ 0: { status: 'accepted' } }),
    f({ status: 'waived' }),
    f({ status: 'resolved' }),                       // not reviewable, must not hold the state back
  ];
  assert.equal(ledger.workspaceState(feature, findings, null), 'ready-to-post');
});

test('workspaceState: applied spec changes with nothing left to triage → awaiting-reaudit', () => {
  const feature = { status: 'reworking', review: {} };
  const findings = [
    f({ status: 'reworking', appliedAt: '2026-09-10T00:00:00.000Z' }),
    f({ status: 'resolved' }),
  ];
  assert.equal(ledger.workspaceState(feature, findings, null), 'awaiting-reaudit');
});

test('workspaceState: nothing open, nothing out, not closed → settled', () => {
  const feature = { status: 'ready', review: {} };
  assert.equal(ledger.workspaceState(feature, [f({ status: 'resolved' }), f({ status: 'waived' })], null), 'settled');
  assert.equal(ledger.workspaceState(feature, [], null), 'settled', 'a workspace with no findings at all');
});

test('workspaceState: feature.status done wins over every other signal', () => {
  const feature = { status: 'done', review: { lastPostedAt: '2026-09-01T00:00:00.000Z', authorRespondedAt: '2026-09-02T00:00:00.000Z', lastActivityAt: '2026-09-30T00:00:00.000Z' } };
  const findings = [
    f({ status: 'open' }),                                          // would be needs-rereview
    f({ status: 'reworking', pending: 'post', decision: 'approve' }), // would be posting
    f({ status: 'reworking', postedAt: '2026-09-01T00:00:00.000Z' }), // would be author-responded
  ];
  assert.equal(ledger.workspaceState(feature, findings, '2026-09-01T00:00:00.000Z'), 'done');
});

test('workspaceState: a finding with neither draft nor suggestion is still not REVIEWABLE', () => {
  // isReviewable mirrors web/app.js's reviewableFindings(), which drives the stepper, so the
  // settled backstop must NOT have widened it. If it had, this bare finding would join the
  // reviewable set as undecided and drag the workspace back to needs-review.
  const bare = { fp: 'fp-bare', status: 'open', suggestion: '   ' };
  const feature = { status: 'draft', review: {} };
  assert.equal(ledger.workspaceState(feature, [f({ decision: 'approve' }), bare], null), 'ready-to-post');
});

test('workspaceState: a live finding with nothing attached never reads settled', () => {
  // The failure this whole state machine exists to prevent. `ingestFindings` defaults `suggestion`
  // to '', so an open finding with no draft and an empty suggestion is reachable through the
  // documented path — and it is invisible to isReviewable. Falling through to `settled` would draw
  // it in the "waiting on others" band while `counts.open` on the same row says there is open work.
  const feature = { status: 'draft', review: {} };
  const bare = { fp: 'fp-bare-1', status: 'open', suggestion: '' };
  assert.equal(ledger.workspaceState(feature, [bare], null), 'needs-review');
  // whitespace-only is the same nothing, and `reworking` is just as live as `open`
  assert.equal(ledger.workspaceState(feature, [{ fp: 'fp-bare-2', status: 'reworking', suggestion: '   ' }], null), 'needs-review');
});

test('workspaceState: the live-finding backstop takes the same everPosted split', () => {
  // Which pass the user is on still has to be said — a bare finding on a re-review round is a
  // second look, not a first one.
  const bare = { fp: 'fp-bare-3', status: 'open', suggestion: '' };
  const posted = { status: 'draft', review: { lastPostedAt: '2026-08-17T11:47:58.373Z' } };
  assert.equal(ledger.workspaceState(posted, [bare], null), 'needs-rereview');
  // per-finding evidence alone is enough, exactly as on the reviewable path
  const viaFinding = [bare, f({ status: 'resolved', postedAt: '2026-08-01T00:00:00.000Z' })];
  assert.equal(ledger.workspaceState({ status: 'draft', review: {} }, viaFinding, null), 'needs-rereview');
});

test('workspaceState: the backstop only catches LIVE findings, and outranks nothing above it', () => {
  // Posted / applied / pending / resolved findings are out of the reviewer's hands, so they must
  // keep reaching the states that already claim them — the guard sits last for exactly that reason.
  const feature = { status: 'ready', review: {} };
  assert.equal(ledger.workspaceState(feature, [f({ status: 'resolved' }), f({ status: 'waived' })], null), 'settled');
  assert.equal(ledger.workspaceState(feature, [], null), 'settled');
  const bare = (fp, over = {}) => ({ fp, status: 'reworking', suggestion: '', ...over });
  assert.equal(ledger.workspaceState(feature, [bare('b1', { appliedAt: '2026-09-10T00:00:00.000Z' })], null), 'awaiting-reaudit');
  assert.equal(ledger.workspaceState(feature, [bare('b2', { postedAt: '2026-09-10T00:00:00.000Z' })], null), 'awaiting-author');
  assert.equal(ledger.workspaceState(feature, [bare('b3', { pending: 'post' })], null), 'posting');
  assert.equal(ledger.workspaceState({ status: 'done', review: {} }, [bare('b4')], null), 'done');
});

/* ---- the workspace summary: written by the review skills, never by the app ---- */

test('setFeatureSummary: set, trim, clear — and "empty" is always null, never ""', () => {
  const id = 'summary-roundtrip';
  ledger.createFeature({ id, title: 'PR #1 — something', kind: 'pr-review' });
  assert.equal(ledger.getFeature(id).summary, null, 'a fresh workspace has no summary — nobody has written one');

  const set = ledger.setFeatureSummary(id, '  Adds per-language venue ids so the map POIs read in the visitor\'s language.  ');
  assert.equal(set.summary, "Adds per-language venue ids so the map POIs read in the visitor's language.");
  assert.equal(ledger.getFeature(id).summary, set.summary, 'and it survives the round trip to disk');

  // Both clears collapse to the same null the UI tests for, so "cleared" and "never written" are
  // one state rather than two that render differently.
  assert.equal(ledger.setFeatureSummary(id, '   ').summary, null);
  assert.equal(ledger.setFeatureSummary(id, 'again').summary, 'again');
  assert.equal(ledger.setFeatureSummary(id, null).summary, null);

  assert.throws(() => ledger.setFeatureSummary(id, { text: 'no' }), (e) => e.code === 'EUSER');
  assert.throws(() => ledger.setFeatureSummary('no-such-workspace', 'x'), (e) => e.code === 'EUSER');
});

test('normalizeFeature: a junk or missing summary reads as "none", not as content', () => {
  const id = 'summary-junk';
  ledger.createFeature({ id, title: 'x' });
  const file = path.join(tmpDir, 'features', `${id}.json`);
  for (const junk of [{ paragraphs: [] }, 42, '', '   ', [], null]) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.summary = junk;
    fs.writeFileSync(file, JSON.stringify(raw));
    assert.equal(ledger.getFeature(id).summary, null, `summary ${JSON.stringify(junk)} must read as none`);
  }
  // The field absent entirely — every workspace written before this existed.
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete raw.summary;
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.equal(ledger.getFeature(id).summary, null);
});

test('addSource: the Vertec phase rides the work item, and a blank one never erases a real one', () => {
  const id = 'vertec-source';
  ledger.createFeature({ id, title: 'PR #5882', kind: 'pr-review' });
  ledger.addSource(id, {
    type: 'ado', id: 43057, itemType: 'User Story', title: "Atrius 2.3 — The map reads in the visitor's language",
    url: 'https://dev.azure.com/FZAG/dxp/_workitems/edit/43057',
    vertecPhase: '  Maps Integration // 12. Atrius 2.3  ',
  });
  let [story] = ledger.getFeature(id).sources.ado;
  assert.equal(story.type, 'User Story', '--itemType still lands on the source as its work-item type');
  assert.equal(story.vertecPhase, 'Maps Integration // 12. Atrius 2.3');

  // Re-registering on a later round without the phase (or with a blank one) must not wipe it —
  // addSource merges, and a dropped phase would silently un-answer the header's read-out.
  ledger.addSource(id, { type: 'ado', id: 43057, title: 'retitled', vertecPhase: '   ' });
  [story] = ledger.getFeature(id).sources.ado;
  assert.equal(story.vertecPhase, 'Maps Integration // 12. Atrius 2.3');
  assert.equal(story.title, 'retitled', 'while everything actually supplied does update');

  // An explicit null is the way to take a wrong phase back off.
  ledger.addSource(id, { type: 'ado', id: 43057, vertecPhase: null });
  assert.equal(ledger.getFeature(id).sources.ado[0].vertecPhase, null);

  assert.throws(() => ledger.addSource(id, { type: 'ado', id: 1, vertecPhase: 7 }), (e) => e.code === 'EUSER');
  // The booking-key override takes the same treatment.
  ledger.addSource(id, { type: 'ado', id: 99, vertecKey: ' fzag-web ' });
  assert.equal(ledger.getFeature(id).sources.ado.find((s) => s.id === 99).vertecKey, 'fzag-web');
});

test('addSource: a Vertec value can be cleared explicitly, and a key that is not a key is refused', () => {
  const id = 'vertec-clear';
  ledger.createFeature({ id, title: 'x' });
  ledger.addSource(id, { type: 'ado', id: 1, vertecPhase: 'Phase A', vertecKey: 'FZAG' });
  assert.equal(ledger.getFeature(id).sources.ado[0].vertecPhase, 'Phase A');
  ledger.addSource(id, { type: 'ado', id: 1, vertecPhase: null });
  assert.equal(ledger.getFeature(id).sources.ado[0].vertecPhase, null);
  assert.equal(ledger.getFeature(id).sources.ado[0].vertecKey, 'FZAG', 'clearing one leaves the other');

  // The key becomes the `FZAG-` half of a string pasted into a real booking, so it must look like
  // a key — "foo bar" would silently produce the booking line "FOO BAR-43057 …".
  for (const bad of ['foo bar', 'a/b', '-lead', 'FZ AG', 'x y']) {
    assert.throws(() => ledger.addSource(id, { type: 'ado', id: 2, vertecKey: bad }),
      (e) => e.code === 'EUSER', `vertecKey "${bad}" must be refused`);
  }
  for (const ok of ['FZAG', 'fzag-web', 'DXN', 'a.b_c-1']) {
    ledger.addSource(id, { type: 'ado', id: 3, vertecKey: ok });
    assert.equal(ledger.getFeature(id).sources.ado.find((s) => s.id === 3).vertecKey, ok);
  }
});

/* ---- the PR approval signal: which vote the review has earned, and why ---- */

const ROUND_AT = '2026-09-18T08:00:00.000Z';
function prFeature(over = {}) {
  return { id: 'pr-1', kind: 'pr-review', status: 'draft', review: {}, ...over };
}
// A finding that went OUT to the PR and is still open — the only kind that costs the vote.
function posted(over = {}) {
  return {
    fp: `fp-${Math.abs(JSON.stringify(over).length)}-${over.severity || 'minor'}-${over.dimension || 'x'}`,
    severity: 'minor', dimension: 'consistency', status: 'reworking',
    postedAt: '2026-09-18T07:00:00.000Z', suggestion: 'do the thing', ...over,
  };
}

test('approvalSignal: approve only when nothing is outstanding', () => {
  const f = prFeature();
  // Every finding fixed (resolved), pushed back / accepted (waived), or never raised.
  const handled = [
    { fp: 'a', severity: 'blocker', status: 'resolved', postedAt: '2026-09-18T07:00:00.000Z' },
    { fp: 'b', severity: 'major', status: 'waived', statusReason: 'author pushed back, fair', postedAt: '2026-09-18T07:00:00.000Z' },
  ];
  const s = ledger.approvalSignal(f, handled, ROUND_AT);
  assert.equal(s.vote, 'approve');
  assert.match(s.reason, /nothing outstanding/);
  // A clean review — nothing found at all — is the same answer.
  assert.equal(ledger.approvalSignal(f, [], ROUND_AT).vote, 'approve');
});

test('approvalSignal: a major never rides along on an approve', () => {
  // The reviewer's own rule, not Azure DevOps': an approve says "my feedback was handled", and a
  // major IS feedback. This is the assertion that fails if someone re-tiers major as a suggestion.
  for (const severity of ['blocker', 'major']) {
    const s = ledger.approvalSignal(prFeature(), [posted({ severity })], ROUND_AT);
    assert.equal(s.vote, 'wait-for-author', `an open ${severity} must hold the author`);
    assert.equal(s.outstanding.blocking, 1);
    // The chip sits under a readiness gate that says "nothing blocking" about the reviewer's own
    // open queue, which a posted finding has deliberately left. Each must name its own subject or
    // the two read as a contradiction on one screen.
    assert.match(s.reason, /1 blocking comment still awaiting the author/);
    assert.equal(s.outstanding.suggestions, 0, `${severity} must not be counted as a suggestion`);
  }
});

test('approvalSignal: an unanswered question is never an approve, at any severity', () => {
  // `ambiguity` is the dimension the review skills raise a question under (it maps to the
  // `question` conventional-comment label). Severity is irrelevant: the author has not replied.
  const s = ledger.approvalSignal(prFeature(), [posted({ severity: 'info', dimension: 'ambiguity' })], ROUND_AT);
  assert.equal(s.vote, 'wait-for-author');
  assert.equal(s.outstanding.questions, 1);
  assert.equal(s.outstanding.suggestions, 0);
  // Answered (resolved) or accepted (waived) questions cost nothing.
  const closed = [
    posted({ dimension: 'ambiguity', status: 'resolved' }),
    posted({ dimension: 'ambiguity', status: 'waived' }),
  ];
  assert.equal(ledger.approvalSignal(prFeature(), closed, ROUND_AT).vote, 'approve');
});

test('approvalSignal: only suggestions left ⇒ approve with suggestions', () => {
  const s = ledger.approvalSignal(prFeature(),
    [posted({ severity: 'minor' }), posted({ severity: 'info', dimension: 'design-match' })], ROUND_AT);
  assert.equal(s.vote, 'approve-with-suggestions');
  assert.equal(s.outstanding.suggestions, 2);
  assert.match(s.reason, /2 suggestions posted — nothing blocking/);
  // Singular reads correctly too — the chip is a sentence, not a template.
  assert.match(ledger.approvalSignal(prFeature(), [posted()], ROUND_AT).reason, /^1 suggestion posted/);
});

test('approvalSignal: the honest nulls — it refuses to recommend what it cannot know', () => {
  const nul = (feature, findings, at) => ledger.approvalSignal(feature, findings, at);

  // No round has run. A brand-new workspace has no findings and would otherwise look exactly like
  // a clean review — recommending approve on code nobody read is the worst thing this could do.
  assert.equal(nul(prFeature(), [], null).vote, null);
  assert.match(nul(prFeature(), [], null).reason, /no review round/);

  // Undecided work: the review is not finished.
  assert.equal(nul(prFeature(), [{ fp: 'u', severity: 'minor', status: 'open', suggestion: 'x' }], ROUND_AT).vote, null);

  // Decided but not yet posted: the next move is Post, not a vote.
  const decided = [{ fp: 'd', severity: 'minor', status: 'open', suggestion: 'x', decision: 'approve' }];
  assert.equal(nul(prFeature(), decided, ROUND_AT).vote, null);

  // The PR moved after our last round — whether the feedback was handled is exactly what we don't
  // know, so there is no vote until it has been re-read.
  const moved = prFeature({ review: { lastActivityAt: '2026-09-18T09:00:00.000Z', lastActivityBy: 'the author' } });
  const sig = nul(moved, [posted({ severity: 'blocker' })], ROUND_AT);
  assert.equal(sig.vote, null);
  assert.match(sig.reason, /re-review first/);

  // A spec has no PR; on a pr-respond the vote is somebody else's to cast.
  assert.equal(nul({ kind: 'spec', review: {} }, [], ROUND_AT).vote, null);
  assert.equal(nul({ kind: 'pr-respond', review: {} }, [], ROUND_AT).vote, null);
  // And a workspace with no kind at all (pre-dating the field) defaults to spec — no vote.
  assert.equal(nul({ review: {} }, [], ROUND_AT).vote, null);
});

test('workspaceState: a finished PR review is NEEDS-YOU, not "waiting on others"', () => {
  // The whole complaint: the review is done, the next move is one press on the PR, and the
  // workspace was filed under the band you stop looking at.
  assert.equal(ledger.workspaceState(prFeature(), [], ROUND_AT), 'needs-approval');
  const band = (st) => ledger.WORKSPACE_STATES.find((s) => s.state === st).band;
  assert.equal(band('needs-approval'), 'needs-you');

  // …but only once a round has actually run. Before that it is just an empty workspace.
  assert.equal(ledger.workspaceState(prFeature(), [], null), 'settled');
  // …and only for a pr-review: a settled spec is genuinely settled.
  assert.equal(ledger.workspaceState({ kind: 'spec', review: {} }, [], ROUND_AT), 'settled');
  assert.equal(ledger.workspaceState({ kind: 'pr-respond', review: {} }, [], ROUND_AT), 'settled');

  // Comments out, none of them blocking → you can approve-with-suggestions now, so it is your
  // move, not the author's.
  assert.equal(ledger.workspaceState(prFeature(), [posted({ severity: 'minor' })], ROUND_AT), 'needs-approval');
  // Anything blocking, or an unanswered question, genuinely IS waiting on the author.
  assert.equal(ledger.workspaceState(prFeature(), [posted({ severity: 'major' })], ROUND_AT), 'awaiting-author');
  assert.equal(ledger.workspaceState(prFeature(), [posted({ dimension: 'ambiguity' })], ROUND_AT), 'awaiting-author');
  // And nothing here may outrank the states above it.
  assert.equal(ledger.workspaceState(prFeature({ status: 'done' }), [], ROUND_AT), 'done');
  assert.equal(ledger.workspaceState(prFeature(), [{ fp: 'p', status: 'open', pending: 'post', suggestion: 'x' }], ROUND_AT), 'posting');
});

test('approvalSignal: a PR that moved after the round NEVER gets a vote — even with nothing outstanding', () => {
  // B1, and the worst output this feature has. `workspaceState` only reaches its `author-responded`
  // rule from INSIDE the "something is still posted" branch, so a review whose findings were all
  // resolved — the clean review, the finished one — walked straight past it. Reading the state
  // string therefore answered "did the PR move?" with "no" for exactly the workspaces where it
  // matters most, and the chip said Approve on code the author had pushed to since anybody read it.
  // 14 of the user's own workspaces had this shape.
  const moved = prFeature({ review: { lastActivityAt: '2026-09-18T12:00:00.000Z', lastActivityBy: 'the author' } });
  const flagged = prFeature({ review: { authorRespondedAt: '2026-09-18T12:00:00.000Z' } });
  const allHandled = [{ fp: 'a', severity: 'blocker', status: 'resolved', postedAt: '2026-09-18T07:00:00.000Z' }];

  for (const [name, f] of [['activity newer than the round', moved], ['the runner flagged a response', flagged]]) {
    for (const [shape, list] of [['every finding handled', allHandled], ['no findings at all', []],
      ['only suggestions out', [posted({ severity: 'minor' })]]]) {
      const s = ledger.approvalSignal(f, list, ROUND_AT);
      assert.equal(s.vote, null, `${name} + ${shape} must not produce a vote`);
      assert.match(s.reason, /re-review first/);
    }
    // …and the row must not say "Ready to approve" either, or the band and the chip disagree.
    assert.notEqual(ledger.workspaceState(f, allHandled, ROUND_AT), 'needs-approval');
    assert.notEqual(ledger.workspaceState(f, [], ROUND_AT), 'needs-approval');
    // A workspace already marked done is not exempt: `done` outranks every state, so gating on the
    // state string would have let the stalest workspaces keep a green Approve.
    assert.equal(ledger.approvalSignal({ ...f, status: 'done' }, allHandled, ROUND_AT).vote, null);
  }

  // The guard must not cost the honest case: same shapes, PR untouched since the round.
  const still = prFeature({ review: { lastActivityAt: '2026-09-18T07:00:00.000Z' } });
  assert.equal(ledger.approvalSignal(still, allHandled, ROUND_AT).vote, 'approve');
  assert.equal(ledger.workspaceState(still, allHandled, ROUND_AT), 'needs-approval');
});

test('approvalSignal: an unrecognised severity withholds the vote rather than passing as a suggestion', () => {
  for (const severity of [undefined, null, 'critical', 'BLOCKER', '']) {
    const s = ledger.approvalSignal(prFeature(), [posted({ severity })], ROUND_AT);
    assert.equal(s.vote, 'wait-for-author', `severity ${JSON.stringify(severity)} must not read as a suggestion`);
    assert.equal(s.outstanding.blocking, 1);
  }
  // The four real severities are unaffected.
  assert.equal(ledger.approvalSignal(prFeature(), [posted({ severity: 'minor' })], ROUND_AT).vote, 'approve-with-suggestions');
});

test('addRequest: an action that needs a workspace is refused without one', () => {
  for (const action of ledger.WSID_REQUIRED_ACTIONS) {
    assert.throws(() => ledger.addRequest({ action }), (e) => e.code === 'EUSER',
      `${action} without a wsId would queue a row the runner can never dispatch`);
  }
  assert.ok(ledger.WSID_REQUIRED_ACTIONS.includes('summarize'));
  // `audit` still takes either a wsId or URLs, and `poll` needs neither.
  assert.ok(!ledger.WSID_REQUIRED_ACTIONS.includes('audit'));
  assert.doesNotThrow(() => ledger.addRequest({ action: 'poll' }));
});

test('addSource: a blank title or url is dropped, never stored over a real one', () => {
  const id = 'blank-title-guard';
  ledger.createFeature({ id, title: 'x' });
  ledger.addSource(id, { type: 'ado', id: 43099, title: 'Atrius map on Wayfinding', url: 'https://dev.azure.com/FZAG/dxp/_workitems/edit/43099' });
  const src = () => ledger.getFeature(id).sources.ado[0];

  // /flowlever:summarize re-registers EVERY ado source passing --title "<System.Title>" across 36
  // workspaces. An unset shell variable would otherwise blank the real titles — silently destroying
  // the data that step exists to repair — and a blank url would take the Vertec prefix with it.
  ledger.addSource(id, { type: 'ado', id: 43099, title: '   ' });
  assert.equal(src().title, 'Atrius map on Wayfinding');
  ledger.addSource(id, { type: 'ado', id: 43099, url: '' });
  assert.equal(src().url, 'https://dev.azure.com/FZAG/dxp/_workitems/edit/43099');
  // Real values still update, and an explicit null still clears.
  ledger.addSource(id, { type: 'ado', id: 43099, title: 'The real System.Title' });
  assert.equal(src().title, 'The real System.Title');
  ledger.addSource(id, { type: 'ado', id: 43099, title: null });
  assert.equal(src().title, null);
});
