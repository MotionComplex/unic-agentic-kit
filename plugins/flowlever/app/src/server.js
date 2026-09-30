'use strict';

// FlowLever cockpit server — JSON API per docs/SCHEMA.md "HTTP API" + static web/.
// Node built-ins only. Same-origin usage; no CORS headers on purpose.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const ledger = require('./ledger');
const runner = require('./runner');
const { API_VERSION } = require('./version');
const { generateReport } = require('./report');

const PORT = process.env.PORT !== undefined && process.env.PORT !== '' ? Number(process.env.PORT) : 4173;
// LOOPBACK BY DEFAULT. `listen(PORT)` with no host binds the unspecified address — every interface —
// so the cockpit was reachable from the whole LAN with no authentication of any kind, including
// POST /api/runner, which spawns a Claude session with permission checks disabled that can write
// comments and code fixes to the user's Azure DevOps account. Binding a hostname of your own
// (`127.0.0.1 lever` in /etc/hosts) still works against a loopback bind, so nothing is lost.
// FLOWLEVER_HOST remains as a deliberate, documented opt-out — see the warning in listen().
const HOST = process.env.FLOWLEVER_HOST !== undefined && process.env.FLOWLEVER_HOST !== ''
  ? process.env.FLOWLEVER_HOST
  : '127.0.0.1';
// The WHOLE of 127.0.0.0/8 is loopback, not just 127.0.0.1 — which matters because the documented
// friendly-hostname recipe binds an lo0 alias like 127.94.41.73. An exact-string check called that
// "remote" and would have turned the API read-only and refused the runner for a setup this project
// tells you to use.
function isLoopbackHost(host) {
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return false;
  return octets[0] === 127;
}
const IS_LOOPBACK = isLoopbackHost(HOST);
// Opting into a non-loopback bind must not silently hand WRITE access to anyone who can reach the
// port. Guarding only the runner was not enough: the job queue is itself a write surface, so a LAN
// client could enqueue work the owner's next local runner would dutifully execute, and could stop a
// runner mid-drain. So on a non-loopback bind, reads are allowed (that is the point of choosing to
// expose it) and every MUTATION requires an explicit opt-in.
const ALLOW_REMOTE_WRITES = process.env.FLOWLEVER_ALLOW_REMOTE_WRITES === '1'
  || process.env.FLOWLEVER_ALLOW_REMOTE_RUNNER === '1';   // the older, narrower name still works
const ALLOW_REMOTE_RUNNER = ALLOW_REMOTE_WRITES;
// When this process started — shown next to the version so "restart the server" is verifiable.
const SERVER_STARTED_AT = new Date().toISOString();
const WEB_DIR = path.resolve(__dirname, '..', 'web');
const BODY_LIMIT = 2 * 1024 * 1024; // 2MB
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

// EUSER from the ledger is either "thing not found" (→404) or bad input (→400).
function euserStatus(err) {
  return /not found|no such|does not exist|unknown feature|unknown finding/i.test(err.message) ? 404 : 400;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        const err = new Error('Request body exceeds 2MB limit');
        err.code = 'ETOOBIG';
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error('Request body is not valid JSON');
    err.code = 'EBADJSON';
    throw err;
  }
}

// Same return-shape tolerance as the CLI: validateIngestFinding may throw,
// return an error string, an array of errors, or { errors: [...] }.
function findingError(f, idx) {
  let res;
  try {
    res = ledger.validateIngestFinding(f);
  } catch (err) {
    return `Finding #${idx + 1} invalid: ${err.message}`;
  }
  let errors = [];
  if (typeof res === 'string' && res) errors = [res];
  else if (Array.isArray(res)) errors = res;
  else if (res && typeof res === 'object' && Array.isArray(res.errors)) errors = res.errors;
  else if (res === false) errors = ['failed validation'];
  return errors.length ? `Finding #${idx + 1} invalid: ${errors.join('; ')}` : null;
}

// ---------- API handlers ----------

// The "what's in this workspace" tally both list endpoints serve. It lives here, once, because
// the two shapes are read side by side — an inbox row and a section card for the SAME workspace —
// and a second copy of this loop would eventually disagree with the first about what counts as
// what, which reads to the user as the cockpit contradicting itself.
function findingCounts(findings) {
  const counts = { toReview: 0, open: 0, reworking: 0, posted: 0, resolved: 0, waived: 0 };
  for (const fd of findings) {
    const live = fd.status === 'open' || fd.status === 'reworking';
    // Posted findings are awaiting the author, not the reviewer: count them under `posted`,
    // never as `reworking` or `toReview`, so the inbox stops re-surfacing what's already out.
    if (live && fd.postedAt) { counts.posted += 1; continue; }
    if (counts[fd.status] !== undefined) counts[fd.status] += 1;
    if (live && fd.draft) counts.toReview += 1;
  }
  return counts;
}

function handleFeatureList(res, kindFilter) {
  const listed = ledger.listFeatures({ withSkipped: true });
  let features = listed.features || [];
  const skipped = listed.skipped || [];
  if (kindFilter) features = features.filter((f) => (f.kind || 'spec') === kindFilter);
  const summaries = features.map((f) => {
    let readiness = null;
    try {
      const r = ledger.readiness(f.id);
      readiness = { score: r.score, gate: r.gate, openCount: r.openCount, openBySeverity: r.openBySeverity };
    } catch { /* feature without ledger yet */ }
    const s = f.sources || {};
    const sourceCounts = {
      confluence: (s.confluence || []).length,
      ado: (s.ado || []).length,
      figma: (s.figma || []).length,
    };
    let lastRoundAt = null;
    try {
      const rounds = (ledger.loadRounds(f.id).rounds) || [];
      if (rounds.length) lastRoundAt = rounds[rounds.length - 1].at;
    } catch { /* no rounds yet */ }
    const findings = (ledger.loadLedger(f.id).findings) || [];
    const awaitingAuthor = findings.some((fd) => fd.postedAt && (fd.status === 'open' || fd.status === 'reworking'));
    return {
      id: f.id,
      title: f.title,
      kind: f.kind || 'spec',
      status: f.status,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
      sourceCounts,
      lastRoundAt,
      readiness,
      awaitingAuthor,                                          // has posted, unaddressed comments
      authorResponded: !!(f.review && f.review.authorRespondedAt),
      reviewNote: (f.review && f.review.note) || null,
      counts: findingCounts(findings),
      // The one canonical answer to "what is going on here" (ledger.WORKSPACE_STATES). Computed
      // server-side so the inbox and the section lists can never disagree about it.
      state: ledger.workspaceState(f, findings, lastRoundAt),
      // When we last reviewed vs. when the PR was last touched by the other side — so a card
      // can say "reviewed 3h ago · PR updated 20m ago" and flag that a re-review is worthwhile.
      stamps: ledger.reviewStamps(f, lastRoundAt),
    };
  });
  // A workspace file we could not read must not vanish silently. The response body stays an ARRAY
  // (that is the client contract, and attaching a property to an array is dropped by JSON.stringify
  // anyway), so the signal rides on a header and the detail is available from /api/diagnostics.
  if (skipped.length) res.setHeader('X-FlowLever-Skipped', String(skipped.length));
  sendJson(res, 200, summaries);
}

// Cross-kind inbox: one summary per workspace with the "what needs you" counts,
// sorted so the most actionable surface first (most toReview, then most open).
// toReview = open/reworking findings carrying a proposed change (draft).
function handleHome(res) {
  const listed = ledger.listFeatures({ withSkipped: true });
  const features = listed.features || [];
  const skippedWorkspaces = listed.skipped || [];
  const rows = features.map((f) => {
    const findings = (ledger.loadLedger(f.id).findings) || [];
    const counts = findingCounts(findings);
    let readiness = { score: 0, gate: 'in-progress' };
    try {
      const r = ledger.readiness(f.id);
      readiness = { score: r.score, gate: r.gate };
    } catch { /* feature without ledger yet */ }
    let lastRoundAt = null;
    try {
      const rounds = (ledger.loadRounds(f.id).rounds) || [];
      if (rounds.length) lastRoundAt = rounds[rounds.length - 1].at;
    } catch { /* no rounds yet */ }
    return {
      id: f.id, title: f.title, kind: f.kind || 'spec', status: f.status, readiness, counts,
      authorResponded: !!(f.review && f.review.authorRespondedAt),
      lastRoundAt,
      // `updatedAt` is the "last touched anything" clock, and for a COMPLETED workspace it is
      // effectively when it was marked done (that goes through mutateFeature like any other
      // change). The inbox's Done list sorts on it, which /api/features already supported and
      // this one did not — the two shapes had drifted for no reason.
      updatedAt: f.updatedAt,
      stamps: ledger.reviewStamps(f, lastRoundAt),
      // The one canonical answer to "what is going on here" (ledger.WORKSPACE_STATES); the
      // grouping the inbox draws from it is the browser's job, so the sort below is unchanged.
      state: ledger.workspaceState(f, findings, lastRoundAt),
    };
  });
  rows.sort((a, b) =>
    // Completed workspaces sink to the bottom of the inbox.
    (Number(a.status === 'done') - Number(b.status === 'done')) ||
    (b.counts.toReview - a.counts.toReview) ||
    (b.counts.open - a.counts.open) ||
    (b.counts.reworking - a.counts.reworking) ||
    a.title.localeCompare(b.title));
  if (skippedWorkspaces.length) res.setHeader('X-FlowLever-Skipped', String(skippedWorkspaces.length));
  sendJson(res, 200, rows);
}

function handleFeatureDetail(res, id) {
  const feature = ledger.getFeature(id);
  const led = ledger.loadLedger(id);
  const rounds = ledger.loadRounds(id);
  const list = (rounds && rounds.rounds) || [];
  const lastRoundAt = list.length ? list[list.length - 1].at : null;
  sendJson(res, 200, {
    feature,
    ledger: led,
    rounds,
    readiness: ledger.readiness(id),
    // Same derived recommendation the list rows carry, so the detail header and the row it was
    // opened from can never disagree about which vote the review has earned.
    approval: ledger.approvalSignal(feature, led.findings || [], lastRoundAt),
  });
}

// A handler that catches EUSER itself must still let a LOCK TIMEOUT through as a transient 503,
// otherwise it reports "your request was wrong" for a write that merely collided with the CLI or the
// runner. Rethrowing hands it to the central error path, which knows the difference.
function sendHandlerError(res, err) {
  if (err && err.lockTimeout) throw err;
  return sendError(res, err && err.code === 'EUSER' ? euserStatus(err) : 500, err.message);
}

// Set a workspace's lifecycle status — used by the "Mark review complete" / "Reopen"
// buttons (status:'done' / status:'reworking').
async function handleFeatureStatus(req, res, id) {
  const body = await readJsonBody(req);
  if (typeof body.status !== 'string') return sendError(res, 400, 'Body must include a status string');
  try {
    const feature = ledger.setFeatureStatus(id, body.status);
    sendJson(res, 200, feature);
  } catch (e) {
    return sendHandlerError(res, e);
  }
}

// The "waiting on author" tracker. The /flowlever:watch runner POSTs here when it detects new
// author activity on the PR (authorResponded:true + a note), or the UI clears it on re-review.
// `lastActivityAt`/`lastActivityBy` carry the REAL time (and author) of the newest counterpart
// update on the PR, as opposed to `at`/authorRespondedAt which is when we noticed it.
async function handleFeatureActivity(req, res, id) {
  const body = await readJsonBody(req);
  const patch = {};
  if (body.authorResponded !== undefined) {
    patch.authorRespondedAt = body.authorResponded ? (typeof body.at === 'string' ? body.at : new Date().toISOString()) : null;
    if (!body.authorResponded) patch.note = null;
  }
  if (body.note !== undefined) patch.note = body.note;
  if (body.lastPostedAt !== undefined) patch.lastPostedAt = body.lastPostedAt;
  if (body.lastActivityAt !== undefined) {
    if (body.lastActivityAt !== null && Number.isNaN(Date.parse(body.lastActivityAt))) {
      return sendError(res, 400, 'lastActivityAt must be an ISO-8601 timestamp or null');
    }
    patch.lastActivityAt = body.lastActivityAt;
  }
  if (body.lastActivityBy !== undefined) patch.lastActivityBy = body.lastActivityBy;
  if (Object.keys(patch).length === 0) {
    return sendError(res, 400, 'Body must include authorResponded, note, lastPostedAt, lastActivityAt and/or lastActivityBy');
  }
  try {
    const feature = ledger.setFeatureReview(id, patch);
    sendJson(res, 200, feature);
  } catch (e) {
    return sendHandlerError(res, e);
  }
}

async function handleFindingUpdate(req, res, id, fp) {
  const body = await readJsonBody(req);
  let finding;
  // Optional comment-body edit (the pr-review "Edit comment" action): the finding's
  // `suggestion` IS the proposed PR comment, so persist it via setFindingDetails.
  if (body.suggestion !== undefined) {
    finding = ledger.setFindingDetails(id, fp, { suggestion: body.suggestion, by: 'user' });
  }
  // The reviewer's triage decision (approve/edit/fix-only, or null to undo) — persisted so the board,
  // stepper and Post screen agree and survive a refresh. A status change (below) clears it.
  if (body.decision !== undefined) {
    finding = ledger.setFindingDecision(id, fp, body.decision, { by: 'user' });
  }
  // The reviewer's free-text note on the finding (their objection / answer to a clarifying
  // question) — distinct from the audit suggestion; lets suggestion-only items carry a response.
  if (body.note !== undefined) {
    finding = ledger.setFindingNote(id, fp, body.note, { by: 'user' });
  }
  const change = { by: 'user' };
  if (body.status !== undefined) change.status = body.status;
  if (body.reason !== undefined) change.reason = body.reason;
  if (body.pinned !== undefined) change.pinned = body.pinned;
  if (change.status !== undefined || change.pinned !== undefined) {
    finding = ledger.setFindingStatus(id, fp, change);
  } else if (body.suggestion === undefined && body.decision === undefined && body.note === undefined) {
    return sendError(res, 400, 'Body must include status, pinned, suggestion, decision and/or note');
  }
  sendJson(res, 200, finding);
}

async function handleDraftSet(req, res, id, fp) {
  const body = await readJsonBody(req);
  if (typeof body.before !== 'string' || typeof body.after !== 'string') {
    return sendError(res, 400, 'Body must include before and after strings');
  }
  const finding = ledger.setFindingDraft(id, fp, {
    target: body.target,
    targetRef: body.targetRef,
    before: body.before,
    after: body.after,
    format: body.format,
    by: 'user',
  });
  sendJson(res, 200, finding);
}

function handleDraftClear(res, id, fp) {
  const finding = ledger.clearFindingDraft(id, fp, { by: 'user' });
  sendJson(res, 200, finding);
}

// Body is the full review object, a single-hunk patch { hunk, status, editedText? },
// and/or a finding-level counter-proposal { note?, verdict? }. Validation (status/verdict
// enum, edited requires text, draft must exist) lives in the ledger → EUSER → 400/404.
async function handleDraftReview(req, res, id, fp) {
  const body = await readJsonBody(req);
  const finding = ledger.setDraftReview(id, fp, body, { by: 'user' });
  sendJson(res, 200, finding);
}

// Reject + counter-proposal (spec workspaces). The reviewer disagrees with the proposed
// change's target/approach and supplies a counter. This does two things atomically:
//   1. records the counter on the draft (verdict='redirect' + note), and
//   2. enqueues a SCOPED re-audit request so the proposer re-evaluates THIS item against
//      the counter and drafts a revised proposal — the per-item refine loop.
// The runner (/flowlever:watch) picks up the re-audit, re-checks only the redirected
// findings, and re-drafts. Requires the finding to already carry a draft (the thing being
// countered) — setDraftReview throws (→400) otherwise. Body: { note, scope? }.
async function handleFindingCounter(req, res, id, fp) {
  const body = await readJsonBody(req);
  if (typeof body.note !== 'string' || body.note.trim() === '') {
    return sendError(res, 400, 'A counter requires a non-empty "note" (your counter-proposal)');
  }
  const finding = ledger.setDraftReview(id, fp, { verdict: 'redirect', note: body.note }, { by: 'user' });
  const request = ledger.addRequest({
    action: 're-audit',
    wsId: id,
    title: `Re-audit · ${finding.title}`.slice(0, 120),
    instructions: typeof body.scope === 'string' && body.scope.trim()
      ? body.scope.trim()
      : `Counter on ${fp}: ${body.note.trim()}`,
  });
  sendJson(res, 200, { finding, request });
}

// Bulk-apply the review-flow finish screen: set a list of findings to reworking
// (additive — the finish screen reflects in-flight work without touching Confluence/ADO).
// Validated up front so the operation is all-or-nothing: every fp must exist and the
// target status must be in the small allowlist before any write happens.
// `reworking` = spec rework in-flight; `resolved` = a PR-review comment / thread closed
// without needing the author. The transient in-flight markers — set when the reviewer clicks
// Post/Apply, BEFORE the runner does the real write — are `pending-post` / `pending-apply`
// (→ "Posting…/Applying…" lane). The runner stamps the real completion (markPosted/markApplied)
// once the comment is actually on the PR / the spec is actually written. `posted` stays accepted
// for back-compat / the runner, but the browser no longer uses it to fake a completion.
const REVIEW_APPLY_STATUSES = ['reworking', 'resolved', 'posted', 'pending-post', 'pending-apply'];

async function handleReviewApply(req, res, id) {
  const body = await readJsonBody(req);
  const status = body.status === undefined ? 'reworking' : body.status;
  const fps = body.fps;
  if (!Array.isArray(fps) || fps.length === 0 || !fps.every((x) => typeof x === 'string' && x.trim())) {
    return sendError(res, 400, 'Body must include a non-empty fps array of finding ids');
  }
  if (!REVIEW_APPLY_STATUSES.includes(status)) {
    return sendError(res, 400, `status must be one of ${REVIEW_APPLY_STATUSES.join(', ')}`);
  }
  const existing = new Set((ledger.loadLedger(id).findings || []).map((f) => f.fp));
  const missing = [...new Set(fps)].filter((fp) => !existing.has(fp));
  if (missing.length) return sendError(res, 400, `unknown finding(s): ${missing.join(', ')}`);

  const uniq = [...new Set(fps)];
  let findings;
  let skipped = [];
  // `posted` carries the fix gate: for a finding whose agreed response is a code change the ledger
  // refuses the stamp without the pushed commit's sha (→ EUSER → 400). The browser never sends this
  // status for code fixes (it sends `pending-post` and lets the runner do the real work), so a 400
  // here means something tried to claim a fix it did not push.
  if (status === 'posted') {
    const r = ledger.markPosted(id, uniq, { by: 'user', sha: body.sha, repo: body.repo, branch: body.branch, detailed: true });
    findings = r.updated; skipped = r.skipped;
  } else if (status === 'pending-post' || status === 'pending-apply') {
    const kind = status === 'pending-post' ? 'post' : 'apply';
    const r = ledger.setFindingPending(id, uniq, kind, { by: 'user', detailed: true });
    findings = r.updated; skipped = r.skipped;
  } else {
    // `reworking` here is the finish screen saying "these are in flight", NOT the reviewer
    // re-triaging them — so their approve/edit decisions must survive. Clearing them sent every
    // suggestion-only finding back to Undecided and left the export reading "No applicable
    // changes to export". `resolved` is a real completion, so it supersedes the decision as usual.
    const keepDecision = status === 'reworking';
    findings = uniq.map((fp) => ledger.setFindingStatus(id, fp, { status, by: 'user', keepDecision }));
  }
  // `skipped` names the findings the bulk operation passed over (already waived/resolved). The
  // response used to carry only a smaller count, so a reviewer who posted 5 and saw "4 updated"
  // had no way to learn which one was dropped.
  sendJson(res, 200, { updated: findings.length, status, findings, skipped });
}

// Cancel a stuck Post/Apply: clear the in-flight markers so the findings return to the review
// queue, and (optionally) drop the dead request that never ran. This is the escape hatch for the
// one state the cockpit couldn't previously leave — the runner never picked the job up (or died
// mid-flight), so the findings sat in "Posting…/Applying…" forever, out of the review queue and
// never stamped. Body: { fps?: [...] (default: every pending finding), requestId?: <req to drop> }.
// NOT a claim that anything was written — findings already stamped postedAt/appliedAt are untouched.
async function handleReviewCancel(req, res, id) {
  const body = await readJsonBody(req);
  const existing = ledger.loadLedger(id).findings || [];
  let fps;
  if (body.fps === undefined) {
    fps = ledger.pendingFindings(id).map((f) => f.fp);
  } else {
    if (!Array.isArray(body.fps) || !body.fps.every((x) => typeof x === 'string' && x.trim())) {
      return sendError(res, 400, 'fps must be an array of finding ids when provided');
    }
    const known = new Set(existing.map((f) => f.fp));
    const missing = [...new Set(body.fps)].filter((fp) => !known.has(fp));
    if (missing.length) return sendError(res, 400, `unknown finding(s): ${missing.join(', ')}`);
    fps = body.fps;
  }
  const findings = fps.length
    ? ledger.clearFindingPending(id, fps, { by: 'user', reason: body.reason })
    : [];
  // Dropping the request is best-effort: an already-deleted job must not fail the cancel, since
  // clearing the markers is the part that unsticks the workspace.
  let requestDeleted = false;
  if (typeof body.requestId === 'string' && body.requestId.trim()) {
    try { ledger.deleteRequest(body.requestId.trim()); requestDeleted = true; } catch { /* already gone */ }
  }
  sendJson(res, 200, { cancelled: findings.length, requestDeleted, findings });
}

async function handleIngest(req, res, id) {
  const body = await readJsonBody(req);
  if (!Array.isArray(body.findings)) {
    return sendError(res, 400, 'Body must be { findings: [...], note?, reopenResolved? }');
  }
  for (let i = 0; i < body.findings.length; i++) {
    const message = findingError(body.findings[i], i);
    if (message) return sendError(res, 400, message);
  }
  // `scope` marks a PARTIAL pass, so reconciliation doesn't auto-resolve findings this round never
  // examined. Passed straight through; the ledger validates its shape.
  const { round, stats } = ledger.ingestRound(id, body.findings, {
    note: body.note,
    reopenResolved: Boolean(body.reopenResolved),
    trigger: 'audit',
    scope: body.scope === undefined ? null : body.scope,
  });
  sendJson(res, 200, { round, stats });
}

// ---------- requests (UI-triggered job queue) ----------

// `dedupe` (used by the manual "↻ Refresh") reports the already queued/running job for the same
// action + target instead of stacking a second one — a double-click can't fan out two passes.
async function handleRequestCreate(req, res) {
  const body = await readJsonBody(req);
  if (body.dedupe) {
    const existing = ledger.listRequests({}).find((r) =>
      (r.status === 'queued' || r.status === 'running')
      && r.action === body.action
      && (body.prId === undefined || String(r.prId) === String(body.prId))
      && (body.wsId === undefined || String(r.wsId) === String(body.wsId))
      && (body.kind === undefined || (r.kind || null) === (body.kind || null)));
    if (existing) return sendJson(res, 200, { ...existing, deduped: true });
  }
  const request = ledger.addRequest({
    action: body.action,
    prId: body.prId,
    wsId: body.wsId,
    kind: body.kind,
    title: body.title,
    instructions: body.instructions,
  });
  sendJson(res, 201, request);
}

function handleRequestList(res, statusFilter) {
  const requests = ledger.listRequests(statusFilter ? { status: statusFilter } : {});
  sendJson(res, 200, requests);
}

async function handleRequestUpdate(req, res, id) {
  const body = await readJsonBody(req);
  const change = {};
  if (body.status !== undefined) change.status = body.status;
  if (body.note !== undefined) change.note = body.note;
  if (body.wsId !== undefined) change.wsId = body.wsId;
  if (body.phase !== undefined) change.phase = body.phase;
  if (body.needsInput !== undefined) change.needsInput = body.needsInput;
  if (change.status === undefined && change.note === undefined && change.wsId === undefined
      && change.phase === undefined && change.needsInput === undefined) {
    return sendError(res, 400, 'Body must include status, note, wsId, phase and/or needsInput');
  }
  const request = ledger.setRequestStatus(id, change);
  sendJson(res, 200, request);
}

// ---------- runner control (start the session that drains the queue) ----------

// The queue only moves when a Claude Code session runs /flowlever:watch. These let the cockpit
// launch that session itself, so a queued Post isn't stuck waiting for the user to remember.
// The runner posts to Azure DevOps — which is why it only ever runs one of the fixed prompts in
// runner.ACTIONS, never anything derived from the request body.
function handleRunnerGet(res, wantLog) {
  const body = runner.status();
  if (wantLog) body.log = runner.tailLog();
  sendJson(res, 200, body);
}

const RUNNER_ERROR_STATUS = { EACTION: 400, EBUSY: 409, ENOBIN: 503, ESPAWN: 500, EIDLE: 409, EKILL: 500 };

// Starting the runner spawns a Claude session with permission checks disabled that writes to Azure
// DevOps. On a loopback bind that is the same trust boundary as the CLI which started the server.
// On a non-loopback bind it is not: it would hand that capability to anyone who can reach the port.
function remoteRunnerBlocked(res) {
  if (IS_LOOPBACK || ALLOW_REMOTE_RUNNER) return false;
  sendError(res, 403, `The runner is disabled because the server is bound to ${HOST} rather than `
    + 'loopback, and the cockpit has no authentication. Bind 127.0.0.1 (the default), or set '
    + 'FLOWLEVER_ALLOW_REMOTE_RUNNER=1 to accept that anyone who can reach this port may write to '
    + 'your Azure DevOps account.');
  return true;
}

async function handleRunnerStart(req, res) {
  if (remoteRunnerBlocked(res)) return;
  const body = await readJsonBody(req);
  const action = body.action === undefined ? 'watch' : body.action;
  if (typeof action !== 'string') return sendError(res, 400, 'action must be a string');
  const result = runner.start(action);
  if (!result.ok) return sendJson(res, RUNNER_ERROR_STATUS[result.code] || 500, { error: result.error, status: result.status });
  sendJson(res, 202, result.status);
}

function handleRunnerStop(res) {
  const result = runner.stop();
  if (!result.ok) return sendJson(res, RUNNER_ERROR_STATUS[result.code] || 500, { error: result.error });
  sendJson(res, 200, result.status);
}

function handleFeatureDelete(res, id) {
  const result = ledger.deleteFeature(id);
  sendJson(res, 200, result);
}

function handleRequestDelete(res, id) {
  const result = ledger.deleteRequest(id);
  sendJson(res, 200, result);
}

function handleReport(res, id) {
  const md = generateReport(id);
  res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
  res.end(md);
}

// ---------- static files ----------

function handleStatic(req, res, pathname) {
  // HEAD is GET without a body — answering 405 broke the standard contract for no reason.
  const headOnly = req.method === 'HEAD';
  if (req.method !== 'GET' && !headOnly) return sendError(res, 405, 'Method not allowed');
  let rel;
  try {
    rel = decodeURIComponent(pathname === '/' ? 'index.html' : pathname.slice(1));
  } catch {
    return sendError(res, 400, 'Bad request path');
  }
  const filePath = path.resolve(WEB_DIR, rel);
  // No path traversal: resolved path must stay inside web/.
  if (filePath !== WEB_DIR && !filePath.startsWith(WEB_DIR + path.sep)) {
    return sendError(res, 404, 'Not found');
  }
  const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()];
  if (!contentType) return sendError(res, 404, 'Not found');
  fs.readFile(filePath, (err, data) => {
    if (err) return sendError(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': data.length });
    if (headOnly) return res.end();
    res.end(data);
  });
}

// ---------- routing ----------

async function route(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let parts;
  try {
    parts = url.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  } catch {
    // Malformed percent-encoding (e.g. `%c0%af`) threw here and fell through to the catch-all as a
    // 500 with a stack in the log. It is bad input, not an internal failure.
    return sendError(res, 400, 'Bad request path');
  }

  if (parts[0] !== 'api') return handleStatic(req, res, url.pathname);

  // Explicit read-only mode. The ledger refuses writes on its own (see writeJson), but that would
  // surface here as a 500 with a stack — a bug's shape, not a policy's. Answering 403 up front says
  // the refusal was deliberate, and keeps the runner-spawn route (which reaches Azure DevOps
  // without touching the ledger at all) inside the same gate.
  if (ledger.READONLY && req.method !== 'GET' && req.method !== 'HEAD') {
    return sendError(res, 403, 'This cockpit is running with FLOWLEVER_READONLY=1, so it cannot '
      + 'change review data, post to Azure DevOps, or start a runner. Everything is still readable. '
      + 'Restart without FLOWLEVER_READONLY to make changes.');
  }

  // Read-only from a non-loopback bind unless the operator explicitly opted into remote writes.
  if (!IS_LOOPBACK && !ALLOW_REMOTE_WRITES && req.method !== 'GET' && req.method !== 'HEAD') {
    return sendError(res, 403, `This cockpit is bound to ${HOST} rather than loopback and has no `
      + 'authentication, so it is read-only over the network. Run it on 127.0.0.1 (the default) to '
      + 'make changes, or set FLOWLEVER_ALLOW_REMOTE_WRITES=1 to accept that anyone who can reach '
      + 'this port may change your review data and post to Azure DevOps.');
  }

  if (parts[1] === 'home' && parts.length === 2 && req.method === 'GET') {
    return handleHome(res);
  }
  if (parts[1] === 'features') {
    if (parts.length === 2 && req.method === 'GET') {
      return handleFeatureList(res, url.searchParams.get('kind') || null);
    }
    if (parts.length === 3 && req.method === 'GET') return handleFeatureDetail(res, parts[2]);
    if (parts.length === 3 && req.method === 'DELETE') return handleFeatureDelete(res, parts[2]);
    if (parts.length === 5 && parts[3] === 'findings' && req.method === 'POST') {
      return handleFindingUpdate(req, res, parts[2], parts[4]);
    }
    if (parts.length === 6 && parts[3] === 'findings' && parts[5] === 'draft') {
      if (req.method === 'POST') return handleDraftSet(req, res, parts[2], parts[4]);
      if (req.method === 'DELETE') return handleDraftClear(res, parts[2], parts[4]);
    }
    if (parts.length === 7 && parts[3] === 'findings' && parts[5] === 'draft'
        && parts[6] === 'review' && req.method === 'POST') {
      return handleDraftReview(req, res, parts[2], parts[4]);
    }
    if (parts.length === 6 && parts[3] === 'findings' && parts[5] === 'counter' && req.method === 'POST') {
      return handleFindingCounter(req, res, parts[2], parts[4]);
    }
    if (parts.length === 5 && parts[3] === 'review' && parts[4] === 'apply' && req.method === 'POST') {
      return handleReviewApply(req, res, parts[2]);
    }
    if (parts.length === 5 && parts[3] === 'review' && parts[4] === 'cancel' && req.method === 'POST') {
      return handleReviewCancel(req, res, parts[2]);
    }
    if (parts.length === 4 && parts[3] === 'status' && req.method === 'POST') {
      return handleFeatureStatus(req, res, parts[2]);
    }
    if (parts.length === 4 && parts[3] === 'activity' && req.method === 'POST') {
      return handleFeatureActivity(req, res, parts[2]);
    }
  }
  if (parts[1] === 'requests') {
    if (parts.length === 2 && req.method === 'POST') return handleRequestCreate(req, res);
    if (parts.length === 2 && req.method === 'GET') {
      return handleRequestList(res, url.searchParams.get('status') || null);
    }
    if (parts.length === 3 && req.method === 'POST') return handleRequestUpdate(req, res, parts[2]);
    if (parts.length === 3 && req.method === 'DELETE') return handleRequestDelete(res, parts[2]);
  }
  // Let the browser tell "this route doesn't exist" apart from "this SERVER is older than this page".
  // Deliberately the cheapest possible handler and matched first — it must answer even when
  // everything else about the build is mismatched.
  if (parts[1] === 'version' && parts.length === 2 && req.method === 'GET') {
    return sendJson(res, 200, { apiVersion: API_VERSION, pid: process.pid, startedAt: SERVER_STARTED_AT });
  }
  // What the server could NOT read, plus the knobs that change its behavior. Exists because a
  // skipped workspace was otherwise invisible from inside the product: the board simply omitted it
  // and the inbox stopped nagging, which is quieter than the whole-board error it replaced but no
  // more honest. The list routes flag the count on X-FlowLever-Skipped and point here for detail.
  if (parts[1] === 'diagnostics' && parts.length === 2 && req.method === 'GET') {
    // Loopback (or an explicit opt-in) only: this reports the absolute data path, the bind, and
    // whether remote writes are on — reconnaissance an unauthenticated remote reader has no business
    // with, even though it is a GET.
    if (!IS_LOOPBACK && !ALLOW_REMOTE_WRITES) {
      return sendError(res, 403, 'Diagnostics are available from loopback only (they report local '
        + 'paths and the trust-boundary configuration).');
    }
    const listed = ledger.listFeatures({ withSkipped: true });
    return sendJson(res, 200, {
      dataDir: ledger.DATA_DIR,
      host: HOST,
      loopback: IS_LOOPBACK,
      remoteWritesAllowed: ALLOW_REMOTE_WRITES,
      readOnly: ledger.READONLY,
      lockWaitMs: ledger.configureLocking().waitMs,
      fsyncDir: process.env.FLOWLEVER_FSYNC_DIR === '1',
      workspaces: listed.features.length,
      skippedWorkspaces: listed.skipped,
    });
  }
  // The browser recomputes readiness optimistically after a decision, and used to do it against a
  // hardcoded copy of the severity weights — which silently drifted the moment anyone edited the
  // documented config.json. Serve the real one instead.
  if (parts[1] === 'config' && parts.length === 2 && req.method === 'GET') {
    // `readOnly` rides on the config the page already fetches at boot rather than needing its own
    // request. The page has to know: in read-only mode every write control must say so up front
    // instead of letting the user compose a decision and meet a 403 at the end of it.
    return sendJson(res, 200, { ...ledger.loadConfig(), readOnly: ledger.READONLY });
  }
  if (parts[1] === 'runner' && parts.length === 2) {
    if (req.method === 'GET') return handleRunnerGet(res, url.searchParams.get('log') === '1');
    if (req.method === 'POST') return handleRunnerStart(req, res);
    if (req.method === 'DELETE') return handleRunnerStop(res);
  }
  if (parts[1] === 'ingest' && parts.length === 3 && req.method === 'POST') {
    return handleIngest(req, res, parts[2]);
  }
  if (parts[1] === 'report' && parts.length === 3 && req.method === 'GET') {
    return handleReport(res, parts[2]);
  }
  return sendError(res, 404, 'Not found');
}

const server = http.createServer((req, res) => {
  Promise.resolve()
    .then(() => route(req, res))
    .catch((err) => {
      if (res.writableEnded) return;
      // A lock timeout is transient — the right answer is "try again", not "your request was wrong".
      if (err && err.lockTimeout) {
        res.setHeader('Retry-After', '1');
        return sendError(res, 503, err.message);
      }
      if (err && err.code === 'EUSER') {
        // euserStatus decides on the MESSAGE, on every method. Forcing 404 for GET made
        // `GET /api/requests?status=bogus` — a validation error — answer 404, so a client could
        // not tell "no such resource" from "you sent nonsense".
        return sendError(res, euserStatus(err), err.message);
      }
      if (err && err.code === 'ETOOBIG') return sendError(res, 413, err.message);
      if (err && err.code === 'EBADJSON') return sendError(res, 400, err.message);
      console.error(err && err.stack ? err.stack : err);
      return sendError(res, 500, 'Internal server error');
    });
});

ledger.initDataDir();
// A contended lock blocks this process's event loop, so the whole cockpit is unresponsive while a
// request waits. The CLI and the runner can afford the ledger's generous default; the server cannot,
// so it fails fast and tells the client to retry. Measured worst case drops from ~10s to ~1.5s.
ledger.configureLocking({ waitMs: Number(process.env.FLOWLEVER_LOCK_WAIT_MS) > 0
  ? Number(process.env.FLOWLEVER_LOCK_WAIT_MS)
  : 1500 });
server.listen(PORT, HOST, () => {
  console.log(`FlowLever cockpit → http://localhost:${server.address().port}`);
  if (!IS_LOOPBACK) {
    console.warn(`WARNING: bound to ${HOST}, not loopback. The cockpit has NO authentication — `
      + 'anyone who can reach this address can read and change your review data'
      + `${ALLOW_REMOTE_RUNNER ? ' AND start runner sessions that write to Azure DevOps' : ''}.`);
  }
});

module.exports = { server };
