'use strict';

// Drives the REAL CLI as a subprocess against a temp FLOWLEVER_DATA dir — no mocks. There was no
// test file for cli.js at all before this one, which is exactly why F-1/F-2/F-3/C-21/C-16 shipped
// underneath a green suite (see plugins/flowlever/REVIEW.md).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowlever-cli-test-'));
const fixturesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowlever-cli-fixtures-'));

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(fixturesDir, { recursive: true, force: true });
});

function run(args, { data = tmpDir } = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, FLOWLEVER_DATA: data },
    encoding: 'utf8',
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function readJson(...parts) {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, ...parts), 'utf8'));
}

function writeFixture(name, data) {
  const file = path.join(fixturesDir, name);
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
}

let seq = 0;
function nextId(prefix) { seq += 1; return `${prefix}-${seq}`; }

function mkFinding(over = {}) {
  return {
    dimension: 'consistency',
    severity: 'major',
    title: 'Spec and ADO disagree on payment methods',
    detail: 'Spec lists 3, AC lists 4.',
    locus: 'confluence:1#flow',
    suggestion: 'Align them.',
    ...over,
  };
}

// ---------- F-1: bare invocation must print usage, not crash ----------

test('bare invocation prints usage and exits 0 (F-1)', () => {
  const r = run([]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /FlowLever — review cockpit/);
  assert.match(r.stdout, /Severity glyphs:/);
  assert.equal(r.stderr, '');
});

test('help exits 0 with the same usage text as bare invocation', () => {
  const bare = run([]);
  const help = run(['help']);
  assert.equal(help.status, 0);
  assert.equal(help.stdout, bare.stdout);
});

test('unknown command exits 1 with a readable Error, no stack trace', () => {
  const r = run(['bogus-command']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^Error: Unknown command 'bogus-command'/);
  assert.doesNotMatch(r.stderr, /at Object\.|at run \(|TypeError/);
});

// ---------- F-2: `source add --type figma` must succeed via --fileKey/--nodeId ----------

test('source add --type figma succeeds and persists fileKey/nodeId (F-2)', () => {
  const id = nextId('figma-src');
  assert.equal(run(['feature', 'add', id, '--title', 'Figma test']).status, 0);

  const add = run(['source', 'add', id, '--type', 'figma', '--fileKey', 'aBc123', '--nodeId', '1:23']);
  assert.equal(add.status, 0, add.stderr);
  assert.match(add.stdout, /Added figma source aBc123#1:23/);

  const feature = readJson('features', `${id}.json`);
  assert.equal(feature.sources.figma.length, 1);
  assert.equal(feature.sources.figma[0].fileKey, 'aBc123');
  assert.equal(feature.sources.figma[0].nodeId, '1:23');
});

test('source add --type figma without --fileKey fails on --fileKey, not the old --id complaint', () => {
  const id = nextId('figma-noid');
  assert.equal(run(['feature', 'add', id, '--title', 'x']).status, 0);
  const r = run(['source', 'add', id, '--type', 'figma', '--nodeId', '1:23']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--fileKey/);
});

// ---------- F-3: `source add --type ado --itemType ...` must persist as "type" ----------

test('source add --type ado --itemType persists as the source\'s "type" field (F-3)', () => {
  const id = nextId('ado-src');
  assert.equal(run(['feature', 'add', id, '--title', 'ADO test']).status, 0);

  const add = run(['source', 'add', id, '--type', 'ado', '--id', '99999', '--itemType', 'User Story']);
  assert.equal(add.status, 0, add.stderr);

  const feature = readJson('features', `${id}.json`);
  assert.equal(feature.sources.ado.length, 1);
  assert.equal(feature.sources.ado[0].id, 99999);
  assert.equal(feature.sources.ado[0].type, 'User Story');
  assert.equal(feature.sources.ado[0].itemType, undefined);
});

// ---------- C-21: a value flag must not swallow the next flag as its value ----------

test('a value flag followed by another flag errors instead of silently dropping it (C-21)', () => {
  const id = nextId('swallow');
  const r = run(['feature', 'add', id, '--title', '--json']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--title/);
  assert.match(r.stderr, /another flag/);
  assert.equal(fs.existsSync(path.join(tmpDir, 'features', `${id}.json`)), false);
});

test('a value flag with nothing after it still errors clearly (missing value)', () => {
  const id = nextId('missing-val');
  const r = run(['feature', 'add', id, '--title']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--title requires a value/);
});

// ---------- C-16: destructive commands need an explicit guard ----------

test('feature delete refuses without --yes, naming exactly what would be destroyed', () => {
  const id = nextId('del');
  assert.equal(run(['feature', 'add', id, '--title', 'to delete']).status, 0);

  const refused = run(['feature', 'delete', id]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, new RegExp(`features.*${id}\\.json`));
  assert.match(refused.stderr, /--yes/);
  assert.equal(fs.existsSync(path.join(tmpDir, 'features', `${id}.json`)), true, 'nothing deleted yet');

  const confirmed = run(['feature', 'delete', id, '--yes']);
  assert.equal(confirmed.status, 0, confirmed.stderr);
  assert.equal(fs.existsSync(path.join(tmpDir, 'features', `${id}.json`)), false);
});

test('demo refuses without --force once a demo workspace id already exists, proceeds with --force', () => {
  const demoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowlever-cli-demo-'));
  try {
    // Occupy one of demo.js's fixed ids with a REAL workspace before seeding.
    assert.equal(run(['feature', 'add', 'checkout-redesign', '--title', 'A REAL workspace'], { data: demoDir }).status, 0);

    const refused = run(['demo'], { data: demoDir });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /checkout-redesign/);
    assert.match(refused.stderr, /--force/);
    const untouched = JSON.parse(fs.readFileSync(path.join(demoDir, 'features', 'checkout-redesign.json'), 'utf8'));
    assert.equal(untouched.title, 'A REAL workspace', 'refusing must not have touched the real workspace');

    const forced = run(['demo', '--force'], { data: demoDir });
    assert.equal(forced.status, 0, forced.stderr);
    const seeded = JSON.parse(fs.readFileSync(path.join(demoDir, 'features', 'checkout-redesign.json'), 'utf8'));
    assert.notEqual(seeded.title, 'A REAL workspace', '--force should have reseeded over it');
  } finally {
    fs.rmSync(demoDir, { recursive: true, force: true });
  }
});

test('demo proceeds without --force on a clean data dir (no existing demo workspace)', () => {
  const cleanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowlever-cli-demo-clean-'));
  try {
    const r = run(['demo'], { data: cleanDir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Demo data seeded/);
  } finally {
    fs.rmSync(cleanDir, { recursive: true, force: true });
  }
});

// ---------- ingest --scope-dimensions / --scope-fps must not auto-resolve out-of-scope findings ----------

test('ingest --scope-dimensions leaves out-of-scope findings untouched instead of auto-resolving them', () => {
  const id = nextId('scope');
  assert.equal(run(['feature', 'add', id, '--title', 'scope test']).status, 0);

  const round1 = [
    mkFinding({ dimension: 'consistency', title: 'Consistency issue', locus: 'l:1' }),
    mkFinding({ dimension: 'completeness', title: 'Completeness issue', locus: 'l:2' }),
  ];
  assert.equal(run(['ingest', id, '--file', writeFixture(`${id}-round1.json`, round1)]).status, 0);

  // Round 2 only re-checks "consistency" and omits the completeness finding entirely.
  const round2 = [mkFinding({ dimension: 'consistency', title: 'Consistency issue', locus: 'l:1' })];
  const ingest2 = run(['ingest', id, '--file', writeFixture(`${id}-round2.json`, round2), '--scope-dimensions', 'consistency']);
  assert.equal(ingest2.status, 0, ingest2.stderr);

  const doc = readJson('ledger', `${id}.json`);
  const byTitle = new Map(doc.findings.map((f) => [f.title, f]));
  assert.equal(byTitle.get('Consistency issue').status, 'open');
  assert.equal(byTitle.get('Completeness issue').status, 'open', 'out-of-scope finding must not be auto-resolved');
});

test('ingest --scope-fps behaves the same way, scoped by fingerprint', () => {
  const id = nextId('scopefp');
  assert.equal(run(['feature', 'add', id, '--title', 'scope-fp test']).status, 0);

  const round1 = [
    mkFinding({ dimension: 'consistency', title: 'A', locus: 'l:1' }),
    mkFinding({ dimension: 'completeness', title: 'B', locus: 'l:2' }),
  ];
  assert.equal(run(['ingest', id, '--file', writeFixture(`${id}-r1.json`, round1)]).status, 0);
  const fpA = readJson('ledger', `${id}.json`).findings.find((f) => f.title === 'A').fp;

  const round2 = [mkFinding({ dimension: 'consistency', title: 'A', locus: 'l:1' })];
  const r = run(['ingest', id, '--file', writeFixture(`${id}-r2.json`, round2), '--scope-fps', fpA]);
  assert.equal(r.status, 0, r.stderr);

  const doc = readJson('ledger', `${id}.json`);
  assert.equal(doc.findings.find((f) => f.title === 'B').status, 'open');
});

test('ingest without --scope still auto-resolves an omitted finding (a full sweep, unchanged behavior)', () => {
  const id = nextId('noscope');
  assert.equal(run(['feature', 'add', id, '--title', 'no scope test']).status, 0);

  const round1 = [
    mkFinding({ dimension: 'consistency', title: 'A', locus: 'l:1' }),
    mkFinding({ dimension: 'completeness', title: 'B', locus: 'l:2' }),
  ];
  assert.equal(run(['ingest', id, '--file', writeFixture(`${id}-r1.json`, round1)]).status, 0);

  const round2 = [mkFinding({ dimension: 'consistency', title: 'A', locus: 'l:1' })];
  assert.equal(run(['ingest', id, '--file', writeFixture(`${id}-r2.json`, round2)]).status, 0);

  const doc = readJson('ledger', `${id}.json`);
  assert.equal(doc.findings.find((f) => f.title === 'B').status, 'resolved');
});

test('ingest rejects --scope-fps and --scope-dimensions together', () => {
  const id = nextId('scope-conflict');
  assert.equal(run(['feature', 'add', id, '--title', 'x']).status, 0);
  const f = writeFixture(`${id}.json`, [mkFinding()]);
  const r = run(['ingest', id, '--file', f, '--scope-fps', 'abc', '--scope-dimensions', 'consistency']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /either --scope-fps or --scope-dimensions/);
});

// ---------- requests claim: an atomic, exclusive take ----------

test('requests claim atomically takes exactly one queued job, oldest first', () => {
  const add1 = run(['requests', 'add', '--action', 'poll', '--json']);
  assert.equal(add1.status, 0, add1.stderr);
  const req1 = JSON.parse(add1.stdout).id;
  const add2 = run(['requests', 'add', '--action', 'poll', '--json']);
  assert.equal(add2.status, 0, add2.stderr);
  const req2 = JSON.parse(add2.stdout).id;

  const claim1 = run(['requests', 'claim', '--json']);
  assert.equal(claim1.status, 0, claim1.stderr);
  const claimed1 = JSON.parse(claim1.stdout);
  assert.equal(claimed1.id, req1);
  assert.equal(claimed1.status, 'running');

  const claim2 = run(['requests', 'claim', '--json']);
  const claimed2 = JSON.parse(claim2.stdout);
  assert.equal(claimed2.id, req2);

  const claim3 = run(['requests', 'claim']);
  assert.equal(claim3.status, 0);
  assert.match(claim3.stdout, /Nothing queued/);
});

test('requests claim narrows to --actions', () => {
  assert.equal(run(['requests', 'add', '--action', 'apply', '--wsId', 'some-ws', '--json']).status, 0);
  const addPoll = run(['requests', 'add', '--action', 'poll', '--json']);
  assert.equal(addPoll.status, 0, addPoll.stderr);

  const claim = run(['requests', 'claim', '--actions', 'poll', '--json']);
  assert.equal(claim.status, 0, claim.stderr);
  const claimed = JSON.parse(claim.stdout);
  assert.equal(claimed.action, 'poll');
});

test('feature summary: --text / --file / --clear, exactly one of them', () => {
  const id = nextId('summary-cli');
  run(['feature', 'add', id, '--title', 'PR #5882', '--kind', 'pr-review']);

  const set = run(['feature', 'summary', id, '--text', 'Boots the Atrius map against a per-language venue.']);
  assert.equal(set.status, 0, set.stderr);
  assert.equal(readJson('features', `${id}.json`).summary, 'Boots the Atrius map against a per-language venue.');

  // A good summary is a short paragraph, so it has to be able to arrive from a file with newlines.
  const file = path.join(fixturesDir, 'summary.md');
  fs.writeFileSync(file, 'What it does\n\n- normalises the language\n- derives the venue id\n');
  assert.equal(run(['feature', 'summary', id, '--file', file]).status, 0);
  assert.match(readJson('features', `${id}.json`).summary, /derives the venue id/);

  assert.equal(run(['feature', 'summary', id, '--clear']).status, 0);
  assert.equal(readJson('features', `${id}.json`).summary, null);

  // Ambiguity is refused rather than resolved by precedence: two sources for one field is a
  // mistake in the caller, and picking one silently discards the other.
  const both = run(['feature', 'summary', id, '--text', 'a', '--clear']);
  assert.equal(both.status, 1);
  assert.match(both.stderr + both.stdout, /exactly one of/i);
  assert.equal(run(['feature', 'summary', id]).status, 1, 'and none of them is not a no-op either');
  assert.equal(run(['feature', 'summary', id, '--file', path.join(fixturesDir, 'nope.md')]).status, 1);
});

test('source add: --itemType and --vertecPhase land on the work item; --vertecPhase is ado-only', () => {
  const id = nextId('vertec-cli');
  run(['feature', 'add', id, '--title', 'PR #5882', '--kind', 'pr-review']);
  const added = run(['source', 'add', id, '--type', 'ado', '--id', '43057',
    '--itemType', 'User Story', '--title', 'Atrius 2.3 — The map reads in the visitor\'s language',
    '--url', 'https://dev.azure.com/FZAG/dxp/_workitems/edit/43057',
    '--vertecPhase', 'Maps Integration // 12. Atrius 2.3']);
  assert.equal(added.status, 0, added.stderr);
  const [story] = readJson('features', `${id}.json`).sources.ado;
  assert.equal(story.type, 'User Story');
  assert.equal(story.vertecPhase, 'Maps Integration // 12. Atrius 2.3');

  // A phase on a Confluence page has nowhere to go. Dropping it silently would look like it worked
  // and show no phase in the cockpit, so it is a hard error naming the flag.
  const wrong = run(['source', 'add', id, '--type', 'confluence', '--id', '988446724',
    '--vertecPhase', 'Maps Integration']);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr + wrong.stdout, /--vertecPhase applies to --type ado only/);

  // And `feature show` prints both, so the terminal tells the same story as the cockpit.
  const shown = run(['feature', 'show', id]);
  assert.match(shown.stdout, /\[User Story\]/);
  assert.match(shown.stdout, /Vertec phase: Maps Integration/);
});

test('source add: --clear-vertec-phase is the only way to remove a phase, and a blank never is', () => {
  const id = nextId('vertec-clear-cli');
  run(['feature', 'add', id, '--title', 'x']);
  run(['source', 'add', id, '--type', 'ado', '--id', '43057', '--vertecPhase', 'Maps Integration']);
  const phase = () => readJson('features', `${id}.json`).sources.ado[0].vertecPhase;
  assert.equal(phase(), 'Maps Integration');

  // The accident this protects against: `--vertecPhase "$PHASE"` with an empty PHASE.
  assert.equal(run(['source', 'add', id, '--type', 'ado', '--id', '43057', '--vertecPhase=']).status, 0);
  assert.equal(phase(), 'Maps Integration', 'a blank value must never wipe a real phase');

  assert.equal(run(['source', 'add', id, '--type', 'ado', '--id', '43057', '--clear-vertec-phase']).status, 0);
  assert.equal(phase(), null, 'but the explicit flag does');

  // Contradicting yourself is an error, not a precedence puzzle.
  const both = run(['source', 'add', id, '--type', 'ado', '--id', '43057',
    '--vertecPhase', 'A', '--clear-vertec-phase']);
  assert.equal(both.status, 1);
  assert.match(both.stderr + both.stdout, /contradict/);
  assert.equal(run(['source', 'add', id, '--type', 'confluence', '--id', '9', '--clear-vertec-phase']).status, 1);
});

test('source add: the vertec flags are ado-only on EVERY type, figma included', () => {
  const id = nextId('vertec-figma');
  run(['feature', 'add', id, '--title', 'x']);
  // The guard used to live inside the id-keyed branch, so --type figma skipped it entirely: the
  // command exited 0, stored nothing, and the help text promised "a hard error elsewhere".
  for (const extra of [['--vertecPhase', 'Nope'], ['--vertecKey', 'FOO'], ['--clear-vertec-phase']]) {
    const res = run(['source', 'add', id, '--type', 'figma', '--fileKey', 'abc', ...extra]);
    assert.equal(res.status, 1, `figma + ${extra[0]} must be refused, not silently dropped`);
    assert.match(res.stderr + res.stdout, /applies to --type ado only/);
  }
  // And the figma source itself still registers fine without them.
  assert.equal(run(['source', 'add', id, '--type', 'figma', '--fileKey', 'abc', '--nodeId', '1:23']).status, 0);
  assert.equal(readJson('features', `${id}.json`).sources.figma[0].nodeId, '1:23');
});
