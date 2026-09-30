'use strict';

// FlowLever markdown report generator. Paste-ready for Confluence/Slack.

const ledger = require('./ledger');

const GLYPH = { blocker: '◆', major: '▲', minor: '●', info: '○' };
const SEV_ORDER = { blocker: 0, major: 1, minor: 2, info: 3 };
const GATE_BADGE = {
  ready: '🟢 `READY`',
  'in-progress': '🟡 `IN PROGRESS`',
  'not-ready': '🔴 `NOT READY`',
};
const COVERAGE_ICON = {
  covered: '✅ covered',
  partial: '🟡 partial',
  uncovered: '🔴 uncovered',
  orphan: '⚪ orphan',
};

// "On the board" = not yet resolved/waived (status open or reworking). This is a SUPERSET of what
// counts against the readiness score: posted/applied/pending findings stay on the board (still
// unaddressed) but ledger.computeReadiness excludes them from `openCount`/`openBySeverity` because
// that work is out of the reviewer's hands. Every place in this report that shows a count MUST say
// which of the two it means — "on board" or "scored" — never bare "open", which is ambiguous
// between the two (this ambiguity was C-9: the summary showed 0 scored while the board listed 1).
const isOnBoard = (f) => f.status === 'open' || f.status === 'reworking';
const glyph = (sev) => GLYPH[sev] || '·';
const day = (iso) => (typeof iso === 'string' && iso.length >= 10 ? iso.slice(0, 10) : '—');

// Why an on-board finding isn't scored right now, or null if it currently IS scored (i.e. it's
// genuinely open and gating). Mirrors ledger's isPosted/isApplied/isPending precedence exactly so
// this label can never disagree with computeReadiness's own exclusion order.
function boardLabel(f) {
  if (ledger.isPosted(f)) return 'posted — awaiting author';
  if (ledger.isApplied(f)) return 'applied — awaiting re-audit';
  if (ledger.isPending(f)) return 'pending — run in flight';
  return null;
}

// Escape for markdown table cells.
function cell(v) {
  if (v === null || v === undefined || v === '') return '—';
  return String(v).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

function mdTable(header, rows) {
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
  ];
  for (const row of rows) lines.push(`| ${row.map(cell).join(' | ')} |`);
  return lines.join('\n');
}

function sortBySeverity(findings) {
  return findings.slice().sort((a, b) =>
    (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9)
    || String(a.title).localeCompare(String(b.title)));
}

function dimensionOrder(dimensions) {
  let configured = [];
  try {
    const config = ledger.loadConfig();
    if (config && Array.isArray(config.dimensions)) configured = config.dimensions;
  } catch { /* fall back to alphabetical */ }
  const known = configured.filter((d) => dimensions.has(d));
  const extra = [...dimensions].filter((d) => !configured.includes(d)).sort();
  return [...known, ...extra];
}

function generateReport(featureId) {
  const feature = ledger.getFeature(featureId);
  const ledgerDoc = ledger.loadLedger(featureId);
  const roundsDoc = ledger.loadRounds(featureId);
  const ready = ledger.readiness(featureId);

  const findings = Array.isArray(ledgerDoc) ? ledgerDoc : (ledgerDoc && ledgerDoc.findings) || [];
  const rounds = Array.isArray(roundsDoc) ? roundsDoc : (roundsDoc && roundsDoc.rounds) || [];

  const onBoard = findings.filter(isOnBoard);
  const waived = findings.filter((f) => f.status === 'waived');
  const resolved = findings.filter((f) => f.status === 'resolved');
  const reworking = findings.filter((f) => f.status === 'reworking');
  // Board blockers vs. scored blockers: same underlying set, but `ready.blockers` (from a fresh
  // ledger.readiness() read) excludes posted/applied/pending ones. Match by fp — the two reads are
  // separate loadLedger() calls, so object identity can't be relied on.
  const boardBlockers = sortBySeverity(onBoard.filter((f) => f.severity === 'blocker'));
  const scoredBlockerFps = new Set((ready.blockers || []).filter((f) => f.fp).map((f) => f.fp));
  const gatingBlockers = boardBlockers.filter((f) => f.fp && scoredBlockerFps.has(f.fp));
  const shadowBlockers = boardBlockers.filter((f) => !(f.fp && scoredBlockerFps.has(f.fp)));
  const lastRound = rounds.length ? rounds[rounds.length - 1] : null;

  const md = [];

  // ----- Title + badges -----
  md.push(`# ${feature.title} — Spec Readiness Report`);
  md.push('');
  md.push(`**Feature:** \`${feature.id}\` · **Status:** ${feature.status} · **Readiness:** **${ready.score} / 100** ${GATE_BADGE[ready.gate] || `\`${ready.gate}\``}`);
  md.push('');
  md.push(`_Generated ${new Date().toISOString()} by FlowLever${lastRound ? ` · after round ${lastRound.n}` : ''}_`);
  md.push('');

  // ----- Executive summary -----
  md.push('## Executive summary');
  md.push('');
  const sevBits = ['blocker', 'major', 'minor', 'info']
    .map((s) => `${glyph(s)} ${(ready.openBySeverity && ready.openBySeverity[s]) || 0} ${s}`)
    .join(' · ');
  // "Open findings (scored)" is exactly ready.openCount — what the gate above is computed from.
  // "On the board" is the wider, always-≥ count that also includes posted/applied/pending
  // findings — still unresolved, but deliberately not weighing on the score. Showing both, with
  // names that can't be confused, is how this report stays self-consistent (see C-9).
  const notScored = onBoard.length - ready.openCount;
  md.push(mdTable(['Metric', 'Value'], [
    ['Readiness score', `${ready.score} / 100`],
    ['Gate', `${GATE_BADGE[ready.gate] || ready.gate}`],
    ['Open findings (scored)', `${ready.openCount} (${sevBits})`],
    ['On the board (incl. posted/applied/pending)', `${onBoard.length}${notScored > 0 ? ` (${notScored} not scored — see note below)` : ''}`],
    ['In rework', reworking.length],
    ['Resolved', resolved.length],
    ['Waived', waived.length],
    ['Audit rounds', rounds.length ? `${rounds.length} (last: ${day(lastRound.at)})` : 'none yet'],
  ]));
  md.push('');
  if (notScored > 0) {
    // The one note the whole file exists to guarantee: if the badge above says READY (or the
    // score looks better than the board suggests) while something is still unresolved, explain
    // why right here, in place — never leave a reader to reconcile two tables on their own.
    const blockerCallout = shadowBlockers.length
      ? ` — including ${shadowBlockers.length} blocker${shadowBlockers.length === 1 ? '' : 's'} that would otherwise gate readiness (see 🚧 Blocking below)`
      : '';
    md.push(`_${notScored} finding${notScored === 1 ? '' : 's'} on the board ${notScored === 1 ? 'is' : 'are'} posted, applied, or pending: still unresolved, but excluded from the score above because that work is out of the reviewer's hands${blockerCallout}._`);
    md.push('');
  }

  // ----- Blocking -----
  md.push('## 🚧 Blocking');
  md.push('');
  if (!gatingBlockers.length) {
    md.push('_No blockers are gating the readiness score right now._');
    md.push('');
  } else {
    for (const f of gatingBlockers) {
      md.push(`### ◆ ${f.title}`);
      md.push('');
      if (f.locus) md.push(`- **Where:** \`${f.locus}\``);
      if (f.detail) md.push(`- **Detail:** ${f.detail}`);
      if (f.suggestion) md.push(`- **Suggestion:** ${f.suggestion}`);
      md.push(`- _Status: ${f.status}${f.pinned ? ' · 📌 pinned' : ''} · since round ${f.firstSeenRound} · fp \`${f.fp}\`_`);
      md.push('');
    }
  }
  if (shadowBlockers.length) {
    // These ARE blocker-severity and still on the board, but posted/applied/pending — the reason
    // the gate above can read READY (or in-progress) while a blocker-labeled row exists elsewhere
    // in this document. Naming that explicitly here is what keeps the two sections from
    // contradicting each other.
    md.push(`_${shadowBlockers.length} more blocker${shadowBlockers.length === 1 ? '' : 's'} on the board, not gating the score (posted/applied/pending):_`);
    md.push('');
    for (const f of shadowBlockers) {
      md.push(`### ◆ ${f.title} _(${boardLabel(f)})_`);
      md.push('');
      if (f.locus) md.push(`- **Where:** \`${f.locus}\``);
      if (f.detail) md.push(`- **Detail:** ${f.detail}`);
      if (f.suggestion) md.push(`- **Suggestion:** ${f.suggestion}`);
      md.push(`- _Status: ${f.status}${f.pinned ? ' · 📌 pinned' : ''} · since round ${f.firstSeenRound} · fp \`${f.fp}\`_`);
      md.push('');
    }
  }

  // ----- Findings on the board, by dimension -----
  // Deliberately titled "on the board", not "open": this section lists everything unresolved,
  // including posted/applied/pending findings that the Executive summary's score excludes (C-9).
  // The "Scored" column says, per row, whether that specific finding currently counts.
  md.push('## Findings on the board, by dimension');
  md.push('');
  if (!onBoard.length) {
    md.push('_Nothing on the board — no unresolved findings._');
    md.push('');
  } else {
    const byDim = new Map();
    for (const f of onBoard) {
      if (!byDim.has(f.dimension)) byDim.set(f.dimension, []);
      byDim.get(f.dimension).push(f);
    }
    for (const dim of dimensionOrder(new Set(byDim.keys()))) {
      const items = sortBySeverity(byDim.get(dim));
      const scoredHere = items.filter((f) => !boardLabel(f)).length;
      md.push(`### ${dim} (${items.length} on board · ${scoredHere} scored)`);
      md.push('');
      md.push(mdTable(
        ['Severity', 'Title', 'Locus', 'Status', 'Scored', 'Since round'],
        items.map((f) => {
          const label = boardLabel(f);
          return [
            `${glyph(f.severity)} ${f.severity}`,
            f.title,
            f.locus ? `\`${cell(f.locus)}\`` : '—',
            f.status + (f.pinned ? ' 📌' : ''),
            label ? `⏸ no — ${label}` : '✅ yes',
            f.firstSeenRound,
          ];
        }),
      ));
      md.push('');
    }
  }

  // ----- Coverage matrix -----
  md.push('## Coverage matrix');
  md.push('');
  const sections = feature.specSections || [];
  const coverage = feature.coverage || [];
  if (!sections.length && !coverage.length) {
    md.push('_No coverage data yet — run an audit with coverage mapping._');
    md.push('');
  } else {
    const covByKey = new Map(coverage.filter((c) => c.sectionKey).map((c) => [c.sectionKey, c]));
    const rows = [];
    for (const s of sections) {
      const c = covByKey.get(s.key);
      rows.push([
        s.title || s.key,
        c && (c.adoIds || []).length ? c.adoIds.map((id) => `AB#${id}`).join(', ') : '—',
        c && (c.figmaNodeIds || []).length ? c.figmaNodeIds.map((n) => `\`${n}\``).join(', ') : '—',
        c ? (COVERAGE_ICON[c.status] || c.status) : COVERAGE_ICON.uncovered,
      ]);
    }
    // Orphans: coverage entries without a (known) spec section.
    const knownKeys = new Set(sections.map((s) => s.key));
    for (const c of coverage) {
      if (c.sectionKey && knownKeys.has(c.sectionKey)) continue;
      rows.push([
        c.sectionKey ? `(unknown section: ${c.sectionKey})` : '(no spec section)',
        (c.adoIds || []).map((id) => `AB#${id}`).join(', ') || '—',
        (c.figmaNodeIds || []).map((n) => `\`${n}\``).join(', ') || '—',
        COVERAGE_ICON[c.status] || c.status || COVERAGE_ICON.orphan,
      ]);
    }
    md.push(mdTable(['Spec section', 'ADO', 'Figma', 'Status'], rows));
    md.push('');
  }

  // ----- Waived findings -----
  if (waived.length) {
    md.push('## Waived findings');
    md.push('');
    md.push(mdTable(
      ['Severity', 'Title', 'Reason', 'Waived on'],
      sortBySeverity(waived).map((f) => [
        `${glyph(f.severity)} ${f.severity}`,
        f.title,
        f.statusReason || '—',
        day(f.updatedAt),
      ]),
    ));
    md.push('');
  }

  // ----- Round timeline -----
  md.push('## Round timeline');
  md.push('');
  if (!rounds.length) {
    md.push('_No audit rounds yet._');
  } else {
    // r.stats.totalOpen is computed by ledger.ingestRound from the same open-or-reworking notion
    // as "on board" above (it predates posted/applied/pending and includes them too) — labeled
    // to match, so it doesn't read as the "scored" count from the Executive summary.
    md.push(mdTable(
      ['Round', 'Date', 'New', 'Auto-resolved', 'Regressions', 'On board', 'Score', 'Note'],
      rounds.map((r) => [
        r.n,
        day(r.at),
        r.stats ? r.stats.new : '—',
        r.stats ? r.stats.autoResolved : '—',
        r.stats ? r.stats.regressions : '—',
        r.stats ? r.stats.totalOpen : '—',
        r.readiness ? `${r.readiness.score}` : '—',
        r.note || '',
      ]),
    ));
  }
  md.push('');

  return md.join('\n');
}

module.exports = { generateReport };
