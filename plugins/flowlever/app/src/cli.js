#!/usr/bin/env node
'use strict';

// FlowLever CLI — see docs/SCHEMA.md "CLI surface".
// Exit codes: 0 ok, 1 user error (EUSER), 2 internal.

const fs = require('node:fs');
const path = require('node:path');
const ledger = require('./ledger');

const GLYPH = { blocker: '◆', major: '▲', minor: '●', info: '○' };
const SEV_ORDER = { blocker: 0, major: 1, minor: 2, info: 3 };

const USAGE = `FlowLever — review cockpit

Usage: node src/cli.js <command> [args]

  feature add <id> --title "..." [--kind spec|pr-review|pr-respond]   Create a workspace
  feature list [--json]                  List features (with readiness)
  feature show <id> [--json]             Show one feature in detail
  feature delete <id> --yes              Delete a workspace (features + ledger + rounds).
                                         --yes is required — the command lists exactly which
                                         files it would remove and refuses without it.
  feature activity <id> [--responded] [--note "..."] [--at <iso>] [--by "<name>"] | --clear
                                         Mark/clear "author responded" on a posted PR review (runner).
                                         --at/--by record WHEN the counterpart last updated the PR and
                                         who — shown in the cockpit next to when we last reviewed it.
  feature summary <id> --text "..." | --file <md> | --clear
                                         Set the plain-language "what is this change about" blurb
                                         shown at the top of the workspace. Written by the review
                                         skills, which have just read the PR, ticket and specs —
                                         the app has no model of its own, so nothing else fills it.
  source add <featureId> --type confluence|ado --id <id> [--itemType "..."] [--title "..."] [--url <url>]
                               [--vertecPhase "..."] [--vertecKey <KEY>]
                               [--clear-vertec-phase] [--clear-vertec-key]
  source add <featureId> --type figma --fileKey <key> [--nodeId <node>] [--title "..."] [--url <url>]
                                         confluence/ado need --id; figma needs --fileKey (--nodeId
                                         optional). --itemType (ado only) stores the work-item type
                                         ("User Story", "Bug", "Pull Request", …) — the cockpit
                                         badges each source by it, so a PR is never mistaken for a
                                         story. --vertecPhase (ado only) stores the work item's
                                         Vertec booking phase (ADO field Custom.Vertec, under
                                         Administration); --vertecKey overrides the booking prefix
                                         the cockpit otherwise derives from the ADO org in --url.
                                         A BLANK --vertecPhase/--vertecKey is dropped, never stored,
                                         so re-registering a source can't wipe a real value by
                                         interpolating an empty variable; --clear-vertec-phase /
                                         --clear-vertec-key are the explicit way to remove one.
  threads set <featureId> --file threads.json | --none
                                         Record the comment threads the PR ALREADY carries (other
                                         reviewers' and your own). Required before "ingest" on a
                                         pr-review/pr-respond workspace: ingest refuses findings
                                         that land on an existing thread unless each says what it
                                         is relative to it (duplicateOf / thread locus /
                                         notDuplicate). --none asserts the PR has no comments.
                                         Entries: { threadId, author, locus?, excerpt?, url? }.
  threads list <featureId> [--json]      Show the recorded threads (or that none were recorded).
  ingest <featureId> --file findings.json [--reopen-resolved] [--note "..."]
                                         [--scope-fps <fp>[,<fp>...] | --scope-dimensions <dim>[,<dim>...]]
                                         Ingest an audit round + reconcile ledger. --scope-fps/
                                         --scope-dimensions (mutually exclusive) mark this as a
                                         PARTIAL pass: findings outside the scope are left exactly
                                         as they were instead of being auto-resolved.
  finding list <featureId> [--status open] [--dimension x] [--severity y] [--json]
  finding edit <featureId> <fp> [--detail "..."] [--suggestion "..."] [--severity blocker|major|minor|info] [--note "..."]
                                         Refine a finding's text/severity (fingerprint stays stable)
  finding posted <featureId> --fps <fp>[,<fp>...] [--sha <commit>] [--repo <r>] [--branch <b>]
                                         Mark PR comment(s)/repl(ies) as posted back (stays reworking +
                                         stamped "awaiting author"; re-review auto-resolves).
                                         --sha is REQUIRED for any finding whose agreed response is a
                                         code fix: no pushed commit, no stamp (hard error). Use
                                         'finding cancel' if the fix was not actually made.
  finding fixed <featureId> --fps <fp>[,<fp>...] --sha <commit> [--repo <r>] [--branch <b>]
                                         Record the pushed commit a code fix landed in
  finding unbacked [<featureId>] [--json]  Audit: agreed code fixes claimed done with NO commit behind
                                         them (i.e. the reviewer was told "fixed" but the branch isn't)
  finding applied <featureId> --fps <fp>[,<fp>...]  Mark spec change(s) as written back to Confluence/ADO
                                         (stays reworking + stamped "awaiting re-audit"; re-audit auto-resolves)
  finding cancel <featureId> [--fps <fp>[,<fp>...]] [--reason "..."]
                                         Undo an in-flight "Posting…/Applying…" marker (default: all of
                                         them) so the findings go back to the review queue. Call this
                                         whenever an apply fails or is abandoned — a stranded pending
                                         marker is otherwise permanent. Claims nothing was written.
  finding set <featureId> <fp> --status open|reworking|resolved|waived
                               [--reason "..."] [--pin|--unpin]
  finding draft <featureId> <fp> --before "..." --after "..." [--target "..."]
                               [--format text|gherkin|markdown] [--target-ref '<json>']
                                         Attach a proposed before→after change (red/green diff in the
                                         cockpit). --target-ref is the machine write target for apply,
                                         e.g. '{"system":"ado","adoId":42695,"field":"...AcceptanceCriteria"}'
                                         or '{"system":"confluence","pageId":"123","anchor":"flow-payment","version":14}'
  finding draft-clear <featureId> <fp>   Remove a finding's proposed change
  finding review <featureId> <fp> [--verdict proposed|redirect|reject] [--note "..."]
                               [--hunk <idx> --hunk-status accepted|rejected|edited [--edited-text "..."]]
                                         Record decisions on a proposal: accept/edit/reject a hunk, and/or
                                         a finding-level verdict + counter-proposal note (redirect = do it
                                         differently/elsewhere; reject = don't apply)
  readiness <featureId> [--json]         Print score + gate + open blockers
  report <featureId> [--out report.md]   Generate markdown report
  coverage set <featureId> --file coverage.json
  requests list [--status queued|running|done|error] [--json]   List UI-triggered job requests
  requests add --action pr-review|pr-respond|audit|apply|re-audit|propose|poll
                               [--prId <id>] [--wsId <id>] [--kind pr-review|pr-respond]
                               [--title "..."] [--instructions "..."] [--dedupe] [--json]
                                         Enqueue a job (same queue the web UI feeds); --dedupe
                                         no-ops when an identical queued/running request exists.
                                         poll = a discovery/refresh pass now (--kind narrows it
                                         to one section); the cockpit's "↻ Refresh" button
  requests claim [--actions a,b] [--json]   Atomically claim the OLDEST queued request
                                         (optionally filtered to one or more --actions) — the
                                         compare-and-swap that makes a runner's take exclusive.
                                         Prints "nothing queued" and exits 0 when the queue is empty.
  requests delete <id>                   Remove a request from the queue
  requests set <id> --status running|done|error [--note "..."] [--wsId <id>]
                               [--phase "..."] [--needs-input|--no-needs-input]
                                         Update a request (the runner skill uses this);
                                         --phase sets the live step label, --needs-input flags
                                         it as blocked on you (e.g. a 2FA/auth prompt)
  start [--port N] [--no-open]           Launch the cockpit server + open it in the browser
  demo [--force]                         Seed demo feature. --force is required once any demo
                                         workspace already exists (it would be deleted + reseeded).
  help                                   Show this help

Severity glyphs: ◆ blocker  ▲ major  ● minor  ○ info`;

function userError(msg) {
  const err = new Error(msg);
  err.code = 'EUSER';
  return err;
}

// ---------- arg parsing (hand-rolled) ----------

const BOOL_FLAGS = new Set(['json', 'reopen-resolved', 'pin', 'unpin', 'no-open', 'needs-input', 'no-needs-input', 'responded', 'no-responded', 'clear', 'clear-vertec-phase', 'clear-vertec-key', 'dedupe', 'yes', 'force']);

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const body = a.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (BOOL_FLAGS.has(body)) {
        flags[body] = true;
      } else {
        const next = argv[i + 1];
        // A value-taking flag must not silently swallow the NEXT flag as if it were its value —
        // `finding set ws fp --status --pin` used to store status:'--pin' and drop --pin with no
        // error. None of this CLI's value flags take a negative-number or dash-prefixed value, so
        // anything shaped like another `--flag` (or a bare `--`) is unambiguously a missing value.
        if (next === undefined || next.startsWith('--')) {
          throw userError(`Flag --${body} requires a value${next !== undefined ? ` (got another flag '${next}')` : ''}`);
        }
        flags[body] = next;
        i++;
      }
    } else {
      pos.push(a);
    }
  }
  return { pos, flags };
}

function need(value, what) {
  if (value === undefined || value === null || value === '') throw userError(`Missing ${what}. Run \`node src/cli.js help\` for usage.`);
  return value;
}

// ---------- output helpers ----------

function table(rows) {
  const widths = [];
  for (const row of rows) {
    row.forEach((c, i) => { widths[i] = Math.max(widths[i] || 0, String(c).length); });
  }
  return rows
    .map((row) => row.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd())
    .join('\n');
}

function glyph(severity) {
  return GLYPH[severity] || '·';
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function readJsonFile(file, what) {
  let raw;
  try {
    raw = fs.readFileSync(path.resolve(file), 'utf8');
  } catch (err) {
    throw userError(`Cannot read ${what} file '${file}': ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw userError(`Invalid JSON in '${file}': ${err.message}`);
  }
}

// validateIngestFinding's return contract: it may throw, return an error string,
// an array of errors, or { errors: [...] }. Anything else counts as valid.
function assertValidFinding(f, idx) {
  let res;
  try {
    res = ledger.validateIngestFinding(f);
  } catch (err) {
    throw userError(`Finding #${idx + 1} invalid: ${err.message}`);
  }
  let errors = [];
  if (typeof res === 'string' && res) errors = [res];
  else if (Array.isArray(res)) errors = res;
  else if (res && typeof res === 'object' && Array.isArray(res.errors)) errors = res.errors;
  else if (res === false) errors = ['failed validation'];
  if (errors.length) throw userError(`Finding #${idx + 1} invalid: ${errors.join('; ')}`);
}

function extractFindings(data, file) {
  const findings = Array.isArray(data) ? data : data && data.findings;
  if (!Array.isArray(findings)) {
    throw userError(`'${file}' must be a JSON array of findings or { "findings": [...] }`);
  }
  return findings;
}

function openSummary(openBySeverity) {
  const parts = [];
  let total = 0;
  for (const sev of ['blocker', 'major', 'minor', 'info']) {
    const n = (openBySeverity && openBySeverity[sev]) || 0;
    total += n;
    parts.push(`${glyph(sev)} ${n} ${sev}`);
  }
  return `${parts.join('   ')}   (${total} open)`;
}

// ---------- commands ----------

function cmdFeatureAdd({ pos, flags }) {
  const id = need(pos[0], 'feature <id>');
  const title = need(flags.title, '--title');
  const opts = { id, title };
  if (flags.kind !== undefined) opts.kind = flags.kind; // spec | pr-review | pr-respond
  const feature = ledger.createFeature(opts);
  console.log(`Created feature ${feature.id} (${feature.kind || 'spec'}) — ${feature.title}`);
}

function cmdFeatureList({ flags }) {
  const features = ledger.listFeatures() || [];
  const summaries = features.map((f) => {
    let r = null;
    try { r = ledger.readiness(f.id); } catch { /* no ledger yet */ }
    return {
      id: f.id,
      title: f.title,
      status: f.status,
      updatedAt: f.updatedAt,
      readiness: r ? { score: r.score, gate: r.gate, openCount: r.openCount } : null,
    };
  });
  if (flags.json) return printJson(summaries);
  if (!summaries.length) {
    console.log('No features yet. Create one: node src/cli.js feature add <id> --title "..."');
    return;
  }
  const rows = [['ID', 'TITLE', 'STATUS', 'SCORE', 'GATE', 'OPEN']];
  for (const s of summaries) {
    rows.push([
      s.id,
      s.title,
      s.status,
      s.readiness ? `${s.readiness.score}/100` : '—',
      s.readiness ? s.readiness.gate : '—',
      s.readiness ? s.readiness.openCount : '—',
    ]);
  }
  console.log(table(rows));
}

function cmdFeatureShow({ pos, flags }) {
  const id = need(pos[0], 'feature <id>');
  const feature = ledger.getFeature(id);
  const r = ledger.readiness(id);
  if (flags.json) return printJson({ feature, readiness: r });

  console.log(`${feature.id} — ${feature.title}`);
  console.log(table([
    ['  Status', feature.status],
    ['  Created', feature.createdAt || '—'],
    ['  Updated', feature.updatedAt || '—'],
    ['  Readiness', `${r.score}/100 (${r.gate})`],
    ['  Open', openSummary(r.openBySeverity)],
  ]));

  if (feature.summary) {
    console.log('\nSummary:');
    for (const line of feature.summary.split('\n')) console.log(`  ${line}`);
  }

  const sources = feature.sources || {};
  const srcRows = [];
  for (const type of ['confluence', 'ado', 'figma']) {
    for (const s of sources[type] || []) {
      // The work-item type is what tells a PR apart from the story it implements, so it is
      // printed next to the id rather than left to the title's wording.
      srcRows.push([
        `  ${type}`,
        s.type ? `[${s.type}]` : '',
        s.id != null ? s.id : `${s.fileKey || ''}${s.nodeId ? '#' + s.nodeId : ''}`,
        s.title || '',
        s.url || '',
      ]);
      if (s.vertecPhase) srcRows.push(['', '', '', `Vertec phase: ${s.vertecPhase}`, '']);
    }
  }
  console.log('\nSources:');
  console.log(srcRows.length ? table(srcRows) : '  (none)');

  const sections = feature.specSections || [];
  const coverage = feature.coverage || [];
  if (sections.length || coverage.length) {
    const byStatus = {};
    for (const c of coverage) byStatus[c.status] = (byStatus[c.status] || 0) + 1;
    const bits = Object.entries(byStatus).map(([k, v]) => `${v} ${k}`).join(', ');
    console.log(`\nCoverage: ${sections.length} spec sections, ${coverage.length} mapped${bits ? ` (${bits})` : ''}`);
  }
  if ((r.blockers || []).length) {
    console.log('\nBlockers:');
    for (const b of r.blockers) {
      if (typeof b === 'string') console.log(`  ◆ ${b}`);
      else console.log(`  ◆ ${b.fp || ''}  ${b.title || ''}`.trimEnd());
    }
  }
}

function cmdFeatureDelete({ pos, flags }) {
  const id = need(pos[0], 'feature <id>');
  ledger.getFeature(id); // EUSER (not found) before the destructive guard, so a typo fails clearly
  if (!flags.yes) {
    const files = ['features', 'ledger', 'rounds']
      .map((sub) => path.join(ledger.DATA_DIR, sub, `${id}.json`))
      .filter((p) => fs.existsSync(p));
    throw userError(`This permanently deletes ${files.length} file(s) for "${id}":\n`
      + files.map((f) => `  ${f}`).join('\n')
      + `\nPass --yes to confirm: node src/cli.js feature delete ${id} --yes`);
  }
  ledger.deleteFeature(id);
  console.log(`Deleted feature ${id}`);
}

// The workspace's plain-language summary. `--file` exists because a good summary is a short
// paragraph or a few bullets, and a shell argument is a poor place to keep newlines.
function cmdFeatureSummary({ pos, flags }) {
  const featureId = need(pos[0], '<featureId>');
  const given = ['text', 'file', 'clear'].filter((k) => flags[k] !== undefined);
  if (given.length !== 1) {
    throw userError('Pass exactly one of --text "...", --file <path> or --clear');
  }
  let summary = null;
  if (flags.text !== undefined) summary = String(flags.text);
  if (flags.file !== undefined) {
    const file = path.resolve(String(flags.file));
    try {
      summary = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw userError(`Cannot read summary file '${flags.file}': ${err.message}`);
    }
  }
  const feature = ledger.setFeatureSummary(featureId, summary);
  console.log(feature.summary
    ? `${feature.id} summary set (${feature.summary.length} chars)`
    : `${feature.id} summary cleared`);
}

function cmdSourceAdd({ pos, flags }) {
  const featureId = need(pos[0], '<featureId>');
  const type = need(flags.type, '--type');
  if (!['confluence', 'ado', 'figma'].includes(type)) {
    throw userError(`--type must be confluence, ado or figma (got '${type}')`);
  }
  const source = { type };
  let label;
  if (type === 'figma') {
    // figma sources are keyed by fileKey, not id — ledger.addSource requires it and there was no
    // route to pass it: this command unconditionally demanded --id, which figma never uses.
    source.fileKey = need(flags.fileKey, '--fileKey (required for --type figma)');
    if (flags.nodeId !== undefined) source.nodeId = flags.nodeId;
    label = `${source.fileKey}${source.nodeId ? `#${source.nodeId}` : ''}`;
  } else {
    let id = need(flags.id, '--id');
    if (type === 'ado' && /^\d+$/.test(id)) id = Number(id);
    source.id = id;
    // ledger.addSource maps itemType -> the source's "type" field (the work-item type); this
    // command used to never read the flag at all, so `--itemType` was accepted and dropped.
    if (type === 'ado' && flags.itemType !== undefined) source.itemType = flags.itemType;
    label = id;
  }
  // The Vertec booking phase + prefix override ride on the work item, so they are ado-only, and a
  // hard error beats silently dropping them: a skill that put the flag on the wrong source would
  // otherwise look like it worked and show no phase. This guard sits OUTSIDE the id-keyed branch
  // on purpose — inside it, `--type figma` never reached the check and exited 0 having stored
  // nothing, while the help text promised "a hard error elsewhere".
  for (const k of ['vertecPhase', 'vertecKey']) {
    if (flags[k] === undefined) continue;
    if (type !== 'ado') throw userError(`--${k} applies to --type ado only (got '${type}')`);
    source[k] = flags[k];
  }
  // Clearing is its own explicit flag, never a blank value: `--vertecPhase "$PHASE"` with an
  // empty PHASE is an accident and must not wipe a real phase (addSource drops blanks for that
  // reason), but a phase emptied in ADO still needs a way off the source.
  for (const [flag, field] of [['clear-vertec-phase', 'vertecPhase'], ['clear-vertec-key', 'vertecKey']]) {
    if (!flags[flag]) continue;
    if (type !== 'ado') throw userError(`--${flag} applies to --type ado only (got '${type}')`);
    if (flags[field] !== undefined) throw userError(`--${flag} and --${field} contradict each other`);
    source[field] = null;
  }
  if (flags.title !== undefined) source.title = flags.title;
  if (flags.url !== undefined) source.url = flags.url;
  ledger.addSource(featureId, source);
  console.log(`Added ${type} source ${label} to ${featureId}`);
}

// Register the comment threads a PR already carries, so `ingest` can refuse findings that
// restate them. --none is the explicit "I looked, there were no comments" — it is NOT the same
// as never running this, which ingest rejects.
function cmdThreadsSet({ pos, flags }) {
  const featureId = need(pos[0], '<featureId>');
  if (Boolean(flags.none) === (flags.file !== undefined)) {
    throw userError('Use either --file <json> or --none, not both and not neither');
  }
  let threads = [];
  if (!flags.none) {
    const file = flags.file;
    const data = readJsonFile(file, 'threads');
    threads = Array.isArray(data) ? data : data && data.threads;
    if (!Array.isArray(threads)) {
      throw userError(`'${file}' must be a JSON array of threads or { "threads": [...] }`);
    }
  }
  let recorded;
  try {
    recorded = ledger.setPriorThreads(featureId, threads);
  } catch (err) {
    throw userError(err.message);
  }
  const anchored = recorded.threads.filter((t) => t.locus).length;
  console.log(`Recorded ${recorded.threads.length} existing thread(s) for ${featureId}`
    + (recorded.threads.length ? ` — ${anchored} anchored to a file:line` : ' (PR has no comments)'));
}

function cmdThreadsList({ pos, flags }) {
  const featureId = need(pos[0], '<featureId>');
  const feature = ledger.getFeature(featureId);
  if (flags.json) return printJson(feature.priorThreads);
  if (feature.priorThreads === null) {
    console.log(`No existing PR threads recorded for ${featureId}.`);
    if (ledger.PR_KINDS.includes(feature.kind)) {
      console.log('Ingest will refuse this workspace until they are — run `threads set` first.');
    }
    return;
  }
  const { threads, recordedAt } = feature.priorThreads;
  console.log(`${threads.length} existing thread(s) for ${featureId}${recordedAt ? ` (recorded ${recordedAt})` : ''}`);
  if (threads.length) {
    console.log(table(threads.map((t) => [`  ${t.threadId}`, t.author, t.locus || '(no file anchor)'])));
  }
}

function cmdIngest({ pos, flags }) {
  const featureId = need(pos[0], '<featureId>');
  const file = need(flags.file, '--file');
  const findings = extractFindings(readJsonFile(file, 'findings'), file);
  findings.forEach((f, i) => assertValidFinding(f, i));
  if (flags['scope-fps'] !== undefined && flags['scope-dimensions'] !== undefined) {
    throw userError('Use either --scope-fps or --scope-dimensions, not both');
  }
  let scope = null;
  if (flags['scope-fps'] !== undefined) {
    scope = { fps: String(flags['scope-fps']).split(',').map((s) => s.trim()).filter(Boolean) };
  } else if (flags['scope-dimensions'] !== undefined) {
    scope = { dimensions: String(flags['scope-dimensions']).split(',').map((s) => s.trim()).filter(Boolean) };
  }
  const { round, stats } = ledger.ingestRound(featureId, findings, {
    note: flags.note,
    reopenResolved: Boolean(flags['reopen-resolved']),
    trigger: 'audit',
    scope,
  });
  console.log(`Ingested round ${round.n} for ${featureId}${flags.note ? ` — ${flags.note}` : ''}`);
  console.log(table([
    ['  New', stats.new],
    ['  Still open', stats.stillOpen],
    ['  Auto-resolved', stats.autoResolved],
    ['  Regressions', stats.regressions],
    ['  Total open', stats.totalOpen],
  ]));
  if (round.readiness) {
    console.log(`  Readiness      ${round.readiness.score}/100 (${round.readiness.gate})`);
  }
}

function cmdFindingList({ pos, flags }) {
  const featureId = need(pos[0], '<featureId>');
  const doc = ledger.loadLedger(featureId);
  let findings = Array.isArray(doc) ? doc : (doc && doc.findings) || [];
  if (flags.status) findings = findings.filter((f) => f.status === flags.status);
  if (flags.dimension) findings = findings.filter((f) => f.dimension === flags.dimension);
  if (flags.severity) findings = findings.filter((f) => f.severity === flags.severity);
  findings = findings.slice().sort((a, b) =>
    (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9)
    || String(a.dimension).localeCompare(String(b.dimension))
    || String(a.title).localeCompare(String(b.title)));

  if (flags.json) return printJson(findings);
  if (!findings.length) return console.log('No findings match.');
  const rows = [['', 'FP', 'SEVERITY', 'DIMENSION', 'STATUS', 'TITLE']];
  for (const f of findings) {
    rows.push([glyph(f.severity), f.fp, f.severity, f.dimension, f.status + (f.pinned ? ' 📌' : ''), f.title]);
  }
  console.log(table(rows));
  console.log(`\n${findings.length} finding(s)`);
}

function cmdFindingSet({ pos, flags }) {
  const featureId = need(pos[0], '<featureId>');
  const fp = need(pos[1], '<fp>');
  if (flags.pin && flags.unpin) throw userError('Use either --pin or --unpin, not both');
  const change = { by: 'user' };
  if (flags.status !== undefined) {
    if (!['open', 'reworking', 'resolved', 'waived'].includes(flags.status)) {
      throw userError(`--status must be open, reworking, resolved or waived (got '${flags.status}')`);
    }
    change.status = flags.status;
  }
  if (flags.reason !== undefined) change.reason = flags.reason;
  if (flags.pin) change.pinned = true;
  if (flags.unpin) change.pinned = false;
  if (change.status === undefined && change.pinned === undefined) {
    throw userError('Nothing to change: pass --status and/or --pin/--unpin');
  }
  const finding = ledger.setFindingStatus(featureId, fp, change);
  console.log(`${glyph(finding.severity)} ${finding.fp}  ${finding.status}${finding.pinned ? ' 📌' : ''}  ${finding.title}`);
}

// `--responded` stamps DETECTION time (now). `--at` records the real timestamp of the
// counterpart's newest update on the PR (from ADO) and `--by` who made it — that pair is what
// the cockpit shows as "PR updated <when> by <who>" beside "reviewed <when>". Runners should
// pass both whenever they know them; `--responded` alone still works.
function cmdFeatureActivity({ pos, flags }) {
  const featureId = need(pos[0], '<featureId>');
  const patch = {};
  if (flags.responded) patch.authorRespondedAt = new Date().toISOString();
  if (flags['no-responded'] || flags['clear']) { patch.authorRespondedAt = null; patch.note = null; }
  if (flags.note !== undefined) patch.note = String(flags.note);
  if (flags.at !== undefined) {
    if (Number.isNaN(Date.parse(flags.at))) {
      throw userError(`--at must be an ISO-8601 timestamp (got '${flags.at}')`);
    }
    patch.lastActivityAt = String(flags.at);
  }
  if (flags.by !== undefined) patch.lastActivityBy = String(flags.by);
  if (Object.keys(patch).length === 0) {
    throw userError('Nothing to set: pass --responded [--note "..."] [--at <iso> --by "<name>"], or --clear');
  }
  const feature = ledger.setFeatureReview(featureId, patch);
  const r = feature.review || {};
  const activity = r.lastActivityAt ? `  PR updated ${r.lastActivityAt}${r.lastActivityBy ? ` by ${r.lastActivityBy}` : ''}` : '';
  console.log(`${feature.id}  author ${r.authorRespondedAt ? 'responded' : 'not responded'}${r.note ? `  — ${r.note}` : ''}${activity}`);
}

// `--sha` is REQUIRED for any finding whose agreed response is a code change — the ledger refuses
// the stamp otherwise (see assertFixCommit). This is deliberate: a reply saying "Fixed" with no
// commit behind it is the one failure this tool must never produce again.
function cmdFindingPosted({ pos, flags }) {
  const featureId = need(pos[0], '<featureId>');
  const raw = flags.fps !== undefined ? String(flags.fps) : pos.slice(1).join(',');
  const fps = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!fps.length) throw userError('Pass the posted finding ids: --fps <fp>[,<fp>...] (or as positional args)');
  if (flags.sha !== undefined && !/^[0-9a-f]{7,40}$/i.test(String(flags.sha).trim())) {
    throw userError(`--sha must be a 7–40 character hex git sha (got '${flags.sha}')`);
  }
  const updated = ledger.markPosted(featureId, fps, {
    by: 'post',
    sha: flags.sha,
    repo: flags.repo !== undefined ? String(flags.repo) : null,
    branch: flags.branch !== undefined ? String(flags.branch) : null,
  });
  for (const f of updated) {
    const fix = f.fixCommit && f.fixCommit.sha ? `  fix in ${f.fixCommit.sha.slice(0, 10)}` : '';
    console.log(`${glyph(f.severity)} ${f.fp}  posted (awaiting author)${fix}  ${f.title}`);
  }
  console.log(`\n${updated.length} finding(s) marked posted`);
}

// Record the pushed commit for a fix without (or before) posting anything about it.
function cmdFindingFixed({ pos, flags }) {
  const featureId = need(pos[0], '<featureId>');
  const raw = flags.fps !== undefined ? String(flags.fps) : pos.slice(1).join(',');
  const fps = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!fps.length) throw userError('Pass the fixed finding ids: --fps <fp>[,<fp>...]');
  const sha = need(flags.sha, '--sha <pushed commit sha>');
  for (const fp of fps) {
    const f = ledger.setFindingFixCommit(featureId, fp, {
      sha,
      repo: flags.repo !== undefined ? String(flags.repo) : null,
      branch: flags.branch !== undefined ? String(flags.branch) : null,
    });
    console.log(`${glyph(f.severity)} ${f.fp}  fix recorded in ${f.fixCommit.sha.slice(0, 10)}  ${f.title}`);
  }
}

// Audit: agreed code fixes that are claimed done with no commit behind them. Should print nothing.
function cmdFindingUnbacked({ pos, flags }) {
  const ids = pos[0] ? [pos[0]] : ledger.listFeatures().map((f) => f.id);
  const rows = [];
  for (const id of ids) {
    for (const f of ledger.unbackedFixes(id)) {
      rows.push({ workspace: id, fp: f.fp, status: f.status, target: (f.draft && f.draft.target) || f.locus, title: f.title });
    }
  }
  if (flags.json) return printJson(rows);
  if (!rows.length) {
    console.log('No unbacked fixes — every claimed code fix points at a commit.');
    return;
  }
  console.log(table([['WORKSPACE', 'FP', 'STATUS', 'TARGET', 'TITLE'],
    ...rows.map((r) => [r.workspace, r.fp, r.status, r.target, r.title.slice(0, 60)])]));
  console.log(`\n⚠ ${rows.length} finding(s) claim a code fix with NO commit behind them — the reviewer was told`);
  console.log('  it was handled but the branch does not contain the change. Reopen them (finding set <ws> <fp>');
  console.log('  --status open) and redo the fix, or record the real commit (finding fixed <ws> --fps <fp> --sha <sha>).');
}

// Undo an in-flight Post/Apply marker. The runner MUST call this whenever an apply fails or is
// abandoned — otherwise the findings stay in the "Posting…/Applying…" lane forever: out of the
// review queue, never stamped, with no way back. With no --fps it clears every pending finding
// in the workspace. Findings already stamped posted/applied are left as they are.
function cmdFindingCancel({ pos, flags }) {
  const featureId = need(pos[0], '<featureId>');
  const raw = flags.fps !== undefined ? String(flags.fps) : pos.slice(1).join(',');
  const fps = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const targets = fps.length ? fps : ledger.pendingFindings(featureId).map((f) => f.fp);
  if (!targets.length) {
    console.log(`${featureId}: nothing in flight — no pending post/apply to cancel`);
    return;
  }
  const updated = ledger.clearFindingPending(featureId, targets, { by: 'user', reason: flags.reason });
  for (const f of updated) {
    console.log(`${glyph(f.severity)} ${f.fp}  back in the review queue (${f.status})  ${f.title}`);
  }
  console.log(`\n${updated.length} finding(s) taken out of the in-flight lane — nothing was posted`);
}

// Spec mirror of `finding posted`: the runner calls this after actually writing an accepted
// change back to Confluence/ADO, so the finding moves from "Applying…" to "Applied — awaiting
// re-audit" (and stops faking a completion the moment the user clicked Apply).
function cmdFindingApplied({ pos, flags }) {
  const featureId = need(pos[0], '<featureId>');
  const raw = flags.fps !== undefined ? String(flags.fps) : pos.slice(1).join(',');
  const fps = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!fps.length) throw userError('Pass the applied finding ids: --fps <fp>[,<fp>...] (or as positional args)');
  const updated = ledger.markApplied(featureId, fps, { by: 'apply' });
  for (const f of updated) {
    console.log(`${glyph(f.severity)} ${f.fp}  applied (awaiting re-audit)  ${f.title}`);
  }
  console.log(`\n${updated.length} finding(s) marked applied`);
}

function cmdFindingEdit({ pos, flags }) {
  const featureId = need(pos[0], '<featureId>');
  const fp = need(pos[1], '<fp>');
  const change = { by: 'user' };
  if (flags.detail !== undefined) change.detail = flags.detail;
  if (flags.suggestion !== undefined) change.suggestion = flags.suggestion;
  if (flags.severity !== undefined) {
    if (!['blocker', 'major', 'minor', 'info'].includes(flags.severity)) {
      throw userError(`--severity must be blocker, major, minor or info (got '${flags.severity}')`);
    }
    change.severity = flags.severity;
  }
  if (flags.note !== undefined) change.note = flags.note;
  if (change.detail === undefined && change.suggestion === undefined && change.severity === undefined) {
    throw userError('Nothing to refine: pass --detail, --suggestion and/or --severity');
  }
  const finding = ledger.setFindingDetails(featureId, fp, change);
  console.log(`${glyph(finding.severity)} ${finding.fp}  refined  ${finding.title}`);
}

function describeTargetRef(tr) {
  if (!tr) return '';
  if (tr.system === 'ado') return `ado:${tr.adoId}${tr.field ? `#${tr.field}` : ''}`;
  if (tr.system === 'confluence') return `confluence:${tr.pageId}${tr.anchor ? `#${tr.anchor}` : ''}${tr.version != null ? ` @v${tr.version}` : ''}`;
  return tr.system || '';
}

function cmdFindingDraft({ pos, flags }) {
  const featureId = need(pos[0], '<featureId>');
  const fp = need(pos[1], '<fp>');
  const before = need(flags.before, '--before');
  const after = need(flags.after, '--after');
  const opts = { before, after, by: 'user' };
  if (flags.target !== undefined) opts.target = flags.target;
  if (flags.format !== undefined) {
    if (!['text', 'gherkin', 'markdown'].includes(flags.format)) {
      throw userError(`--format must be text, gherkin or markdown (got '${flags.format}')`);
    }
    opts.format = flags.format;
  }
  if (flags['target-ref'] !== undefined) {
    try { opts.targetRef = JSON.parse(flags['target-ref']); }
    catch (err) { throw userError(`--target-ref must be valid JSON: ${err.message}`); }
  }
  const finding = ledger.setFindingDraft(featureId, fp, opts);
  const where = describeTargetRef(finding.draft && finding.draft.targetRef) || (finding.draft ? finding.draft.target : '');
  console.log(`${glyph(finding.severity)} ${finding.fp}  drafted${where ? ` → ${where}` : ''}  ${finding.title}`);
}

function cmdFindingDraftClear({ pos }) {
  const featureId = need(pos[0], '<featureId>');
  const fp = need(pos[1], '<fp>');
  const finding = ledger.clearFindingDraft(featureId, fp, { by: 'user' });
  console.log(`${glyph(finding.severity)} ${finding.fp}  draft cleared  ${finding.title}`);
}

function cmdFindingReview({ pos, flags }) {
  const featureId = need(pos[0], '<featureId>');
  const fp = need(pos[1], '<fp>');
  const review = {};
  if (flags.verdict !== undefined) review.verdict = flags.verdict;
  if (flags.note !== undefined) review.note = flags.note;
  if (flags.hunk !== undefined) {
    review.hunk = flags.hunk;
    review.status = need(flags['hunk-status'], '--hunk-status (required with --hunk)');
    if (flags['edited-text'] !== undefined) review.editedText = flags['edited-text'];
  } else if (flags['hunk-status'] !== undefined) {
    throw userError('--hunk-status requires --hunk <idx>');
  }
  if (review.verdict === undefined && review.note === undefined && review.hunk === undefined) {
    throw userError('Nothing to review: pass --verdict, --note and/or --hunk <idx> --hunk-status ...');
  }
  const finding = ledger.setDraftReview(featureId, fp, review, { by: 'user' });
  const rv = (finding.draft && finding.draft.review) || {};
  console.log(`${glyph(finding.severity)} ${finding.fp}  verdict=${rv.verdict || 'proposed'}${rv.note ? `  — ${rv.note}` : ''}  ${finding.title}`);
}

function cmdReadiness({ pos, flags }) {
  const featureId = need(pos[0], '<featureId>');
  const r = ledger.readiness(featureId);
  if (flags.json) return printJson(r);
  console.log(`Readiness for ${featureId}`);
  console.log(table([
    ['  Score', `${r.score}/100`],
    ['  Gate', r.gate],
    ['  Open', openSummary(r.openBySeverity)],
  ]));
  const blockers = r.blockers || [];
  if (blockers.length) {
    console.log('\nBlockers:');
    for (const b of blockers) {
      if (typeof b === 'string') console.log(`  ◆ ${b}`);
      else console.log(`  ◆ ${b.fp || ''}  ${b.title || ''}`.trimEnd());
    }
  } else {
    console.log('\nNo open blockers.');
  }
}

async function cmdReport({ pos, flags }) {
  const featureId = need(pos[0], '<featureId>');
  const { generateReport } = require('./report.js');
  const md = await generateReport(featureId);
  if (flags.out) {
    fs.writeFileSync(path.resolve(flags.out), md);
    console.log(`Report written to ${flags.out}`);
  } else {
    console.log(md);
  }
}

function cmdRequestsList({ flags }) {
  const requests = ledger.listRequests(flags.status ? { status: flags.status } : {});
  if (flags.json) return printJson(requests);
  if (!requests.length) {
    console.log('No requests queued.');
    return;
  }
  const rows = [['ID', 'ACTION', 'STATUS', 'TARGET', 'TITLE', 'INSTRUCTIONS', 'NOTE']];
  for (const r of requests) {
    // A `poll` (refresh) job has no id target — name the scope it covers instead.
    const target = r.prId ? `PR ${r.prId}` : (r.wsId || (r.action === 'poll' ? (r.kind || 'all PRs') : '—'));
    rows.push([r.id, r.action, r.status, target, r.title || '', r.instructions || '', r.note || '']);
  }
  console.log(table(rows));
  console.log(`\n${requests.length} request(s)`);
}

// Enqueue a job from the CLI — the same queue the web UI feeds via POST /api/requests, so
// automation (e.g. the /flowlever:poll scheduled pass) can enqueue without the server running.
// --dedupe makes the call idempotent: if a queued/running request already targets the same
// action + prId/wsId/kind, report that one instead of stacking a duplicate.
function cmdRequestsAdd({ flags }) {
  const action = need(flags.action, '--action');
  if (flags.dedupe) {
    const existing = ledger.listRequests({}).find((r) => (r.status === 'queued' || r.status === 'running')
      && r.action === action
      && (flags.prId === undefined || r.prId === String(flags.prId))
      && (flags.wsId === undefined || r.wsId === String(flags.wsId))
      && (flags.kind === undefined || (r.kind || null) === String(flags.kind)));
    if (existing) {
      if (flags.json) return printJson({ ...existing, deduped: true });
      const what = existing.prId ? `PR ${existing.prId}` : (existing.wsId || existing.kind || '—');
      console.log(`Already ${existing.status}: ${existing.id}  ${existing.action}  ${what} (no duplicate queued)`);
      return;
    }
  }
  const request = ledger.addRequest({
    action,
    prId: flags.prId,
    wsId: flags.wsId,
    kind: flags.kind,
    title: flags.title,
    instructions: flags.instructions,
  });
  if (flags.json) return printJson(request);
  const target = request.prId ? `PR ${request.prId}` : (request.wsId || request.kind || '—');
  console.log(`Queued ${request.id}  ${request.action}  ${target}${request.title ? ` — ${request.title}` : ''}`);
}

// The compare-and-swap take: exactly one caller can claim a given queued request, which is what
// lets a runner drain the queue without a second runner (a scheduled poll, a manually-started
// watch) picking up and re-executing the same job. Optionally narrowed to a set of --actions.
function cmdRequestsClaim({ flags }) {
  const actions = flags.actions !== undefined
    ? String(flags.actions).split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  const request = ledger.claimNextRequest({ actions, by: flags.by });
  if (!request) {
    if (flags.json) return printJson(null);
    console.log('Nothing queued.');
    return;
  }
  if (flags.json) return printJson(request);
  const target = request.prId ? `PR ${request.prId}` : (request.wsId || request.kind || '—');
  console.log(`Claimed ${request.id}  ${request.action}  ${target}${request.title ? ` — ${request.title}` : ''}`);
}

function cmdRequestsDelete({ pos }) {
  const id = need(pos[0], '<id>');
  ledger.deleteRequest(id);
  console.log(`Dismissed request ${id}`);
}

function cmdRequestsSet({ pos, flags }) {
  const id = need(pos[0], '<id>');
  const change = {};
  if (flags.status !== undefined) {
    if (!ledger.REQUEST_STATUSES.includes(flags.status)) {
      throw userError(`--status must be one of ${ledger.REQUEST_STATUSES.join(', ')} (got '${flags.status}')`);
    }
    change.status = flags.status;
  }
  if (flags.note !== undefined) change.note = flags.note;
  if (flags.wsId !== undefined) change.wsId = flags.wsId;
  if (flags.phase !== undefined) change.phase = flags.phase;
  if (flags['needs-input'] && flags['no-needs-input']) {
    throw userError('Use either --needs-input or --no-needs-input, not both');
  }
  if (flags['needs-input']) change.needsInput = true;
  if (flags['no-needs-input']) change.needsInput = false;
  if (change.status === undefined && change.note === undefined && change.wsId === undefined
      && change.phase === undefined && change.needsInput === undefined) {
    throw userError('Nothing to change: pass --status, --note, --wsId, --phase and/or --needs-input/--no-needs-input');
  }
  const request = ledger.setRequestStatus(id, change);
  const target = request.prId ? `PR ${request.prId}` : (request.wsId || '—');
  const phaseStr = request.phase ? `  · ${request.phase}` : '';
  const needsStr = request.needsInput ? '  ⚠ needs input' : '';
  console.log(`${request.id}  ${request.action}  ${request.status}${phaseStr}${needsStr}  ${target}${request.note ? ` — ${request.note}` : ''}`);
}

function cmdCoverageSet({ pos, flags }) {
  const featureId = need(pos[0], '<featureId>');
  const file = need(flags.file, '--file');
  const data = readJsonFile(file, 'coverage');
  const coverage = Array.isArray(data) ? data : data && data.coverage;
  if (!Array.isArray(coverage)) {
    throw userError(`'${file}' must be a JSON array of coverage entries or { "coverage": [...] }`);
  }
  ledger.setCoverage(featureId, coverage);
  console.log(`Coverage updated for ${featureId}: ${coverage.length} entr${coverage.length === 1 ? 'y' : 'ies'}`);
}

async function cmdDemo({ flags }) {
  const demo = require('./demo.js');
  // demo.seed() unconditionally rm's features/ledger/rounds for its fixed ids — including
  // "checkout-redesign" and "pr-482-checkout-api", plausible real workspace names — with no
  // guard of its own. demo.js is not this unit's to change, so the guard lives here instead.
  const existing = (demo.DEMO_IDS || []).filter((id) => {
    try { ledger.getFeature(id); return true; } catch { return false; }
  });
  if (existing.length && !flags.force) {
    throw userError(`This overwrites existing workspace(s): ${existing.join(', ')} — their `
      + 'features, ledger and round history will be deleted and reseeded. '
      + 'Pass --force to confirm: node src/cli.js demo --force');
  }
  const result = await demo.seed();
  const id = result && (result.id || (result.feature && result.feature.id));
  console.log(`Demo data seeded${id ? ` (feature: ${id})` : ''}.`);
  console.log('Try: node src/cli.js feature list   ·   node src/server.js');
}

function cmdStart({ flags }) {
  if (flags.port) process.env.PORT = String(flags.port);
  const port = process.env.PORT || '4173';
  const url = `http://localhost:${port}`;
  require('./server.js'); // boots server.listen() on require
  if (flags.open !== 'false' && !flags['no-open']) {
    const cp = require('node:child_process');
    const opener = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    setTimeout(() => {
      try { cp.spawn(opener, [url], { stdio: 'ignore', detached: true }).unref(); } catch { /* ignore */ }
    }, 500);
  }
  // server.listen keeps the process alive; nothing else to do.
}

// ---------- dispatch ----------

async function run(argv) {
  const { pos, flags } = parseArgs(argv);
  const [a, b] = pos;
  // `a` is undefined on a bare invocation (empty argv) — `cmd` must stay undefined too, so it
  // falls into the `case undefined` usage handler below instead of `cmd.includes(...)` throwing
  // before the switch is ever reached (that handler used to be unreachable dead code).
  const cmd = a === undefined ? undefined
    : (a === 'feature' || a === 'source' || a === 'finding' || a === 'coverage' || a === 'requests' || a === 'threads'
      ? `${a} ${b || ''}`.trim()
      : a);
  const rest = { pos: pos.slice(cmd !== undefined && cmd.includes(' ') ? 2 : 1), flags };

  ledger.initDataDir();

  switch (cmd) {
    case 'feature add': return cmdFeatureAdd(rest);
    case 'feature list': return cmdFeatureList(rest);
    case 'feature show': return cmdFeatureShow(rest);
    case 'feature delete': return cmdFeatureDelete(rest);
    case 'feature activity': return cmdFeatureActivity(rest);
    case 'feature summary': return cmdFeatureSummary(rest);
    case 'source add': return cmdSourceAdd(rest);
    case 'threads set': return cmdThreadsSet(rest);
    case 'threads list': return cmdThreadsList(rest);
    case 'ingest': return cmdIngest(rest);
    case 'finding list': return cmdFindingList(rest);
    case 'finding set': return cmdFindingSet(rest);
    case 'finding posted': return cmdFindingPosted(rest);
    case 'finding fixed': return cmdFindingFixed(rest);
    case 'finding unbacked': return cmdFindingUnbacked(rest);
    case 'finding cancel': return cmdFindingCancel(rest);
    case 'finding applied': return cmdFindingApplied(rest);
    case 'finding edit': return cmdFindingEdit(rest);
    case 'finding draft': return cmdFindingDraft(rest);
    case 'finding draft-clear': return cmdFindingDraftClear(rest);
    case 'finding review': return cmdFindingReview(rest);
    case 'readiness': return cmdReadiness(rest);
    case 'report': return cmdReport(rest);
    case 'coverage set': return cmdCoverageSet(rest);
    case 'requests list': return cmdRequestsList(rest);
    case 'requests add': return cmdRequestsAdd(rest);
    case 'requests claim': return cmdRequestsClaim(rest);
    case 'requests delete': return cmdRequestsDelete(rest);
    case 'requests set': return cmdRequestsSet(rest);
    case 'start': return cmdStart(rest);
    case 'demo': return cmdDemo(rest);
    case 'help':
    case undefined:
      console.log(USAGE);
      return;
    default:
      throw userError(`Unknown command '${pos.join(' ')}'\n\n${USAGE}`);
  }
}

(async () => {
  try {
    await run(process.argv.slice(2));
  } catch (err) {
    if (err && err.code === 'EUSER') {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(2);
  }
})();
