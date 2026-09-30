'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const repoRoot = path.resolve(__dirname, '..');
const DATA_DIR = process.env.FLOWLEVER_DATA || path.join(repoRoot, 'data');

// Read-only mode: the cockpit reads and renders everything, and refuses every write — to the
// ledger, to Azure DevOps, and to the runner. Read at require() time on purpose: a mode that could
// be toggled mid-process would be a mode you cannot reason about from a log line. See writeJson().
const READONLY = process.env.FLOWLEVER_READONLY === '1';

const SEVERITIES = ['blocker', 'major', 'minor', 'info'];
const STATUSES = ['open', 'reworking', 'resolved', 'waived'];
// Workflow kinds a workspace can host. All ride the same finding model + stepper;
// only labels/icons differ in the UI. `spec` is the default and the back-compat
// value for any feature on disk that predates the field.
const KINDS = ['spec', 'pr-review', 'pr-respond'];
// A workspace's lifecycle status (distinct from a finding's status). `done` means the
// review/flow is finished — the cockpit shows it as completed and the inbox stops nagging.
const FEATURE_STATUSES = ['draft', 'auditing', 'reworking', 'ready', 'implementing', 'done'];
const SOURCE_TYPES = ['confluence', 'ado', 'figma'];
// Workspace kinds whose findings are posted back as PR comments, and therefore have to be
// reconciled against the comments a PR already carries before anything is ingested.
const PR_KINDS = ['pr-review', 'pr-respond'];
// How near an incoming finding has to sit to an existing thread's anchor to count as landing on
// the same place. Reviewers rarely anchor to the exact same line — a comment on the guard clause
// and a comment on the `if` above it are the same conversation — so the window is deliberately
// wider than an exact match, and narrow enough that two unrelated points in one function don't
// collapse into each other.
const THREAD_PROXIMITY_LINES = 5;
const COVERAGE_STATUSES = ['covered', 'partial', 'uncovered', 'orphan'];
const DRAFT_FORMATS = ['text', 'gherkin', 'markdown'];
const REVIEW_STATUSES = ['accepted', 'rejected', 'edited'];
const REVIEW_VERDICTS = ['proposed', 'redirect', 'reject'];
// The systems a draft can be written back to on apply (spec workspaces). A draft's
// machine-addressable write target (`draft.targetRef`) names one of these.
const TARGET_SYSTEMS = ['ado', 'confluence'];
// UI-triggered job queue. A request is enqueued from the web UI and picked up by
// a session-side runner skill (/lever:watch) that runs the matching adapter.
//   pr-review / pr-respond → load a PR (require prId)
//   apply                  → write a workspace's reviewed output back to its source
//                            (require wsId): PR comments for PR kinds, ADO/Confluence
//                            edits for a spec workspace — the runner branches on kind
//   re-audit               → scoped re-audit of a spec workspace (require wsId): re-check
//                            only the findings the reviewer countered (verdict=redirect)
//   audit                  → start a NEW spec analysis (require instructions = the spec /
//                            work-item / Figma URLs): the runner creates the workspace,
//                            registers the sources, and runs the audit sweep
//   poll                   → the cockpit's manual "↻ Refresh": run a discovery pass NOW
//                            instead of waiting for the scheduled /flowlever:poll — find new
//                            PRs and re-check known ones for counterpart updates. Optional
//                            `kind` narrows it to one section (pr-review / pr-respond)
const REQUEST_ACTIONS = ['pr-review', 'pr-respond', 'apply', 're-audit', 'audit', 'propose', 'poll', 'summarize'];
// Actions that are meaningless without a target workspace. Enqueuing one without a `wsId`
// creates a row the runner can never dispatch and nothing ever cleans up — it just sits in the
// queue looking like work. (`audit` is absent on purpose: it takes EITHER a wsId or URLs.)
const WSID_REQUIRED_ACTIONS = ['apply', 're-audit', 'propose', 'summarize'];
const REQUEST_STATUSES = ['queued', 'running', 'done', 'error'];
// Workspace kinds a `poll` request may be narrowed to (null = both).
const REQUEST_KINDS = ['pr-review', 'pr-respond'];

// `scoreZeroAtPenalty` is the penalty total at which readiness hits 0 — the constant the score
// is normalized against. It lives in config because severityWeights do: scaling the weights
// without scaling this would silently redefine what `readyThreshold` means.
const DEFAULT_CONFIG = {
  severityWeights: { blocker: 10, major: 5, minor: 2, info: 0.5 },
  gates: { blockerOpenMeansNotReady: true, readyThreshold: 85, scoreZeroAtPenalty: 40 },
  dimensions: ['consistency', 'completeness', 'testability', 'design-match', 'dor', 'ambiguity', 'feasibility'],
};

// ---------- small helpers ----------

function euser(message) {
  const err = new Error(message);
  err.code = 'EUSER';
  return err;
}

function now() {
  return new Date().toISOString();
}

// Validated at the point an id becomes a filename, so no caller — HTTP route, CLI, skill — can
// forget to do it. See assertFeatureId for why this is the load-bearing guard.
function featurePath(id) { return path.join(DATA_DIR, 'features', `${assertFeatureId(id)}.json`); }
function ledgerPath(id) { return path.join(DATA_DIR, 'ledger', `${assertFeatureId(id)}.json`); }
function roundsPath(id) { return path.join(DATA_DIR, 'rounds', `${assertFeatureId(id)}.json`); }
function configPath() { return path.join(DATA_DIR, 'config.json'); }
function requestsPath() { return path.join(DATA_DIR, 'requests.json'); }

// A corrupt/hand-edited file on disk is a USER problem (they can fix the file), not an internal
// error — so it must surface as EUSER with the path, never as a raw SyntaxError behind a 500.
// Every read is confined to the real data directory. Validating the ID stops a traversing *id*, but
// it says nothing about a SYMLINK planted inside the data dir: `features/x.json` pointing at a file
// elsewhere was followed, so arbitrary JSON from outside was served straight back through the API.
// Both sides are resolved, so a symlinked FLOWLEVER_DATA (a legitimate setup) still works.
let realDataDir = null;
function assertInsideDataDir(file) {
  if (realDataDir === null) {
    // Only a resolved root is cached. Caching a fallback would poison every later read if the data
    // dir did not exist yet at first call and the real path differs (/tmp -> /private/tmp).
    try { realDataDir = fs.realpathSync(DATA_DIR); } catch { return; }
  }
  let real;
  try { real = fs.realpathSync(file); } catch { return; }   // missing: the caller's own check reports it
  if (real !== realDataDir && !real.startsWith(realDataDir + path.sep)) {
    throw euser(`refusing to read ${path.basename(file)}: it resolves outside the data directory`);
  }
}

function readJson(file) {
  assertInsideDataDir(file);
  const text = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(text);
  } catch (e) {
    throw euser(`${file} is not valid JSON (${e.message}). Fix or delete the file.`);
  }
}

// Durable replace: write to a temp file, fsync it, then rename over the target. Without the file
// fsync the rename can be visible while the contents are not — the window that makes "atomic"
// untrue at the level that matters. Syncing the DIRECTORY as well (so the rename itself survives an
// OS crash) is opt-in; see the note at the end of this function for the measurement behind that.
function writeJson(file, obj) {
  // Read-only mode is enforced HERE, at the one function every ledger write funnels through,
  // rather than only at the HTTP layer. The reason is the failure it exists to stop: testing the
  // cockpit against a throwaway copy of the data isolates the ledger but NOT the app's outbound
  // side effects, and a stray keystroke in the real one silently rewrote a real finding. A guard
  // that lives only in src/server.js would be bypassed by the CLI, by a spawned runner, and by
  // any future caller of this module — so it lives at the choke point and covers all of them.
  if (READONLY) {
    throw new Error(`FLOWLEVER_READONLY=1 — refusing to write ${path.basename(file)}. `
      + 'This cockpit is in read-only mode: nothing can change the ledger, post to Azure DevOps, '
      + 'or start a runner. Unset FLOWLEVER_READONLY to make changes.');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${nextTmpSeq()}.tmp`;
  const body = JSON.stringify(obj, null, 2) + '\n';
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, body);
      // Durability is best-effort: some filesystems reject fsync, and refusing to write at all there
      // would be a worse outcome than a slightly weaker durability guarantee.
      try { fs.fsyncSync(fd); } catch { /* not supported here */ }
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    // Never leave a half-written .tmp behind next to the real data.
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
  // The DIRECTORY fsync is opt-in, and that is a measured tradeoff, not laziness. Measured on this
  // machine: 0.18 ms/write with no fsync, 5.16 with the file fsync, 10.05 with both — so syncing the
  // directory doubles the time spent holding a global lock, and because this module is synchronous
  // that time is time the server serves nothing. What it buys is narrow: tmp+rename already makes
  // the replacement atomic, so a reader never sees a torn file; the directory sync only protects the
  // rename itself from an OS-level crash, whose failure mode is losing the last write and keeping the
  // previous good file — not corruption. For a local review tool that is the right side of the trade.
  // Set FLOWLEVER_FSYNC_DIR=1 to pay for it anyway.
  if (process.env.FLOWLEVER_FSYNC_DIR === '1') {
    try {
      const dfd = fs.openSync(path.dirname(file), 'r');
      try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    } catch { /* not supported here (notably Windows) */ }
  }
}

let tmpSeq = 0;
function nextTmpSeq() { tmpSeq += 1; return `${Date.now()}.${tmpSeq}`; }

// ---------- cross-process locking ----------
//
// The server (browser decisions), the CLI, and the /flowlever:watch runner all mutate the same
// JSON files by design — the runner is even pinned to the same FLOWLEVER_DATA. Every mutation is
// a read-modify-write, so without a lock two overlapping writers silently discard each other's
// changes (measured: 6 processes enqueueing 240 jobs persisted 47).
//
// `mkdir` is the lock primitive because it is atomic on every platform and leaves a file we can
// age out: a holder that crashed leaves a stale directory, so a lock older than LOCK_STALE_MS is
// broken rather than waited on forever. Re-entrant within a process (this module is fully
// synchronous, so "already held here" is unambiguous) which keeps nested public calls deadlock-free.
const LOCK_STALE_MS = 30_000;
// How long a caller waits for a contended lock before giving up. This module is synchronous, so on
// the server this wait BLOCKS THE EVENT LOOP — a contended write stalls every other request until it
// clears. Real writes take single-digit milliseconds, so contention normally resolves instantly; the
// wait only matters when another process (the CLI, the watch runner) is mid-write or died holding
// the lock. Be clear-eyed about the worst case: a request that waits the full timeout blocks the
// server for that whole time, so the ceiling IS a potential freeze, not merely a slow request. The
// server therefore sets a much shorter ceiling of its own (see configureLocking) and turns the
// timeout into a retryable 503; this default is for the CLI and the runner, where blocking is free.
// Tunable for slow/network filesystems.
// 10s is a safety net, not an expected latency: a write costs ~5ms, so even a dozen processes
// hammering one file clear in well under a second. It is only reached when something is genuinely
// stuck, and an orphaned lock is now reclaimed (see breakIfStale) rather than blocking forever.
const DEFAULT_LOCK_WAIT_MS = Number(process.env.FLOWLEVER_LOCK_WAIT_MS) > 0
  ? Number(process.env.FLOWLEVER_LOCK_WAIT_MS)
  : 10_000;
let lockWaitMs = DEFAULT_LOCK_WAIT_MS;

// The server calls this at startup with a much smaller ceiling. Blocking is free in the CLI and the
// runner — they have nothing else to serve — but in the server the wait is time the WHOLE cockpit is
// unresponsive, so there it must fail fast and let the caller retry rather than hold the event loop.
function configureLocking({ waitMs } = {}) {
  if (Number(waitMs) > 0) lockWaitMs = Number(waitMs);
  return { waitMs: lockWaitMs };
}
// A lock directory that never got its owner stamp can only be aged by its own mtime, which is a
// weaker signal — so it gets a much longer grace period before anyone reclaims it.
const LOCK_ORPHAN_MS = 60_000;
const LOCK_POLL_MS = 20;
const heldLocks = new Set();

function sleepSync(ms) {
  // Blocking sleep with no dependencies: wait on a futex that never gets notified.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withFileLock(file, fn) {
  const lock = `${file}.lock`;
  if (heldLocks.has(lock)) return fn();          // re-entrant: this process already holds it
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + lockWaitMs;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      // Stamp ownership INSIDE the lock so a crashed holder can be told apart from a live one.
      // Until this lands a waiter sees a lock with no stamp and simply retries — it must never
      // conclude "stale" from a missing stamp.
      try { fs.writeFileSync(path.join(lock, 'owner'), `${process.pid}\n${Date.now()}\n`); }
      catch { /* unstampable: the lock still works, it just can't be broken as stale */ }
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() >= deadline) {
        const err = euser(`timed out waiting for a lock on ${path.basename(file)} — another FlowLever `
          + `process is writing it. If nothing is running, remove ${lock} and retry.`);
        err.lockTimeout = true;   // transient: the HTTP layer answers 503, not 400
        throw err;
      }
      breakIfStale(lock);
      sleepSync(LOCK_POLL_MS);
    }
  }
  heldLocks.add(lock);
  try {
    return fn();
  } finally {
    heldLocks.delete(lock);
    try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* already gone */ }
  }
}

// Reclaim a lock left behind by a process that died holding it — and ONLY that.
//
// Two rules keep this from becoming the very bug it guards against:
//   1. A lock whose stamp is missing is NOT stale. It is either mid-acquire or was just released,
//      and treating absence as staleness lets a waiter delete a lock another process legitimately
//      holds — two writers, silent lost update. (Measured while building this: 1 enqueue in 240.)
//   2. Breaking is an atomic rename, so if several waiters decide to break at once exactly one
//      succeeds; the losers get ENOENT and simply retry.
function breakIfStale(lock) {
  let stamp = null;
  try { stamp = fs.readFileSync(path.join(lock, 'owner'), 'utf8'); }
  catch { /* unstamped: mid-acquire, just-released, or an orphan — decided below */ }

  if (stamp !== null) {
    const at = Number(String(stamp).split('\n')[1]);
    // An unparseable or future-dated stamp is never treated as old.
    if (!Number.isFinite(at) || Date.now() - at < LOCK_STALE_MS) return;
  } else {
    // Rule 1 forbids concluding "stale" from a missing stamp, because a lock acquired microseconds
    // ago has no stamp yet and deleting it loses a write. The DIRECTORY's own mtime distinguishes
    // the two: a just-acquired lock is fresh, an orphan left by a process that died between mkdir
    // and the stamp is old. Without this, such a lock was unbreakable and every later write to that
    // file failed forever with no in-product way out.
    let age = 0;
    try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { return; }
    if (!(age > LOCK_ORPHAN_MS)) return;
  }

  const doomed = `${lock}.stale.${process.pid}.${nextTmpSeq()}`;
  try { fs.renameSync(lock, doomed); } catch { return; }  // rule 2: another waiter won the break
  try { fs.rmSync(doomed, { recursive: true, force: true }); } catch { /* best effort */ }
}

// Read-modify-write a feature's ledger under its lock. `fn` mutates the loaded doc in place;
// the doc is saved once `fn` returns (a throw leaves the on-disk state untouched).
function mutateLedger(featureId, fn) {
  return withFileLock(ledgerPath(featureId), () => {
    const ledger = loadLedger(featureId);
    const out = fn(ledger);
    saveLedger(ledger);
    return out;
  });
}

function mutateFeature(featureId, fn) {
  return withFileLock(featurePath(featureId), () => {
    const feature = getFeature(featureId);
    const out = fn(feature);
    saveFeature(feature);
    return out === undefined ? feature : out;
  });
}

function mutateRequests(fn) {
  return withFileLock(requestsPath(), () => {
    const doc = loadRequests();
    const out = fn(doc);
    saveRequests(doc);
    return out;
  });
}

// ---------- data dir / config ----------

function initDataDir() {
  // In read-only mode this must not be the thing that fails: pointed at a fresh or empty directory
  // there is nothing to initialise and nothing to serve, and crashing on the missing config file
  // would make read-only mode look broken rather than empty. loadConfig() already falls back to
  // DEFAULT_CONFIG, so skip both the mkdir and the seed and let the board render empty.
  if (READONLY) return DATA_DIR;
  for (const sub of ['features', 'ledger', 'rounds']) {
    fs.mkdirSync(path.join(DATA_DIR, sub), { recursive: true });
  }
  if (!fs.existsSync(configPath())) {
    writeJson(configPath(), DEFAULT_CONFIG);
  }
  return DATA_DIR;
}

// config.json is a documented, hand-editable surface, so a partial or half-edited file must never
// be able to break the app: every key is merged onto the defaults and range-checked. Dropping
// `gates` while tuning weights used to make every readiness call and every ingest throw.
function loadConfig() {
  if (!fs.existsSync(configPath())) return structuredClone(DEFAULT_CONFIG);
  const raw = readJson(configPath());
  return mergeConfig(raw);
}

function mergeConfig(raw) {
  const out = structuredClone(DEFAULT_CONFIG);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;

  const rw = raw.severityWeights;
  if (rw && typeof rw === 'object' && !Array.isArray(rw)) {
    for (const sev of SEVERITIES) {
      const v = rw[sev];
      // A weight that is missing or nonsense keeps its default — never 0, which would make that
      // severity free and let a blocker contribute nothing while still tripping the blocker gate.
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out.severityWeights[sev] = v;
    }
  }

  const rg = raw.gates;
  if (rg && typeof rg === 'object' && !Array.isArray(rg)) {
    if (typeof rg.blockerOpenMeansNotReady === 'boolean') {
      out.gates.blockerOpenMeansNotReady = rg.blockerOpenMeansNotReady;
    }
    if (typeof rg.readyThreshold === 'number' && Number.isFinite(rg.readyThreshold)
      && rg.readyThreshold >= 0 && rg.readyThreshold <= 100) {
      out.gates.readyThreshold = rg.readyThreshold;
    }
    if (typeof rg.scoreZeroAtPenalty === 'number' && Number.isFinite(rg.scoreZeroAtPenalty)
      && rg.scoreZeroAtPenalty > 0) {
      out.gates.scoreZeroAtPenalty = rg.scoreZeroAtPenalty;
    }
  }

  if (Array.isArray(raw.dimensions)) {
    const dims = raw.dimensions.filter((d) => typeof d === 'string' && d.trim() !== '');
    if (dims.length) out.dimensions = dims;
  }
  return out;
}

// ---------- features ----------

// THE id guard. Every feature id becomes a path segment (`features/<id>.json`), so an id that
// escapes the character class escapes the data directory: the HTTP layer percent-decodes route
// segments, which turned `..%2f..%2fsecret` into a real traversal and let any reachable client
// read or delete arbitrary .json files. Validation therefore cannot live only in createFeature —
// it must run on every path that turns an id into a filename. Callers use `assertFeatureId`.
const FEATURE_ID_RE = /^[a-z0-9-]{1,64}$/;

function isValidFeatureId(id) {
  return typeof id === 'string' && FEATURE_ID_RE.test(id);
}

function assertFeatureId(id) {
  if (!isValidFeatureId(id)) {
    throw euser(`invalid feature id "${id}": must match [a-z0-9-]{1,64}`);
  }
  return id;
}

function createFeature({ id, title, kind = 'spec' }) {
  assertFeatureId(id);
  if (typeof title !== 'string' || title.trim() === '') {
    throw euser('feature title is required');
  }
  if (!KINDS.includes(kind)) {
    throw euser(`invalid kind "${kind}": must be one of ${KINDS.join(', ')}`);
  }
  if (fs.existsSync(featurePath(id))) {
    throw euser(`feature "${id}" already exists`);
  }
  const ts = now();
  const feature = {
    id,
    title,
    kind,
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
    sources: { confluence: [], ado: [], figma: [] },
    // null = the PR's existing comment threads were never fetched. Distinct from a recorded
    // empty list, which asserts the PR genuinely had no comments. Ingest refuses to run on a
    // PR workspace while this is null, so "I never looked" can't pass for "there was nothing".
    priorThreads: null,
    specSections: [],
    coverage: [],
    notes: '',
    reviewBrief: '',
  };
  writeJson(featurePath(id), feature);
  return feature;
}

// Back-fill every structural field a feature file is expected to carry, so a workspace written by
// an older version (or hand-edited) can't make a downstream `.push` / `.filter` throw TypeError and
// surface as an opaque 500. Only shapes are repaired here — no content is invented.
// `idFromPath` is authoritative when given: the FILENAME identifies the workspace, not a field
// inside it. Trusting the field meant (a) a file with no `id` produced `undefined` and broke every
// caller that then built a path from it, and (b) a file whose `id` named a DIFFERENT workspace made
// saveFeature write over that other workspace.
function normalizeFeature(feature, idFromPath = null) {
  if (!feature || typeof feature !== 'object' || Array.isArray(feature)) {
    throw euser('feature file is malformed: expected a JSON object');
  }
  if (idFromPath !== null) feature.id = idFromPath;
  if (!feature.kind) feature.kind = 'spec';
  const sources = feature.sources && typeof feature.sources === 'object' && !Array.isArray(feature.sources)
    ? feature.sources
    : {};
  for (const t of SOURCE_TYPES) {
    if (!Array.isArray(sources[t])) sources[t] = [];
  }
  feature.sources = sources;
  // Anything that isn't a well-formed record collapses to null — "not recorded". A workspace
  // written before this field existed therefore reads as never-fetched rather than as a PR with
  // no comments, which is the safe direction: it fails the ingest gate instead of silently
  // waving every duplicate through.
  const pt = feature.priorThreads;
  feature.priorThreads = pt && typeof pt === 'object' && !Array.isArray(pt) && Array.isArray(pt.threads)
    ? { recordedAt: pt.recordedAt ?? null, threads: pt.threads.filter((t) => t && typeof t === 'object' && !Array.isArray(t)) }
    : null;
  if (!Array.isArray(feature.specSections)) feature.specSections = [];
  if (!Array.isArray(feature.coverage)) feature.coverage = [];
  // Absent, blank or the wrong type all collapse to null — "nobody has written one". The cockpit
  // draws the summary block only for a non-empty string, so a workspace written before this field
  // existed simply doesn't show one rather than rendering `undefined` or an empty panel.
  feature.summary = typeof feature.summary === 'string' && feature.summary.trim() ? feature.summary : null;
  return feature;
}

function getFeature(id) {
  if (!fs.existsSync(featurePath(id))) {
    throw euser(`feature "${id}" not found`);
  }
  return normalizeFeature(readJson(featurePath(id)), id);
}

// One unreadable file must not take down the whole board. It used to: the list is built from the
// directory rather than from validated ids, so a single hand-edited or truncated workspace made
// GET /api/features and the inbox fail for every OTHER workspace too. Bad files are skipped and
// named on stderr — visible in the server log, never silently dropped.
// Warn once per file+mtime, not once per call: the board polls, so an unchanged bad file otherwise
// reprints its warning on every request and buries the log.
const warnedSkips = new Set();
const WARNED_SKIPS_CAP = 500;
function warnSkipOnce(file, reason) {
  let key = `${file}:?`;
  try { key = `${file}:${fs.statSync(file).mtimeMs}`; } catch { /* gone; warn under '?' */ }
  if (warnedSkips.has(key)) return;
  // Keyed by mtime, so a file rewritten in a loop would otherwise grow this forever in a
  // long-running server. Dropping the oldest just means an old warning may repeat once.
  if (warnedSkips.size >= WARNED_SKIPS_CAP) warnedSkips.delete(warnedSkips.values().next().value);
  warnedSkips.add(key);
  console.warn(`FlowLever: skipping ${path.basename(file)} — ${reason}`);
}

// `withSkipped` returns { features, skipped } so a caller can TELL THE USER something was omitted.
// Silently dropping a workspace is its own failure: the board would simply not show it and the inbox
// would stop nagging, which is quieter but no more honest than the whole-board error it replaced.
function listFeatures({ withSkipped = false } = {}) {
  const dir = path.join(DATA_DIR, 'features');
  if (!fs.existsSync(dir)) return withSkipped ? { features: [], skipped: [] } : [];
  const features = [];
  const skipped = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const full = path.join(dir, file);
    const id = file.slice(0, -'.json'.length);
    if (!isValidFeatureId(id)) {
      const reason = `"${id}" is not a valid workspace id`;
      warnSkipOnce(full, reason);
      skipped.push({ file, reason });
      continue;
    }
    try {
      features.push(normalizeFeature(readJson(full), id));
    } catch (err) {
      warnSkipOnce(full, err.message);
      skipped.push({ file, reason: err.message });
    }
  }
  return withSkipped ? { features, skipped } : features;
}

function saveFeature(feature) {
  feature.updatedAt = now();
  writeJson(featurePath(feature.id), feature);
  return feature;
}

// Set a workspace's lifecycle status (e.g. mark a review `done`, or reopen it).
function setFeatureStatus(featureId, status) {
  if (!FEATURE_STATUSES.includes(status)) {
    throw euser(`invalid feature status "${status}": must be one of ${FEATURE_STATUSES.join(', ')}`);
  }
  return mutateFeature(featureId, (feature) => { feature.status = status; });
}

// The plain-language "what is this change actually about" blurb shown at the top of a workspace.
// The app carries no model of its own, so this is written by the review skills — which have just
// read the PR description, the linked work item and the specs — and by nothing else. An empty
// summary therefore means NOBODY HAS WRITTEN ONE YET, never "this workspace has nothing to say":
// the cockpit says exactly that rather than inventing a sentence from the title.
// `null`/`''` clears it, so a wrong summary can be withdrawn without deleting the workspace.
function setFeatureSummary(featureId, summary) {
  if (summary !== null && summary !== undefined && typeof summary !== 'string') {
    throw euser('summary must be a string (or null to clear it)');
  }
  const text = typeof summary === 'string' ? summary.trim() : '';
  return mutateFeature(featureId, (feature) => { feature.summary = text || null; });
}

// The PR-review "waiting on author" tracker (pr-review / pr-respond). After posting, a
// workspace waits on the author; the /flowlever:watch runner checks the PR for new
// replies/commits since `lastPostedAt` and flips `authorRespondedAt` (+ a human note) so the
// cockpit can move from a passive "Waiting on author" state to "Author responded → Re-review".
//
// Two DIFFERENT clocks live here and must not be conflated:
//   - `authorRespondedAt` — when the RUNNER NOTICED the activity (detection time).
//   - `lastActivityAt`    — the real timestamp OF the newest counterpart update on the PR
//                           (their latest comment / pushed commit), as reported by ADO, with
//                           `lastActivityBy` naming who made it. This is what the cockpit shows
//                           as "PR updated <when>" and compares against the last review round
//                           to decide whether a re-review is worth running.
// `patch` merges any of { lastPostedAt, authorRespondedAt, lastActivityAt, lastActivityBy, note }
// (null clears a field).
const REVIEW_FIELDS = ['lastPostedAt', 'authorRespondedAt', 'lastActivityAt', 'lastActivityBy', 'note'];
function setFeatureReview(featureId, patch = {}) {
  return mutateFeature(featureId, (feature) => {
    const review = {
      lastPostedAt: null, authorRespondedAt: null, lastActivityAt: null, lastActivityBy: null, note: null,
      ...(feature.review || {}),
    };
    for (const k of REVIEW_FIELDS) {
      if (patch[k] !== undefined) review[k] = patch[k];
    }
    feature.review = review;
  });
}

// Is `a` strictly later than `b`? Parsed (not string-compared) so timestamps that ADO hands
// back with a different offset/precision than our own `now()` still order correctly. An
// unparseable or missing value is never "later".
function isAfter(a, b) {
  const ta = Date.parse(a);
  if (Number.isNaN(ta)) return false;
  const tb = Date.parse(b);
  return Number.isNaN(tb) ? true : ta > tb;
}

// The two timestamps the cockpit reads to answer "can I re-review yet?": when WE last reviewed
// (the last ingest round — no separate stamp needed, a round IS a review pass) and when the
// counterpart last touched the PR. `newSinceReview` is the whole point: their update landed
// after our last round, so a re-review would actually see something new.
function reviewStamps(feature, lastRoundAt = null) {
  const rv = (feature && feature.review) || {};
  const lastReviewedAt = lastRoundAt || null;
  const lastActivityAt = rv.lastActivityAt || null;
  return {
    lastReviewedAt,
    lastActivityAt,
    lastActivityBy: rv.lastActivityBy || null,
    lastPostedAt: rv.lastPostedAt || null,
    authorRespondedAt: rv.authorRespondedAt || null,
    newSinceReview: Boolean(lastActivityAt && isAfter(lastActivityAt, lastReviewedAt)),
  };
}

// ---------- one canonical state per workspace ----------

// What the reviewer has already decided about a finding, read from PERSISTED state only —
// null means genuinely undecided. This mirrors the rules web/app.js applies when it hydrates
// the review flow off disk, and it has to: the cockpit's list views rank a workspace by whether
// anything is still undecided, so a second, subtly different notion of "decided" would park a
// workspace under "needs you" while the page it opens shows nothing left to do.
//
// The hunk path is the one that is easy to miss. Accepting a proposal hunk-by-hunk in the diff
// never writes the finding-level `decision`, so keying off `decision` alone would read the
// commonest PR-review flow as undecided forever.
function decisionOf(finding) {
  if (!finding || typeof finding !== 'object') return null;
  if (finding.status === 'waived') return 'waive';
  if (FINDING_DECISIONS.includes(finding.decision)) return finding.decision;
  const rv = finding.draft && finding.draft.review;
  if (!rv) return null;
  // "Don't apply this" IS a decision, not the absence of one. Treating a considered
  // redirect/reject as undecided would leave the workspace demanding attention it already had.
  if (rv.verdict === 'redirect') return 'redirect';
  if (rv.verdict === 'reject') return 'reject';
  // `draft.review.hunks` is the ledger's own record of the hunks — a map from hunk index to the
  // decision taken on it — so the recorded keys ARE the hunk ids here. The browser instead walks
  // the hunk list it recomputes from the before/after diff, which means a draft whose hunks are
  // only PARTLY decided reads as undecided there and decided here. Closing that skew would mean
  // a second copy of the diff engine in the ledger, which costs more than the skew does — and what
  // it costs is bounded. The skew only ever runs one way (decided here, undecided there), so the
  // workspace reads `ready-to-post` where the browser would say `needs-review`/`needs-rereview`;
  // all three sit in the SAME `needs-you` band, so it can change the label and the rank within that
  // band and never the band itself. Nothing is hidden by it. The dominant path cannot skew at all:
  // Approve in web/app.js (`acceptAll`) writes an entry for every hunk id, so it takes a
  // strict-subset accept with the remainder left untouched to reach the disagreement.
  const statuses = Object.values(rv.hunks || {}).map((h) => h && h.status);
  if (!statuses.length) return null;
  if (!statuses.every((s) => s === 'accepted' || s === 'edited')) return null;
  return statuses.includes('edited') ? 'edit' : 'approve';
}

// The nine workspace states in the order the cockpit ranks them, grouped into the four bands the
// list views draw. ONE table, deliberately: a consumer that wants "which band" and a consumer
// that wants "which sorts first" must not each carry their own copy of the order, because the
// two lists drift and the UI then shows a card in one band sorted as if it were in another.
// Rank is the index — no separate number to keep in step.
// (The browser layers its own live-runner states on top of these bands; those are its business,
// not the ledger's — nothing here may assume this is the complete set of things a card can say.)
const WORKSPACE_STATES = [
  { state: 'ready-to-post', band: 'needs-you', label: 'Ready to post' },
  { state: 'needs-review', band: 'needs-you', label: 'Needs review' },
  { state: 'needs-rereview', band: 'needs-you', label: 'Needs re-review' },
  { state: 'author-responded', band: 'needs-you', label: 'Author responded' },
  // Last within `needs-you`: the work is finished and what is left is one press on the PR, so it
  // sorts under the reviews still needing a read-through. Bands are CONTIGUOUS runs in this array
  // — a state placed outside its band's run is drawn under one header and sorted as if it sat
  // under another, which is the exact failure the one-table rule exists to prevent.
  { state: 'needs-approval', band: 'needs-you', label: 'Ready to approve' },
  { state: 'posting', band: 'in-progress', label: 'Posting' },
  { state: 'awaiting-author', band: 'waiting', label: 'Awaiting author' },
  { state: 'awaiting-reaudit', band: 'waiting', label: 'Awaiting re-audit' },
  { state: 'settled', band: 'waiting', label: 'Settled' },
  { state: 'done', band: 'done', label: 'Done' },
];

// ---------- the PR approval signal ----------
//
// FlowLever never casts a vote — the reviewer does that on the PR. All this computes is the
// RECOMMENDATION, so that "the review is finished and nobody told you" stops being a state you
// have to notice for yourself. It is derived from the ledger alone: no ADO read, no ADO write.
//
// `major` sits with `blocker` on the reviewer's own rule, not on Azure DevOps': an approve says
// "my feedback was handled", and a major finding is feedback. Only minor/info can ride along under
// "Approved with suggestions".
const APPROVAL_BLOCKING_SEVERITIES = ['blocker', 'major'];
// The dimension the review skills raise a question under — `/flowlever:pr-review` maps `ambiguity`
// onto the `question` conventional-comment label. An unanswered question is never an approve,
// whatever severity it was filed at: the author has not replied to it yet.
const QUESTION_DIMENSION = 'ambiguity';
const APPROVAL_VOTES = ['approve', 'approve-with-suggestions', 'wait-for-author'];

// What is still OUT on the PR, split by what it costs the vote. Only posted-and-still-open
// findings count: a finding waived or resolved has been handled (fixed, pushed back, or accepted),
// and one that never went out was never the author's to answer.
function outstandingByWeight(findings) {
  const out = (Array.isArray(findings) ? findings : []).filter((f) => f && isPosted(f));
  // An unrecognised or missing severity counts as BLOCKING. Ingest validates severity, so this
  // only reaches a hand-edited or legacy ledger — but the safe default for a vote is to withhold
  // it, not to quietly file the unknown thing under "suggestion" and recommend an approve.
  const isBlocking = (f) => !SEVERITIES.includes(f.severity) || APPROVAL_BLOCKING_SEVERITIES.includes(f.severity);
  const isQuestion = (f) => f.dimension === QUESTION_DIMENSION;
  return {
    blocking: out.filter(isBlocking).length,
    // A question already counted as blocking is not counted twice — the buckets partition `out`.
    questions: out.filter((f) => !isBlocking(f) && isQuestion(f)).length,
    suggestions: out.filter((f) => !isBlocking(f) && !isQuestion(f)).length,
  };
}

// The vote those buckets imply. Kept separate from `approvalSignal` so `workspaceState` can ask
// for it WITHOUT calling back into itself.
function voteFor(o) {
  if (o.blocking || o.questions) return 'wait-for-author';
  if (o.suggestions) return 'approve-with-suggestions';
  return 'approve';
}

// Has the PR moved since our last round? Either the runner flagged a response, or the recorded
// activity is newer than the round.
//
// This is a FACT about the workspace, not a workspace *state*, and the difference is the whole of
// bug B1: `workspaceState` only ever reaches its `author-responded` rule from inside the
// "something is still posted" branch, so a review whose findings were all resolved — the clean
// review, the finished one — walked straight past it. Reading the state string therefore answered
// "did the PR move?" with "no" for exactly the workspaces where the question matters most, and the
// signal recommended Approve on code the author had pushed to since anybody read it. Ask the facts.
function prMovedSinceRound(feature, lastRoundAt) {
  return Boolean(feature && feature.review && feature.review.authorRespondedAt)
    || reviewStamps(feature, lastRoundAt).newSinceReview;
}

// Is this finding still LIVE work on the reviewer's side? Open/reworking and not already out of
// their hands — nothing posted to the PR, nothing written back to the spec, no runner mid-write.
// This is the same set `computeReadiness` scores as "open", i.e. the one the `counts.open` on a
// list row is drawn from.
function isLiveFinding(finding) {
  return isOpen(finding) && !isPosted(finding) && !isApplied(finding) && !isPending(finding);
}

// Is this finding still something the REVIEWER has to decide on? Live (above) AND carrying
// something decidable — a code-diff `draft` or a non-empty `suggestion` (the proposed PR comment).
// PR-review findings usually carry only a suggestion, so dropping the suggestion arm would make
// every PR workspace look like it had nothing to review.
//
// Deliberately NARROWER than isLiveFinding, and it must stay that way: this predicate mirrors
// web/app.js's `reviewableFindings()`, which is what the review stepper walks. Widening it to take
// in live findings with nothing attached would hand the stepper cards it cannot render a decision
// for. Where the state machine needs "is there live work at all", it asks isLiveFinding instead.
function isReviewable(finding) {
  if (!isLiveFinding(finding)) return false;
  const hasSuggestion = typeof finding.suggestion === 'string' && finding.suggestion.trim() !== '';
  return Boolean(finding.draft) || hasSuggestion;
}

// Has anything on this workspace ever gone out? It is the only durable first-pass/second-pass
// split: a re-review round reopens findings that look exactly like first-round ones. The
// per-finding stamp is checked as well as the workspace one because a workspace posted before
// feature.review existed carries the evidence only on its findings.
function everPosted(feature, list) {
  return Boolean(feature && feature.review && feature.review.lastPostedAt)
    || list.some((f) => Boolean(f && f.postedAt));
}

// The single answer to "what is going on with this workspace?", computed here rather than in the
// browser so every surface — inbox rows, section cards, anything later — reads the SAME string.
// The order of the tests is the contract: each one claims the workspace outright, so the earlier
// a rule sits the more it outranks the rest. In particular an in-flight post wins over everything
// but `done`, because while the runner is mid-write the ledger's other stamps are still the
// pre-post ones and any later rule would describe a state that has already moved on.
function workspaceState(feature, findings, lastRoundAt = null) {
  const list = Array.isArray(findings) ? findings : [];
  if (feature && feature.status === 'done') return 'done';
  if (list.some(isPending)) return 'posting';

  const reviewable = list.filter(isReviewable);
  if (reviewable.some((f) => decisionOf(f) === null)) {
    // Whether this is a first pass or a second one changes what the user is being asked to do.
    return everPosted(feature, list) ? 'needs-rereview' : 'needs-review';
  }
  // Everything decidable has been decided and none of it has gone out yet — the user's next
  // move is the Post button, not another read-through.
  if (reviewable.length) return 'ready-to-post';

  if (list.some(isPosted)) {
    // Either the runner explicitly flagged a response, or the recorded PR activity is newer than
    // our last round. Both mean the same thing: there is a delta on the PR to reconcile.
    if (prMovedSinceRound(feature, lastRoundAt)) return 'author-responded';
    // Comments are out, but if NONE of them blocks — only suggestions, no unanswered questions —
    // the reviewer is not actually waiting on anybody: they can approve-with-suggestions now. That
    // is a `needs-you` move, and filing it under "waiting on others" is exactly how it gets
    // forgotten. Anything blocking stays `awaiting-author`, which is the truth.
    // `lastRoundAt` is required for the same reason it is below: the row would otherwise say
    // "Ready to approve" on a workspace whose chip declines to name a vote, and a row and a chip
    // that disagree are worse than either alone.
    if (isPrReviewKind(feature) && lastRoundAt
        && voteFor(outstandingByWeight(list)) === 'approve-with-suggestions') {
      return 'needs-approval';
    }
    return 'awaiting-author';
  }
  if (list.some(isApplied)) return 'awaiting-reaudit';

  // Backstop, and the reason this whole function exists. A live finding carrying neither a draft
  // nor a suggestion is invisible to isReviewable, so without this it walks past every rule above
  // and lands on `settled` — drawn in the "waiting on others" band at minimum density, on a row
  // whose own `counts.open` says there is open work. The user would be told to wait on somebody
  // else for work that is nobody's but theirs, by the one list built to stop work going missing.
  // `ingestFindings` defaults `suggestion` to '', so this arrives through the documented path.
  // Reviewable or not, the state has to name it — the user decides what to do with an empty one.
  if (list.some(isLiveFinding)) return everPosted(feature, list) ? 'needs-rereview' : 'needs-review';

  // Nothing open, nothing out, not marked done: the work is finished but the workspace has not
  // been closed. On a PR review that has ACTUALLY had a round, that is not a resting place at all
  // — it is the moment the PR can be approved, and the moment the reviewer forgets to. It only
  // counts once a round has run: recommending an approve on a workspace nobody has reviewed would
  // be the worst thing this feature could do.
  // …and only while the PR has not moved since. A review whose findings were all resolved is the
  // likeliest workspace to reach here, and if the author has pushed since, whether the fixes are
  // real is the open question — not something to badge "Ready to approve". Such a workspace stays
  // `settled`, exactly as it did before this state existed.
  if (isPrReviewKind(feature) && lastRoundAt && !prMovedSinceRound(feature, lastRoundAt)) {
    return 'needs-approval';
  }
  // Otherwise a real resting place, not an error — hence a name of its own.
  return 'settled';
}

function isPrReviewKind(feature) { return ((feature && feature.kind) || 'spec') === 'pr-review'; }

// The recommendation the cockpit shows: which vote this review has earned, and why — in the
// reviewer's own terms, so the chip can be read without opening the findings.
//
// FlowLever does not cast it. The reviewer votes on the PR; this only removes "notice that you
// are done" from the list of things they have to remember. `vote` is null whenever the honest
// answer is "not yet" — and the `reason` then says what is missing, because a silent null reads
// as a bug.
function approvalSignal(feature, findings, lastRoundAt = null) {
  const list = Array.isArray(findings) ? findings : [];
  const outstanding = outstandingByWeight(list);
  const none = (reason) => ({ vote: null, reason, outstanding });

  // Only a pr-review carries a vote of yours: a spec has no PR, and on a pr-respond YOU are the
  // author — the vote there is somebody else's to cast.
  if (!isPrReviewKind(feature)) return none('not a PR review');
  // No round has run, so nothing has been read. A workspace can sit here with zero findings and
  // look exactly like a clean review; it is not one.
  if (!lastRoundAt) return none('no review round has run yet');

  // Gated on FACTS, not on the state string. A denylist of states was how B1 shipped: a state this
  // list forgot — or one `workspaceState` could not reach, which is what happened — falls through
  // to a vote, and the failure direction is "recommend Approve", the worst output this has. Each
  // test below asks the ledger directly, so there is nothing to forget.
  if (list.some(isPending)) return none('a post is still in flight');
  // Anything open that has not gone out yet: the review is not finished, whatever else is true.
  if (list.some(isLiveFinding)) return none('the review is not finished');
  // The PR moved after our last round, so whether the feedback was handled is precisely what we
  // do not know. Approving here would be signing off on code nobody re-read. This must be asked
  // even when NOTHING is still outstanding — a clean review of a PR that has since been pushed to
  // is the single most inviting way to get a false Approve.
  if (prMovedSinceRound(feature, lastRoundAt)) {
    return none('the PR changed after your last round — re-review first');
  }

  const vote = voteFor(outstanding);
  // The words matter here, because this chip sits directly under the readiness gate, which says
  // "nothing blocking" about a DIFFERENT set: the gate counts the reviewer's own open queue, and a
  // posted finding deliberately leaves it (it stops being "to review" and stops dragging the
  // score). Both are true at once — "0 open total · nothing blocking" beside "3 blocking" reads as
  // a contradiction unless each names its own subject. So: comments, on the PR, awaiting them.
  const n = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const bits = [];
  if (outstanding.blocking) bits.push(n(outstanding.blocking, 'blocking comment'));
  if (outstanding.questions) bits.push(n(outstanding.questions, 'unanswered question'));
  if (outstanding.suggestions) bits.push(n(outstanding.suggestions, 'suggestion'));
  const reason = vote === 'approve'
    ? 'nothing outstanding — every finding was fixed, waived or answered'
    : vote === 'wait-for-author'
      ? `${bits.join(' · ')} still awaiting the author`
      : `${bits.join(' · ')} posted — nothing blocking`;
  return { vote, reason, outstanding };
}

// Register a source on a workspace. Idempotent by the type's key field: re-adding the same
// Confluence page / work item / Figma file UPDATES that entry instead of appending a second copy
// (a duplicate would double-count in the coverage matrix and the dashboard's source counts).
function addSource(featureId, { type, ...fields }) {
  if (!SOURCE_TYPES.includes(type)) {
    throw euser(`invalid source type "${type}": must be one of ${SOURCE_TYPES.join(', ')}`);
  }
  const entry = { ...fields, lastFetched: fields.lastFetched ?? null };
  // The ado source entry carries its own "type" field (work item type), which
  // collides with the source-kind discriminator; accept it as `itemType`.
  if (type === 'ado' && 'itemType' in entry) {
    entry.type = entry.itemType;
    delete entry.itemType;
  }
  // The work item's Vertec booking phase (ADO's `Custom.Vertec` field, under Administration) and
  // an explicit booking-key override. Trimmed to null when blank so "recorded as empty" and "never
  // recorded" are the same thing to the cockpit — it labels a missing phase rather than drawing a
  // blank one, and a re-added source with a blank flag must not wipe a phase already on file.
  // A blank value is DROPPED, never stored. `title` and `url` are here for the same reason the
  // vertec fields are, and they earned it late: /flowlever:summarize re-registers every ado source
  // on a workspace passing `--title "<System.Title>"`, so an unset shell variable would blank the
  // real titles across 36 workspaces — silently destroying exactly the data that step exists to
  // repair. Clearing stays possible, but only by passing an explicit null.
  for (const k of ['vertecPhase', 'vertecKey', 'title', 'url']) {
    if (!(k in entry)) continue;
    if (entry[k] === null) continue;                       // explicit clear
    if (typeof entry[k] !== 'string') throw euser(`${k} must be a string`);
    const v = entry[k].trim();
    if (v) entry[k] = v;
    else delete entry[k];
  }
  // The key becomes the `FZAG-` half of a string pasted into a booking, so it has to LOOK like a
  // key. Without this, `--vertecKey "foo bar"` yields the booking line "FOO BAR-43057 …", which is
  // wrong in a way nothing downstream can detect.
  if (typeof entry.vertecKey === 'string' && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.vertecKey)) {
    throw euser(`vertecKey "${entry.vertecKey}" is not a booking key: letters, digits, . _ - only`);
  }
  const keyField = type === 'figma' ? 'fileKey' : 'id';
  if (entry[keyField] === undefined || entry[keyField] === null || entry[keyField] === '') {
    throw euser(`${type} source requires "${keyField}"`);
  }
  return mutateFeature(featureId, (feature) => {
    const list = feature.sources[type];
    const idx = list.findIndex((s) => s && String(s[keyField]) === String(entry[keyField]));
    if (idx === -1) list.push(entry);
    else list[idx] = { ...list[idx], ...entry };
    return entry;
  });
}

// ---------- prior PR threads (duplicate-comment enforcement) ----------

// Record the comment threads a PR already carries — other reviewers' and our own from earlier
// rounds — so ingest can refuse findings that restate them. Passing an empty array is a positive
// assertion that the PR had no comments; it satisfies the gate. `threads` entries:
//   { threadId, author, locus, excerpt?, url?, status? }
// `locus` uses the same `pr:<id>:<path>:L<line>` grammar as a finding, so the two are directly
// comparable; a thread ADO reports without a file anchor (a PR-level comment) may omit it.
function setPriorThreads(featureId, threads) {
  if (!Array.isArray(threads)) throw euser('threads must be an array');
  const clean = threads.map((t, i) => {
    if (!t || typeof t !== 'object' || Array.isArray(t)) throw euser(`thread[${i}] must be an object`);
    if (t.threadId === undefined || t.threadId === null || String(t.threadId).trim() === '') {
      throw euser(`thread[${i}].threadId is required`);
    }
    if (typeof t.author !== 'string' || t.author.trim() === '') {
      throw euser(`thread[${i}].author is required (who already made the point)`);
    }
    for (const opt of ['locus', 'excerpt', 'url', 'status']) {
      if (t[opt] !== undefined && t[opt] !== null && typeof t[opt] !== 'string') {
        throw euser(`thread[${i}].${opt} must be a string when provided`);
      }
    }
    return {
      threadId: String(t.threadId),
      author: t.author.trim(),
      locus: t.locus ?? null,
      excerpt: t.excerpt ?? '',
      url: t.url ?? null,
      status: t.status ?? null,
    };
  });
  return mutateFeature(featureId, (feature) => {
    feature.priorThreads = { recordedAt: now(), threads: clean };
    return feature.priorThreads;
  });
}

// Split a locus into the parts worth comparing. Understands the finding grammars:
//   pr:<id>:<path>:L<line>       → { path, from, to }
//   pr:<id>:<path>:L<a>-<b>      → { path, from: a, to: b }
//   pr:<id>:<path>:<line>        → same; the bare-number form is used in practice too
//   pr:<id>:thread:<threadId>    → { threadId }
// and degrades to { path, from: null } for anything else (spec loci, a file with no line), which
// simply won't collide with a PR thread anchor.
//
// The `L` is optional ONLY under a `pr:` prefix. Without it, `ado:42695` would read as line 42695
// of a file called "ado" — a phantom anchor on spec loci. Requiring either the prefix or the `L`
// keeps the bare-number convenience without inventing positions for non-PR loci.
function parseLocus(locus) {
  const s = String(locus || '');
  const thread = /^pr:[^:]+:thread:(.+)$/.exec(s);
  if (thread) return { threadId: thread[1], path: null, from: null, to: null };
  const anchored = /^(?:(pr:[^:]+:)|)(.*?):(?:L(\d+)|(\d+))(?:-(\d+))?$/.exec(s);
  if (anchored && (anchored[1] !== undefined || anchored[3] !== undefined)) {
    const from = Number(anchored[3] ?? anchored[4]);
    const to = anchored[5] === undefined ? from : Number(anchored[5]);
    return { threadId: null, path: normalizePath(anchored[2]), from: Math.min(from, to), to: Math.max(from, to) };
  }
  return { threadId: null, path: normalizePath(s.replace(/^pr:[^:]+:/, '')), from: null, to: null };
}

// Compare paths by their tail, case-insensitively: ADO reports thread anchors as `/src/Foo.cs`
// while a review finding usually writes `src/Foo.cs`. Matching on the normalized string would
// call those two different files and let every duplicate through.
function normalizePath(p) {
  const s = String(p || '').replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase();
  return s === '' ? null : s;
}

// Which already-existing threads does this finding land on? Same file, and line ranges that
// overlap or sit within THREAD_PROXIMITY_LINES of each other. A thread with no file anchor can't
// collide positionally — it's a PR-level comment — so it never matches here.
function threadCollisions(locus, threads) {
  const a = parseLocus(locus);
  if (!a.path || a.from === null) return [];
  return (threads || []).filter((t) => {
    if (!t.locus) return false;
    const b = parseLocus(t.locus);
    if (!b.path || b.from === null) return false;
    if (b.path !== a.path && !b.path.endsWith(`/${a.path}`) && !a.path.endsWith(`/${b.path}`)) return false;
    return a.from - THREAD_PROXIMITY_LINES <= b.to && b.from - THREAD_PROXIMITY_LINES <= a.to;
  });
}

// A finding is allowed to sit on top of an existing thread only when the review has said, in the
// data, what it's doing about it:
//   - duplicateOf         → it's the same point, kept visible as a cross-reference
//   - pr:…:thread:<id>    → it's an increment, and Apply will post it as a reply in that thread
//   - notDuplicate: "…"   → the reviewer looked and judged it a genuinely different point
// Anything else is the failure this gate exists to catch: a second thread restating a point
// somebody already made.
function unreconciledAgainstThreads(finding, threads) {
  if (finding.duplicateOf || finding.notDuplicate) return [];
  if (parseLocus(finding.locus).threadId) return [];
  return threadCollisions(finding.locus, threads);
}

// ---------- ledger / rounds stores ----------

// Repair the SHAPE of a persisted ledger so a legacy or truncated file degrades instead of
// crashing. A bare array of findings is the known pre-1.0 shape (report.js already tolerated it
// while readiness did not, so the same file both worked and 500'd depending on the route).
// `history` is normalized because the lifecycle code pushes onto it unconditionally.
function normalizeLedger(featureId, doc) {
  const base = Array.isArray(doc)
    ? { featureId, findings: doc }
    : (doc && typeof doc === 'object' ? { ...doc, featureId: doc.featureId || featureId } : { featureId, findings: [] });
  base.findings = Array.isArray(base.findings)
    ? base.findings.filter((f) => f && typeof f === 'object' && !Array.isArray(f))
    : [];
  for (const f of base.findings) {
    if (!Array.isArray(f.history)) f.history = [];
  }
  return base;
}

function loadLedger(featureId) {
  if (!fs.existsSync(ledgerPath(featureId))) return { featureId, findings: [] };
  return normalizeLedger(featureId, readJson(ledgerPath(featureId)));
}

function loadRounds(featureId) {
  if (!fs.existsSync(roundsPath(featureId))) return { featureId, rounds: [] };
  const doc = readJson(roundsPath(featureId));
  const base = doc && typeof doc === 'object' && !Array.isArray(doc)
    ? { ...doc, featureId: doc.featureId || featureId }
    : { featureId, rounds: Array.isArray(doc) ? doc : [] };
  if (!Array.isArray(base.rounds)) base.rounds = [];
  return base;
}

function saveLedger(ledger) { writeJson(ledgerPath(ledger.featureId), ledger); }
function saveRounds(rounds) { writeJson(roundsPath(rounds.featureId), rounds); }

// ---------- fingerprint ----------

function normalizeTitleForFp(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')   // strip punctuation, keep a-z0-9 and whitespace
    .replace(/\s+/g, ' ')          // collapse whitespace
    .trim();
}

function hashFp(featureId, dimension, normTitle, locus) {
  return crypto.createHash('sha1')
    .update(`${featureId}|${dimension}|${normTitle}|${locus}`)
    .digest('hex')
    .slice(0, 10);
}

// The finding's stable identity across audit rounds. The FULL normalized title is hashed: the
// title used to be truncated to 80 characters first, so two genuinely different findings sharing
// a dimension, a locus and an 80-character prefix — routine for audit titles — collided, and
// ingest silently dropped the second one with no warning and no trace in the round stats.
function fingerprint(featureId, dimension, title, locus) {
  return hashFp(featureId, dimension, normalizeTitleForFp(title), locus);
}

// The pre-fix fingerprint (title truncated at 80 chars). Kept ONLY so ingest can recognise a
// finding already on disk under its old id and carry it forward instead of treating it as new and
// auto-resolving the original. See migrateLegacyFp.
function legacyFingerprint(featureId, dimension, title, locus) {
  return hashFp(featureId, dimension, normalizeTitleForFp(title).slice(0, 80), locus);
}

// ---------- validation ----------

function validateIngestFinding(f) {
  const config = loadConfig();
  if (!f || typeof f !== 'object') throw euser('finding must be an object');
  if (!config.dimensions.includes(f.dimension)) {
    throw euser(`invalid dimension "${f.dimension}": must be one of ${config.dimensions.join(', ')}`);
  }
  if (!SEVERITIES.includes(f.severity)) {
    throw euser(`invalid severity "${f.severity}": must be one of ${SEVERITIES.join(', ')}`);
  }
  if (typeof f.title !== 'string' || f.title.trim() === '') throw euser('finding title is required');
  if (typeof f.locus !== 'string' || f.locus.trim() === '') throw euser('finding locus is required');
  for (const opt of ['detail', 'suggestion']) {
    if (f[opt] !== undefined && f[opt] !== null && typeof f[opt] !== 'string') {
      throw euser(`finding ${opt} must be a string when provided`);
    }
  }
  if (f.duplicateOf !== undefined && f.duplicateOf !== null) {
    validateDuplicateOf(f.duplicateOf);
  }
  // The escape hatch from the thread-collision gate: a stated reason why this finding is a
  // different point from the thread it happens to land near. Non-empty on purpose — "true"
  // would let the gate be silenced without anyone saying anything.
  if (f.notDuplicate !== undefined && f.notDuplicate !== null) {
    if (typeof f.notDuplicate !== 'string' || f.notDuplicate.trim() === '') {
      throw euser('notDuplicate must be a non-empty string explaining why this is a different point');
    }
  }
  return f;
}

// A finding can mark itself as a duplicate of an already-raised comment/finding, so the UI
// can badge it and the posted reply can be a cross-reference instead of a second answer.
// Shape: { label: "Oriol on OktaErrorHelper.cs:39", url?: <deep link>, threadId?: <n>, fp?: <fp> }.
function validateDuplicateOf(d) {
  if (typeof d !== 'object' || Array.isArray(d)) throw euser('duplicateOf must be an object');
  if (typeof d.label !== 'string' || d.label.trim() === '') throw euser('duplicateOf.label is required (e.g. "Oriol on file.cs:39")');
  for (const opt of ['url', 'fp']) {
    if (d[opt] !== undefined && d[opt] !== null && typeof d[opt] !== 'string') {
      throw euser(`duplicateOf.${opt} must be a string when provided`);
    }
  }
  return d;
}

// ---------- readiness ----------

function isOpen(finding) {
  return finding.status === 'open' || finding.status === 'reworking';
}

// A finding is "posted" once its comment/reply has been sent back to the PR: it stays
// `reworking` (so reconciliation still auto-resolves it once the author addresses it) but
// carries a `postedAt` stamp. From the reviewer's side the work is done — it's awaiting the
// author — so it sits in its own "Posted" lane and does NOT drag the readiness score down.
function isPosted(finding) {
  return Boolean(finding.postedAt) && isOpen(finding);
}

// Spec mirror of isPosted: a finding whose accepted change has actually been written back to
// Confluence/ADO carries an `appliedAt` stamp. It stays `reworking` (so a re-audit auto-resolves
// it once the spec genuinely reflects the fix) but sits in the "Applied — awaiting re-audit" lane
// and, like posted, does not drag readiness down — the reviewer's work is out.
function isApplied(finding) {
  return Boolean(finding.appliedAt) && isOpen(finding);
}

// Transient: the user clicked Post/Apply and the runner is mid-flight. `pending` is 'post' | 'apply'.
// Set on confirm, cleared the moment the runner stamps postedAt/appliedAt (or on error / reopen).
// Only meaningful while the finding is still open/reworking and NOT yet stamped done.
function isPending(finding) {
  return Boolean(finding.pending) && isOpen(finding) && !finding.postedAt && !finding.appliedAt;
}

function computeReadiness(ledger, config) {
  // Posted / applied / in-flight findings are out of the reviewer's hands (awaiting the author,
  // awaiting re-audit, or mid write-back), not open work — so they don't penalize the score, but
  // they remain `isOpen` for reconciliation's auto-resolve.
  // Tolerates a legacy bare-array ledger and a doc with no findings — this is reached from the
  // report and every readiness call, so a malformed file must degrade, not throw.
  const all = Array.isArray(ledger) ? ledger : (Array.isArray(ledger?.findings) ? ledger.findings : []);
  const open = all.filter((f) => f && isOpen(f) && !isPosted(f) && !isApplied(f) && !isPending(f));
  const openBySeverity = { blocker: 0, major: 0, minor: 0, info: 0 };
  let penalty = 0;
  for (const f of open) {
    if (!SEVERITIES.includes(f.severity)) continue;   // hand-edited severity: don't crash the score
    openBySeverity[f.severity] += 1;
    penalty += config.severityWeights[f.severity] ?? DEFAULT_CONFIG.severityWeights[f.severity] ?? 0;
  }
  // Normalized against a configured penalty ceiling, not a hardcoded one: scaling severityWeights
  // without scaling this would collapse every score to 0 and silently redefine readyThreshold.
  const fullScale = config.gates.scoreZeroAtPenalty || DEFAULT_CONFIG.gates.scoreZeroAtPenalty;
  const score = Math.max(0, Math.round(100 - (penalty * 100) / fullScale));
  const blockers = open.filter((f) => f.severity === 'blocker');
  let gate;
  if (config.gates.blockerOpenMeansNotReady && blockers.length > 0) gate = 'not-ready';
  else if (score >= config.gates.readyThreshold && blockers.length === 0) gate = 'ready';
  else gate = 'in-progress';
  return { score, gate, openBySeverity, openCount: open.length, blockers };
}

function readiness(featureId) {
  getFeature(featureId); // EUSER if missing
  return computeReadiness(loadLedger(featureId), loadConfig());
}

// ---------- ingest / reconciliation ----------

// A round's SCOPE: which of the workspace's existing findings this pass actually re-checked.
// null (the default) means a full sweep — anything absent was genuinely fixed, so it auto-resolves.
// A partial pass MUST say so, because auto-resolve is otherwise indiscriminate: a re-review scoped
// to one area would close every finding outside it and flip the readiness gate green.
function normalizeScope(scope) {
  if (scope === null || scope === undefined) return null;
  if (typeof scope !== 'object' || Array.isArray(scope)) {
    throw euser('scope must be an object like { fps: [...] } or { dimensions: [...] }');
  }
  const out = {};
  const strList = (v, label) => {
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x.trim() === '')) {
      throw euser(`scope.${label} must be an array of non-empty strings`);
    }
    return v.map((s) => s.trim());
  };
  if (scope.fps !== undefined && scope.fps !== null) out.fps = strList(scope.fps, 'fps');
  if (scope.dimensions !== undefined && scope.dimensions !== null) {
    out.dimensions = strList(scope.dimensions, 'dimensions');
  }
  if (!out.fps && !out.dimensions) throw euser('scope must name "fps" or "dimensions"');
  return out;
}

function inScope(finding, scope) {
  if (!scope) return true;
  if (scope.fps && scope.fps.includes(finding.fp)) return true;
  if (scope.dimensions && scope.dimensions.includes(finding.dimension)) return true;
  return false;
}

function ingestRound(featureId, findings, { note = '', reopenResolved = false, trigger = 'audit', scope = null } = {}) {
  const feature = getFeature(featureId); // EUSER if missing
  if (!Array.isArray(findings)) throw euser('findings must be an array');
  findings.forEach(validateIngestFinding);
  assertReconciledAgainstPriorThreads(feature, findings);
  const normScope = normalizeScope(scope);

  const config = loadConfig();
  return withFileLock(ledgerPath(featureId), () => ingestRoundLocked(featureId, findings, {
    note, reopenResolved, trigger, scope: normScope, config,
  }));
}

// The duplicate-comment gate. Until now "don't restate what another reviewer already said" was
// only an instruction in the review skill, and the failure mode was invisible: a finding the
// review DROPPED as a duplicate showed up in the run summary, but one it simply never noticed
// looked exactly like an ordinary finding. This makes both halves of that check structural —
// you cannot ingest a PR review without having fetched the PR's threads, and you cannot ingest
// a finding sitting on an existing thread without saying what it is relative to that thread.
// Spec workspaces are unaffected: they have no PR comments to collide with.
function assertReconciledAgainstPriorThreads(feature, findings) {
  if (!PR_KINDS.includes(feature.kind)) return;
  if (feature.priorThreads === null) {
    throw euser(
      `workspace "${feature.id}" is a ${feature.kind} but its existing PR comment threads were never recorded — `
      + 'fetch them with repo_get_pull_request_threads and register them '
      + `("flowlever threads set ${feature.id} --file <json>", or --none if the PR genuinely has no comments) `
      + 'before ingesting. Without them a review cannot tell which points other reviewers already made.',
    );
  }
  const threads = feature.priorThreads.threads;
  if (threads.length === 0) return;
  const clashes = [];
  for (const f of findings) {
    for (const t of unreconciledAgainstThreads(f, threads)) {
      clashes.push(`  "${f.title}" (${f.locus})\n    already covered by ${t.author} on thread ${t.threadId}${t.locus ? ` (${t.locus})` : ''}`);
    }
  }
  if (clashes.length === 0) return;
  throw euser(
    `${clashes.length} finding(s) land on PR comment threads that already exist:\n${clashes.join('\n')}\n`
    + 'For each one, either drop it, or say what it is relative to that thread: set `duplicateOf` to keep it '
    + 'visible as a cross-reference, use locus `pr:<id>:thread:<threadId>` to post it as a reply that adds only '
    + 'the increment, or set `notDuplicate: "<why this is a different point>"` if it genuinely is one.',
  );
}

function ingestRoundLocked(featureId, findings, { note, reopenResolved, trigger, scope, config }) {
  const ledger = loadLedger(featureId);
  const rounds = loadRounds(featureId);
  // The round number is derived from BOTH stores. The ledger and the rounds file are two separate
  // writes, so if the second one fails the ledger already carries the mutation for round n while
  // the rounds file never recorded it — taking `rounds.length + 1` alone would then hand the next
  // ingest the same n, and `firstSeenRound`/`resolvedInRound` would point at a round whose stats
  // describe a different pass. Taking the max of the two makes reuse impossible either way.
  const n = Math.max(rounds.rounds.length, Number(ledger.lastRound) || 0) + 1;
  const at = now();
  const byFp = new Map(ledger.findings.map((f) => [f.fp, f]));

  const stats = {
    new: 0, stillOpen: 0, autoResolved: 0, regressions: 0, totalOpen: 0,
    // Honest bookkeeping for the things ingest used to do silently.
    duplicatesInBatch: 0, outOfScopeSkipped: 0, migratedFps: 0,
  };
  const seenFps = new Set();
  const adoptedLegacy = new Set();

  for (const incoming of findings) {
    const fp = fingerprint(featureId, incoming.dimension, incoming.title, incoming.locus);
    if (seenFps.has(fp)) {
      // Genuinely the same finding twice in one batch (same dimension, locus and full title).
      // Counted rather than dropped in silence.
      stats.duplicatesInBatch += 1;
      continue;
    }
    seenFps.add(fp);
    let existing = byFp.get(fp);

    // Carry forward a finding stored under the pre-fix (80-char-truncated) fingerprint, so
    // upgrading does not orphan long-titled findings — which would auto-resolve the original and
    // re-insert it as new, losing its history, pins and decisions.
    if (!existing) {
      const legacy = legacyFingerprint(featureId, incoming.dimension, incoming.title, incoming.locus);
      const old = legacy !== fp && !adoptedLegacy.has(legacy) ? byFp.get(legacy) : undefined;
      if (old) {
        adoptedLegacy.add(legacy);
        old.fp = fp;
        old.history.push({ at, from: old.status, to: old.status, by: 'migrate', note: `fingerprint migrated from ${legacy}` });
        byFp.delete(legacy);
        byFp.set(fp, old);
        existing = old;
        stats.migratedFps += 1;
      }
    }

    if (!existing) {
      const finding = {
        fp,
        dimension: incoming.dimension,
        severity: incoming.severity,
        title: incoming.title,
        detail: incoming.detail ?? '',
        locus: incoming.locus,
        suggestion: incoming.suggestion ?? '',
        duplicateOf: incoming.duplicateOf ?? null,
        notDuplicate: incoming.notDuplicate ?? null,
        status: 'open',
        statusReason: null,
        pinned: false,
        firstSeenRound: n,
        lastSeenRound: n,
        resolvedInRound: null,
        createdAt: at,
        updatedAt: at,
        history: [],
      };
      ledger.findings.push(finding);
      byFp.set(fp, finding);
      stats.new += 1;
    } else if (isOpen(existing)) {
      existing.lastSeenRound = n;
      existing.detail = incoming.detail ?? existing.detail;
      existing.suggestion = incoming.suggestion ?? existing.suggestion;
      existing.duplicateOf = incoming.duplicateOf ?? existing.duplicateOf ?? null;
      existing.notDuplicate = incoming.notDuplicate ?? existing.notDuplicate ?? null;
      existing.updatedAt = at;
      stats.stillOpen += 1;
    } else {
      // resolved/waived re-flagged → regression
      stats.regressions += 1;
      if (reopenResolved) {
        existing.history.push({ at, from: existing.status, to: 'open', by: 'reconcile', note: `re-flagged in round ${n}` });
        existing.status = 'open';
        existing.statusReason = null;
        existing.resolvedInRound = null;
        existing.lastSeenRound = n;
        existing.detail = incoming.detail ?? existing.detail;
        existing.suggestion = incoming.suggestion ?? existing.suggestion;
        existing.updatedAt = at;
      }
      // else: stays closed, regression logged in round stats only
    }
  }

  // Auto-resolve open findings absent from this round, unless pinned — or unless this round only
  // covered part of the workspace, in which case an absent finding outside the scope was never
  // looked at and must be left exactly as it was.
  for (const finding of ledger.findings) {
    if (!isOpen(finding) || seenFps.has(finding.fp) || finding.pinned) continue;
    if (!inScope(finding, scope)) { stats.outOfScopeSkipped += 1; continue; }
    finding.history.push({ at, from: finding.status, to: 'resolved', by: 'reconcile', note: `not flagged in round ${n}` });
    finding.status = 'resolved';
    finding.statusReason = null;
    finding.resolvedInRound = n;
    finding.updatedAt = at;
    stats.autoResolved += 1;
  }

  stats.totalOpen = ledger.findings.filter(isOpen).length;

  const r = computeReadiness(ledger, config);
  const round = {
    n,
    at,
    trigger,
    stats,
    readiness: { score: r.score, gate: r.gate, openBySeverity: r.openBySeverity },
    note,
    // Recorded so the trail shows a partial pass as partial rather than looking like a full sweep.
    scope: scope || null,
  };
  rounds.rounds.push(round);

  // Ledger first, stamped with the round it now reflects (see the `n` derivation above).
  ledger.lastRound = n;
  saveLedger(ledger);
  saveRounds(rounds);
  return { round, stats };
}

// ---------- finding lifecycle ----------

// `keepDecision` is for WORKFLOW transitions (queueing a post/apply, a runner advancing a finding)
// as opposed to a user re-triaging it. A plain status change supersedes the reviewer's pending
// approve/edit — but the finish screen's "mark these in-flight" is not a re-triage, and clearing
// the decision there sent every suggestion-only finding back to Undecided and left the export
// reading "No applicable changes", destroying the triage the reviewer had just done.
function setFindingStatus(featureId, fp, { status, reason = null, pinned, by = 'user', keepDecision = false } = {}) {
  return mutateLedger(featureId, (ledger) => setFindingStatusIn(ledger, featureId, fp, { status, reason, pinned, by, keepDecision }));
}

function setFindingStatusIn(ledger, featureId, fp, { status, reason = null, pinned, by = 'user', keepDecision = false }) {
  const finding = ledger.findings.find((f) => f.fp === fp);
  if (!finding) throw euser(`finding "${fp}" not found in ledger for "${featureId}"`);

  const at = now();
  if (pinned !== undefined) finding.pinned = Boolean(pinned);

  if (status !== undefined && status !== finding.status) {
    if (!STATUSES.includes(status)) {
      throw euser(`invalid status "${status}": must be one of ${STATUSES.join(', ')}`);
    }
    if (status === 'waived' && (typeof reason !== 'string' || reason.trim() === '')) {
      throw euser('waiving a finding requires a reason');
    }
    const from = finding.status;
    finding.history.push({ at, from, to: status, by, note: reason ?? '' });
    finding.status = status;
    finding.statusReason = status === 'waived' ? reason : reason ?? null;
    // A status change supersedes any pending triage decision (approve/edit) and any in-flight
    // post/apply marker — drop them. `agreedCodeFix` is deliberately NOT dropped: it is the
    // durable record that the reviewer signed off a code change, and the fix gate reads it. When
    // it was inferred from `decision` alone, moving a finding's status disarmed the gate AND
    // erased the evidence `unbackedFixes` needs, so the audit built to catch an unbacked fix
    // reported clean on exactly the case it exists for.
    if (!keepDecision) delete finding.decision;
    delete finding.pending;
    // Reopening a posted/applied finding pulls it back into the review flow, so drop the stamps.
    if (status === 'open') { delete finding.postedAt; delete finding.appliedAt; }
    if (isOpen(finding)) {
      finding.resolvedInRound = null; // reopening clears the resolution round
    } else if (status === 'resolved') {
      // Same rule as the round number itself: take whichever store knows about more rounds, so a
      // torn rounds write can't make this point at the wrong pass.
      finding.resolvedInRound = Math.max(
        loadRounds(featureId).rounds.length,
        Number(ledger.lastRound) || 0,
      ) || null;
    }
  }

  finding.updatedAt = at;
  return finding;
}

// ---------- the fix gate: a claimed code fix must point at a real pushed commit ----------

// Does this finding represent a CODE CHANGE the author agreed to make (as opposed to a comment,
// a reply, or a suggestion handed to someone else)? True when it carries a before→after draft that
// actually changes something AND the reviewer signed that change off — either via the finding-level
// decision (`edit` = fix + reply, `fix-only` = fix, no reply) or by accepting/editing its hunks in
// the diff. The hunk path matters: going straight from per-hunk Accept to Post never sets the
// finding-level `decision`, so keying off `decision` alone would leave the commonest case ungated.
// `redirect`/`reject` verdicts are excluded — those are explicitly "don't apply this".
// `agreedCodeFix` is the DURABLE half of that sign-off, stamped by setFindingDecision and never
// cleared by a status change — only by explicitly undoing the decision. Without it the gate keyed
// solely off the transient `decision`, so any status change (including the cockpit's own
// "mark in-flight") silently un-gated the finding.
const AGREE_DECISIONS = ['edit', 'fix-only'];

function isAgreedCodeFix(finding) {
  const d = finding.draft;
  const review = (d && d.review) || {};
  // An explicit "don't apply this" retracts the agreement whatever else is set.
  if (review.verdict === 'redirect' || review.verdict === 'reject') return false;
  // The durable marker stands ALONE, deliberately. Keying off the draft first meant clearing or
  // re-drafting the proposal (a normal UI action) disarmed the gate AND blinded unbackedFixes —
  // the same "told it was fixed with nothing on the branch" outcome as the original defect, reached
  // through a different lever. Retracting an agreement is setFindingDecision(null), nothing else.
  if (AGREE_DECISIONS.includes(finding.agreedCodeFix)) return true;
  if (!d || typeof d.after !== 'string' || d.after === d.before) return false;
  if (AGREE_DECISIONS.includes(finding.decision)) return true;
  return Object.values(review.hunks || {}).some((h) => h && (h.status === 'accepted' || h.status === 'edited'));
}

// THE GATE. Marking a `pr-respond` finding done means telling the reviewer their point is handled.
// When the agreed response is a code change, calling it "handled" should mean the change is actually
// on the branch — so stamping it REQUIRES the sha of the pushed commit that carries it. That sha is
// recorded and shape-checked, NOT verified against the repository (see isValidSha): this makes a
// false claim cost a deliberate fabrication rather than a silence, which is a different thing from
// making it impossible.
//
// This exists because nothing used to tie a finding to the commit that fixed it, so a delivered fix
// and a missing one looked identical in the ledger. An audit found 11 findings across 5 workspaces
// closed as handled with no commit on file, and answering "did this actually ship?" took a
// commit-by-commit read of the repo — which is exactly the kind of question that gets answered
// confidently and wrongly. Prose in the skill ("apply, verify, commit, push, then reply") can be
// skipped while the reply still succeeds; a required sha cannot. No sha, no stamp, hard error, and
// the finding stays in the queue where the user can see it.
//
// A finding with an existing fixCommit passes (idempotent re-stamp). Comment/reply-only findings
// (no agreed code change) are unaffected — a reply IS the whole deliverable there.
// Only a `pr-respond` workspace owes a git commit (see owesGitCommit). A `spec` workspace's drafts
// are Confluence/ADO edits whose proof of delivery is `appliedAt` (markApplied), so demanding a sha
// there would be nonsense.
// Unknown/unreadable kind fails CLOSED (gate on) — the cost of an extra required flag is a moment's
// friction; the cost of a missed gate is a reviewer told a lie.
// ONLY `pr-respond` owes a git commit — that is the workflow where you are the PR author acting on
// a reviewer's point, so "handled" means the change is on your branch.
//
// It used to be `kind !== 'spec'`, which swept in `pr-review`: there you are reviewing SOMEONE
// ELSE'S pull request, and a finding carrying a suggested before→after diff is a comment, not work
// you are going to commit. Demanding a sha there blocked posting a review comment, and because the
// agreement marker is now durable there was no longer an accidental way out — the finding stranded
// in "Posting…". A `spec` workspace proves delivery with appliedAt, as before.
// Unknown AND unreadable kinds both fail CLOSED — an unrecognised kind is a real unknown, and a
// spurious required flag is cheaper than a reviewer told a fix shipped when it did not. Testing for
// `=== 'pr-respond'` alone silently un-gated any hand-edited or future kind, which is the opposite
// of what this comment claimed.
function owesGitCommit(featureId) {
  try {
    const kind = getFeature(featureId).kind || 'spec';
    if (kind === 'pr-respond') return true;
    return !KINDS.includes(kind);
  } catch {
    return true;
  }
}

// A git sha, not merely a non-empty string. The gate used to accept anything truthy, so posting
// over HTTP with sha="lol-no-commit" satisfied it and wrote that value into the trail verbatim —
// the CLI validated the shape but the API did not, which is the path the cockpit actually uses.
//
// LIMIT, and it matters: this checks the SHAPE only. The ledger has no repository to ask, so a
// well-formed invention like "deadbeef" passes and then reads as a delivered fix (unbackedFixes
// returns clean for it). The gate raises the cost of claiming a fix that was never made from
// "say nothing" to "fabricate a plausible sha"; it does not make it impossible. Verifying the
// commit exists needs a repo context — `git cat-file -e <sha>` in the right checkout — which
// belongs to the caller that has one, not here.
const SHA_RE = /^[0-9a-f]{7,40}$/i;

function isValidSha(sha) {
  return typeof sha === 'string' && SHA_RE.test(sha.trim());
}

function assertFixCommit(featureId, finding, sha) {
  if (!isAgreedCodeFix(finding)) return;
  if (!owesGitCommit(featureId)) return;
  if (finding.fixCommit && finding.fixCommit.sha) return;
  if (isValidSha(sha)) return;
  if (typeof sha === 'string' && sha.trim()) {
    throw euser(`invalid commit sha "${sha}": expected a 7–40 character hex git sha`);
  }
  throw euser(
    `finding "${finding.fp}" is an agreed code fix (${(finding.draft && finding.draft.target) || finding.locus}) — `
    + 'it cannot be marked posted without the commit that carries it. Apply the change, commit and '
    + 'push it, then pass --sha <pushed commit sha> — the sha is recorded and checked for shape, not '
    + 'verified against the repository, so it is on you that it is real. If the fix was NOT made, run '
    + `\`finding cancel ${featureId} --fps ${finding.fp}\` instead — never reply claiming a fix that isn't on the branch.`);
}

// Record the pushed commit a fix landed in. Kept separate from the posted stamp so the trail shows
// the code went out before (or without) any comment about it.
function setFindingFixCommit(featureId, fp, { sha, repo = null, branch = null, by = 'apply' } = {}) {
  if (!isValidSha(sha)) {
    throw euser(`invalid commit sha "${sha}": expected a 7–40 character hex git sha`);
  }
  return mutateLedger(featureId, (ledger) => {
    const finding = ledger.findings.find((f) => f.fp === fp);
    if (!finding) throw euser(`finding "${fp}" not found in ledger for "${featureId}"`);
    const at = now();
    finding.fixCommit = { sha: sha.trim(), repo, branch, at };
    finding.history.push({ at, from: finding.status, to: finding.status, by, note: `fix pushed in ${sha.trim().slice(0, 10)}` });
    finding.updatedAt = at;
    return finding;
  });
}

// Findings whose agreed code fix is claimed done but points at no commit — i.e. someone said
// "handled" without the change being on the branch. The cockpit badges these and /flowlever:watch
// reports them; ideally always empty.
function unbackedFixes(featureId) {
  // Only the kinds that owe a commit can have an UNBACKED one: a spec workspace proves delivery with
  // appliedAt, and on a pr-review workspace a suggested diff is a comment for the PR's author to
  // commit, so there is no commit of yours that could be missing.
  if (!owesGitCommit(featureId)) return [];
  return (loadLedger(featureId).findings || []).filter((f) =>
    isAgreedCodeFix(f) && (f.postedAt || f.status === 'resolved')
    && !(f.fixCommit && f.fixCommit.sha) && !f.appliedAt);
}

// Mark findings as posted back to the PR (their inline comment / reply has been sent).
// A posted finding stays `reworking` — so a later re-review reconciliation auto-resolves it
// once the author addresses it — but gains a `postedAt` stamp that moves it into the
// "Posted — awaiting author" lane and excludes it from the readiness penalty and the
// "to review" count. Idempotent: re-posting refreshes the stamp without duplicating history.
// `fps` may be a single fp or an array. Returns the updated findings.
// `sha` (+ optional repo/branch) is the pushed commit carrying the code fix. It is REQUIRED for any
// finding whose agreed response is a code change (see assertFixCommit) and ignored for reply-only
// ones. Validated for the whole batch BEFORE anything is written, so a mixed batch can't half-apply.
// `detailed: true` returns { updated, skipped } instead of the bare updated array. The skipped
// list exists because these bulk operations pass over waived/resolved findings silently: the
// caller only saw a smaller count ("posted 5, updated 4") with no way to learn which one it was.
function markPosted(featureId, fps, { by = 'post', sha, repo = null, branch = null, detailed = false } = {}) {
  const list = Array.isArray(fps) ? fps : [fps];
  const at = now();
  const uniq = [...new Set(list)];
  const skipped = [];
  const result = mutateLedger(featureId, (ledger) => {
    // Gate first, write second: all-or-nothing.
    for (const fp of uniq) {
      const finding = ledger.findings.find((f) => f.fp === fp);
      if (!finding) throw euser(`finding "${fp}" not found in ledger for "${featureId}"`);
      if (finding.status === 'waived' || finding.status === 'resolved') continue;
      assertFixCommit(featureId, finding, sha);
    }
    const updated = [];
    for (const fp of uniq) {
      const finding = ledger.findings.find((f) => f.fp === fp);
      // Its own comment already said posting applies only to live findings, but it stamped
      // postedAt on closed ones anyway — moving a waived finding into the "awaiting author" lane.
      if (finding.status === 'waived' || finding.status === 'resolved') {
        skipped.push({ fp, reason: finding.status });
        continue;
      }
      // Record the commit on the findings that represent a code fix, so the trail (and the cockpit)
      // can point at the change itself rather than just at a comment about it.
      if (isValidSha(sha) && isAgreedCodeFix(finding) && !(finding.fixCommit && finding.fixCommit.sha)) {
        finding.fixCommit = { sha: sha.trim(), repo, branch, at };
        finding.history.push({ at, from: finding.status, to: finding.status, by, note: `fix pushed in ${sha.trim().slice(0, 10)}` });
      }
      if (finding.status === 'open') {
        finding.history.push({ at, from: 'open', to: 'reworking', by, note: 'posted to PR' });
        finding.status = 'reworking';
        finding.resolvedInRound = null;
      } else if (!finding.postedAt) {
        finding.history.push({ at, from: finding.status, to: finding.status, by, note: 'posted to PR' });
      }
      finding.postedAt = at;
      delete finding.decision;   // posting supersedes the pending approve/edit decision
      delete finding.pending;    // the in-flight "Posting…" marker is now resolved
      finding.updatedAt = at;
      updated.push(finding);
    }
    return updated;
  });
  // Posting (re)starts the wait on the author: anchor the "since" time and clear any prior
  // "author responded" flag. Best-effort — a missing feature file shouldn't fail the post.
  if (result.length) {
    try { setFeatureReview(featureId, { lastPostedAt: at, authorRespondedAt: null, note: null }); }
    catch { /* feature gone — ignore */ }
  }
  return detailed ? { updated: result, skipped } : result;
}

// Spec mirror of markPosted: the runner has actually written the accepted change back to
// Confluence/ADO. Stamp `appliedAt` (→ "Applied — awaiting re-audit" lane), keep it `reworking`
// so the next /flowlever:audit reconciles it (auto-resolves if the spec now reflects the fix,
// keeps it open if not). Clears the in-flight "Applying…" marker. Idempotent.
function markApplied(featureId, fps, { by = 'apply', detailed = false } = {}) {
  const list = Array.isArray(fps) ? fps : [fps];
  const at = now();
  const skipped = [];
  const updated = mutateLedger(featureId, (ledger) => markAppliedIn(ledger, featureId, [...new Set(list)], { by, at, skipped }));
  return detailed ? { updated, skipped } : updated;
}

function markAppliedIn(ledger, featureId, uniq, { by, at, skipped }) {
  const updated = [];
  for (const fp of uniq) {
    const finding = ledger.findings.find((f) => f.fp === fp);
    if (!finding) throw euser(`finding "${fp}" not found in ledger for "${featureId}"`);
    if (finding.status === 'waived' || finding.status === 'resolved') {
      // Not awaiting anything — recorded so the caller can say WHICH items it passed over.
      skipped.push({ fp, reason: finding.status });
      continue;
    }
    if (finding.status === 'open') {
      finding.history.push({ at, from: 'open', to: 'reworking', by, note: 'applied to spec' });
      finding.status = 'reworking';
      finding.resolvedInRound = null;
    } else if (!finding.appliedAt) {
      finding.history.push({ at, from: finding.status, to: finding.status, by, note: 'applied to spec' });
    }
    finding.appliedAt = at;
    delete finding.decision;
    delete finding.pending;
    finding.updatedAt = at;
    updated.push(finding);
  }
  return updated;
}

// Set the transient in-flight marker when the user confirms Post/Apply: the finding leaves the
// reviewer's queue and shows in the "Posting…/Applying…" lane until the runner stamps it done
// (markPosted/markApplied) or it's reopened. An open finding moves to `reworking` so it's no
// longer counted as untriaged. `kind` is 'post' | 'apply'. `fps` may be a single fp or array.
const PENDING_KINDS = ['post', 'apply'];
function setFindingPending(featureId, fps, kind, { by = 'user', detailed = false } = {}) {
  if (!PENDING_KINDS.includes(kind)) {
    throw euser(`invalid pending kind "${kind}": must be one of ${PENDING_KINDS.join(', ')}`);
  }
  const list = Array.isArray(fps) ? fps : [fps];
  const at = now();
  const skipped = [];
  const updated = mutateLedger(featureId, (ledger) => {
    const out = [];
    for (const fp of [...new Set(list)]) {
      const finding = ledger.findings.find((f) => f.fp === fp);
      if (!finding) throw euser(`finding "${fp}" not found in ledger for "${featureId}"`);
      if (finding.status === 'waived' || finding.status === 'resolved') {
        skipped.push({ fp, reason: finding.status });
        continue;
      }
      if (finding.status === 'open') {
        finding.history.push({ at, from: 'open', to: 'reworking', by, note: `queued for ${kind}` });
        finding.status = 'reworking';
        finding.resolvedInRound = null;
      }
      finding.pending = kind;
      finding.updatedAt = at;
      out.push(finding);
    }
    return out;
  });
  return detailed ? { updated, skipped } : updated;
}

// Undo setFindingPending: drop the transient "Posting…/Applying…" marker WITHOUT claiming the
// write happened. Needed because a pending marker is otherwise a dead end — if the runner never
// picks the job up, dies mid-flight, or fails, the finding is stranded in the in-flight lane
// forever (excluded from the review queue AND never stamped posted/applied).
// Two callers: the cockpit's "Cancel post" on a stuck job, and the runner's error path.
// The finding returns to `reworking` with its triage intact, so it lands back in the post queue.
// Findings already stamped postedAt/appliedAt are left alone — that write really did happen.
// `fps` may be a single fp or an array; unknown fps throw. Returns the findings it changed.
function clearFindingPending(featureId, fps, { by = 'user', reason = '' } = {}) {
  const list = Array.isArray(fps) ? fps : [fps];
  const at = now();
  return mutateLedger(featureId, (ledger) => {
    const updated = [];
    for (const fp of [...new Set(list)]) {
      const finding = ledger.findings.find((f) => f.fp === fp);
      if (!finding) throw euser(`finding "${fp}" not found in ledger for "${featureId}"`);
      if (!finding.pending) continue;                     // nothing in flight — no-op
      if (finding.postedAt || finding.appliedAt) { delete finding.pending; updated.push(finding); continue; }
      const kind = finding.pending;
      delete finding.pending;
      finding.history.push({ at, from: finding.status, to: finding.status, by, note: reason || `cancelled queued ${kind}` });
      finding.updatedAt = at;
      updated.push(finding);
    }
    return updated;
  });
}

// Every finding of a workspace currently sitting in the in-flight lane — what a "cancel the
// stuck post/apply" action operates on when the caller doesn't name specific fps.
function pendingFindings(featureId) {
  return (loadLedger(featureId).findings || []).filter(isPending);
}

// The reviewer's triage decision on a PR comment that hasn't been posted yet:
// `approve` / `edit` mean "will post on the next Post" (the finding stays open/reworking);
// a dismiss is modelled by the `waived` status instead, not here. Persisting the decision
// (rather than holding it only in the browser's review flow) is what keeps the board, the
// stepper and the Post screen in sync and makes a decision survive a page refresh.
//
// `fix-only` (pr-respond) = **apply the code fix and post NO reply.** The runner commits and
// pushes the fix, then resolves the reviewer's thread by setting its ADO status to `Fixed`
// rather than writing a comment. Resolving matters: a thread left Active whose newest comment
// is still the reviewer's would be re-detected as "awaiting your reply" on every later sweep,
// so the item would come back forever. It's a distinct decision, not a flavour of `edit`,
// because the runner must know NOT to reply.
// Pass null to clear the decision (undo). Returns the finding.
const FINDING_DECISIONS = ['approve', 'edit', 'fix-only'];
function setFindingDecision(featureId, fp, decision, { by = 'user' } = {}) {
  if (decision !== null && !FINDING_DECISIONS.includes(decision)) {
    throw euser(`invalid decision "${decision}": must be one of ${FINDING_DECISIONS.join(', ')} or null`);
  }
  return mutateLedger(featureId, (ledger) => {
    const finding = ledger.findings.find((f) => f.fp === fp);
    if (!finding) throw euser(`finding "${fp}" not found in ledger for "${featureId}"`);
    const at = now();
    if (decision === null) {
      // An explicit undo is the ONLY thing that retracts the durable code-fix agreement.
      const had = finding.decision !== undefined || finding.agreedCodeFix !== undefined;
      if (!had) return finding;
      delete finding.decision;
      delete finding.agreedCodeFix;
      finding.history.push({ at, from: finding.status, to: finding.status, by, note: 'cleared decision' });
    } else if (finding.decision !== decision) {
      finding.decision = decision;
      // Durable record of "the reviewer signed off a code change here", so the fix gate and the
      // unbacked-fix audit survive the status changes that clear the transient decision.
      if (AGREE_DECISIONS.includes(decision)) finding.agreedCodeFix = decision;
      finding.history.push({ at, from: finding.status, to: finding.status, by, note: `decided: ${decision}` });
    } else {
      return finding;   // unchanged
    }
    finding.updatedAt = at;
    return finding;
  });
}

// The reviewer's free-text NOTE on a finding (distinct from the audit `suggestion` and from a
// draft's counter-note): what they object to, their answer to a clarifying question, or context for
// whoever actions it. Lives on the finding so suggestion-only items (no code-diff draft) can still
// carry a reviewer response. Pass '' to clear. Surfaced in the card + the exported work order.
function setFindingNote(featureId, fp, note, { by = 'user' } = {}) {
  return mutateLedger(featureId, (ledger) => {
    const finding = ledger.findings.find((f) => f.fp === fp);
    if (!finding) throw euser(`finding "${fp}" not found in ledger for "${featureId}"`);
    const next = typeof note === 'string' ? note : '';
    if ((finding.note || '') === next) return finding;
    const at = now();
    if (next.trim()) finding.note = next; else delete finding.note;
    finding.history.push({ at, from: finding.status, to: finding.status, by, note: next.trim() ? 'reviewer note' : 'cleared note' });
    finding.updatedAt = at;
    return finding;
  });
}

// Refine a finding's descriptive text without touching its identity. title, locus and
// dimension feed the fingerprint, so they are intentionally NOT editable here — changing
// them would create a different finding. detail/suggestion/severity can be corrected as
// understanding improves during refinement; a history entry records the refinement.
function setFindingDetails(featureId, fp, { detail, suggestion, severity, duplicateOf, by = 'user', note = '' } = {}) {
  if (severity !== undefined && !SEVERITIES.includes(severity)) {
    throw euser(`invalid severity "${severity}": must be one of ${SEVERITIES.join(', ')}`);
  }
  if (duplicateOf !== undefined && duplicateOf !== null) validateDuplicateOf(duplicateOf);
  if (detail === undefined && suggestion === undefined && severity === undefined && duplicateOf === undefined) {
    throw euser('nothing to refine: provide detail, suggestion, severity or duplicateOf');
  }

  return mutateLedger(featureId, (ledger) => {
    const finding = ledger.findings.find((f) => f.fp === fp);
    if (!finding) throw euser(`finding "${fp}" not found in ledger for "${featureId}"`);

    const at = now();
    const changed = [];
    if (detail !== undefined && detail !== finding.detail) { finding.detail = String(detail); changed.push('detail'); }
    if (suggestion !== undefined && suggestion !== finding.suggestion) { finding.suggestion = String(suggestion); changed.push('suggestion'); }
    if (duplicateOf !== undefined) { finding.duplicateOf = duplicateOf; changed.push(duplicateOf ? `marked duplicate of ${duplicateOf.label}` : 'duplicate mark cleared'); }
    if (severity !== undefined && severity !== finding.severity) {
      changed.push(`severity ${finding.severity}→${severity}`);
      finding.severity = severity;
    }
    if (changed.length) {
      finding.history.push({ at, from: finding.status, to: finding.status, by, note: note || `refined ${changed.join(', ')}` });
      finding.updatedAt = at;
    }
    return finding;
  });
}

// ---------- finding rework drafts ----------

// A draft is a proposed before→after change to the spec/ticket that fixes a finding,
// shown in the cockpit as a PR-style red/green diff before it is written back to the
// real source. It is purely descriptive: it does NOT touch the finding's identity
// fields (dimension/title/locus), so the fingerprint is unaffected. A history entry
// records the draft so the trail shows when a fix was proposed.
// A targetRef is the machine-addressable write target for a draft's surgical apply
// (distinct from `target`, the human-readable label). The spec proposer sets it so
// /flowlever:apply-spec knows exactly where to write — an ADO work-item field, or a
// Confluence page (optionally a section anchor + the version it was drafted against,
// so the writer can do optimistic-concurrency and patch one node instead of rewriting
// the whole page). Shape:
//   { system: 'ado',        adoId, field? }
//   { system: 'confluence', pageId, anchor?, version? }
// plus an optional `label`. Unknown/extra keys are dropped.
function normalizeTargetRef(ref) {
  if (typeof ref !== 'object' || ref === null) throw euser('targetRef must be an object');
  if (!TARGET_SYSTEMS.includes(ref.system)) {
    throw euser(`targetRef.system must be one of ${TARGET_SYSTEMS.join(', ')}`);
  }
  const out = { system: ref.system };
  if (ref.system === 'ado') {
    if (ref.adoId === undefined || ref.adoId === null || String(ref.adoId).trim() === '') {
      throw euser('targetRef for ado requires "adoId"');
    }
    out.adoId = typeof ref.adoId === 'number' ? ref.adoId : String(ref.adoId).trim();
    if (ref.field !== undefined && ref.field !== null) out.field = String(ref.field);
  } else {
    if (ref.pageId === undefined || ref.pageId === null || String(ref.pageId).trim() === '') {
      throw euser('targetRef for confluence requires "pageId"');
    }
    out.pageId = String(ref.pageId).trim();
    if (ref.anchor !== undefined && ref.anchor !== null) out.anchor = String(ref.anchor);
    if (ref.version !== undefined && ref.version !== null) {
      const v = Number(ref.version);
      if (!Number.isFinite(v)) throw euser('targetRef.version must be a number');
      out.version = v;
    }
  }
  if (ref.label !== undefined && ref.label !== null) out.label = String(ref.label);
  return out;
}

function setFindingDraft(featureId, fp, { target, targetRef, before, after, format = 'text', by = 'user' } = {}) {
  if (typeof before !== 'string' || typeof after !== 'string') {
    throw euser('a draft requires "before" and "after" strings');
  }
  if (!DRAFT_FORMATS.includes(format)) {
    throw euser(`invalid draft format "${format}": must be one of ${DRAFT_FORMATS.join(', ')}`);
  }

  return mutateLedger(featureId, (ledger) => {
    const finding = ledger.findings.find((f) => f.fp === fp);
    if (!finding) throw euser(`finding "${fp}" not found in ledger for "${featureId}"`);

    const at = now();
    const draft = {
      target: typeof target === 'string' && target.trim() ? target : finding.locus,
      format,
      before,
      after,
      updatedAt: at,
    };
    if (targetRef !== undefined && targetRef !== null) {
      draft.targetRef = normalizeTargetRef(targetRef);
    } else if (finding.draft && finding.draft.targetRef) {
      // Re-drafting the text only (e.g. an edited proposal) keeps the machine write target.
      draft.targetRef = finding.draft.targetRef;
    }
    finding.draft = draft;
    finding.history.push({ at, from: finding.status, to: finding.status, by, note: 'drafted change' });
    finding.updatedAt = at;
    return finding;
  });
}

function clearFindingDraft(featureId, fp, { by = 'user' } = {}) {
  return mutateLedger(featureId, (ledger) => {
    const finding = ledger.findings.find((f) => f.fp === fp);
    if (!finding) throw euser(`finding "${fp}" not found in ledger for "${featureId}"`);

    if (finding.draft) {
      const at = now();
      delete finding.draft;
      finding.history.push({ at, from: finding.status, to: finding.status, by, note: 'cleared draft' });
      finding.updatedAt = at;
    }
    return finding;
  });
}

// A draft review records the user's decisions on a rework draft so they can be
// exported as a work order for a coding agent. It lives under draft.review and,
// like the draft itself, never touches the finding's identity fields
// (dimension/title/locus) — the fingerprint is unaffected.
//
// Two LEVELS of decision live here, both merged into the existing review:
//   - PER-HUNK Accept/Reject/Edit: `review` carries a full object
//     `{ hunks: { "<idx>": { status, editedText? } } }` or a single-hunk patch
//     `{ hunk, status, editedText? }`. A status of 'undecided' (or null) clears
//     that hunk's decision.
//   - FINDING-LEVEL counter-proposal: an optional `note` (free text aimed at the
//     coding agent) and an optional `verdict` ('proposed' | 'redirect' | 'reject').
//     `redirect` = do it differently/elsewhere, see note; `reject` = don't do it
//     at all. These override the per-hunk proposal in the export.
// Any combination may be sent in one call; each field present is merged.
function setDraftReview(featureId, fp, review, { by = 'user' } = {}) {
  return mutateLedger(featureId, (ledger) => setDraftReviewIn(ledger, featureId, fp, review, { by }));
}

function setDraftReviewIn(ledger, featureId, fp, review, { by = 'user' } = {}) {
  const finding = ledger.findings.find((f) => f.fp === fp);
  if (!finding) throw euser(`finding "${fp}" not found in ledger for "${featureId}"`);
  if (!finding.draft) throw euser(`finding "${fp}" has no draft to review`);
  if (!review || typeof review !== 'object') throw euser('review must be an object');

  const hasHunkPatch = 'hunk' in review && review.hunk !== undefined && review.hunk !== null;
  const hasHunks = review.hunks && typeof review.hunks === 'object';
  const hasNote = 'note' in review;
  const hasVerdict = 'verdict' in review;
  if (!hasHunkPatch && !hasHunks && !hasNote && !hasVerdict) {
    throw euser('review must include "hunks", a single-hunk patch { hunk, status }, a note or a verdict');
  }

  const at = now();
  const prior = finding.draft.review || {};
  const merged = { ...(prior.hunks || {}) };

  if (hasHunkPatch || hasHunks) {
    const patches = hasHunkPatch
      ? { [String(review.hunk)]: { status: review.status, editedText: review.editedText } }
      : review.hunks;
    for (const [idx, hk] of Object.entries(patches)) {
      if (!hk || typeof hk !== 'object') throw euser(`hunk "${idx}" decision must be an object`);
      if (hk.status === 'undecided' || hk.status === null) { delete merged[String(idx)]; continue; }
      if (!REVIEW_STATUSES.includes(hk.status)) {
        throw euser(`invalid hunk status "${hk.status}": must be one of ${REVIEW_STATUSES.join(', ')}`);
      }
      if (hk.editedText !== undefined && hk.editedText !== null && typeof hk.editedText !== 'string') {
        throw euser('hunk editedText must be a string when provided');
      }
      if (hk.status === 'edited' && typeof hk.editedText !== 'string') {
        throw euser('an edited hunk requires editedText (string)');
      }
      const entry = { status: hk.status, at };
      if (hk.status === 'edited') entry.editedText = hk.editedText;
      merged[String(idx)] = entry;
    }
  }

  // Finding-level note + verdict (merge: keep prior value unless this call sets it).
  let note = prior.note ?? '';
  if (hasNote) {
    if (review.note !== null && review.note !== undefined && typeof review.note !== 'string') {
      throw euser('note must be a string when provided');
    }
    note = review.note == null ? '' : String(review.note);
  }
  let verdict = prior.verdict ?? 'proposed';
  if (hasVerdict) {
    if (review.verdict == null) {
      verdict = 'proposed';
    } else if (!REVIEW_VERDICTS.includes(review.verdict)) {
      throw euser(`invalid verdict "${review.verdict}": must be one of ${REVIEW_VERDICTS.join(', ')}`);
    } else {
      verdict = review.verdict;
    }
  }

  finding.draft.review = { hunks: merged, note, verdict, updatedAt: at };
  finding.draft.updatedAt = at;
  // A pure note/verdict change is a counter-proposal, not a per-hunk review.
  const histNote = (hasNote || hasVerdict) && !hasHunkPatch && !hasHunks ? 'reviewer note' : 'reviewed draft';
  finding.history.push({ at, from: finding.status, to: finding.status, by, note: histNote });
  finding.updatedAt = at;
  return finding;
}

// ---------- requests (UI-triggered job queue) ----------

// The queue file holds a monotonic counter alongside the requests, so ids are
// derived from the counter (req-1, req-2, …) — never from a clock. This keeps
// ids deterministic in tests and stable across reads.
function requestIdNumber(id) {
  const n = Number(String(id ?? '').replace(/^req-/, ''));
  return Number.isFinite(n) ? n : 0;
}

function loadRequests() {
  if (!fs.existsSync(requestsPath())) return { counter: 0, requests: [] };
  const doc = readJson(requestsPath());
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { counter: 0, requests: [] };
  if (!Array.isArray(doc.requests)) doc.requests = [];
  doc.requests = doc.requests.filter((r) => r && typeof r === 'object' && !Array.isArray(r));
  // The counter must never fall below the highest id ever issued. `requests.length` was the old
  // fallback, but deleteRequest splices without touching the counter, so after any deletion the
  // length is lower than the highest issued id — and the next enqueue would mint a duplicate id
  // that `find`/`findIndex` would then resolve to the WRONG request.
  const maxIssued = doc.requests.reduce((m, r) => Math.max(m, requestIdNumber(r.id)), 0);
  if (typeof doc.counter !== 'number' || !Number.isFinite(doc.counter) || doc.counter < maxIssued) {
    doc.counter = maxIssued;
  }
  return doc;
}

function saveRequests(doc) { writeJson(requestsPath(), doc); }

// Enqueue a job. `pr-review`/`pr-respond` target a PR (require prId); `apply`
// posts the reviewed output of an existing workspace (require wsId). Optional
// title is a human label shown on the queued card; optional `instructions` is
// free-text scope/focus for THAT run (e.g. "front-end only") the runner honors.
// `kind` narrows a `poll` (manual refresh) to one section; ignored for other actions.
function addRequest({ action, prId, wsId, title, instructions, kind } = {}) {
  if (!REQUEST_ACTIONS.includes(action)) {
    throw euser(`invalid action "${action}": must be one of ${REQUEST_ACTIONS.join(', ')}`);
  }
  if (kind !== undefined && kind !== null && String(kind).trim() !== '' && !REQUEST_KINDS.includes(kind)) {
    throw euser(`invalid kind "${kind}": must be one of ${REQUEST_KINDS.join(', ')}`);
  }
  if ((action === 'pr-review' || action === 'pr-respond') && (prId === undefined || prId === null || String(prId).trim() === '')) {
    throw euser(`${action} requires "prId"`);
  }
  if (WSID_REQUIRED_ACTIONS.includes(action) && (wsId === undefined || wsId === null || String(wsId).trim() === '')) {
    throw euser(`${action} requires "wsId"`);
  }
  // `audit` is either a NEW analysis (needs `instructions` = the spec/work-item/Figma URLs) or a
  // RE-AUDIT of an existing workspace (needs `wsId`; sources are already registered on it).
  if (action === 'audit'
    && (wsId === undefined || wsId === null || String(wsId).trim() === '')
    && (instructions === undefined || instructions === null || String(instructions).trim() === '')) {
    throw euser('audit requires "instructions" (URLs for a new analysis) or "wsId" (to re-audit an existing workspace)');
  }
  if (instructions !== undefined && instructions !== null && typeof instructions !== 'string') {
    throw euser('instructions must be a string when provided');
  }
  return mutateRequests((doc) => addRequestIn(doc, { action, prId, wsId, title, instructions, kind }));
}

function addRequestIn(doc, { action, prId, wsId, title, instructions, kind }) {
  doc.counter += 1;
  const ts = now();
  const request = {
    id: `req-${doc.counter}`,
    action,
    prId: prId === undefined || prId === null || String(prId).trim() === '' ? null : String(prId).trim(),
    wsId: wsId === undefined || wsId === null || String(wsId).trim() === '' ? null : String(wsId).trim(),
    // Section scope for a manual-refresh (`poll`) job; null = every PR kind.
    kind: kind === undefined || kind === null || String(kind).trim() === '' ? null : String(kind).trim(),
    title: typeof title === 'string' && title.trim() ? title.trim() : null,
    // Per-run scope/focus the runner honors (e.g. "front-end only"); null when omitted.
    instructions: typeof instructions === 'string' && instructions.trim() ? instructions.trim() : null,
    status: 'queued',
    // phase = short free-text label of the runner's current step (e.g. "fetching PR diff");
    // needsInput = the job is blocked waiting on the user (e.g. a 2FA/auth prompt), with the
    // human-facing instruction in `note`.
    phase: null,
    needsInput: false,
    note: null,
    createdAt: ts,
    updatedAt: ts,
  };
  doc.requests.push(request);
  return request;
}

function listRequests({ status } = {}) {
  let requests = loadRequests().requests;
  if (status !== undefined && status !== null && status !== '') {
    if (!REQUEST_STATUSES.includes(status)) {
      throw euser(`invalid status "${status}": must be one of ${REQUEST_STATUSES.join(', ')}`);
    }
    requests = requests.filter((r) => r.status === status);
  }
  return requests;
}

// Merge a status update onto a request. Only specified fields are touched, so the
// runner can advance `phase` without clobbering `note`, set `needsInput` on its own,
// etc. Reaching a terminal status (done/error) implicitly clears needsInput — a
// finished job is never still waiting on the user.
function setRequestStatus(id, { status, note, wsId, phase, needsInput } = {}) {
  if (status !== undefined && !REQUEST_STATUSES.includes(status)) {
    throw euser(`invalid status "${status}": must be one of ${REQUEST_STATUSES.join(', ')}`);
  }
  return mutateRequests((doc) => {
    const request = doc.requests.find((r) => r.id === id);
    if (!request) throw euser(`request "${id}" not found`);
    if (status !== undefined) request.status = status;
    if (note !== undefined) request.note = note === null || note === '' ? null : String(note);
    if (wsId !== undefined && wsId !== null && String(wsId).trim() !== '') request.wsId = String(wsId).trim();
    if (phase !== undefined) request.phase = phase === null || phase === '' ? null : String(phase);
    if (needsInput !== undefined) request.needsInput = Boolean(needsInput);
    // A terminal status is never "waiting on you".
    if (status === 'done' || status === 'error') request.needsInput = false;
    request.updatedAt = now();
    return request;
  });
}

// ---------- claiming work (the runner's exclusive take) ----------
//
// A runner used to do `listRequests({status:'queued'})` and then `setRequestStatus(id,'running')` —
// load, mutate, save, with nothing checking the status it thought it saw. Two runners (the
// scheduled /flowlever:poll and a cockpit-started watch) therefore both saw the same queued rows
// and both executed them, posting every PR comment twice. runner.js's in-memory `isRunning` cannot
// help: it is per-process.
//
// claimRequest is a compare-and-swap under the queue lock: it succeeds only if the request is
// STILL queued, so exactly one caller can win. A loser gets EUSER and moves on.
function claimRequest(id, { by = null, phase = null } = {}) {
  return mutateRequests((doc) => {
    const request = doc.requests.find((r) => r.id === id);
    if (!request) throw euser(`request "${id}" not found`);
    if (request.status !== 'queued') {
      throw euser(`request "${id}" is already "${request.status}" — another runner claimed it`);
    }
    request.status = 'running';
    request.claimedBy = by === null || by === '' ? null : String(by);
    request.claimedAt = now();
    if (phase !== undefined && phase !== null && phase !== '') request.phase = String(phase);
    request.updatedAt = request.claimedAt;
    return request;
  });
}

// Atomically take the OLDEST queued job (optionally filtered to certain actions) — the operation a
// runner actually wants, since it removes the list-then-claim window entirely. Returns null when
// the queue is empty, so a drain loop is `while ((r = claimNextRequest())) { ... }`.
function claimNextRequest({ actions = null, by = null, phase = null } = {}) {
  if (actions !== null && actions !== undefined) {
    if (!Array.isArray(actions) || actions.some((a) => !REQUEST_ACTIONS.includes(a))) {
      throw euser(`actions must be an array drawn from ${REQUEST_ACTIONS.join(', ')}`);
    }
  }
  return mutateRequests((doc) => {
    const next = doc.requests.find((r) => r.status === 'queued'
      && (!actions || actions.includes(r.action)));
    if (!next) return null;
    next.status = 'running';
    next.claimedBy = by === null || by === '' ? null : String(by);
    next.claimedAt = now();
    if (phase !== undefined && phase !== null && phase !== '') next.phase = String(phase);
    next.updatedAt = next.claimedAt;
    return next;
  });
}

// ---------- delete ----------

function deleteFeature(id) {
  if (!fs.existsSync(featurePath(id))) throw euser(`feature "${id}" not found`);
  for (const p of [featurePath(id), ledgerPath(id), roundsPath(id)]) {
    try { fs.rmSync(p); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  // Any job still pointing at this workspace is now unrunnable: a queued one would be picked up by
  // the runner and fail (or an `audit` would silently re-create the id), and the cockpit would show
  // a job stalled forever against a workspace that no longer exists. Fail them explicitly instead —
  // terminal, so no runner claims them, with the reason visible on the card. History is preserved.
  let cancelled = [];
  try {
    cancelled = mutateRequests((doc) => {
      const hit = doc.requests.filter((r) => r.wsId === id && (r.status === 'queued' || r.status === 'running'));
      const at = now();
      for (const r of hit) {
        r.status = 'error';
        r.note = `workspace "${id}" was deleted before this job ran`;
        r.needsInput = false;
        r.updatedAt = at;
      }
      return hit.map((r) => r.id);
    });
  } catch { /* queue unreadable — the feature is still deleted */ }
  return { id, deleted: true, cancelledRequests: cancelled };
}

function deleteRequest(id) {
  return mutateRequests((doc) => {
    const idx = doc.requests.findIndex((r) => r.id === id);
    if (idx === -1) throw euser(`request "${id}" not found`);
    doc.requests.splice(idx, 1);
    return { id, deleted: true };
  });
}

// ---------- coverage ----------

function setCoverage(featureId, coverage) {
  if (!Array.isArray(coverage)) throw euser('coverage must be an array');
  for (const entry of coverage) {
    if (!entry || typeof entry !== 'object') throw euser('coverage entries must be objects');
    if (!COVERAGE_STATUSES.includes(entry.status)) {
      throw euser(`invalid coverage status "${entry.status}": must be one of ${COVERAGE_STATUSES.join(', ')}`);
    }
  }
  return mutateFeature(featureId, (feature) => { feature.coverage = coverage; });
}

module.exports = {
  DATA_DIR,
  READONLY,
  KINDS,
  FEATURE_STATUSES,
  REQUEST_ACTIONS,
  REQUEST_STATUSES,
  REQUEST_KINDS,
  initDataDir,
  configureLocking,
  loadConfig,
  mergeConfig,
  isValidFeatureId,
  assertFeatureId,
  isValidSha,
  legacyFingerprint,
  claimRequest,
  claimNextRequest,
  createFeature,
  getFeature,
  listFeatures,
  saveFeature,
  addSource,
  PR_KINDS,
  THREAD_PROXIMITY_LINES,
  setPriorThreads,
  parseLocus,
  threadCollisions,
  unreconciledAgainstThreads,
  setFeatureStatus,
  setFeatureSummary,
  setFeatureReview,
  reviewStamps,
  WORKSPACE_STATES,
  WSID_REQUIRED_ACTIONS,
  APPROVAL_VOTES,
  APPROVAL_BLOCKING_SEVERITIES,
  QUESTION_DIMENSION,
  approvalSignal,
  decisionOf,
  workspaceState,
  loadLedger,
  loadRounds,
  fingerprint,
  ingestRound,
  setFindingStatus,
  markPosted,
  markApplied,
  setFindingPending,
  clearFindingPending,
  pendingFindings,
  isAgreedCodeFix,
  setFindingFixCommit,
  unbackedFixes,
  isPosted,
  isApplied,
  isPending,
  setFindingDecision,
  setFindingNote,
  setFindingDetails,
  setFindingDraft,
  clearFindingDraft,
  setDraftReview,
  readiness,
  setCoverage,
  loadRequests,
  addRequest,
  listRequests,
  setRequestStatus,
  deleteFeature,
  deleteRequest,
  validateIngestFinding,
};
