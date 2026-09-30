'use strict';

// The duplicate-comment gate: a PR review must not open a second thread restating a point
// another reviewer already made. Before this, that rule lived only as prose in the review
// skill, so a missed duplicate was indistinguishable from an ordinary finding.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Must be set BEFORE requiring the module under test.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowlever-dupgate-'));
process.env.FLOWLEVER_DATA = tmpDir;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const ledger = require('../src/ledger');

let seq = 0;
function mkWorkspace(kind = 'pr-review') {
  const id = `ws-${kind}-${++seq}`;
  ledger.createFeature({ id, title: `PR #${seq}`, kind });
  return id;
}

function mkFinding(over = {}) {
  return {
    dimension: 'feasibility',
    severity: 'major',
    title: 'Null deref when the token is absent',
    detail: 'GetClaim returns null and is dereferenced.',
    locus: 'pr:770:src/OktaErrorHelper.cs:L39',
    suggestion: 'Guard it.',
    ...over,
  };
}

function thread(over = {}) {
  return {
    threadId: '9001',
    author: 'Oriol',
    locus: 'pr:770:src/OktaErrorHelper.cs:L39',
    excerpt: 'This can be null here.',
    ...over,
  };
}

before(() => { ledger.initDataDir(); });
after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

// ---------- the "did you even look" half ----------

test('a fresh pr-review workspace has priorThreads null, not an empty list', () => {
  const id = mkWorkspace();
  assert.equal(ledger.getFeature(id).priorThreads, null);
});

test('ingest on a PR workspace refuses while the PR threads were never recorded', () => {
  const id = mkWorkspace();
  assert.throws(() => ledger.ingestRound(id, [mkFinding()]), (err) => {
    assert.equal(err.code, 'EUSER');
    assert.match(err.message, /never recorded/);
    assert.match(err.message, /threads set/);
    return true;
  });
});

test('a spec workspace is unaffected — it has no PR comments to collide with', () => {
  const id = mkWorkspace('spec');
  const { stats } = ledger.ingestRound(id, [mkFinding({ locus: 'confluence:1#flow' })]);
  assert.equal(stats.new, 1);
});

test('recording an explicitly empty thread list satisfies the gate', () => {
  const id = mkWorkspace();
  ledger.setPriorThreads(id, []);
  const { stats } = ledger.ingestRound(id, [mkFinding()]);
  assert.equal(stats.new, 1);
});

test('a workspace file predating the field reads as never-recorded, not as "no comments"', () => {
  const id = mkWorkspace();
  const p = path.join(tmpDir, 'features', `${id}.json`);
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  delete raw.priorThreads;
  fs.writeFileSync(p, JSON.stringify(raw));
  assert.equal(ledger.getFeature(id).priorThreads, null);
  assert.throws(() => ledger.ingestRound(id, [mkFinding()]), /never recorded/);
});

test('setPriorThreads demands a threadId and an author — an unattributed thread is useless', () => {
  const id = mkWorkspace();
  assert.throws(() => ledger.setPriorThreads(id, [{ author: 'Oriol' }]), /threadId is required/);
  assert.throws(() => ledger.setPriorThreads(id, [{ threadId: '1' }]), /author is required/);
  assert.throws(() => ledger.setPriorThreads(id, 'nope'), /threads must be an array/);
});

// ---------- the "is this the same point" half ----------

test('a finding landing on an existing thread is refused, naming the author and thread', () => {
  const id = mkWorkspace();
  ledger.setPriorThreads(id, [thread()]);
  assert.throws(() => ledger.ingestRound(id, [mkFinding()]), (err) => {
    assert.equal(err.code, 'EUSER');
    assert.match(err.message, /already covered by Oriol on thread 9001/);
    return true;
  });
});

test('duplicateOf lets it through — kept visible as a cross-reference', () => {
  const id = mkWorkspace();
  ledger.setPriorThreads(id, [thread()]);
  const { stats } = ledger.ingestRound(id, [mkFinding({
    duplicateOf: { label: 'Oriol on OktaErrorHelper.cs:39', url: 'https://dev.azure.com/x?discussionId=9001' },
  })]);
  assert.equal(stats.new, 1);
});

test('a thread locus lets it through — it posts as a reply, not a new thread', () => {
  const id = mkWorkspace();
  ledger.setPriorThreads(id, [thread()]);
  const { stats } = ledger.ingestRound(id, [mkFinding({ locus: 'pr:770:thread:9001' })]);
  assert.equal(stats.new, 1);
});

test('notDuplicate lets it through, and the stated reason is persisted for review', () => {
  const id = mkWorkspace();
  ledger.setPriorThreads(id, [thread()]);
  ledger.ingestRound(id, [mkFinding({ notDuplicate: 'Oriol is about the null check; this is the swallowed exception.' })]);
  const [f] = ledger.loadLedger(id).findings;
  assert.match(f.notDuplicate, /swallowed exception/);
});

test('notDuplicate cannot be a bare truthy value — silencing the gate has to say something', () => {
  assert.throws(() => ledger.validateIngestFinding(mkFinding({ notDuplicate: true })), /non-empty string/);
  assert.throws(() => ledger.validateIngestFinding(mkFinding({ notDuplicate: '  ' })), /non-empty string/);
});

test('a finding elsewhere in the same file is not a collision', () => {
  const id = mkWorkspace();
  ledger.setPriorThreads(id, [thread({ locus: 'pr:770:src/OktaErrorHelper.cs:L200' })]);
  const { stats } = ledger.ingestRound(id, [mkFinding()]);
  assert.equal(stats.new, 1);
});

test('a finding at the same line in a different file is not a collision', () => {
  const id = mkWorkspace();
  ledger.setPriorThreads(id, [thread({ locus: 'pr:770:src/Other.cs:L39' })]);
  const { stats } = ledger.ingestRound(id, [mkFinding()]);
  assert.equal(stats.new, 1);
});

test('a PR-level thread with no file anchor cannot collide positionally', () => {
  const id = mkWorkspace();
  ledger.setPriorThreads(id, [thread({ locus: null })]);
  const { stats } = ledger.ingestRound(id, [mkFinding()]);
  assert.equal(stats.new, 1);
});

test('every unreconciled finding is reported at once, not just the first', () => {
  const id = mkWorkspace();
  ledger.setPriorThreads(id, [
    thread({ threadId: '1', author: 'Oriol', locus: 'pr:770:src/A.cs:L10' }),
    thread({ threadId: '2', author: 'Mireia', locus: 'pr:770:src/B.cs:L20' }),
  ]);
  assert.throws(() => ledger.ingestRound(id, [
    mkFinding({ title: 'one', locus: 'pr:770:src/A.cs:L10' }),
    mkFinding({ title: 'two', locus: 'pr:770:src/B.cs:L20' }),
  ]), (err) => {
    assert.match(err.message, /2 finding\(s\)/);
    assert.match(err.message, /Oriol/);
    assert.match(err.message, /Mireia/);
    return true;
  });
});

test('a refused ingest writes nothing — no round is consumed', () => {
  const id = mkWorkspace();
  ledger.setPriorThreads(id, [thread()]);
  assert.throws(() => ledger.ingestRound(id, [mkFinding()]));
  assert.equal(ledger.loadLedger(id).findings.length, 0);
  assert.equal(ledger.loadRounds(id).rounds.length, 0);
});

// ---------- proximity + path matching ----------

test('a comment a few lines off is the same conversation', () => {
  const id = mkWorkspace();
  ledger.setPriorThreads(id, [thread({ locus: 'pr:770:src/OktaErrorHelper.cs:L42' })]);
  assert.throws(() => ledger.ingestRound(id, [mkFinding({ locus: 'pr:770:src/OktaErrorHelper.cs:L39' })]),
    /already covered by/);
});

test('a range finding collides when it spans an existing thread anchor', () => {
  const id = mkWorkspace();
  ledger.setPriorThreads(id, [thread({ locus: 'pr:770:src/OktaErrorHelper.cs:L60' })]);
  assert.throws(() => ledger.ingestRound(id, [mkFinding({ locus: 'pr:770:src/OktaErrorHelper.cs:L55-70' })]),
    /already covered by/);
});

test("ADO's leading-slash paths match a finding's repo-relative path", () => {
  const id = mkWorkspace();
  ledger.setPriorThreads(id, [thread({ locus: 'pr:770:/src/OktaErrorHelper.cs:L39' })]);
  assert.throws(() => ledger.ingestRound(id, [mkFinding()]), /already covered by/);
});

test('path matching is case-insensitive', () => {
  const id = mkWorkspace();
  ledger.setPriorThreads(id, [thread({ locus: 'pr:770:src/oktaerrorhelper.cs:L39' })]);
  assert.throws(() => ledger.ingestRound(id, [mkFinding()]), /already covered by/);
});

test('parseLocus reads both grammars and degrades on anything else', () => {
  assert.deepEqual(ledger.parseLocus('pr:770:src/A.cs:L39'),
    { threadId: null, path: 'src/a.cs', from: 39, to: 39 });
  assert.deepEqual(ledger.parseLocus('pr:770:src/A.cs:L39-44'),
    { threadId: null, path: 'src/a.cs', from: 39, to: 44 });
  assert.equal(ledger.parseLocus('pr:770:thread:9001').threadId, '9001');
  assert.equal(ledger.parseLocus('confluence:1#flow').from, null);
});

test('an inverted range is read low-to-high, so it still collides', () => {
  assert.deepEqual(ledger.parseLocus('pr:770:src/A.cs:L44-39'),
    { threadId: null, path: 'src/a.cs', from: 39, to: 44 });
});

test('threadCollisions is pure and reports every overlapping thread', () => {
  const threads = [
    thread({ threadId: '1', locus: 'pr:770:src/A.cs:L10' }),
    thread({ threadId: '2', locus: 'pr:770:src/A.cs:L12' }),
    thread({ threadId: '3', locus: 'pr:770:src/A.cs:L900' }),
  ];
  const hits = ledger.threadCollisions('pr:770:src/A.cs:L11', threads).map((t) => t.threadId);
  assert.deepEqual(hits, ['1', '2']);
});

// ---------- re-ingest across rounds ----------

test('a reconciled finding keeps passing on the next round', () => {
  const id = mkWorkspace();
  ledger.setPriorThreads(id, [thread()]);
  const f = mkFinding({ notDuplicate: 'different point: the swallowed exception.' });
  ledger.ingestRound(id, [f]);
  const { stats } = ledger.ingestRound(id, [f]);
  assert.equal(stats.stillOpen, 1);
});

test('our own posted comment, re-recorded as a thread, does not block its own finding', () => {
  // Round 2 fetches the PR threads and now sees the comment round 1 posted. The finding is
  // fingerprint-identical, so reconciliation should carry it forward rather than trip the gate
  // on a thread that IS this finding — the review re-anchors it to the thread it created.
  const id = mkWorkspace();
  ledger.setPriorThreads(id, []);
  ledger.ingestRound(id, [mkFinding()]);
  ledger.setPriorThreads(id, [thread({ author: 'FlowLever' })]);
  const { stats } = ledger.ingestRound(id, [mkFinding({ locus: 'pr:770:thread:9001' })]);
  assert.equal(stats.new, 1, 'a re-anchored finding is a new fingerprint');
});
