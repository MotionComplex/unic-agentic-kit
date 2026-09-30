'use strict';

// FLOWLEVER_READONLY=1 — the guard that makes the cockpit safe to open, drive and demo against real
// review data. It exists because of two near-misses on the author's own ledger: a single keystroke
// in the stepper silently rewrote a real finding, and later a worker testing against a THROWAWAY
// copy of the data still spawned a live runner that talks to real Azure DevOps. That second one is
// the whole reason the mode is enforced in three places rather than one — a scratch FLOWLEVER_DATA
// isolates the ledger but not the app's outbound writes.
//
// Everything here runs as a real subprocess, because READONLY is read at require() time (a mode you
// could toggle mid-process is a mode you cannot reason about from a log line). Each assertion is
// paired with a control run WITHOUT the flag, so a test that passes because the operation was
// broken anyway cannot masquerade as the guard working.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const SRC = path.join(__dirname, '..', 'src');

const dirs = [];
function freshData() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'flowlever-ro-'));
  dirs.push(d);
  // Seed with the flag OFF, so every read-only assertion below runs against a real populated store.
  const seed = spawnSync(process.execPath, [CLI, 'feature', 'add', 'ro-feat', '--title', 'RO Feature'],
    { env: { ...process.env, FLOWLEVER_DATA: d, FLOWLEVER_READONLY: '' }, encoding: 'utf8' });
  assert.equal(seed.status, 0, `seeding must succeed: ${seed.stderr}`);
  return d;
}

after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function cli(args, { data, readOnly }) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, FLOWLEVER_DATA: data, FLOWLEVER_READONLY: readOnly ? '1' : '' },
    encoding: 'utf8',
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

/* Boot a real server in a subprocess on an ephemeral port and return its base URL. */
function startServer({ data, readOnly }) {
  const child = require('node:child_process').spawn(process.execPath, ['-e', `
    process.env.FLOWLEVER_DATA = ${JSON.stringify(data)};
    const { server } = require(${JSON.stringify(path.join(SRC, 'server.js'))});
    const done = () => console.log('PORT:' + server.address().port);
    server.listening ? done() : server.once('listening', done);
  `], {
    env: { ...process.env, FLOWLEVER_DATA: data, FLOWLEVER_READONLY: readOnly ? '1' : '', PORT: '0' },
    encoding: 'utf8',
  });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`server did not start: ${out}`)), 15000);
    child.stdout.on('data', (b) => {
      out += b;
      const m = out.match(/PORT:(\d+)/);
      if (m) { clearTimeout(timer); resolve({ base: `http://127.0.0.1:${m[1]}`, child }); }
    });
    child.stderr.on('data', (b) => { out += b; });
    child.on('exit', (c) => { clearTimeout(timer); reject(new Error(`server exited ${c}: ${out}`)); });
  });
}

test('read-only refuses every ledger write at the choke point, not just over HTTP', () => {
  const data = freshData();
  const before = fs.readFileSync(path.join(data, 'features', 'ro-feat.json'), 'utf8');

  // The CLI bypasses the server entirely, which is exactly why the guard cannot live in server.js.
  const blocked = cli(['feature', 'add', 'ro-second', '--title', 'Should not exist'], { data, readOnly: true });
  assert.notEqual(blocked.status, 0, 'a write must fail under FLOWLEVER_READONLY=1');
  assert.match(`${blocked.stdout}${blocked.stderr}`, /FLOWLEVER_READONLY/,
    'the refusal must name the flag, so the cause is obvious rather than mysterious');
  assert.ok(!fs.existsSync(path.join(data, 'features', 'ro-second.json')),
    'nothing may reach disk');
  assert.equal(fs.readFileSync(path.join(data, 'features', 'ro-feat.json'), 'utf8'), before,
    'existing data must be byte-identical afterwards');

  // Control: the same command succeeds without the flag, so the assertion above is about the guard
  // and not about a command that could never have worked.
  const allowed = cli(['feature', 'add', 'ro-second', '--title', 'Now it exists'], { data, readOnly: false });
  assert.equal(allowed.status, 0, `the same write must succeed without the flag: ${allowed.stderr}`);
  assert.ok(fs.existsSync(path.join(data, 'features', 'ro-second.json')));
});

test('read-only still reads: listing and reporting work untouched', () => {
  const data = freshData();
  const list = cli(['feature', 'list', '--json'], { data, readOnly: true });
  assert.equal(list.status, 0, `reads must keep working: ${list.stderr}`);
  assert.match(list.stdout, /ro-feat/, 'the seeded workspace is still visible');
});

test('read-only answers 403 on writes and 200 on reads over HTTP', async () => {
  const data = freshData();
  const { base, child } = await startServer({ data, readOnly: true });
  try {
    const get = await fetch(`${base}/api/features`);
    assert.equal(get.status, 200, 'reads stay available — the cockpit is meant to be browsable');

    const cfg = await (await fetch(`${base}/api/config`)).json();
    assert.equal(cfg.readOnly, true, 'the page learns the mode from the config it already fetches');

    const diag = await (await fetch(`${base}/api/diagnostics`)).json();
    assert.equal(diag.readOnly, true, 'diagnostics report the trust boundary honestly');

    // A 403 rather than the ledger's own throw surfacing as a 500: the refusal is policy, and it
    // must not read like a crash.
    const write = await fetch(`${base}/api/features/ro-feat/status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });
    assert.equal(write.status, 403);
    assert.match((await write.json()).error, /FLOWLEVER_READONLY/);

    // The runner is the one route that reaches OUTSIDE this machine, and it writes nothing locally,
    // so the ledger guard cannot stop it. It must be refused by the same gate.
    const runner = await fetch(`${base}/api/runner`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'watch' }),
    });
    assert.equal(runner.status, 403, 'starting a runner must be refused — it posts to real PRs');

    const after = JSON.parse(fs.readFileSync(path.join(data, 'features', 'ro-feat.json'), 'utf8'));
    assert.notEqual(after.status, 'done', 'the refused write left no trace');
  } finally {
    child.kill('SIGKILL');
  }
});

test('without the flag the same server accepts the same write (control)', async () => {
  const data = freshData();
  const { base, child } = await startServer({ data, readOnly: false });
  try {
    const cfg = await (await fetch(`${base}/api/config`)).json();
    assert.equal(cfg.readOnly, false, 'read-only is off unless asked for — it must never be the default');

    const write = await fetch(`${base}/api/features/ro-feat/status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });
    assert.equal(write.status, 200, 'the identical request succeeds, so the 403 above was the guard');
  } finally {
    child.kill('SIGKILL');
  }
});

test('the runner module refuses to spawn under read-only, with a reason a caller can act on', () => {
  const data = freshData();
  const probe = spawnSync(process.execPath, ['-e', `
    const runner = require(${JSON.stringify(path.join(SRC, 'runner.js'))});
    const r = runner.start('watch');
    console.log(JSON.stringify({ ok: r.ok, code: r.code, error: r.error }));
  `], {
    env: { ...process.env, FLOWLEVER_DATA: data, FLOWLEVER_READONLY: '1' },
    encoding: 'utf8',
  });
  assert.equal(probe.status, 0, `probe must run: ${probe.stderr}`);
  const r = JSON.parse(probe.stdout.trim());
  assert.equal(r.ok, false, 'a runner must not start under read-only');
  assert.equal(r.code, 'EREADONLY', 'a distinct code, so the HTTP layer can map it deliberately');
  assert.match(r.error, /FLOWLEVER_READONLY/);
  // Refused before it could even look for the binary: a missing `claude` must not be able to
  // masquerade as the read-only guard, or this test would pass on a machine without the CLI.
  assert.doesNotMatch(r.error, /No shell available|not found/i);
});

test('read-only mode does not crash against an empty data dir', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'flowlever-ro-empty-'));
  dirs.push(empty);
  // initDataDir() would normally seed config.json here; under read-only it must decline and let the
  // board render empty rather than fail in a way that looks like the mode is broken.
  const list = cli(['feature', 'list', '--json'], { data: empty, readOnly: true });
  assert.equal(list.status, 0, `an empty store must read as empty, not as an error: ${list.stderr}`);
  assert.ok(!fs.existsSync(path.join(empty, 'config.json')), 'and it seeded nothing');
});
