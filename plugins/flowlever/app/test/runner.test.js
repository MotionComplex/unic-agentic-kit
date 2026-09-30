'use strict';

// Covers the process-spawning module. The properties under test are the ones that keep an HTTP
// handler spawning a subprocess safe and honest: a fixed prompt allowlist, one run at a time,
// truthful liveness, and a visible log.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowlever-runner-'));
process.env.FLOWLEVER_DATA = tmpDir;

// A stand-in for the `claude` CLI: echoes its argv so we can assert exactly what was invoked,
// then lingers long enough for the concurrency checks.
const FAKE = path.join(tmpDir, 'fake-claude');
fs.writeFileSync(FAKE, '#!/bin/sh\necho "argv: $@"\necho "data: $FLOWLEVER_DATA"\nsleep 5\n');
fs.chmodSync(FAKE, 0o755);
process.env.FLOWLEVER_CLAUDE_BIN = FAKE;

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const runner = require('../src/runner');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A login shell sources the user's profile, which can take a second or two on a real machine —
// poll for the expected output instead of guessing a fixed delay.
async function waitForLog(re, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const log = runner.tailLog();
    if (re.test(log)) return log;
    if (Date.now() > deadline) return log;
    await sleep(200);
  }
}

after(() => {
  try { runner.stop(); } catch { /* already idle */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('status resolves the binary from FLOWLEVER_CLAUDE_BIN and starts idle', () => {
  const s = runner.status();
  assert.equal(s.available, true);
  assert.equal(s.bin, FAKE);
  assert.equal(s.binFrom, 'FLOWLEVER_CLAUDE_BIN');
  assert.equal(s.running, false);
  assert.equal(s.logPath, path.join(tmpDir, 'runner.log'));
});

test('start refuses any action outside the allowlist (no request text reaches the shell)', () => {
  for (const action of ['rm -rf /', 'watch; touch /tmp/pwned', 'apply', '', null, 42]) {
    const r = runner.start(action);
    assert.equal(r.ok, false, `${JSON.stringify(action)} must be refused`);
    assert.equal(r.code, 'EACTION');
  }
  assert.equal(runner.isRunning(), false, 'a refused start must not spawn anything');
});

test('start spawns the fixed prompt, pins FLOWLEVER_DATA, and logs the invocation', async () => {
  const r = runner.start('watch');
  assert.equal(r.ok, true);
  assert.equal(runner.isRunning(), true);
  assert.equal(r.status.action, 'watch');
  assert.ok(r.status.pid > 0);

  const log = await waitForLog(/argv:/);
  assert.match(log, /=== watch started .* \(from the cockpit\) ===/);
  assert.match(log, /argv: -p \/flowlever:watch --dangerously-skip-permissions/,
    'the prompt must be exactly the allowlisted skill');
  assert.match(log, new RegExp(`data: ${tmpDir}`), 'the child writes to the ledger this server serves');
});

test('a second start while running is refused, not queued', () => {
  assert.equal(runner.isRunning(), true, 'previous test left it running');
  const r = runner.start('watch');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'EBUSY');
  assert.ok(r.status.running);
});

test('stop terminates it and status turns truthful again', async () => {
  assert.equal(runner.stop().ok, true);
  await sleep(500);
  const s = runner.status();
  assert.equal(s.running, false);
  assert.equal(s.signal, 'SIGTERM');
  assert.ok(s.finishedAt, 'the end time is recorded');
  assert.equal(runner.stop().ok, false, 'stopping an idle runner is an error, not a silent no-op');
});

test('a missing binary is reported, not spawned blindly', () => {
  const saved = process.env.FLOWLEVER_CLAUDE_BIN;
  process.env.FLOWLEVER_CLAUDE_BIN = path.join(tmpDir, 'does-not-exist');
  try {
    const s = runner.status();
    assert.equal(s.available, false);
    assert.match(s.reason, /does not exist/);
    const r = runner.start('watch');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ENOBIN');
  } finally {
    process.env.FLOWLEVER_CLAUDE_BIN = saved;
  }
});

// ---------- stopping the whole process group, and surviving a restart (C-13) ----------

const cp = require('node:child_process');

// Earlier tests in this file leave a fake runner lingering on purpose (they assert the one-at-a-time
// refusal), so these tests must start from a genuinely idle module.
async function quiesce() {
  if (runner.isRunning()) runner.stop();
  for (let i = 0; i < 60 && runner.isRunning(); i += 1) {
    await new Promise((r) => setTimeout(r, 100));
  }
  fs.rmSync(path.join(tmpDir, 'runner.pid'), { force: true });
  assert.equal(runner.isRunning(), false, 'could not reach an idle runner state');
}

// The child is spawned via `sh -lc "<cmd>"` with detached:true, so it LEADS a process group. Whether
// the shell execs the command or forks it is shell- and profile-dependent — which is why two
// reviewers disagreed about whether stop() leaked. Signalling the group makes it deterministic.
test('stop() reaps a grandchild the shell forked, not just the shell', async () => {
  const marker = `flowlever-orphan-test-${process.pid}`;
  const forking = path.join(tmpDir, 'forking-claude');
  fs.writeFileSync(forking, `#!/bin/bash\nbash -c 'exec -a ${marker} sleep 240' &\nwait\n`);
  fs.chmodSync(forking, 0o755);

  await quiesce();
  const saved = process.env.FLOWLEVER_CLAUDE_BIN;
  process.env.FLOWLEVER_CLAUDE_BIN = forking;
  const count = () => {
    try { return Number(cp.execSync(`pgrep -f ${marker} | wc -l`).toString().trim()); }
    catch { return 0; }
  };
  try {
    const started = runner.start('watch');
    assert.ok(started.ok, `start failed: ${started.error || ''}`);
    // Give the stub time to fork its grandchild, otherwise the assertion proves nothing.
    for (let i = 0; i < 40 && count() === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(count() >= 1, 'the test stub must actually fork a grandchild for this to mean anything');

    assert.ok(runner.stop().ok);
    for (let i = 0; i < 30 && count() > 0; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(count(), 0, 'a shell-only SIGTERM would have left this process running');
  } finally {
    try { cp.execSync(`pkill -f ${marker}`); } catch { /* already gone */ }
    process.env.FLOWLEVER_CLAUDE_BIN = saved;
    if (runner.isRunning()) runner.stop();
  }
});

test('liveness survives a server restart: an adopted runner blocks a second start', async () => {
  // The guard used to live only in module memory, so restarting the server forgot a live runner and
  // the next click spawned a second session draining the same queue.
  await quiesce();
  const outsider = cp.spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  fs.writeFileSync(path.join(tmpDir, 'runner.pid'),
    JSON.stringify({ pid: outsider.pid, action: 'watch', startedAt: new Date().toISOString() }));
  try {
    assert.equal(runner.isRunning(), true, 'a live pid on disk means a runner is going');
    const st = runner.status();
    assert.equal(st.adopted, true);
    assert.equal(st.pid, outsider.pid);
    assert.equal(st.exitCode, null, 'an adopted runner must not report a finished state');

    const second = runner.start('watch');
    assert.equal(second.ok, false);
    assert.equal(second.code, 'EBUSY');
  } finally {
    try { outsider.kill(); } catch { /* gone */ }
    fs.rmSync(path.join(tmpDir, 'runner.pid'), { force: true });
  }
});

test('a stale pid file (dead process) does not block a start', async () => {
  await quiesce();
  // A very high pid that is essentially certain not to exist, to avoid pid-reuse flakiness.
  fs.writeFileSync(path.join(tmpDir, 'runner.pid'),
    JSON.stringify({ pid: 999999, action: 'watch', startedAt: new Date().toISOString() }));
  assert.equal(runner.isRunning(), false, 'a dead runner must not hold the guard');
  assert.ok(!fs.existsSync(path.join(tmpDir, 'runner.pid')), 'and the stale stamp is cleaned up');
});

// A live pid that is NOT ours to signal. pid 1 is useless here — externalRunner rejects `pid <= 1`
// before pidAlive is consulted, so a test using it passes even against the unfixed code (that is
// how the first version of this test was vacuous). Find a real foreign pid instead.
function foreignPid() {
  let out = '';
  try { out = cp.execSync('ps -axo pid=,uid=', { encoding: 'utf8' }); } catch { return null; }
  const me = process.getuid ? process.getuid() : null;
  if (me === null) return null;
  for (const line of out.split('\n')) {
    const [pid, uid] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(pid) || pid <= 1 || !Number.isInteger(uid)) continue;
    if (uid === me) continue;
    try { process.kill(pid, 0); } catch (e) { if (e.code === 'EPERM') return pid; }
  }
  return null;
}

test('R-6b: a live pid we cannot signal is not adopted as our runner', async (t) => {
  await quiesce();
  const foreign = foreignPid();
  if (foreign === null) {
    t.skip('no foreign (EPERM) pid available on this machine to exercise the guard');
    return;
  }
  // Adopting such a pid left the runner neither stoppable (DELETE → EPERM, stamp retained) nor
  // startable (EBUSY) — unusable with no way out from inside the product.
  fs.writeFileSync(path.join(tmpDir, 'runner.pid'),
    JSON.stringify({ pid: foreign, action: 'watch', startedAt: new Date().toISOString() }));
  assert.equal(runner.isRunning(), false, `pid ${foreign} is alive but not ours, so it is not our runner`);
  assert.ok(!fs.existsSync(path.join(tmpDir, 'runner.pid')), 'and the stale record is discarded');

  const started = runner.start('watch');
  assert.equal(started.ok, true, 'so a runner can still be started');
  runner.stop();
});

test('R-6b/X-1: a pid that is not even a valid argument is not adopted either', async () => {
  await quiesce();
  // 2^31 is an integer > 1, so externalRunner's own guard passes it through, and process.kill then
  // throws ERR_INVALID_ARG_TYPE rather than ESRCH/EPERM. Defaulting an unrecognised failure to
  // "alive" wedged the runner exactly as above.
  fs.writeFileSync(path.join(tmpDir, 'runner.pid'),
    JSON.stringify({ pid: 2147483648, action: 'watch', startedAt: new Date().toISOString() }));
  assert.equal(runner.isRunning(), false, 'only a successful signal proves a live runner');
  assert.ok(!fs.existsSync(path.join(tmpDir, 'runner.pid')));
  const started = runner.start('watch');
  assert.equal(started.ok, true);
  runner.stop();
});
