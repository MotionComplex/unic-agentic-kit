'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Must be set BEFORE requiring the modules under test. PORT=0 → ephemeral port.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowlever-server-'));
process.env.FLOWLEVER_DATA = tmpDir;
process.env.PORT = '0';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const ledger = require('../src/ledger');
const { server } = require('../src/server');

let base;

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

before(async () => {
  ledger.initDataDir();
  ledger.createFeature({ id: 'flow-feat', title: 'Flow Feature' });
  ledger.ingestRound('flow-feat', [
    mkFinding({ title: 'Finding A' }),
    mkFinding({ title: 'Finding B', dimension: 'completeness' }),
    mkFinding({ title: 'Finding C', dimension: 'testability', severity: 'minor' }),
  ], { note: 'seed' });
  await new Promise((res) => (server.listening ? res() : server.once('listening', res)));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

function fps() {
  return ledger.loadLedger('flow-feat').findings.map((f) => f.fp);
}

test('POST /review/apply sets the listed findings to reworking', async () => {
  const all = fps();
  const target = all.slice(0, 2);
  const res = await fetch(`${base}/api/features/flow-feat/review/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fps: target, status: 'reworking' }),
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.updated, 2);
  assert.equal(json.status, 'reworking');

  const byFp = new Map(ledger.loadLedger('flow-feat').findings.map((f) => [f.fp, f]));
  assert.equal(byFp.get(target[0]).status, 'reworking');
  assert.equal(byFp.get(target[1]).status, 'reworking');
  assert.equal(byFp.get(all[2]).status, 'open'); // untouched
});

test('POST /review/apply defaults status to reworking when omitted', async () => {
  const target = [fps()[2]];
  const res = await fetch(`${base}/api/features/flow-feat/review/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fps: target }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'reworking');
});

test('POST /review/apply rejects empty / bad fps and unknown findings (atomic)', async () => {
  const empty = await fetch(`${base}/api/features/flow-feat/review/apply`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fps: [] }),
  });
  assert.equal(empty.status, 400);

  const unknown = await fetch(`${base}/api/features/flow-feat/review/apply`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fps: ['nope-nope-xx'] }),
  });
  assert.equal(unknown.status, 400);
});

test('POST /review/apply rejects a status outside the allowlist', async () => {
  const res = await fetch(`${base}/api/features/flow-feat/review/apply`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fps: [fps()[0]], status: 'waived' }),
  });
  assert.equal(res.status, 400);
});

test('POST /review/apply accepts resolved (pr-review approve → will-post)', async () => {
  const target = [fps()[0]];
  const res = await fetch(`${base}/api/features/flow-feat/review/apply`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fps: target, status: 'resolved' }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'resolved');
  const byFp = new Map(ledger.loadLedger('flow-feat').findings.map((f) => [f.fp, f]));
  assert.equal(byFp.get(target[0]).status, 'resolved');
});

test('POST /review/apply accepts posted (PR comment sent → reworking + postedAt stamp)', async () => {
  const target = [fps()[2]];
  const res = await fetch(`${base}/api/features/flow-feat/review/apply`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fps: target, status: 'posted' }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'posted');
  const f = ledger.loadLedger('flow-feat').findings.find((x) => x.fp === target[0]);
  assert.equal(f.status, 'reworking', 'posted stays open for the re-review reconcile');
  assert.ok(f.postedAt, 'carries a postedAt stamp');
});

/* The inbox's Done list can be sorted by "last modified", which reads `updatedAt` off each row.
 * /api/features had always carried it and /api/home never did — the two summary shapes had drifted,
 * and the sort would have silently ranked every completed workspace as undated. */
test('GET /api/home carries the timestamps the Done list sorts on', async () => {
  const home = await (await fetch(`${base}/api/home`)).json();
  const row = home.find((r) => r.id === 'flow-feat');
  assert.ok(row, 'flow-feat is in the inbox');
  assert.ok(row.updatedAt, 'updatedAt must be present — "sort by last modified" reads it');
  assert.ok(!Number.isNaN(Date.parse(row.updatedAt)), 'and it must be a parseable timestamp');
  // The other sort key comes off the stamps block, which this endpoint already served.
  assert.ok(row.stamps, 'stamps must be present — "sort by last reviewed" reads lastReviewedAt');
  assert.ok('lastReviewedAt' in row.stamps);
});

test('GET /api/home counts posted findings separately, not as reworking/toReview', async () => {
  const home = await (await fetch(`${base}/api/home`)).json();
  const row = home.find((r) => r.id === 'flow-feat');
  assert.ok(row, 'flow-feat is in the inbox');
  assert.ok(row.counts.posted >= 1, 'posted findings are counted under posted');
});

test('POST /features/:id/activity flips authorResponded; summaries carry it', async () => {
  // post a comment first so the workspace is "awaiting author"
  await fetch(`${base}/api/features/flow-feat/review/apply`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fps: [fps()[0]], status: 'posted' }),
  });
  const resp = await fetch(`${base}/api/features/flow-feat/activity`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authorResponded: true, note: '2 new replies' }),
  });
  assert.equal(resp.status, 200);
  const feat = await resp.json();
  assert.ok(feat.review.authorRespondedAt, 'authorRespondedAt is set');
  assert.equal(feat.review.note, '2 new replies');

  const all = await (await fetch(`${base}/api/features`)).json();
  const row = all.find((r) => r.id === 'flow-feat');
  assert.equal(row.authorResponded, true);
  assert.equal(row.awaitingAuthor, true);

  // clearing returns to waiting
  const cleared = await fetch(`${base}/api/features/flow-feat/activity`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authorResponded: false }),
  });
  assert.equal((await cleared.json()).review.authorRespondedAt, null);
});

test('POST /features/:id/activity records the real PR-update time; summaries expose both clocks', async () => {
  // A future-dated activity stamp is guaranteed to be newer than the seeded round, which is
  // exactly the "the PR moved since we reviewed it" case the cockpit flags.
  const at = new Date(Date.now() + 60_000).toISOString();
  const resp = await fetch(`${base}/api/features/flow-feat/activity`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lastActivityAt: at, lastActivityBy: 'Oriol Puig' }),
  });
  assert.equal(resp.status, 200);
  const feat = await resp.json();
  assert.equal(feat.review.lastActivityAt, at);
  assert.equal(feat.review.lastActivityBy, 'Oriol Puig');

  const row = (await (await fetch(`${base}/api/features`)).json()).find((r) => r.id === 'flow-feat');
  assert.ok(row.stamps, 'feature summaries carry the stamps block');
  assert.equal(row.stamps.lastActivityAt, at);
  assert.equal(row.stamps.lastActivityBy, 'Oriol Puig');
  assert.equal(row.stamps.lastReviewedAt, row.lastRoundAt, 'lastReviewedAt is the last round');
  assert.equal(row.stamps.newSinceReview, true, 'their update is newer than our last round');

  const hrow = (await (await fetch(`${base}/api/home`)).json()).find((r) => r.id === 'flow-feat');
  assert.equal(hrow.stamps.newSinceReview, true, 'home rows carry the stamps too');

  // an unparseable timestamp is a client error, not a silently stored string
  const bad = await fetch(`${base}/api/features/flow-feat/activity`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lastActivityAt: 'yesterday-ish' }),
  });
  assert.equal(bad.status, 400);
});

test('POST /review/cancel releases stranded in-flight findings and drops the dead job', async () => {
  ledger.createFeature({ id: 'srv-stuck', title: 'Stuck', kind: 'pr-review' });
  // Not a duplicate-detection test: assert up front that this PR carries no comments,
  // which is what the ingest gate requires a PR workspace to have established.
  ledger.setPriorThreads('srv-stuck', []);
  ledger.ingestRound('srv-stuck', [
    mkFinding({ title: 'SS1', locus: 'pr:7:a.ts:L1' }),
    mkFinding({ title: 'SS2', locus: 'pr:7:b.ts:L2' }),
  ]);
  const fps = ledger.loadLedger('srv-stuck').findings.map((f) => f.fp);
  const job = ledger.addRequest({ action: 'apply', wsId: 'srv-stuck' });

  // The UI's Post: mark in flight, then the runner never shows up.
  await fetch(`${base}/api/features/srv-stuck/review/apply`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fps, status: 'pending-post' }),
  });
  assert.equal(ledger.pendingFindings('srv-stuck').length, 2);

  const res = await fetch(`${base}/api/features/srv-stuck/review/cancel`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: job.id, reason: 'never ran' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.cancelled, 2, 'both pending findings released');
  assert.equal(body.requestDeleted, true, 'the dead job is gone');
  assert.equal(ledger.pendingFindings('srv-stuck').length, 0);
  // Crucially: released, NOT posted.
  for (const f of ledger.loadLedger('srv-stuck').findings) {
    assert.equal(f.postedAt, undefined, 'cancelling must never stamp postedAt');
  }
  assert.ok(!ledger.listRequests().some((r) => r.id === job.id));

  // Idempotent, and tolerant of an already-deleted request.
  const again = await fetch(`${base}/api/features/srv-stuck/review/cancel`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: job.id }),
  });
  assert.equal(again.status, 200);
  const body2 = await again.json();
  assert.equal(body2.cancelled, 0);
  assert.equal(body2.requestDeleted, false);
});

test('POST /review/cancel rejects unknown fps and 404s an unknown workspace', async () => {
  const bad = await fetch(`${base}/api/features/srv-stuck/review/cancel`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fps: ['nope'] }),
  });
  assert.equal(bad.status, 400);

  const missing = await fetch(`${base}/api/features/no-such-ws/review/cancel`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fps: ['abc'] }),
  });
  assert.equal(missing.status, 400, 'unknown workspace has no such finding');
});

test('GET /api/version lets the UI detect a server older than the page it serves', async () => {
  const res = await fetch(`${base}/api/version`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.apiVersion, require('../src/version').API_VERSION);
  assert.ok(body.startedAt, 'exposes when this process started, so "restart it" is verifiable');
  // The web UI compiles the expected version in; drift between the two is the bug this catches.
  const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
  const m = ui.match(/EXPECTED_API_VERSION\s*=\s*'([^']+)'/);
  assert.ok(m, 'web/app.js must declare EXPECTED_API_VERSION');
  assert.equal(m[1], body.apiVersion,
    'web/app.js EXPECTED_API_VERSION and src/version.js API_VERSION must be bumped together');
});

// Read the body of a top-level `function name(` / `async function name(` declaration in a source
// file by matching braces, so these assertions don't depend on how the body is indented.
function fnBody(src, decl) {
  const at = src.indexOf(decl);
  assert.ok(at > -1, `web/app.js must declare ${decl}`);
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error(`unbalanced braces reading ${decl}`);
}

/* Some assertions below forbid a pattern (`&& !r.wsId`, a bare `.wsId` read) that the code's own
 * comments QUOTE, because explaining why a rule was rejected means naming it. A regex over the raw
 * body would read the warning as the mistake and fail on a correct file — and, worse, would pass on
 * a broken one whose comment happened to be reworded. Strip the prose and assert on the code. */
function codeOnly(body) {
  return body.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/* The stylesheet with its comments removed, for the assertions that ask what is still SELECTED.
 * style.css explains its own history at length — including the names of rules that were deleted —
 * and a plain substring search cannot tell "this rule styles .features-grid" from "there is no
 * .features-grid any more". */
function cssRules(css) { return css.replace(/\/\*[\s\S]*?\*\//g, ' '); }

test('U1: the heartbeat timer belongs to the app, not to the per-view poller', () => {
  // Regression guard for the bug that made the first cut of this heartbeat useless: it rode the
  // interval owned by startPolling(), which route() tears down before every render and each view
  // re-arms only at the END of its async render — after an `await api(...)` that throws while the
  // server is down. So the heartbeat died exactly during an outage: a cold load with the server
  // down never got a timer at all, and navigating mid-outage froze the failure count so the banner
  // could neither trip nor clear. Assert the ownership that makes that impossible.
  const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');

  // Exactly one interval in the app, and it must be created at module scope (column 0 — this file
  // indents everything inside a function), i.e. at boot, where navigation cannot reach it.
  const intervals = ui.match(/setInterval\s*\(/g) || [];
  assert.equal(intervals.length, 1, 'the app must have exactly one setInterval');
  assert.match(ui, /^setInterval\(appTick, 4000\);$/m,
    'the sole interval must be armed at module scope at boot and run appTick on the 4s cadence');

  // startPolling/stopPolling may only register/unregister the view callback. If either one grows a
  // timer again the heartbeat is back on a view's lifetime, which is the whole bug.
  const startBody = fnBody(ui, 'function startPolling(');
  const stopBody = fnBody(ui, 'function stopPolling(');
  assert.ok(!/setInterval|setTimeout/.test(startBody),
    'startPolling must not create a timer — the app-level ticker owns the cadence');
  assert.ok(!/clearInterval|clearTimeout/.test(stopBody),
    'stopPolling() must not be able to stop the heartbeat');
  assert.ok(!/\.timer\b/.test(startBody + stopBody),
    'neither startPolling nor stopPolling may hold a timer handle');
  assert.ok(/checkHeartbeat/.test(fnBody(ui, 'async function appTick(')),
    'the app-level ticker must be the thing that runs the heartbeat');

  // And within that ticker the heartbeat must be reached unconditionally: nothing — not a failed
  // /api/requests, not a missing view callback — may return before it.
  const tick = fnBody(ui, 'async function appTick(');
  const heartbeatIdx = tick.indexOf('checkHeartbeat()');
  assert.ok(heartbeatIdx > -1, 'appTick must call checkHeartbeat()');
  assert.ok(!/\breturn\b/.test(tick.slice(0, heartbeatIdx)),
    'appTick must not be able to return before the heartbeat runs');
  assert.ok(tick.indexOf('pollRequestsTick') > heartbeatIdx,
    'the heartbeat must run before the per-view requests poll, not after it');

  // A 404 on /api/version means the server predates the check — reachable, so not a heartbeat
  // failure, but still conclusively the stale side. It must reach the version-mismatch path.
  const heartbeatBody = fnBody(ui, 'async function checkHeartbeat(');
  assert.equal((heartbeatBody.match(/checkVersionMismatch\(/g) || []).length, 2,
    'checkHeartbeat must call checkVersionMismatch on both the ok and the 404 path');
  assert.match(heartbeatBody, /checkVersionMismatch\(null\)/,
    'a 404 must reach checkVersionMismatch with a null version, not be treated as healthy');

  // The debounce: the banner must require more than a single missed heartbeat.
  const thresholdMatch = ui.match(/HEARTBEAT_FAIL_THRESHOLD\s*=\s*(\d+)/);
  assert.ok(thresholdMatch, 'web/app.js must declare HEARTBEAT_FAIL_THRESHOLD');
  assert.ok(Number(thresholdMatch[1]) >= 2, 'a single blip must not be enough to show the unreachable banner');

  // And the banner itself must not be re-created on every failed tick: a fresh role="alert" is
  // re-announced by screen readers, and this fires every 4s for the length of the outage.
  const bannerBody = fnBody(ui, 'function showUnreachableBanner(');
  assert.ok(/textContent\s*=/.test(bannerBody),
    'showUnreachableBanner must update the existing banner\'s text in place');
  // Guard the BEHAVIOUR, not one spelling of it. An earlier version of this assertion only
  // rejected the literal `existing.remove()`, and a re-review proved it: reintroducing the very
  // same bug as `existing.parentNode.removeChild(existing)` left the test passing. Match any way
  // the found node can be detached, and require the early return that keeps it in place.
  const detaches = /\bexisting\b[\s\S]*?\.(remove|removeChild|replaceWith|replaceChildren)\s*\(|\bremoveChild\s*\(\s*existing\s*\)/;
  assert.ok(!detaches.test(bannerBody),
    'showUnreachableBanner must not detach and rebuild the role="alert" node every tick '
    + '(any of .remove/.removeChild/.replaceWith on the existing node)');
  assert.ok(/if\s*\(existing\)\s*\{[\s\S]*?\breturn\b/.test(bannerBody),
    'showUnreachableBanner must return early when the banner already exists, so the node survives');

  // The heartbeat fetch needs a deadline. A dead process refuses instantly, but the outage this
  // whole unit exists for was a WEDGED server: socket accepting, event loop stopped, so a fetch
  // with no timeout never settles and `fails` never leaves 0 — verified with SIGSTOP.
  const hbBody = fnBody(ui, 'async function checkHeartbeat(');
  assert.ok(/AbortSignal\.timeout\(|signal:/.test(hbBody),
    'checkHeartbeat must bound its fetch, or a wedged server is never detected');
});

test('GET /api/runner reports whether the queue is being drained', async () => {
  const res = await fetch(`${base}/api/runner`);
  assert.equal(res.status, 200);
  const s = await res.json();
  assert.equal(s.running, false, 'no runner in a fresh test server');
  assert.deepEqual(Object.keys(s.actions).sort(), ['poll', 'watch'], 'only the two fixed prompts');
  assert.ok('available' in s && 'logPath' in s);
});

test('POST /api/runner refuses anything outside the fixed prompt allowlist', async () => {
  // The whole point: no request body can ever become part of the spawned command.
  for (const action of ['rm -rf /', 'watch; curl evil.example', '', 'audit']) {
    const res = await fetch(`${base}/api/runner`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    assert.equal(res.status, 400, `action ${JSON.stringify(action)} must be rejected`);
  }
  const nonString = await fetch(`${base}/api/runner`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: { toString: 'nope' } }),
  });
  assert.equal(nonString.status, 400);
});

test('DELETE /api/runner is a 409 when nothing is running', async () => {
  const res = await fetch(`${base}/api/runner`, { method: 'DELETE' });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /no runner/i);
});

test('POST /api/requests creates a poll (refresh) job and dedupes it', async () => {
  const first = await fetch(`${base}/api/requests`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'poll', kind: 'pr-review', title: 'Refresh PR Review' }),
  });
  assert.equal(first.status, 201);
  const job = await first.json();
  assert.equal(job.action, 'poll');
  assert.equal(job.kind, 'pr-review');

  // same scope while it's still queued → the existing job, not a second one
  const again = await fetch(`${base}/api/requests`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'poll', kind: 'pr-review', dedupe: true }),
  });
  assert.equal(again.status, 200);
  const dup = await again.json();
  assert.equal(dup.id, job.id);
  assert.equal(dup.deduped, true);

  // a different scope is a different job
  const other = await fetch(`${base}/api/requests`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'poll', kind: 'pr-respond', dedupe: true }),
  });
  assert.equal(other.status, 201);
  assert.notEqual((await other.json()).id, job.id);

  const bad = await fetch(`${base}/api/requests`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'poll', kind: 'spec' }),
  });
  assert.equal(bad.status, 400);
});

test('POST /features/:id/status marks done / reopens; home carries status', async () => {
  const done = await fetch(`${base}/api/features/flow-feat/status`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'done' }),
  });
  assert.equal(done.status, 200);
  assert.equal((await done.json()).status, 'done');

  const home = await (await fetch(`${base}/api/home`)).json();
  assert.equal(home.find((r) => r.id === 'flow-feat').status, 'done', 'home payload carries status');

  const bad = await fetch(`${base}/api/features/flow-feat/status`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'nonsense' }),
  });
  assert.equal(bad.status, 400, 'invalid status rejected');

  // reopen so later assertions see a live workspace
  await fetch(`${base}/api/features/flow-feat/status`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'reworking' }),
  });
});

test('POST /findings/:fp persists a triage decision (approve/edit) and clears on null', async () => {
  const fp = fps()[1];
  const approved = await fetch(`${base}/api/features/flow-feat/findings/${fp}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'approve' }),
  });
  assert.equal(approved.status, 200);
  assert.equal((await approved.json()).decision, 'approve');

  // edit body + decision together
  await fetch(`${base}/api/features/flow-feat/findings/${fp}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ suggestion: 'Edited.', decision: 'edit' }),
  });
  assert.equal(ledger.loadLedger('flow-feat').findings.find((f) => f.fp === fp).decision, 'edit');

  // null clears it
  const cleared = await fetch(`${base}/api/features/flow-feat/findings/${fp}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: null }),
  });
  assert.equal((await cleared.json()).decision, undefined);
});

test('POST /findings/:fp with suggestion edits the proposed comment body', async () => {
  const target = fps()[1];
  const res = await fetch(`${base}/api/features/flow-feat/findings/${target}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ suggestion: 'Edited comment body.' }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).suggestion, 'Edited comment body.');
  const byFp = new Map(ledger.loadLedger('flow-feat').findings.map((f) => [f.fp, f]));
  assert.equal(byFp.get(target).suggestion, 'Edited comment body.');
});

test('POST /findings/:fp with nothing actionable is a 400', async () => {
  const res = await fetch(`${base}/api/features/flow-feat/findings/${fps()[2]}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

// ---------- requests (UI-triggered job queue) ----------

test('POST /findings/:fp/draft accepts a targetRef; /counter records redirect + enqueues a re-audit', async () => {
  const fp = fps()[0];
  // attach a proposal with a machine write target
  const draftRes = await fetch(`${base}/api/features/flow-feat/findings/${fp}/draft`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      before: 'card, PayPal', after: 'card, PayPal, Twint',
      targetRef: { system: 'confluence', pageId: '1', anchor: 'flow', version: 14 },
    }),
  });
  assert.equal(draftRes.status, 200);
  const drafted = await draftRes.json();
  assert.deepEqual(drafted.draft.targetRef, { system: 'confluence', pageId: '1', anchor: 'flow', version: 14 });

  // Reject + counter: records verdict=redirect + note AND enqueues a scoped re-audit
  const res = await fetch(`${base}/api/features/flow-feat/findings/${fp}/counter`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'Change the ADO story instead of the spec.' }),
  });
  assert.equal(res.status, 200);
  const { finding, request } = await res.json();
  assert.equal(finding.draft.review.verdict, 'redirect');
  assert.equal(finding.draft.review.note, 'Change the ADO story instead of the spec.');
  assert.equal(request.action, 're-audit');
  assert.equal(request.wsId, 'flow-feat');
  assert.equal(request.status, 'queued');

  // the re-audit is actually on the queue
  const queue = await (await fetch(`${base}/api/requests?status=queued`)).json();
  assert.ok(queue.some((r) => r.id === request.id && r.action === 're-audit'));

  // empty note → 400 (handler guards before touching the ledger)
  const noNote = await fetch(`${base}/api/features/flow-feat/findings/${fp}/counter`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: '   ' }),
  });
  assert.equal(noNote.status, 400);

  // countering a finding with no draft → 400 (setDraftReview: "no draft to review")
  const noDraft = await fetch(`${base}/api/features/flow-feat/findings/${fps()[1]}/counter`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: 'x' }),
  });
  assert.equal(noDraft.status, 400);
});

test('POST /api/requests creates a request; GET lists + filters by status', async () => {
  const res = await fetch(`${base}/api/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'pr-review', prId: '1481', title: 'Checkout PR' }),
  });
  assert.equal(res.status, 201);
  const created = await res.json();
  assert.equal(created.action, 'pr-review');
  assert.equal(created.prId, '1481');
  assert.equal(created.status, 'queued');
  assert.match(created.id, /^req-\d+$/);

  const listRes = await fetch(`${base}/api/requests`);
  assert.equal(listRes.status, 200);
  const list = await listRes.json();
  assert.ok(list.some((r) => r.id === created.id));

  const queuedRes = await fetch(`${base}/api/requests?status=queued`);
  const queued = await queuedRes.json();
  assert.ok(queued.every((r) => r.status === 'queued'));
  assert.ok(queued.some((r) => r.id === created.id));
});

test('POST /api/requests rejects bad/missing fields with 400', async () => {
  const bad = await fetch(`${base}/api/requests`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'nope' }),
  });
  assert.equal(bad.status, 400);

  const noPr = await fetch(`${base}/api/requests`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'pr-review' }),
  });
  assert.equal(noPr.status, 400);

  const noWs = await fetch(`${base}/api/requests`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'apply' }),
  });
  assert.equal(noWs.status, 400);
});

test('POST /api/requests/:id updates status/note/wsId; unknown id is 404', async () => {
  const created = await (await fetch(`${base}/api/requests`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'pr-respond', prId: '777' }),
  })).json();

  const upd = await fetch(`${base}/api/requests/${created.id}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'done', wsId: 'pr-777-respond' }),
  });
  assert.equal(upd.status, 200);
  const updated = await upd.json();
  assert.equal(updated.status, 'done');
  assert.equal(updated.wsId, 'pr-777-respond');

  const empty = await fetch(`${base}/api/requests/${created.id}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(empty.status, 400);

  const missing = await fetch(`${base}/api/requests/req-nope`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'done' }),
  });
  assert.equal(missing.status, 404);
});

test('POST /api/requests/:id passes phase + needsInput through', async () => {
  const created = await (await fetch(`${base}/api/requests`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'pr-review', prId: '888' }),
  })).json();
  assert.equal(created.phase, null);
  assert.equal(created.needsInput, false);

  const upd = await fetch(`${base}/api/requests/${created.id}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'running', phase: 'fetching PR #888 diff', needsInput: true, note: 'Approve the auth prompt' }),
  });
  assert.equal(upd.status, 200);
  const updated = await upd.json();
  assert.equal(updated.phase, 'fetching PR #888 diff');
  assert.equal(updated.needsInput, true);
  assert.equal(updated.note, 'Approve the auth prompt');

  // phase-only update is accepted (not "nothing to change") and clears needsInput on done
  const done = await (await fetch(`${base}/api/requests/${created.id}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'done', phase: 'review ready' }),
  })).json();
  assert.equal(done.needsInput, false);
  assert.equal(done.phase, 'review ready');
});

// ---------- DELETE routes ----------

test('DELETE /api/features/:id returns 200 { id, deleted:true } and removes the workspace', async () => {
  ledger.createFeature({ id: 'del-via-api', title: 'Delete via API' });

  const res = await fetch(`${base}/api/features/del-via-api`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { id: 'del-via-api', deleted: true, cancelledRequests: [] });

  const get = await fetch(`${base}/api/features/del-via-api`);
  assert.equal(get.status, 404);
});

test('DELETE /api/features/:id returns 404 for an unknown feature', async () => {
  const res = await fetch(`${base}/api/features/no-such-feature-xyz`, { method: 'DELETE' });
  assert.equal(res.status, 404);
});

test('DELETE /api/requests/:id returns 200 and removes the request', async () => {
  const created = await (await fetch(`${base}/api/requests`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'pr-review', prId: '4242' }),
  })).json();

  const res = await fetch(`${base}/api/requests/${created.id}`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { id: created.id, deleted: true });

  const list = await (await fetch(`${base}/api/requests`)).json();
  assert.ok(!list.some((r) => r.id === created.id), 'request must be gone from the list');
});

test('DELETE /api/requests/:id returns 404 for an unknown request', async () => {
  const res = await fetch(`${base}/api/requests/req-nope-server`, { method: 'DELETE' });
  assert.equal(res.status, 404);
});

// ---------- security: the traversal hole (C-1) ----------
//
// `featureId` was validated only in createFeature while every read/write/delete built a path from
// the raw URL segment — and route() percent-decodes segments, so `..%2f..%2fsecret` reached the
// filesystem. A reachable client could DELETE any .json file the server user could write, and read
// one back through the status route.

const TRAVERSAL_IDS = [
  '..%2f..%2foutside%2fsecret',
  '..%2fsecret',
  '%2e%2e%2f%2e%2e%2foutside%2fsecret',
  '..%5c..%5csecret',
  'UPPERCASE',
  'has%20space',
];

test('DELETE with a traversing id is refused and deletes nothing outside the data dir', async () => {
  const outside = path.join(tmpDir, '..', `flowlever-must-survive-${process.pid}.json`);
  fs.writeFileSync(outside, JSON.stringify({ apiToken: 'sk-DO-NOT-LEAK' }));
  try {
    for (const id of TRAVERSAL_IDS) {
      const res = await fetch(`${base}/api/features/${id}`, { method: 'DELETE' });
      assert.ok(res.status === 400 || res.status === 404, `${id} → ${res.status}`);
      const body = await res.json();
      assert.ok(!body.deleted, `${id} must not report a deletion`);
    }
    // the exact path the reviewer used, aimed at the real file
    const rel = path.basename(outside, '.json');
    const res = await fetch(`${base}/api/features/${encodeURIComponent(`../${rel}`)}`, { method: 'DELETE' });
    assert.equal(res.status, 400);
    assert.ok(fs.existsSync(outside), 'a file outside the data dir must survive');
  } finally {
    fs.rmSync(outside, { force: true });
  }
});

test('a traversing id cannot read a file back through the status route', async () => {
  const outside = path.join(tmpDir, '..', `flowlever-leak-${process.pid}.json`);
  fs.writeFileSync(outside, JSON.stringify({ apiToken: 'sk-DO-NOT-LEAK' }));
  try {
    const rel = path.basename(outside, '.json');
    const res = await fetch(`${base}/api/features/${encodeURIComponent(`../${rel}`)}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.ok(!text.includes('sk-DO-NOT-LEAK'), 'the file contents must not come back in the response');
  } finally {
    fs.rmSync(outside, { force: true });
  }
});

test('every id-taking route rejects a traversing id', async () => {
  const id = '..%2f..%2foutside%2fsecret';
  const cases = [
    ['GET', `/api/features/${id}`],
    ['GET', `/api/report/${id}`],
    ['POST', `/api/ingest/${id}`, { findings: [] }],
    ['POST', `/api/features/${id}/review/apply`, { fps: ['x'] }],
    ['POST', `/api/features/${id}/review/cancel`, {}],
    ['POST', `/api/features/${id}/activity`, { lastActivityAt: '2026-01-01T00:00:00.000Z' }],
  ];
  for (const [method, url, body] of cases) {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.ok(res.status === 400 || res.status === 404, `${method} ${url} → ${res.status}`);
    const text = await res.text();
    assert.ok(!/"deleted":\s*true/.test(text), `${method} ${url} must not report success`);
  }
});

// ---------- status-code honesty (C-14) ----------

test('a validation error on a GET is 400, not 404', async () => {
  const bad = await fetch(`${base}/api/requests?status=bogus`);
  assert.equal(bad.status, 400, 'bad input is not a missing resource');
  assert.match((await bad.json()).error, /invalid status/);

  const missing = await fetch(`${base}/api/features/no-such-workspace`);
  assert.equal(missing.status, 404, 'a genuinely absent resource is still 404');
});

// ---------- decisions survive the finish screen (C-8) ----------

test('review/apply reworking keeps the reviewer\'s decision; resolved supersedes it', async () => {
  ledger.createFeature({ id: 'keep-dec-api', title: 'Keep decisions' });
  ledger.ingestRound('keep-dec-api', [
    mkFinding({ title: 'K1', locus: 'k:1' }),
    mkFinding({ title: 'K2', locus: 'k:2' }),
  ]);
  const [a, b] = ledger.loadLedger('keep-dec-api').findings.map((f) => f.fp);
  ledger.setFindingDecision('keep-dec-api', a, 'approve');
  ledger.setFindingDecision('keep-dec-api', b, 'approve');

  const res = await fetch(`${base}/api/features/keep-dec-api/review/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fps: [a], status: 'reworking' }),
  });
  assert.equal(res.status, 200);
  const after = ledger.loadLedger('keep-dec-api').findings.find((f) => f.fp === a);
  assert.equal(after.status, 'reworking');
  assert.equal(after.decision, 'approve', 'marking in-flight is not a re-triage');

  await fetch(`${base}/api/features/keep-dec-api/review/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fps: [b], status: 'resolved' }),
  });
  const resolved = ledger.loadLedger('keep-dec-api').findings.find((f) => f.fp === b);
  assert.equal(resolved.decision, undefined, 'a real completion still supersedes the decision');
});

test('review/apply reports which findings it skipped', async () => {
  ledger.createFeature({ id: 'skip-api', title: 'Skips' });
  ledger.ingestRound('skip-api', [
    mkFinding({ title: 'S1', locus: 's:1' }),
    mkFinding({ title: 'S2', locus: 's:2' }),
  ]);
  const [live, gone] = ledger.loadLedger('skip-api').findings.map((f) => f.fp);
  ledger.setFindingStatus('skip-api', gone, { status: 'waived', reason: 'not doing it' });

  const res = await fetch(`${base}/api/features/skip-api/review/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fps: [live, gone], status: 'pending-apply' }),
  });
  const body = await res.json();
  assert.equal(body.updated, 1);
  assert.deepEqual(body.skipped, [{ fp: gone, reason: 'waived' }], 'the caller learns WHICH was dropped');
});

// ---------- the fix gate over HTTP (C-4) ----------

test('posting an agreed code fix over HTTP refuses a missing or malformed sha', async () => {
  ledger.createFeature({ id: 'gate-api', title: 'Gate', kind: 'pr-respond' });
  // Not a duplicate-detection test: assert up front that this PR carries no comments,
  // which is what the ingest gate requires a PR workspace to have established.
  ledger.setPriorThreads('gate-api', []);
  ledger.ingestRound('gate-api', [mkFinding({ title: 'G1', locus: 'pr:1:a.cs:1' })]);
  const fp = ledger.loadLedger('gate-api').findings[0].fp;
  ledger.setFindingDraft('gate-api', fp, { before: 'old', after: 'new' });
  ledger.setFindingDecision('gate-api', fp, 'fix-only');

  const post = (payload) => fetch(`${base}/api/features/gate-api/review/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fps: [fp], status: 'posted', ...payload }),
  });

  const noSha = await post({});
  assert.equal(noSha.status, 400);
  assert.match((await noSha.json()).error, /cannot be marked posted without the commit/);

  const junk = await post({ sha: 'lol-no-commit' });
  assert.equal(junk.status, 400, 'the API used to accept any non-empty string');
  assert.match((await junk.json()).error, /invalid commit sha/);

  const ok = await post({ sha: 'a1b2c3d4e5f6' });
  assert.equal(ok.status, 200);
  assert.equal(ledger.loadLedger('gate-api').findings[0].fixCommit.sha, 'a1b2c3d4e5f6');
});

// ---------- config + scope + HEAD ----------

test('GET /api/config serves the real merged config, plus this server\'s read-only mode', async () => {
  const res = await fetch(`${base}/api/config`);
  assert.equal(res.status, 200);
  const cfg = await res.json();
  // The original point of this test stands: every documented config key must come from
  // loadConfig() rather than a hardcoded copy in the server, which is what silently drifted the
  // moment anyone edited config.json. Assert that key-by-key rather than by deep-equality on the
  // whole body, so the response can also carry server state without loosening the guarantee.
  const real = ledger.loadConfig();
  for (const [k, v] of Object.entries(real)) {
    assert.deepEqual(cfg[k], v, `${k} must be served from the real config, not a copy`);
  }
  assert.equal(typeof cfg.gates.readyThreshold, 'number');
  assert.equal(typeof cfg.gates.scoreZeroAtPenalty, 'number');
  // `readOnly` rides along because the page needs the mode at boot and already fetches this once.
  // It must be present and false here: read-only is opt-in, never the default.
  assert.equal(cfg.readOnly, false);
  assert.ok(!('readOnly' in real), 'readOnly is server state, not a config.json key');
});

test('POST /api/ingest honours scope and rejects a malformed one', async () => {
  ledger.createFeature({ id: 'scope-api', title: 'Scoped' });
  ledger.ingestRound('scope-api', [
    mkFinding({ severity: 'blocker', title: 'BE', locus: 'be:1', dimension: 'feasibility' }),
    mkFinding({ title: 'FE', locus: 'fe:1', dimension: 'design-match' }),
  ]);

  const res = await fetch(`${base}/api/ingest/scope-api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      findings: [mkFinding({ title: 'FE', locus: 'fe:1', dimension: 'design-match' })],
      scope: { dimensions: ['design-match'] },
    }),
  });
  assert.equal(res.status, 200);
  const { stats } = await res.json();
  assert.equal(stats.autoResolved, 0, 'the out-of-scope blocker must not be closed');
  assert.equal(stats.outOfScopeSkipped, 1);
  assert.equal(ledger.readiness('scope-api').gate, 'not-ready');

  const bad = await fetch(`${base}/api/ingest/scope-api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ findings: [], scope: 'front-end only' }),
  });
  assert.equal(bad.status, 400);
});

test('HEAD on a static file returns headers, not 405', async () => {
  const res = await fetch(`${base}/app.js`, { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.ok(Number(res.headers.get('content-length')) > 0);
  assert.equal((await res.text()).length, 0, 'HEAD carries no body');

  const post = await fetch(`${base}/app.js`, { method: 'POST' });
  assert.equal(post.status, 405, 'other methods are still refused');
});

test('the static handler still refuses traversal out of web/', async () => {
  for (const p of ['/../src/ledger.js', '/..%2fsrc%2fledger.js', '/../../etc/passwd']) {
    const res = await fetch(`${base}${p}`);
    assert.equal(res.status, 404, `${p} → ${res.status}`);
  }
});

test('X-2: an unreadable workspace file is reported, not silently dropped from the board', async () => {
  // The first fix stopped one bad file from 400ing the whole board, but then omitted it with only a
  // stderr warning — so the workspace simply vanished from the UI and the inbox stopped nagging.
  const bad = path.join(tmpDir, 'features', 'x2-truncated.json');
  fs.writeFileSync(bad, '{ "title": "truncated');
  try {
    const res = await fetch(`${base}/api/features`);
    assert.equal(res.status, 200, 'healthy workspaces still list');
    assert.equal(res.headers.get('x-flowlever-skipped'), '1', 'the count rides on a header');
    const body = await res.json();
    assert.ok(Array.isArray(body), 'the array shape is preserved for existing clients');
    assert.ok(body.some((f) => f.id === 'flow-feat'), 'the healthy workspace is present');

    const home = await fetch(`${base}/api/home`);
    assert.equal(home.status, 200);
    assert.equal(home.headers.get('x-flowlever-skipped'), '1', 'the inbox flags it too');

    // ...and the detail is retrievable from inside the product, not only from the server's stdout.
    const diag = await fetch(`${base}/api/diagnostics`);
    assert.equal(diag.status, 200);
    const d = await diag.json();
    assert.equal(d.skippedWorkspaces.length, 1);
    assert.equal(d.skippedWorkspaces[0].file, 'x2-truncated.json');
    assert.match(d.skippedWorkspaces[0].reason, /not valid JSON/);
    assert.equal(typeof d.lockWaitMs, 'number');
    assert.equal(d.loopback, true);
  } finally {
    fs.rmSync(bad, { force: true });
  }
});

test('a lock timeout answers 503 with Retry-After, not 400', async () => {
  // A contended lock is transient: "try again", not "your request was wrong". The server also runs a
  // much shorter lock ceiling than the CLI, because waiting blocks its event loop.
  const lock = path.join(tmpDir, 'requests.json.lock');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner'), `999999\n${Date.now()}\n`);   // fresh, so not stale
  try {
    const started = Date.now();
    const res = await fetch(`${base}/api/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'pr-review', prId: '4242' }),
    });
    const waited = Date.now() - started;
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('retry-after'), '1');
    assert.match((await res.json()).error, /timed out waiting for a lock/);
    assert.ok(waited < 6000, `the server must fail fast, waited ${waited}ms`);
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
});

test('Z-1: every write route answers 503 on a lock timeout, not 400', async () => {
  // handleFeatureStatus and handleFeatureActivity caught EUSER themselves and reported 400, so the
  // central lockTimeout->503 mapping never saw them: a write that merely collided with the CLI was
  // reported as a bad request. Genuine bad input must still be 400.
  ledger.createFeature({ id: 'z1-ws', title: 'Z1' });
  const lock = path.join(tmpDir, 'features', 'z1-ws.json.lock');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner'), `999999\n${Date.now()}\n`);
  try {
    for (const [route, body] of [
      ['status', { status: 'done' }],
      ['activity', { lastActivityBy: 'someone' }],
    ]) {
      const res = await fetch(`${base}/api/features/z1-ws/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 503, `${route} must report a lock timeout as transient`);
      assert.equal(res.headers.get('retry-after'), '1', `${route} must say when to retry`);
    }
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }

  const ok = await fetch(`${base}/api/features/z1-ws/status`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'done' }),
  });
  assert.equal(ok.status, 200, 'and it works once the lock clears');
  const bad = await fetch(`${base}/api/features/z1-ws/status`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'bogus' }),
  });
  assert.equal(bad.status, 400, 'a real validation error is still a bad request');
});

test('the whole of 127.0.0.0/8 counts as loopback, not just 127.0.0.1', () => {
  // The documented friendly-hostname recipe binds an lo0 alias (FLOWLEVER_HOST=127.94.41.73). An
  // exact-string loopback check called that "remote", which would have made the API read-only and
  // refused the runner for a setup this project tells you to use. (Binding a 127.x alias needs
  // `ifconfig lo0 alias` root privileges, so the predicate is asserted directly.)
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const start = src.indexOf('function isLoopbackHost');
  const end = src.indexOf('const IS_LOOPBACK');
  assert.ok(start > -1 && end > start, 'isLoopbackHost must exist ahead of IS_LOOPBACK');
  // eslint-disable-next-line no-new-func
  const isLoopbackHost = new Function(`${src.slice(start, end)}; return isLoopbackHost;`)();

  for (const host of ['127.0.0.1', '127.94.41.73', '127.1.2.3', '127.255.255.254', 'localhost', '::1']) {
    assert.equal(isLoopbackHost(host), true, `${host} is loopback`);
  }
  for (const host of ['0.0.0.0', '192.168.1.5', '10.0.0.1', '128.0.0.1', '27.0.0.1', '127.0.0.999', 'evil.com', '']) {
    assert.equal(isLoopbackHost(host), false, `${host} is NOT loopback`);
  }
});

test('U2: approveAllRemaining only ever touches currently-undecided findings', () => {
  // No bulk-decision endpoint exists server-side (only /review/apply, which bulk-sets finding
  // *status* for the post/apply hand-off — not the `decision` field a single Approve writes), so
  // this whole unit lives client-side. Assert the source-level guarantee that matters most: a
  // reviewer's considered Dismiss/Edit/Redirect/Waive/Skip can never be silently overturned by the
  // bulk action, and it never posts.
  const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
  const undecidedBody = fnBody(ui, 'function undecidedFlowFps(');
  // Must read the decisions map directly, not go through flowDecisionKind() — that helper falls
  // back to 'skip' both for "never decided" AND for an explicit Skip (pr-respond/spec have a real
  // Skip button), so using it here would let a bulk approve overturn a considered Skip.
  assert.ok(/!state\.flow\.decisions\[/.test(undecidedBody),
    'undecidedFlowFps must test the decisions map directly, not flowDecisionKind()');
  assert.ok(!/flowDecisionKind/.test(undecidedBody),
    'undecidedFlowFps must not go through flowDecisionKind() — it collapses "never decided" and "explicit Skip" into one bucket');

  const bulkBody = fnBody(ui, 'async function approveAllRemaining(');
  assert.ok(/undecidedFlowFps\(\)/.test(bulkBody),
    'approveAllRemaining must source its target fps from undecidedFlowFps(), not from every flow item');
  // The previous version of this guard only blacklisted `.map`/`.forEach`/`.filter` called on
  // `state.flow.items`, so a `for..of state.flow.items`, a classic indexed `for` loop, a
  // `for..in`, `state.flow.items[i]`, `...state.flow.items`, or `Object.keys(state.flow.items)`
  // all sailed straight through it untouched. A reviewer proved this concretely with a `for..of`
  // mutation that iterated every item and flipped an already-Dismissed finding to Approved —
  // the suite stayed green at 208/208. There is no syntax-form denylist that reliably covers
  // every one of those (and whatever's invented next); the only real invariant is that this
  // function has no legitimate reason to reference `state.flow.items` AT ALL — undecidedFlowFps()
  // is the sole approved way in. So assert the literal string is simply absent from the body.
  assert.ok(!/state\.flow\.items/.test(bulkBody),
    'approveAllRemaining must never reference state.flow.items directly (by .map/.forEach/.filter, '
    + 'for..of, a classic for(;;), for..in, indexing, spread, Object.keys, or any other traversal) '
    + '— undecidedFlowFps() must be the only way it reads the undecided set');
  assert.ok(!/enqueueApply|postBack\(|\/review\/apply/.test(bulkBody),
    'approveAllRemaining must never post or enqueue a post — Post stays a separate, explicit click');
});

/* Guarding the one path in the UI that causes a write to somebody else's pull request.
 *
 * `reject` became a decision kind so the bulk approve-all could not silently overturn a
 * considered rejection. That promotion had a consequence nothing caught: flowDecisionKind() now
 * returns 'reject' instead of falling back to 'skip', so in persistTriage the finding stopped
 * hitting the `continue` and fell through to the `else` that pushes items into the post set and
 * marks them pending-post for the runner. A finding the reviewer explicitly rejected would have
 * been posted as a comment — while the Post button, which counts only accept/edit, said nothing
 * about it. The whole suite stayed green through that, so the invariant gets its own test. */
test('U2: persistTriage never carries a rejected or undecided finding into the post set', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
  const body = fnBody(ui, 'async function persistTriage(');

  // Both non-decisions must bail BEFORE the branch that fills postFps.
  const elseIdx = body.indexOf('postFps.push');
  assert.ok(elseIdx > 0, 'persistTriage still builds a postFps set');
  const beforePush = body.slice(0, elseIdx);
  for (const kind of ['skip', 'reject']) {
    const guard = new RegExp(`k === '${kind}'\\s*\\)\\s*continue;`);
    assert.ok(guard.test(beforePush),
      `persistTriage must skip '${kind}' before anything reaches postFps.push — `
      + `a '${kind}' finding must never be handed to the runner to post`);
  }

  // And a rejected finding must not be quietly re-labelled as a dismissal either: Dismiss waives
  // the finding, Reject only refuses the proposed change. Conflating them loses the distinction
  // the reviewer drew.
  assert.ok(!/waiveItems\.push[^;]*'reject'/.test(body),
    'a reject must not be recorded as a waive — they are different reviewer intents');
});

test('U2: the approve-all control requires an inline confirm before it can act', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
  const body = fnBody(ui, 'function approveAllControl(');
  assert.ok(!/window\.confirm|window\.alert/.test(body),
    'must not use window.confirm/alert — this app builds confirms with h()');
  assert.ok(/confirmApproveAll/.test(body),
    'the write must be gated behind a two-step confirm flag, like stepWaiveForm');
  assert.ok(/approveAllRemaining\(/.test(body),
    'the confirmed branch must be able to actually call approveAllRemaining');
  // Renders nothing when nothing is undecided, so it can never invite approving an already-clear
  // batch. The previous version of this check just tested that SOME `return null` existed
  // ANYWHERE in the body — which the function also does for the unrelated `kind !== 'pr-review'`
  // early return, so a reviewer could delete the actual "nothing undecided → render nothing"
  // guard entirely and this test kept passing. Anchor on the specific guard, not the substring.
  assert.ok(/const fps = undecidedFlowFps\(\);/.test(body),
    'approveAllControl must derive its fps from undecidedFlowFps()');
  assert.ok(/if\s*\(\s*!fps\.length\s*\)\s*return null;/.test(body),
    'approveAllControl must return null specifically when the undecided-fps set is empty — not '
    + 'merely contain the text "return null" somewhere else in the function (e.g. the kind guard)');
});

test('U2: the zero-post label names the remaining work instead of dead-ending', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
  const body = fnBody(ui, 'function postActionEl(');
  assert.ok(/still undecided/.test(body),
    'postActionEl must name the undecided count instead of just restating "Post 0 …"');
  // The already-correct disabled gate on the Post button must survive intact — the U2 unit was
  // only allowed to change the label above it. Read-only mode later added a term IN FRONT of this
  // condition (a cockpit that cannot write must not offer to post), which is an addition rather
  // than a rewrite, so the original clause is still asserted verbatim here.
  assert.ok(/\(postN === 0 && !posted && !errored && !stalled && !unconfirmed\)/.test(body),
    'the original Post-button disabled condition must survive intact');
  assert.ok(/disabled: readOnlyMode\(\) \|\| active/.test(body),
    'read-only must also disable Post — it is the control that reaches a real pull request');
});

/* The other half of the zero-post screen, and the one the U2 label could not reach: a reviewer who
 * DECIDES every finding away (dismiss/reject on all of them) has nothing left to decide, so "N still
 * undecided" does not apply — and what they were shown instead was a disabled "Post 0 comments to
 * PR #5869" under the section label "Post comments — nothing is sent until you click this", plus a
 * next-step note promising a post back to the PR. Three sentences about an action that can never
 * happen. Nothing postable and nothing left to decide is an END STATE, and the screen has to say so
 * rather than render a control that counts to zero. */
test('the finish screen offers no Post button when every decision posts nothing', () => {
  const ui = readUi();
  const state = {};
  const { nothingLeftToPost } = liftUi(ui, [
    fnSource(ui, 'const POSTABLE_DECISIONS = '),
    'const JOB_STALE_MS = 3 * 60 * 1000;',
    'function isOpenish(', 'function isPosted(', 'function isApplied(', 'function isPending(',
    'function jobAgeMs(', 'function isStaleJob(',
    'function flowDecisionKind(', 'function undecidedFlowFps(',
    'function postJobState(', 'function nothingLeftToPost(',
  ], { state, runnerBusy: () => false });

  const fps = ['a', 'b', 'c', 'd'];
  const decide = (kinds, applyReqs = []) => {
    state.flow = {
      items: fps,
      decisions: Object.fromEntries(fps.map((fp, i) => (kinds[i] ? [fp, { kind: kinds[i] }] : []))
        .filter((e) => e.length)),
      applyReqs,
    };
  };
  // Findings the reviewer dismissed are `waived` in the ledger, so none of them is still pending a
  // post — which is what makes this an end state rather than an unfinished one.
  const data = { feature: { kind: 'pr-review' }, ledger: { findings: fps.map((fp) => ({ fp, status: 'waived' })) } };

  decide(['waive', 'waive', 'waive', 'waive']);
  assert.equal(nothingLeftToPost(data), true,
    'every finding dismissed and nothing postable is a dead end — no Post control belongs on it');

  decide(['waive', 'reject', 'waive', 'reject']);
  assert.equal(nothingLeftToPost(data), true,
    'a Reject posts nothing either — the mix of refusals is still a dead end');

  // The two states that are NOT dead ends, and must keep their button:
  decide(['accept', 'waive', 'waive', 'waive']);
  assert.equal(nothingLeftToPost(data), false,
    'one approved comment is a post — the button must stay');
  decide(['waive', 'waive', 'waive', null]);
  assert.equal(nothingLeftToPost(data), false,
    'an undecided finding is unfinished work, not an empty post set — U2\'s "still undecided" label owns it');

  // A post that already ran (or failed) keeps its own control — "Post again" / "Retry post" — so the
  // empty state must not swallow the reviewer's way back to it.
  const pending = { feature: data.feature, ledger: { findings: fps.map((fp) => ({ fp, status: 'open', pending: true })) } };
  decide(['waive', 'waive', 'waive', 'waive'], [{ id: '1', status: 'error', note: 'auth' }]);
  assert.equal(nothingLeftToPost(data), false, 'a failed post keeps its Retry');
  decide(['waive', 'waive', 'waive', 'waive'], [{ id: '1', status: 'done' }]);
  assert.equal(nothingLeftToPost(data), false, 'a finished post keeps its "post again"');
  assert.equal(nothingLeftToPost(pending), false,
    'and a post that finished without confirming its items keeps its Retry too');

  // The two callers must both route through this one predicate, so the control and the note beneath
  // it can never disagree about whether a post is still ahead.
  assert.match(codeOnly(fnBody(ui, 'function postActionEl(')), /if \(nothingLeftToPost\(data\)\) return postEmptyEl\(kind\);/,
    'postActionEl must swap the whole Post control for the empty state, not merely relabel it');
  assert.match(codeOnly(fnBody(ui, 'function nextStepNote(')), /nothingLeftToPost\(data\)/,
    'nextStepNote must stop promising "post back to the PR" when there is nothing to post');
  const empty = codeOnly(fnBody(ui, 'function postEmptyEl('));
  assert.ok(!/h\('button'/.test(empty), 'the empty state must not draw a button of its own');
  for (const live of ['.finish-post-empty', '.post-empty-msg', '.post-empty-hint']) {
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'web', 'style.css'), 'utf8'),
      new RegExp(`\\${live}(?![\\w-])`), `style.css must style ${live} — the empty state draws it`);
  }
});

/* Regression guard for NEW-3: route()'s two confirm resets have no test coverage of their own
 * today — a reviewer deleted the `confirmApproveAll` reset line entirely and the whole 209-test
 * suite stayed green, because nothing ever asserted route() clears either flag. Both resets exist
 * for the identical reason (a confirm armed on the finish screen must not survive navigating away
 * and back to the SAME feature, since that path skips initFlow's fresh-state reset) and both guard
 * a real write — confirmApproveAll gates approveAllRemaining, confirmApply gates a live write to
 * ADO/Confluence — so losing either silently re-arms a "one click from a real write" state. */
/* U3: editing a proposed comment/note used to strand the keyboard — Escape cancelled, but
 * committing meant reaching for the mouse to click "Save & approve" / "Save note". The fix must
 * (a) let Cmd/Ctrl+Enter submit through the SAME function the button calls, in both the spec and
 * PR branches, so button and shortcut can never diverge; (b) leave bare Enter alone, since these
 * are multi-line bodies; and (c) advertise the shortcut next to the buttons it duplicates. */
test('U3: Cmd/Ctrl+Enter submits the comment editor via the same path as the Save button', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');

  // The submit chord lives in exactly one place — both textareas wire onkeydown through it — so a
  // future edit to one branch cannot silently leave the other without a keyboard submit.
  const keydownBody = fnBody(ui, 'function commentEditTaKeydown(');
  assert.match(keydownBody, /e\.key === 'Enter' && \(e\.metaKey \|\| e\.ctrlKey\)/,
    'commentEditTaKeydown must require Cmd OR Ctrl with Enter — accepting either is what makes '
    + 'this work on macOS and elsewhere without platform sniffing');
  assert.match(keydownBody, /e\.preventDefault\(\)/,
    'the chord must preventDefault, or the newline is inserted in addition to submitting');
  assert.match(keydownBody, /e\.key === 'Escape'/,
    'Escape must still be handled by the shared handler, so cancel behaviour cannot regress');

  // Bare Enter must never reach a submit call on its own — only the guarded chord above may. If a
  // regression added an unconditional `if (e.key === 'Enter')` branch, this would catch it.
  assert.ok(!/e\.key === 'Enter'\)/.test(keydownBody.replace(/e\.key === 'Enter' && \(e\.metaKey \|\| e\.ctrlKey\)/, '')),
    'bare Enter (no modifier) must not be wired to submit — these are multi-line bodies');

  // commentEditTaKeydown must be the ONLY place in the app that binds this chord: if a second,
  // divergent binding shows up (e.g. someone hand-rolls the condition again on a new textarea)
  // this count moves, which is the drift this unit exists to prevent.
  const chordSites = (ui.match(/e\.key === 'Enter' && \(e\.metaKey \|\| e\.ctrlKey\)/g) || []).length;
  assert.equal(chordSites, 1, 'the Cmd/Ctrl+Enter condition must be defined once and reused');

  const formBody = fnBody(ui, 'function commentEditForm(');
  // Spec branch (note textarea): the button's onclick and the textarea's onkeydown must call the
  // exact same function reference, not two separate calls into saveSpecNote — otherwise a future
  // edit to one could change what gets saved without touching the other.
  assert.match(formBody, /onkeydown:\s*commentEditTaKeydown\(cancel,\s*submitNote\)/,
    'the spec-branch textarea must route Cmd/Ctrl+Enter through the same submitNote used by the button');
  assert.match(formBody, /onclick:\s*submitNote\s*\}/,
    'the "Save note" button must call submitNote, the same function the keyboard shortcut calls');

  // PR branch (proposed-comment textarea): same requirement, via submitComment.
  assert.match(formBody, /onkeydown:\s*commentEditTaKeydown\(cancel,\s*submitComment\)/,
    'the PR-branch textarea must route Cmd/Ctrl+Enter through the same submitComment used by the button');
  assert.match(formBody, /onclick:\s*submitComment\s*\}/,
    'the "Save & approve" button must call submitComment, the same function the keyboard shortcut calls');

  // Discoverability: the shortcut hint must actually be rendered next to both action rows, not
  // just exist in code with nothing pointing at it (the U-5 register this unit follows).
  const hintSites = (formBody.match(/saveKbdHint\(\)/g) || []).length;
  assert.equal(hintSites, 2, 'saveKbdHint() must be rendered in both the spec and PR action rows');

  // The global decide-loop handler must remain blind to this chord: it already refuses to fire
  // while any modifier is held, which is what stops Cmd/Ctrl+Enter from also being read as a
  // one-letter decide-loop key while the editor is open. If that guard is ever narrowed to only
  // cover a subset of modifiers, this chord would start leaking into the decide loop.
  const docKeydown = ui.slice(ui.indexOf("document.addEventListener('keydown'"));
  assert.match(docKeydown, /!e\.metaKey && !e\.ctrlKey && !e\.altKey/,
    'the decide-loop branch must still exclude all modifier keys, so Cmd/Ctrl+Enter can never '
    + 'be misread as a one-letter decision');
});

test('NEW-3: route() disarms both finish-screen confirms on every navigation', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
  const body = fnBody(ui, 'function route(');
  assert.ok(/state\.flow\.confirmApproveAll\s*=\s*false;/.test(body),
    'route() must reset state.flow.confirmApproveAll = false on every navigation');
  assert.ok(/state\.flow\.confirmApply\s*=\s*false;/.test(body),
    'route() must reset state.flow.confirmApply = false on every navigation — it gates a real '
    + 'write to ADO/Confluence and is the higher-stakes sibling of confirmApproveAll');
});

/* Sorting the Done list. The comparator lives in browser code the Node suite cannot import, so
 * these are source assertions — but they pin the two properties that would actually break it: the
 * menu must be generated from the same table the comparator reads (otherwise it can offer an order
 * nothing implements, the DECIDE_KEYS failure mode), and a workspace with no date must sink rather
 * than lead (an undated entry sorting first would put the least-known work at the top of a list
 * whose whole purpose is recency). The ordering itself is verified in a real browser. */
test('the Done sort menu and its comparator read one table, and undated rows sink', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');

  const table = ui.match(/const DONE_SORTS = \{[\s\S]*?\n\};/);
  assert.ok(table, 'DONE_SORTS must exist as the single source of truth');
  for (const key of ['reviewed', 'modified', 'title']) {
    assert.ok(new RegExp(`\\b${key}:`).test(table[0]), `DONE_SORTS must define "${key}"`);
  }

  const disc = fnBody(ui, 'function doneDisclosure(');
  assert.ok(/Object\.entries\(DONE_SORTS\)/.test(disc),
    'the <select> options must be generated from DONE_SORTS, not hand-listed alongside it');
  assert.ok(/e\.stopPropagation\(\)/.test(disc),
    'the menu sits inside a <summary>, so its events must not bubble into the disclosure toggle');

  const cmp = fnBody(ui, 'function sortDonePairs(');
  assert.ok(/if \(!av\) return 1;/.test(cmp) && /if \(!bv\) return -1;/.test(cmp),
    'a row with no timestamp must sort LAST in sortDonePairs, never first');
  assert.ok(/localeCompare\(String\(av\)\)/.test(cmp),
    'timestamps are ISO strings and must be compared newest-first (b vs a)');

  // The two date labels the user picks between must be the same words the rows print, or the sort
  // is unverifiable by eye — this is what made the first cut of the feature unusable.
  const dates = fnBody(ui, 'function doneDatesRow(');
  assert.ok(/'Last reviewed'/.test(dates) && /'Last modified'/.test(dates),
    'doneDatesRow must label the dates exactly as the sort menu names them');
  assert.ok(/DONE_SORTS/.test(table[0]) && /'Last reviewed'/.test(table[0])
    && /'Last modified'/.test(table[0]),
    'and DONE_SORTS must use those same labels');
});

/* The canonical per-workspace `state`. It is computed in the ledger and served by BOTH list
 * endpoints, because the inbox and the section lists show the same workspaces and a card that
 * says "needs review" in one place and "awaiting author" in the other is worse than either. */
test('GET /api/home and /api/features agree on one canonical state per workspace', async () => {
  ledger.createFeature({ id: 'state-fresh', title: 'Fresh Review', kind: 'pr-review' });
  ledger.setPriorThreads('state-fresh', []);   // pr-review ingest is gated on the prior-thread record
  ledger.ingestRound('state-fresh', [mkFinding({ title: 'Untouched finding', locus: 'pr:1:a.cs:L1' })], { note: 'seed' });

  const home = await (await fetch(`${base}/api/home`)).json();
  const list = await (await fetch(`${base}/api/features?kind=pr-review`)).json();
  const hrow = home.find((r) => r.id === 'state-fresh');
  const lrow = list.find((r) => r.id === 'state-fresh');
  assert.ok(hrow && lrow, 'the workspace appears on both endpoints');
  assert.equal(hrow.state, 'needs-review', 'an undecided first-round finding needs a review');
  assert.equal(lrow.state, hrow.state, 'the two endpoints must never disagree');
  assert.ok(ledger.WORKSPACE_STATES.some((s) => s.state === hrow.state),
    'every served state must be one the WORKSPACE_STATES table knows how to band');
});

/* /api/features served no counts at all, so a section card could not show the bits an inbox row
 * shows. Both now read ONE count helper — asserting they agree is what stops a second copy of
 * the loop being reintroduced and quietly drifting. */
test('GET /api/features carries the same counts block as /api/home', async () => {
  const home = await (await fetch(`${base}/api/home`)).json();
  const list = await (await fetch(`${base}/api/features`)).json();
  for (const hrow of home) {
    const lrow = list.find((r) => r.id === hrow.id);
    if (!lrow) continue;   // /api/home drops nothing, but don't let a skipped workspace fail this
    assert.deepEqual(lrow.counts, hrow.counts, `counts differ for ${hrow.id}`);
  }
  const fresh = list.find((r) => r.id === 'state-fresh');
  assert.deepEqual(Object.keys(fresh.counts).sort(),
    ['open', 'posted', 'resolved', 'reworking', 'toReview', 'waived']);
  assert.equal(fresh.counts.open, 1);
});

test('GET /api/features reports the real states of posted / decided / done workspaces', async () => {
  // Posted, and the PR has NOT moved since our round → the user is waiting on the author.
  ledger.createFeature({ id: 'state-posted', title: 'Posted Review', kind: 'pr-review' });
  ledger.setPriorThreads('state-posted', []);   // pr-review ingest is gated on the prior-thread record
  ledger.ingestRound('state-posted', [mkFinding({ title: 'Posted finding', locus: 'pr:2:a.cs:L1' })], { note: 'seed' });
  const postedFp = ledger.loadLedger('state-posted').findings[0].fp;
  await fetch(`${base}/api/features/state-posted/review/apply`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fps: [postedFp], status: 'posted' }),
  });

  // Decided but nothing out yet → the next move is the Post button.
  ledger.createFeature({ id: 'state-ready', title: 'Ready Review', kind: 'pr-review' });
  ledger.setPriorThreads('state-ready', []);   // pr-review ingest is gated on the prior-thread record
  ledger.ingestRound('state-ready', [mkFinding({ title: 'Decided finding', locus: 'pr:3:a.cs:L1' })], { note: 'seed' });
  const readyFp = ledger.loadLedger('state-ready').findings[0].fp;
  await fetch(`${base}/api/features/state-ready/findings/${readyFp}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'approve' }),
  });

  const byId = new Map((await (await fetch(`${base}/api/features?kind=pr-review`)).json()).map((r) => [r.id, r]));
  assert.equal(byId.get('state-posted').state, 'awaiting-author');
  assert.equal(byId.get('state-ready').state, 'ready-to-post');

  // Closing the workspace overrides everything still on its findings.
  await fetch(`${base}/api/features/state-posted/status`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'done' }),
  });
  const after = (await (await fetch(`${base}/api/features?kind=pr-review`)).json()).find((r) => r.id === 'state-posted');
  assert.equal(after.state, 'done');
  const hafter = (await (await fetch(`${base}/api/home`)).json()).find((r) => r.id === 'state-posted');
  assert.equal(hafter.state, 'done', 'and the inbox says the same');
});

/* The runner flipping "the author replied" must move the workspace out of the waiting band and
 * back into needs-you — that transition is the whole reason the state is recomputed per request
 * rather than stamped once. */
test('activity flagged as author-responded moves a waiting workspace to author-responded', async () => {
  ledger.createFeature({ id: 'state-responded', title: 'Responded Review', kind: 'pr-review' });
  ledger.setPriorThreads('state-responded', []);   // pr-review ingest is gated on the prior-thread record
  ledger.ingestRound('state-responded', [mkFinding({ title: 'Replied-to finding', locus: 'pr:4:a.cs:L1' })], { note: 'seed' });
  const fp = ledger.loadLedger('state-responded').findings[0].fp;
  await fetch(`${base}/api/features/state-responded/review/apply`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fps: [fp], status: 'posted' }),
  });
  const before = (await (await fetch(`${base}/api/features?kind=pr-review`)).json()).find((r) => r.id === 'state-responded');
  assert.equal(before.state, 'awaiting-author');

  await fetch(`${base}/api/features/state-responded/activity`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authorResponded: true, note: '1 new reply' }),
  });
  const after = (await (await fetch(`${base}/api/features?kind=pr-review`)).json()).find((r) => r.id === 'state-responded');
  assert.equal(after.state, 'author-responded');
});

/* U2: the kind sections draw four ordered bands. The renderer is browser code the Node suite
 * cannot import, so these are source assertions — but they pin the properties that would actually
 * break it: the order must be expressed once (the DECIDE_KEYS failure mode), the browser's
 * taxonomy must agree with the ledger's, an unknown state must fall back rather than crash, and an
 * empty band must not be drawn. The rendering itself is verified in a real browser. */
function readUi() { return fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8'); }

/* Parses WS_BANDS/WS_STATES out of web/app.js. Reading the real tables rather than restating them
 * here is the point: a test carrying its own copy of the order is the very duplication it exists
 * to forbid. */
function wsTables(ui) {
  const bandsSrc = ui.match(/const WS_BANDS = \[[\s\S]*?\n\];/);
  const statesSrc = ui.match(/const WS_STATES = \[[\s\S]*?\n\];/);
  assert.ok(bandsSrc, 'web/app.js must declare WS_BANDS as the single source of band order');
  assert.ok(statesSrc, 'web/app.js must declare WS_STATES as the single source of state rank');
  const bands = [...bandsSrc[0].matchAll(/\{\s*key:\s*'([^']+)',\s*label:\s*'([^']+)',\s*density:\s*'([^']+)'/g)]
    .map((m) => ({ key: m[1], label: m[2], density: m[3] }));
  const states = [...statesSrc[0].matchAll(/\{\s*key:\s*'([^']+)',\s*band:\s*'([^']+)',\s*label:\s*'([^']+)'/g)]
    .map((m) => ({ key: m[1], band: m[2], label: m[3] }));
  assert.equal(bands.length, 3, 'WS_BANDS must parse as three bands');
  assert.ok(states.length >= 9, 'WS_STATES must parse as the full state list');
  return { bands, states, bandsSrc: bandsSrc[0], statesSrc: statesSrc[0] };
}

test('U2: WS_BANDS/WS_STATES are the only place band order and rank are expressed', () => {
  const ui = readUi();
  const { bands, states, statesSrc } = wsTables(ui);

  // Rank is the index. A `rank:` field would be a second copy of the order to keep in step, which
  // is the exact drift the one-table rule exists to prevent.
  assert.ok(!/\brank\s*:/.test(statesSrc),
    'WS_STATES must not carry an explicit rank — position in the array IS the rank');
  const bandKeys = bands.map((b) => b.key);
  for (const s of states) {
    assert.ok(bandKeys.includes(s.band), `WS_STATES "${s.key}" names a band WS_BANDS doesn't define`);
  }
  // Bands must occupy contiguous runs, or "iterate bands, sort by rank" would draw a card above a
  // higher-ranked sibling in the same band.
  const runs = states.map((s) => s.band).filter((b, i, a) => b !== a[i - 1]);
  assert.deepEqual(runs, [...new Set(runs)], 'each band must be one contiguous run of WS_STATES');

  // The loop itself lives in ONE place, shared by every list view (see U3) — a second copy is how
  // the sections and the inbox would come to disagree about which band a workspace is in.
  const loop = fnBody(ui, 'function bandSections(');
  const grid = fnBody(ui, 'function sectionGrid(');
  assert.match(loop, /for \(const band of WS_BANDS\)/,
    'the band loop must walk WS_BANDS, not a hand-listed set of bands');
  assert.match(loop, /wsState\(a\.cat\)\.rank - wsState\(b\.cat\)\.rank/,
    'rank must come from the WS_STATES table, not a parallel comparator');
  assert.ok(!/for \(const band of WS_BANDS\)/.test(grid),
    'sectionGrid must reuse the shared loop rather than keep its own');
  for (const b of bands) {
    for (const [name, body] of [['bandSections', loop], ['sectionGrid', grid]]) {
      assert.ok(!body.includes(`'${b.key}'`),
        `${name} must not name the "${b.key}" band itself — that is a second copy of the order`);
      assert.ok(!body.includes(`'${b.label}'`), `${name} must not hand-write the "${b.label}" header`);
    }
  }
  // Density is the band's property, read from the table and handed to the renderer.
  assert.match(loop, /band\.density/, 'the row density must come from the band table');
  assert.match(fnBody(ui, 'function rowParts('), /density === 'compact'/,
    'the row must branch on the density the band gave it');
  // And in ONE place: rowParts is the whole of "what does this density draw", so the renderer must
  // not re-read `density` to make a second, private decision beside it.
  const rowBody = fnBody(ui, 'function workspaceRow(');
  assert.match(rowBody, /rowParts\(opts, density, done\)/,
    'workspaceRow must get what it draws from rowParts, not decide it inline');

  // One index built from the table, and exactly one.
  const indexSites = (ui.match(/WS_STATES\.map\(/g) || []).length;
  assert.equal(indexSites, 1, 'WS_STATE_INDEX must be the single derivation of WS_STATES');
});

test('U2: the browser band table and the ledger WORKSPACE_STATES are one taxonomy', () => {
  const { states } = wsTables(readUi());
  const byKey = new Map(states.map((s) => [s.key, s]));
  const server = new Map(ledger.WORKSPACE_STATES.map((s) => [s.state, s]));

  // Every non-job state the browser knows must be a real server state, in the SAME band. A state
  // banded one way in the core and another in the UI is two taxonomies wearing one name.
  for (const s of states) {
    if (s.key.startsWith('job-')) continue;   // the live-runner states are the browser's own
    const srv = server.get(s.key);
    assert.ok(srv, `web/app.js WS_STATES has "${s.key}", which ledger.js does not serve`);
    assert.equal(s.band, srv.band, `"${s.key}" lands in a different band in the browser than in the ledger`);
  }
  // And every state the server can serve must have somewhere to go. `done` is the one exception:
  // it keeps the collapsed Done disclosure instead of a band.
  for (const srv of ledger.WORKSPACE_STATES) {
    if (srv.state === 'done') continue;
    assert.ok(byKey.has(srv.state),
      `ledger.js serves "${srv.state}" but web/app.js has no band for it — it would render unlabelled`);
  }
  assert.ok(!byKey.has('done'), 'done must NOT be a band — it keeps its collapsed disclosure');
});

test('U2: categoryOf falls back instead of crashing on a missing or unknown state', () => {
  const ui = readUi();
  const { states } = wsTables(ui);
  const body = fnBody(ui, 'function categoryOf(');

  // A summary from an older cockpit carries no `state` at all, and an unknown word must not
  // produce an unlabelled band — the lookup is guarded and the fallback is a real WS_STATES key.
  assert.match(body, /WS_STATE_INDEX\.has\(f && f\.state\) \? f\.state : WS_FALLBACK_STATE/,
    'categoryOf must check the state against the table before trusting it, and null-guard `f`');
  const fallback = ui.match(/const WS_FALLBACK_STATE = '([^']+)';/);
  assert.ok(fallback, 'WS_FALLBACK_STATE must be declared');
  assert.ok(states.some((s) => s.key === fallback[1]),
    `the fallback "${fallback[1]}" must itself be a WS_STATES key, or the fallback renders no band`);
  // wsState() is the other half of the same guard: an unknown key still yields a labelled entry.
  assert.match(fnBody(ui, 'function wsState('), /\|\| WS_STATE_INDEX\.get\(WS_FALLBACK_STATE\)/,
    'wsState must never return undefined — the renderer reads .band and .rank off it');

  // A live job outranks the workspace's own state, and the three "a human must unstick this"
  // job conditions must stay in one branch: an errored job banded as "in progress" is the lie.
  assert.match(body, /job\.status === 'error' \|\| isStaleJob\(job\)/,
    'errored and stalled jobs must share the attention branch');
  assert.ok(!/function isStaleJob/.test(body), 'categoryOf must reuse isStaleJob, not re-derive it');
});

test('U2: an empty band is not rendered', () => {
  const ui = readUi();
  const grid = fnBody(ui, 'function sectionGrid(');
  assert.match(fnBody(ui, 'function bandSections('), /if \(!rows\.length\) continue;/,
    'a band with no cards must be skipped entirely — never a header with zero under it');
  // The pre-band behaviour at the two edges must survive: nothing at all → the empty state,
  // nothing active but something done → the note above the disclosure.
  assert.match(grid, /if \(!bands\.length && !doneRows\.length\) return sectionEmpty\(kind\);/,
    'an utterly empty section must still return sectionEmpty(kind)');
  assert.match(grid, /No active workspaces — everything below is complete\./,
    'bands empty but Done non-empty must keep the all-done note');
  assert.match(grid, /doneDisclosure\(kind, doneRows, 'inbox done-disc-body'\)/,
    'the Done disclosure and its date sort must be left exactly as they were — now filled with the '
    + 'same rows the bands hold, in the same list container');
});

/* U2 review fixes. Same shape as the tests above — source assertions over browser code the Node
 * suite cannot import, pinning the property that would actually break, with the rendering itself
 * verified in a real browser. */

test('U2: a job that already has a workspace row never gets a placeholder beside it', () => {
  const ui = readUi();
  // The entries a section draws are decided in sectionEntries and DRAWN by sectionGrid — split so
  // the poll can sign one decision and render it (see the idle-repaint test in U7).
  const entries = codeOnly(fnBody(ui, 'function sectionEntries('));
  const grid = codeOnly(fnBody(ui, 'function sectionGrid('));

  // The placeholder list is "every live job of this kind that has no card to be folded onto", and
  // that second clause is jobBindsTo asked of every card the page draws. Anything narrower has
  // shipped wrong twice: `used` alone holds the ONE job jobForFeature folded per workspace, so a PR
  // with two live jobs leaks its runner-up and is drawn twice; adding a wsId test on top still
  // misses a job that carries no wsId and binds by prId — which is what "+ New PR review" enqueues.
  assert.match(entries, /!features\.some\(\(f\) => jobBindsTo\(r, f\)\)/,
    'the placeholder filter must exclude any job that binds to ANY workspace on this page, through '
    + 'the same predicate that folds jobs onto cards');
  // The other half of the rule — a dangling wsId must KEEP its placeholder — has its own test
  // below, so this one is free to be about suppression alone.

  // And the placeholder is a row like any other, so it takes the band's density (finding 5).
  assert.match(grid, /pendingJobRow\(e\.job, density, kind\)/,
    'a placeholder must be drawn at the band density, not always full — a full-height placeholder '
    + 'among one-line compact rows breaks the only promise a compact band makes');
});

test('U2: card-binding and placeholder-suppression are ONE predicate, stated once', () => {
  const ui = readUi();
  const binds = codeOnly(fnBody(ui, 'function jobBindsTo('));
  const forFeature = codeOnly(fnBody(ui, 'function jobForFeature('));
  const entries = codeOnly(fnBody(ui, 'function sectionEntries('));

  // A job may arrive with a wsId, a prId, or both — the "+ New PR review" dialog enqueues
  // { action, prId, title } with no wsId at all. Both arms live in the predicate, so a caller that
  // only ever thought about wsId cannot be wrong about the prId case separately.
  assert.match(binds, /job\.wsId && job\.wsId === f\.id/,
    'jobBindsTo must bind a job to the workspace its wsId names');
  assert.match(binds, /String\(job\.prId\) === String\(prNumber\(f\)\)|String\(job\.prId\) === String\(pr\)/,
    'jobBindsTo must ALSO bind a PR job by prId — a wsId-less job is the ordinary UI-enqueued case, '
    + 'and a rule that only reads wsId lets it bind a card and draw a placeholder beside it');
  assert.match(binds, /pr-review|pr-respond/,
    'and the prId arm stays limited to the PR actions, so an apply job never binds by PR number');

  // The whole point: neither call site may restate the matching. Two copies of this rule is how the
  // duplicate PR card shipped — one side learned about prId, the other never did.
  for (const [name, body] of [['jobForFeature', forFeature], ['sectionEntries', entries]]) {
    assert.match(body, /jobBindsTo\(/, `${name} must go through the shared predicate`);
    assert.ok(!/\.wsId\b/.test(body),
      `${name} must not read wsId at all — one rule, or the two call sites drift apart`);
    // A comparison is a restatement; a bare truthiness check is not. sectionEntries must never
    // compare a prId to a workspace, which is the predicate's whole job. (It no longer reads prId
    // at all: what a placeholder needs is a NAME, and pendingJobTitle answers that.)
    assert.ok(!/String\([^)]*prId/.test(body) && !/prId\s*===/.test(body),
      `${name} must not compare prId to a workspace — that comparison lives in jobBindsTo`);
  }
  assert.ok(!/prId/.test(forFeature),
    'jobForFeature must not mention prId at all: it asks the predicate and sorts the answer');
});

test('U2: a wsId naming a workspace that is gone still gets its placeholder', () => {
  const ui = readUi();
  const grid = codeOnly(fnBody(ui, 'function sectionEntries('));

  // The rejected fix was `&& !r.wsId`, which reads "has a wsId ⇒ has a card". It does not: a
  // workspace can be deleted out from under a running review, and that review then vanishes from
  // the cockpit entirely — no card, no placeholder, no trace of the runner that is still going.
  // Membership in `features` is the only honest test, and it is exactly what .some() performs.
  assert.match(grid, /features\.some\(/,
    'placeholder suppression must be decided against the workspaces this page actually draws, so a '
    + 'dangling wsId matches nothing and keeps its placeholder');
  assert.ok(!/wsIds\.has\(/.test(grid),
    'and not against a bare set of ids, which can only answer the wsId half of the question');
  assert.ok(!/!r\.wsId\b/.test(grid),
    'the filter must test workspace EXISTENCE, never merely the presence of a wsId — `&& !r.wsId` '
    + 'is the rejected fix, and it makes a running review on a deleted workspace disappear');
});

test('U2: a full row names its state, so the band that demands action says the most', () => {
  const ui = readUi();
  const card = fnBody(ui, 'function workspaceRow(');

  // Without this, ready-to-post / needs-review / needs-rereview / author-responded render
  // pixel-identically: same lifecycle chip, same dial, same stamps. The compact rows parked
  // BELOW them were the only ones labelled.
  assert.match(card, /cat \? wsStatePill\(cat, kind\) : null/,
    'a banded row must render the state pill when it was given a category — in its own kind\'s '
    + 'vocabulary, so a running spec audit is not labelled "Re-reviewing"');
  // The lifecycle chip is kept, not deleted — "where is this workspace in its life" is a different
  // question from "what is it waiting on" — but it is drawn through the gate that suppresses the
  // one value it always held inside a band (`draft`). See the U5 test for what the gate lets past.
  // It came off the full card onto the full section row; Home never carried it and still does not.
  assert.match(card, /part\.sectionFull \? statusChipIfMeaningful\(r\.status\) : null/,
    'and keep the lifecycle chip, gated so it draws only when it discriminates');

  // .chip.ws-pill-needs-you was unreachable dead CSS while only compact rows wore a pill and no
  // needs-you row was ever compact. Every band must have a reachable tint.
  const css = fs.readFileSync(path.join(__dirname, '..', 'web', 'style.css'), 'utf8');
  for (const b of wsTables(ui).bands) {
    assert.ok(css.includes(`.chip.ws-pill-${b.key}`), `style.css must tint the "${b.key}" pill`);
  }
  assert.match(fnBody(ui, 'function wsStatePill('), /ws-pill-\$\{cssSafe\(meta\.band\)\}/,
    'the pill tint must come from the band the WS_STATES row names, not from the card');
});

test('U2: the category is decided once per render and handed to the row', () => {
  const ui = readUi();
  const grid = fnBody(ui, 'function sectionGrid(');
  const card = fnBody(ui, 'function workspaceRow(');

  assert.match(grid, /workspaceRow\(e\.ws, e\.job, density, e\.cat, ROW_SECTION\)/,
    'the band loop already decided the category — it must travel with the row');
  // categoryOf reads the clock through isStaleJob, so a second call inside the row can disagree
  // with the one that chose the header the row is sitting under: banded as one state, pilled as
  // another, on a single job crossing the 3-minute stale threshold mid-render.
  assert.ok(!/categoryOf\(/.test(card),
    'workspaceRow must not recompute categoryOf — one decision per render');
  assert.match(ui, /function workspaceRow\(r, job = null, density = 'full', cat = null, opts = ROW_HOME\)/,
    'and the Done disclosure, which draws outside the bands, must be able to pass no category: '
    + '`done` is deliberately not a WS_STATES key, so there is no honest pill for it');
});

test('U2: band density is emitted from WS_BANDS, not restated in CSS', () => {
  const ui = readUi();
  const { bands } = wsTables(ui);
  const loop = fnBody(ui, 'function bandSections(');
  const css = fs.readFileSync(path.join(__dirname, '..', 'web', 'style.css'), 'utf8');

  assert.match(loop, /band-density-\$\{cssSafe\(band\.density\)\}/,
    'the band must carry its density as a class, so the stylesheet can read the table too');
  // Hardcoding which bands are compact is the WS_BANDS/band-map drift spelled in CSS: flip a
  // `density` in the table and the spacing stays behind on a band that no longer holds one-liners.
  for (const b of bands) {
    assert.ok(!new RegExp(`\\.band-${b.key}\\s+\\.inbox`).test(css),
      `style.css must not space the "${b.key}" band by name — key it off the density class`);
  }
  assert.ok(css.includes('.band-density-compact .inbox'),
    'the compact spacing must hang off the density class');
  // And off ONE container, because there is one: a rule still naming .features-grid would be
  // styling an element no view builds any more, which is how dead CSS starts reading as live.
  // Comments stripped first — the section header explains where the grid went, and saying so is
  // not the same as selecting it.
  assert.ok(!cssRules(css).includes('features-grid'),
    'no RULE may still select .features-grid — Home and the sections share the .inbox list');
});

/* U3 — the Home inbox, banded by the same tables as the kind sections. Source assertions again:
 * `node --test` cannot import browser code, so these pin the properties whose loss would actually
 * break the screen, and the rendering itself is verified in a real browser. */

test('U3: the inbox bands come from the shared loop, not a second one of its own', () => {
  const ui = readUi();
  const { bands } = wsTables(ui);
  const inbox = fnBody(ui, 'function renderHomeInbox(');

  // The whole point of extracting bandSections: an inbox with its own copy of the loop is free to
  // order, label or count a band differently from the sections showing the same workspaces.
  assert.match(inbox, /bandSections\(active,\s*\n?\s*\(e, density\) => workspaceRow\(e\.ws, e\.job, density, e\.cat, ROW_HOME\), 'inbox'\)/,
    'renderHomeInbox must draw its bands through bandSections, handing each row the band density, '
    + 'the category the loop already decided, and the surface it is being drawn on');
  assert.ok(!/for \(const band of WS_BANDS\)/.test(inbox),
    'the inbox must not walk WS_BANDS itself — that is a second copy of the band order');
  for (const b of bands) {
    assert.ok(!inbox.includes(`'${b.label}'`),
      `the inbox must not hand-write the "${b.label}" header — it comes from WS_BANDS`);
  }
  // The band table is ordered by urgency, so the top band IS what needs you. Deriving the header
  // count from it rather than from needsYouBits is the fix for a subtitle that disagreed with the
  // rows underneath it: the bits read counts.toReview, which is 0 on a PR whose findings carry
  // suggestions rather than drafts — exactly the rows the count was about.
  assert.match(inbox, /wsState\(e\.cat\)\.band === WS_BANDS\[0\]\.key/,
    'the "needs you" count must come from the top band, the same answer the rows are grouped by');
  assert.ok(!/needsYouBits/.test(inbox),
    'no count on this screen may be derived from needsYouBits any more');
});

test('U3: Home folds each live job onto its row', () => {
  const ui = readUi();
  const inbox = fnBody(ui, 'function renderHomeInbox(');
  const row = fnBody(ui, 'function workspaceRow(');

  // Without binding, the inbox cannot band truthfully: a PR being posted, or one whose runner has
  // stalled and needs a human, sits under whatever state it held before the job started.
  assert.match(inbox, /\.filter\(isLiveJob\)/,
    'Home must bind the same jobs a section binds — isLiveJob, not its own liveness test');
  assert.match(inbox, /jobForFeature\(r, live\)/,
    'and correlate them with jobForFeature, not a second matcher');
  assert.match(inbox, /categoryOf\(r, job\)/,
    'the job must reach categoryOf, which is what lets it outrank the served state');
  // And the row has to SAY so, in the words the cards use — a stalled job must be as actionable
  // from the inbox as it is from a section.
  assert.match(row, /cardJobRow\(job, hasFindingsOf\(r\), kind\)/,
    'a row with a live job must render the job line, in the workspace\'s own kind vocabulary');
});

test('U3: the requests strip drops the jobs already shown on a row', () => {
  const ui = readUi();
  const poll = fnBody(ui, 'function startHomeRequestsPoll(');

  // A job on a row AND in the strip states the same thing twice on one screen — the duplication
  // the sections removed when they folded jobs onto cards.
  assert.match(poll, /const used = renderHomeInbox\(reqs\)/,
    'the strip must learn which jobs the rows took from the render that took them');
  assert.match(poll, /active\.filter\(\(r\) => !used\.has\(r\.id\)\)/,
    'a job bound to a visible row must not be listed in the strip as well');
  // But the strip stays: it is the cross-section queue view, and a job with no row yet has nowhere
  // else to appear. Emptied by the dedupe it must say where its jobs went, not go silent — a blank
  // strip under a live queue reads as broken.
  assert.match(poll, /populateRequestsStrip\(\$\('#requests-strip'\), unbound, active\.length/,
    'the strip must still render the unbound jobs, with an honest empty state when there are none');
  assert.match(poll, /already shown on the rows below/,
    'and that empty state must explain the dedupe rather than leave a gap');
});

test('U3: a needs-you row names its state, and a parked row drops the decision material', () => {
  const ui = readUi();
  const row = fnBody(ui, 'function workspaceRow(');

  // The inbox was the last surface where ready-to-post / needs-review / needs-rereview /
  // author-responded drew identically — the section cards gained the pill in 3d008a8.
  assert.match(row, /cat \? wsStatePill\(cat, kind\) : null/,
    'a banded row must wear the state pill, whatever its density');
  assert.match(ui, /function workspaceRow\(r, job = null, density = 'full', cat = null, opts = ROW_HOME\)/,
    'and a row drawn outside the bands (the Done disclosure) must still be able to pass neither');
  // Compact rows: title, pill, ONE stamp. The dial is a score you weigh before opening something,
  // and nothing parked on someone else is waiting on that decision. (Which density drops what is
  // rowParts' single decision, and it is RUN in "one renderer, two surfaces" below.)
  assert.match(row, /part\.dial \? dialEl\(/, 'a compact row must not draw the readiness dial');
  assert.match(row, /const bits = part\.bits \? needsYouBits\(r\.counts\) : \[\]/,
    'nor the needs-you counts');
  assert.match(row, /part\.stamp \? compactStamp\(r, job, cat\) : null/,
    'it earns the one stamp that says why it is parked, chosen by the rule compactStamp states');
  // Every density keeps the two things that make a row usable at all.
  assert.match(row, /href: `#\/feature\/\$\{encodeURIComponent\(r\.id\)\}`/,
    'every row keeps its link to the workspace');
  // The delete flow, pinned as CONTROL FLOW. What stood here was `/class: 'btn-icon ir-delete'/`,
  // which was green for the entire period the confirm was being destroyed every four seconds: it
  // proved the button was constructed, never that the flow worked. Cancel must put the row AND its
  // button back — a showDefault that restored only one of them leaves a row you cannot open, or a
  // row you cannot delete, and both look fine to a "was it built" assertion.
  assert.match(codeOnly(fnBody(row, 'function showDefault()')),
    /wrap\.replaceChildren\(link, trashBtn\)/,
    'the default state of a row is the row plus its trash button, restored together');
  assert.match(codeOnly(fnBody(row, 'function showConfirm()')), /onclick: showDefault \}, 'Cancel'/,
    'and Cancel must run exactly that function — not a partial undo of its own');
  // (Escape / outside-click take the same path — U7's wireConfirmDismiss test runs it. The prune
  // that follows a real delete is RUN in U5.)
});

test('U3: the inbox skips an empty band and keeps both edge cases', () => {
  const ui = readUi();
  const inbox = fnBody(ui, 'function renderHomeInbox(');

  // Shared with the sections, so the "never a header with zero under it" rule is pinned once — but
  // the inbox has to actually go through it, which is what this asserts.
  assert.match(fnBody(ui, 'function bandSections('), /if \(!rows\.length\) continue;/,
    'the shared loop must skip a band with nothing in it');
  assert.match(inbox, /bands\.length\s*\?\s*bands/,
    'the inbox draws whatever bands came back — it must not fill in the missing ones');
  assert.match(inbox, /No active workspaces — everything below is complete\./,
    'nothing active but something done must keep the all-done note');
  assert.match(inbox, /doneDisclosure\('home',\s*\n?\s*doneRows\.map\(\(e\) => \(\{ sortable: e\.ws, el: workspaceRow\(e\.ws, null, 'full', null, ROW_HOME\) \}\)\),\s*\n?\s*'inbox done-disc-body'\)/,
    'and the Done disclosure and its date sort must be left exactly as they were — a done row is '
    + 'drawn outside the bands, so it passes no job and no category, and it is still a Home row');
  // The zero-workspace case never reaches here: renderHome answers it with the seeding empty state.
  assert.match(fnBody(ui, 'async function renderHome('), /if \(rows\.length === 0\)/,
    'an empty cockpit must still get the "Nothing in the cockpit yet" view');
});

/* U4 — the three findings an independent reviewer raised against ce22adf. Source assertions again
 * (`node --test` cannot import browser code), and deliberately NOT of the shape the reviewer showed
 * to be worthless: `/class: 'btn-icon ir-delete'/` was green for the whole time the delete-confirm
 * was being destroyed every four seconds, because it proved the button was CONSTRUCTED and never
 * that it SURVIVED. These pin ordering and control flow — which branch returns before which write —
 * so breaking the property breaks the test. The rendering itself is verified in a real browser. */

test('U4: a PR number may only bind a workspace of the job\'s OWN kind', () => {
  const ui = readUi();
  const bind = codeOnly(fnBody(ui, 'function jobBindsTo('));

  // prNumber() falls back to `id.match(/(\d+)/)` — ANY digit run in ANY workspace id. So a
  // pr-review of PR 7001 bound `spec-7001-checkout`: that spec row drew "Re-reviewing" and was
  // banded into "In progress" by a runner that had never heard of it. Requiring the job to be
  // PR-shaped was only half the rule; the workspace has to be too.
  //
  // And "a PR kind" is not narrow enough either. One PR can carry BOTH a pr-review workspace and a
  // pr-respond one; a membership test binds each job to both, which puts "Re-reviewing" on the row
  // where you are answering reviewer threads and lets one job claim two cards. The gate must be
  // EQUALITY — a job's action names the kind of workspace it acts on.
  const gate = bind.indexOf('job.action !== f.kind');
  const match = bind.indexOf('prNumber(f)');
  assert.ok(gate > -1,
    'the kind gate must compare the job action to the feature kind, not test membership of a set: '
    + "a `pr-respond` job binding a `pr-review` workspace of the same PR is the bug this closes");
  assert.ok(!/f\.kind !== 'pr-review'|f\.kind !== 'pr-respond'/.test(bind),
    'and the old "is it any PR kind" membership test must be gone, not merely joined — two gates '
    + 'means the looser one is still deciding something');
  assert.ok(match > gate, 'the kind gate must GUARD the prId match — after it, it guards nothing');

  // The wsId arm is an exact id match and stays kind-agnostic by design: an `apply` names its
  // workspace and nothing else can answer to it, spec or PR.
  const wsArm = bind.indexOf('job.wsId === f.id');
  assert.ok(wsArm > -1 && wsArm < gate,
    'the wsId arm must stay ahead of the kind gate — narrowing it would break apply on specs');

  // One predicate, one place. A caller that re-states the rule is the drift 80c4f76 removed, and
  // Home re-stating it would leave every OTHER call site still wrong.
  const inbox = codeOnly(fnBody(ui, 'function renderHomeInbox('));
  assert.ok(!/kind/.test(inbox),
    'renderHomeInbox must not filter by kind itself — jobBindsTo owns the binding rule');
});

test('U4: a poll tick that changes nothing touches nothing', () => {
  const ui = readUi();
  const inbox = codeOnly(fnBody(ui, 'function renderHomeInbox('));
  const sig = codeOnly(fnBody(ui, 'function listEntrySig('));
  const list = codeOnly(fnBody(ui, 'function bandedListSig('));

  const sigAt = inbox.indexOf('bandedListSig(active, doneRows)');
  const paintAt = inbox.indexOf('zone.replaceChildren(');
  assert.ok(sigAt > -1, 'the tick must derive a signature of what the inbox renders');
  assert.ok(paintAt > sigAt, 'and derive it BEFORE the repaint, or the comparison decides nothing');
  assert.match(inbox.slice(sigAt, paintAt), /if \(sig === homeInbox\.sig\) \{[^}]*return used;\s*\}/,
    'an unchanged signature must return without ever reaching replaceChildren');

  // The signature has to be the banded layout itself, or it goes stale in the direction that
  // matters: a band that moved and a screen that never repaints to say so.
  assert.match(sig, /e\.ws && e\.ws\.id/, 'the signature must carry which rows are drawn');
  assert.match(sig, /e\.cat/, 'and the state each one landed in');
  assert.match(sig, /wsState\(e\.cat\)\.band/, 'and the band that state puts it in');
  assert.match(sig, /e\.job\.id/, 'and the identity of the job folded onto it');
  assert.match(sig, /e\.job\.status/, 'and that job\'s status — "queued → running" is a visible change');
  assert.match(list, /done\.map\(listEntrySig\)/,
    'and the Done entries, whose count the disclosure prints, through the same entry signature');

  // Recorded only once the paint has landed. Stamped earlier, a tick that skipped would make its
  // own skip permanent — the deferred change becomes a dropped one.
  assert.ok(inbox.indexOf('homeInbox.sig = sig') > paintAt,
    'the signature must be recorded after the repaint, never before or instead of it');
  // A fresh zone is an empty zone: a stale signature matching would skip the first paint into it.
  assert.match(codeOnly(fnBody(ui, 'async function renderHome(')), /homeInbox\.sig = null/,
    'renderHome must clear the signature when it rebuilds the inbox zone');
  // Whether or not it painted, the strip still needs to know what is on screen.
  assert.equal((inbox.match(/return used;/g) || []).length, 4,
    'every exit from renderHomeInbox must still answer which jobs the rows hold');
});

test('U4: a repaint never lands on top of an interaction — and is never dropped either', () => {
  const ui = readUi();
  const inbox = codeOnly(fnBody(ui, 'function renderHomeInbox('));
  const busy = codeOnly(fnBody(ui, 'function zoneHold('));
  const flush = codeOnly(fnBody(ui, 'function flushHomeInboxSoon('));
  const release = codeOnly(fnBody(ui, 'function releaseHomeInbox('));
  const home = codeOnly(fnBody(ui, 'async function renderHome('));

  const guardAt = inbox.indexOf('zoneHold(zone)');
  const paintAt = inbox.indexOf('zone.replaceChildren(');
  assert.ok(guardAt > -1, 'a tick must ask whether the user is mid-interaction before repainting');
  assert.ok(guardAt < paintAt, 'and ask it before the write, not after');
  assert.match(inbox.slice(guardAt, paintAt), /homeInbox\.pending = true;[\s\S]*?return used;/,
    'a tick arriving mid-interaction must HOLD the repaint and return, not perform it');

  // The interactions a replaceChildren destroys without a trace.
  assert.match(busy, /querySelector\('\.delete-confirm'\)/,
    'an open delete-confirm must block the repaint — rebuilding it answers "no" for the user');
  assert.match(busy, /zone\.contains\(a\)/,
    'so must focus inside the zone — the swap drops a keyboard user to <body>');

  // Held, not dropped. Two independent releases, because either alone has a hole: the tick alone
  // leaves up to four seconds of stale bands after a Cancel, and the event alone loses the change
  // if the interaction ends some way that fires neither. The body moved into releaseHomeInbox when
  // the full-view reload joined the same guard; the properties are the ones that always held.
  assert.match(release, /homeInbox\.pending/, 'the release must only fire when something is actually held');
  assert.match(release, /renderHomeInbox\(homeInbox\.reqs\)/,
    'and must replay the held tick, not repaint from an empty queue');
  assert.match(flush, /setTimeout\(/,
    'deferred a turn: during focusout activeElement is transiently <body>, so asking now would '
    + 'answer "nobody is here" mid-Tab and destroy the element about to receive focus');
  assert.match(flush, /releaseHomeInbox/, 'and the deferred call must be the shared release');
  assert.match(home, /onclick: flushHomeInboxSoon/,
    'the zone must release the hold on the click that ends a confirm');
  assert.match(home, /onfocusout: flushHomeInboxSoon/, 'and on the blur that ends a keyboard visit');
  assert.match(inbox, /homeInbox\.reqs = requests/,
    'and the tick must keep its requests, or the flush has nothing to replay');
  // The tick-side release: a skipped tick must leave the signature stale so the NEXT tick still
  // sees a difference and paints it.
  assert.ok(!/homeInbox\.sig = sig/.test(inbox.slice(guardAt, paintAt)),
    'a held tick must not record the signature it never painted');
});

test('U4: the strip accounts for the jobs it is not listing', () => {
  const ui = readUi();
  const poll = codeOnly(fnBody(ui, 'function startHomeRequestsPoll('));
  const strip = codeOnly(fnBody(ui, 'function populateRequestsStrip('));
  const row = codeOnly(fnBody(ui, 'function requestRow('));

  // The dedupe only explained itself when it removed EVERYTHING. On partial binding the screen
  // read "2 JOBS" in the strip beside "▶ Run 3 jobs" in the toolbar, with nothing joining them.
  assert.match(poll, /const onRows = active\.length - unbound\.length/,
    'the strip must compute the remainder it is not listing');
  assert.match(poll, /note: onRows \?/, 'and hand it over only when there is one');
  assert.match(strip, /o\.note \?/,
    'and the strip must render it beside its own count, where the arithmetic closes');

  // A PR with two live jobs folds one onto its row and leaks the runner-up into the strip. Keeping
  // it visible is right — hiding live work is the worse lie — but unlabelled it reads as a second
  // PR rather than a second job on the one already below.
  assert.match(poll, /jobBindsTo\(r, row\)/,
    '"does this strip entry already have a row" is jobBindsTo asked again, not a second matcher');
  assert.match(poll, /onRow: alsoOnRow/, 'and the answer must reach the strip');
  assert.match(strip, /requestRow\(r, onRow\(r\)\)/, 'which must pass it down to the entry');
  assert.match(row, /also on a row below/, 'and the entry must say so');
  assert.match(ui, /function requestRow\(r, onRow = false\)/,
    'defaulted, so the strips that show the whole queue read exactly as they did');
  assert.ok(!/unbound = unbound\.filter|unbound\.filter\(/.test(poll),
    'the runner-up must be labelled, never suppressed');
});

/* U5 — the loose ends. Two shapes of test here, and the difference is deliberate.
 *
 * Where a rule is PURE it is lifted out of web/app.js and RUN (fnSource + liftUi below), because a
 * source assertion can only ever say the code looks right. Where a rule is inseparable from the DOM
 * or from module state it stays a source assertion — and then it pins ORDERING and CONTROL FLOW,
 * never the presence of a constructed string. That distinction is the lesson of
 * `/class: 'btn-icon ir-delete'/`, which was green throughout the period the delete-confirm was
 * being destroyed every four seconds: it proved the button was built, never that it survived.
 * What the source assertions cannot reach is verified in a real browser. */

/* Like fnBody, but keeps the signature, so the text can be evaluated as a function. */
function fnSource(src, decl) {
  const at = src.indexOf(decl);
  assert.ok(at > -1, `web/app.js must declare ${decl}`);
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`unbalanced braces reading ${decl}`);
}

/* Lifts declarations out of a source string and evaluates them, so a rule can be tested by running
 * it on real inputs instead of by pattern-matching its text. `decls` entries are either
 * `function <name>(` / `async function <name>(` (lifted whole from the source) or a literal line to
 * include verbatim; anything the lifted code closes over is named in `env`. The env is itself a
 * guard: a rule that quietly grows a dependency on the DOM or on `state` stops lifting here rather
 * than drifting unnoticed — and where the dependency is unavoidable, naming it in `env` is what
 * makes it visible. `ui` is usually the whole file, but any string containing the declaration works,
 * which is how a NESTED function (doDelete inside inboxRow) is reached: fnBody() the host first. */
function liftUi(ui, decls, env = {}) {
  const isDecl = (d) => d.startsWith('function ') || d.startsWith('async function ');
  const src = decls.map((d) => (isDecl(d) ? fnSource(ui, d) : d)).join('\n');
  const names = decls.filter(isDecl)
    .map((d) => d.slice(d.indexOf('function ') + 'function '.length, d.indexOf('(')));
  const keys = Object.keys(env);
  // eslint-disable-next-line no-new-func
  return new Function(...keys, `${src}\nreturn { ${names.join(', ')} };`)(...keys.map((k) => env[k]));
}

test('U5: a PR job binds only the workspace of its own kind', () => {
  const ui = readUi();
  // jobBindsTo reads nothing but its two arguments and prNumber, so it can be run rather than read.
  const { jobBindsTo } = liftUi(ui, ['function prNumber(', 'function jobBindsTo(']);

  // The two workspaces one pull request can carry at the same time. They are different work on
  // different findings: on the first you are the reviewer, on the second you are the author.
  const review = { id: 'pr-7001-checkout', kind: 'pr-review', title: 'Checkout rewrite #7001' };
  const respond = { id: 'pr-7001-checkout-respond', kind: 'pr-respond', title: 'Checkout rewrite #7001' };

  // The regression: a pr-respond job used to bind the pr-review workspace (and the reverse), so the
  // runner's verb landed on the wrong row — "Re-reviewing" printed on the workspace where you are
  // answering reviewer threads — and one job claimed two cards, making a band count name more
  // workspaces than the band held.
  assert.equal(jobBindsTo({ id: 'j1', action: 'pr-respond', prId: 7001 }, review), false,
    'a pr-respond job must not bind the pr-review workspace for the same PR');
  assert.equal(jobBindsTo({ id: 'j2', action: 'pr-review', prId: 7001 }, respond), false,
    'nor a pr-review job the pr-respond workspace');
  // And each still binds its own — the narrowing must not cost the binding that was right.
  assert.equal(jobBindsTo({ id: 'j3', action: 'pr-respond', prId: 7001 }, respond), true);
  assert.equal(jobBindsTo({ id: 'j4', action: 'pr-review', prId: 7001 }, review), true);
  assert.equal(jobBindsTo({ id: 'j5', action: 'pr-review', prId: '7001' }, review), true,
    'and the ids compare as strings, because the queue and the title carry different types');

  // The earlier half of the same rule, still holding: prNumber() falls back to any digit run in any
  // id, so an ungated match let a PR job bind a spec workspace that merely contains the number.
  assert.equal(jobBindsTo({ id: 'j6', action: 'pr-review', prId: 7001 },
    { id: 'spec-7001-checkout', kind: 'spec' }), false,
  'a PR job must never bind a spec workspace whose id merely contains the number');

  // The wsId arm stays exact and kind-agnostic: it names one workspace outright, and an `apply` on
  // a spec has no other way to find its target. Narrowing this arm by kind would break Apply.
  assert.equal(jobBindsTo({ id: 'j7', action: 'apply', wsId: 'spec-7001-checkout' },
    { id: 'spec-7001-checkout', kind: 'spec' }), true);
  assert.equal(jobBindsTo({ id: 'j8', action: 'apply', wsId: 'pr-7001-checkout' }, review), true);
  assert.equal(jobBindsTo({ id: 'j9', action: 'apply', wsId: 'pr-7001-checkout' }, respond), false,
    'and it is an id match, not a PR match — an apply names one workspace');
  // A non-PR action with no wsId can never reach the number comparison at all.
  assert.equal(jobBindsTo({ id: 'j10', action: 'apply', prId: 7001 }, review), false);
  assert.equal(jobBindsTo({ id: 'j11', action: 'poll', prId: 7001 }, review), false);
  // Defensive edges the callers actually hand it: a missing side, and a PR-less workspace.
  assert.equal(jobBindsTo(null, review), false);
  assert.equal(jobBindsTo({ id: 'j12', action: 'pr-review', prId: 7001 }, null), false);
  assert.equal(jobBindsTo({ id: 'j13', action: 'pr-review' }, review), false,
    'a PR job with no prId and no wsId binds nothing — it must not fall through to a match');
});

test('U5: a deleted workspace is pruned from the cache the poller repaints from', async () => {
  const ui = readUi();

  // Both list views cache their rows and repaint from that cache on every tick that sees a change,
  // and each cache is refilled only by a full re-render. Removing the element alone therefore
  // un-deletes the workspace on the next live job: the row comes back, linking to a 404.
  //
  // What stood here was theatre, and an independent reviewer proved it: indexOf positions plus
  // `del.includes('!== r.id')`. Mutating the filter to `row.label !== r.id` and the guard to
  // `if (!state.home)` left the prune completely dead and the whole suite green. doDelete() closes
  // over nothing but its caller's locals, so it can be LIFTED OUT AND RUN (fnSource/liftUi) against
  // a real three-row cache — and then a dead prune, a cleared cache, a prune moved ahead of the
  // await, and a prune moved into the catch all FAIL, because each one changes what the cache holds.
  // One renderer serves both lists now, so WHICH cache a delete prunes is an argument (ROW_HOME /
  // ROW_SECTION → pruneRowCache) rather than a second copy of the function. That makes the wrong
  // answer perfectly plausible — a section row that pruned state.home.rows would pass every source
  // assertion in this file and still resurrect the workspace on the section's next repaint — so
  // both surfaces are RUN here, and each must leave the OTHER cache untouched.
  // doDelete is nested in workspaceRow, and pruneRowCache is beside it at module scope — both are
  // lifted from the real source. The surface tables are read from source too (never re-typed here:
  // a test that declared its own { cache: 'section' } would pass while ROW_SECTION said otherwise).
  const rowSrc = fnSource(ui, 'function pruneRowCache(') + '\n' + fnBody(ui, 'function workspaceRow(');
  const optsOf = (name) => {
    const m = ui.match(new RegExp(`^const ${name} = (\\{[^}]*\\});$`, 'm'));
    assert.ok(m, `${name} must be one object literal at module scope`);
    // eslint-disable-next-line no-new-func
    return new Function(`return ${m[1]};`)();
  };
  for (const spec of [
    {
      owner: 'the Home inbox',
      opts: 'ROW_HOME',
      fresh: () => ({
        home: { rows: [{ id: 'pr-1' }, { id: 'pr-2' }, { id: 'pr-3' }] },
        section: { features: [{ id: 'pr-1' }, { id: 'pr-2' }, { id: 'pr-3' }] },
      }),
      read: (st) => st.home.rows,
      other: (st) => st.section.features,
    },
    {
      owner: 'a section row',
      opts: 'ROW_SECTION',
      fresh: () => ({
        home: { rows: [{ id: 'pr-1' }, { id: 'pr-2' }, { id: 'pr-3' }] },
        section: { features: [{ id: 'pr-1' }, { id: 'pr-2' }, { id: 'pr-3' }] },
      }),
      read: (st) => st.section.features,
      other: (st) => st.home.rows,
    },
  ]) {
    const run = async (fail) => {
      const state = spec.fresh();
      const sent = [];
      const seen = { removed: 0, restored: 0, toasts: [] };
      // pruneRowCache is lifted too, not stubbed: the thing under test is which cache the surface
      // option resolves to, and a stub would be the test answering its own question.
      const { doDelete } = liftUi(rowSrc,
        ['function pruneRowCache(', 'async function doDelete('], {
          state,
          api: async (url, o) => {
            sent.push({ url, method: o && o.method });
            if (fail) throw new Error('server said no');
            return {};
          },
          wrap: { remove() { seen.removed++; } },
          showDefault: () => { seen.restored++; },
          toast: (msg) => seen.toasts.push(msg),
          label: 'Checkout rewrite',
          r: { id: 'pr-2' },
          opts: optsOf(spec.opts),
        });
      await doDelete();
      return { state, sent, seen };
    };

    // The delete succeeds: exactly the deleted id leaves the cache, and the other two stay. A prune
    // that matches nothing (`row.label !== r.id`), one skipped by an inverted guard, and one that
    // clears the cache outright are three different wrong answers and all three fail here.
    const ok = await run(false);
    assert.deepEqual(ok.sent, [{ url: '/api/features/pr-2', method: 'DELETE' }],
      `${spec.owner} must issue exactly one DELETE, for the workspace it is deleting`);
    assert.deepEqual(spec.read(ok.state).map((x) => x.id), ['pr-1', 'pr-3'],
      `${spec.owner} must drop exactly the deleted id from the cache the poller repaints from — `
      + 'leave it in and the next live job paints the deleted workspace straight back onto the '
      + 'screen, linking to a 404');
    assert.deepEqual(spec.other(ok.state).map((x) => x.id), ['pr-1', 'pr-2', 'pr-3'],
      `${spec.owner} must prune its OWN cache and only its own — pruning the other one is the same `
      + 'bug pointing the other way, and it is invisible until the next repaint brings the '
      + 'workspace back');
    assert.equal(ok.seen.removed, 1, `${spec.owner} must also take the element out of the DOM`);
    assert.equal(ok.seen.restored, 0, 'and must not put the trash button back after a success');

    // The delete fails: the cache must be EXACTLY as it was. This is what makes "after the server
    // confirmed" a behaviour rather than a source position — prune before the await, or in the
    // catch, and a workspace that is still on the server vanishes from the list until a reload.
    const bad = await run(true);
    assert.deepEqual(spec.read(bad.state).map((x) => x.id), ['pr-1', 'pr-2', 'pr-3'],
      `${spec.owner} must not prune when the server refused — the workspace is still there`);
    assert.equal(bad.seen.removed, 0, 'nor remove the element');
    assert.equal(bad.seen.restored, 1, 'and it must restore the default row');
    assert.match(bad.seen.toasts.join(' '), /Delete failed/, 'and say so');
  }

  // And the prune is load-bearing only because these two still repaint from the caches. If either
  // stopped, the assertions above would be guarding nothing.
  assert.match(codeOnly(fnBody(ui, 'function renderHomeInbox(')), /state\.home && state\.home\.rows/,
    'the inbox must still draw from state.home.rows — that is what makes a stale entry visible');
  assert.match(codeOnly(fnBody(ui, 'function startSectionRequestsPoll(')),
    /sectionEntries\(kind, state\.section\.features, rel\)/,
    'and the section poll from state.section.features');
});

test('U5: the section poll asks the binding predicate instead of restating it', () => {
  const ui = readUi();
  const poll = codeOnly(fnBody(ui, 'function startSectionRequestsPoll('));

  // `r.action === 'apply' && r.wsId && wsIds.has(r.wsId)` was the wsId arm of jobBindsTo, copied
  // out one function beyond the guarded zone. It is the exact shape that shipped wrong twice: the
  // predicate learns an arm, the copy does not, and two surfaces disagree about which jobs exist.
  assert.ok(!/wsIds/.test(poll), 'the poll must not build its own set of workspace ids');
  assert.ok(!/\.wsId\b/.test(poll),
    'nor read wsId at all — which field decides a binding is jobBindsTo\'s business alone');
  assert.match(poll, /jobBindsTo\(/, 'it must go through the shared predicate');

  // Behaviour preserved exactly, which is the whole requirement: this is a RELEVANCE filter, not
  // the binding rule. Same-kind jobs reach the grid whether or not they bind a workspace — that is
  // what lets an in-flight review with no workspace yet draw its pending placeholder — and the
  // predicate guards only the wsId-targeted arm, where the old copy sat.
  // The kind arm is KIND_ACTIONS now rather than `r.action === kind` (see U6), and the second arm
  // is WSID_JOB_ACTIONS rather than a hardcoded `apply` (it has to admit `summarize` too, and a
  // third site hardcoding the list is how `summarize` shipped invisible on this very grid) — but
  // their POSITIONS in the filter are the property that mattered and still do.
  const kindArm = poll.indexOf('actsOnKind(r, kind)');
  const wsidArm = poll.indexOf('WSID_JOB_ACTIONS.includes(r.action)');
  const asked = poll.indexOf('jobBindsTo(');
  assert.ok(kindArm > -1, 'every job of this section\'s own kind must still be relevant to it');
  assert.ok(wsidArm > -1 && asked > wsidArm,
    'and the predicate must guard the wsId-targeted arm — asking it of the kind arm would drop the '
    + 'workspace-less reviews that placeholders are made of');
  assert.ok(kindArm < wsidArm, 'with the unconditional kind arm first, as it was');

  // The filter must be computed before the grid is drawn from it, or it decides nothing.
  const relAt = poll.indexOf('const rel =');
  const drawAt = poll.indexOf('sectionGrid(');
  assert.ok(relAt > -1 && drawAt > relAt, 'the grid must be drawn from the filter, not beside it');

  // No copy left anywhere. A caller may ask "is this even a PR job" (a bare truthiness read), but
  // comparing an id or a PR number to a workspace is the predicate's job and only its job.
  for (const fn of ['startSectionRequestsPoll', 'startHomeRequestsPoll', 'renderHomeInbox',
    'jobForFeature', 'sectionGrid']) {
    const body = codeOnly(fnBody(ui, `function ${fn}(`));
    assert.ok(!/\.wsId\b/.test(body), `${fn} must not read wsId — one rule, or the call sites drift`);
    assert.ok(!/prId\s*===|String\([^)]*prId/.test(body),
      `${fn} must not compare prId to a workspace — that comparison lives in jobBindsTo`);
  }
});

test('U5: the lifecycle chip is drawn only when it says something', () => {
  const ui = readUi();
  const card = codeOnly(fnBody(ui, 'function workspaceRow('));

  // One spelling of the default, shared by the chip's own fallback and by the gate. Two copies and
  // the gate starts hiding a value the chip would have rendered, or the reverse.
  const defaultDecl = ui.match(/^const DEFAULT_STATUS = '[^']+';$/m);
  assert.ok(defaultDecl, 'the default lifecycle value must be declared once, at module scope');
  assert.equal((ui.match(/const DEFAULT_STATUS\s*=/g) || []).length, 1,
    'and exactly once — the gate and the chip must read the same word');
  assert.match(codeOnly(fnBody(ui, 'function statusChip(')), /status \?\? DEFAULT_STATUS/,
    'statusChip must fall back to that same constant rather than its own literal');

  // The gate is pure, so run it. `draft` — what ingest writes and every active workspace carries —
  // is suppressed; every other value still reaches the real chip. This is a suppression, not a
  // deletion: auditing / reworking / ready / implementing arrive through
  // POST /api/features/:id/status. (`done` never reaches the gate from a row — a done row draws its
  // own chip — but the gate must still pass it, because the gate decides whether, never what.)
  const drawn = [];
  const { statusChipIfMeaningful } = liftUi(ui,
    [defaultDecl[0], 'function statusChipIfMeaningful('],
    { statusChip: (s) => { drawn.push(s); return { chip: String(s) }; } });

  assert.equal(statusChipIfMeaningful('draft'), null, '`draft` must draw nothing');
  assert.equal(statusChipIfMeaningful(undefined), null,
    'and so must a missing status, which statusChip itself reads as `draft`');
  assert.equal(statusChipIfMeaningful(null), null);
  assert.deepEqual(drawn, [], 'none of those may reach the chip at all');
  for (const s of ['done', 'auditing', 'reworking', 'ready', 'implementing']) {
    assert.ok(statusChipIfMeaningful(s), `"${s}" discriminates and must still draw`);
  }
  assert.deepEqual(drawn, ['done', 'auditing', 'reworking', 'ready', 'implementing'],
    'and must be rendered by the real chip, unchanged — the gate decides whether, never what');

  // The row goes through the gate, and must not keep an unguarded call beside it.
  assert.match(card, /statusChipIfMeaningful\(r\.status\)/,
    'the row must draw the lifecycle chip through the gate');
  assert.ok(!/statusChip\(r\.status\)/.test(card),
    'and never past it — one unguarded call puts `draft` back on every active row');
  // The pill it sits next to is the thing that actually discriminates, and it stays.
  assert.match(card, /cat \? wsStatePill\(cat, kind\) : null/,
    'the state pill must be untouched — it is what the chip was crowding');
});

test('U5: the Home subtitle agrees with its own count', () => {
  const ui = readUi();
  // Pure string assembly, so run it. plural() inflects the noun only; the verb was left at the
  // plural, so the landing screen read "1 workspace need you" — and one is the ordinary case.
  const { homeSubtitle } = liftUi(ui, ['function plural(', 'function homeSubtitle(']);

  assert.equal(homeSubtitle(1, 1), '1 workspace needs you · 1 workspace total');
  assert.equal(homeSubtitle(7, 1), '1 workspace needs you · 7 workspaces total');
  // The n>1 wording is the one that was already right, and it must be untouched.
  assert.equal(homeSubtitle(9, 3), '3 workspaces need you · 9 workspaces total');
  assert.equal(homeSubtitle(2, 2), '2 workspaces need you · 2 workspaces total');
  // Nothing needing you takes the other branch entirely, singular included.
  assert.equal(homeSubtitle(1, 0), 'All caught up · 1 workspace under watch');
  assert.equal(homeSubtitle(4, 0), 'All caught up · 4 workspaces under watch');
});

test('U5: a band names itself, and its name carries its size', () => {
  const ui = readUi();
  const loop = codeOnly(fnBody(ui, 'function bandSections('));

  // The <section> had no accessible name, so three bands appeared in a landmark list as three
  // anonymous regions; and the count sat in a span OUTSIDE the <h2>, so heading navigation
  // announced "Needs you" without the one number that decides whether you enter the band.
  assert.match(loop, /'aria-labelledby': headId/,
    'the band section must be named by its own heading');
  const mint = loop.indexOf('const headId');
  const use = loop.indexOf("'aria-labelledby': headId");
  const onHead = loop.indexOf('id: headId');
  assert.ok(mint > -1 && use > mint && onHead > mint,
    'the id must be minted before it is referenced and before it is placed');

  // The count must be a CHILD of the heading, not its sibling — that is the whole fix for heading
  // navigation, and reverting it would leave aria-labelledby resolving to a nameless label. And it
  // must come AFTER the label: "the count is inside the h2" alone was satisfied by putting the count
  // first, which announces "· 4 Needs you" and buries the name behind a number.
  const h2At = loop.indexOf("h('h2'");
  const labelAt = loop.indexOf('band.label');
  const countAt = loop.indexOf("h('span', { class: 'band-count' }");
  assert.ok(h2At > -1 && labelAt > h2At, 'the band name must be the heading\'s first child');
  assert.ok(countAt > labelAt, 'and its size must follow the name, never lead it');
  assert.ok(!/\}, band\.label\),/.test(loop),
    'the h2 must not close before the count — a sibling span is the arrangement being replaced');

  // Name computation concatenates the heading's text nodes with nothing between them, so a count
  // that starts at "·" is announced as "Needs you· 2". One leading space fixes it, and costs no
  // layout: .band-count is a flex item, and a flex item's leading white space is trimmed.
  assert.match(loop, /'band-count' \}, ` · \$\{rows\.length\}`\)/,
    'the count must carry its own separating space, or the band\'s accessible name runs together');

  // A counter, not the band key: two banded lists on one page would mint the same key-derived id
  // twice, and a duplicate id makes aria-labelledby silently resolve to the wrong heading.
  assert.match(loop, /\+\+bandHeadSeq/, 'each band head must get an id of its own');
  assert.ok(!/band-head-\$\{cssSafe\(band\.key\)\}/.test(loop),
    'and it must not be derived from the band key, which repeats across lists');

  // Semantics only: the header must stay the quiet divider it is. Making it focusable or clickable
  // would put it in the tab order beside the Done disclosure, which IS a control.
  assert.ok(!/role:\s*'button'|tabindex|onclick/.test(loop),
    'the band header is structure, not a control — it must gain no interactive affordance');

  // The stylesheet has to hold the count's own metrics now that it inherits from the heading, or
  // this tree change becomes a visible one.
  const css = fs.readFileSync(path.join(__dirname, '..', 'web', 'style.css'), 'utf8');
  const countRule = css.slice(css.indexOf('.band-count'), css.indexOf('.band-count') + 260);
  assert.match(countRule, /line-height:/,
    'the count must pin its line-height — inheriting the heading\'s 1.2 shortens the whole header');
  assert.match(countRule, /letter-spacing:/,
    'and restate its tracking, or it picks up the heading\'s uppercase .07em and pads "· N"');
  assert.ok(!/letter-spacing:\s*(inherit|\.07em|0\.07em)/.test(countRule),
    'and that restatement must not be the heading\'s own value');
  assert.match(css.slice(css.indexOf('.band-label {')), /^[^}]*display: flex/,
    'and the heading must become the flex row .band-head was, so the gap is unchanged');
});

/* U6 — the four findings left open against 316edb0's fix. Same two shapes as U5, for the same
 * reason: where a rule is pure it is LIFTED OUT AND RUN (rowAgeText, holdStands, actsOnKind), and
 * where it is inseparable from the DOM it is pinned by ORDERING and CONTROL FLOW — which branch
 * returns before which write — never by the presence of a constructed string. The rendering itself,
 * and everything about focus and live DOM these cannot reach, is verified in a real browser. */

test('U6: the full-view refetch goes through the same guard as the repaint', () => {
  const ui = readUi();
  const poll = codeOnly(fnBody(ui, 'function startHomeRequestsPoll('));
  const release = codeOnly(fnBody(ui, 'function releaseHomeInbox('));
  const home = codeOnly(fnBody(ui, 'async function renderHome('));

  // The narrow path that survived 316edb0: a second job completing while a confirm was open called
  // renderHome() outright, and renderHome() does app.replaceChildren() on the WHOLE view — outside
  // both the signature and the interaction guard. Measured: {"confirms":1,"active":"BUTTON.btn
  // btn-danger"} → {"confirms":0,"active":"BODY."}. The poller must no longer reach it directly.
  assert.ok(!/renderHome\(\)/.test(poll),
    'the poll must not call renderHome() itself — that is the unguarded write, whatever guards the '
    + 'repaint beside it');
  assert.match(poll, /homeInbox\.reload = true/,
    'a newly completed job must FLAG the refetch, so the guard decides when it happens');
  assert.match(poll, /releaseHomeInbox\(\)/,
    'and the tick must offer the flag to the release, or a completed job waits for an event that '
    + 'may never come');
  // Flagged, never dropped: the refetch exists because the server has new data.
  const flagAt = poll.indexOf('homeInbox.reload = true');
  const releaseAt = poll.indexOf('releaseHomeInbox()');
  assert.ok(flagAt > -1 && releaseAt > flagAt,
    'the release must come after the flag in the same tick, or the refetch is a tick late for no '
    + 'reason');

  // One guard, asked before the write — the same two functions the zone repaint asks.
  const askAt = release.indexOf('holdStands(hold, homeInbox)');
  const reloadAt = release.indexOf('renderHome()');
  const repaintAt = release.indexOf('renderHomeInbox(homeInbox.reqs)');
  assert.match(release, /const hold = zoneHold\(\$\('#home-inbox-zone'\)\)|zoneHold\(zone\)/,
    'the release must ask the SAME hold predicate, not invent a second one');
  assert.ok(askAt > -1 && reloadAt > askAt,
    'and ask it BEFORE renderHome() — after it, the view is already gone');
  assert.ok(repaintAt > askAt, 'and before the repaint, for the same reason');
  assert.match(release.slice(askAt, reloadAt), /return;/,
    'a standing hold must return without reaching either write');
  // A reload rebuilds the zone from fresh server data, so a repaint queued behind it is stale by
  // construction — drawing it first would paint the old rows and then throw them away.
  assert.ok(reloadAt < repaintAt, 'the reload must win over a repaint held beside it');

  // And the flag must not outlive the view it was raised against. Presence alone was too weak —
  // hoisting the line above the `await` satisfied it while breaking what it claims — so this pins
  // WHERE: the clear belongs to the fresh-zone reset, which happens once the new data is in hand
  // and before anything is drawn from it. Clear it before the fetch and the flag this very fetch
  // satisfies survives into the new view, so the first poll tick calls renderHome() again and tears
  // down the view it has just painted. Clear it after the first paint and the same tick re-enters.
  const awaitAt = home.indexOf("await api('/api/home')");
  const clearAt = home.indexOf('homeInbox.reload = false');
  const firstPaintAt = home.indexOf('renderHomeInbox(');
  const pollAt = home.indexOf('startHomeRequestsPoll()');
  assert.ok(awaitAt > -1 && clearAt > awaitAt,
    'renderHome must clear the reload it is satisfying AFTER the fetch that satisfies it');
  assert.ok(firstPaintAt > clearAt && pollAt > clearAt,
    'and before it paints or re-arms the poll, or the next tick reloads the view it just built');
  // It is one reset with four fields, not four scattered writes: a zone that is fresh in three
  // respects and stale in the fourth is the shape every one of these bugs has had.
  for (const field of ['sig = null', 'pending = false', 'reload = false', 'heldAt = 0']) {
    assert.ok(home.includes(`homeInbox.${field}`), `renderHome must reset homeInbox.${field}`);
    assert.ok(home.indexOf(`homeInbox.${field}`) > awaitAt,
      `and reset homeInbox.${field} after the fetch, with the rest of them`);
  }
});

test('U6: the hold on a confirm is absolute; the hold on a cursor has a ceiling', () => {
  const ui = readUi();
  const ceilingDecl = ui.match(/^const ZONE_BUSY_HOLD_MS = \d+;$/m);
  assert.ok(ceilingDecl, 'the ceiling must be declared once, at module scope, as a named constant');
  const CEILING = Number(ceilingDecl[0].match(/(\d+)/)[1]);
  // holdStands reads its two arguments and the clock, so it is run rather than read.
  const { holdStands } = liftUi(ui, [ceilingDecl[0], 'function holdStands(']);

  // Nothing held: no decision, and — critically — no clock started. Stamping heldAt on a quiet tick
  // would spend the ceiling before the first change that needed it ever arrived.
  const quiet = { heldAt: 0 };
  assert.equal(holdStands(null, quiet), false);
  assert.equal(quiet.heldAt, 0, 'an unheld tick must not start the hold clock');

  // A destructive confirm is an unanswered question. A repaint answers it "no" on the user's behalf
  // and there is nothing to restore, so no elapsed time makes that trade worth making.
  const confirming = { heldAt: Date.now() - CEILING * 100 };
  assert.equal(holdStands('confirm', confirming), true,
    'an open delete-confirm must hold however long it has been open — it has no ceiling');

  // A cursor is a place, not a decision. Holding is right while the user is moving through the
  // list; past the ceiling the list is lying about the world to protect a cursor position, which is
  // the worse of the two failures. Measured before the fix: frozen across 5+ ticks, data changing
  // on every one.
  const fresh = { heldAt: 0 };
  assert.equal(holdStands('busy', fresh), true, 'focus must still buy the user some time');
  assert.ok(fresh.heldAt > 0, 'and the first held decision must start the clock');
  const stale = { heldAt: Date.now() - (CEILING + 1000) };
  assert.equal(holdStands('busy', stale), false,
    'but past the ceiling the repaint must land — an indefinite freeze is the bug being closed');
  // Continuous time, not a count of calls: a user clicking around inside the zone is as entitled to
  // a truthful list as one sitting still, so repeated calls must not re-arm the budget.
  const armed = { heldAt: Date.now() - (CEILING - 500) };
  const at = armed.heldAt;
  holdStands('busy', armed); holdStands('busy', armed); holdStands('busy', armed);
  assert.equal(armed.heldAt, at, 'a second held decision must not restart the clock');
});

test('U6: a forced repaint puts the user back where it found them', () => {
  const ui = readUi();
  const inbox = codeOnly(fnBody(ui, 'function renderHomeInbox('));
  const grid = codeOnly(fnBody(ui, 'function startSectionRequestsPoll('));
  const mark = codeOnly(fnBody(ui, 'function zoneFocusMark('));

  // The ceiling would be a straight trade of one failure for another if it dropped the keyboard
  // user to <body> — that is exactly what the hold was added to prevent. A node reference cannot
  // survive replaceChildren, so the mark is a string looked up again in the rebuilt list.
  assert.match(mark, /\[data-fk\]/, 'the mark must be read off a stable key, not a node identity');

  // The restore itself is RUN, not read. Regexes over its body were the whole of this guard and they
  // pinned nothing: an early `return;`, or `if (el && false) el.focus(...)`, left the function a
  // no-op with every assertion still green. It touches only its two arguments, CSS.escape and
  // .focus(), so it lifts cleanly (7eedee4's pattern) and a no-op fails outright.
  const looked = [];
  const focused = [];
  const zone = (found) => ({
    querySelector(sel) {
      looked.push(sel);
      return found ? { focus: (opts) => focused.push(opts) } : null;
    },
  });
  const { restoreZoneFocus } = liftUi(ui, ['function restoreZoneFocus('],
    { CSS: { escape: (s) => String(s).replace(/"/g, '\\"') } });

  restoreZoneFocus(zone(true), 'row:pr-1');
  assert.deepEqual(looked, ['[data-fk="row:pr-1"]'],
    'the mark must be redeemed by looking the key up in the NEW dom, escaped');
  assert.deepEqual(focused, [{ preventScroll: true }],
    'and the element it finds must actually be focused — the user did not ask to move, so it must '
    + 'not scroll the page either');

  // The three shapes the callers really hand it, none of which may throw or focus anything: no
  // zone (the view navigated away mid-repaint), no mark (a release the user's own click triggered,
  // where focus was never taken), and a mark whose control is gone from the rebuilt list.
  looked.length = 0; focused.length = 0;
  restoreZoneFocus(null, 'row:pr-1');
  restoreZoneFocus(zone(true), null);
  assert.deepEqual(looked, [], 'a missing zone or a null mark must not even search');
  restoreZoneFocus(zone(false), 'row:gone');
  assert.deepEqual(looked, ['[data-fk="row:gone"]']);
  assert.deepEqual(focused, [], 'and a key with nothing behind it must be dropped, not thrown on');

  // Order is the whole property: taken while the old dom is still there, redeemed after the new one
  // exists. Either side of the write and it marks or restores nothing.
  for (const [name, body, write] of [
    ['the inbox', inbox, 'zone.replaceChildren('],
    ['the section grid', grid, 'zone.replaceChildren('],
  ]) {
    const took = body.indexOf('zoneFocusMark(zone)');
    const wrote = body.indexOf(write);
    const put = body.indexOf('restoreZoneFocus(zone, mark)');
    assert.ok(took > -1 && wrote > took, `${name} must take the focus mark before it repaints`);
    assert.ok(put > wrote, `${name} must restore focus after the repaint, not before it`);
  }

  // Every control a repaint can pull out from under the keyboard has to carry a key, or the mark is
  // null for it and the ceiling drops the user after all. These are all of them in both lists.
  for (const [what, decl, key] of [
    ['the row link', 'function workspaceRow(', 'fk: `row:${r.id}`'],
    ['its delete button', 'function workspaceRow(', 'fk: `row-del:${r.id}`'],
    ['the Done disclosure', 'function doneDisclosure(', 'fk: `done-sum:${key}`'],
    ['its sort menu', 'function doneDisclosure(', 'fk: `done-sort:${key}`'],
  ]) {
    assert.ok(codeOnly(fnBody(ui, decl)).includes(key),
      `${what} must carry a focus key (${key}) — without it a forced repaint loses the keyboard`);
  }
  // Both lists emit `row:`/`row-del:` now, which is fine — they are never on screen together — but
  // the OLD keys must be gone rather than lingering on some path that still builds a card: a zone
  // holding a `card:` key and a list emitting `row:` keys is a mark that redeems nothing, which is
  // exactly the silent focus loss the ceiling exists to prevent.
  assert.ok(!/fk: `card(-del)?:/.test(ui),
    'no control may still carry a `card:` focus key — one renderer, one key namespace');
  // The two lists' keys are the same STRINGS for the same workspace, deliberately: a workspace
  // focused on Home and then on its section is the same control by the only name the mark has.
  const rowSrc = codeOnly(fnBody(ui, 'function workspaceRow('));
  assert.equal((rowSrc.match(/fk: `row:/g) || []).length, 1,
    'and one renderer emits it once, so the two surfaces cannot disagree about what it is called');
});

test('U6: a held list says so, and nothing already on screen moves when it does', () => {
  const ui = readUi();
  const note = codeOnly(fnBody(ui, 'function zoneHeldNote('));
  const poll = codeOnly(fnBody(ui, 'function startHomeRequestsPoll('));
  const inbox = codeOnly(fnBody(ui, 'function renderHomeInbox('));

  // While held the page stated two different things about one queue: the strip read "1 job in
  // flight — already shown on the rows below" while no row showed it. Both halves of the fix are
  // pinned here.
  //
  // Half one: the rows admit it. The note is raised on the SAME branch that holds, so it cannot be
  // forgotten on a path that holds silently.
  const holdAt = inbox.indexOf('holdStands(hold, homeInbox)');
  const paintAt = inbox.indexOf('zone.replaceChildren(');
  assert.ok(holdAt > -1 && holdAt < paintAt);
  assert.match(inbox.slice(holdAt, paintAt), /zoneHeldNote\(zone, HOME_HELD_NOTE\[hold\]\)/,
    'the branch that holds must be the branch that says it is holding');
  // And it must come down again when the list is no longer behind — a paused sign over a live list
  // is the same contradiction pointing the other way.
  assert.match(inbox, /clearZoneHeldNote\(zone\)/,
    'a tick that finds nothing outstanding must take the note down');
  const notes = ui.match(/const HOME_HELD_NOTE = \{[\s\S]*?\n\};/);
  assert.ok(notes, 'the wording must live in one table, not be built at the call site');
  assert.match(notes[0], /queue above has moved on/,
    'and it must say the queue above is AHEAD of these rows — "paused" alone leaves the strip\'s '
    + '"already shown on the rows below" standing, which is the contradiction being closed');

  // Half two: the strip and the toolbar deliberately DO NOT hold. Freezing the "▶ Run N jobs" count
  // means pressing a button that promises the wrong number, and freezing the strip hides live work
  // at the moment work is happening. They must stay ahead of the release, unguarded.
  const stripAt = poll.indexOf('populateRequestsStrip(');
  const runnerAt = poll.indexOf('renderRunnerZone(');
  const releaseAt = poll.indexOf('releaseHomeInbox()');
  assert.ok(stripAt > -1 && runnerAt > -1 && releaseAt > -1);
  assert.ok(stripAt < releaseAt && runnerAt < releaseAt,
    'the strip and the runner button must update before the hold is even consulted');
  assert.ok(!/holdStands|zoneHold/.test(poll.slice(0, Math.max(stripAt, runnerAt))),
    'and neither may be placed behind the hold — the fix is the rows admitting they are stale, '
    + 'not the rest of the screen going stale with them');

  // The note arrives while a confirm is open and the pointer is already over the red Delete button.
  // Anything that reflows the list above it turns a status line into a misclick on an irreversible
  // action, so it may only ever be appended.
  //
  // "It calls append" was too weak on its own — `zone.append(note); note.remove();` satisfied it
  // while leaving no note at all — so what is pinned is the control flow around the append: it
  // happens ONLY on the branch that had to create the note, nothing removes it afterwards, and the
  // text is written to the existing element rather than the element being replaced. Appending an
  // element that is already in the DOM MOVES it, which is the same reflow under the same pointer.
  const mintAt = note.indexOf('if (!note)');
  const appendAt = note.indexOf('zone.append(note)');
  const writeAt = note.indexOf("note.querySelector('.zone-held-text')");
  assert.ok(mintAt > -1 && appendAt > mintAt,
    'the note must be appended only where it was just created — re-appending an existing note '
    + 'moves it, which is the reflow this whole arrangement exists to avoid');
  assert.ok(writeAt > appendAt,
    'and the sentence written into the note that is already placed, never by replacing it');
  assert.ok(!/prepend|insertBefore|replaceChildren|note\.remove\(\)|removeChild|replaceWith/.test(note),
    'never prepended, inserted, replaced or removed — that pushes an open confirm down under the '
    + 'pointer, or takes away the admission the rows owe the strip above them');
  assert.match(note, /if \(t\.textContent !== text\)/,
    'and written only on a real change, or role="status" re-announces the same sentence every '
    + 'four seconds for as long as the hold lasts');
  const css = fs.readFileSync(path.join(__dirname, '..', 'web', 'style.css'), 'utf8');
  const rule = css.slice(css.indexOf('.zone-held {'), css.indexOf('.zone-held {') + 400);
  assert.match(rule, /position: sticky/,
    'and pinned rather than placed, so a long held list still shows it');
  assert.match(css, /\.zone-held-text \{[^}]*min-width: 0/,
    'the sentence must wrap inside the note, or it forces the page wider than a 420px viewport');

  // There is NO height reservation under the note, and that absence is the finding, not an
  // omission. `.zone-holding { padding-bottom: calc(var(--zone-held-h, 72px) + 18px) }` stood here
  // to keep the last row reachable under a pinned note — but sticky already keeps the note's own
  // flow box at the end of the zone and only shifts it UP, so at maximum scroll it is back in its
  // own space with the last row above it. Measured on a 26-row inbox at 1280px and 420px, at both
  // scroll extremes, with the padding and without: identical coverage (two rows mid-scroll either
  // way, which the reservation never addressed; none at maximum scroll either way), and ~56px less
  // empty space. This is a source-shaped guard because the property is a rendered one — what makes
  // it honest is that the browser measurement is what decided it, and it is written down in both
  // files. If the reservation comes back, it comes back with a measurement that justifies it.
  // codeOnly on both sides: BOTH files name the removed rule in the comment that explains why it
  // went, and a regex over the raw text would read the explanation as the mistake.
  assert.ok(!/zone-holding/.test(codeOnly(css)) && !/zone-holding/.test(codeOnly(ui)),
    'the reservation was measured unnecessary and removed — bringing it back needs a measurement, '
    + 'not a theory');
  assert.ok(!/--zone-held-h/.test(codeOnly(css)) && !/--zone-held-h/.test(codeOnly(ui)),
    'and the custom property that fed it must go with it, not linger unread');
  // The note still has to come down when the list is no longer behind. On a repaint that happens
  // through replaceChildren (it is a direct child of the zone); on the short-circuit, where nothing
  // is replaced, it takes the explicit clear.
  assert.match(note, /zone\.append\(note\)/,
    'the note must be a direct child of the zone, which is what lets a repaint take it');
  for (const [where, decl, skip] of [
    ['the inbox', 'function renderHomeInbox(', 'if (sig === homeInbox.sig)'],
    ['the section grid', 'function startSectionRequestsPoll(', 'if (sig === gridPaint.sig)'],
  ]) {
    const body = codeOnly(fnBody(ui, decl));
    const at = body.indexOf(skip);
    assert.ok(at > -1 && body.indexOf('clearZoneHeldNote(zone)', at) > at,
      `${where} must take the note down on the tick that finds nothing outstanding — that tick `
      + 'repaints nothing, so nothing else would');
  }
});

test('U6: a rendered age is in the signature, and the clock is not', () => {
  const ui = readUi();
  // rowAgeText reads its arguments, the formatters and the clock — nothing else — so it is run.
  const staleDecl = ui.match(/^const JOB_STALE_MS = .*;$/m);
  assert.ok(staleDecl, 'JOB_STALE_MS must stay a module-scope constant');
  const { rowAgeText } = liftUi(ui, [
    'function fmtDate(', 'function fmtDateTime(', 'function fmtAgo(', 'function fmtAge(',
    'function reviewStampsOf(', staleDecl[0], 'function jobAgeMs(', 'function isStaleJob(',
    'function rowAgeText(',
  ], { runnerBusy: () => false });

  const ago = (mins, secs = 0) => new Date(Date.now() - (mins * 60 + secs) * 1000).toISOString();
  const row = (mins, secs) => ({ id: 'pr-1', stamps: { lastReviewedAt: ago(mins, secs) } });

  // The regression: "Reviewed 18m ago" is rendered text with nothing else in the signature standing
  // for it, so once a tick that changes nothing touched nothing, a card that read "queued 27m ago"
  // went on reading it at 40m. The text has to be IN the signature.
  assert.notEqual(rowAgeText(row(18), null), rowAgeText(row(19), null),
    'a minute that changes the words must change the signature, or the age freezes');
  assert.notEqual(rowAgeText(row(59), null), rowAgeText(row(61), null),
    'and so must the crossing into hours');

  // The other way to lose: Date.now() in the signature differs on EVERY tick, so every tick
  // repaints and the DOM-swap pressure this whole mechanism exists to remove is back in full. What
  // is folded in is the TEXT, which is the same string for a whole minute.
  assert.equal(rowAgeText(row(18, 0), null), rowAgeText(row(18, 30), null),
    'a quiet half-minute inside the same displayed minute must NOT repaint');
  assert.equal(rowAgeText(row(600), null), rowAgeText(row(605), null),
    'nor five minutes inside the same displayed hour');

  // The stale job's own clock ("Not running — queued 27m ago") is the third rendered age, and it is
  // only printed when the job is stale. `runnerBusy: false` above is what lets isStaleJob say so.
  const stale = { id: 'j1', status: 'queued', createdAt: ago(30), updatedAt: ago(30) };
  const staler = { id: 'j1', status: 'queued', createdAt: ago(31), updatedAt: ago(31) };
  const quiet = { id: 'j2', status: 'running', createdAt: ago(0, 10), updatedAt: ago(0, 10) };
  assert.notEqual(rowAgeText(row(1000), stale), rowAgeText(row(1000), staler),
    'the stale note\'s age must move the signature too');
  assert.equal(rowAgeText(row(1000), quiet), rowAgeText(row(1000), null),
    'a job that is not stale prints no clock of its own, so it must add nothing');

  // And the signature has to actually carry it — for the Done rows as well, which print the same
  // "Last reviewed 12m ago" and would freeze the same way. One entry signature, used for both the
  // banded entries and the Done ones, so neither can be the half that forgets.
  const sig = codeOnly(fnBody(ui, 'function listEntrySig('));
  const list = codeOnly(fnBody(ui, 'function bandedListSig('));
  assert.match(sig, /rowAgeText\(e\.ws, e\.job\)/, 'every entry must contribute its age text');
  assert.match(list, /entries\.map\(listEntrySig\)/, 'every banded entry goes through it');
  assert.match(list, /done\.map\(listEntrySig\)/, 'and every done one, through the same function');
  assert.ok(!/Date\.now\(\)/.test(sig) && !/Date\.now\(\)/.test(list),
    'the signature must never read the clock directly — that repaints every single tick');
  assert.ok(!/Date\.now\(\)/.test(codeOnly(fnBody(ui, 'function renderHomeInbox('))),
    'nor may the tick that compares it');
});

test('U6: a section sees exactly the jobs that act on its own workspaces', () => {
  const ui = readUi();
  // KIND_ACTIONS + actsOnKind read nothing else, so they are run rather than read.
  const table = ui.match(/const KIND_ACTIONS = \{[\s\S]*?\n\};/);
  assert.ok(table, 'the kind→actions map must be declared once, at module scope');
  const { actsOnKind } = liftUi(ui, [table[0], 'function actsOnKind(']);

  // The bug: `r.action === kind` is true only because a PR review's action IS its workspace kind.
  // Spec has no action of its own name, so #/spec matched nothing and never folded a job — one
  // workspace reading "In progress" on Home and "Ready to post" on its own section.
  for (const a of ['audit', 're-audit', 'propose']) {
    assert.equal(actsOnKind({ action: a }, 'spec'), true, `#/spec must see its own ${a} jobs`);
    assert.equal(actsOnKind({ action: a }, 'pr-review'), false,
      `and a ${a} job must not reach a PR section`);
    assert.equal(actsOnKind({ action: a }, 'pr-respond'), false);
  }
  // No PR job may leak the other way, which is the scoping the fix could most easily get wrong.
  for (const a of ['pr-review', 'pr-respond']) {
    assert.equal(actsOnKind({ action: a }, 'spec'), false,
      `a ${a} job must never be admitted to #/spec`);
    assert.equal(actsOnKind({ action: a }, a), true, 'while each PR kind still sees its own');
  }
  assert.equal(actsOnKind({ action: 'pr-respond' }, 'pr-review'), false,
    'and the two PR kinds must not see each other, exactly as jobBindsTo refuses to cross them');
  // apply and poll are not owned by a kind. `apply` may only reach a section through jobBindsTo —
  // that is what keeps an apply on a PR workspace out of #/spec — and `poll` drives the Refresh
  // button, never a card.
  for (const kind of ['spec', 'pr-review', 'pr-respond']) {
    assert.equal(actsOnKind({ action: 'apply' }, kind), false,
      'apply must not be admitted by the kind arm — jobBindsTo is its only way in');
    assert.equal(actsOnKind({ action: 'poll' }, kind), false);
    assert.equal(actsOnKind({ action: 'summarize' }, kind), false,
      'nor summarize — it names one workspace, exactly like apply');
  }
  // …and the wsId arm really does admit it, on every kind. Without this, calling it "shared" would
  // just be a way of excusing an action no section ever draws.
  {
    const { jobBindsTo } = liftUi(readUi(), ['function prNumber(', 'function jobBindsTo(']);
    for (const kind of ['spec', 'pr-review', 'pr-respond']) {
      assert.equal(jobBindsTo({ id: 'j', action: 'summarize', wsId: 'ws-1' }, { id: 'ws-1', kind }), true,
        `a summarize job must bind its own ${kind} workspace`);
    }
    assert.equal(jobBindsTo({ id: 'j', action: 'summarize', wsId: 'ws-1' }, { id: 'ws-2', kind: 'spec' }), false);
  }
  assert.equal(actsOnKind({ action: 'nonsense' }, 'spec'), false);
  assert.equal(actsOnKind({ action: 'audit' }, 'no-such-kind'), false,
    'an unknown kind must admit nothing rather than throw on an undefined lookup');

  // One taxonomy, like WS_STATES and WORKSPACE_STATES: every action the server can enqueue must be
  // either owned by exactly one kind or one of the two deliberately shared ones. A new action added
  // to ledger.js and forgotten here is precisely how #/spec went blind in the first place.
  const owners = new Map();
  for (const [kind, actions] of Object.entries(new Function(`${table[0]}; return KIND_ACTIONS;`)())) {
    for (const a of actions) {
      assert.ok(!owners.has(a), `"${a}" is claimed by both ${owners.get(a)} and ${kind}`);
      owners.set(a, kind);
    }
  }
  // `summarize` joins apply/poll as shared: like apply it names ONE workspace by wsId and any
  // kind can host it, so admitting it through the kind arm would claim it for one section and
  // hide it on the others. jobBindsTo's wsId arm is its way in — asserted below, so "shared"
  // cannot become a way of excusing an action nothing ever draws.
  const shared = ['apply', 'poll', 'summarize'];
  for (const a of ledger.REQUEST_ACTIONS) {
    assert.ok(owners.has(a) || shared.includes(a),
      `ledger.js can enqueue "${a}" but no section claims it and it is not one of the shared `
      + `actions (${shared.join(', ')}) — it would be invisible on every section`);
  }
  for (const a of owners.keys()) {
    assert.ok(ledger.REQUEST_ACTIONS.includes(a),
      `KIND_ACTIONS claims "${a}", which ledger.js can never enqueue`);
  }
  for (const a of shared) {
    assert.ok(!owners.has(a), `"${a}" is shared and must not be claimed by a kind`);
  }
});

test('U6: #/spec is polled and banded like the PR sections, and guarded like them too', () => {
  const ui = readUi();
  const section = codeOnly(fnBody(ui, 'async function renderSection('));
  const grid = codeOnly(fnBody(ui, 'function sectionEntries('));
  const poll = codeOnly(fnBody(ui, 'function startSectionRequestsPoll('));

  // `if (isPr) startSectionRequestsPoll(kind)` is what left #/spec with no runner at all.
  assert.match(section, /\n\s*startSectionRequestsPoll\(kind\);/,
    'every kind must start the poll — a section that never sees a job cannot band by one');
  assert.ok(!/isPr\s*(\?|&&)?\s*startSectionRequestsPoll|if \(isPr\) startSectionRequestsPoll/.test(section),
    'and it must not be conditional on the kind being a PR one');
  // The section-actions header stays PR-only — spec has no Refresh or Run button and gains none.
  assert.match(section, /isPr\s*\n?\s*\?\s*h\('div', \{ class: 'section-actions' \}/,
    'the PR-only toolbar must stay PR-only: the poll is what generalises, not the header');

  // Both filters now read the one table, so a section cannot admit a job it does not own.
  assert.match(poll, /actsOnKind\(r, kind\)/, 'the relevance filter must ask the table');
  assert.match(grid, /actsOnKind\(r, kind\) && pendingJobTitle\(r\)/,
    'and so must the placeholder filter — gated on the placeholder having a NAME, which is the '
    + 'requirement `r.prId` was standing in for, and the substitution that made a first spec '
    + 'audit visible on its own page (U7)');
  assert.ok(!/r\.action === kind/.test(poll) && !/r\.action === kind/.test(grid),
    'the coincidence that a PR review\'s action equals its workspace kind must not be relied on '
    + 'anywhere — that is the whole bug');

  // Turning the poll on for #/spec hands it the repaint the PR sections already had, and this grid
  // draws the same delete-confirm the inbox does. Guarded by the SAME helpers — a second rule for
  // "may I repaint now" is how two surfaces drawing one confirm come to disagree about it.
  const holdAt = poll.indexOf('holdStands(hold, gridHold)');
  const writeAt = poll.indexOf('zone.replaceChildren(');
  assert.ok(holdAt > -1, 'the grid must ask the shared hold before repainting');
  assert.ok(writeAt > holdAt, 'and ask it before the write, not after');
  assert.match(poll.slice(holdAt, writeAt), /return;/,
    'a standing hold must return without reaching replaceChildren');
  assert.match(poll.slice(holdAt, writeAt), /zoneHeldNote\(zone, GRID_HELD_NOTE\[hold\]\)/,
    'and say so, for the same reason the inbox does');
  assert.ok(!/function (gridHold|sectionInteracting)\(/.test(ui),
    'the grid must reuse zoneHold/holdStands rather than grow a predicate of its own');
  // Its clock is its own, though: one shared record would carry a hold across a navigation between
  // two lists that are never on screen together.
  assert.match(ui, /^const gridHold = \{ heldAt: 0 \};$/m, 'the grid keeps its own hold clock');
  // Unconditionally, and before the poll can consult it. Merely mentioning the assignment was too
  // weak — `if (false) gridHold.heldAt = 0;` satisfied it — so pin it as a statement in its own
  // right, at statement position, ahead of the poll it exists to unblock.
  const clearAt = section.search(/^\s*gridHold\.heldAt = 0;/m);
  const armAt = section.indexOf('startSectionRequestsPoll(kind)');
  assert.ok(clearAt > -1,
    'a freshly rendered section must clear the hold clock unconditionally — a fresh zone has no '
    + 'interaction in progress, and a clock carried in from the last section would spend this '
    + 'section\'s ceiling before its first change arrived');
  assert.ok(armAt > clearAt, 'and clear it before arming the poll that reads it');
  // The same rule for the signature the grid gained: a fresh zone is an EMPTY one, so a signature
  // left over from the section last visited must not match and skip the first paint into it.
  const sigClearAt = section.search(/^\s*gridPaint\.sig = null;/m);
  assert.ok(sigClearAt > -1 && armAt > sigClearAt,
    'and clear the grid signature too, for the reason renderHome clears homeInbox.sig');
});

/* U7 — the final review's findings. Same discipline as U5/U6, pushed further where it can be: every
 * rule here that is pure is LIFTED OUT AND RUN, including two that previously looked unliftable.
 * wireConfirmDismiss touches only `document`, so `document` becomes an env entry and the whole
 * dismissal is exercised for real; doDelete (U5, above) closes over its caller's locals, so the host
 * function is fnBody'd first and the nested declaration lifted out of that. What remains a source
 * assertion pins ORDERING and CONTROL FLOW, never the presence of a constructed string — and every
 * one of these was mutation-proved by breaking the behaviour and watching it fail. The rendering,
 * the live DOM and the accessibility tree are verified in a real browser. */

test('U7: an abandoned delete-confirm has a way out, and the way out is Cancel', () => {
  const ui = readUi();

  // The hold an open confirm puts on a polled list has no ceiling (see U6), which is only
  // defensible while a confirm is always ANSWERED. Nothing guaranteed that: Escape did nothing,
  // clicking away did nothing. Measured — confirm open + 14s + a newly started job → rows unchanged,
  // with no bound on how much longer. This is the exit that makes the uncapped hold honest.
  //
  // It reads `document` and nothing else, so it is run rather than read: a wiring that never
  // cancels, one that cancels on the wrong event, and one that keeps listening after the confirm is
  // gone are all visible here.
  const mkDoc = () => {
    const at = new Map();
    return {
      added: [],
      addEventListener(type, fn, capture) {
        this.added.push([type, capture]);
        if (!at.has(type)) at.set(type, []);
        at.get(type).push(fn);
      },
      removeEventListener(type, fn) {
        const a = at.get(type) || [];
        const i = a.indexOf(fn);
        if (i > -1) a.splice(i, 1);
      },
      live(type) { return (at.get(type) || []).length; },
      fire(type, ev) { for (const fn of [...(at.get(type) || [])]) fn(ev); },
    };
  };
  const harness = ({ connected = true, inside = false } = {}) => {
    const seen = { cancelled: 0, flushed: 0, prevented: 0 };
    const doc = mkDoc();
    const { wireConfirmDismiss } = liftUi(ui, ['function wireConfirmDismiss('], {
      document: doc,
      flushHomeInboxSoon: () => { seen.flushed++; },
    });
    const el = { isConnected: connected, contains: () => inside };
    wireConfirmDismiss(el, () => { seen.cancelled++; });
    return { doc, seen, el, key: (k) => doc.fire('keydown', { key: k, preventDefault: () => { seen.prevented++; } }), down: () => doc.fire('pointerdown', { target: {} }) };
  };

  // Both listeners, both in capture — a handler that stops propagation on the way up must not be
  // able to swallow the only way out.
  const esc = harness();
  assert.deepEqual(esc.doc.added, [['keydown', true], ['pointerdown', true]],
    'the confirm must listen for Escape and for a press outside, both in the capture phase');

  // Escape cancels, exactly once, and unhooks — a listener still live after the confirm is gone
  // cancels the NEXT confirm out from under the user.
  esc.key('Escape');
  assert.equal(esc.seen.cancelled, 1, 'Escape must dismiss the confirm');
  assert.equal(esc.seen.prevented, 1, 'and claim the keystroke');
  assert.equal(esc.doc.live('keydown') + esc.doc.live('pointerdown'), 0,
    'and both listeners must come off with it');
  esc.key('Escape');
  assert.equal(esc.seen.cancelled, 1, 'a second Escape must reach nothing');
  assert.equal(esc.seen.flushed, 1,
    'and the dismissal must release the held repaint, as the Cancel click does through the zone');

  // Any other key is not an answer.
  const other = harness();
  other.key('Enter'); other.key('a'); other.key('ArrowDown');
  assert.equal(other.seen.cancelled, 0, 'only Escape dismisses');
  assert.equal(other.doc.live('keydown'), 1, 'and the confirm keeps listening');

  // A press OUTSIDE dismisses; a press inside is the user aiming at Delete or Cancel and must not.
  const away = harness({ inside: false });
  away.down();
  assert.equal(away.seen.cancelled, 1, 'a press outside the confirm must dismiss it');
  const within = harness({ inside: true });
  within.down();
  assert.equal(within.seen.cancelled, 0,
    'a press inside must not — that is the user reaching for one of its own two buttons');
  assert.equal(within.doc.live('pointerdown'), 1, 'and the confirm keeps listening');

  // The confirm can also leave without either button: a repaint past the ceiling takes it. The
  // listeners must then unhook and cancel NOTHING — running showDefault against a detached wrap is
  // work on a DOM nobody is looking at.
  const dead = harness({ connected: false });
  dead.key('Escape');
  assert.equal(dead.seen.cancelled, 0, 'a confirm already out of the DOM must not be cancelled');
  assert.equal(dead.doc.live('keydown') + dead.doc.live('pointerdown'), 0,
    'and its listeners must unhook themselves rather than wait for buttons that are gone');

  // And the structural half: the dismissal is handed the CANCEL path, never the delete. This is
  // what makes "a dismissal is never read as consent" a property of the wiring rather than a hope —
  // wireConfirmDismiss is only ever given one function, and it is showDefault on both surfaces.
  const confirm = codeOnly(fnBody(fnBody(ui, 'function workspaceRow('), 'function showConfirm()'));
  assert.match(confirm, /wireConfirmDismiss\(confirmEl, showDefault\)/,
    'the row must give the dismissal the same function Cancel runs, never doDelete');
  assert.ok(!/wireConfirmDismiss\([^)]*doDelete/.test(confirm),
    'a dismissal that deleted would be worse than the freeze it fixes');
  // And there is exactly ONE of these confirms now. The rule used to have to hold on two surfaces at
  // once — "one confirm drawn on two surfaces must not have a way out on only one of them" — and the
  // surest way to keep that true is for there to be one confirm: the declaration, and a single call.
  assert.equal((ui.match(/wireConfirmDismiss\(/g) || []).length, 2,
    'one wireConfirmDismiss declaration and one call site — a second list-side confirm is a second '
    + 'chance to ship one without an exit');
});

test('U7: a reload paints the jobs it already knows, not an empty queue', () => {
  const ui = readUi();
  const home = codeOnly(fnBody(ui, 'async function renderHome('));

  // renderHome() is how a completed job gets its fresh data (homeInbox.reload → releaseHomeInbox),
  // so this first paint runs precisely when OTHER jobs are still running — and `renderHomeInbox([])`
  // dropped every one of them. Measured 4.2s: a still-running job vanished from its row, the row
  // fell back to "Needs you", homeInbox.reqs was overwritten with [] so the strip lost its dedupe
  // too, and the next tick put it all back.
  assert.match(home, /renderHomeInbox\(homeInbox\.reqs\)/,
    'the first paint must use the jobs this view last saw');
  assert.ok(!/renderHomeInbox\(\[\]\)/.test(home),
    'never an empty queue — that blanks every live binding for a whole tick');
  // And the cache it paints from must survive the reset above it, or this is the same blank by a
  // different route: `reqs` is deliberately NOT one of the four fields a fresh zone clears.
  assert.ok(!/homeInbox\.reqs = \[\]/.test(home),
    'and the reset must not clear reqs — that would re-create the hole it is closing');
  assert.match(codeOnly(fnBody(ui, 'function renderHomeInbox(')), /homeInbox\.reqs = requests/,
    'the cache is refilled by the render that consumed it');
});

test('U7: a spec job is described in spec words', () => {
  const ui = readUi();
  const grab = (re, what) => { const m = ui.match(re); assert.ok(m, what); return m[0]; };
  const states = grab(/const WS_STATES = \[[\s\S]*?\n\];/, 'WS_STATES must be one table');
  const index = grab(/^const WS_STATE_INDEX = .*$/m, 'WS_STATE_INDEX must be module scope');
  const fallback = grab(/^const WS_FALLBACK_STATE = .*$/m, 'WS_FALLBACK_STATE must be module scope');
  const perKind = grab(/const JOB_LABELS_BY_KIND = \{[\s\S]*?\n\};/,
    'the per-kind job labels must be one table, at module scope');
  const applyVerb = grab(/const APPLY_VERB = \{[\s\S]*?\n\};/,
    'where an apply is writing must be one table too');
  const actionLabel = grab(/^const REQ_ACTION_LABEL = .*$/m, 'REQ_ACTION_LABEL must be module scope');

  // All pure lookups, so they are run.
  const { wsStateLabel } = liftUi(ui,
    [states, index, fallback, perKind, 'function wsState(', 'function wsStateLabel(']);
  const { jobVerb } = liftUi(ui, [applyVerb, actionLabel, 'function jobVerb(']);

  // The bug: WS_STATES' labels are the pr-review ones, and every kind wore them. A running spec
  // audit read "Re-reviewing" and a spec apply read "Posting review" / "Posting to PR" — all three
  // naming a pull request that a spec workspace does not have.
  assert.equal(wsStateLabel('job-reviewing', 'spec'), 'Auditing');
  assert.equal(wsStateLabel('job-rereviewing', 'spec'), 'Re-auditing');
  assert.equal(wsStateLabel('job-posting', 'spec'), 'Applying changes');
  assert.equal(jobVerb({ action: 'audit' }, false, 'spec'), 'Auditing');
  assert.equal(jobVerb({ action: 'audit' }, true, 'spec'), 'Re-auditing',
    'and the verb splits on prior findings exactly as the pill does, so the two cannot disagree');
  assert.equal(jobVerb({ action: 're-audit' }, true, 'spec'), 'Re-auditing');
  assert.equal(jobVerb({ action: 'propose' }, true, 'spec'), 'Drafting changes',
    'and `propose` must not fall through to its raw action name');
  assert.match(jobVerb({ action: 'apply' }, true, 'spec'), /spec/i);
  assert.ok(!/PR/.test(jobVerb({ action: 'apply' }, true, 'spec')),
    'a spec apply writes back to the spec — there is no PR anywhere near it');

  // pr-review is the vocabulary the defaults already were, and it must be untouched.
  for (const [key, label] of [['job-reviewing', 'Reviewing'], ['job-rereviewing', 'Re-reviewing'],
    ['job-posting', 'Posting review']]) {
    assert.equal(wsStateLabel(key, 'pr-review'), label, `pr-review must keep "${label}"`);
    assert.equal(wsStateLabel(key, undefined), label,
      'and an unnamed kind must fall back to the table, not to a blank');
    assert.equal(wsStateLabel(key, 'no-such-kind'), label, 'as must an unknown one');
  }
  assert.equal(jobVerb({ action: 'apply' }, true, 'pr-review'), 'Posting to PR');
  assert.equal(jobVerb({ action: 'pr-review' }, true, 'pr-review'), 'Re-reviewing');
  assert.equal(jobVerb({ action: 'apply' }, true, undefined), 'Posting to PR',
    'and an apply with no kind keeps the wording every caller meant before');

  // pr-respond is a third vocabulary, not a second copy of pr-review's: replying to reviewer
  // threads is not reviewing, and its apply posts replies rather than a review.
  assert.equal(wsStateLabel('job-reviewing', 'pr-respond'), 'Responding');
  assert.equal(wsStateLabel('job-posting', 'pr-respond'), 'Posting replies');
  assert.equal(jobVerb({ action: 'apply' }, true, 'pr-respond'), 'Posting replies');

  // Labels only. The band a live job lands in is categoryOf's, and it must stay kind-free — "a
  // runner is mid-way through this" is the same fact whatever the workspace is, and a per-kind band
  // map is the WS_BANDS drift this whole arrangement exists to prevent.
  const cat = codeOnly(fnBody(ui, 'function categoryOf('));
  assert.ok(!/kind/.test(cat),
    'categoryOf must not learn about kinds — only the words are per-kind, never the banding');
  for (const key of ['job-posting', 'job-rereviewing', 'job-reviewing']) {
    assert.match(perKind, new RegExp(`'${key}'`),
      `${key} must have a per-kind wording, since it is a PR word by default`);
  }
  // Every key the table renames must be a real state, or it renames nothing and the PR word stands.
  const known = new Set(wsTables(ui).states.map((s) => s.key));
  for (const m of perKind.matchAll(/'(job-[a-z-]+)':/g)) {
    assert.ok(known.has(m[1]), `JOB_LABELS_BY_KIND renames "${m[1]}", which is not in WS_STATES`);
  }
});

test('U7: a workspace-less spec audit still has a row to appear on', () => {
  const ui = readUi();
  const { pendingJobTitle } = liftUi(ui, ['function pendingJobTitle(']);

  // #/spec showed NOTHING for a brand-new audit: placeholders were gated on `r.prId`, which spec
  // actions never carry (ledger.js takes wsId OR instructions), and that page has no requests strip.
  // No card, no placeholder, no strip — the only surface a first audit had was Home's strip, one
  // navigation away. What a placeholder actually needs is a NAME, and this is that requirement
  // stated directly.
  assert.equal(pendingJobTitle({ action: 'audit', title: 'Checkout redesign' }), 'Checkout redesign');
  assert.equal(
    pendingJobTitle({ action: 'audit', instructions: 'https://conf/spec/42\nhttps://ado/1234' }),
    'https://conf/spec/42',
    'with no title, the first line of what it was queued with identifies the run');
  assert.equal(pendingJobTitle({ action: 'audit', instructions: '\n\n  just the payment flow  \n' }),
    'just the payment flow', 'trimmed, and blank leading lines skipped');
  // A title always wins, and the PR number is still the PR placeholder's name.
  assert.equal(pendingJobTitle({ action: 'pr-review', prId: 7001 }), 'PR 7001');
  assert.equal(pendingJobTitle({ action: 'pr-review', prId: 7001, title: 'Checkout #7001' }),
    'Checkout #7001');
  // And the refusal is still real: an anonymous job draws no card. A "starting…" box naming no work
  // is worse than no box, and it is what an unconditional filter would have produced.
  for (const job of [{ action: 'audit' }, { action: 'audit', instructions: '' },
    { action: 'audit', instructions: '   \n  \n' }]) {
    assert.equal(pendingJobTitle(job), null, 'a job with nothing to call itself draws no placeholder');
  }

  // The filter asks exactly that question, and the card takes its name from the same function, so
  // "may it exist" and "what is it called" can never be two different answers.
  const entries = codeOnly(fnBody(ui, 'function sectionEntries('));
  const cardSrc = codeOnly(fnBody(ui, 'function pendingJobRow('));
  assert.match(entries, /pendingJobTitle\(r\)/, 'the placeholder filter must gate on the name');
  assert.ok(!/r\.prId/.test(entries),
    'and no longer on prId, which is the gate that made a first spec audit invisible');
  assert.match(cardSrc, /pendingJobTitle\(job\)/, 'and the row must take its title from it too');
  // The instructions can BE the title; printing them twice says the same sentence under itself.
  assert.match(cardSrc, /job\.instructions !== title/,
    'a placeholder named from its instructions must not repeat them on its meta line');
  // The placeholder's job line speaks the section's vocabulary, because that is the only kind it
  // can have — actsOnKind is what let the job onto this page at all.
  assert.match(cardSrc, /cardJobRow\(job, false, kind\)/,
    'and the job line must be told which section it is on, or a spec audit says "Reviewing"');
});

test('U7: the strip does not deny the note beside it', () => {
  const ui = readUi();
  const poll = codeOnly(fnBody(ui, 'function startHomeRequestsPoll('));

  // While held, the strip read "N jobs in flight — already shown on the rows below" while no row
  // showed them, and the held note directly below said the queue above had moved on and the rows had
  // not. The note is the true half. The strip must soften its dedupe clause rather than assert the
  // opposite of the sentence underneath it — and must not go silent, because where the jobs went is
  // still the thing worth saying.
  const heldAt = poll.indexOf('homeInbox.pending');
  const stripAt = poll.indexOf('populateRequestsStrip(');
  assert.ok(heldAt > -1, 'the strip must know whether the rows below it are held');
  assert.ok(stripAt > heldAt, 'and know it before it writes its sentence');
  // Both clauses the strip writes must be BRANCHES of that question, not one sentence with a
  // second one added beside it: asserting only that the softened wording exists somewhere passed
  // with the dedupe claim left unconditional, which is the bug.
  assert.match(poll, /behind \? '[^']*catching up[^']*' : '[^']*already shown on the rows below\.'/,
    'the dedupe claim may only be made on the branch where the rows are NOT behind');
  assert.match(poll, /behind \? '[^']*catching up[^']*' : '[^']*on the rows below'/,
    'and the head-note that counts them must split the same way, or half the strip still denies it');
  assert.match(poll, /plural\(active\.length, 'job', 'jobs'\)\} in flight/,
    'either way the strip still says how much work is in flight');
  // The rows' own admission is what the strip is being made consistent WITH, so it must still be
  // the same table it always was (U6 pins its wording).
  assert.match(ui, /const HOME_HELD_NOTE = \{[\s\S]*?queue above has moved on[\s\S]*?\n\};/,
    'the note the strip must agree with stays where it is');
});

test('U7: an idle section grid repaints nothing', () => {
  const ui = readUi();
  const poll = codeOnly(fnBody(ui, 'function startSectionRequestsPoll('));

  // The inbox has had "a tick that changes nothing touches nothing" since 316edb0; the grid
  // repainted unconditionally every 4s. That was survivable only while the hold was unconditional
  // too — with the busy ceiling above it (4406176) it became a GUARANTEED tear-down every 12
  // seconds on a section nobody is changing. Measured on an idle grid with focus parked on a card:
  // 2 focusout / 3 focusin across 40 seconds, and a text selection dying at ~16s.
  const entriesAt = poll.indexOf('sectionEntries(kind, state.section.features, rel)');
  const sigAt = poll.indexOf('sectionGridSig(entries)');
  const skipAt = poll.indexOf('if (sig === gridPaint.sig)');
  const holdAt = poll.indexOf('holdStands(hold, gridHold)');
  const paintAt = poll.indexOf('zone.replaceChildren(');
  const recordAt = poll.indexOf('gridPaint.sig = sig');
  assert.ok(entriesAt > -1 && sigAt > entriesAt, 'the tick must sign the entries it is about to draw');
  assert.ok(skipAt > sigAt && paintAt > skipAt,
    'and compare BEFORE the repaint, or the comparison decides nothing');
  assert.match(poll.slice(skipAt, holdAt), /return;/,
    'an unchanged signature must return without ever reaching replaceChildren');
  assert.match(poll.slice(skipAt, holdAt), /clearZoneHeldNote\(zone\)/,
    'and with nothing outstanding it must take the held note down — a paused sign over a list that '
    + 'is not behind is the same contradiction pointing the other way');
  assert.ok(recordAt > paintAt,
    'the signature must be recorded after the paint landed — stamped earlier, a held tick would '
    + 'make its own skip permanent and the deferred change becomes a dropped one');
  // ONE decision, signed and then drawn. categoryOf reads the clock through isStaleJob, so deciding
  // twice per tick lets the comparison and the render disagree about the same job.
  assert.equal((poll.match(/sectionEntries\(/g) || []).length, 1,
    'the entries must be computed once per tick and handed to the render');
  assert.match(poll, /sectionGrid\(kind, entries\)/, 'which draws exactly what was signed');

  // And the signature is the inbox's, not a second one. Two signature functions for two lists drawn
  // by one band loop is the drift WS_BANDS/WS_STATES exist to prevent, one level up again.
  assert.match(codeOnly(fnBody(ui, 'function sectionGridSig(')), /bandedListSig\(/,
    'the grid must sign itself with the shared signature');
  assert.ok(!/function (sectionSig|gridSig)\(/.test(ui), 'and grow no second one of its own');

  // Run it. The shapes the grid adds over the inbox are a placeholder entry (no workspace at all)
  // and `rev`, and both have to move the answer.
  const grab = (re) => { const m = ui.match(re); assert.ok(m, `web/app.js must declare ${re}`); return m[0]; };
  const gridPaint = { sig: null, rev: 0 };
  const { sectionGridSig } = liftUi(ui, [
    'function fmtDate(', 'function fmtDateTime(', 'function fmtAgo(', 'function fmtAge(',
    'function reviewStampsOf(', grab(/^const JOB_STALE_MS = .*$/m), 'function jobAgeMs(',
    'function isStaleJob(', 'function rowAgeText(',
    grab(/const WS_STATES = \[[\s\S]*?\n\];/), grab(/^const WS_STATE_INDEX = .*$/m),
    grab(/^const WS_FALLBACK_STATE = .*$/m), 'function wsState(',
    'function listEntrySig(', 'function bandedListSig(', 'function sectionGridSig(',
  ], { runnerBusy: () => false, gridPaint });

  const ws = (id) => ({ id, title: id });
  const job = (over = {}) => ({ id: 'j1', status: 'running', action: 'pr-review', updatedAt: new Date().toISOString(), ...over });
  const board = () => ({
    pending: [{ ws: null, job: job({ id: 'j9' }), cat: 'job-reviewing' }],
    active: [{ ws: ws('pr-1'), job: job(), cat: 'job-reviewing' },
      { ws: ws('pr-2'), job: null, cat: 'awaiting-author' }],
    done: [{ ws: ws('pr-3'), job: null }],
  });

  assert.equal(sectionGridSig(board()), sectionGridSig(board()),
    'an unchanged grid must sign identically — this is the whole of "an idle tick touches nothing"');

  const moved = board(); moved.active[1].cat = 'author-responded';
  assert.notEqual(sectionGridSig(board()), sectionGridSig(moved), 'a card changing band must show');
  const stopped = board(); stopped.active[0].job = null;
  assert.notEqual(sectionGridSig(board()), sectionGridSig(stopped), 'a job ending must show');
  const queued = board(); queued.active[0].job = job({ status: 'queued' });
  assert.notEqual(sectionGridSig(board()), sectionGridSig(queued),
    'and "queued → running" is a visible change on the card even when the band does not move');
  const gone = board(); gone.pending = [];
  assert.notEqual(sectionGridSig(board()), sectionGridSig(gone),
    'a placeholder appearing or leaving must show, exactly as a card does');
  const other = board(); other.pending[0].job = job({ id: 'j8' });
  assert.notEqual(sectionGridSig(board()), sectionGridSig(other),
    'and one placeholder is not another');
  const finished = board(); finished.done = [];
  assert.notEqual(sectionGridSig(board()), sectionGridSig(finished),
    'the Done disclosure prints a count, so its contents are in the signature too');

  // `rev` is the term the inbox does not need: state.home.rows is only refilled by renderHome(),
  // which rebuilds the zone outright, but state.section.features is replaced IN PLACE by this poll —
  // and what comes back is exactly the scores, counts and stamps the cards draw. Without this, a
  // refetch that changed every number on the page but no band would be skipped.
  const before = sectionGridSig(board());
  gridPaint.rev++;
  assert.notEqual(before, sectionGridSig(board()),
    'a refetch of the cards\' own data must move the signature even when no band did');
  assert.match(poll, /gridPaint\.rev\+\+/, 'and the refetch must be what bumps it');
  const bumpAt = poll.indexOf('gridPaint.rev++');
  assert.ok(bumpAt > -1 && bumpAt < entriesAt,
    'before the signature is taken, or the tick that refetched is the tick that skips');
});

/* replaceChildren() is a DOM method, not h(). h() drops a null child; replaceChildren STRINGIFIES
 * it, so a `cond ? node : null` argument renders the literal word "null" whenever cond is false.
 * That shipped: in read-only mode with an empty queue the runner zone printed "null" beside the
 * Refresh button. The first test runs the real function and checks what reaches replaceChildren;
 * the second catches the whole class, because this idiom is correct everywhere h() is the caller
 * and wrong every time the DOM is. */
test('U8: an empty read-only runner zone clears itself instead of printing "null"', () => {
  const ui = readUi();
  const { renderRunnerZone } = liftUi(ui,
    ['function plural(', 'function renderRunnerZone('],
    {
      // Read-only with no runner status is the exact configuration that printed it.
      readOnlyMode: () => true,
      runnerStatus: () => null,
      READ_ONLY_TITLE: 'read-only',
      // The zone never builds a node in the empty case; in the queued case we only care THAT a node
      // is handed over, not what it looks like.
      h: (tag, attrs, ...kids) => ({ tag, attrs, kids }),
    });

  const calls = [];
  const zone = { dataset: {}, replaceChildren: (...args) => calls.push(args) };

  renderRunnerZone(zone, 0);
  assert.equal(calls.length, 1, 'the empty case must still clear the zone');
  assert.deepEqual(calls[0], [],
    'with NO arguments — passing null renders the text "null", which is what the bug was');

  renderRunnerZone(zone, 2);
  assert.equal(calls[1].length, 1, 'a queued read-only zone still says why it will not run');
  assert.ok(calls[1][0] && typeof calls[1][0] === 'object',
    'and what it hands over is a node, never a bare value the DOM would stringify');
});


test('U8: no replaceChildren call is handed a bare null', () => {
  const ui = readUi();
  const NEEDLE = 'replaceChildren(';
  const offenders = [];

  for (let at = ui.indexOf(NEEDLE); at > -1; at = ui.indexOf(NEEDLE, at + 1)) {
    // Read the call's real argument list, balanced, so a wrapped call is read whole.
    let depth = 0;
    let end = at + NEEDLE.length - 1;
    for (let i = end; i < ui.length; i++) {
      if (ui[i] === '(') depth++;
      else if (ui[i] === ')' && --depth === 0) { end = i; break; }
    }
    const args = ui.slice(at + NEEDLE.length, end);

    // Only a TOP-LEVEL `: null` can reach the DOM. One nested inside an h(...) argument is fine —
    // h() drops null children, which is exactly why the idiom is safe everywhere else and unsafe
    // here — and one inside a list that ends in .filter(Boolean) has already been removed.
    let d = 0;
    for (let i = 0; i < args.length; i++) {
      const c = args[i];
      if (c === '(' || c === '[' || c === '{') d++;
      else if (c === ')' || c === ']' || c === '}') d--;
      else if (c === ':' && d === 0 && /^:\s*null(\s|,|$)/.test(args.slice(i))) {
        offenders.push(`${ui.slice(0, at).split('\n').length}: ${args.trim().slice(0, 60)}`);
        break;
      }
    }
  }

  assert.deepEqual(offenders, [],
    'a top-level `cond ? node : null` argument to replaceChildren renders the literal word "null" '
    + 'when cond is false — spread an array, .filter(Boolean), or guard the call');
});

/* U9 — one row renderer for every list of workspaces. Home and the three kind sections drew the
 * same object two ways (inboxRow and featureCard/compactCard), which is the drift this file already
 * has three scars from: the job-binding rule shipped wrong twice because it was written twice, and
 * the band/density mapping was written twice as well. These pin that there is now ONE renderer, and
 * that the two things that genuinely differ between the surfaces are driven by an explicit argument
 * rather than by asking what the current route is.
 *
 * rowParts is pure, so it is RUN (liftUi) rather than read: "what does a compact section row draw"
 * is a mapping, and a mapping asserted by pattern-matching its own text is a mapping that agrees
 * with itself and nothing else. */

test('U9: one renderer draws every workspace row, on both surfaces', () => {
  const ui = readUi();

  // The second renderer is gone, not merely unused: a featureCard left in the file is a function the
  // next change can call, and then there are two answers to "what does a workspace look like" again.
  for (const gone of ['function featureCard(', 'function compactCard(']) {
    assert.ok(!ui.includes(gone), `${gone} must be deleted, not left for something to call again`);
  }
  // Both lists go through the one renderer, each naming the surface it is drawing.
  assert.match(codeOnly(fnBody(ui, 'function renderHomeInbox(')),
    /workspaceRow\(e\.ws, e\.job, density, e\.cat, ROW_HOME\)/,
    'Home must draw its bands with the shared renderer');
  assert.match(codeOnly(fnBody(ui, 'function sectionGrid(')),
    /workspaceRow\(e\.ws, e\.job, density, e\.cat, ROW_SECTION\)/,
    'and a section must draw its bands with the same one');
  // The surface is an ARGUMENT. Reading current.view inside the renderer would put the answer back
  // in the one place that cannot be told which list it is in — the Done disclosure and the bands
  // both call it, and a route is not a list.
  const row = codeOnly(fnBody(ui, 'function workspaceRow('));
  assert.ok(!/current\.(view|kind)/.test(row),
    'the renderer must not sniff the route — which surface it is on comes in on `opts`');
  assert.ok(!/current\.(view|kind)/.test(codeOnly(fnBody(ui, 'function rowParts('))),
    'nor may the part table, which is where that temptation would land next');

  // The placeholder is a row too, at both densities, and keeps the dashed treatment that says it is
  // not a workspace yet. It deliberately does NOT go through workspaceRow — there is no workspace,
  // and inventing one to render one is the fake data this cockpit refuses — so what has to hold is
  // that it wears the row's own classes.
  const pending = codeOnly(fnBody(ui, 'function pendingJobRow('));
  assert.match(pending, /class: `inbox-row ir-pending\$\{compact \? ' ir-compact' : ''\}`/,
    'a placeholder must be an inbox-row at whichever density the band gave it');
  assert.ok(!/feature-card|fc-compact|fc-title\b/.test(pending),
    'and must not keep any of the card classes it used to wear');
  const css = cssRules(fs.readFileSync(path.join(__dirname, '..', 'web', 'style.css'), 'utf8'));
  assert.match(css, /\.inbox-row\.ir-pending \{[^}]*border-style: dashed/,
    'the dashed border is what says "not a workspace yet" — without it the placeholder claims to be '
    + 'a real row, and the only other thing it says is "starting…"');
});

test('U9: the kind badge is Home\'s, and the section material is the section\'s', () => {
  const ui = readUi();
  // Both surface tables, read from the source and RUN through the real mapping. Re-typing them here
  // would let the test agree with itself while the app disagreed with both.
  const optsOf = (name) => {
    const m = ui.match(new RegExp(`^const ${name} = (\\{[^}]*\\});$`, 'm'));
    assert.ok(m, `${name} must be one object literal at module scope`);
    // eslint-disable-next-line no-new-func
    return new Function(`return ${m[1]};`)();
  };
  const { rowParts } = liftUi(ui, ['function rowParts(']);
  const home = (d, done = false) => rowParts(optsOf('ROW_HOME'), d, done);
  const section = (d, done = false) => rowParts(optsOf('ROW_SECTION'), d, done);

  // The badge: Home is cross-kind and needs it to tell a spec row from a PR row; inside a section
  // every row is the same kind, so it would be the page's own title repeated once per row.
  assert.equal(home('full').kindBadge, true, 'Home must keep the kind badge');
  assert.equal(home('compact').kindBadge, true, 'at every density — a parked row is still a kind');
  assert.equal(section('full').kindBadge, false, 'a section row must not repeat its section\'s kind');
  assert.equal(section('compact').kindBadge, false);

  // The section material — severity counts, sources/last-round line, lifecycle chip, waiting-on-
  // author line — rides the FULL band of a SECTION and nothing else. Home never had it and the
  // owner picked Home as the reference; a compact band is parked, and a done row is answered.
  assert.equal(section('full').sectionFull, true,
    'the full section row must carry what the full card carried — those counts are why the section '
    + 'exists as something other than a filtered Home');
  assert.equal(section('compact').sectionFull, false,
    'a compact row must not — nothing in those bands is waiting on a decision from you');
  assert.equal(section('full', true).sectionFull, false,
    'nor a done row, for the same reason its needs-you counts already drop out');
  assert.equal(home('full').sectionFull, false, 'and Home must be left exactly as it was');
  assert.equal(home('compact').sectionFull, false);

  // The density rules the row already had, now stated where both surfaces read them.
  for (const at of [home, section]) {
    assert.equal(at('full').dial, true, 'a full row weighs a score, so it draws the dial');
    assert.equal(at('compact').dial, false, 'a compact one does not');
    assert.equal(at('compact').stamp, true, 'and earns the one stamp that says why it is parked');
    assert.equal(at('full').stamp, false, 'which the full row does not need — it has the rest');
    assert.equal(at('full').bits, true);
    assert.equal(at('compact').bits, false);
    assert.equal(at('full', true).bits, false, 'a completed workspace never nags');
  }

  // And the renderer actually gates on those fields rather than re-deciding beside them.
  const row = codeOnly(fnBody(ui, 'function workspaceRow('));
  assert.match(row, /part\.kindBadge \? kindBadge\(kind\) : null/, 'the badge is drawn through the table');
  assert.match(row, /part\.sectionFull \? sevCountsRow\(rd\.openBySeverity\) : null/,
    'the severity counts too — and from the readiness the row already resolved');
  assert.match(row, /part\.sectionFull \? rowMetaLine\(r, kind\) : null/, 'and the sources line');
  assert.match(row, /part\.sectionFull && r\.awaitingAuthor \? cardReviewRow\(r\) : null/,
    'and the waiting-on-author line, which is the third thing the full card said');
});

test('U9: nothing the row draws is left unstyled, and nothing styled is left undrawn', () => {
  const ui = readUi();
  const css = cssRules(fs.readFileSync(path.join(__dirname, '..', 'web', 'style.css'), 'utf8'));

  // The card's own classes went with it. Each of these selected an element that no view builds any
  // more; left behind they are rules the next reader has to prove are dead before touching anything.
  for (const dead of ['.features-grid', '.feature-card', '.fc-titlewrap', '.fc-top', '.fc-title',
    '.fc-meta', '.fc-chips', '.fc-why', '.fc-compact', '.fc-wrap', '.fc-delete', '.fc-done',
    '.fc-stamps', '.fc-pending', '.skel-card']) {
    assert.ok(!new RegExp(`\\${dead}\\b`).test(css), `style.css must not still style ${dead}`);
  }
  // And the reverse, which is the failure that actually shows on screen: every class the row and the
  // placeholder emit must be selected by something. `.ir-meta` and `.ir-pending-dial` are new here,
  // and an unstyled .ir-meta is a sources line in the wrong font with no separators.
  for (const live of ['.inbox', '.inbox-row', '.ir-wrap', '.ir-main', '.ir-top', '.ir-title',
    '.ir-needs', '.ir-compact', '.ir-meta', '.ir-pending', '.ir-pending-dial', '.ir-delete',
    '.ir-stamps', '.ir-arrow', '.sev-counts', '.fc-job', '.fc-review', '.delete-confirm']) {
    // The class must be selected as a WHOLE class, not merely appear inside a longer name:
    // `.ir-meta-x` contains ".ir-meta" and styles nothing the row emits.
    assert.match(css, new RegExp(`\\${live}(?![\\w-])`),
      `style.css must still style ${live} — the row draws it`);
  }
  // The job tints are shared between the two surfaces by name, and only one surface is left, so the
  // card half of each pair had to go without taking the row half with it.
  assert.ok(!/\.feature-card\.fc-busy/.test(css), 'the card half of the job tints is gone');
  assert.match(css, /\.inbox-row\.fc-busy-needs \{/, 'and the row half is not');

  // The one container the bands stack into is the row list, on both surfaces.
  assert.match(codeOnly(fnBody(ui, 'function sectionGrid(')), /\), 'inbox'\);/,
    'a section must band its rows into the same .inbox list Home does');
  assert.match(codeOnly(fnBody(ui, 'async function renderSection(')), /skel\('skel-row'\)/,
    'and its loading skeleton must be row-shaped, or the first paint shifts the whole list');
  // The zone the poll writes into is named for what it holds; both references move together.
  assert.equal((ui.match(/section-list-zone/g) || []).length, 2,
    'the section list zone is created once and found once — a rename that missed one would leave '
    + 'the poll writing into nothing, silently');
  assert.ok(!ui.includes('features-grid'), 'and no reference to the old grid may survive anywhere');
});

/* ============================================================================================
 * V — "which link is which": source roles, the Vertec booking line, the PR quick link, the summary.
 * The complaint these answer: every Azure DevOps source wore one checkbox icon, so opening the user
 * story meant reading a truncated title and clicking the PR by mistake.
 * ========================================================================================== */

/* The real shape of a pr-review workspace's sources, as `/flowlever:pr-review` registers them:
 * the PR first (it is what the review is of), then the story, then the epic above it. */
function prWorkspaceSources() {
  return {
    confluence: [
      { id: '988446724', title: 'Atrius migration — specification (index)', url: 'https://uniccom.atlassian.net/wiki/x/BIDqOg' },
    ],
    ado: [
      { id: 5882, type: 'Pull Request', title: "PR #5882 — [43057] Atrius 2.3: the map reads in the visitor's language",
        url: 'https://dev.azure.com/FZAG/dxp/_git/DXP-Website/pullrequest/5882' },
      { id: 43057, type: 'User Story', title: "Atrius 2.3 — The map reads in the visitor's language",
        url: 'https://dev.azure.com/FZAG/dxp/_workitems/edit/43057',
        vertecPhase: 'Maps Integration // 12. Atrius 2.3 — The map looks and reads like a DXP map' },
      { id: 43049, type: 'Feature', title: 'Epic 2 — Map parity with PointConsulting (parent of 43057)',
        url: 'https://dev.azure.com/FZAG/dxp/_workitems/edit/43049' },
    ],
    figma: [],
  };
}

function liftSources(ui) {
  const decl = fnSource(ui, 'const SOURCE_ROLES = ');
  return {
    // The role table is read from the source, never re-typed here: a test carrying its own copy
    // would keep passing while the strip rendered something else.
    // eslint-disable-next-line no-new-func
    SOURCE_ROLES: new Function(`${decl};\nreturn SOURCE_ROLES;`)(),
    ...liftUi(ui, [decl, 'function isPrUrl(', 'function adoRole(', 'function trimIdPrefix(', 'function sourceEntries(']),
  };
}

test('V1: every source names what it IS, and the two you reach for come first', () => {
  const ui = readUi();
  const { adoRole, sourceEntries, trimIdPrefix } = liftSources(ui);

  // The mapping that carries the whole feature: the work-item type decides the role.
  assert.equal(adoRole({ type: 'Pull Request' }), 'pr');
  assert.equal(adoRole({ type: 'User Story' }), 'story');
  assert.equal(adoRole({ type: 'Product Backlog Item' }), 'story', 'the Agile and Scrum templates name the same thing differently');
  assert.equal(adoRole({ type: 'Bug' }), 'bug');
  assert.equal(adoRole({ type: 'Feature' }), 'feature');
  assert.equal(adoRole({ type: 'Epic' }), 'epic');
  assert.equal(adoRole({ type: 'user story' }), 'story', 'the type is compared case-insensitively');
  // An ADO instance can carry types we do not map; it must still get a role rather than throw.
  assert.equal(adoRole({ type: 'Impediment' }), 'item');

  // The fallback that makes this work on the workspaces the user already has: everything reviewed
  // before `--itemType` was passed carries NO type at all, and those are exactly the PRs on screen
  // today. A /pullrequest/<id> url is unambiguous.
  assert.equal(adoRole({ url: 'https://dev.azure.com/FZAG/dxp/_git/DXP-Website/pullrequest/5882' }), 'pr',
    'an untyped source at a pull-request url is a PR');
  assert.equal(adoRole({ url: 'https://dev.azure.com/FZAG/dxp/_workitems/edit/43057' }), 'item',
    'but an untyped work item is never guessed into a story');
  assert.equal(adoRole({}), 'item');

  const entries = sourceEntries({ sources: prWorkspaceSources() });
  assert.deepEqual(entries.map((e) => e.role), ['pr', 'story', 'feature', 'spec'],
    'the PR and its story sort first — they are what the reviewer reaches for');
  assert.deepEqual(entries.map((e) => e.label), ['PR', 'Story', 'Feature', 'Spec']);
  assert.deepEqual(entries.map((e) => e.idText), ['#5882', '#43057', '#43049', '']);

  // The badge already says "PR #5882", so the title must not say it a second time and lose the
  // width that would have shown what the PR is about.
  assert.equal(entries[0].text, "[43057] Atrius 2.3: the map reads in the visitor's language");
  assert.equal(entries[1].text, "Atrius 2.3 — The map reads in the visitor's language",
    'a title that never restated its id is left exactly as it is');

  // trimIdPrefix must never eat the title down to nothing, and must not match a longer number.
  assert.equal(trimIdPrefix('#5882', 5882), '#5882', 'a title that is only its own id keeps it');
  assert.equal(trimIdPrefix('58821 other thing', 5882), '58821 other thing', 'a prefix match must be the whole number');
  assert.equal(trimIdPrefix(null, 5882), '');
  // A BARE leading number is only a restatement when a separator follows. Work item #5 titled
  // "5 Whys analysis of the outage" used to render as "Whys analysis of the outage" — the strip
  // mangling the very title it exists to make identifiable.
  assert.equal(trimIdPrefix('5 Whys analysis of the outage', 5), '5 Whys analysis of the outage');
  assert.equal(trimIdPrefix('2026 roadmap alignment', 2026), '2026 roadmap alignment');
  assert.equal(trimIdPrefix('5 — Whys analysis', 5), 'Whys analysis', 'but with a separator it IS a restatement');
  assert.equal(trimIdPrefix('#5 Whys analysis', 5), 'Whys analysis', 'and the # form needs no separator');
  assert.equal(trimIdPrefix('PR 5882 fixes the thing', 5882), 'fixes the thing');

  // An unmapped type shows its REAL name — "Work item" would throw away what ADO told us.
  const odd = sourceEntries({ sources: { ado: [{ id: 7, type: 'Impediment', title: 'Blocked on vendor' }] } });
  assert.equal(odd[0].label, 'Impediment');

  // Every role the mapper can return must have a row in the table the strip renders from.
  for (const it of [{ type: 'Pull Request' }, { type: 'User Story' }, { type: 'Bug' }, { type: 'Task' },
    { type: 'Feature' }, { type: 'Epic' }, {}]) {
    const { SOURCE_ROLES } = liftSources(ui);
    assert.ok(SOURCE_ROLES[adoRole(it)], `SOURCE_ROLES must describe role ${adoRole(it)}`);
  }
});

test('V1b: nothing the sources strip draws is left unstyled', () => {
  const ui = readUi();
  const css = fs.readFileSync(path.join(__dirname, '..', 'web', 'style.css'), 'utf8');
  const { SOURCE_ROLES } = liftSources(ui);
  for (const role of Object.keys(SOURCE_ROLES)) {
    assert.match(css, new RegExp(`\\.src-role-${role}(?![\\w-])`),
      `style.css must tint .src-role-${role} — an untinted role is a chip that looks like every other`);
    assert.ok(ui.includes(`${SOURCE_ROLES[role].icon}:`) || ['confluence', 'figma'].includes(SOURCE_ROLES[role].icon),
      `ICONS must carry the glyph ${SOURCE_ROLES[role].icon} that role ${role} names`);
  }
  for (const live of ['.src-badge', '.src-id', '.src-text', '.src-out', '.vertec-row', '.vertec-label',
    '.vertec-body', '.vertec-text', '.vertec-missing', '.vertec-phase', '.vertec-phase-label',
    '.vertec-phase-text', '.copy-btn', '.dh-titlerow', '.dh-prlink', '.ws-summary',
    '.ws-summary-label', '.ws-summary-body', '.ws-summary-empty']) {
    assert.match(css, new RegExp(`\\${live}(?![\\w-])`), `style.css must style ${live}`);
  }
});

/* A round that WORKED used to erase its own Re-review. isPosted() and-s in isOpenish(), so it means
 * "posted and still awaiting the author" — the right reading for that lane, the wrong one for "did
 * we ever post?". The moment the author fixed everything and a re-review reconciled the findings to
 * `resolved`, postedFindings() went empty: reviewWait() fell to null, loopActiveStage() fell back to
 * `apply`, the loop strip stopped lighting stage 4, and the button vanished. Measured on the real
 * ledger: 12 of 57 PR workspaces were stranded with no way to re-review from the UI at all. */
test('a fully reconciled PR round keeps its Re-review instead of erasing it', () => {
  const ui = readUi();
  const F = liftUi(ui, [
    'function isOpenish(', 'function isPosted(', 'function isApplied(', 'function isPending(',
    'function isInFlightOrOut(', 'function hasSuggestion(', 'function reviewableFindings(',
    'function postedFindings(', 'function everPostedFindings(', 'function hasPostedToPr(',
    'function appliedFindings(', 'function reviewStampsOf(', 'function reviewWait(',
    'function loopActiveStage(',
  ]);

  // The exact shape of pr-5867 after its author addressed every comment: posted, then resolved.
  const resolved = ['a', 'b', 'c'].map((fp) => ({ fp, status: 'resolved', postedAt: '2026-09-14T10:41:51Z', suggestion: 's' }));
  const data = {
    feature: { kind: 'pr-review', review: { lastPostedAt: '2026-09-14T10:41:51Z', lastActivityAt: '2026-09-18T13:01:46Z' } },
    ledger: { findings: resolved },
  };

  assert.equal(F.postedFindings(resolved).length, 0,
    'precondition: isPosted() is false once reconciliation resolves a posted finding');
  assert.equal(F.hasPostedToPr(data), true,
    'but the workspace HAS posted — that fact must survive the findings being closed');
  assert.equal(F.reviewWait(data), 'responded',
    'so it is still in the post-posting wait state, which is what renders the Re-review button');
  assert.equal(F.loopActiveStage(data), 'reaudit',
    'and the live stage is the re-run, not "Post" with nothing left to post');

  // The per-finding fallback carries workspaces posted before lastPostedAt was stamped.
  assert.equal(F.hasPostedToPr({ feature: { kind: 'pr-review' }, ledger: { findings: resolved } }), true,
    'a postedAt on any finding proves the post even with no lastPostedAt on the feature');

  // And the states that must NOT be dragged into "waiting": never posted, or still mid-triage.
  assert.equal(F.reviewWait({ feature: { kind: 'pr-review', review: {} }, ledger: { findings: [{ fp: 'x', status: 'open', suggestion: 's' }] } }), null,
    'a workspace that never posted is not waiting on anyone');
  assert.equal(F.reviewWait({ ...data, ledger: { findings: [...resolved, { fp: 'd', status: 'open', suggestion: 's' }] } }), null,
    'and a new finding to triage outranks the wait state — that is review work, not a re-run');

  // The re-run action itself must not depend on finding state: the delta lives on the PR.
  const strip = codeOnly(fnBody(ui, 'function loopStrip('));
  assert.match(strip, /const prClickable = isLast && canReReview;/,
    'the PR re-run must be clickable on the last stage whenever the PR number is known — not only '
    + 'when that stage happens to be the active one');
  assert.ok(!/const prClickable = onLast && canReReview;/.test(strip),
    'the old active-gated form must be gone, or the 12 stranded workspaces stay stranded');

  // "0 comments posted to PR #5867" under a Posted stamp was the same bug wearing a number.
  assert.match(codeOnly(fnBody(ui, 'function reviewCta(')), /everPostedFindings\(findings\)\.length/,
    'the posted count must survive reconciliation too');
});

/* iconSpan's default class had no rule at all, so the span stayed an inline box and its svg sat on
 * the TEXT BASELINE — the line box reserving descender space underneath it. Measured in the PR
 * quick-link (a 30px control around a 15px glyph): 5.16px above, 9.84px below, i.e. the arrow rode
 * ~2.3px high inside a control whose own CSS centres its children. Every glyph drawn through the
 * default class had it; the three places that noticed (.src-icon, .f-pin, .btn-icon) each patched
 * `display: inline-flex` locally, which is the same fix applied one caller at a time. */
test('an icon glyph is centred by its own box, not parked on the text baseline', () => {
  const ui = readUi();
  const css = cssRules(fs.readFileSync(path.join(__dirname, '..', 'web', 'style.css'), 'utf8'));

  // The default class iconSpan hands out when a caller names none — the one that was unstyled.
  assert.match(codeOnly(fnSource(ui, 'function iconSpan(')), /cls = 'icon'/,
    'iconSpan must still default to the class this rule styles');
  const rule = css.match(/\n\.icon \{[^}]*\}/);
  assert.ok(rule, 'style.css must carry a base rule for .icon — an unstyled icon span is baseline-aligned');
  assert.match(rule[0], /display: inline-flex/,
    '.icon must be a flex box: blockifying the svg is what takes the baseline out of the layout');
  assert.match(css, /\.icon > svg \{[^}]*display: block/,
    'and the svg itself must be a block, so a UA stylesheet cannot put the baseline back');

  // The control this was reported on centres its children already — the glyph, not the button, was
  // the thing off-centre, so the button's own rule must not be "corrected" to compensate.
  const prlink = css.match(/\.dh-prlink \{[^}]*\}/);
  assert.ok(prlink, 'style.css must still style .dh-prlink');
  assert.match(prlink[0], /align-items: center/);
  assert.match(prlink[0], /justify-content: center/);
  assert.ok(!/padding|margin-bottom|line-height/.test(prlink[0]),
    'the PR quick link must not nudge its glyph with padding or line-height — the fix belongs on .icon');
});

test('V2: the Vertec line is the booking string, assembled from real fields only', () => {
  const ui = readUi();
  const { bookingItem, vertecBookingText, vertecPrefix, unverifiedBookingItem } = liftUi(ui, [
    fnSource(ui, 'const VERTEC_RANK = '),
    'function isPrUrl(', 'function adoRole(', 'function bookingItem(',
    'function unverifiedBookingItem(', 'function vertecPrefix(', 'function vertecBookingText(',
  ], { location: { href: 'http://localhost:4173/' } });

  const feature = { sources: prWorkspaceSources() };
  const item = bookingItem(feature);
  assert.equal(item.id, 43057, 'a booking is made on the story, never on the PR that implements it');

  // The exact string the user pastes into Vertec. Byte-for-byte, because it is pasted, not read.
  assert.equal(vertecBookingText(item),
    "FZAG-43057 Atrius 2.3 — The map reads in the visitor's language");

  // The prefix is the Azure DevOps ORGANISATION — derived, so a new project needs no configuration.
  assert.equal(vertecPrefix({ url: 'https://dev.azure.com/DXN/web/_workitems/edit/42507' }), 'DXN');
  assert.equal(vertecPrefix({ url: 'https://fzag.visualstudio.com/dxp/_workitems/edit/1' }), 'FZAG',
    'the pre-dev.azure.com host form still resolves');
  assert.equal(vertecPrefix({ url: 'https://dev.azure.com/FZAG/dxp/_workitems/edit/1', vertecKey: 'fzag-web' }),
    'FZAG-WEB', 'an explicit key wins over the derived org');

  // The refusals. A booking line with a guessed prefix would be pasted into a real booking, so a
  // missing org produces NO line rather than a plausible one.
  assert.equal(vertecPrefix({ url: 'https://example.com/whatever' }), null);
  assert.equal(vertecPrefix({}), null);
  assert.equal(vertecBookingText({ id: 43057, title: 'x', url: 'https://example.com/x' }), null);
  assert.equal(vertecBookingText({ title: 'x', url: 'https://dev.azure.com/FZAG/dxp/_workitems/edit/1' }), null,
    'no id, no booking key');
  assert.equal(vertecBookingText(null), null);

  // A PR-only workspace has nothing bookable — the row must not fall back to the PR.
  assert.equal(bookingItem({ sources: { ado: [prWorkspaceSources().ado[0]] } }), null);
  assert.equal(bookingItem({}), null);

  // A bug is booked on the bug; a feature only when there is no story/bug/task above it.
  const bugFirst = { sources: { ado: [
    { id: 1, type: 'Feature', url: 'https://dev.azure.com/FZAG/dxp/_workitems/edit/1' },
    { id: 2, type: 'Bug', url: 'https://dev.azure.com/FZAG/dxp/_workitems/edit/2' },
  ] } };
  assert.equal(bookingItem(bugFirst).id, 2, 'the feature is a last resort, not the first ado source');
});

test('V2b: an UNTYPED work item is never bookable — the regression that put a made-up booking on the clipboard', () => {
  const ui = readUi();
  const { bookingItem, unverifiedBookingItem, vertecBookingText } = liftUi(ui, [
    fnSource(ui, 'const VERTEC_RANK = '),
    'function isPrUrl(', 'function adoRole(', 'function bookingItem(',
    'function unverifiedBookingItem(', 'function vertecPrefix(', 'function vertecBookingText(',
  ], { location: { href: 'http://localhost:4173/' } });

  // The real shape of a workspace audited before `--itemType` existed — 36 of the user's 55
  // bookable workspaces looked exactly like this. Neither item carries a type, and the titles are
  // the audit skill's annotations, NOT the work items' own System.Title.
  const legacy = { sources: { ado: [
    { id: 42702, title: 'FOAN02 - Analytics Flight Overview (the date/time-filter surface)',
      url: 'https://dev.azure.com/FZAG/dxp/_workitems/edit/42702' },
    { id: 42640, title: 'Flight Overview Page (parent Feature)',
      url: 'https://dev.azure.com/FZAG/dxp/_workitems/edit/42640' },
  ] } };

  // The bug: `item` ranked 3 — ahead of feature (4) and epic (5) — so an untyped source was
  // bookable AND outranked the roles the ranking was written to demote. The ranking collapsed to
  // "whichever was registered first", and the copy button offered
  // `FZAG-42702 FOAN02 - Analytics Flight Overview (the date/time-filter surface)` — a paraphrase,
  // on an item nobody confirmed was the story — with the same confidence as a verified line.
  assert.equal(bookingItem(legacy), null,
    'an untyped work item must not be bookable: neither which item nor the title can be confirmed');
  // …but the row can still explain itself, so "missing" does not read as "broken".
  assert.equal(unverifiedBookingItem(legacy).id, 42702);
  assert.equal(unverifiedBookingItem({ sources: { ado: [{ id: 1, type: 'User Story' }] } }), null,
    'and a typed workspace has nothing to explain');

  // The guard must not cost the verified path: one typed item among untyped ones still books.
  const mixed = { sources: { ado: [
    legacy.sources.ado[0],
    { id: 43057, type: 'User Story', title: 'The real System.Title',
      url: 'https://dev.azure.com/FZAG/dxp/_workitems/edit/43057' },
  ] } };
  assert.equal(bookingItem(mixed).id, 43057);
  assert.equal(vertecBookingText(bookingItem(mixed)), 'FZAG-43057 The real System.Title');

  // `item` must stay out of the rank table — this is the assertion that fails if someone
  // "helpfully" re-adds the fallback.
  const rank = new Function(`${fnSource(ui, 'const VERTEC_RANK = ')};\nreturn VERTEC_RANK;`)();
  assert.equal(rank.item, undefined, 'VERTEC_RANK must not make the untyped fallback role bookable');
});

test('V2c: "not bookable" and "type never recorded" are different sentences', () => {
  const ui = readUi();
  const { unbookableReason, unverifiedBookingItem } = liftUi(ui, [
    'function isPrUrl(', 'function adoRole(', 'function unverifiedBookingItem(',
    'function unbookableReason(',
  ]);

  // `adoRole` returns 'item' for BOTH "no type on file" and "a type we don't book against". Telling
  // an Impediment that its type "was never recorded — the next review round records it" is false
  // (the badge beside it reads IMPEDIMENT) and is a dead end: re-recording changes nothing.
  const untyped = unbookableReason({ id: 42702 });
  assert.match(untyped, /never recorded/);
  assert.match(untyped, /next review round/, 'the untyped case has an action, so it names it');

  const impediment = unbookableReason({ id: 66001, type: 'Impediment' });
  assert.match(impediment, /#66001 with type "Impediment"/);
  // No article before a type that comes from the ADO instance — "a Impediment" is the failure case
  // of any article this code could pick.
  assert.ok(!/\b(a|an) Impediment\b/.test(impediment));
  assert.ok(!/never recorded/.test(impediment),
    'a recorded type must not be told it was never recorded');
  assert.ok(!/next review round/.test(impediment),
    'nor pointed at a re-review that would change nothing');
  assert.match(impediment, /story or bug/, 'it names what the user can actually do instead');

  // Of several unbookable candidates, prefer the one that at least carries a phase.
  const withPhase = unverifiedBookingItem({ sources: { ado: [
    { id: 1, title: 'first' },
    { id: 2, title: 'second', vertecPhase: 'Maps Integration' },
  ] } });
  assert.equal(withPhase.id, 2);
});

test('V2d: the Vertec row explains itself instead of vanishing — every combination', () => {
  const ui = readUi();
  // vertecRow builds DOM, so it is checked through its own source rather than run: the one thing
  // that must hold is that the ONLY early return is "no work item at all".
  const body = fnBody(ui, 'function vertecRow(');
  const returns = body.match(/return null;/g) || [];
  assert.equal(returns.length, 1,
    'vertecRow may bail exactly once — on a workspace with no bookable-or-explainable work item. '
    + 'A second bail is how a typed item with an underivable org and no phase used to vanish '
    + 'silently, which the row\'s own comment says must never happen');
  assert.match(body, /if \(!subject\) return null;/);
  // And the copy button is built only alongside real booking text — never for an explanation.
  assert.match(body, /text \? copyButton\(/);
});

test('V3: the PR quick link points at the PR, and only ever at the PR', () => {
  const ui = readUi();
  const { prSource } = liftUi(ui, [
    'function safeHref(', 'function isPrUrl(', 'function adoRole(', 'function prSource(',
  ]);

  assert.equal(prSource({ sources: prWorkspaceSources() }).id, 5882);
  // A spec workspace has no PR: the arrow must be absent, not pointed at the story.
  assert.equal(prSource({ sources: { ado: [prWorkspaceSources().ado[1]] } }), null);
  assert.equal(prSource({}), null);
  // A PR recorded without a usable url cannot be opened, so it does not get an arrow that 404s.
  assert.equal(prSource({ sources: { ado: [{ id: 5882, type: 'Pull Request', url: 'javascript:alert(1)' }] } }), null,
    'and the href goes through safeHref, so a non-http scheme never reaches an anchor');
});

test('V5: the chip states a vote, it does not cast one — and the summarize job is drawn everywhere', () => {
  const ui = readUi();

  // FlowLever never votes: the user said "I will be the one that approves. I will do that on the
  // PR." A control that looked pressable and changed nothing over there would be worse than no
  // indicator at all, so the chip is a div — and that is a design claim, which means it is tested.
  const chip = fnSource(ui, 'function approvalChip(');
  assert.ok(!/h\('button'/.test(chip) && !/onclick/.test(chip),
    'approvalChip must not render a button or bind a click — the vote is cast on the PR, not here');
  assert.match(chip, /if \(!a \|\| !a\.vote\) return null;/,
    'and a null vote draws nothing at all: a greyed-out vote reads as a broken control');

  // A queue action that names one workspace must be in ONE list, not hardcoded per site. It was
  // hardcoded at three, which is how `summarize` shipped invisible on the section grid, labelled
  // "Re-reviewing" on Home, and unnoticed by the detail page when it finished.
  // fnSource() brace-matches, so it is the wrong tool for an ARRAY literal — it would run off to
  // the next `{` in the file. Read these as arrays.
  const arrayLiteral = (name) => {
    const m = ui.match(new RegExp(`^const ${name} = (\\[[\\s\\S]*?\\]);$`, 'm'));
    assert.ok(m, `${name} must be one array literal at module scope`);
    // eslint-disable-next-line no-new-func
    return new Function(`return ${m[1]};`)();
  };
  const wsidList = arrayLiteral('WSID_JOB_ACTIONS');
  assert.deepEqual(wsidList, ['apply', 'summarize']);
  for (const [fn, why] of [
    ['function startSectionRequestsPoll(', 'the section grid folds the job onto its row'],
    ['function ensureFeatureJobPolling(', 'the detail page reloads when the summary lands'],
  ]) {
    assert.match(codeOnly(fnBody(ui, fn)), /WSID_JOB_ACTIONS|DETAIL_JOB_ACTIONS/,
      `${fn} must read the shared list, not its own copy — ${why}`);
  }

  // Every action the server can enqueue needs a human-readable verb and a band, or a live job row
  // wears the raw action string and lands under someone else's label.
  const labels = new Function(`${ui.match(/^const REQ_ACTION_LABEL = .*$/m)[0]};\nreturn REQ_ACTION_LABEL;`)();
  for (const a of ledger.REQUEST_ACTIONS) {
    assert.ok(labels[a], `REQ_ACTION_LABEL must name "${a}" — a job row otherwise prints the action id`);
  }
  assert.match(codeOnly(fnBody(ui, 'function categoryOf(')), /summarize/,
    'categoryOf must claim summarize, or it falls through to the "Re-reviewing" default');
  const states = arrayLiteral('WS_STATES');
  const summarizing = states.find((st) => st.key === 'job-summarizing');
  assert.ok(summarizing && summarizing.band === 'in-progress', 'and its band must be in-progress');

  // Its banner must not borrow the write-job wording — "Posting…" on a job that posts nothing.
  const banner = fnSource(ui, 'function summarizeJobBanner(');
  assert.ok(!/Posting|Applying|review queue/.test(banner),
    'the summarize banner must not claim a post, an apply, or items to put back — it has none');
  assert.match(codeOnly(fnBody(ui, 'function specJobBanner(')), /summarizeJobBanner\(j\)/,
    'and specJobBanner must hand off to it before the write-job branches');
});

test('V4: the summary is written, never invented', () => {
  const ui = readUi();
  const body = fnBody(ui, 'function summaryPanel(');
  // The app has no model. The ONLY text it may draw is feature.summary — a panel that fell back to
  // the title or to the findings would be paraphrasing the thing the user already cannot parse.
  assert.match(body, /feature\.summary/);
  assert.ok(!/feature\.title/.test(body),
    'summaryPanel must never fall back to the workspace title — that is the text it exists to explain');
  // And an empty one offers the one thing that CAN fill it: a job the runner executes.
  assert.match(body, /summarizeButton\(/, 'the empty state must offer a way to fill it in');

  const btn = fnSource(ui, 'function summarizeButton(');
  assert.match(btn, /action: 'summarize'/);
  assert.match(btn, /wsId/, 'the job names the workspace it is for');
  assert.match(btn, /dedupe: true/,
    'a double-click must not stack two summarize passes over the same sources');
  assert.match(btn, /readOnlyMode\(\)/,
    'read-only mode must not offer a button the server would refuse');
  // Queueing a job nobody runs is a silent no-op — the same rule Post/Apply follow.
  assert.match(btn, /startRunner\(/);
  // `summarize` must be a real server action, not a string only the browser believes in.
  assert.ok(ledger.REQUEST_ACTIONS.includes('summarize'),
    'the button enqueues an action the ledger can actually store');
});
