/* FlowLever dashboard — vanilla ES2022, zero deps.
 * Talks to the HTTP API in docs/SCHEMA.md (same origin, /api). */
'use strict';

/* ============================== constants ============================== */

const SEV_ORDER = ['blocker', 'major', 'minor', 'info'];
const SEV = {
  blocker: { glyph: '◆', label: 'blocker' },  // ◆
  major:   { glyph: '▲', label: 'major' },    // ▲
  minor:   { glyph: '●', label: 'minor' },    // ●
  info:    { glyph: '○', label: 'info' },     // ○
};
const GATE = {
  'ready':       { label: 'Ready' },
  'in-progress': { label: 'In progress' },
  'not-ready':   { label: 'Not ready' },
};
const DIMENSIONS = ['consistency', 'completeness', 'testability', 'design-match', 'dor', 'ambiguity', 'feasibility'];
const STATUS_COLS = [
  { key: 'open',      label: 'Open' },
  { key: 'reworking', label: 'Reworking' },
  { key: 'resolved',  label: 'Resolved' },
  { key: 'waived',    label: 'Waived' },
];
/* The bands a list view draws, top to bottom, and how much of each row it spends on them.
 * "Needs you" earns the full row because that is where you actually decide something; the rest
 * only has to identify the row and say why it is parked, so it gets a compact one. Four bands with
 * every row at full detail is the thing this replaces — a flat wall in which the two PRs waiting
 * on YOU look exactly like the nine that are waiting on someone else. */
const WS_BANDS = [
  { key: 'needs-you',   label: 'Needs you',         density: 'full'    },
  { key: 'in-progress', label: 'In progress',       density: 'compact' },
  { key: 'waiting',     label: 'Waiting on others', density: 'compact' },
];
/* Every state a row can be in, ordered: position in this array IS the rank, across the whole
 * list. One table, deliberately — the same reason ledger.js's WORKSPACE_STATES is one table. A
 * separate "which band" map and "which sorts first" list drift apart, and the symptom is a row
 * drawn under one header but ordered as if it belonged under another. A `rank:` number here would
 * be that second copy in miniature, so there isn't one.
 *
 * The `job-*` states are the browser's own: they describe what a live runner is doing right now,
 * which outranks whatever the ledger last computed. The rest mirror ledger.js's WORKSPACE_STATES
 * one-for-one (minus `done`, which keeps its collapsed disclosure) — test/server.test.js pins that
 * agreement, because two taxonomies that disagree is the whole risk of splitting them. */
const WS_STATES = [
  { key: 'job-attention',    band: 'needs-you',   label: 'Needs attention'     },
  { key: 'ready-to-post',    band: 'needs-you',   label: 'Ready to post'       },
  { key: 'needs-review',     band: 'needs-you',   label: 'New — to review'     },
  { key: 'needs-rereview',   band: 'needs-you',   label: 'Re-review'           },
  { key: 'author-responded', band: 'needs-you',   label: 'Author responded'    },
  { key: 'needs-approval',   band: 'needs-you',   label: 'Ready to approve'    },
  { key: 'job-posting',      band: 'in-progress', label: 'Posting review'      },
  { key: 'job-rereviewing',  band: 'in-progress', label: 'Re-reviewing'        },
  { key: 'job-reviewing',    band: 'in-progress', label: 'Reviewing'           },
  { key: 'job-polling',      band: 'in-progress', label: 'Checking for updates'},
  { key: 'job-summarizing',  band: 'in-progress', label: 'Writing summary'      },
  { key: 'posting',          band: 'in-progress', label: 'Posting…'            },
  { key: 'awaiting-author',  band: 'waiting',     label: 'Waiting on author'   },
  { key: 'awaiting-reaudit', band: 'waiting',     label: 'Waiting on re-audit' },
  { key: 'settled',          band: 'waiting',     label: 'Settled'             },
];
/* Rank = index, resolved once. Nothing else may express the order. */
const WS_STATE_INDEX = new Map(WS_STATES.map((s, i) => [s.key, { ...s, rank: i }]));
/* Where an unrecognised state lands. A summary served by an older cockpit carries no `state` at
 * all, and an unlabelled band — or a crash — is a far worse answer than "parked, nothing to do". */
const WS_FALLBACK_STATE = 'settled';
function wsState(key) { return WS_STATE_INDEX.get(key) || WS_STATE_INDEX.get(WS_FALLBACK_STATE); }

/* The `job-*` labels in each kind's OWN words. Only the words: which band a live job lands in is
 * categoryOf()'s decision and does not move, because "a runner is mid-way through this" is the same
 * fact whatever the workspace is. What is not the same is what the runner is DOING.
 *
 * WS_STATES' defaults are the pr-review ones, and they leaked: a running spec audit wore the pill
 * "Re-reviewing" and a spec apply wore "Posting review" — both naming a pull request the workspace
 * does not have. (True on Home since ce22adf; 4406176 put it on #/spec too, beside a card whose own
 * loop strip says "Audit".) The repo already has the vocabulary, in REVIEW_NOUN and
 * LOOP_STAGES_BY_KIND: a spec is AUDITED and its accepted changes are APPLIED back to Confluence and
 * ADO, a pr-review is reviewed and POSTED as comments, a pr-respond REPLIES to reviewer threads.
 *
 * Only the states a kind can actually reach need an entry — `job-polling` is PR discovery and never
 * binds a spec, and the non-job states are the server's own and already kind-neutral. Anything
 * missing falls through to the WS_STATES label, which is where pr-review's own words stay. */
const JOB_LABELS_BY_KIND = {
  spec: {
    'job-posting':     'Applying changes',
    'job-rereviewing': 'Re-auditing',
    'job-reviewing':   'Auditing',
  },
  'pr-respond': {
    'job-posting':     'Posting replies',
    'job-rereviewing': 'Re-checking threads',
    'job-reviewing':   'Responding',
  },
};
/* The label for a state as THIS kind says it. `kind` may be absent — a row drawn before its
 * workspace exists has none — and then the table's default wording stands, exactly as it did. */
function wsStateLabel(key, kind) {
  const per = JOB_LABELS_BY_KIND[kind];
  return (per && per[key]) || wsState(key).label;
}

// Defaults matching ledger.js's DEFAULT_CONFIG — used only for the optimistic readiness
// recompute, and only until GET /api/config answers (fetched at boot, see loadLiveConfig
// below). The server's value is authoritative either way and reconciled after every POST;
// this is what keeps the OPTIMISTIC number from drifting the moment someone edits
// config.json's documented severityWeights/readyThreshold (F-5).
const SEVERITY_WEIGHTS = { blocker: 10, major: 5, minor: 2, info: 0.5 };
const READY_THRESHOLD = 85;
const SCORE_ZERO_AT_PENALTY = 40;
let liveConfig = null;   // { severityWeights, gates: { readyThreshold, scoreZeroAtPenalty } } once fetched

async function loadLiveConfig() {
  try { liveConfig = await api('/api/config'); } catch { /* keep the fallback constants */ }
  // Read-only rides on the config response, so the banner can go up as soon as the page knows.
  if (readOnlyMode()) showReadOnlyBanner();
}

/* Whether the server refused writes for this session (FLOWLEVER_READONLY=1). Unknown until
 * /api/config answers, and deliberately defaults to FALSE while unknown: guessing "read-only"
 * would disable the whole cockpit on a slow first request, which is a worse failure than briefly
 * offering a control that the server would refuse anyway. */
function readOnlyMode() { return !!(liveConfig && liveConfig.readOnly); }

const READ_ONLY_TITLE = 'Read-only mode (FLOWLEVER_READONLY=1) — this cannot change anything. '
  + 'Restart the cockpit without it to make changes.';

const ICONS = {
  pin: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16v6"/><path d="M9 3h6l-1 6 3.5 3.5a1 1 0 0 1-.7 1.5H7.2a1 1 0 0 1-.7-1.5L10 9z"/></svg>',
  confluence: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h6"/></svg>',
  ado: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 12l2.5 2.5L15.5 9.5"/></svg>',
  figma: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5z"/><path d="M3 14.5l9 5 9-5"/></svg>',
  link: '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>',
  // kind glyphs (lucide-style: file-text / git-pull-request / reply-in-bubble)
  kindSpec: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h4"/></svg>',
  kindReview: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M6 8.5v7"/><circle cx="18" cy="18" r="2.5"/><path d="M18 15.5V12a4 4 0 0 0-4-4h-3"/><path d="M13 5l-2 3 2 3"/></svg>',
  kindRespond: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/><path d="M11 8l-3 3 3 3"/><path d="M8 11h6a2 2 0 0 1 2 2v1"/></svg>',
  // source-role glyphs (lucide-style). A PR, the story it implements and the epic above it used to
  // share one checkbox icon, so telling them apart meant reading the title — the thing you click
  // BEFORE you have read it. Each role gets its own silhouette.
  srcPr: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M6 8.5v7"/><circle cx="18" cy="18" r="2.5"/><path d="M18 15.5V12a4 4 0 0 0-4-4h-3"/><path d="M13 5l-2 3 2 3"/></svg>',
  srcStory: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 5a2 2 0 0 1 2-2h5a3 3 0 0 1 3 3v13a2.5 2.5 0 0 0-2.5-2.5H2z"/><path d="M22 5a2 2 0 0 0-2-2h-5a3 3 0 0 0-3 3v13a2.5 2.5 0 0 1 2.5-2.5H22z"/></svg>',
  srcBug: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="6" width="8" height="14" rx="4"/><path d="M8 11H4M20 11h-4M8 16H4.5M20 16h-3.5M9 6.5L7 4M15 6.5L17 4"/></svg>',
  srcTask: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 12l2.5 2.5L15.5 9.5"/></svg>',
  srcEpic: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l9 4.5-9 4.5-9-4.5z"/><path d="M3 12l9 4.5 9-4.5"/><path d="M3 16.5L12 21l9-4.5"/></svg>',
  // clipboard-copy, and its "done" twin — the copy button swaps glyph on success so the feedback
  // is on the control you pressed, not only in a toast that may be off-screen.
  copy: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  copied: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>',
  // the "open this elsewhere" arrow, at control size (ICONS.link is the 10px in-chip version)
  openExternal: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8"/></svg>',
};

/* The three workflow kinds a workspace can host. Each rides the SAME finding model
 * + stepper; only the label/icon/tint differ. `spec` is the default + back-compat. */
const KIND = {
  spec:         { label: 'Spec',       section: '#/spec',       icon: 'kindSpec' },
  'pr-review':  { label: 'PR Review',  section: '#/pr-review',  icon: 'kindReview' },
  'pr-respond': { label: 'PR Respond', section: '#/pr-respond', icon: 'kindRespond' },
};
function kindMeta(kind) { return KIND[kind] || KIND.spec; }

function kindBadge(kind) {
  const m = kindMeta(kind);
  return h('span', { class: `kind-badge kind-${cssSafe(kind)}` },
    h('span', { class: 'kind-icon', html: ICONS[m.icon] || '' }),
    m.label);
}

/* ============================== state ============================== */

const state = {
  detailId: null,
  detail: null,            // { feature, ledger, rounds, readiness }
  filters: { dims: new Set(), sevs: new Set(), status: 'all', q: '', draft: false },
  waiving: null,           // fp showing the inline waive form
  diffMode: 'rendered',    // 'rendered' | 'unified' | 'split' — proposed-change view (sticky pref).
                           // 'rendered' shows markdown/gherkin formatted; raw diff falls back to unified.
  editingHunk: null,       // { fp, idx } — hunk whose inline edit textarea is open
  modalFp: null,           // fp whose finding modal is open (one at a time)
  modalMode: 'detail',     // 'detail' | 'review' — which sub-view the modal is showing
  modalTrigger: null,      // element to restore focus to when the modal closes
  exportFp: null,          // fp whose per-finding export panel is open
  exportAll: false,        // feature-level "export all reviewed" panel open
  report: { id: null, md: null },
  // guided review flow (the stepper). `items` is a snapshot of reviewable fps
  // taken when the flow launches; `decisions` is the per-finding flow decision
  // (accept/edit/redirect/waive/skip) — the actual edits persist via the draft
  // review API, this just records which path the reviewer chose.
  flow: { active: false, finish: false, featureId: null, items: null, idx: 0, decisions: {}, waiving: null, editingComment: null, persistFailed: {} },
  section: { kind: null, features: [] },   // cached summaries for the open section, re-bound to live jobs each poll
  home: { rows: [] },      // cached inbox rows, re-banded against the live jobs on every poll tick
  runner: null,            // last GET /api/runner — is a session draining the queue right now?
};
const current = { view: null, id: null, tab: null };
let routeSeq = 0;

/* Footer appended to AI-drafted PR comments/replies when the post toggle is on (the default). */
const DISCLOSURE_LINE = '🤖 AI comment posted by Claude';

/* The API contract this build of the UI expects — must match src/version.js. A browser reload always
 * gets the newest app.js, but src/server.js is only read when the cockpit process starts, so an
 * updated plugin + a long-running server means the page calls routes the server has never heard of.
 * That used to surface as a bare "Not found"; now it says which half is stale. */
const EXPECTED_API_VERSION = '5';

/* ============================== tiny DOM lib ============================== */

const $ = (sel, root = document) => root.querySelector(sel);

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

/* h(tag, attrs, ...children) — children that are strings/numbers become text
 * nodes (XSS-safe). attrs.html is reserved for TRUSTED constant markup only. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
}

function cssSafe(s) { return String(s ?? '').toLowerCase().replace(/[^a-z0-9-]/g, ''); }
function safeHref(u) { return /^(https?:|\/|#)/i.test(String(u ?? '')) ? String(u) : null; }

function fmtDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtDateTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}
/* Compact relative age — "just now", "12m ago", "3h ago", "2d ago", then an absolute date.
 * Used for the review/activity stamps, where "how long ago" is the question being asked;
 * the absolute time always rides along in the element's title attribute. */
function fmtAgo(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const secs = Math.round((Date.now() - t) / 1000);
  if (secs < 0) return fmtDateTime(iso);         // clock skew / future stamp — show it plainly
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return fmtDate(iso);
}
function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

/* ============================== review / activity stamps ============================== */

/* The two timestamps that answer "can I re-review yet?":
 *   lastReviewedAt — when WE last reviewed (the last ingest round; a round IS a review pass)
 *   lastActivityAt — when the OTHER side last touched the PR (their newest comment/commit),
 *                    recorded by the runner from ADO, with lastActivityBy naming who.
 * `newSinceReview` = their update landed after our last round, so a re-review would see
 * something new. Works off either shape: an API summary row (which carries `stamps`) or a
 * full detail payload ({ feature, rounds }). */
function reviewStampsOf(source) {
  if (source && source.stamps) return source.stamps;
  const feature = (source && source.feature) || source || {};
  const rv = feature.review || {};
  const rounds = (source && source.rounds && source.rounds.rounds) || [];
  const lastReviewedAt = rounds.length ? rounds[rounds.length - 1].at : (source && source.lastRoundAt) || null;
  const lastActivityAt = rv.lastActivityAt || null;
  const newer = lastActivityAt
    && !Number.isNaN(Date.parse(lastActivityAt))
    && (!lastReviewedAt || Number.isNaN(Date.parse(lastReviewedAt))
        || Date.parse(lastActivityAt) > Date.parse(lastReviewedAt));
  return {
    lastReviewedAt,
    lastActivityAt,
    lastActivityBy: rv.lastActivityBy || null,
    lastPostedAt: rv.lastPostedAt || null,
    authorRespondedAt: rv.authorRespondedAt || null,
    newSinceReview: Boolean(newer),
  };
}

/* One stamp: "<label> <relative> [by <who>]", with the exact timestamp in the tooltip. */
function stampEl(label, iso, extraClass = '', who = '') {
  const rel = fmtAgo(iso);
  if (!rel) return null;
  return h('span', {
    class: `stamp ${extraClass}`.trim(),
    title: `${label}: ${fmtDateTime(iso) || iso}${who ? ` by ${who}` : ''}`,
  },
  h('span', { class: 'stamp-label' }, label),
  h('span', { class: 'stamp-val' }, rel),
  who ? h('span', { class: 'stamp-who' }, `by ${who}`) : null);
}

/* The stamps line for a PR workspace: when we reviewed, when the PR was last updated by the
 * other side (and by whom), and — when their update is newer than our review — a "new since
 * your review" marker, which is exactly the "you can re-review now" signal. `compact` drops
 * the posted stamp (used on rows, where space is tight). */
function reviewStampsRow(source, kind, { compact = false, cls = 'review-stamps' } = {}) {
  if (kind !== 'pr-review' && kind !== 'pr-respond') return null;
  const s = reviewStampsOf(source);
  if (!s.lastReviewedAt && !s.lastActivityAt && !s.lastPostedAt) return null;
  const bits = [
    stampEl('Reviewed', s.lastReviewedAt),
    !compact ? stampEl('Posted', s.lastPostedAt) : null,
    stampEl('PR updated', s.lastActivityAt, s.newSinceReview ? 'stamp-new' : '', s.lastActivityBy || ''),
  ].filter(Boolean);
  if (!bits.length) return null;
  if (s.newSinceReview) {
    bits.push(h('span', {
      class: 'stamp-flag',
      title: 'The PR changed after our last review round — a re-review will pick up the delta.',
    }, '● new since your review'));
  }
  return h('div', { class: cls }, bits);
}

/* ============================== round helpers ============================== */

function currentRoundNum() {
  if (!state.detail || !state.detail.rounds) return null;
  const rounds = state.detail.rounds.rounds || [];
  return rounds.length > 0 ? rounds[rounds.length - 1].n : null;
}

function findingBadge(f, currentRound) {
  if (currentRound == null) return null;
  // Once a finding has been acted on — resolved, waived, in-flight, posted or applied — it is no
  // longer "new"/"regressed" to the reviewer; those badges only describe untouched open work.
  if (f.status === 'resolved' || f.status === 'waived' || isInFlightOrOut(f)) return null;
  // NEW = a freshly surfaced finding that hasn't been triaged yet (still Open).
  if (f.status === 'open' && f.firstSeenRound === currentRound) return 'new';
  const hist = Array.isArray(f.history) ? f.history : [];
  // Explicitly reopened by reconcile in this round
  if (hist.some((h) => h.to === 'open' && h.by === 'reconcile' &&
      String(h.note || '').includes(`round ${currentRound}`))) return 'regressed';
  // Open finding last seen this round that was previously resolved and then reopened
  if (f.lastSeenRound === currentRound && f.firstSeenRound < currentRound) {
    if (hist.some((h) => h.to === 'resolved') && hist.some((h) => h.to === 'open' || h.to === 'reworking')) {
      return 'regressed';
    }
  }
  return null;
}

function deriveRoundFindings(findings, n) {
  const newF = [], autoResolved = [], regressed = [];
  for (const f of findings) {
    if (f.firstSeenRound === n) newF.push(f);
    if (f.resolvedInRound === n) {
      const hist = f.history || [];
      if (hist.some((h) => h.to === 'resolved' && h.by === 'reconcile')) autoResolved.push(f);
    }
    const hist = f.history || [];
    if (hist.some((h) => h.to === 'open' && h.by === 'reconcile' &&
        String(h.note || '').includes(`round ${n}`))) regressed.push(f);
  }
  return { newF, autoResolved, regressed };
}

/* ============================== toasts ============================== */

function toast(msg, kind = 'error') {
  const t = h('div', { class: `toast toast-${cssSafe(kind)}`, role: 'status' }, msg);
  $('#toasts').append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 200);
  }, 4500);
}

/* ============================== api ============================== */

async function api(path, opts = {}) {
  // Refuse writes locally in read-only mode instead of letting each one round-trip to a 403.
  // Every caller already handles a rejected api() — toasts, the "not saved — retry" affordance,
  // the optimistic rollbacks — so failing here reuses all of that and gives one consistent
  // sentence, rather than each surface inventing its own reading of a server error.
  const method = (opts.method || 'GET').toUpperCase();
  if (readOnlyMode() && method !== 'GET' && method !== 'HEAD') {
    throw new Error('read-only mode (FLOWLEVER_READONLY=1) — nothing was changed');
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new Error('network unreachable');
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.text();
      try {
        const j = JSON.parse(body);
        msg = j.error || j.message || msg;
      } catch { if (body && body.length < 200) msg = body; }
    } catch { /* keep status text */ }
    throw new Error(msg);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}

/* ============================== readiness (optimistic) ============================== */

function computeReadiness(findings) {
  const weights = (liveConfig && liveConfig.severityWeights) || SEVERITY_WEIGHTS;
  const gates = (liveConfig && liveConfig.gates) || {};
  const readyThreshold = gates.readyThreshold ?? READY_THRESHOLD;
  const scoreZeroAtPenalty = gates.scoreZeroAtPenalty || SCORE_ZERO_AT_PENALTY;
  const openBySeverity = { blocker: 0, major: 0, minor: 0, info: 0 };
  let penalty = 0;
  for (const f of findings || []) {
    if (f.status !== 'open' && f.status !== 'reworking') continue;
    if (isInFlightOrOut(f)) continue;   // posted/applied/in-flight = not open reviewer work → no penalty
    if (openBySeverity[f.severity] != null) openBySeverity[f.severity]++;
    penalty += weights[f.severity] ?? 0;
  }
  const score = Math.max(0, Math.round(100 - (penalty * 100) / scoreZeroAtPenalty));
  let gate = 'in-progress';
  if (openBySeverity.blocker > 0) gate = 'not-ready';
  else if (score >= readyThreshold) gate = 'ready';
  return { score, gate, openBySeverity };
}

/* ============================== shared widgets ============================== */

function arcPath(cx, cy, r, a0deg, a1deg) {
  const a0 = ((a0deg - 90) * Math.PI) / 180;
  const a1 = ((a1deg - 90) * Math.PI) / 180;
  const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
  const large = a1deg - a0deg > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/* Readiness dial: 270° instrument gauge, colored by gate. Numeric inputs only. */
function dialEl(score, gate, size, extraClass = '') {
  const n = Math.max(0, Math.min(100, Number(score) || 0));
  const cx = size / 2, cy = size / 2, r = size / 2 - 5;
  const start = -135, sweep = 270;
  const end = start + (sweep * n) / 100;
  const gateCls = GATE[gate] ? cssSafe(gate) : 'unknown';
  const wrap = h('div', {
    class: `dial dial-${gateCls} ${extraClass}`.trim(),
    style: `width:${size}px;height:${size}px`,
    role: 'img',
    'aria-label': `readiness ${Math.round(n)} of 100`,
  });
  wrap.innerHTML =
    `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">` +
    `<path class="dial-track" d="${arcPath(cx, cy, r, start, start + sweep)}"/>` +
    (n > 0.5 ? `<path class="dial-prog" d="${arcPath(cx, cy, r, start, end)}"/>` : '') +
    `</svg><div class="dial-num">${Math.round(n)}</div>`;
  return wrap;
}

/* "Mark review complete" / "Reopen" — sets the workspace's lifecycle status to `done`
 * (or back to `reworking`). A done workspace reads as completed everywhere: a green check
 * in the header, a done chip on its row, and it drops out of the "needs you" inbox. */
function completeControl(feature) {
  const done = feature.status === 'done';
  return h('button', {
    class: `btn btn-complete ${done ? 'is-done' : ''}`.trim(), type: 'button',
    title: done ? 'Reopen this review (back to in-progress)' : 'Mark this review complete — it shows as done and leaves the inbox',
    onclick: () => setFeatureStatus(done ? 'reworking' : 'done'),
  }, done ? '↩ Reopen review' : '✓ Mark review complete');
}

async function setFeatureStatus(status) {
  try {
    await api(`/api/features/${encodeURIComponent(current.id)}/status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    await loadDetail(current.id, true);
    rerenderDetail();
    toast(status === 'done' ? 'Review marked complete' : 'Review reopened', 'success');
  } catch (e) {
    toast(`Could not update status: ${e.message}`);
  }
}

/* The lifecycle value a workspace carries until something moves it — and the value `statusChip`
 * itself falls back to, so the two cannot drift apart. */
const DEFAULT_STATUS = 'draft';
function statusChip(status) {
  const s = String(status ?? DEFAULT_STATUS);
  return h('span', { class: `chip status-${cssSafe(s)}` }, s);
}
/* The same chip, drawn only when it discriminates. Inside the bands every active workspace reads
 * `draft` — the ingest default — so the chip was a word repeated on every row beside the state
 * pill that actually says what the workspace is waiting on, and pure width: the row's top line
 * wraps, so "Checking for updates" plus "draft" cost a second line on a narrow row for no
 * information.
 *
 * Deliberately a suppression and not a deletion. `auditing`, `reworking`, `ready` and
 * `implementing` are all reachable through POST /api/features/:id/status even though the real
 * corpus has none today, and each of them IS news next to the state pill. `done` never reaches here:
 * a done row draws its own chip (workspaceRow), because that one value is always worth saying. */
function statusChipIfMeaningful(status) {
  return String(status ?? DEFAULT_STATUS) === DEFAULT_STATUS ? null : statusChip(status);
}

function gateBadge(gate) {
  const meta = GATE[gate];
  return h('span', { class: `gate-badge gate-${meta ? cssSafe(gate) : 'unknown'}` },
    h('span', { class: 'gate-dot' }),
    meta ? meta.label : String(gate ?? 'unknown'));
}

function sevCountsRow(openBySeverity) {
  const o = openBySeverity || {};
  return h('div', { class: 'sev-counts' },
    SEV_ORDER.map((s) => h('span', { class: `sev sev-${s}`, title: `open ${SEV[s].label}s` },
      h('span', { class: 'sev-glyph' }, SEV[s].glyph),
      h('span', { class: 'num' }, String(o[s] ?? 0)),
    )));
}

function iconSpan(name, cls = 'icon') {
  return h('span', { class: cls, html: ICONS[name] || '' });
}

function skel(cls) { return h('div', { class: `skel ${cls}` }); }

/* ============================== guide ============================== */

function gStep(n, title, ...body) {
  return h('div', { class: 'guide-step' },
    h('div', { class: 'gs-num' }, String(n)),
    h('div', { class: 'gs-body' }, h('h3', {}, title), ...body));
}
function gCmd(text) { return h('code', { class: 'guide-cmd' }, text); }

function renderGuide() {
  current.view = 'guide'; current.id = null; current.tab = null;
  const app = $('#app');
  app.replaceChildren(
    h('div', { class: 'guide' },
      h('div', { class: 'view-head' },
        h('h1', {}, 'How FlowLever works'),
        h('p', { class: 'view-sub' }, 'A review cockpit for specs and PRs — from messy spec to ready-to-build, and from PR diff to posted comments, staying on top of every finding')),

      // What it is
      h('section', { class: 'guide-card' },
        h('h2', {}, 'The idea in one breath'),
        h('p', { class: 'guide-lead' },
          'A ', h('strong', {}, 'feature'), ' links its Confluence spec, Azure DevOps work items and Figma designs. ',
          'You run ', h('strong', {}, 'audits'), ' that flag ', h('strong', {}, 'findings'),
          ' (contradictions, gaps, untestable statements, design mismatches). Findings live in a ',
          h('strong', {}, 'fingerprinted ledger'), ' with a lifecycle and a ', h('strong', {}, 'readiness score'),
          '. You rework, re-audit, and the score climbs until the gate turns green — and the ledger ',
          'never loses track of what was flagged, fixed, or quietly came back.')),

      // Two halves
      h('section', { class: 'guide-card' },
        h('h2', {}, 'Two halves'),
        h('div', { class: 'guide-cols' },
          h('div', { class: 'guide-col' },
            h('h3', {}, '🖥️  The cockpit (this site + CLI)'),
            h('p', {}, 'Runs locally, no network, zero dependencies. It shows everything — readiness, the findings board, the coverage matrix, the round timeline, the report. Drive it from the dashboard or the ', gCmd('node src/cli.js'), ' commands.')),
          h('div', { class: 'guide-col' },
            h('h3', {}, '🤖  The skills (in Claude Code chat)'),
            h('p', {}, 'The ', h('code', {}, '/flowlever:*'), ' skills run inside your Claude Code session — where your Confluence / ADO / Figma access already lives. They do the fetching, analysis and (only on your OK) the fixes for both ', h('strong', {}, 'specs'), ' (audit / rework / brief) and ', h('strong', {}, 'PRs'), ' (pr-review / pr-respond), then write findings into the ledger.')))),

      // The loop
      h('section', { class: 'guide-card' },
        h('h2', {}, 'The loop'),
        h('div', { class: 'guide-steps' },
          gStep(1, 'Audit',
            h('p', {}, 'In Claude Code: ', h('code', {}, '/flowlever:audit checkout-redesign'), ' (or “audit feature X”, or paste a spec link). It fetches the sources, runs a 7-dimension check, and ingests findings into the ledger.')),
          gStep(2, 'Review — step through, one finding at a time',
            h('p', {}, 'Open the feature here and hit the ', h('strong', {}, '“Review N flagged items”'), ' button in the header loop strip. The guided ', h('strong', {}, 'stepper'), ' walks each flagged finding one at a time: you see the proposed change as a red/green diff and decide ', h('strong', {}, 'Accept · Edit · Redirect · Waive · Skip'), '. Decisions accumulate — nothing is applied mid-flow — and a rail lets you jump around. The ', h('strong', {}, 'All findings'), ' board, ', h('strong', {}, 'Coverage'), ', and ', h('strong', {}, 'Timeline'), ' tabs are all still there.')),
          gStep(3, 'Apply / Export',
            h('p', {}, 'The finish screen is a ', h('strong', {}, 'decision summary'), ' grouped by spec page / work item. From there: ', h('strong', {}, 'Export the work order'), ' (markdown to hand a coding agent) and/or ', h('strong', {}, 'mark the reviewed findings as Reworking'), ' so the board reflects in-flight work. Drafts come from ', h('code', {}, '/flowlever:rework'), '; nothing is written to Confluence/ADO from the browser.')),
          gStep(4, 'Re-audit',
            h('p', {}, 'Run ', h('code', {}, '/flowlever:audit'), ' again. The ledger ', h('strong', {}, 'reconciles'), ': fixed findings auto-resolve, still-open ones refresh, and anything that ', h('strong', {}, 'silently came back'), ' is flagged as a regression (red on the timeline).')),
          gStep(5, 'Ship',
            h('p', {}, 'When the gate is green, ', h('code', {}, '/flowlever:brief checkout-redesign'), ' composes an implementation-ready handoff brief from the spec, designs and settled decisions.')))),

      // PR flows
      h('section', { class: 'guide-card' },
        h('h2', {}, 'PRs ride the same cockpit'),
        h('p', { class: 'guide-lead' },
          'Pull requests use the exact same finding model and review stepper as specs — only the workflow differs. ',
          'Kick a job off from ', h('strong', {}, '“+ New PR review / respond”'), ' in the UI (or the skill in chat); the ',
          h('code', {}, '/flowlever:watch'), ' runner — a loop in your Claude Code session — picks it up, does the ADO work, and the results show back here.'),
        h('div', { class: 'guide-cols' },
          h('div', { class: 'guide-col' },
            h('h3', {}, h('code', {}, '/flowlever:pr-review'), ' — review someone’s PR'),
            h('p', {},
              'Enqueue a PR id → the runner fetches the diff + linked ticket/spec and reviews it → findings land in a workspace → you ',
              h('strong', {}, 'step through'), ' each one (Accept · Edit · Redirect · Waive · Skip) → ',
              h('strong', {}, '“Post comments”'), ' posts only what you approved as inline PR comments. ',
              h('strong', {}, 'Nothing is posted automatically.'))),
          h('div', { class: 'guide-col' },
            h('h3', {}, h('code', {}, '/flowlever:pr-respond'), ' — answer feedback on your PR'),
            h('p', {},
              'Pulls the reviewer threads awaiting your reply → each becomes a finding with a proposed reply/fix → you decide ',
              h('strong', {}, 'per thread'), ' (reply · fix + reply · ', h('strong', {}, 'fix only'),
              ' · push back · skip) → ', h('strong', {}, '“Post replies”'),
              ' posts the replies and applies the code fixes — only on your action. ',
              h('strong', {}, 'Fix only'), ' is the quiet path: it pushes the commit and marks the thread ',
              h('em', {}, 'Fixed'), ' without writing any comment — for when you want the change in but ',
              'would rather answer the reviewer yourself, or not at all.')))),

      // Job lifecycle & statuses
      h('section', { class: 'guide-card' },
        h('h2', {}, 'Job lifecycle & statuses'),
        h('p', {},
          'A UI-triggered job moves through four statuses, shown live on its row in the jobs strip:'),
        h('ul', { class: 'guide-list' },
          h('li', {}, h('strong', {}, '⏳ Queued'), ' — waiting for the runner to pick it up.'),
          h('li', {}, h('strong', {}, '⠿ Running'), ' — being processed. The row shows the ', h('strong', {}, 'live phase'),
            ' (e.g. “Running · reviewing changes”) so you can see exactly what it’s doing.'),
          h('li', {}, h('strong', { class: 'guide-ni' }, '⚠ Needs your input'), ' — the job is ', h('strong', {}, 'blocked waiting on you'),
            ', most often to approve a 2FA / auth prompt in another window. An amber banner spells out what to do; ',
            'approve it and the job continues on its own.'),
          h('li', {}, h('strong', {}, '✓ Done'), ' — finished; the workspace is ready and linked from the row.'),
          h('li', {}, h('strong', {}, '✗ Error'), ' — failed; the row shows why.'),
          h('li', {}, h('strong', { class: 'guide-ni' }, '⏸ Not running'), ' — queued (or claiming to run) for ',
            'minutes with ', h('strong', {}, 'no runner going'), '. Nothing has been posted. Hit ',
            h('strong', {}, '▶ Run it now'), ', or cancel the job to put its items back in the review queue.')),
        h('h3', {}, 'Running jobs from here — ▶ Run N jobs'),
        h('p', {},
          'Queued jobs only move when a Claude Code session runs ', h('code', {}, '/flowlever:watch'), '. ',
          'The cockpit server is a local process, so it can start that session for you: ',
          h('strong', {}, '▶ Run N jobs'), ' (on Home, the PR sections, and in the stalled banner) launches it ',
          'headlessly and the job rows then move queued → running → done in front of you. While it works ',
          'the control reads ', h('strong', {}, 'Runner working… ■ Stop'), '. Because this one ',
          h('em', {}, 'writes'), ' to Azure DevOps it confirms once before starting, only ever runs one session ',
          'at a time, and logs to ', h('code', {}, '~/.flowlever/runner.log'), ' so a headless failure ',
          '(expired auth, missing MCP) is visible instead of silent. If the ', h('code', {}, 'claude'),
          ' CLI can\'t be found the button says so — set ', h('code', {}, 'FLOWLEVER_CLAUDE_BIN'), '.'),
        h('h3', {}, 'Why a Post can never silently look done'),
        h('p', {},
          'Clicking Post does ', h('em', {}, 'not'), ' write anything — the browser can\'t reach Azure DevOps. It marks the ',
          'items ', h('strong', {}, '“Posting…”'), ' and queues a job; only the runner can confirm a comment landed, ',
          'by stamping it ', h('strong', {}, 'Posted — awaiting author'), '. So if the runner never arrives, dies ',
          'mid-way, or finishes without stamping, the cockpit says exactly that ("no runner picked this up", ',
          '"finished but N items not confirmed as posted") instead of implying success — and offers ',
          h('strong', {}, '↩ Back to the review queue'), ' to release the items so you can Post again. ',
          'Each ', h('code', {}, '/flowlever:watch'), ' pass also heals strays: it checks the PR and either stamps ',
          'items whose comment is already there, or releases the ones that never made it.'),
        h('h3', {}, 'The two review clocks — when can I re-review?'),
        h('p', {},
          'Every PR workspace carries two timestamps, shown together on its row — on Home and in its section — and its header: ',
          h('strong', {}, 'Reviewed'), ' (when we last reviewed it — its last ingest round) and ',
          h('strong', {}, 'PR updated'), ' (when the ', h('em', {}, 'other'),
          ' side last touched the PR: the author on a PR review, the reviewer on a PR respond). ',
          'When their update is newer than our review, the stamp turns blue with a ',
          h('strong', {}, '● new since your review'), ' badge and the prominent ',
          h('strong', {}, '↻ Re-review'), ' action appears — a re-review will actually see something. ',
          'Hover a stamp for the exact time.'),
        h('h3', {}, 'The ↻ Refresh button'),
        h('p', {},
          'The scheduled ', h('code', {}, '/flowlever:poll'), ' pass runs every couple of hours. When you already ',
          h('em', {}, 'know'), ' a new PR landed or a reviewer just commented, hit ', h('strong', {}, '↻ Refresh'),
          ' on Home or on either PR section: it queues a discovery pass your ', h('code', {}, '/flowlever:watch'),
          ' session runs right away — finding PRs with no workspace yet and re-checking the known ones for updates. ',
          'The button is its own progress indicator (queued → live phase → done, or the failure reason with a retry), ',
          'it de-dupes so a double-click can’t start two passes, and like the scheduled pass it ',
          h('strong', {}, 'never posts anything'), '.'),
        h('p', { class: 'meta-dim' },
          'The runner is the ', h('code', {}, '/flowlever:watch'), ' loop in your Claude Code session — that’s why a job can pause for your 2FA: ',
          'the session, not the browser, holds your Confluence / ADO access.')),

      // Reading the dashboard
      h('section', { class: 'guide-card' },
        h('h2', {}, 'Reading the dashboard'),
        h('ul', { class: 'guide-list' },
          h('li', {}, h('strong', {}, 'Readiness dial'), ' — 0–100. Green = ready, amber = in progress, red = not ready. Any open ', h('span', { class: 'sev-blocker' }, '◆ blocker'), ' forces “not ready” no matter the score.'),
          h('li', {}, h('strong', {}, 'Severity'), ' — ', h('span', { class: 'sev-blocker' }, '◆ blocker'), ' (build would be wrong/stuck) · ', h('span', { class: 'sev-major' }, '▲ major'), ' (rework needed) · ', h('span', { class: 'sev-minor' }, '● minor'), ' (polish) · ', h('span', { class: 'sev-info' }, '○ info'), '.'),
          h('li', {}, h('strong', {}, 'Status columns'), ' — Open → Reworking → Resolved | Waived. Waiving needs a reason; pinned findings never auto-resolve.'),
          h('li', {}, h('strong', {}, 'Coverage'), ' — covered / partial / uncovered sections, plus orphan work items with no matching spec section.'),
          h('li', {}, h('strong', {}, 'Timeline'), ' — each audit round with new / auto-resolved / regression counts and the score delta.'))),

      // Try now
      h('section', { class: 'guide-card guide-try' },
        h('h2', {}, 'Try it right now'),
        h('ol', { class: 'guide-list' },
          h('li', {}, 'The demo feature is already seeded — ', h('a', { href: '#/' }, 'open the Features overview'), ' and click into ', h('strong', {}, 'Checkout Redesign'), '.'),
          h('li', {}, 'Walk the four tabs. Notice the score climbing 0 → 33 → 53 across rounds on the Timeline, and the regression flagged in round 3.'),
          h('li', {}, 'Re-seed any time with ', gCmd('node src/cli.js demo'), '.'),
          h('li', {}, 'For a real feature, tell Claude Code: ', h('em', {}, '“audit feature <name>”'), ' with its Confluence / ADO / Figma links.'))),

      h('p', { class: 'guide-foot' }, 'Full details live in ', h('code', {}, 'README.md'), ' and ', h('code', {}, 'docs/SCHEMA.md'), '.'),
    ));
}

/* ============================== guided review flow ============================== */

/* Reviewable = an open/reworking finding that carries something to decide on: a
 * code-diff `draft` OR a non-empty `suggestion` (the proposed PR comment / reply).
 * PR-review findings usually carry only a suggestion, so they MUST count here too —
 * these are the items the stepper walks and the CTA counts. */
function hasSuggestion(f) {
  return typeof f.suggestion === 'string' && f.suggestion.trim() !== '';
}
/* A finding whose comment/reply has been posted back to the PR: it stays open/reworking
 * (so a re-review reconciles it) but is "awaiting the author", not the reviewer — it sits in
 * its own lane and is NOT re-counted as something to review. */
function isOpenish(f) {
  return f.status === 'open' || f.status === 'reworking';
}
function isPosted(f) {
  return Boolean(f.postedAt) && isOpenish(f);
}
/* Spec mirror of isPosted: the accepted change has actually been written back to Confluence/ADO
 * (stamped by the runner), so it's awaiting re-audit, not the reviewer. */
function isApplied(f) {
  return Boolean(f.appliedAt) && isOpenish(f);
}
/* Transient: the reviewer clicked Post/Apply and the runner is mid-flight (`pending` is
 * 'post' | 'apply'). Shown in the "Posting…/Applying…" lane until the real completion stamp lands. */
function isPending(f) {
  return Boolean(f.pending) && isOpenish(f) && !f.postedAt && !f.appliedAt;
}
/* Out of the reviewer's hands — in flight, posted, or applied — so not "to review". */
function isInFlightOrOut(f) {
  return isPosted(f) || isApplied(f) || isPending(f);
}
function reviewableFindings(findings) {
  return (findings || []).filter((f) =>
    isOpenish(f) && !isInFlightOrOut(f) && (f.draft || hasSuggestion(f)));
}
function postedFindings(findings) {
  return (findings || []).filter(isPosted);
}
/* Findings this workspace has sent to the PR, whether or not they are STILL open. isPosted()
 * deliberately means "posted and awaiting the author" (it and-s in isOpenish), which is the right
 * reading for the awaiting-author lane — but the wrong one for "did we ever post?". The moment the
 * author addresses a comment and a re-review reconciles the finding to `resolved`, isPosted() goes
 * false for it, and a workspace where the round went perfectly ends up indistinguishable from one
 * that never posted at all. */
function everPostedFindings(findings) {
  return (findings || []).filter((f) => Boolean(f.postedAt));
}
/* Has this workspace already put comments on the pull request? Workspace-level and permanent, so
 * it survives the reconciliation that clears the per-finding awaiting-author state. `lastPostedAt`
 * is the primary record (the runner stamps it on the feature); the per-finding scan is the
 * fallback for workspaces posted before that stamp existed. */
function hasPostedToPr(data) {
  const feature = (data && data.feature) || {};
  if (feature.review && feature.review.lastPostedAt) return true;
  return everPostedFindings((data && data.ledger && data.ledger.findings) || []).length > 0;
}
/* Spec findings whose accepted change has been written back and are awaiting a re-audit to
 * reconcile (the spec analog of postedFindings awaiting the author). */
function appliedFindings(findings) {
  return (findings || []).filter(isApplied);
}
/* A spec workspace is "ready to re-audit" once changes are applied and nothing is left to
 * triage — the spec analog of reviewWait==='responded'. (Applying IS the trigger; unlike a PR
 * there's no third party to wait on.) */
function specReauditReady(data) {
  const kind = data.feature && data.feature.kind;
  if (kind !== 'spec') return false;
  const findings = (data.ledger && data.ledger.findings) || [];
  if (reviewableFindings(findings).length) return false;   // still stuff to triage
  return appliedFindings(findings).length > 0;
}

/* The post-posting wait state for a PR workspace: 'waiting' (comments out, nothing to do
 * but wait), 'responded' (the runner saw new author replies/commits — time to re-review), or
 * null (not a PR, or still has things to review/post). Drives the loop + CTA framing. */
function reviewWait(data) {
  const kind = data.feature && data.feature.kind;
  if (kind !== 'pr-review' && kind !== 'pr-respond') return null;
  const findings = (data.ledger && data.ledger.findings) || [];
  if (reviewableFindings(findings).length) return null;   // still stuff to triage/post
  // "Have we posted?" is a fact about the workspace, not about which findings are still open.
  // Asking postedFindings() here meant a round that WORKED — author fixed everything, re-review
  // resolved the findings — reported "nothing posted", dropped out of the wait state, and took
  // the Re-review control with it. 19 of 57 PR workspaces were stranded that way.
  if (!hasPostedToPr(data)) return null;                   // never posted → not waiting
  // Either the runner explicitly flagged a response, or the recorded PR-activity timestamp is
  // newer than our last review round — both mean the same thing: there's a delta to reconcile.
  const stamps = reviewStampsOf(data);
  const responded = (data.feature.review && data.feature.review.authorRespondedAt) || stamps.newSinceReview;
  return responded ? 'responded' : 'waiting';
}

/* Build the review-flow decision map from PERSISTED finding state, so a decision taken on
 * ANY surface (board modal or the stepper) shows everywhere and survives a page refresh:
 * a waived finding reads as Dismissed, a stored `decision` as Approve/Edit, an explicit
 * redirect/reject verdict as its own kind, the rest Undecided. The in-memory flow map is
 * just a cache hydrated from this. */
function hydrateDecisions(findings) {
  const d = {};
  for (const f of findings || []) {
    if (f.status === 'waived') d[f.fp] = { kind: 'waive', reason: f.statusReason || '' };
    else if (f.decision === 'approve') d[f.fp] = { kind: 'accept' };
    else if (f.decision === 'edit') d[f.fp] = { kind: 'edit' };
    else if (f.decision === 'fix-only') d[f.fp] = { kind: 'fix-only' };
    else {
      // No finding-level decision stored — derive one from the persisted draft review,
      // so accepting a proposal hunk-by-hunk counts as deciding the finding (otherwise
      // the finish screen reads it as Undecided and silently drops it from the post).
      const rv = f.draft && f.draft.review;
      if (!rv) continue;
      if (rv.verdict === 'redirect') { d[f.fp] = { kind: 'redirect', reason: rv.note || '' }; continue; }
      // A `reject` verdict is the reviewer explicitly saying "don't apply this proposed
      // change" — that IS a decision, not an absence of one. Leaving it out of `d` (as this
      // used to) made it fall back to Undecided everywhere flowDecisionKind() is read, which
      // meant approveAllRemaining's undecidedFlowFps() scooped it up and silently rewrote a
      // considered Reject back to `proposed` + accepted hunks. Recording it as its own kind
      // here — the same move already made for `redirect` two lines up — fixes it at the one
      // place every consumer (undecided set, finish tally, rail marks, triage tags) reads from,
      // instead of teaching each consumer a second, separate notion of "decided".
      if (rv.verdict === 'reject') { d[f.fp] = { kind: 'reject', reason: rv.note || '' }; continue; }
      const hunkDecs = rv.hunks || {};
      const statuses = draftStats(f).hunks.map((hk) => (hunkDecs[String(hk.id)] || {}).status);
      if (statuses.length && statuses.every((s) => s === 'accepted' || s === 'edited')) {
        d[f.fp] = { kind: statuses.includes('edited') ? 'edit' : 'accept' };
      }
    }
  }
  return d;
}

/* Canonical loop stages keyed independent of label, so a kind can rename them.
 * fetch → review → apply → reaudit. `reaudit` is the trailing "next" step and is
 * never lit as the *active* stage — it's what you do after posting/applying. */
const STAGE_KEYS = ['fetch', 'review', 'apply', 'reaudit'];
const LOOP_STAGES_BY_KIND = {
  spec:         [['1', 'Audit'], ['2', 'Review'], ['3', 'Apply / Export'], ['4', 'Re-audit']],
  'pr-review':  [['1', 'Fetch'], ['2', 'Review comments'], ['3', 'Post'], ['4', '(re-run)']],
  'pr-respond': [['1', 'Fetch'], ['2', 'Review threads'], ['3', 'Post'], ['4', '(re-run)']],
};

/* Active stage from REAL state, not "rounds exist": no findings → fetch; any
 * undecided reviewable finding → review; otherwise everything's been triaged →
 * apply/post. `reaudit` is only ever the dangling next step (never returned here). */
function loopActiveStage(data) {
  const findings = (data.ledger && data.ledger.findings) || [];
  if (!findings.length) return 'fetch';
  if (reviewableFindings(findings).length) return 'review';
  // Nothing left to review/post. If comments are posted (PR) or changes applied (spec), the live
  // step is the reconcile (re-review / re-audit); otherwise it's still the post/apply step.
  // Same correction as reviewWait: a PR whose posted findings have since been resolved has still
  // POSTED, and its live step is the re-run — not "Post", with nothing left to post.
  if (hasPostedToPr(data) || appliedFindings(findings).length) return 'reaudit';
  return 'apply';
}

/* The loop, always visible in the feature header, with kind-aware stage labels,
 * the current stage lit and the primary CTA on the right. */
function loopStrip(data, rightEl) {
  const kind = (data.feature && data.feature.kind) || 'spec';
  const stages = LOOP_STAGES_BY_KIND[kind] || LOOP_STAGES_BY_KIND.spec;
  const activeIdx = STAGE_KEYS.indexOf(loopActiveStage(data));
  const isPr = kind === 'pr-review' || kind === 'pr-respond';
  const canReReview = isPr && !!prNumber(data.feature);
  const wait = reviewWait(data);   // null | 'waiting' | 'responded'  (PR)
  const reaudit = specReauditReady(data);   // spec: changes applied → re-audit available
  const els = [];
  stages.forEach(([ix, label], i) => {
    if (i) els.push(h('span', { class: 'loop-sep' }, '→'));
    // The trailing stage lights once comments are posted (PR) or changes applied (spec). For a
    // PR it's "Re-review" (or a passive Waiting chip); for a spec, applying makes it "Re-audit".
    const active = i === activeIdx;
    const isLast = i === 3;
    const onLast = isLast && active;
    // A PR re-run must not depend on finding state. The delta a re-review reconciles lives on the
    // PULL REQUEST — new commits, new replies — not in this ledger, so whether the ledger happens
    // to hold an open posted finding says nothing about whether re-running is worth doing. Gating
    // the click on `active` is what made the action unreachable on every workspace whose last
    // round closed cleanly. Knowing the PR number is the only real precondition.
    const prClickable = isLast && canReReview;
    const specClickable = onLast && reaudit;
    const clickable = prClickable || specClickable;
    const act = specClickable ? () => reAuditSpec(data) : (prClickable ? () => reReviewPr(data) : undefined);
    let stageLabel = label;
    let stateCls = '';
    if (specClickable) { stageLabel = '↻ Re-audit'; stateCls = 'loop-stage-action'; }
    else if (isLast && wait === 'responded') { stageLabel = '↻ Re-review'; stateCls = 'loop-stage-action'; }
    else if (isLast && wait === 'waiting') { stageLabel = '⏳ Waiting'; stateCls = 'loop-stage-waiting'; }
    // Not waiting on anyone and not the live stage — but still re-runnable, and the label has to
    // say so. "(re-run)" reads as a caption for a stage you cannot reach; "↻ Re-review" is a verb.
    else if (prClickable) { stageLabel = '↻ Re-review'; }
    els.push(h('div', {
      class: `loop-stage ${active ? 'active' : ''} ${stateCls}`.trim(),
      role: clickable ? 'button' : undefined,
      tabindex: clickable ? '0' : undefined,
      title: clickable
        ? (specClickable ? 'Changes applied — re-audit to re-fetch the spec and reconcile these findings'
          : wait === 'responded' ? 'Author responded — re-review and reconcile'
          : wait === 'waiting' ? 'Waiting on the author — click to re-review anyway'
          : 'Re-fetch the PR and reconcile any new commits or replies into this ledger')
        : undefined,
      onclick: act,
      onkeydown: clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); } } : undefined,
    }, h('span', { class: 'loop-ix' }, ix), stageLabel));
  });
  return h('div', { class: 'loop-strip' },
    h('div', { class: 'loop-stages' }, els),
    rightEl);
}

/* Noun the CTA + stepper use for one reviewable item, per kind. */
const REVIEW_NOUN = {
  spec: ['flagged item', 'flagged items'],
  'pr-review': ['comment', 'comments'],
  'pr-respond': ['thread', 'threads'],
};
function reviewNoun(kind) { return REVIEW_NOUN[kind] || REVIEW_NOUN.spec; }

/* The single prominent next-action. "Review N comments/items/threads" when there's
 * something to review; otherwise it tells the user there's nothing left to triage. */
function reviewCta(data) {
  const findings = (data.ledger && data.ledger.findings) || [];
  const kind = (data.feature && data.feature.kind) || 'spec';
  const [one, many] = reviewNoun(kind);
  const n = reviewableFindings(findings).length;
  if (n > 0) {
    return h('button', {
      class: 'review-cta', type: 'button',
      onclick: () => { location.hash = `#/feature/${encodeURIComponent(current.id)}/review`; },
    }, 'Review ', h('span', { class: 'cta-n' }, String(n)), ` ${n === 1 ? one : many}`);
  }
  const openNone = findings.filter((f) =>
    (f.status === 'open' || f.status === 'reworking') && !f.draft && !hasSuggestion(f)).length;
  if (openNone > 0) {
    const noun = kind === 'spec' ? 'a draft' : 'a comment';
    return h('div', { class: 'review-cta-done' },
      `Nothing to review — ${plural(openNone, 'open finding', 'open findings')} without ${noun}`);
  }
  if (kind === 'pr-review' || kind === 'pr-respond') {
    // Once comments are posted the work is OUT — the workspace waits on the author. It stays in
    // a passive "Waiting on author" state until the runner detects a reply/commit (or you act
    // manually); only then does it surface a prominent Re-review.
    const wait = reviewWait(data);
    if (wait) {
      // Count everything we sent, not just what is still awaiting the author — otherwise a fully
      // reconciled round reads "0 comments posted to PR #5867" directly under a Posted stamp.
      const posted = everPostedFindings(findings).length;
      const prNum = prNumber(data.feature);
      const target = prNum ? `PR #${prNum}` : 'the PR';
      const canReReview = !!prNum;
      const reBtn = (cls, label) => canReReview ? h('button', {
        class: cls, type: 'button',
        title: 'Re-fetch the PR and reconcile the author’s response into this ledger',
        onclick: () => reReviewPr(data),
      }, label) : null;
      if (wait === 'responded') {
        const note = data.feature.review && data.feature.review.note;
        return h('div', { class: 'review-cta-done is-responded' },
          h('span', {}, `● Author responded on ${target}${note ? ` — ${note}` : ''}`),
          reBtn('review-cta review-cta-rereview is-hot', '↻ Re-review'));
      }
      return h('div', { class: 'review-cta-done is-waiting' },
        h('span', {}, `${plural(posted, 'comment', 'comments')} posted to ${target}`),
        reBtn('review-cta review-cta-rereview', '↻ Re-review'));
    }
    return h('div', { class: 'review-cta-done is-ready' }, '✓ All reviewed — ready to post');
  }
  // Spec: once accepted changes are written back to Confluence/ADO, the workspace is "out for
  // re-audit" — surface a prominent Re-audit that re-fetches the spec and reconciles (auto-resolves
  // the applied findings if the spec now reflects them, or keeps them open + flags regressions).
  if (specReauditReady(data)) {
    const n = appliedFindings(findings).length;
    return h('div', { class: 'review-cta-done is-responded' },
      h('span', {}, `● ${plural(n, 'change', 'changes')} applied — re-audit to reconcile`),
      h('button', {
        class: 'review-cta review-cta-rereview is-hot', type: 'button',
        title: 'Re-fetch the spec sources and reconcile: applied findings auto-resolve if the spec now reflects them.',
        onclick: () => reAuditSpec(data),
      }, '↻ Re-audit'));
  }
  const gate = (data.readiness && data.readiness.gate) || 'in-progress';
  return h('div', { class: 'review-cta-done is-ready' }, gate === 'ready' ? '✓ Ready to build' : '✓ Nothing to review');
}

/* Kind-aware decision actions for the stepper's decision row. Each returns the
 * button set (each mapped to an internal flow-decision kind so the rail marks,
 * finish tallies, export + apply all keep working), the per-finding triage tag
 * labels, and behavior flags. `editsComment` → the Edit button opens the proposed
 * comment in a textarea (not the per-hunk diff); `quickDismiss` → Dismiss records
 * the decision immediately (reason optional). */
function decisionActions(kind) {
  if (kind === 'pr-review') {
    return {
      label: 'Decision',
      editsComment: true,
      quickDismiss: true,
      helper: 'Approved comments are posted only when you click Post — nothing is sent until then.',
      // `reject` is missing here for the same reason DEC_PILL['pr-review'] needed it (app.js:~903):
      // hydrateDecisions now records a `reject` verdict as its own decided kind, so decisionRow's
      // `cfg.tagLabels[decKind] || cfg.tagLabels.undecided` falls through to the literal word
      // "Undecided" for a card that is very much decided — the reviewer's own reject verdict,
      // shown right above it as a red banner, contradicted by its own triage tag.
      tagLabels: { accept: 'Will post', edit: 'Edited', waive: 'Dismissed', reject: 'Rejected', undecided: 'Undecided' },
      // The card is already headed "Proposed comment" — repeating the noun in every button
      // only widened them. Labels stay one word each so the k/a/e/w hint reads the same.
      buttons: [
        { kind: 'accept', label: '✓ Approve', cls: 'dec-accept' },
        { kind: 'edit', label: '✎ Edit', cls: 'dec-edit' },
        { kind: 'waive', label: '✕ Dismiss', cls: 'dec-waive' },
      ],
    };
  }
  if (kind === 'pr-respond') {
    return {
      label: 'Decision',
      helper: 'Replies and fixes are sent only when you click Post — nothing is sent until then. '
        + '“Fix only” pushes the fix and resolves the thread without writing a reply.',
      // `reject` added alongside `redirect` above for the same reason pr-review's tagLabels
      // needed it: hydrateDecisions can hand this surface a `reject`-kind decision purely from a
      // draft verdict, with no dedicated button behind it, so leaving it out of a kind-keyed
      // label map is a silent "Undecided" mislabel, not a compile error.
      tagLabels: {
        accept: 'Will reply', edit: 'Fix + reply', 'fix-only': 'Fix, no reply',
        redirect: 'Push back', reject: 'Rejected', skip: 'Skipped', undecided: 'Undecided',
      },
      buttons: [
        { kind: 'accept', label: '↩ Reply', cls: 'dec-accept' },
        // Named for what it actually does: this one commits the fix AND answers the thread.
        { kind: 'edit', label: '✎ Fix + reply', cls: 'dec-edit' },
        // Fix, push, resolve the thread — no comment written.
        { kind: 'fix-only', label: '✎ Fix only', cls: 'dec-fixonly' },
        { kind: 'redirect', label: '⤺ Push back', cls: 'dec-redirect' },
        { kind: 'skip', label: '⏭ Skip', cls: 'dec-skip' },
      ],
    };
  }
  // Spec: the act is APPLYING a change to Confluence/ADO, and the finish screen has always
  // called it that ("Apply as proposed" / DEC_LABEL "Apply"). The button said "Accept", so one
  // act carried two names across two screens; it now says Apply everywhere. Glyphs match the
  // PR kinds' hairline set rather than mixing in colour emoji.
  return {
    label: 'Decision',
    buttons: [
      { kind: 'accept', label: '✓ Apply', cls: 'dec-accept' },
      { kind: 'edit', label: '✎ Edit', cls: 'dec-edit' },
      { kind: 'redirect', label: '⤳ Redirect', cls: 'dec-redirect' },
      { kind: 'waive', label: '⊘ Waive', cls: 'dec-waive' },
      { kind: 'skip', label: '⏭ Skip', cls: 'dec-skip' },
    ],
  };
}

// `reject` sits next to `redirect` in both maps below for the same reason: hydrateDecisions can
// derive either kind purely from a draft verdict (no dedicated decide() button backs it), so
// wherever `redirect` is wired into a shared, kind-agnostic display map, `reject` needs the same
// entry or it silently falls back to an unstyled/blank rendering (or the wrong glyph) for a state
// that is now genuinely "decided".
const DEC_LABEL = { accept: 'Apply', edit: 'With edits', 'fix-only': 'Fix, no reply', redirect: 'Redirect', reject: 'Reject', waive: 'Waive', skip: 'Skip' };
// `reject` uses the hairline `⊗` here, not the colour '🚫' emoji used elsewhere (VERDICT_GLYPH,
// the verdict buttons): every other mark in this set (✓ ✎ ⤳ ⊘ –) is a plain glyph that inherits
// `.rail-mark`'s `color`, so it renders crisp against the red dec-reject background. An emoji
// carries its own fixed colours regardless of CSS `color` and rendered as a dark blob on that red
// chip instead of a mark — the exact inconsistency the comment above `decisionActions` (app.js:
// ~884-885) already calls out for this set.
const RAIL_MARK = { accept: '✓', edit: '✎', 'fix-only': '✎', redirect: '⤳', reject: '⊗', waive: '⊘', skip: '–' };

async function renderReviewFlow(id, finish) {
  current.view = 'review-flow'; current.id = id; current.tab = 'review';
  const seq = ++routeSeq;
  const app = $('#app');
  const cached = state.detailId === id && state.detail;
  if (!cached) app.replaceChildren(detailSkeleton());
  let data;
  try {
    data = await loadDetail(id);
  } catch (e) {
    if (seq !== routeSeq) return;
    toast(`Could not load feature: ${e.message}`);
    app.replaceChildren(errorView(`Could not load “${id}”`, e.message));
    return;
  }
  if (seq !== routeSeq) return;
  initFlow(data);
  state.flow.active = true;
  state.flow.finish = !!finish;
  renderFlowInto();
}

/* Snapshot the reviewable fps at launch so the step count is stable while the
 * reviewer works. Re-entering the same feature keeps decisions + position;
 * switching features resets. */
function initFlow(data) {
  const findings = (data.ledger && data.ledger.findings) || [];
  const reviewable = reviewableFindings(findings);
  if (state.flow.featureId !== current.id || !Array.isArray(state.flow.items)) {
    state.flow = {
      active: true, finish: false, featureId: current.id,
      items: reviewable.map((f) => f.fp), idx: 0, decisions: hydrateDecisions(findings), waiving: null, editingComment: null,
      persistFailed: {},
    };
  }
  const len = state.flow.items.length;
  if (len === 0) { state.flow.idx = 0; return; }
  if (state.flow.idx >= len) state.flow.idx = len - 1;
  if (state.flow.idx < 0) state.flow.idx = 0;
}

/* While the stepper is open, a background reload (a decision synced in from the board modal, a
 * scoped re-audit finishing, /flowlever:watch reconciling a round) can change which findings
 * exist — but state.flow.items was frozen at launch and only ever rebuilt on a feature switch
 * or by retryPost's manual reset. So a re-review landing mid-stepper added findings the rail and
 * "x of N" never showed, and a finding removed by reconciliation stayed counted forever (C-25).
 * Reconciles in place instead: keeps the reviewer's position and every decision already
 * recorded, appends newly-reviewable fps, and drops only fps that no longer exist at all. */
function reconcileFlowItems(data) {
  if (state.flow.featureId !== current.id || !Array.isArray(state.flow.items)) return;
  const findings = (data.ledger && data.ledger.findings) || [];
  const byFp = new Set(findings.map((f) => f.fp));
  const liveFps = reviewableFindings(findings).map((f) => f.fp);
  const currentFp = state.flow.items[state.flow.idx];
  const kept = state.flow.items.filter((fp) => byFp.has(fp));
  const known = new Set(kept);
  const added = liveFps.filter((fp) => !known.has(fp));
  if (kept.length === state.flow.items.length && added.length === 0) return;   // nothing changed
  state.flow.items = [...kept, ...added];
  const newIdx = state.flow.items.indexOf(currentFp);
  state.flow.idx = newIdx >= 0 ? newIdx : Math.min(state.flow.idx, state.flow.items.length - 1);
  if (state.flow.idx < 0) state.flow.idx = 0;
}

function renderFlowInto() {
  if (current.view !== 'review-flow' || !state.detail) return;
  const app = $('#app');
  const data = state.detail;
  reconcileFlowItems(data);
  const kind = data.feature && data.feature.kind;
  const postable = state.flow.finish && (kind === 'pr-review' || kind === 'pr-respond');
  if (postable) ensureApplyPolling(); else stopPolling();
  if (!state.flow.items || !state.flow.items.length) {
    app.replaceChildren(flowEmptyView());
    return;
  }
  app.replaceChildren(state.flow.finish ? finishView(data) : stepperView(data));
}

/* Re-render whichever review surface is live: the full-page stepper when it's the
 * active view, otherwise the finding modal (board + open dialog). This lets the
 * shared decision widgets (decisionRow / suggestionSection / acceptAll …) drive
 * BOTH the stepper and the modal review sub-view without each knowing the other. */
function reviewRefresh() {
  if (current.view === 'review-flow') renderFlowInto();
  else refreshModal();
}

/* Make state.flow track the current feature's reviewable findings WITHOUT
 * launching the stepper, so a decision taken in the modal lands in the same
 * state.flow.decisions the stepper reads (they must agree). Re-entering the same
 * feature keeps prior decisions; switching features starts fresh. */
function ensureFlow() {
  const data = state.detail;
  if (!data || !current.id) return;
  if (state.flow.featureId === current.id && Array.isArray(state.flow.items)) return;
  const findings = (data.ledger && data.ledger.findings) || [];
  state.flow = {
    active: false, finish: false, featureId: current.id,
    items: reviewableFindings(findings).map((f) => f.fp),
    idx: 0, decisions: hydrateDecisions(findings), waiving: null, editingComment: null,
    persistFailed: {},
  };
}

/* While the PR finish screen is open, keep the apply-request status for this
 * workspace fresh so the Post button shows queued → running → posted. The scope
 * guard means re-rendering the finish view reuses the interval, not resets it. */
function ensureApplyPolling() {
  startPolling(`apply:${current.id}`, (reqs) => {
    if (current.view !== 'review-flow' || !state.flow.finish) return;
    const next = reqs.filter((r) => (r.action === 'apply' || r.action === 'propose') && r.wsId === current.id);
    const prev = state.flow.applyReqs || [];
    const sig = (list) => list.map((r) => `${r.id}:${r.status}:${r.phase || ''}:${r.note || ''}:${r.needsInput ? 1 : 0}`).join('|');
    state.flow.applyReqs = next;
    // Once the server has a queued/running apply request, that drives the busy
    // state; clear the optimistic flag when nothing is in flight anymore.
    state.flow.applying = next.some((r) => r.status === 'queued' || r.status === 'running');
    if (sig(prev) !== sig(next)) renderFlowInto();
  });
}

function flowEmptyView() {
  const back = `#/feature/${encodeURIComponent(current.id)}`;
  return h('div', { class: 'stepper' },
    h('a', { class: 'backlink', href: back }, '← Overview'),
    h('div', { class: 'step-card' },
      h('div', { class: 'step-empty' },
        h('h2', {}, 'Nothing to review'),
        h('p', { class: 'meta-dim' }, 'No open findings carry a proposed change yet. Run ',
          h('code', {}, '/flowlever:rework'), ' in Claude Code to draft fixes, then re-audit.'),
        h('p', {}, h('a', { class: 'backlink', href: back }, '← Back to the board')))));
}

/* Single source of truth for the decide-loop keyboard shortcuts (U-5) — the global keydown
 * handler and this discoverability hint both read it, so the hint can never claim a key the
 * handler doesn't actually bind. Keyed by the same `kind` decisionActions() buttons use. */
const DECIDE_KEYS = { a: 'accept', e: 'edit', w: 'waive', r: 'redirect', f: 'fix-only', s: 'skip' };

function stepKbdHint(kind) {
  const cfg = decisionActions(kind);
  const labelFor = (k) => {
    const b = cfg.buttons.find((btn) => btn.kind === k);
    // Buttons carry an emoji glyph prefix ("✅ Accept") — strip it so the hint reads as plain text.
    return b ? b.label.replace(/^\S+\s*/, '') : k;
  };
  const entries = [['k/j', '←/→ prev/next'],
    ...Object.entries(DECIDE_KEYS).filter(([, k]) => cfg.buttons.some((b) => b.kind === k))
      .map(([key, k]) => [key, labelFor(k)])];
  return h('div', { class: 'step-kbd-hint', title: 'Keyboard shortcuts (disabled while typing)' },
    entries.map(([key, label], i) => [i ? ' · ' : '', h('kbd', {}, key), ' ', label]));
}

/* The stepper: top bar (progress) · item rail · focused step card · prev/next. */
function stepperView(data) {
  const findings = (data.ledger && data.ledger.findings) || [];
  const { items, idx } = state.flow;
  const fp = items[idx];
  const f = findings.find((x) => x.fp === fp);
  const total = items.length;
  const decided = items.filter((id) => state.flow.decisions[id]).length;
  const kind = (data.feature && data.feature.kind) || 'spec';

  const top = h('div', { class: 'step-top' },
    h('div', { class: 'step-top-title' }, 'Reviewing ', h('span', { class: 'meta-dim' }, data.feature.title || current.id)),
    h('span', { class: 'step-progress' }, `${idx + 1} of ${total}`),
    h('div', { class: 'step-progressbar', role: 'progressbar', 'aria-valuenow': String(decided), 'aria-valuemax': String(total) },
      h('i', { style: `width:${total ? Math.round((decided / total) * 100) : 0}%` })),
    stepKbdHint(kind),
    h('button', { class: 'btn step-exit', type: 'button',
      onclick: () => { location.hash = `#/feature/${encodeURIComponent(current.id)}`; } }, 'Exit to board'),
  );

  const card = f ? stepCard(data, f)
    : h('div', { class: 'step-card' }, h('div', { class: 'step-empty' }, 'This finding is no longer available.'));

  return h('div', { class: 'stepper' },
    top,
    h('div', { class: 'step-layout' },
      stepRail(findings, (data.feature && data.feature.kind) || 'spec'),
      h('div', {}, card, stepNav())));
}

function stepRail(findings, kind) {
  const { items, idx } = state.flow;
  const [one, many] = reviewNoun(kind || 'spec');
  const rows = items.map((fp, i) => {
    const f = findings.find((x) => x.fp === fp);
    const dec = state.flow.decisions[fp];
    const sev = f && SEV[f.severity] ? f.severity : 'info';
    return h('button', {
      class: `rail-item ${i === idx ? 'active' : ''} ${dec ? `decided dec-${dec.kind}` : ''}`,
      type: 'button',
      onclick: () => { state.flow.idx = i; state.flow.finish = false; renderFlowInto(); },
    },
      h('span', { class: 'rail-mark' }, dec ? RAIL_MARK[dec.kind] : ''),
      h('span', { class: `rail-sev sev-${sev}` }, SEV[sev].glyph),
      h('span', { class: 'rail-label' }, f ? (f.title || '(untitled)') : fp));
  });
  return h('div', { class: 'step-rail' },
    h('div', { class: 'rail-head' }, plural(items.length, one, many)),
    rows,
    h('button', {
      class: 'rail-item', type: 'button', style: 'margin-top:6px;border-top:1px solid var(--line-soft);border-radius:0 0 var(--radius-sm) var(--radius-sm)',
      onclick: () => { state.flow.finish = true; renderFlowInto(); },
    }, h('span', { class: 'rail-mark' }, '✓'), h('span', { class: 'rail-label' }, 'Finish & summary')));
}

/* The suggestion label per kind: a pr-review finding's suggestion IS the proposed
 * comment, so it's surfaced prominently as "Proposed comment". */
function suggestionLabel(kind) {
  return kind === 'pr-review' ? 'Proposed comment'
    : kind === 'pr-respond' ? 'Proposed reply'
    : 'Suggestion';
}

function stepCard(data, f) {
  const kind = (data.feature && data.feature.kind) || 'spec';
  const sev = SEV[f.severity] ? f.severity : 'info';
  const badge = findingBadge(f, currentRoundNum());
  const hasDraft = !!f.draft;
  const verdict = hasDraft ? draftVerdict(f) : 'proposed';

  const head = h('div', { class: 'step-finding-head' },
    h('div', { class: 'step-titlerow' },
      h('span', { class: `sev-glyph sev-${sev}`, title: SEV[sev].label }, SEV[sev].glyph),
      h('h2', {}, f.title || '(untitled finding)')),
    h('div', { class: 'step-tags' },
      f.dimension ? h('span', { class: 'dim-tag' }, f.dimension) : null,
      badge ? h('span', { class: `f-badge f-badge-${badge}` }, badge === 'new' ? 'NEW' : 'REGRESSED') : null,
      duplicateChip(f),
      notDuplicateChip(f),
      statusChip(f.status),
      verdictChip(f),
      f.locus ? h('code', { class: 'f-locus' }, f.locus) : null));

  const diffSection = hasDraft ? stepDiffSection(f, verdict) : null;

  // The reviewer's saved note (their objection / answer), shown read-only under the suggestion
  // once written — distinct from the suggestion itself. Hidden while the editor is open.
  const noteEl = (f.note && state.flow.editingComment !== f.fp)
    ? h('div', { class: 'f-suggestion f-note' },
        h('span', { class: 'f-suglabel' }, 'Your note'),
        h('p', {}, f.note))
    : null;

  // The detail argues WHY the finding was raised; the proposed comment already carries the ask.
  // Roughly half the comment's vocabulary also appears in the detail, so showing both in full
  // made every decision cost ~1,350 characters of part-duplicate prose. Collapsed by default:
  // decide from title + comment, open this only when the comment does not convince you.
  const whyEl = f.detail
    ? h('details', { class: 'step-why' },
        h('summary', {}, 'Why this was raised'),
        mdBlock(f.detail, 'step-detail'))
    : null;

  // Decision BEFORE the diff. It used to sit last, which on a card with a draft put it ~87%
  // down a 1,500px card — off-screen, so approving cost a scroll to the bottom and back.
  return h('div', { class: `step-card ${verdict !== 'proposed' ? `rm-frame-${verdict}` : ''}`.trim() },
    head,
    whyEl,
    suggestionSection(kind, f),
    noteEl,
    decisionRow(data, f),
    diffSection);
}

/* The "Proposed comment" / "Suggestion" block — editable inline when the user
 * picked "Edit comment" on this finding (pr-review/pr-respond). */
function suggestionSection(kind, f) {
  if (state.flow.editingComment === f.fp) return commentEditForm(kind, f);
  const body = hasSuggestion(f) ? f.suggestion : '';
  if (!body && kind === 'spec') return null;
  const cls = kind === 'spec' ? 'f-suggestion' : 'f-suggestion proposed-comment';
  return h('div', { class: cls },
    h('span', { class: 'f-suglabel' }, suggestionLabel(kind)),
    body ? mdBlock(body, 'md-prose')
      : h('p', {}, h('span', { class: 'meta-dim' }, '(no comment text yet — use Edit)')));
}

/* U-3: submitting an edited comment needs the keyboard, not just the "Save" button — editing a
 * too-long comment is the single most common action in the stepper, so reaching for the mouse
 * here breaks the keyboard-driven loop exactly where it is used most. Bare Enter must still insert
 * a newline (these are multi-line bodies), so the submit chord requires a modifier; either Cmd or
 * Ctrl is accepted so the same handler works on macOS and elsewhere without platform sniffing. The
 * glyph shown in the hint is the ONLY platform-specific bit — it is cosmetic, derived once here, and
 * can never cause the hint to advertise a chord the handler doesn't accept (the handler takes both).
 */
const SAVE_SHORTCUT_MOD = /Mac|iPhone|iPod|iPad/.test(navigator.platform || navigator.userAgent || '') ? '⌘' : 'Ctrl';
const SAVE_SHORTCUT_LABEL = `${SAVE_SHORTCUT_MOD}+Enter`;

function saveKbdHint() {
  return h('span', { class: 'save-kbd-hint', title: 'Submit without leaving the keyboard' },
    h('kbd', {}, SAVE_SHORTCUT_LABEL), ' to save');
}

/* Shared by both textareas below: Escape cancels (unchanged), and Cmd/Ctrl+Enter submits via the
 * SAME callback the Save button calls, so the button and the shortcut can never diverge. Plain
 * Enter is left alone so it still inserts a newline. */
function commentEditTaKeydown(cancel, submit) {
  return (e) => {
    if (e.key === 'Escape') { cancel(); return; }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
  };
}

function commentEditForm(kind, f) {
  function cancel() { state.flow.editingComment = null; state.flow.editingKind = null; reviewRefresh(); }

  // Spec: keep the audit SUGGESTION visible (read-only) and give a SEPARATE field for the
  // reviewer's note — what they object to, or their answer if the finding asks a question.
  // The note persists on the finding (finding.note); the suggestion is left untouched.
  if (kind === 'spec') {
    const decKind = state.flow.editingKind === 'redirect' ? 'redirect' : 'edit';
    const submitNote = () => saveSpecNote(f.fp, ta.value, decKind);
    const ta = h('textarea', {
      class: 'comment-edit-ta', rows: '4', spellcheck: 'true',
      'aria-label': 'Your note / response',
      placeholder: decKind === 'redirect'
        ? "Why is this the wrong fix, or where/how should it be done instead? (your counter)"
        : "Your note: what to change about the suggestion, or your answer if it asks for clarification.",
      onkeydown: commentEditTaKeydown(cancel, submitNote),
    });
    ta.value = f.note || '';
    const form = h('div', { class: 'comment-edit' },
      f.suggestion ? h('div', { class: 'f-suggestion' },
        h('span', { class: 'f-suglabel' }, 'Suggestion'),
        mdBlock(f.suggestion, 'md-prose')) : null,
      h('span', { class: 'f-suglabel' }, decKind === 'redirect' ? 'Your counter / answer' : 'Your note / answer'),
      ta,
      h('div', { class: 'comment-edit-actions' },
        h('button', { class: 'btn btn-accent', type: 'button', onclick: submitNote }, 'Save note'),
        h('button', { class: 'btn', type: 'button', onclick: cancel }, 'Cancel'),
        saveKbdHint()));
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); });
    return form;
  }

  // PR: the suggestion IS the proposed comment, so editing it inline is the intent.
  const submitComment = () => saveComment(f.fp, ta.value);
  const ta = h('textarea', {
    class: 'comment-edit-ta', rows: '5', spellcheck: 'true',
    'aria-label': `${suggestionLabel(kind)} — editing`,
    onkeydown: commentEditTaKeydown(cancel, submitComment),
  });
  ta.value = f.suggestion || '';
  const form = h('div', { class: 'comment-edit proposed-comment' },
    h('span', { class: 'f-suglabel' }, `${suggestionLabel(kind)} — editing`),
    ta,
    h('div', { class: 'comment-edit-actions' },
      h('button', { class: 'btn btn-accent', type: 'button', onclick: submitComment }, 'Save & approve'),
      h('button', { class: 'btn', type: 'button', onclick: cancel }, 'Cancel'),
      saveKbdHint()));
  requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); });
  return form;
}

/* Persist a spec finding's reviewer NOTE (separate from the suggestion) plus the chosen decision
 * (edit keeps the suggestion + your note; redirect routes it elsewhere with your counter). */
async function saveSpecNote(fp, note, decKind) {
  const f = findFinding(fp);
  if (f) f.note = note;                       // optimistic
  setFlowDecision(fp, decKind);
  state.flow.editingComment = null;
  state.flow.editingKind = null;
  reviewRefresh();
  try {
    // Persist the note; for 'edit' also persist the decision so it's durable across refresh.
    const body = decKind === 'edit' ? { note, decision: 'edit' } : { note };
    await api(`/api/features/${encodeURIComponent(current.id)}/findings/${encodeURIComponent(fp)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    await loadDetail(current.id, true);
  } catch (e) {
    toast(`Note save failed: ${e.message}`);
    try { await loadDetail(current.id, true); } catch { /* keep optimistic */ }
  }
  reviewRefresh();
}

/* Persist the edited proposed-comment body (via setFindingDetails on the server),
 * mark the finding Approved (edited), and close the editor. */
async function saveComment(fp, val) {
  const f = findFinding(fp);
  if (f) { f.suggestion = val; f.decision = 'edit'; }   // optimistic
  setFlowDecision(fp, 'edit');
  state.flow.editingComment = null;
  reviewRefresh();
  try {
    // Persist the edited body AND the edit decision together, so the approval is durable.
    await api(`/api/features/${encodeURIComponent(current.id)}/findings/${encodeURIComponent(fp)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ suggestion: val, decision: 'edit' }),
    });
    await loadDetail(current.id, true);
  } catch (e) {
    toast(`Comment save failed: ${e.message}`);
    try { await loadDetail(current.id, true); } catch { /* keep optimistic state */ }
  }
  reviewRefresh();
}

/* The red/green diff section (present only when a finding carries a code-diff
 * draft). Pulled out of stepCard so suggestion-only findings render without it. */
function stepDiffSection(f, verdict) {
  const { adds, dels, hunks } = draftStats(f);
  const renderable = canRenderProse(f);
  const mkTab = (mode, label) => h('button', {
    class: `diff-tab ${state.diffMode === mode ? 'active' : ''}`, type: 'button', 'aria-label': `${label} view`,
    onclick: () => { state.diffMode = mode; reviewRefresh(); },
  }, label);

  const diffHead = h('div', { class: 'step-diffhead' },
    h('span', { class: 'step-section-label' }, 'Proposed change'),
    h('code', { class: 'diff-target' }, (f.draft && f.draft.target) || f.locus || '—'),
    h('span', { class: 'diff-counts' },
      h('span', { class: 'diff-add-n' }, `+${adds}`), ' ', h('span', { class: 'diff-del-n' }, `−${dels}`)),
    hunks.length ? h('div', { class: 'diff-toggle', role: 'group', 'aria-label': 'Diff view mode' },
      renderable ? mkTab('rendered', 'Rendered') : null, mkTab('unified', 'Unified'), mkTab('split', 'Split')) : null);

  const banner = verdict !== 'proposed'
    ? h('div', { class: `rm-verdict-banner verdict-${verdict}` },
        h('span', { class: 'verdict-glyph' }, VERDICT_GLYPH[verdict]),
        verdict === 'reject'
          ? 'Rejected — the proposed change below is overridden by your note.'
          : 'Redirect — the proposed change below is superseded; the agent follows your note instead.')
    : null;

  return h('div', { class: 'step-diffwrap' }, diffHead, banner, ...reviewBodyKids(f));
}

function decisionRow(data, f) {
  const kind = (data.feature && data.feature.kind) || 'spec';
  const cfg = decisionActions(kind);
  if (state.flow.waiving === f.fp) {
    return h('div', { class: 'decision-row' },
      h('span', { class: 'decision-label' }, 'Waive'),
      stepWaiveForm(f));
  }
  const dec = state.flow.decisions[f.fp];
  const decKind = dec && dec.kind;
  const mk = (b) => h('button', {
    class: `dec-btn ${b.cls} ${decKind === b.kind ? 'on' : ''}`, type: 'button',
    'aria-pressed': decKind === b.kind ? 'true' : 'false',
    // Disabled rather than merely failing: reading a finding, forming a judgement and clicking
    // Approve only to be told afterwards that nothing was recorded wastes the most expensive part
    // of a review. The banner says why the whole row is dead.
    disabled: readOnlyMode() ? 'disabled' : undefined,
    title: readOnlyMode() ? READ_ONLY_TITLE : undefined,
    onclick: () => decide(data, f, b.kind),
  }, b.label);
  const tag = cfg.tagLabels
    ? h('span', { class: `triage-tag triage-${decKind || 'undecided'}` }, cfg.tagLabels[decKind || 'undecided'] || cfg.tagLabels.undecided)
    : null;
  const undo = decKind
    ? h('button', { class: 'dec-undo', type: 'button', title: 'Clear this decision', onclick: () => undecide(f) }, '↺ Undo')
    : null;
  // The click landed locally (decKind/tag above already reflect it) but the server never
  // confirmed it — say so here rather than let the tag imply it's saved (U-2).
  const notSaved = state.flow.persistFailed[f.fp]
    ? h('button', {
        class: 'dec-not-saved', type: 'button',
        title: 'The server did not confirm this decision.', onclick: () => retryPersist(f.fp),
      }, '⚠ not saved — retry')
    : null;
  const row = h('div', { class: 'decision-row' },
    h('span', { class: 'decision-label' }, cfg.label || 'Decision'),
    ...cfg.buttons.map(mk),
    tag, undo, notSaved);
  return cfg.helper
    ? h('div', { class: 'decision-wrap' }, row, h('p', { class: 'decision-helper meta-dim' }, cfg.helper))
    : row;
}

/* Undo a `reject`/`redirect` decision by resetting the draft verdict itself back to `proposed`,
 * through the same endpoint the verdict control uses (setVerdict/reviewNoteSection, app.js:
 * ~4549/~4517) — preserving `draft.review.note`, since that's the reviewer's own written
 * rationale and Undo only withdraws the decision, not their words. Without this, undecide()
 * only ever cleared the LOCAL state.flow.decisions entry and the (irrelevant, for these two
 * kinds) top-level `decision` field, leaving the ledger's `verdict` still `reject`/`redirect`
 * while the card read "Undecided" — exactly the gap `approveAllRemaining`'s undecidedFlowFps()
 * swept into a silent approve (NEW-1). Reports failure via markPersisted/toast, same as every
 * other persist helper here, so a dropped write shows "not saved — retry" instead of the UI and
 * ledger quietly disagreeing. */
async function resetVerdictToProposed(fp) {
  const f = findFinding(fp);
  if (!f || !f.draft) { markPersisted(fp, true); return true; }
  const prev = f.draft.review ? structuredClone(f.draft.review) : undefined;
  const cur = f.draft.review || {};
  f.draft.review = { ...cur, hunks: cur.hunks || {}, verdict: 'proposed', updatedAt: new Date().toISOString() };
  reviewRefresh();
  try {
    await api(`/api/features/${encodeURIComponent(current.id)}/findings/${encodeURIComponent(fp)}/draft/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verdict: 'proposed' }),
    });
    markPersisted(fp, true);
    return true;
  } catch (e) {
    // The write failed, so the ledger still holds the old verdict — roll the local copy back to
    // match it rather than let the UI claim a reset that didn't happen.
    if (prev === undefined) delete f.draft.review; else f.draft.review = prev;
    toast(`Could not clear the ${prev && prev.verdict} verdict: ${e.message} — it will show as "not saved" until you retry`);
    markPersisted(fp, false);
    reviewRefresh();
    return false;
  }
}

async function undecide(f) {
  const wasDec = state.flow.decisions[f.fp];
  // `reject`/`redirect` are decided purely via draft.review.verdict (hydrateDecisions, app.js:
  // ~689) — there is no top-level `decision` field backing them, so the `{decision:null}` POST
  // below is a no-op for these two kinds and Undo needs the extra step below to actually undo.
  const verdictDerived = wasDec && (wasDec.kind === 'reject' || wasDec.kind === 'redirect');
  delete state.flow.decisions[f.fp];
  state.flow.waiving = null;
  state.flow.editingComment = null;
  state.flow.editingKind = null;
  reviewRefresh();
  // Clear the persisted decision too: a dismissed (waived) finding is reopened; an
  // approve/edit marker is simply removed. Keeps every surface in sync.
  try {
    const body = f.status === 'waived' ? { status: 'open' } : { decision: null };
    await api(`/api/features/${encodeURIComponent(current.id)}/findings/${encodeURIComponent(f.fp)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (verdictDerived && !(await resetVerdictToProposed(f.fp))) return;   // already toasted + flagged + re-rendered
    await loadDetail(current.id, true);
  } catch (e) {
    toast(`Could not clear decision: ${e.message}`);
  }
  reviewRefresh();
}

function stepWaiveForm(f) {
  const input = h('input', {
    class: 'waive-input', type: 'text', placeholder: 'Why is this acceptable as-is? (required)',
    'aria-label': 'Waive reason',
    onkeydown: (e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') cancel(); },
  });
  function submit() {
    const r = input.value.trim();
    if (!r) { input.classList.add('invalid'); input.focus(); return; }
    setFlowDecision(f.fp, 'waive', { reason: r });
    state.flow.waiving = null;
    advance();
  }
  function cancel() { state.flow.waiving = null; renderFlowInto(); }
  const form = h('div', { class: 'waive-form' }, input,
    h('div', { style: 'display:flex;gap:6px' },
      h('button', { class: 'btn btn-accent', type: 'button', onclick: submit }, 'Waive & next'),
      h('button', { class: 'btn', type: 'button', onclick: cancel }, 'Cancel')));
  requestAnimationFrame(() => input.focus());
  return form;
}

/* Shared with the j/k keyboard shortcuts (U-5) so both routes move the stepper identically. */
function stepGoPrev() {
  if (state.flow.idx <= 0) return;
  state.flow.idx--;
  renderFlowInto();
}
/* Reconcile BEFORE asking "was that the last one?". A finding ingested while the reviewer was
 * deciding is already in state.detail but not yet in state.flow.items, and measuring against the
 * stale list jumped straight to the summary instead of walking them onto the new item. Nothing was
 * lost — it appeared there as Undecided — but they were never taken to it. */
function syncFlowBeforeMove() {
  if (state.detail) reconcileFlowItems(state.detail);
}

function stepGoNext() {
  syncFlowBeforeMove();
  if (state.flow.idx >= state.flow.items.length - 1) state.flow.finish = true;
  else state.flow.idx++;
  renderFlowInto();
}

function stepNav() {
  const { idx, items } = state.flow;
  const atFirst = idx <= 0;
  const atLast = idx >= items.length - 1;
  return h('div', { class: 'step-nav' },
    h('button', { class: 'btn', type: 'button', disabled: atFirst, title: 'Previous (k / ←)',
      onclick: stepGoPrev }, '← Prev'),
    h('span', { class: 'step-nav-mid' }, `${idx + 1} / ${items.length}`),
    h('button', { class: 'btn btn-accent', type: 'button', title: 'Next (j / →)',
      onclick: stepGoNext },
      atLast ? 'Finish →' : 'Next →'));
}

function setFlowDecision(fp, kind, extra = {}) {
  state.flow.decisions[fp] = { kind, ...extra };
}

function advance() {
  syncFlowBeforeMove();
  if (state.flow.idx >= state.flow.items.length - 1) state.flow.finish = true;
  else state.flow.idx++;
  renderFlowInto();
}

/* Decisions persist via the existing draft-review API (so the board + export
 * reflect them); nothing touches finding *status* until the finish/Post screen. */
async function decide(data, f, kind) {
  const fp = f.fp;
  const wsKind = (data.feature && data.feature.kind) || 'spec';
  const cfg = decisionActions(wsKind);
  // The stepper advances to the next finding after a terminal decision; the modal
  // has no "next", so it just re-renders in place.
  const inStepper = current.view === 'review-flow';
  const next = () => { if (inStepper) advance(); else reviewRefresh(); };

  // pr-review: Edit opens the proposed comment in a textarea (not the per-hunk
  // diff). In the modal's detail sub-view, route into the review sub-view so the
  // editable comment is actually visible.
  if (kind === 'edit' && cfg.editsComment) {
    state.flow.editingComment = fp;
    if (!inStepper) state.modalMode = 'review';
    reviewRefresh();
    requestAnimationFrame(() => { const ta = $('.comment-edit-ta'); if (ta) ta.focus(); });
    return;
  }
  // pr-review: Dismiss is a one-tap decision (reason optional). Persist it as `waived`
  // straight away so the card moves to the Waived lane and the decision survives a refresh.
  if (kind === 'waive' && cfg.quickDismiss) {
    setFlowDecision(fp, 'waive', { reason: '' });
    const ok = await persistWaive(fp, 'dismissed');
    // A failed persist must not read as done: stay put and show "not saved" rather than
    // auto-advancing to a summary that claims this was dismissed (U-2).
    if (ok) next(); else reviewRefresh();
    return;
  }

  if (kind === 'accept') {
    setFlowDecision(fp, 'accept');
    const ok = await persistDecisionField(fp, 'approve');   // persist the approve so every surface agrees
    if (!ok) { reviewRefresh(); return; }
    await acceptAll(f);
    next();
  } else if (kind === 'fix-only') {
    // Apply the fix exactly as drafted, and post NO reply: accept the hunks (so the runner knows
    // what to write to the working tree) and persist `fix-only`, which is what tells the runner to
    // resolve the thread instead of answering it. A thread-only item with no code draft has no fix
    // to apply, so this decision would be a no-op — refuse it rather than silently swallow it.
    if (!f.draft) {
      toast('Nothing to fix here — this thread has no proposed code change. Use Reply or Push back.');
      return;
    }
    setFlowDecision(fp, 'fix-only');
    const ok = await persistDecisionField(fp, 'fix-only');
    if (!ok) { reviewRefresh(); return; }
    await acceptAll(f);
    next();
  } else if (kind === 'edit') {
    setFlowDecision(fp, 'edit');
    // Suggestion-only finding (no code-diff draft): there are no per-hunk controls to reveal, so
    // open the inline editor — the reviewer keeps the suggestion visible and writes a separate
    // note/answer. Save persists the note on the finding.
    if (!f.draft) {
      state.flow.editingComment = fp;
      state.flow.editingKind = 'edit';
      if (!inStepper) state.modalMode = 'review';
      reviewRefresh();
      requestAnimationFrame(() => { const ta = $('.comment-edit-ta'); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } });
      return;
    }
    if (!inStepper) state.modalMode = 'review';
    if (draftVerdict(f) !== 'proposed') await setVerdict(fp, 'proposed');
    else reviewRefresh();   // reveal the per-hunk controls; reviewer edits then Next
  } else if (kind === 'redirect') {
    setFlowDecision(fp, 'redirect');
    // Suggestion-only finding: same editor (suggestion read-only + a counter/answer field), so the
    // reviewer can write where/how it should be done instead even without a code-diff draft.
    if (!f.draft) {
      state.flow.editingComment = fp;
      state.flow.editingKind = 'redirect';
      if (!inStepper) state.modalMode = 'review';
      reviewRefresh();
      requestAnimationFrame(() => { const ta = $('.comment-edit-ta'); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } });
      return;
    }
    if (!inStepper) state.modalMode = 'review';
    if (draftVerdict(f) !== 'redirect') await setVerdict(fp, 'redirect');
    else reviewRefresh();
    requestAnimationFrame(() => { const ta = $('.review-note-ta'); if (ta) ta.focus(); });
  } else if (kind === 'waive') {
    state.flow.waiving = fp;
    reviewRefresh();
  } else if (kind === 'skip') {
    setFlowDecision(fp, 'skip');
    next();
  }
}

/* A decision the Decision Summary lists as e.g. "Apply as proposed" must mean the server
 * actually holds it — otherwise the summary is describing a click, not a saved state. Both
 * persist helpers below report ok/failed here instead of only toasting, so a dropped POST
 * (server down mid-stepper, say) stays visible on the finding and blocks Apply rather than
 * silently reading as decided. Cleared the moment a later persist for the same fp succeeds. */
function markPersisted(fp, ok) {
  if (ok) delete state.flow.persistFailed[fp];
  else state.flow.persistFailed[fp] = true;
}

/* Persist a triage decision (approve/edit, or null to clear) onto the finding so the board,
 * stepper and Post screen stay in sync and it survives a refresh. Optimistic, then reloads.
 * Returns whether the server actually accepted it — callers must not advance/report success
 * on a false return (U-2).
 * `reload:false` skips the loadDetail() round-trip this call would otherwise do on its own —
 * used by approveAllRemaining, which persists many findings and would otherwise turn one bulk
 * action into N sequential GETs; that caller does exactly one reload itself once every write
 * has settled. Every other caller keeps the default (reload after this one write) unchanged. */
async function persistDecisionField(fp, decision, { reload = true } = {}) {
  const cur = findFinding(fp);
  if (cur) { if (decision) cur.decision = decision; else delete cur.decision; }
  try {
    await api(`/api/features/${encodeURIComponent(current.id)}/findings/${encodeURIComponent(fp)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    });
    if (reload) await loadDetail(current.id, true);
    markPersisted(fp, true);
    return true;
  } catch (e) {
    toast(`Could not save decision: ${e.message} — it will show as "not saved" until you retry`);
    if (reload) { try { await loadDetail(current.id, true); } catch { /* keep optimistic */ } }
    markPersisted(fp, false);
    return false;
  }
}

/* Dismiss = persist the finding as `waived` immediately (it moves to the Waived lane and the
 * decision sticks across refreshes), rather than holding the decision only in the browser.
 * Returns whether the server accepted it — same contract as persistDecisionField. */
async function persistWaive(fp, reason) {
  const cur = findFinding(fp);
  if (cur) { cur.status = 'waived'; cur.statusReason = reason || 'dismissed'; }   // optimistic
  try {
    await api(`/api/features/${encodeURIComponent(current.id)}/findings/${encodeURIComponent(fp)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'waived', reason: reason || 'dismissed' }),
    });
    await loadDetail(current.id, true);
    markPersisted(fp, true);
    return true;
  } catch (e) {
    toast(`Could not dismiss: ${e.message} — it will show as "not saved" until you retry`);
    try { await loadDetail(current.id, true); } catch { /* keep optimistic */ }
    markPersisted(fp, false);
    return false;
  }
}

/* Retry a decision whose persist previously failed (surfaced as "not saved — retry" on the
 * decision row and the Decision Summary). Re-issues the same persist call decide() made —
 * doesn't re-run acceptAll/advance, so it's safe to call from the finish screen without
 * disturbing the reviewer's position. */
async function retryPersist(fp) {
  const dec = state.flow.decisions[fp];
  const f = findFinding(fp);
  if (dec && dec.kind === 'accept') await persistDecisionField(fp, 'approve');
  else if (dec && dec.kind === 'fix-only') await persistDecisionField(fp, 'fix-only');
  else if (dec && dec.kind === 'waive') await persistWaive(fp, dec.reason || 'dismissed');
  // undecide() already deleted `dec` before this can fail (NEW-1: resetVerdictToProposed rolls
  // f.draft.review back to its pre-reset verdict on failure) — so the only signal left that an
  // Undo's verdict-reset is what needs retrying is the rolled-back verdict itself.
  else if (!dec && f && ['reject', 'redirect'].includes(draftVerdict(f))) await resetVerdictToProposed(fp);
  else { delete state.flow.persistFailed[fp]; }   // decisions with no direct persist call (edit/redirect/reject/skip)
  reviewRefresh();
}

/* Accept the whole proposal: mark every hunk accepted + verdict proposed, in one
 * merged POST. Optimistic, then reconciled from the server.
 * `reload:false` (see persistDecisionField above) — approveAllRemaining calls this once per
 * undecided finding and does its own single reload afterward instead of one per finding. */
async function acceptAll(f, { reload = true } = {}) {
  // Suggestion-only finding (no code-diff draft): the approval is the decision —
  // there's nothing to persist server-side until the Post step.
  if (!f.draft) { if (reload) reviewRefresh(); return; }
  const { hunks } = draftStats(f);
  const hunkObj = {};
  for (const hk of hunks) hunkObj[String(hk.id)] = { status: 'accepted', at: new Date().toISOString() };
  const cur = findFinding(f.fp);
  if (cur && cur.draft) {
    cur.draft.review = { ...(cur.draft.review || {}), hunks: hunkObj, verdict: 'proposed', updatedAt: new Date().toISOString() };
  }
  if (reload) reviewRefresh();
  try {
    const body = hunks.length ? { hunks: hunkObj, verdict: 'proposed' } : { verdict: 'proposed' };
    await api(`/api/features/${encodeURIComponent(current.id)}/findings/${encodeURIComponent(f.fp)}/draft/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (reload) await loadDetail(current.id, true);
  } catch (e) {
    toast(`Accept failed: ${e.message}`);
    if (reload) { try { await loadDetail(current.id, true); } catch { /* keep optimistic state */ } }
  }
  if (reload) reviewRefresh();
}

/* A finding is "currently undecided" iff nothing was ever recorded for it in
 * state.flow.decisions — NOT flowDecisionKind(fp) === 'skip'. flowDecisionKind() falls back to
 * 'skip' for exactly this empty case, but pr-respond/spec workspaces also have a real, explicit
 * Skip button that calls setFlowDecision(fp, 'skip') and lands in the SAME 'skip' bucket. Treating
 * that as "undecided" would let approveAllRemaining silently overturn a reviewer's considered
 * Skip — the same mistake the unit exists to rule out for Dismiss/Edit/Redirect/Waive. Checking
 * the decisions map directly is the only way to tell "never touched" apart from "decided: skip". */
function undecidedFlowFps() {
  return (state.flow.items || []).filter((fp) => !state.flow.decisions[fp]);
}

/* Bulk-clear an obvious batch of PR-review findings in one confirmed action, instead of costing
 * one visit per finding through the stepper (U-2: no bulk action existed anywhere in the app).
 * Mirrors decide()'s 'accept' branch exactly — same setFlowDecision + persistDecisionField(approve)
 * + acceptAll(hunks/verdict) a single Approve click makes — so a reload hydrates these findings
 * back to 'accept' via hydrateDecisions() the same way it would for any one-at-a-time approval.
 * The only difference from N single Approves is that every write here passes reload:false and the
 * function does ONE loadDetail() at the end: there is no bulk decision-write endpoint on the
 * server (only /review/apply, which bulk-sets finding *status* for the post/apply hand-off, not
 * the `decision` field an Approve writes), and standing up a new endpoint just to collapse a
 * handful of requests into one wasn't worth the added server surface for this unit.
 * Never touches an already-decided finding: only undecidedFlowFps() is ever passed to
 * setFlowDecision here. It must NEVER be called except from the confirmed step in
 * approveAllControl — this posts nothing (no /review/apply, no enqueueApply), it only records
 * decisions the separate, explicit Post click still has to act on. */
async function approveAllRemaining(data) {
  const kind = (data.feature && data.feature.kind) || 'spec';
  if (kind !== 'pr-review') return;   // scoped to pr-review's Approve/Edit/Dismiss triage
  const fps = undecidedFlowFps();
  if (!fps.length) return;
  state.flow.bulkApproving = true;
  // try/finally: if anything in here throws unexpectedly (the initial render below,
  // setFlowDecision, a later render, whatever), bulkApproving must still come back down. Without
  // it the control is stuck reading "Approving…" — disabled, dead — until the page is reloaded,
  // over one bad write. The initial renderFlowInto() call used to sit OUTSIDE this try, so a
  // throw during THAT render left bulkApproving stuck true with the finally never reached.
  try {
    renderFlowInto();
    for (const fp of fps) setFlowDecision(fp, 'accept');   // optimistic, same as a single Approve
    await Promise.allSettled(fps.map(async (fp) => {
      const ok = await persistDecisionField(fp, 'approve', { reload: false });
      if (!ok) return;   // markPersisted(fp, false) already flagged it — the "not saved" retry picks it up
      const f = findFinding(fp);
      if (f) await acceptAll(f, { reload: false });
    }));
    try { await loadDetail(current.id, true); } catch { /* per-item persistFailed flags already stand */ }
  } finally {
    state.flow.bulkApproving = false;
    state.flow.confirmApproveAll = false;
    renderFlowInto();
  }
}

/* The finish screen's bulk-triage control: sits under the tallies row (a triage action, reviewed
 * alongside the counts it changes) and deliberately far from postActionEl's Post button below —
 * this decides findings, it never sends anything, and must not be mistaken for the posting step.
 * Renders nothing when there is nothing undecided, so it can never read as an invitation to
 * "approve" a batch that's already been triaged. Requires an inline two-step confirm (matching
 * stepWaiveForm's pattern) before it writes anything, because a single click here can approve
 * many PR comments that a LATER click posts for real — window.confirm is banned in this app, so
 * the confirmation is built the same way every other one here is: with h(). */
function approveAllControl(data) {
  const kind = (data.feature && data.feature.kind) || 'spec';
  if (kind !== 'pr-review') return null;
  const fps = undecidedFlowFps();
  if (!fps.length) return null;
  const n = fps.length;
  if (state.flow.confirmApproveAll) {
    const busy = !!state.flow.bulkApproving;
    return h('div', { class: 'approve-all-confirm' },
      h('span', { class: 'approve-all-confirm-msg' }, `Approve ${n} remaining?`),
      h('button', {
        class: 'btn btn-accent', type: 'button', disabled: busy, 'aria-busy': busy ? 'true' : 'false',
        onclick: () => approveAllRemaining(data),
      }, busy ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : null, busy ? ' Approving…' : 'Yes'),
      h('button', {
        class: 'btn', type: 'button', disabled: busy,
        onclick: () => { state.flow.confirmApproveAll = false; renderFlowInto(); },
      }, 'Cancel'));
  }
  return h('button', {
    class: 'btn approve-all-btn', type: 'button',
    disabled: readOnlyMode() ? 'disabled' : undefined,
    title: readOnlyMode() ? READ_ONLY_TITLE
      : 'Approve every finding below still marked Undecided. It never touches a finding you '
      + 'already Dismissed, Edited, or otherwise decided. Nothing is posted — Post stays a separate click.',
    onclick: () => { state.flow.confirmApproveAll = true; renderFlowInto(); },
  }, `✓ Approve ${n} remaining`);
}

/* ---- finish: the decision summary ---- */

function flowDecisionKind(fp) {
  const dec = state.flow.decisions[fp];
  return (dec && dec.kind) || 'skip';
}

/* Per-kind labels for the finish-screen decision tallies + summary pills.
 * `reject` gets its own column/pill in every kind here — same reasoning as DEC_LABEL/RAIL_MARK
 * above: hydrateDecisions now records a `reject` verdict as its own decided kind (mirroring
 * `redirect`), so without an entry here it would either mis-render as the literal string
 * "reject" (pill falls back to the raw key) or vanish from the tally row entirely while still
 * counting toward the reviewed total — both read as a miscount on the one screen this bug was
 * about. */
const FINISH_TALLIES = {
  spec: [
    ['accept', 'Apply as proposed'], ['edit', 'Apply with edits'],
    ['redirect', 'Redirect'], ['reject', 'Reject'], ['waive', 'Waive'], ['skip', 'Skipped'],
  ],
  'pr-review': [
    ['accept', 'Approved'], ['edit', 'Edited'], ['reject', 'Rejected'], ['waive', 'Dismissed'], ['skip', 'Undecided'],
  ],
  'pr-respond': [
    ['accept', 'Reply'], ['edit', 'Fix + reply'], ['fix-only', 'Fix, no reply'],
    ['redirect', 'Push back'], ['reject', 'Rejected'], ['skip', 'Skipped'],
  ],
};
const DEC_PILL = {
  spec: DEC_LABEL,
  'pr-review': { accept: 'Approved', edit: 'Edited', redirect: 'Redirect', reject: 'Rejected', waive: 'Dismissed', skip: 'Undecided' },
  'pr-respond': { accept: 'Reply', edit: 'Fix + reply', 'fix-only': 'Fix, no reply', redirect: 'Push back', reject: 'Rejected', waive: 'Dismissed', skip: 'Skipped' },
};

/* The PR number for a pr-review/pr-respond workspace, read off the title (#482)
 * or the id (pr-482-…), so the Post button can name the target PR. */
function prNumber(feature) {
  const t = (feature && feature.title) || '';
  let m = t.match(/#(\d+)/);
  if (m) return m[1];
  const id = (feature && feature.id) || '';
  m = id.match(/pr-?(\d+)/i) || id.match(/(\d+)/);
  return m ? m[1] : null;
}

function finishView(data) {
  const findings = (data.ledger && data.ledger.findings) || [];
  const kind = (data.feature && data.feature.kind) || 'spec';
  const isPr = kind === 'pr-review' || kind === 'pr-respond';
  const counts = { accept: 0, edit: 0, redirect: 0, reject: 0, waive: 0, skip: 0 };
  const byTarget = new Map();
  for (const fp of state.flow.items) {
    const f = findings.find((x) => x.fp === fp);
    if (!f) continue;
    const dec = state.flow.decisions[fp];
    const dk = (dec && dec.kind) || 'skip';
    counts[dk] = (counts[dk] || 0) + 1;
    const target = (f.draft && f.draft.target && f.draft.target.trim()) || f.locus || '—';
    if (!byTarget.has(target)) byTarget.set(target, []);
    byTarget.get(target).push({ f, kind: dk, reason: dec && dec.reason });
  }

  const [, many] = reviewNoun(kind);
  const tally = (cls, label, n) => h('span', { class: `finish-tally t-${cls}` },
    h('span', { class: 'num' }, String(n)), label);
  const tallySpecs = FINISH_TALLIES[kind] || FINISH_TALLIES.spec;
  const head = h('div', { class: 'finish-head' },
    h('h1', {}, isPr ? 'Triage summary' : 'Decision summary'),
    h('p', { class: 'view-sub' }, `${plural(state.flow.items.length, many.replace(/s$/, ''), many)} reviewed · ${data.feature.title || current.id}`),
    h('div', { class: 'finish-tallies' },
      tallySpecs.map(([k, label]) => tally(k, label, counts[k] || 0))),
    // Sits under the tallies it acts on — a triage row, not a posting control. See
    // approveAllControl's own comment for why it must stay far from postActionEl's Post button.
    // Renders no node at all (approveAllControl returns null) when nothing is left to approve.
    approveAllControl(data));

  const pillMap = DEC_PILL[kind] || DEC_LABEL;
  const groups = [...byTarget.entries()].map(([target, rows]) => h('div', { class: 'finish-group' },
    h('div', { class: 'finish-group-head' }, h('code', { class: 'finish-target' }, target)),
    h('div', { class: 'finish-rows' }, rows.map(({ f, kind: dk, reason }) => {
      const sev = SEV[f.severity] ? f.severity : 'info';
      // A decision the server never confirmed must not read the same as a saved one here —
      // this IS the screen that told the reviewer their click "will be applied" (U-2).
      const notSaved = state.flow.persistFailed[f.fp]
        ? h('button', {
            class: 'dec-not-saved', type: 'button',
            title: 'The server did not confirm this decision.', onclick: () => retryPersist(f.fp),
          }, '⚠ not saved — retry')
        : null;
      return h('div', { class: 'finish-row' },
        h('span', { class: `sev-glyph sev-${sev}` }, SEV[sev].glyph),
        h('span', { class: 'frow-title' }, f.title || '(untitled)',
          reason ? h('span', { class: 'meta-dim' }, ` — ${reason}`) : null),
        h('span', { class: `dec-pill dec-${dk}` }, pillMap[dk] || dk),
        notSaved);
    }))));

  // `fix-only` belongs here too: it's the decision with the MOST to hand a coding agent (a code
  // change and no reply to soften it). Omitting it made the work order claim "no applicable changes"
  // on a screen showing two agreed fixes.
  const applyKinds = (fp) => ['accept', 'edit', 'fix-only', 'redirect'].includes(flowDecisionKind(fp));
  const reworkFps = state.flow.items.filter(applyKinds);
  const waiveItems = state.flow.items
    .filter((fp) => flowDecisionKind(fp) === 'waive')
    .map((fp) => ({ fp, reason: (state.flow.decisions[fp] && state.flow.decisions[fp].reason) || '' }));
  const toExport = reworkFps.map((fp) => findings.find((x) => x.fp === fp)).filter(Boolean);
  // Findings this screen is about to write back or mark in-flight, but whose decision the
  // server never confirmed — Apply/Mark must refuse rather than act on a click that may not
  // be what's actually recorded server-side (U-2).
  const unsavedInScope = [...reworkFps, ...waiveItems.map((w) => w.fp)]
    .filter((fp) => state.flow.persistFailed[fp]);
  const unsavedWarning = unsavedInScope.length
    ? h('p', { class: 'finish-unsaved-warning' },
        `⚠ ${plural(unsavedInScope.length, 'decision', 'decisions')} above didn't save to the server — retry ${unsavedInScope.length === 1 ? 'it' : 'them'} before applying or marking in-flight.`)
    : null;

  const exportEl = toExport.length
    ? exportPanel(data.feature, toExport, 'feature')
    : h('p', { class: 'meta-dim export-empty' }, 'No applicable changes to export — every item was waived or skipped.');

  // Spec: "Apply accepted changes" (write-back to ADO/Confluence via the runner) is the primary
  // action; "Mark in-flight" stays as the local-only bookkeeping. PR: the Post gate is the whole
  // action (postActionEl). Only accept/edit are written back — redirect is countered (re-auditing),
  // reject/waive/skip are not.
  const applyN = reworkFps.length + waiveItems.length;
  const applyableFps = state.flow.items.filter((fp) => ['accept', 'edit'].includes(flowDecisionKind(fp)));
  const applyableN = applyableFps.length;
  // Apply only writes findings that carry an actual before→after draft bound to a write target
  // (targetRef) and aren't rejected/redirected. Approving a finding ≠ having a writable proposal —
  // drafts come from /flowlever:propose. Gating on this is what stops Apply from silently no-opping.
  const isDraftable = (fp) => {
    const ff = findings.find((x) => x.fp === fp);
    const dr = ff && ff.draft;
    const tr = dr && dr.targetRef;
    const verdict = dr && dr.review && dr.review.verdict;
    return !!tr && verdict !== 'reject' && verdict !== 'redirect';
  };
  const draftableFps = applyableFps.filter(isDraftable);
  const draftableN = draftableFps.length;
  const undraftedN = applyableN - draftableN;   // approved/edited but no writable draft yet
  const applyReqs = state.flow.applyReqs || [];
  const activeApply = applyReqs.find((r) => r.status === 'queued' || r.status === 'running');
  const busy = !!(state.flow.applying || activeApply);
  // The primary spec button has three modes: APPLY (writable drafts exist) · PROPOSE (approved but
  // nothing drafted yet — clicking drafts them) · disabled (nothing accepted). This is what makes
  // "Draft proposals first" actually DO something instead of being an inert disabled button.
  const proposeMode = !busy && draftableN === 0 && undraftedN > 0;
  const applyMode = !busy && draftableN > 0;
  const applyLabel = busy
    ? (activeApply && activeApply.status === 'running'
        ? `⏳ Applying${activeApply.phase ? ` · ${activeApply.phase}` : '…'}`
        : '⏳ Queued…')
    : (applyMode ? `Apply ${plural(draftableN, 'change', 'changes')} → ADO / Confluence`
        : proposeMode ? `Draft ${plural(undraftedN, 'proposal', 'proposals')} first`
        : 'Nothing accepted to apply');
  // Apply writes real proposals to real ADO/Confluence targets — the same class of action
  // PR posting gates behind an explicit "Run now?" (renderRunnerZone's showConfirm). A single
  // click used to both queue the write and start the runner that executes it; this makes Apply
  // ask the same are-you-sure, naming what gets written and where, before doing either.
  const confirmingApply = applyMode && !!state.flow.confirmApply;
  const applyPrimary = confirmingApply
    ? h('span', { class: 'apply-confirm' },
        h('span', { class: 'runner-confirm-msg' },
          `Write ${plural(draftableN, 'change', 'changes')} to ADO work-item fields / Confluence sections now?`),
        h('button', {
          class: 'btn btn-accent', type: 'button',
          onclick: () => { state.flow.confirmApply = false; applySpec(draftableFps); },
        }, '▶ Write now'),
        h('button', {
          class: 'btn', type: 'button',
          onclick: () => { state.flow.confirmApply = false; renderFlowInto(); },
        }, 'Cancel'))
    : h('button', {
        class: `btn btn-accent${busy ? ' is-busy' : ''}`, type: 'button',
        disabled: busy || unsavedInScope.length > 0 || (!applyMode && !proposeMode),
        'aria-busy': busy ? 'true' : 'false',
        title: unsavedInScope.length > 0
          ? `${plural(unsavedInScope.length, 'decision', 'decisions')} below didn't save — retry ${unsavedInScope.length === 1 ? 'it' : 'them'} first.`
          : applyMode
            ? 'Queue the write-back: the runner applies your accepted/edited proposals to ADO work-item fields / Confluence sections — surgically, on your confirmation (nothing is written until you click, and confirmed again next).'
            : proposeMode
              ? 'Draft the before→after edits for your accepted findings (runs /flowlever:propose). You then review them here and Apply.'
              : 'Nothing accepted to apply yet.',
        onclick: () => {
          if (applyMode) { state.flow.confirmApply = true; renderFlowInto(); }
          else if (proposeMode) enqueuePropose();
        },
      }, busy ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : null, applyLabel);
  const actions = h('div', { class: 'finish-actions' },
    isPr ? null : applyPrimary,
    isPr ? null : h('button', {
      class: 'btn', type: 'button', disabled: applyN === 0 || busy || unsavedInScope.length > 0,
      title: unsavedInScope.length > 0
        ? `${plural(unsavedInScope.length, 'decision', 'decisions')} below didn't save — retry ${unsavedInScope.length === 1 ? 'it' : 'them'} first.`
        : 'Mark these findings as rework-in-flight locally (no write-back).',
      onclick: () => applyReviewed(reworkFps, waiveItems),
    }, applyN ? `Mark ${plural(applyN, 'finding', 'findings')} in-flight` : 'Nothing to mark'),
    h('button', { class: 'btn', type: 'button', onclick: () => { state.flow.finish = false; renderFlowInto(); } }, '← Back to steps'),
    h('button', { class: 'btn', type: 'button',
      onclick: () => { location.hash = `#/feature/${encodeURIComponent(current.id)}`; } }, 'Exit to board'));

  return h('div', { class: 'finish' },
    h('a', { class: 'backlink', href: `#/feature/${encodeURIComponent(current.id)}` }, '← Overview'),
    head,
    ...groups,
    unsavedWarning,
    postActionEl(data),
    h('div', { class: 'finish-head' },
      h('div', { class: 'step-section-label' }, 'Export work order — hand to a coding agent'),
      exportEl),
    actions,
    (!isPr && undraftedN > 0 && draftableN === 0)
      ? h('div', { class: 'apply-status apply-needs-input' },
          h('span', { class: 'apply-dot' }, '✎'),
          h('span', {}, `${plural(undraftedN, 'accepted finding', 'accepted findings')} have no writable draft yet. `,
            'Run ', h('code', {}, `/flowlever:propose ${current.id}`),
            ' to draft the before→after edits, review them, then Apply. (Structural or decision-only findings may stay as action items.)'))
      : null,
    isPr ? null : applyStatusEl(state.flow.applyReqs || []),
    nextStepNote(data));
}

/* Live status of the spec write-back (apply) request, shown under the finish
 * actions so "Apply" feels responsive: queued → applying (+phase) → applied /
 * failed, plus the amber "needs your input" cue when the runner hits a 2FA/auth
 * prompt. Reads the latest apply request for this workspace. */
function applyStatusEl(applyReqs) {
  if (!applyReqs.length) return null;
  const r = [...applyReqs].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  if (!r) return null;
  if (r.needsInput) {
    return h('div', { class: 'apply-status apply-needs-input' },
      h('span', { class: 'apply-dot' }, '⚠'),
      h('span', {}, r.note || 'Waiting on you — approve the auth prompt in your other window to continue.'));
  }
  const isPropose = r.action === 'propose';
  if (r.status === 'queued') {
    return h('div', { class: 'apply-status apply-running' },
      h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', {}, 'Queued — waiting for the runner to pick it up…'));
  }
  if (r.status === 'running') {
    return h('div', { class: 'apply-status apply-running' },
      h('span', { class: 'spinner', 'aria-hidden': 'true' }),
      h('span', {}, isPropose ? `Drafting proposals${r.phase ? ` — ${r.phase}` : '…'}` : `Applying${r.phase ? ` — ${r.phase}` : ' to spec…'}`));
  }
  if (r.status === 'done') {
    return h('div', { class: 'apply-status apply-done' },
      h('span', { class: 'apply-dot' }, '✓'),
      h('span', {}, isPropose
        ? `${r.phase || 'Proposals drafted'} — review the red/green diffs, then Apply.`
        : `${r.phase || 'Applied to spec'} — re-audit to confirm the edits landed.`));
  }
  if (r.status === 'error') {
    return h('div', { class: 'apply-status apply-error' },
      h('span', { class: 'apply-dot' }, '⚠'),
      h('span', {}, `Apply failed: ${r.note || 'see the Claude session for details'}`));
  }
  return null;
}

/* PR finish screens swap the "re-audit" hint for a posting action: enqueue an
 * `apply` request (the runner posts the kept comments / replies back to the PR)
 * and reflect its queued → running → posted progress. Spec workspaces keep the
 * re-audit note. */
function nextStepNote(data) {
  const kind = data.feature && data.feature.kind;
  // "Next: post back to the PR" is a promise this mode cannot keep, and a false next step is worse
  // than none — it is the sentence a reviewer would act on after reading everything else here.
  if (readOnlyMode()) {
    return h('div', { class: 'finish-next' },
      '🔒 Read-only mode: this is the end of the line. Nothing above will be written or posted.');
  }
  if (kind === 'pr-review' || kind === 'pr-respond') {
    // Same reason as the read-only branch above: with nothing postable there IS no next step, and
    // pointing at a post that cannot happen is the false promise this screen must not make.
    if (nothingLeftToPost(data)) {
      return h('div', { class: 'finish-next' }, '✓ Done: nothing goes back to the PR — Azure DevOps stays as it is.');
    }
    return h('div', { class: 'finish-next' }, '↻ Next: post back to the PR above, then the threads update in Azure DevOps.');
  }
  return h('div', { class: 'finish-next' }, '↻ Next: ', h('strong', {}, 'Apply'),
    ' writes accepted changes back to ADO / Confluence (countered items re-audit automatically), then ',
    h('code', {}, '/flowlever:audit'), ' reconciles the ledger.');
}

// Only approved/edited (and, for respond, pushed-back or fix-only) items post; dismissed +
// undecided do not — the Post button counts exactly what will be sent.
const POSTABLE_DECISIONS = {
  'pr-review': ['accept', 'edit'],
  'pr-respond': ['accept', 'edit', 'fix-only', 'redirect'],
};

/* The post job the finish screen reflects: the most recent apply request plus the state the Post
 * control and its status line both read. Split out so the "is a post still ahead?" question can be
 * asked from more than one place without two answers. */
function postJobState(data) {
  const reqs = (state.flow.applyReqs || []).slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  const latest = reqs[reqs.length - 1];
  const stalled = !!latest && isStaleJob(latest);
  // A stalled job is NOT active: keep the button live so the user can retry instead of staring
  // at a disabled "Queued…" that will never advance.
  const active = !!latest && (latest.status === 'queued' || latest.status === 'running') && !stalled;
  const errored = !!latest && latest.status === 'error';
  // "Posted" is only true when the runner actually STAMPED the findings (postedAt). A request that
  // merely reached `done` while items sit in the in-flight lane means the write wasn't confirmed —
  // claiming success there is what makes the cockpit disagree with the real PR.
  const pendingLeft = ((data.ledger && data.ledger.findings) || []).filter(isPending).length;
  const posted = !!latest && latest.status === 'done' && pendingLeft === 0;
  const unconfirmed = !!latest && latest.status === 'done' && pendingLeft > 0;
  return { latest, stalled, active, errored, pendingLeft, posted, unconfirmed };
}

/* The genuine dead end: every finding is decided, none of those decisions produces a comment or
 * reply, and no earlier attempt is waiting to be retried or repeated. A Post button here can never
 * do anything — it read "Post 0 comments to PR #5869" under the label "nothing is sent until you
 * click this", which asks the reviewer to act on a control with nothing behind it. Both the
 * control and the "next: post back to the PR" note have to stop promising the action. */
function nothingLeftToPost(data) {
  const kind = data.feature && data.feature.kind;
  const postable = POSTABLE_DECISIONS[kind];
  if (!postable) return false;
  const postN = (state.flow.items || []).map(flowDecisionKind).filter((k) => postable.includes(k)).length;
  if (postN > 0 || undecidedFlowFps().length > 0) return false;
  const j = postJobState(data);
  // A finished, failed or stalled attempt keeps its own control ("Post again" / "Retry post") —
  // the dead end is only when there was never anything to send.
  return !(j.latest && (j.active || j.posted || j.errored || j.stalled || j.unconfirmed));
}

/* Standing in for the Post control when nothing can be posted: state WHY there is nothing, and the
 * way back to change it, rather than a disabled button counting to zero. An empty step set never
 * reaches here — renderFlowInto swaps the whole screen for flowEmptyView before finishView runs —
 * so there is always at least one decided finding to name. */
function postEmptyEl(kind) {
  const noun = kind === 'pr-review' ? ['comment', 'comments'] : ['reply', 'replies'];
  const reviewedN = (state.flow.items || []).length;
  const why = reviewedN === 1
    ? `The one finding is decided, and it produces no ${noun[0]}.`
    : `All ${reviewedN} findings are decided, and none of them produce a ${noun[0]}.`;
  return h('div', { class: 'finish-post finish-post-empty' },
    h('div', { class: 'step-section-label' }, 'Nothing to post'),
    h('p', { class: 'post-empty-msg' }, why),
    h('p', { class: 'meta-dim post-empty-hint' },
      'Nothing will be written to the PR. Use ', h('strong', {}, '← Back to steps'), ' if a decision should change.'));
}

function postActionEl(data) {
  const kind = data.feature && data.feature.kind;
  if (kind !== 'pr-review' && kind !== 'pr-respond') return null;
  if (nothingLeftToPost(data)) return postEmptyEl(kind);
  const noun = kind === 'pr-review' ? ['comment', 'comments'] : ['reply', 'replies'];
  const postable = POSTABLE_DECISIONS[kind];
  const decided = state.flow.items.map(flowDecisionKind);
  const postN = decided.filter((k) => postable.includes(k)).length;
  // A fix-only item writes code and resolves its thread but posts NO reply, so it must not be
  // counted as one — "Post 3 replies" when only 2 are replies is exactly the kind of quiet
  // inaccuracy that makes the cockpit disagree with the PR.
  const fixOnlyN = decided.filter((k) => k === 'fix-only').length;
  const replyN = postN - fixOnlyN;
  const prNum = prNumber(data.feature);
  const target = prNum ? `PR #${prNum}` : 'the PR';
  const verb = kind === 'pr-review' ? 'Post comments' : (replyN === 0 && fixOnlyN > 0 ? 'Push fixes' : 'Post replies');

  const { latest, stalled, active, errored, pendingLeft, posted, unconfirmed } = postJobState(data);
  const meta = latest ? (REQ_STATUS[latest.status] || REQ_STATUS.queued) : null;

  const statusLine = latest
    ? h('span', { class: `post-status req-state-${cssSafe(stalled ? 'stalled' : latest.status)}` },
        h('span', { class: `req-glyph req-glyph-${cssSafe(stalled ? 'stalled' : latest.status)} ${meta.spin && !stalled ? 'req-spin' : ''}`.trim() },
          stalled ? '⏸' : meta.glyph),
        ' ',
        stalled ? `Not running — ${latest.status} ${fmtAge(jobAgeMs(latest))} ago, nothing posted`
          : posted ? `Posted to ${target}`
          : unconfirmed ? `Finished, but ${plural(pendingLeft, 'item', 'items')} not confirmed as posted`
          : meta.label,
        errored && latest.note ? h('span', { class: 'meta-dim' }, ` — ${latest.note}`) : null,
        stalled ? h('span', { class: 'meta-dim' }, ' — start /flowlever:watch, then retry') : null)
    : null;

  // Retrying after a job that never confirmed must first RELEASE the stranded in-flight markers —
  // otherwise the items are excluded from the post set and the retry silently posts nothing.
  const needsRelease = pendingLeft > 0 && (stalled || unconfirmed || errored);
  // Spell out the mix so the button never over-promises: "Post 2 replies + 1 fix to PR #5751".
  const parts = [];
  if (replyN) parts.push(`${replyN} ${replyN === 1 ? noun[0] : noun[1]}`);
  if (fixOnlyN) parts.push(`${fixOnlyN} ${fixOnlyN === 1 ? 'fix' : 'fixes'} (no reply)`);
  const postLabel = parts.length
    ? `${verb.split(' ')[0]} ${parts.join(' + ')} to ${target}`
    : `${verb.split(' ')[0]} ${postN} ${postN === 1 ? noun[0] : noun[1]} to ${target}`;
  const btn = h('button', {
    class: 'btn btn-accent btn-post', type: 'button',
    // Read-only is the strongest of the reasons this button can be dead — it is the one that
    // reaches a colleague's pull request — so it gates alongside the existing conditions.
    disabled: readOnlyMode() || active
      || (postN === 0 && !posted && !errored && !stalled && !unconfirmed),
    title: readOnlyMode() ? READ_ONLY_TITLE : undefined,
    onclick: () => (needsRelease ? retryPost(data, kind, verb) : postBack(data, kind, verb)),
  }, active ? 'Queued…'
    : stalled || unconfirmed || errored ? 'Retry post'
    : posted ? `${verb} again`
    : postLabel);

  // AI-disclosure toggle: on by default; the choice rides the apply request's
  // `instructions`, so the runner needs no other channel to know it.
  if (state.flow.disclosure === undefined) state.flow.disclosure = true;
  // The footer only lands on text that gets written, so it's meaningless when every decision is
  // fix-only — don't offer a toggle that changes nothing.
  const disclosureToggle = replyN === 0 && fixOnlyN > 0 ? null
    : h('label', { class: 'post-disclosure meta-dim', title: `When on, each posted ${noun[0]} ends with "${DISCLOSURE_LINE}".` },
      h('input', {
        type: 'checkbox', checked: state.flow.disclosure ? 'checked' : undefined, disabled: active ? 'disabled' : undefined,
        onchange: (e) => { state.flow.disclosure = e.target.checked; },
      }),
      ` ${DISCLOSURE_LINE}`);

  // If a job is waiting and nothing is draining the queue, put the run control right next to the
  // status line — this is the screen the user is staring at while wondering why nothing happens.
  const needsRunner = !!latest && (latest.status === 'queued' || latest.status === 'running') && !runnerBusy();
  // The dead end this replaces: a fresh pr-review workspace showed "Post 0 comments to PR #5843"
  // — true, but it hands the reviewer nowhere to go. The disabled button (web/app.js:1931-ish,
  // unchanged here) is correct; only the label above it was silent about what to do next. Only
  // swap it in the actual dead end — postN===0 because nothing is decided yet, not because a post
  // already ran or everything was dismissed (posted/errored/stalled/unconfirmed all have their own
  // honest status line already, via statusLine above). pr-review gets the pointer to Approve-all
  // (approveAllControl, above the groups) since that's the escape hatch; pr-respond has no such
  // control, so it only names the count.
  const undecidedN = undecidedFlowFps().length;
  const deadEnd = postN === 0 && undecidedN > 0 && !posted && !errored && !stalled && !unconfirmed;
  const sectionLabel = deadEnd
    ? `${plural(undecidedN, 'finding', 'findings')} still undecided — decide them${kind === 'pr-review' ? ', or approve all above' : ''}`
    : `${verb} — nothing is sent until you click this`;
  return h('div', { class: 'finish-post' },
    h('div', { class: 'step-section-label' }, sectionLabel),
    h('div', { class: 'finish-post-row' },
      btn,
      statusLine,
      needsRunner ? runnerZone(1, '▶ Run it now') : null,
      h('span', { class: 'meta-dim post-flow' }, 'queued → running → posted')),
    disclosureToggle);
}

/* Post gate for PR workspaces: first persist the triage to finding statuses
 * (approved/edited → resolved "will post", dismissed → waived), then enqueue the
 * `apply` request the runner posts back to the PR. */
async function postBack(data, kind, verb) {
  await persistTriage(data);
  await enqueueApply(verb, kind);
}

/* Retry a Post whose previous attempt never confirmed (job stalled, errored, or finished without
 * stamping). Releases the stranded in-flight markers first, then rebuilds the post set from the
 * findings' persisted decisions — so the retry actually carries the items, instead of enqueueing
 * an apply over an empty set because the pending ones were filtered out. */
async function retryPost(data, kind, verb) {
  const fid = current.id;
  try {
    await api(`/api/features/${encodeURIComponent(fid)}/review/cancel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'retrying the post — previous attempt never confirmed' }),
    });
    await loadDetail(fid, true);
  } catch (e) {
    toast(`Could not reset the previous attempt: ${e.message}`);
    return;
  }
  // Rebuild the snapshot from the released findings (their approve/edit decisions survived).
  state.flow.items = null;
  initFlow(state.detail);
  state.flow.finish = true;
  await postBack(state.detail, kind, verb);
  renderFlowInto();
}

async function persistTriage(data) {
  const postFps = [];
  const waiveItems = [];
  for (const fp of state.flow.items) {
    const k = flowDecisionKind(fp);
    if (k === 'skip') continue;                       // undecided → leave open
    // A rejected finding must never ride the post set. `reject` only became a decision kind when
    // hydrateDecisions started recognising the verdict (so the bulk approve-all could not silently
    // overturn it) — and that promotion made it fall through to the `else` below, which marks
    // items pending-post and hands them to the runner. The reviewer said "don't apply this at
    // all"; posting a comment off the back of that is the loudest possible way to get it wrong,
    // and the Post button never counted it, so the button and the write disagreed. Leave it open,
    // exactly as it behaved before `reject` was a kind.
    if (k === 'reject') continue;
    if (k === 'waive') waiveItems.push({ fp, reason: (state.flow.decisions[fp] && state.flow.decisions[fp].reason) || 'dismissed' });
    else postFps.push(fp);                             // accept / edit / redirect → posting back
  }
  try {
    if (postFps.length) {
      // Mark them "Posting…" (in-flight), NOT posted: the real postedAt stamp is set by the
      // runner once the comment is actually on the PR. This keeps the lane honest — the card
      // reads "Posting…" until the runner finishes, then moves to "Posted — awaiting author".
      await api(`/api/features/${encodeURIComponent(current.id)}/review/apply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fps: postFps, status: 'pending-post' }),
      });
    }
    for (const { fp, reason } of waiveItems) {
      await api(`/api/features/${encodeURIComponent(current.id)}/findings/${encodeURIComponent(fp)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'waived', reason: reason.trim() || 'dismissed' }),
      });
    }
    await loadDetail(current.id, true);
  } catch (e) {
    toast(`Could not save triage: ${e.message}`);
  }
}

/* Re-review: enqueue a fresh `pr-review` run for the SAME PR. The runner re-fetches the PR
 * (the author's replies + any new commits) and re-ingests — reconciliation auto-resolves the
 * findings the author addressed, keeps the ones still flagged, and inserts anything new. Same
 * loop as a spec re-audit; stable `pr:<n>:<path>:<line>` loci keep fingerprints aligned. */
async function reReviewPr(data) {
  const feature = (data && data.feature) || (state.detail && state.detail.feature);
  const prNum = prNumber(feature);
  if (!prNum) { toast('Could not determine the PR number for this workspace'); return; }
  try {
    await api('/api/requests', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // wsId pins the re-review to THIS workspace so it reconciles into the same ledger
      // rather than spinning up a duplicate pr-<id>-<slug>.
      body: JSON.stringify({ action: 'pr-review', prId: String(prNum), wsId: current.id, title: feature.title || null }),
    });
    toast(`Re-review of PR #${prNum} queued — the runner will reconcile the author’s response`, 'success');
    // We're acting on the response now — clear the "author responded" flag (best-effort) so the
    // workspace returns to waiting until the re-review lands.
    try {
      await api(`/api/features/${encodeURIComponent(current.id)}/activity`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authorResponded: false }),
      });
      await loadDetail(current.id, true);
      rerenderDetail();
    } catch { /* non-fatal */ }
    ensureApplyPolling();
    pollRequestsNow();
  } catch (e) {
    toast(`Could not queue re-review: ${e.message}`);
  }
}

/* Re-audit: enqueue a fresh full audit of the SAME spec workspace. The runner re-fetches the
 * spec sources and re-ingests — reconciliation auto-resolves the findings the spec now reflects
 * (the applied ones), keeps any still-open, and flags regressions. `wsId` pins it to THIS
 * workspace (the watch runner treats `audit` + wsId as "re-audit existing", not a new analysis). */
async function reAuditSpec(data) {
  const feature = (data && data.feature) || (state.detail && state.detail.feature);
  try {
    await api('/api/requests', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'audit', wsId: current.id, title: (feature && feature.title) || null }),
    });
    toast('Re-audit queued — the runner will re-fetch the spec and reconcile', 'success');
    ensureApplyPolling();
    pollRequestsNow();
  } catch (e) {
    toast(`Could not queue re-audit: ${e.message}`);
  }
}

/* Draft proposals: enqueue a `propose` job the runner fulfils with /flowlever:propose, which
 * attaches before→after drafts to the accepted findings (read-only — writes nothing external).
 * Once drafted, this same button flips to "Apply". */
async function enqueuePropose() {
  state.flow.applying = true;     // reuse the busy spinner while the propose job runs
  renderFlowInto();
  try {
    await api('/api/requests', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'propose', wsId: current.id }),
    });
    toast('Drafting proposals — the runner will attach before→after edits for review', 'success');
    ensureApplyPolling();
    pollRequestsNow();
  } catch (e) {
    state.flow.applying = false;
    renderFlowInto();
    toast(`Could not queue propose: ${e.message}`);
  }
}

/* Spec Apply gate: first move the accepted/edited findings into the "Applying…" lane
 * (pending=apply — in-flight, NOT yet written), then enqueue the apply request the runner
 * fulfils. The runner stamps appliedAt on the real write → "Applied — awaiting re-audit". */
async function applySpec(applyableFps) {
  if (applyableFps && applyableFps.length) {
    try {
      await api(`/api/features/${encodeURIComponent(current.id)}/review/apply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fps: applyableFps, status: 'pending-apply' }),
      });
      await loadDetail(current.id, true);
    } catch (e) {
      toast(`Could not mark applying: ${e.message}`);
    }
  }
  await enqueueApply('Apply spec changes');
}

async function enqueueApply(label, kind) {
  // Optimistic: flip the button into its busy state immediately (before the POST
  // round-trips) so the click feels responsive; the apply-request polling then
  // drives the real queued → running → done state.
  state.flow.applying = true;
  renderFlowInto();
  try {
    const isPr = kind === 'pr-review' || kind === 'pr-respond';
    // For PR posts, spell the disclosure choice out on the request so the runner
    // never has to guess (checkbox in postActionEl; default on).
    const disclosure = state.flow.disclosure !== false
      ? `disclosure: append "${DISCLOSURE_LINE}" as the last line of every posted ${kind === 'pr-review' ? 'comment' : 'reply'}`
      : 'disclosure: off — post the reviewed text verbatim, no AI footer';
    // Call out fix-only items explicitly. The runner can read `decision: "fix-only"` off the
    // ledger, but a reply posted where the user asked for silence is not a recoverable mistake —
    // so it gets said twice.
    const fixOnly = state.flow.items.filter((fp) => flowDecisionKind(fp) === 'fix-only');
    const fixNote = fixOnly.length
      ? ` · fix-only (do NOT reply — push the fix, then set the thread status to Fixed): ${fixOnly.join(', ')}`
      : '';
    const instructions = !isPr ? undefined : `${disclosure}${fixNote}`;
    await api('/api/requests', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'apply', wsId: current.id, instructions }),
    });
    // Clicking Post/Apply IS the go-ahead to write. Queueing a job nobody is running turns that
    // into a silent no-op until the user happens to notice — so start the runner right here. Its
    // progress then shows on this very screen (queued → running → posted). No runner available
    // (no `claude` CLI) → say plainly that it's queued and needs a session.
    const r = await refreshRunner();
    if (r && r.available && !r.running) {
      await startRunner('watch', { silent: true });
      toast(`${label} — running now`, 'success');
    } else if (r && r.running) {
      toast(`${label} queued — the running session will pick it up`, 'success');
    } else {
      toast(`${label} queued — run /flowlever:watch in Claude Code to execute it`, 'success');
    }
    ensureApplyPolling();
    pollRequestsNow();
  } catch (e) {
    state.flow.applying = false;
    renderFlowInto();
    toast(`Could not queue: ${e.message}`);
  }
}

/* Apply the finish screen: accepted/edited/redirected → reworking (bulk endpoint);
 * waived → waived with their reasons (per-finding). Then back to the board. */
async function applyReviewed(reworkFps, waiveItems) {
  let n = 0;
  try {
    if (reworkFps.length) {
      await api(`/api/features/${encodeURIComponent(current.id)}/review/apply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fps: reworkFps, status: 'reworking' }),
      });
      n += reworkFps.length;
    }
    for (const { fp, reason } of waiveItems) {
      await api(`/api/features/${encodeURIComponent(current.id)}/findings/${encodeURIComponent(fp)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'waived', reason: reason.trim() || 'waived during review' }),
      });
      n += 1;
    }
    await loadDetail(current.id, true);
    toast(`Applied — ${plural(n, 'finding', 'findings')} updated`, 'success');
    location.hash = `#/feature/${encodeURIComponent(current.id)}`;
  } catch (e) {
    toast(`Apply failed: ${e.message}`);
  }
}

/* ============================== router ============================== */

function route() {
  if (state.modalFp) closeModal();   // never leave a modal open across navigation
  stopPolling();                     // each view (re)starts its own requests poll after it loads
  state.flow.active = false;         // the stepper owns this flag only while on the review route
  // The finish screen's bulk-approve confirm must never survive a navigation away from it: leaving
  // the finish screen (a tab click, the back button) and coming straight back to the SAME feature
  // re-renders finishView without re-running initFlow's fresh-state reset (that only fires on a
  // feature switch), so a left-behind `true` here would re-arm the confirm and leave a bulk write
  // one click away instead of the two clicks it promises. Same idea as clearing `active` above.
  state.flow.confirmApproveAll = false;
  // Its higher-stakes sibling needs the exact same reset and for the exact same reason: Apply
  // writes to real ADO work-item fields / Confluence sections, not just to the local ledger, so a
  // `confirmApply` left `true` across a navigate-away-and-back is one click — not two — from that
  // write. Verified live: Apply → "Write N changes … now?" → switch tabs → back → still armed.
  state.flow.confirmApply = false;
  const hash = location.hash || '#/';
  const m = hash.match(/^#\/feature\/([^/]+)(?:\/(findings|coverage|timeline|report|review))?(?:\/(finish))?\/?$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const sub = m[2] || 'findings';
    if (sub === 'review') renderReviewFlow(id, m[3] === 'finish');
    else renderDetail(id, sub);
  } else if (hash.startsWith('#/guide')) {
    renderGuide();
  } else if (hash.startsWith('#/spec')) {
    renderSection('spec');
  } else if (hash.startsWith('#/pr-review')) {
    renderSection('pr-review');
  } else if (hash.startsWith('#/pr-respond')) {
    renderSection('pr-respond');
  } else {
    renderHome();
  }
  syncNav();
}

function syncNav() {
  const hash = location.hash || '#/';
  let active = '#/';
  if (hash.startsWith('#/guide')) active = '#/guide';
  else if (hash.startsWith('#/pr-review')) active = '#/pr-review';
  else if (hash.startsWith('#/pr-respond')) active = '#/pr-respond';
  else if (hash.startsWith('#/spec')) active = '#/spec';
  else if (hash.startsWith('#/feature')) active = null;   // detail page — no top-level section lit
  document.querySelectorAll('.topnav a').forEach((a) => {
    a.classList.toggle('active', a.getAttribute('href') === active);
  });
}

/* ============================== home (unified inbox) ============================== */

/* The supporting detail a needs-you row prints UNDER its state pill — how much is waiting, in
 * counts. Deliberately not the headline any more: `state` is, and it is the only one of the two
 * that can be trusted here. These bits read `counts`, and counts.toReview only counts findings
 * carrying a `draft` — a PR-review finding usually carries just a `suggestion` — so toReview reads
 * 0 on most PR workspaces and the row said "3 open" where it meant "3 to review". The counts
 * themselves are left exactly as they are (the server's inbox sort reads them); what changed is
 * that no row's headline, and no header count, depends on them. */
function needsYouBits(c) {
  const bits = [];
  if (c.toReview) bits.push(`${c.toReview} to review`);
  if (c.reworking) bits.push(`${c.reworking} reworking`);
  if (!c.toReview && !c.reworking && c.open) bits.push(`${c.open} open`);
  // Posted comments are awaiting the author — surface them so the inbox shows a PR is
  // out for response (and can be re-reviewed), not silently "settled".
  if (c.posted) bits.push(`${c.posted} posted`);
  return bits;
}

/* The dates a completed row can be sorted by, shown so the chosen order is legible. Both are
 * rendered rather than only the active sort key, because these rows are built once and merely
 * reordered when the sort changes — a label that depended on the current key would go stale the
 * moment you switched. "Updated" is dropped when it lands on the same day as the review, which is
 * the common case (marking a workspace done is usually the last thing that touches it) and would
 * otherwise print the same date twice on every row. */
function doneDatesRow(r) {
  const reviewed = (r.stamps && r.stamps.lastReviewedAt) || r.lastRoundAt || null;
  const updated = r.updatedAt || null;
  const sameDay = reviewed && updated && fmtDate(reviewed) === fmtDate(updated);
  const parts = [
    stampEl('Last reviewed', reviewed, 'ir-done-stamp'),
    sameDay ? null : stampEl('Last modified', updated, 'ir-done-stamp'),
  ].filter(Boolean);
  if (!parts.length) return null;
  return h('div', { class: 'review-stamps ir-stamps ir-done-stamps' }, parts);
}

/* The two ways out of an inline delete-confirm that are not its own two buttons.
 *
 * The hold an open confirm puts on a polled list has NO ceiling on purpose (holdStands): a repaint
 * would answer a destructive question "no" on the user's behalf, silently, with nothing to put back.
 * That trade is only defensible while every confirm is eventually ANSWERED — and a confirm whose
 * only exits are two buttons is not: measured, an abandoned one held the rows past 14 seconds and a
 * newly started job, with no bound on how much longer. Escape and a click outside are the answers a
 * user expects to be able to give without aiming at Cancel, and wiring them is what makes "it lasts
 * until the user answers" true rather than hopeful.
 *
 * Both run `cancel` — the SAME function the Cancel button runs, never the delete. A dismissal is the
 * user stepping away from something irreversible; reading it as consent would be the one failure
 * worse than the freeze it fixes.
 *
 * `pointerdown` rather than `click`, because a drag that starts on Cancel and ends outside the
 * confirm would otherwise dismiss on the up-stroke — from a press the user aimed INSIDE. Capture, so
 * a handler that stops propagation on the way up cannot swallow it. Escape is not stopped, so a
 * second open confirm elsewhere on the page dismisses on the same keystroke.
 *
 * The listeners unhook themselves once the confirm is out of the DOM: Cancel and Delete both replace
 * the wrap's children, and a repaint past the ceiling can take the element with neither pressed, so
 * "the confirm went away" cannot be left to the buttons to report. */
function wireConfirmDismiss(confirmEl, cancel) {
  const off = () => {
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onDown, true);
  };
  const gone = () => {
    if (confirmEl.isConnected) return false;
    off();
    return true;
  };
  function onKey(e) {
    if (gone() || e.key !== 'Escape') return;
    e.preventDefault();
    off();
    dismiss();
  }
  function onDown(e) {
    if (gone() || confirmEl.contains(e.target)) return;
    off();
    dismiss();
  }
  function dismiss() {
    cancel();
    // A Cancel click reaches the zone's own onclick and releases whatever the hold deferred; a click
    // outside the zone, and every Escape, reaches nothing. Without this the list would sit on a
    // stale repaint until the next tick for no reason. No-op off Home, which is where it belongs.
    flushHomeInboxSoon();
  }
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onDown, true);
}

/* WHICH surface a row is drawn on. Two tables, passed in by the list that draws the row — never
 * sniffed from `current.view`, because the route is not the question. What a row needs to know is
 * "am I one of many kinds here, or one of one?", and a renderer that reads the route to answer that
 * is free to answer it differently from the list that placed it, which is the whole class of bug the
 * single band/state tables exist to prevent.
 *
 *  · `kindBadge` — Home is cross-kind, and the badge is how you tell a spec row from a PR row at a
 *    glance. Inside a section every row is the same kind, so the badge is the page's own title
 *    repeated once per row and nothing else.
 *  · `sectionMeta` — the material the section cards carried and the inbox never did: the open
 *    severity counts, and for a spec what it is assembled from plus when we last ran a round (and
 *    the "waiting on author / author responded" line). It is the section's reason to exist, and it
 *    is decision material, so it rides the full band only — see rowParts.
 *  · `cache` — which of the two repaint caches this list draws from, so a delete prunes the one that
 *    would otherwise paint the workspace straight back onto the screen (pruneRowCache). */
const ROW_HOME = { kindBadge: true, sectionMeta: false, cache: 'home' };
const ROW_SECTION = { kindBadge: false, sectionMeta: true, cache: 'section' };

/* WHAT a row draws, from the only things that decide it: the band's density (WS_BANDS), the surface
 * table above, and whether the workspace is finished. Pure, and deliberately separate from the
 * rendering, so a test can RUN this mapping instead of reading the renderer's text — this is exactly
 * the shape that has drifted in this file before (the band→density rule was once written twice, in
 * JS and again in CSS), and the only guard that cannot rot alongside it is one you can execute.
 *
 * The rule underneath every `deciding` field is one sentence: decision material goes where a
 * decision is actually waiting. A parked row is waiting on somebody else and a done row is answered
 * already — that is why the needs-you bits have dropped out of both since the bands shipped, and the
 * counts and the sources line are the same kind of thing, so they follow the same rule. */
function rowParts(opts, density, done) {
  const compact = density === 'compact';
  const deciding = !compact && !done;
  return {
    kindBadge: !!opts.kindBadge,
    // The dial is a score you weigh before opening something. Nothing in the compact bands is
    // waiting on that decision — but a done row keeps it, because its score is its outcome.
    dial: !compact,
    bits: deciding,
    // The ONE stamp a compact row earns, in place of everything else it dropped.
    stamp: compact,
    // ONE flag for the four things the full section card carried and the inbox row never did — the
    // severity counts, the sources/last-round line, the lifecycle chip, and the waiting-on-author
    // line. One name because they are one decision: they are what a section exists to show, and
    // they are all decision material, so they all obey the same "only where a decision is waiting"
    // rule. Splitting it into four identical booleans would only invite three of them to drift.
    sectionFull: deciding && !!opts.sectionMeta,
  };
}

/* ONE row renderer, for every list of workspaces the cockpit draws: the Home inbox and all three
 * kind sections. There were two — a row and a card for the same object — and that is the drift this
 * file has been bitten by repeatedly: the binding rule shipped wrong twice because it was written
 * twice, and the band/density mapping was written twice as well. A workspace looks like one thing
 * because there is one function that says what a workspace looks like.
 *
 * The `ir-` class prefix stays (it began as "inbox row") and is deliberately NOT renamed: it names
 * the SHAPE, which both surfaces now share, and renaming it would rewrite the stylesheet and Home's
 * rendered DOM for no behavioural gain.
 *
 * `density` is the band's (WS_BANDS): a needs-you row earns the dial and the counts, a parked one
 * earns only what identifies it and the one stamp that says why it is parked. `cat` is the WS_STATES
 * key the band loop already decided, handed down rather than recomputed — categoryOf() reads the
 * clock, so a second call can label a row as something other than the header it sits under. A row
 * drawn outside the bands (the Done disclosure) passes neither. */
function workspaceRow(r, job = null, density = 'full', cat = null, opts = ROW_HOME) {
  const done = r.status === 'done';
  const compact = density === 'compact';
  const part = rowParts(opts, density, done);
  // A completed workspace never nags; a parked one has nothing to act on either, and its pill and
  // stamp already say why it is here — counts underneath would only invite a read it doesn't need.
  const bits = part.bits ? needsYouBits(r.counts) : [];
  // Through summaryReadiness, not `r.readiness` directly: /api/features can serve a workspace whose
  // ledger has not been read yet (readiness: null) and older shapes flatten score/gate onto the
  // summary. Identical on /api/home rows, which always carry the object.
  const rd = summaryReadiness(r);
  // The caller's already-resolved kind, resolved once here: a summary served without one must get
  // the same words everywhere on the row rather than "spec" in one place and nothing in the next.
  const kind = r.kind || 'spec';
  const wrap = h('div', { class: `ir-wrap ${done ? 'ir-done' : ''}`.trim() });

  // One set of job tints, on the one row — a row with a failed or stalled runner must read as failed
  // or stalled on every surface, or Home is where a stuck Post goes unnoticed.
  const busyState = job
    ? (job.needsInput && job.status !== 'error' ? 'needs' : (isStaleJob(job) ? 'stale' : job.status))
    : null;
  const cls = ['inbox-row', compact ? 'ir-compact' : '', job ? `fc-busy fc-busy-${cssSafe(busyState)}` : '']
    .filter(Boolean).join(' ');

  const link = h('a', {
    class: cls,
    href: `#/feature/${encodeURIComponent(r.id)}`,
    // A key for this control that outlives the element: the rows are rebuilt on every repaint, so a
    // forced one puts focus back by looking this string up again (zoneFocusMark/restoreZoneFocus).
    dataset: { fk: `row:${r.id}` },
  },
    // The dial is decision material — a score you weigh before opening something. Nothing in the
    // compact bands is waiting on that decision, so it goes with the rest of the full row.
    part.dial ? dialEl(rd.score, rd.gate, 44, 'dial-sm ir-dial') : null,
    h('div', { class: 'ir-main' },
      // The kind badge is Home's: there it tells a spec row from a PR row, and inside a section
      // every row already has the page's own kind, so it would be one word repeated down the list.
      h('div', { class: 'ir-top' }, part.kindBadge ? kindBadge(kind) : null,
        h('span', { class: 'ir-title' }, r.title || r.id),
        // The lifecycle chip — where is this workspace in its life — next to the done chip that is
        // its one always-drawn value. Gated by statusChipIfMeaningful, which suppresses the `draft`
        // every active workspace carries: a word repeated down the whole list beside the state pill
        // that actually says what it is waiting on.
        done
          ? h('span', { class: 'chip status-done ir-done-chip' }, 'done')
          : (part.sectionFull ? statusChipIfMeaningful(r.status) : null)),
      h('div', { class: 'ir-needs' },
        // The state leads, and the counts follow it as the detail they are. Without the pill,
        // ready-to-post / needs-review / needs-rereview / author-responded drew identically on the
        // first screen you land on — the inbox was the last surface still hiding the distinction
        // the section cards gained.
        cat ? wsStatePill(cat, kind) : null,
        done
          ? h('span', { class: 'ir-clear' }, '✓ Review complete')
          : bits.length
            ? bits.map((b) => h('span', { class: 'ir-bit' }, b))
            // The pre-band fallback, and only reachable without a pill: a row that says neither
            // what it is waiting on nor what is outstanding says nothing at all.
            : (cat ? null : h('span', { class: 'ir-clear' }, rd.gate === 'ready' ? '✓ Ready to build' : '✓ Nothing needs you')),
        // The ONE stamp a compact row earns, chosen by the same rule a compact card used: a posted
        // review is waiting on the clock since WE posted, anything else since our last round.
        part.stamp ? compactStamp(r, job, cat) : null,
        // The open-severity breakdown the full section cards carried — on the SAME line as the
        // counts it refines, so the row stays a row. It is the section's decision material ("is
        // there a blocker in here before I open it"), which is why Home, whose owner chose it
        // without, does not grow one, and why no compact or done row gets it either.
        part.sectionFull ? sevCountsRow(rd.openBySeverity) : null),
      // PR rows carry the reviewed-vs-updated stamps, so the inbox shows at a glance which
      // PRs have moved since we last looked at them. A completed row has no use for that
      // comparison — but it does need its dates visible, because the Done list can now be sorted
      // by them, and a list ordered by something you cannot see is not a list you can trust.
      done
        ? doneDatesRow(r)
        : (compact ? null : reviewStampsRow(r, kind, { compact: true, cls: 'review-stamps ir-stamps' })),
      // What a spec is assembled from, and when we last ran a round — the other half of what the
      // section cards said. Kept off Home for the same reason the counts are.
      part.sectionFull ? rowMetaLine(r, kind) : null,
      // The live job in the same words the cards used. A row banded by a state a runner is in the
      // middle of invalidating, with no line saying so, is the list lying about what is happening.
      // With no job, a full section row says instead that the ball is in the author's court — the
      // line the full cards drew, and the one thing a posted-and-waiting workspace has to say.
      job
        ? cardJobRow(job, hasFindingsOf(r), kind)
        : (part.sectionFull && r.awaitingAuthor ? cardReviewRow(r) : null)),
    h('span', { class: 'ir-arrow', 'aria-hidden': 'true' }, '→'));

  const label = r.title || r.id;

  function showDefault() {
    const trashBtn = h('button', {
      class: 'btn-icon ir-delete', type: 'button',
      'aria-label': `Delete workspace ${label}`, title: 'Delete workspace',
      dataset: { fk: `row-del:${r.id}` },
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); showConfirm(); },
    }, h('span', { class: 'icon', html: ICONS.trash }));
    wrap.replaceChildren(link, trashBtn);
  }

  function showConfirm() {
    const confirmEl = h('div', { class: 'delete-confirm' },
      h('span', { class: 'delete-confirm-msg' },
        `Delete "${label}"? This removes its findings and history. This can't be undone.`),
      h('div', { class: 'delete-confirm-actions' },
        h('button', { class: 'btn btn-danger', type: 'button', onclick: doDelete }, 'Delete'),
        h('button', { class: 'btn', type: 'button', onclick: showDefault }, 'Cancel')));
    wrap.replaceChildren(confirmEl);
    // Escape / outside-click, both taking the Cancel path. Without a way out, the uncapped hold this
    // confirm puts on the list it is in never ends — and there is one confirm now, so neither list
    // can be the one that ships without an exit.
    wireConfirmDismiss(confirmEl, showDefault);
  }

  async function doDelete() {
    try {
      await api(`/api/features/${encodeURIComponent(r.id)}`, { method: 'DELETE' });
      // Pruned only where the delete actually succeeded, so the cache and the server agree from
      // here on — and from THIS surface's cache, which is what `opts` carries (pruneRowCache).
      pruneRowCache(opts, r.id);
      wrap.remove();
      toast(`Deleted "${label}"`, 'success');
    } catch (e) {
      toast(`Delete failed: ${e.message}`);
      showDefault();
    }
  }

  showDefault();
  return wrap;
}

/* Take a deleted workspace out of the cache the list it was in repaints FROM. Removing the element
 * is not enough: both lists are rebuilt from a cache on every tick that sees a change, and each
 * cache is only refilled by a full re-render (renderHome for one, a completed job's refetch for the
 * other). Leave the deleted id in it and the NEXT real change — a job starting anywhere on the page
 * — paints the workspace you just deleted straight back onto the screen, linking to a 404.
 *
 * WHICH cache is the surface's own answer, carried on ROW_HOME/ROW_SECTION, not a guess: one row
 * renderer now serves both lists, and pruning the wrong one is invisible until the next repaint
 * resurrects the workspace. The other cache is deliberately left alone — the two lists are never on
 * screen together, and blanking both would be a second bug hiding behind a fix for the first. */
function pruneRowCache(opts, id) {
  if (opts.cache === 'section') {
    if (state.section) state.section.features = (state.section.features || []).filter((x) => x.id !== id);
    return;
  }
  if (state.home) state.home.rows = (state.home.rows || []).filter((row) => row.id !== id);
}

/* The line the full section cards carried under everything else: what a spec workspace is assembled
 * FROM, and when we last ran a round against it. Kept as one line so the row reads as a row. */
function rowMetaLine(f, kind) {
  const metaBits = [];
  // PR workspaces don't carry Confluence/ADO/Figma sources — skip the sources line.
  if (kind === 'spec') {
    const src = sourcesLineText(f);
    if (src) metaBits.push(h('span', {}, src));
  }
  const lr = lastRoundDate(f);
  const isPrKind = kind === 'pr-review' || kind === 'pr-respond';
  // On PR rows the "Reviewed <ago>" stamp above already carries the last-round time — don't
  // print it twice; the "no rounds yet" case still needs saying.
  if (!(isPrKind && lr)) metaBits.push(h('span', { class: 'meta-dim' }, lr ? `last round ${lr}` : 'no rounds yet'));
  return metaBits.length ? h('div', { class: 'ir-meta' }, metaBits) : null;
}

/* Active-first lists: finished workspaces are tucked into a collapsed <details> so
 * what still needs you stays on top. Keyed open-state survives the polling re-renders
 * (which rebuild the list every tick) so an expanded "Done" section doesn't snap shut. */
const doneOpen = {};

/* How the Done list can be ordered. One table, read by both the <select> and the comparator, so
 * the menu can never offer an order nothing implements.
 *
 * `at` returns the timestamp to sort on, or null when the workspace has none — a workspace with no
 * review round yet must sink rather than lead, so a missing date sorts last either way.
 * Newest-first is the default because a 45-item Done list ordered by title answers "what is it
 * called" when the question is "what did I finish recently". The server's ordering (active first,
 * then by outstanding counts, then title) still decides the ACTIVE list: that list answers "what
 * needs me next", which is a different question, and it stays as it was. */
const DONE_SORTS = {
  reviewed: {
    label: 'Last reviewed',
    at: (d) => (d.stamps && d.stamps.lastReviewedAt) || d.lastRoundAt || null,
  },
  modified: {
    label: 'Last modified',
    at: (d) => d.updatedAt || null,
  },
  title: { label: 'Title (A–Z)', at: null },
};
const DONE_SORT_DEFAULT = 'reviewed';
const DONE_SORT_STORE = 'flowlever.doneSort';

/* The choice outlives the tab: re-picking an order on every reload is the friction this control
 * exists to remove. Storage access is wrapped because it throws outright in some private modes,
 * and a sort preference is never worth breaking the board over. */
function doneSortKey() {
  let stored = null;
  try { stored = localStorage.getItem(DONE_SORT_STORE); } catch { /* storage unavailable */ }
  return DONE_SORTS[stored] ? stored : DONE_SORT_DEFAULT;
}

function setDoneSortKey(key) {
  if (!DONE_SORTS[key]) return;
  try { localStorage.setItem(DONE_SORT_STORE, key); } catch { /* preference stays session-only */ }
}

/* Sorts [{ sortable, el }] pairs. Reordering prebuilt elements instead of re-rendering them is what
 * lets both call sites share this — they build the same row, at different surface options — without
 * either having to hand over its render function. */
function sortDonePairs(pairs, key) {
  const spec = DONE_SORTS[key] || DONE_SORTS[DONE_SORT_DEFAULT];
  const byTitle = (a, b) => String(a.sortable.title || a.sortable.id || '')
    .localeCompare(String(b.sortable.title || b.sortable.id || ''));
  if (!spec.at) return pairs.slice().sort(byTitle);
  return pairs.slice().sort((a, b) => {
    const av = spec.at(a.sortable);
    const bv = spec.at(b.sortable);
    if (!av && !bv) return byTitle(a, b);   // neither dated → a stable, readable fallback
    if (!av) return 1;                       // undated sinks, never leads
    if (!bv) return -1;
    return String(bv).localeCompare(String(av)) || byTitle(a, b);   // ISO strings → newest first
  });
}

/* `pairs` is [{ sortable, el }]; `sortable` needs title/stamps/lastRoundAt/updatedAt, which both
 * /api/home rows and /api/features summaries carry. */
function doneDisclosure(key, pairs, bodyClass) {
  const body = h('div', { class: bodyClass });
  const fill = (sortKey) => body.replaceChildren(...sortDonePairs(pairs, sortKey).map((p) => p.el));
  fill(doneSortKey());

  const select = h('select', {
    class: 'done-sort-select', 'aria-label': 'Sort completed workspaces',
    // Focus keys, so a forced repaint (see zoneFocusMark) puts the keyboard back on the control it
    // took away. Keyed by the list, because two disclosures can share one page.
    dataset: { fk: `done-sort:${key}` },
    // This sits inside the <summary>, where any click would otherwise toggle the section shut the
    // moment you reach for the menu.
    onclick: (e) => e.stopPropagation(),
    onkeydown: (e) => e.stopPropagation(),
    onchange: (e) => { setDoneSortKey(e.target.value); fill(e.target.value); },
  }, Object.entries(DONE_SORTS).map(([k, s]) =>
    h('option', { value: k, selected: k === doneSortKey() ? 'selected' : undefined }, s.label)));

  return h('details', {
      class: 'done-disc', open: !!doneOpen[key],
      ontoggle: (e) => { doneOpen[key] = e.currentTarget.open; },
    },
    h('summary', { class: 'done-disc-sum', dataset: { fk: `done-sum:${key}` } },
      h('span', {}, `Done (${pairs.length})`),
      h('span', { class: 'done-sort' }, h('span', { class: 'done-sort-label' }, 'Sort'), select)),
    body);
}

/* Ids for the band headings, so a <section> can point at the one that names it. A counter rather
 * than the band key: two banded lists on one page (a section grid and, later, anything else) would
 * mint the same key-derived id twice, and a duplicate id makes aria-labelledby resolve to whichever
 * came first — the wrong heading, silently. */
let bandHeadSeq = 0;

/* The banding every list view draws: WS_BANDS top to bottom, WS_STATES rank within a band, a
 * header carrying its own count, and no header over an empty band. ONE implementation, on purpose
 * — a second copy of this loop is how the kind sections and the inbox would come to disagree about
 * which band a workspace belongs in, which is the same drift the single WS_BANDS/WS_STATES tables
 * exist to prevent, just one level up.
 *
 * `entries` are `{ cat, ... }`: the category is decided ONCE by the caller and travels with the
 * entry, because categoryOf() reads the clock through isStaleJob and a second call can answer
 * differently from the one that chose the header. `render(entry, density)` draws one item at the
 * band's density, and `itemsClass` is the container the view stacks them in. Both callers stack
 * the same rows in the same `.inbox` list; it stays a parameter because the container is the
 * caller's business, not the loop's. */
function bandSections(entries, render, itemsClass) {
  // Rank is the WS_STATES index, and .sort() is stable, so ties keep insertion order.
  const ranked = entries.slice().sort((a, b) => wsState(a.cat).rank - wsState(b.cat).rank);
  const bands = [];
  for (const band of WS_BANDS) {
    const rows = ranked.filter((e) => wsState(e.cat).band === band.key);
    // A header with nothing under it reads as "you have none of these", which is a claim the list
    // doesn't need to make three times per view. Omit the band entirely.
    if (!rows.length) continue;
    // The density rides out as a class so the stylesheet can space a band by how much row it
    // holds without keeping its own list of which bands are compact — that second list is the
    // WS_BANDS/band-map drift again, just spelled in CSS, and it survives a `density` flip here.
    // The count moves INSIDE the <h2> and the <section> is named by that heading. Two things were
    // wrong and both are the same omission: the section had no accessible name at all, so a screen
    // reader's landmark/region list held three anonymous entries; and the "· 4" sat in a sibling
    // span, so jumping heading-to-heading announced "Needs you" with no idea whether that meant one
    // workspace or nine — which is the single most useful thing a triage band can tell you before
    // you decide to enter it. Sighted readers already got the number for free, right beside the
    // label. This is the same information, delivered through the tree instead of the pixels; the
    // rendering is unchanged (style.css keeps the count's own metrics so nothing shifts).
    const headId = `band-head-${++bandHeadSeq}`;
    bands.push(h('section', {
      class: `band band-${cssSafe(band.key)} band-density-${cssSafe(band.density)}`,
      'aria-labelledby': headId,
    },
      h('div', { class: 'band-head' },
        h('h2', { class: 'band-label', id: headId }, band.label,
          // The leading space is for the accessibility tree, not the pixels. Name computation
          // concatenates the heading's text nodes with nothing between them, so "Needs you" + "· 2"
          // was announced as "Needs you· 2". It costs no layout: .band-count is a flex item, and a
          // flex item's leading white space is trimmed, so the 8px gap is still the only gap.
          h('span', { class: 'band-count' }, ` · ${rows.length}`))),
      h('div', { class: itemsClass }, rows.map((e) => render(e, band.density)))));
  }
  return bands;
}

/* The subtitle's count of what needs you comes from the TOP band — which is what ordering WS_BANDS
 * by urgency means — and no longer from needsYouBits: those bits read `counts`, whose toReview is
 * blind to a PR finding carrying only a suggestion, so the header undercounted exactly the PR rows
 * it was meant to be about. The band is the same answer the rows below it are grouped by. */
function homeSubtitle(total, needsYou) {
  // plural() inflects the noun and nothing else, so the verb has to agree separately or the very
  // first line of the landing screen reads "1 workspace need you" — and n=1 is the ordinary case
  // on a quiet morning, not an edge one. The n>1 wording is untouched.
  return needsYou
    ? `${plural(needsYou, 'workspace', 'workspaces')} ${needsYou === 1 ? 'needs' : 'need'} you`
      + ` · ${plural(total, 'workspace', 'workspaces')} total`
    : `All caught up · ${plural(total, 'workspace', 'workspaces')} under watch`;
}

/* The inbox repaints from ONE replaceChildren, and the poller calls it every 4 seconds — which is a
 * DOM swap under the user's hands. It cost an open delete-confirm ("Delete "…"? This can't be
 * undone.") within four seconds of opening it, focus dropped to <body>, the selection cleared, and
 * the Done disclosure's <select> torn out mid-choice. Before ce22adf Home repainted only
 * #requests-strip, so none of that could happen; binding jobs onto the rows is what put the whole
 * list on the tick. Three rules keep it there without the cost.
 *
 * `sig` is everything the inbox actually draws — each row's id, the state/band it landed in, the
 * identity and status of the job folded onto it, and the age STRINGS it prints (rowAgeText). Row
 * content beyond that is not in it because it cannot change here: state.home.rows is only ever
 * refilled by renderHome(), which rebuilds the zone outright. A tick whose signature matches the
 * last painted one touches nothing at all, and that is the overwhelming majority of ticks.
 *
 * `pending` is the second. A tick that DOES change something, arriving while the user is mid-
 * something, must not yank the DOM — but it must not drop the change either: a job that starts
 * while you are hovering a trash icon still has to show up. So the repaint is held, and released
 * the moment the interaction ends (see releaseHomeInbox) or, failing that, on the next tick. `sig`
 * is set only when the paint actually lands, which is what makes the hold self-healing rather than
 * a one-shot flag that can be lost.
 *
 * `reload` is the third, and it is the same rule one level up. startHomeRequestsPoll refetches the
 * whole view when a job newly completes, because a completed job means new server data — and
 * renderHome() does app.replaceChildren() on the ENTIRE view, outside both the signature and the
 * hold. That is blocker 2 again by a narrower path, and it was still reproducible: confirm open,
 * focus on the red Delete button, a second job completes → {"confirms":0,"active":"BODY."}. The
 * refetch must still happen — dropping it would leave the view stale — so it is flagged here and
 * performed by releaseHomeInbox() through the SAME guard, never a second one of its own. */
const homeInbox = { sig: null, reqs: [], pending: false, reload: false, heldAt: 0 };

/* Every "N ago" a row will print, as the text it will print — not the clock behind it.
 *
 * These strings are rendered and derived from nothing else in the signature, so once "a tick that
 * changes nothing touches nothing" landed they froze: at ce22adf the inbox repainted every 4s and
 * they kept up; after it, a row reading "queued 27m ago" went on saying so at 40m. Putting
 * Date.now() in the signature is the other way to lose — every tick would differ, every tick would
 * repaint, and the DOM-swap pressure this whole mechanism exists to remove would be back in full.
 * Rendered text changes at the granularity fmtAgo/fmtAge print at (a minute, then an hour, then a
 * day, then an absolute date that never moves), so that is when this repaints: when the words would
 * actually differ, not when the clock does.
 *
 * Deliberately EVERY stamp the workspace owns, not only the ones this row's density happens to
 * draw. Re-deriving "which stamp shows at which density" here would be a second copy of
 * rowParts/compactStamp/reviewStampsRow's rule, and a copy like that drifts silently — with a
 * frozen string as the symptom, which is the bug. Over-including costs at most one extra repaint a
 * minute on a workspace whose stamps are under an hour old; under-including costs the regression. */
function rowAgeText(f, job) {
  const s = f ? reviewStampsOf(f) : {};
  return [
    fmtAgo(s.lastReviewedAt), fmtAgo(s.lastActivityAt), fmtAgo(s.lastPostedAt),
    fmtAgo(f && f.lastRoundAt), fmtAgo(f && f.updatedAt),
    // cardJobRow prints exactly one clock of its own, on a stalled job ("started 27m ago"). Whether
    // the job IS stale already reaches the signature through `cat`; this is the number beside it.
    job && isStaleJob(job) ? fmtAge(jobAgeMs(job)) : null,
  ].map((x) => x || '').join('/');
}

/* One banded entry's contribution to the signature. Job identity AND status, because "queued →
 * running" is a visible change on the row even when the band doesn't move; `phase` too, since the
 * job line spells it out. A placeholder entry has no workspace, so the job it stands for is its
 * identity — the only one it has. */
function listEntrySig(e) {
  return [
    (e.ws && e.ws.id) || (e.job ? `job:${e.job.id}` : '-'),
    e.cat || '-',
    e.cat ? wsState(e.cat).band : '-',
    e.job ? `${e.job.id}/${e.job.status}/${e.job.needsInput ? 1 : 0}/${e.job.phase || ''}` : '-',
    rowAgeText(e.ws, e.job),
  ].join('~');
}

/* The signature of a banded list — see homeInbox. ONE function for both banded lists, for the same
 * reason bandSections is one loop: the inbox and the section grid are the same list of the same
 * entries drawn two ways, and a second signature is a second answer to "did anything change".
 *
 * Done entries are in it too: the disclosure's count would otherwise go stale, and a Done row prints
 * "Last reviewed 12m ago" exactly as an active one does, so it would freeze exactly as one. They
 * carry no band (they are outside the bands by construction), which costs nothing — a constant term
 * in every signature is a constant term in both sides of the comparison. */
function bandedListSig(entries, done) {
  return [...entries.map(listEntrySig), `done:${done.map(listEntrySig).join(',')}`].join('|');
}

/* How long a polled list may hold a repaint for a cursor: three ticks of the 4s poller.
 *
 * 316edb0 held on focus exactly as it held on a confirm — until the interaction ends — and focusout
 * only fires when the user MOVES. A keyboard user resting on a row link therefore stopped seeing
 * new work indefinitely: measured frozen across 5+ ticks with the data changing on every one. A
 * list that is silently wrong about the world is the worse of the two failures, so focus gets a
 * ceiling. Long enough that ordinary tabbing, reading, and reaching for a control are never
 * interrupted; short enough that "frozen" is never the right word for what you are looking at. */
const ZONE_BUSY_HOLD_MS = 12000;

/* Why a polled list is holding its repaint, or null. The two answers are different in kind, and
 * telling them apart IS the ceiling:
 *
 *  'confirm' — an unanswered destructive question ("Delete X? This can't be undone."). A repaint
 *    answers it "no" on the user's behalf, silently, and there is nothing to put back afterwards.
 *    No poll tick is worth that, so this hold has NO ceiling: it lasts until the user answers, and
 *    the note the list shows while held (zoneHeldNote) is what keeps that honest on screen.
 *  'busy' — focus, or a live text selection, inside the list: a place the user is keeping, not a
 *    decision they are making. A swap drops them to <body> and clears the selection, which is why
 *    holding here is right at all — but only up to ZONE_BUSY_HOLD_MS, after which the list repaints.
 *
 *    What the repaint puts back is FOCUS, and only focus (zoneFocusMark / restoreZoneFocus). Two
 *    things it does not put back, named here rather than glossed, because a comment that promises
 *    more than the code delivers is how the next reader stops checking:
 *      · a native <select> left open past the ceiling closes — focus survives and the chosen value
 *        is unchanged, so this one is recoverable and visible;
 *      · a text SELECTION is destroyed outright, and nothing restores it. Re-selecting a title you
 *        were half-way through copying is the cost, and it is real.
 *    Neither is worth an indefinite freeze, and both are recoverable by the user in a way that a
 *    silently dismissed delete confirm is not — which is the whole reason the two holds differ. A
 *    restore was considered and not built: the only honest one spans replaceChildren by re-finding
 *    the anchor and offset in rebuilt nodes, which is a large mechanism for a rare loss, and the
 *    signature short-circuits (homeInbox.sig, gridPaint.sig) removed the case that made it common —
 *    an idle list no longer repaints at all, so reaching the ceiling now needs the data to be
 *    genuinely changing under the selection for twelve seconds. */
function zoneHold(zone) {
  if (!zone) return null;
  if (zone.querySelector('.delete-confirm')) return 'confirm';
  const a = document.activeElement;
  if (a && a !== document.body && zone.contains(a)) return 'busy';
  // Selecting a title to copy leaves activeElement on <body>, so the focus arm never sees it — and
  // a repaint collapses the selection with no way to restore it.
  const sel = typeof getSelection === 'function' ? getSelection() : null;
  if (sel && sel.rangeCount && !sel.isCollapsed && sel.anchorNode && zone.contains(sel.anchorNode)) {
    return 'busy';
  }
  return null;
}

/* May this hold still stand? `g.heldAt` is stamped by the first held decision and cleared by the
 * paint that ends it, so what this measures is CONTINUOUS held time rather than a count of calls —
 * a user clicking around inside the zone must not burn the budget faster than a user sitting still,
 * because they are equally entitled to a list that is telling the truth. */
function holdStands(hold, g) {
  if (!hold) return false;
  if (!g.heldAt) g.heldAt = Date.now();
  return hold === 'confirm' || Date.now() - g.heldAt < ZONE_BUSY_HOLD_MS;
}

/* Where focus is, in terms that survive the rebuild. Every element in the zone is replaced, so a
 * node reference is worthless; what survives is WHICH control it was, and each focusable in a
 * polled list carries a stable `data-fk` for exactly this. Without it the ceiling would trade one
 * failure for another — the list unfreezes and the keyboard user is dumped to <body>, which is the
 * thing the hold was added to prevent in the first place. */
function zoneFocusMark(zone) {
  const a = document.activeElement;
  if (!zone || !a || !a.closest || !zone.contains(a)) return null;
  const el = a.closest('[data-fk]');
  return el ? el.dataset.fk : null;
}

function restoreZoneFocus(zone, fk) {
  if (!zone || !fk) return;
  const el = zone.querySelector(`[data-fk="${CSS.escape(fk)}"]`);
  // preventScroll: the user did not ask to move, so putting them back must not move the page either.
  if (el) el.focus({ preventScroll: true });
}

/* What a held list says about itself, and why it says anything at all.
 *
 * While the rows were held the page contradicted itself outright: the requests strip and the
 * "▶ Run N jobs" toolbar sit OUTSIDE this guard and keep updating, so the strip read "1 job in
 * flight — already shown on the rows below" while no row showed it. The answer is NOT to freeze
 * them too. The toolbar is a control whose count you act on — freezing it means pressing a button
 * that promises the wrong number — and the strip is the cross-section queue view, so freezing it
 * hides live work at the exact moment work is happening. What was missing was never their liveness;
 * it was the rows admitting they are not live. Now they do, and one story covers the whole screen.
 *
 * Appended, never prepended, and never through replaceChildren: this element has to arrive without
 * moving anything already on screen. A confirm's red Delete button is under the pointer when this
 * appears, and a banner that pushes the list down by its own height turns a status line into a
 * misclick on something irreversible. It pins itself to the bottom of the viewport in CSS instead. */
function zoneHeldNote(zone, text) {
  if (!zone) return;
  let note = zone.querySelector(':scope > .zone-held');
  if (!note) {
    note = h('div', { class: 'zone-held', role: 'status' },
      h('span', { class: 'zone-held-glyph', 'aria-hidden': 'true' }, '⏸'),
      h('span', { class: 'zone-held-text' }));
    zone.append(note);
  }
  const t = note.querySelector('.zone-held-text');
  // Written only on a real change, or role="status" re-announces the same sentence every four
  // seconds to a screen reader for as long as the hold lasts.
  if (t.textContent !== text) t.textContent = text;
  // Nothing else to do. There WAS a height reservation here (`--zone-held-h` + a .zone-holding
  // padding-bottom), added on the theory that a pinned note floats over the row at the bottom edge
  // and that row has to stay reachable. `position: sticky` already makes that true: sticky keeps the
  // element's own flow box, which is at the END of the zone, and only shifts it UP while the end of
  // the zone is below the fold — so at the scroll extreme where the note would sit on the last row,
  // it is back in its own box with the row above it. Measured on a 26-row inbox at 1280px and at
  // 420px, at both scroll extremes, with the reservation and without: the same rows are covered at
  // mid-scroll (which the reservation never addressed) and NO row is covered at maximum scroll
  // either way. What it did do was leave ~56px of empty space under every held list.
}

function clearZoneHeldNote(zone) {
  if (!zone) return;
  const note = zone.querySelector(':scope > .zone-held');
  if (note) note.remove();
}

/* One sentence per reason, and each one answers the strip directly. The measured contradiction was
 * the strip reading "1 job in flight — already shown on the rows below" while no row showed it, so
 * it is not enough to say "paused": the note has to say that the queue above is AHEAD of these
 * rows, which is exactly the gap the strip's sentence would otherwise deny. */
const HOME_HELD_NOTE = {
  confirm: 'Paused while you answer — the job queue above has moved on and these rows have not. '
    + 'They catch up the moment you decide.',
  busy: 'Paused while you work here — the job queue above has moved on and these rows have not. '
    + 'They catch up in a moment.',
};

/* Release whatever Home is holding, in the order that keeps the newest answer: a pending RELOAD
 * refetches and rebuilds the whole view, so a repaint queued behind it is stale by construction and
 * is dropped rather than drawn first. Called from BOTH release edges — the interaction ending
 * (flushHomeInboxSoon, wired to the zone's click/focusout) and the next poll tick — because either
 * alone has a hole: the tick alone leaves up to four seconds of stale bands after a Cancel, and the
 * event alone loses the change when the interaction ends in a way that fires neither. */
function releaseHomeInbox() {
  if (current.view !== 'home') return;
  // Nothing held ⇒ nothing to decide, and in particular no hold clock to start: stamping heldAt on
  // a quiet tick would spend the ceiling before the first change that needed it ever arrived.
  if (!homeInbox.reload && !homeInbox.pending) return;
  const zone = $('#home-inbox-zone');
  const hold = zoneHold(zone);
  if (holdStands(hold, homeInbox)) { zoneHeldNote(zone, HOME_HELD_NOTE[hold]); return; }
  // Past the ceiling with focus still inside, the mark is how the user keeps their place across a
  // rebuild they did not ask for. A release triggered by the user's OWN click or blur has no hold
  // left to read, so `mark` is null there and focus is left exactly where they put it.
  const mark = hold ? zoneFocusMark(zone) : null;
  if (homeInbox.reload) {
    homeInbox.reload = false;
    homeInbox.pending = false;
    homeInbox.heldAt = 0;
    // renderHome() replaces the view, so the mark can only be redeemed once the new zone exists.
    renderHome()
      .then(() => restoreZoneFocus($('#home-inbox-zone'), mark))
      .catch(() => { /* renderHome reports its own failures in the view it drew */ });
    return;
  }
  renderHomeInbox(homeInbox.reqs);
}

/* Deferred by a turn of the event loop on purpose: during focusout document.activeElement is
 * transiently <body>, so asking zoneHold() right now would answer "nobody is here" mid-Tab and
 * destroy the element about to receive focus. */
function flushHomeInboxSoon() { setTimeout(releaseHomeInbox, 0); }

/* Draws the inbox from the cached rows against the jobs seen this tick, and answers WHICH of those
 * jobs it folded onto a row. The strip needs that answer: a job shown on a row and in the strip
 * states the same thing twice on one screen — the exact duplication the sections removed when they
 * folded jobs onto rows. Returns a Set of job ids — always, whether or not this call repainted,
 * because the strip's dedupe is about what is ON SCREEN, not about what this tick happened to draw. */
function renderHomeInbox(requests) {
  const rows = (state.home && state.home.rows) || [];
  const live = (requests || []).filter(isLiveJob);
  const used = new Set();
  const active = [];
  const doneRows = [];
  for (const r of rows) {
    if (r.status === 'done') { doneRows.push({ ws: r }); continue; }
    // Bound exactly as a section row binds its job, through the same two helpers: a PR being
    // posted, or one whose runner has stalled, must band by what is happening to it right now
    // rather than by whatever it was before the job started.
    const job = jobForFeature(r, live);
    if (job) used.add(job.id);
    // `ws` rather than `r`, because this is the entry shape bandedListSig and the section grid
    // share — the two banded lists sign themselves with one function or they drift.
    active.push({ ws: r, job, cat: categoryOf(r, job) });
  }

  // Kept so a held repaint can be replayed from the interaction that ends, not only from the tick.
  homeInbox.reqs = requests || [];

  const zone = $('#home-inbox-zone');
  if (!zone) return used;
  const sig = bandedListSig(active, doneRows);
  // A tick that changes nothing must touch nothing — and with nothing outstanding there is nothing
  // to hold, so the clock and the note both go.
  if (sig === homeInbox.sig) {
    homeInbox.pending = false;
    homeInbox.heldAt = 0;
    clearZoneHeldNote(zone);
    return used;
  }
  // Something did change — but not at the cost of whatever the user has open. Hold it, and say so
  // on the rows, because the strip and the toolbar above are deliberately NOT held (zoneHeldNote).
  const hold = zoneHold(zone);
  if (holdStands(hold, homeInbox)) {
    homeInbox.pending = true;
    zoneHeldNote(zone, HOME_HELD_NOTE[hold]);
    return used;
  }
  // Past the ceiling with focus still parked inside: repaint, then put the user back on the same
  // control. Unfreezing the list at the cost of their place would just be the other failure.
  const mark = hold ? zoneFocusMark(zone) : null;

  const bands = bandSections(active,
    (e, density) => workspaceRow(e.ws, e.job, density, e.cat, ROW_HOME), 'inbox');
  const lists = bands.length
    ? bands
    : [h('p', { class: 'all-done-note' }, 'No active workspaces — everything below is complete.')];
  if (doneRows.length) {
    lists.push(doneDisclosure('home',
      doneRows.map((e) => ({ sortable: e.ws, el: workspaceRow(e.ws, null, 'full', null, ROW_HOME) })),
      'inbox done-disc-body'));
  }
  // replaceChildren takes the note with everything else, and there is nothing left on the zone to
  // take down with it (zoneHeldNote), so the paint needs no clear of its own.
  zone.replaceChildren(h('div', { class: 'section-lists' }, ...lists));
  // Recorded only now, after the paint actually landed: a signature stamped on a tick that skipped
  // would make the skip permanent, which is how a deferred change turns into a dropped one.
  homeInbox.sig = sig;
  homeInbox.pending = false;
  homeInbox.heldAt = 0;
  restoreZoneFocus(zone, mark);

  const sub = $('#home-sub');
  if (sub) {
    sub.textContent = homeSubtitle(rows.length,
      active.filter((e) => wsState(e.cat).band === WS_BANDS[0].key).length);
  }
  return used;
}

async function renderHome() {
  current.view = 'home'; current.id = null; current.tab = null;
  const seq = ++routeSeq;
  const app = $('#app');
  app.replaceChildren(
    h('div', { class: 'view-head' },
      h('h1', {}, 'Home'),
      h('p', { class: 'view-sub' }, 'Everything that needs your attention — across specs and PRs')),
    h('div', { class: 'inbox' }, Array.from({ length: 3 }, () => skel('skel-row'))),
  );
  let rows;
  try {
    rows = await api('/api/home');
  } catch (e) {
    if (seq !== routeSeq) return;
    toast(`Could not load home: ${e.message}`);
    app.replaceChildren(errorView('Could not load home', e.message));
    return;
  }
  if (seq !== routeSeq) return;
  if (!Array.isArray(rows)) rows = [];

  // A fresh view is a fresh zone, and an EMPTY one, so the signature from the last visit must not
  // be allowed to match and skip the first paint into it. The hold goes with it: a clock or a
  // deferred reload left over from the zone that has just been thrown away would be measuring an
  // interaction in a DOM that no longer exists.
  homeInbox.sig = null;
  homeInbox.pending = false;
  homeInbox.reload = false;
  homeInbox.heldAt = 0;

  if (rows.length === 0) {
    app.replaceChildren(
      h('div', { class: 'view-head' }, h('h1', {}, 'Home')),
      h('div', { class: 'section-actions' }, refreshZone(null), runnerZone(0)),
      requestsStripEl([]),
      h('div', { class: 'empty' },
        h('div', { class: 'empty-glyphs' },
          ...SEV_ORDER.map((s) => h('span', { class: `sev sev-${s}` },
            h('span', { class: 'sev-glyph' }, SEV[s].glyph), ' ', SEV[s].label))),
        h('h2', {}, 'Nothing in the cockpit yet'),
        h('p', {}, 'Seed the demo with ', h('code', {}, 'node src/cli.js demo'),
          ', or run ', h('code', {}, '/flowlever:audit'), ', ', h('code', {}, '/flowlever:pr-review'),
          ' or ', h('code', {}, '/flowlever:pr-respond'), ' from Claude Code.')));
    startHomeRequestsPoll();
    return;
  }

  // Cached so every poll tick can re-band them against the live jobs without refetching — the same
  // arrangement the kind sections use, and the only way a row's band can follow its runner.
  state.home.rows = rows;
  app.replaceChildren(
    h('div', { class: 'view-head' },
      h('h1', {}, 'Home'),
      h('p', { class: 'view-sub', id: 'home-sub' }, homeSubtitle(rows.length, 0))),
    h('div', { class: 'section-actions' }, refreshZone(null), runnerZone(0)),
    requestsStripEl([]),
    h('div', {
      id: 'home-inbox-zone',
      // Where a held repaint gets released. A click is what ends a confirm (Cancel swaps the trash
      // button back in before this bubbles), focusout is what ends a keyboard visit — so by the
      // time flushHomeInboxSoon re-asks, the answer is the true one.
      onclick: flushHomeInboxSoon,
      onfocusout: flushHomeInboxSoon,
    }),
  );
  // Paint the bands now rather than holding the whole inbox back for the queue's round trip — but
  // from the jobs LAST SEEN, not from nothing. `[]` here was a measured 4.2s hole: renderHome() is
  // how a completed job gets its fresh data (homeInbox.reload → releaseHomeInbox), so this line runs
  // precisely when other jobs are still running, and it dropped every one of them — the row fell
  // back to "Needs you", the job line vanished, and homeInbox.reqs was overwritten with [] so the
  // strip lost its dedupe too. One tick later the poller put it all back. The cache is the truth
  // this view already has; startPolling below corrects it within the tick.
  renderHomeInbox(homeInbox.reqs);
  startHomeRequestsPoll();
}

/* Home re-bands its rows against the live queue every tick, then shows what the rows did NOT
 * account for: the strip is the cross-section queue view and still carries jobs with no row yet,
 * but a job already folded onto a row must not be listed twice on one screen. Done jobs drop off
 * once their workspace appears in the inbox below; when one completes, refetch so it surfaces. */
function startHomeRequestsPoll() {
  let lastDone = new Set();
  startPolling('home', (reqs) => {
    if (current.view !== 'home') return;
    const used = renderHomeInbox(reqs);
    const active = reqs.filter((r) => r.status !== 'done');
    const unbound = active.filter((r) => !used.has(r.id));
    // The strip's own header counts what it LISTS, so partial binding made the screen contradict
    // itself: "2 jobs" beside "▶ Run 3 jobs", with nothing on the page joining the two numbers up.
    // The remainder is the missing term, said once, so the arithmetic closes.
    const onRows = active.length - unbound.length;
    // A PR can carry two live jobs; jobForFeature folds only the most urgent, so the runner-up
    // reaches the strip. Keeping it is right — hiding live work would be the worse lie — but
    // unlabelled it reads as a job on some other PR, which is a third claim about the same one.
    const alsoOnRow = (r) => (state.home.rows || [])
      .some((row) => row.status !== 'done' && jobBindsTo(r, row));
    // While the inbox is holding a repaint (homeInbox.pending) the rows below are BEHIND this strip
    // by construction — that is what the hold is. "already shown on the rows below" is then a claim
    // the screen itself contradicts: the held note says the queue above has moved on, and this
    // sentence said it had not. The note explains the gap; the strip may not deny it in the same
    // breath. Softened, never dropped — where the jobs went is still the thing worth saying, and an
    // empty silent strip reads as a broken queue.
    const behind = homeInbox.pending;
    // With everything bound the strip has nothing left to add. Empty and silent reads as a broken
    // queue, so say where those jobs went instead.
    populateRequestsStrip($('#requests-strip'), unbound, active.length
      ? `${plural(active.length, 'job', 'jobs')} in flight — `
        + (behind ? 'the rows below are catching up.' : 'already shown on the rows below.')
      : null,
      { note: onRows ? `+ ${onRows} ${behind ? 'catching up below' : 'on the rows below'}` : null, onRow: alsoOnRow });
    // Home's Refresh button covers both PR sections, so any live poll job drives it.
    renderRefreshZone($('#refresh-zone'), null, pickPollJob(reqs, null));
    // Home's Run button offers to drain everything that's waiting, whatever section it belongs to.
    renderRunnerZone($('.runner-zone'), queuedJobs(reqs).length);
    const doneIds = new Set(reqs.filter((r) => r.status === 'done').map((r) => r.id));
    let newlyDone = false;
    doneIds.forEach((id) => { if (!lastDone.has(id)) newlyDone = true; });
    const first = lastDone.size === 0;
    lastDone = doneIds;
    // A completed job means new server data, so the whole view has to be refetched — but
    // renderHome() replaces the entire view, which destroys an open confirm and drops focus exactly
    // as a zone repaint does, only wider. Flag it and let releaseHomeInbox() run it through the
    // same guard; with nothing held that happens on this very line, as it did before.
    if (newlyDone && !first) homeInbox.reload = true;
    // The tick-side release, after everything this tick decided. The event-side release is
    // flushHomeInboxSoon on the zone; neither is enough alone — an interaction can end in a way
    // that fires no event, and waiting for the next tick alone leaves a Cancel four seconds stale.
    releaseHomeInbox();
  });
}

/* ============================== kind sections (features grid) ============================== */

const SECTION_COPY = {
  spec: { sub: 'Readiness across all linked specs, work items and designs' },
  'pr-review': { sub: 'Pull requests you are reviewing' },
  'pr-respond': { sub: 'Reviewer threads on your own pull requests' },
};

function sectionHead(kind, count) {
  const m = kindMeta(kind);
  const copy = SECTION_COPY[kind] || SECTION_COPY.spec;
  return h('div', { class: 'view-head' },
    h('h1', {}, m.label),
    h('p', { class: 'view-sub' }, count != null
      ? `${plural(count, 'workspace', 'workspaces')} under watch`
      : copy.sub));
}

function sectionEmpty(kind) {
  if (kind === 'spec') {
    return h('div', { class: 'empty' },
      h('div', { class: 'empty-glyphs' },
        h('span', { class: 'sev-blocker' }, '◆'), ' ',
        h('span', { class: 'sev-major' }, '▲'), ' ',
        h('span', { class: 'sev-minor' }, '●'), ' ',
        h('span', { class: 'sev-info' }, '○')),
      h('h2', {}, 'No spec audits yet'),
      h('p', {}, 'Seed a demo workspace with ', h('code', {}, 'node src/cli.js demo'),
        ' or run ', h('code', {}, '/flowlever:audit'), ' from a Claude Code session.'));
  }
  const cmd = kind === 'pr-review' ? '/pr-review <id>' : '/pr-respond <id>';
  const what = kind === 'pr-review'
    ? "a pull request's diff into the cockpit so you can review it"
    : 'the reviewer threads on your PR so you can respond to them';
  return h('div', { class: 'empty' },
    h('div', { class: 'empty-icon', html: ICONS[kindMeta(kind).icon] || '' }),
    h('h2', {}, `No ${kindMeta(kind).label.toLowerCase()} workspaces yet`),
    h('p', {}, 'Run ', h('code', {}, cmd), ' in Claude Code to pull ', what, '. ',
      'It rides the same review stepper as everything else — those adapters land in a later phase.'));
}

async function renderSection(kind) {
  current.view = 'section'; current.id = null; current.tab = null; current.kind = kind;
  const seq = ++routeSeq;
  const app = $('#app');
  app.replaceChildren(
    sectionHead(kind),
    // The same skeleton Home draws, because the same rows are what lands here: a card-shaped
    // placeholder followed by a list of rows is a layout shift the first paint does not need.
    h('div', { class: 'inbox' }, Array.from({ length: 3 }, () => skel('skel-row'))),
  );
  let features;
  try {
    features = await api(`/api/features?kind=${encodeURIComponent(kind)}`);
  } catch (e) {
    if (seq !== routeSeq) return;
    toast(`Could not load ${kind}: ${e.message}`);
    app.replaceChildren(errorView(`Could not load ${kindMeta(kind).label}`, e.message));
    return;
  }
  if (seq !== routeSeq) return;
  if (!Array.isArray(features)) features = [];

  const isPr = kind === 'pr-review' || kind === 'pr-respond';
  state.section = { kind, features };
  const gridZone = h('div', { id: 'section-list-zone' },
    sectionGrid(kind, sectionEntries(kind, features, [])));

  app.replaceChildren(...[
    sectionHead(kind, features.length || null),
    // PR sections get the manual refresh next to "+ New …": queue a discovery pass now
    // instead of waiting for the scheduled poller.
    isPr
      ? h('div', { class: 'section-actions' }, newRequestZone(kind), refreshZone(kind), runnerZone(0))
      : (kind === 'spec' ? newAuditZone() : null),
    gridZone,
  ].filter(Boolean));

  // Every kind, not only the PR ones. Without this #/spec was the one banded surface that never saw
  // a runner: a spec workspace with a live `apply` read "In progress" on Home and "Needs you /
  // Ready to post" here, which is two answers about one workspace from the two views that share a
  // state table precisely so they cannot give two.
  gridHold.heldAt = 0;   // a fresh zone has no interaction to be mid-way through
  // And an EMPTY one, so a signature left over from the last section visited must not be allowed to
  // match and skip the first paint into it — the same reason renderHome() clears homeInbox.sig.
  gridPaint.sig = null;
  startSectionRequestsPoll(kind);
}

/* Which WS_STATES key a row belongs under. A live runner job OUTRANKS the workspace's own state:
 * what a runner is doing to this PR right now is the truer answer to "what is happening to it"
 * than a state computed from stamps the runner is in the middle of invalidating.
 *
 * `f` may be null — a pending placeholder has a job and no workspace yet. Deliberately free of any
 * `kind` assumption, so the inbox can band the same way the sections do. */
function categoryOf(f, job) {
  if (job) {
    // These three are the same "a human has to unstick this" pool jobRank() puts at the top, and
    // they must not be buried under "In progress": nothing is progressing.
    const needsInput = !!job.needsInput && job.status !== 'done' && job.status !== 'error';
    if (needsInput || job.status === 'error' || isStaleJob(job)) return 'job-attention';
    if (job.action === 'apply') return 'job-posting';
    if (job.action === 'poll') return 'job-polling';
    if (job.action === 'summarize') return 'job-summarizing';
    // A re-run against a workspace that already has findings/rounds is a re-review, not a first
    // pass — the same distinction cardJobRow's verb makes, read from the same derivation.
    return hasFindingsOf(f) ? 'job-rereviewing' : 'job-reviewing';
  }
  // No job: the server's canonical state, if this build of the cockpit knows the word.
  return WS_STATE_INDEX.has(f && f.state) ? f.state : WS_FALLBACK_STATE;
}

/* Which queue actions act on a workspace of THIS kind. The section filter used to be
 * `r.action === kind`, which is right only by coincidence: a PR review's action IS the kind of
 * workspace it makes. `spec` has no action of its own name, so the same test admitted nothing and
 * #/spec never folded a job onto a card — a spec workspace with a live `apply` banded "In progress"
 * on Home and "Needs you / Ready to post" on its own section. One workspace, two surfaces, two
 * answers: the exact thing the single `state` and the single band table exist to prevent.
 *
 * One table rather than a branch per kind, for the reason WS_STATES is one table: a second place
 * that decides what belongs to a section is a second place to forget `propose` in. It mirrors
 * ledger.js's REQUEST_ACTIONS, minus the two that are not owned by a kind —
 *
 *   `apply`  reaches a section only through jobBindsTo, which is what keeps an apply on a PR
 *            workspace out of #/spec: the wsId arm is an exact id match and nothing else answers.
 *   `poll`   is PR discovery. It drives the Refresh button, never a row, and has no workspace.
 *
 * — so no PR action appears under `spec` and no spec action under a PR kind, which is the whole of
 * "a section sees exactly the jobs that act on its own workspaces". */
const KIND_ACTIONS = {
  spec: ['audit', 're-audit', 'propose'],
  'pr-review': ['pr-review'],
  'pr-respond': ['pr-respond'],
};
function actsOnKind(job, kind) { return (KIND_ACTIONS[kind] || []).includes(job.action); }

/* Queue actions that name ONE workspace by `wsId` and that any kind can host, so KIND_ACTIONS
 * cannot own them — jobBindsTo's wsId arm is their way onto a row. One table, for the same reason
 * KIND_ACTIONS is one: `apply` was hardcoded at each site instead, so adding `summarize` left its
 * job invisible on the section list and mislabelled everywhere else. A new action added here shows
 * up on every surface at once. (`poll` is not here — it names no workspace and drives the Refresh
 * button instead of a row.) */
const WSID_JOB_ACTIONS = ['apply', 'summarize'];
/* …plus the ones a kind already owns that can still change what the DETAIL page is showing. */
const DETAIL_JOB_ACTIONS = [...WSID_JOB_ACTIONS, 'propose'];

/* The rows for a section, drawn as ordered bands: what needs you, what a runner is mid-way
 * through, what is parked on somebody else — then the collapsed Done list, unchanged. Each
 * workspace's live job is folded onto its row, and an in-flight review whose workspace doesn't
 * exist yet gets a placeholder. No separate jobs strip — the status lives on the row it belongs to. */
function sectionEntries(kind, features, requests) {
  const live = (requests || []).filter(isLiveJob);
  const withJob = features.map((ws) => ({ ws, job: jobForFeature(ws, live) }));
  // In-flight reviews for THIS section with no workspace yet → pending placeholder rows, banded
  // by the same rule as everything else. They lead the list so that, at equal rank, the work that
  // has no row of its own yet still appears where its real row will land.
  //
  // "No workspace yet" is jobBindsTo() asked of every row on the page, and it has to be that and
  // nothing else. The job jobForFeature HAPPENED to bind is not the test — a PR carrying two live
  // jobs binds both but folds one, so the runner-up leaks through and draws a placeholder BESIDE
  // that PR's own row: two contradictory claims about one PR, and a band count naming more
  // workspaces than the band holds. Neither is `wsId` the test — a job enqueued from "+ New PR
  // review" carries no wsId and binds by prId, so reading only wsId here is the same duplicate
  // wearing a different hat. A placeholder's whole justification is that there is no row to fold
  // the job onto; the one predicate that answers that is the one the folding itself uses.
  //
  // What is deliberately NOT excluded: a wsId naming a workspace that is GONE. That job is as
  // orphaned as one that never carried a wsId, and dropping it (`&& !r.wsId`) hides a running
  // review from the cockpit entirely. Existence is the question, not the presence of the field.
  //
  // What a placeholder is required to have is a NAME, not a PR number. `r.prId` was standing in for
  // that requirement, and on #/spec it cost the whole surface: a brand-new `audit` carries no prId
  // (ledger.js takes wsId OR instructions) and no workspace either, so a first spec analysis drew no
  // card, no placeholder, and — that page having no requests strip — nothing at all. Its only
  // evidence it was running was Home's strip, one navigation away. pendingJobTitle() is the same
  // requirement said directly, and it still refuses the anonymous job an unconditional filter would
  // admit: a "starting…" box that names no work is worse than no box.
  const pending = live
    .filter((r) => actsOnKind(r, kind) && pendingJobTitle(r) && !features.some((f) => jobBindsTo(r, f)))
    .map((r) => ({ ws: null, job: r, cat: categoryOf(null, r) }));
  // Active workspaces get banded; finished ones drop into a collapsed "Done" section.
  const active = withJob.filter(({ ws }) => ws.status !== 'done')
    .map(({ ws, job }) => ({ ws, job, cat: categoryOf(ws, job) }));
  const done = withJob.filter(({ ws }) => ws.status === 'done');
  return { pending, active, done };
}

/* The rows for a section, from the entries decided above. Split from sectionEntries() so the poll
 * can SIGN the entries and draw them from one decision: categoryOf() reads the clock through
 * isStaleJob, so deciding twice per tick — once to compare, once to render — is the same drift that
 * makes a row sit under one header wearing another's label.
 *
 * The rows are the inbox's rows, at ROW_SECTION: one renderer for both surfaces, differing only in
 * the two things that genuinely differ between them (the kind badge, and the material a section
 * exists to show). A second renderer for the same object is what this replaces. */
function sectionGrid(kind, entries) {
  // The category decided in sectionEntries travels with the row. Recomputing it inside the renderer
  // re-reads Date.now() through isStaleJob: one decision per render.
  const bands = bandSections([...entries.pending, ...entries.active], (e, density) => (e.ws
    ? workspaceRow(e.ws, e.job, density, e.cat, ROW_SECTION)
    : pendingJobRow(e.job, density, kind)), 'inbox');
  // Kept as { sortable, el } pairs so the Done disclosure can reorder them by date — the row
  // element alone carries no timestamp to sort on.
  // The job still travels with a done row, exactly as it did with the done card: an `apply` can be
  // running against a workspace somebody has already marked complete, and bandedListSig signs the
  // done entries' jobs too — a row that dropped the job would be re-signed on every phase change and
  // redraw the same thing.
  const doneRows = entries.done.map(({ ws, job }) => ({
    sortable: ws, el: workspaceRow(ws, job, 'full', null, ROW_SECTION),
  }));

  if (!bands.length && !doneRows.length) return sectionEmpty(kind);
  const lists = bands.length
    ? bands
    : [h('p', { class: 'all-done-note' }, 'No active workspaces — everything below is complete.')];
  if (doneRows.length) lists.push(doneDisclosure(kind, doneRows, 'inbox done-disc-body'));
  return h('div', { class: 'section-lists' }, ...lists);
}

/* The signature of what a section grid is showing — bandedListSig, plus the one term the inbox does
 * not need.
 *
 * `rev` is that term. state.home.rows is only ever refilled by renderHome(), which rebuilds the zone
 * outright, so the inbox's signature can ignore everything a row draws beyond its band and its ages.
 * state.section.features is refilled IN PLACE by this very poll when a job completes, and what comes
 * back is exactly the scores, counts and stamps the rows draw — so the refetch has to be able to
 * move the signature even when no band does. A counter bumped by the refetch says that in one term
 * and cannot be forgotten by a row that learns a new field. */
const gridPaint = { sig: null, rev: 0 };

function sectionGridSig(entries) {
  return `${bandedListSig([...entries.pending, ...entries.active], entries.done)}|rev:${gridPaint.rev}`;
}

/* The grid's half of the hold. Only a clock: the grid repaints every tick regardless, so unlike the
 * inbox it has no repaint that could be lost and nothing to defer — just a question of whether THIS
 * tick may land on an open confirm. Its own record rather than the inbox's, because the two lists
 * are never on screen together and one shared clock would carry a hold across a navigation. */
const gridHold = { heldAt: 0 };

/* Said on the rows themselves, for the reason HOME_HELD_NOTE is said on Home's: everything else
 * on the page keeps updating, so the part that isn't has to be the part that says so. */
const GRID_HELD_NOTE = {
  confirm: 'Paused while you answer — the job queue above has moved on and these rows have not. '
    + 'They catch up the moment you decide.',
  busy: 'Paused while you work here — the job queue above has moved on and these rows have not. '
    + 'They catch up in a moment.',
};

/* Poll requests for a section: rebind jobs to cards every tick, and when a job
 * newly completes, refetch features so the runner's new/updated workspace card shows. */
function startSectionRequestsPoll(kind) {
  let lastDone = new Set();
  startPolling(`section:${kind}`, async (reqs) => {
    if (current.view !== 'section' || current.kind !== kind) return;
    // Jobs relevant to this section: same-kind reviews (including ones with no workspace yet, which
    // is what draws a pending placeholder) + apply jobs targeting a workspace this page draws.
    //
    // That second arm USED to be `r.wsId && wsIds.has(r.wsId)` — a hand-rolled copy of the wsId arm
    // of jobBindsTo, sitting one function outside the guarded zone. It is the exact shape that has
    // shipped wrong twice: the rule grows an arm (prId, and now same-kind), the copy does not, and
    // the two surfaces disagree about which jobs exist. Ask the predicate instead. It answers
    // identically for an `apply` today — the prId arm rejects every non-PR action — so this is one
    // rule where there were two, not a change of behaviour.
    //
    // The kind arm is KIND_ACTIONS now rather than `r.action === kind`: that test is true only
    // because a PR review's action happens to be its workspace kind, and #/spec — whose jobs are
    // `audit`/`re-audit`/`propose` — matched nothing at all under it.
    const known = state.section.features;
    const rel = reqs.filter((r) => actsOnKind(r, kind)
      || (WSID_JOB_ACTIONS.includes(r.action) && known.some((f) => jobBindsTo(r, f))));
    // The manual-refresh pass has no workspace of its own — it drives the Refresh button
    // instead of a card. An unscoped (`kind: null`) poll covers every PR section.
    renderRefreshZone($('#refresh-zone'), kind, pickPollJob(reqs, kind));
    // Count everything queued, not just this section's: the runner drains the whole queue, so
    // promising "run 1 job" while three others go along for the ride would be a lie.
    renderRunnerZone($('.section-actions .runner-zone'), queuedJobs(reqs).length);
    // A finished refresh may have created workspaces or updated activity stamps → refetch.
    const tracked = [...rel, ...reqs.filter((r) => r.action === 'poll' && (!r.kind || r.kind === kind))];
    const doneIds = new Set(tracked.filter((r) => r.status === 'done').map((r) => r.id));
    let newlyDone = false;
    doneIds.forEach((id) => { if (!lastDone.has(id)) newlyDone = true; });
    lastDone = doneIds;
    if (newlyDone) {
      try {
        const fresh = await api(`/api/features?kind=${encodeURIComponent(kind)}`);
        if (Array.isArray(fresh) && current.view === 'section' && current.kind === kind) {
          state.section.features = fresh;
          // The cache the grid draws from has been replaced with new server data — scores, counts,
          // stamps. The signature below must be able to see that even when no band moved, and this
          // is the only place that knows it happened.
          gridPaint.rev++;
        }
      } catch { /* keep cache */ }
    }
    const zone = $('#section-list-zone');
    if (!zone) return;
    // One decision, signed and then drawn. Computing the entries twice would re-read the clock
    // through isStaleJob and let the comparison and the render disagree.
    const entries = sectionEntries(kind, state.section.features, rel);
    const sig = sectionGridSig(entries);
    // A tick that changes nothing must touch nothing — the rule the inbox has had since 316edb0,
    // and the grid had not. Repainting unconditionally was survivable only while the hold was
    // unconditional too; with the busy ceiling above it, the every-4s rebuild became a GUARANTEED
    // tear-down every 12 seconds on a section nobody is changing. Measured on an idle grid with
    // focus parked on a card: 2 focusout / 3 focusin across 40s, and a text selection dying at ~16s.
    // With nothing outstanding there is nothing to hold either, so the clock and the note both go.
    if (sig === gridPaint.sig) {
      gridHold.heldAt = 0;
      clearZoneHeldNote(zone);
      return;
    }
    // Same DOM swap, same hands. This grid draws the same delete-confirm the inbox does and used to
    // rebuild straight over it every four seconds — the hole pruneRowCache's comment names. It
    // stops being merely pre-existing the moment #/spec is polled: that section had no
    // poller at all, so folding its jobs on would have handed it blocker 2 brand new. The same
    // helpers as the inbox, deliberately — two rules for "may I repaint now" is how two surfaces
    // that draw the same confirm come to disagree about whether it survives.
    //
    // No `pending` bookkeeping here, unlike the inbox: a held repaint is not lost, because the
    // signature is recorded only when the paint lands, so the next tick still sees the difference
    // and redraws it. That is the same self-healing property the inbox's `sig` has, and it is what
    // lets this grid skip a tick without a deferred-change flag of its own.
    const hold = zoneHold(zone);
    if (holdStands(hold, gridHold)) { zoneHeldNote(zone, GRID_HELD_NOTE[hold]); return; }
    const mark = hold ? zoneFocusMark(zone) : null;
    gridHold.heldAt = 0;
    // replaceChildren takes the note with everything else — see renderHomeInbox.
    zone.replaceChildren(sectionGrid(kind, entries));
    // Recorded only after the paint landed, for the reason the inbox records its own there: a
    // signature stamped on a tick that skipped would make the skip permanent.
    gridPaint.sig = sig;
    restoreZoneFocus(zone, mark);
  });
}

function summaryReadiness(f) {
  if (f.readiness) return f.readiness;
  // tolerate flattened summaries
  return { score: f.score ?? 0, gate: f.gate ?? 'in-progress', openBySeverity: f.openBySeverity || {} };
}

function sourcesLineText(f) {
  const s = f.sources;
  let c;
  if (s && (Array.isArray(s.confluence) || Array.isArray(s.ado) || Array.isArray(s.figma))) {
    c = { confluence: (s.confluence || []).length, ado: (s.ado || []).length, figma: (s.figma || []).length };
  } else if (f.sourceCounts) {
    c = f.sourceCounts;
  } else if (s && typeof s.confluence === 'number') {
    c = s;
  }
  if (!c) return null;
  const parts = [];
  if (c.confluence) parts.push(plural(c.confluence, 'spec', 'specs'));
  if (c.ado) parts.push(plural(c.ado, 'work item', 'work items'));
  if (c.figma) parts.push(plural(c.figma, 'design', 'designs'));
  return parts.length ? parts.join(' · ') : 'no sources';
}

function lastRoundDate(f) {
  const at = f.lastRoundAt
    || (f.lastRound && f.lastRound.at)
    || (Array.isArray(f.rounds) && f.rounds.length ? f.rounds[f.rounds.length - 1].at : null);
  return fmtDate(at);
}

/* Does this workspace already have review work behind it? Used both to pick the runner's verb
 * ("Reviewing" vs "Re-reviewing") and to band a live job, which is why it isn't inlined in
 * either — two copies of this test would let a card's verb and its band disagree. */
function hasFindingsOf(f) {
  if (!f) return false;   // a pending placeholder has no workspace yet, so nothing can be behind it
  const r = summaryReadiness(f);
  return Boolean((r.openBySeverity && Object.values(r.openBySeverity).some(Boolean))
    || f.lastRoundAt || (f.rounds && f.rounds.length));
}

/* The state pill a row wears: the band table's own label, so the row names the same thing the header
 * above it sorted it by — said in the workspace's own vocabulary (wsStateLabel), because a spec audit
 * is not a re-review. The band class stays keyed off the band, so the tint never moves with the
 * wording. */
function wsStatePill(cat, kind) {
  const meta = wsState(cat);
  return h('span', { class: `chip ws-pill ws-pill-${cssSafe(meta.band)}` }, wsStateLabel(cat, kind));
}

/* The ONE timestamp a compact row earns. Which stamp answers "why is this still here?" depends
 * on the state: a posted review is waiting on the clock since WE posted; anything else parked is
 * waiting since our last round. A row with a job gets none — cardJobRow already says what is
 * happening and how long it has been happening for, and two clocks read as two events. */
function compactStamp(f, job, cat) {
  if (job) return null;
  const s = reviewStampsOf(f);
  if (cat === 'awaiting-author') return stampEl('Posted', s.lastPostedAt);
  return stampEl('Last round', s.lastReviewedAt || f.lastRoundAt || null);
}

/* ============================== UI-triggered job requests ============================== */

/* A request is a job the UI enqueues (POST /api/requests) for the session-side
 * runner skill (/flowlever:watch) to pick up. We poll GET /api/requests on a ~4s
 * cadence while Home or a PR section is open and reflect the status here. */

const REQ_STATUS = {
  queued:  { glyph: '⏳', label: 'Queued' },
  running: { glyph: '⠿', label: 'Running', spin: true },
  done:    { glyph: '✓', label: 'Done' },
  error:   { glyph: '✗', label: 'Error' },
};
const REQ_ACTION_LABEL = { 'pr-review': 'PR review', 'pr-respond': 'PR respond', apply: 'Post to PR', 're-audit': 'Re-audit', audit: 'Spec analysis', propose: 'Draft changes', poll: 'Refresh', summarize: 'Summary' };

/* ---- live job ↔ card binding ----------------------------------------------
 * Instead of a separate "jobs" strip duplicating the cards, the active request
 * for a workspace is folded onto its card (and a brand-new review with no
 * workspace yet gets its own "pending" row). These helpers correlate them. */

// A job worth surfacing on a row: still in flight, blocked on the user, or failed.
// `done` jobs are not shown — the finished workspace row speaks for itself.
function isLiveJob(r) {
  return r.status === 'queued' || r.status === 'running' || r.status === 'error' || !!r.needsInput;
}

/* A queued job only moves when a /flowlever:watch runner is draining the queue. With no session
 * running, "· queued" is technically true but reads as "in progress" forever — which is the exact
 * trap that makes a Post look like it happened. Past this age we say what's really going on:
 * nobody is running it. Generous enough that a normal ~4s pickup never trips it. */
const JOB_STALE_MS = 3 * 60 * 1000;

function jobAgeMs(r) {
  const t = Date.parse(r.updatedAt || r.createdAt);
  return Number.isNaN(t) ? 0 : Date.now() - t;
}
/* Stale = waiting (or claiming to work) for longer than any real pickup takes, and not blocked on
 * the user (needsInput has its own, clearer banner). A `running` job that goes quiet this long has
 * almost certainly lost its session mid-flight.
 * A live runner clears the whole condition: the job isn't abandoned, it's waiting its turn in a
 * queue that is actively being drained — calling that "not running" would be the opposite lie. */
function isStaleJob(r) {
  if (r.needsInput) return false;
  if (r.status !== 'queued' && r.status !== 'running') return false;
  if (runnerBusy()) return false;
  return jobAgeMs(r) > JOB_STALE_MS;
}
/* Compact age for the stale note: "4m", "2h", "3d". */
function fmtAge(ms) {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}
// Higher = more urgent, so a card shows the most important job when several match.
// A stalled job outranks a live one: it's the one that needs a human to unstick it.
function jobRank(r) {
  if (r.needsInput && r.status !== 'done' && r.status !== 'error') return 4;
  if (r.status === 'error') return 3;
  if (isStaleJob(r)) return 3;
  if (r.status === 'running') return 2;
  return 1; // queued
}
/* Does this job act on this workspace? An apply/re-run naming its id, or a pr-review/pr-respond for
 * the same PR number — a job may arrive with EITHER, which is why both arms are here and not split.
 * The "+ New PR review" dialog enqueues { action, prId, title } with no wsId at all, so the prId arm
 * is the ordinary path for anything started from the UI, not an edge case.
 *
 * ONE predicate, called from both sides of the card/placeholder decision, because those two are the
 * same question asked twice: jobForFeature() asks "which job do I fold onto this card", sectionGrid
 * asks "does this job already have a card to be folded onto". Spelled out separately they drift, and
 * the drift is not cosmetic — a filter that inspected only wsId let a wsId-less job bind to a card by
 * prId and STILL draw a placeholder beside it, so one PR appeared twice under a band header counting
 * more workspaces than the band held. Whatever binding learns next (a repo, a branch, a second id
 * shape) it learns here, once, and both callers learn it at the same moment. */
function jobBindsTo(job, f) {
  if (!job || !f) return false;
  // The wsId arm is an exact id match, so it is deliberately kind-agnostic: an `apply` on a spec
  // workspace names that workspace and nothing else can answer to it.
  if (job.wsId && job.wsId === f.id) return true;
  if (job.action !== 'pr-review' && job.action !== 'pr-respond') return false;
  // The job being PR-shaped is only half the question — the WORKSPACE has to be the SAME shape,
  // not merely a PR one. Two things break without the equality:
  //
  // prNumber() falls back to "any digit run in the id" for any workspace at all, so with no kind
  // gate at all a pr-review of PR 7001 binds `spec-7001-checkout`: that spec row drew "Re-reviewing"
  // and was banded into "In progress" by a runner that has never heard of it. And a gate that only
  // asks "is this workspace a PR kind" still crosses the two PR kinds, which is the subtler loss:
  // ONE pull request can carry both a `pr-review` workspace (you reviewing it) and a `pr-respond`
  // one (you answering its reviewers), and they are different work on different findings. Binding
  // across them puts the wrong verb on the wrong row — "Re-reviewing" on the workspace where you
  // are replying to reviewer threads — and lets one job claim two cards, which is a band count
  // naming more workspaces than the band holds.
  //
  // A job's action IS the kind of workspace it acts on, so equality is the whole rule.
  if (job.action !== f.kind) return false;
  const pr = prNumber(f);
  return !!(job.prId && pr && String(job.prId) === String(pr));
}

// The live job acting on this workspace. Most-urgent wins.
function jobForFeature(f, jobs) {
  const mine = jobs.filter((r) => jobBindsTo(r, f));
  return mine.sort((a, b) => jobRank(b) - jobRank(a))[0] || null;
}
/* Where an `apply` is writing, per kind. One action, three destinations — the same split
 * JOB_LABELS_BY_KIND makes for the pill above it, and the reason it cannot be one sentence: an
 * apply on a spec writes the accepted proposals back to Confluence and ADO and has no pull request
 * anywhere near it, so "Posting to PR" named something that does not exist. An unknown kind keeps
 * the PR wording, which is what every caller that could not name a kind meant before. */
const APPLY_VERB = {
  spec: 'Applying to the spec',
  'pr-review': 'Posting to PR',
  'pr-respond': 'Posting replies',
};

/* What the runner is doing, in card language. `existing` ⇒ a re-run on a workspace that already has
 * findings (re-review) rather than a first pass. `kind` is the workspace's, because the words differ
 * by kind wherever the action is shared — and the audit verbs split on `existing` exactly as the PR
 * ones do, so the job line and the state pill above it can never disagree about first-pass vs re-run
 * (both read hasFindingsOf). */
function jobVerb(job, existing, kind) {
  if (job.action === 'apply') return APPLY_VERB[kind] || APPLY_VERB['pr-review'];
  if (job.action === 'poll') return 'Checking for updates';
  if (job.action === 'pr-review') return existing ? 'Re-reviewing' : 'Reviewing';
  if (job.action === 'pr-respond') return existing ? 'Re-checking threads' : 'Responding';
  if (job.action === 'audit') return existing ? 'Re-auditing' : 'Auditing';
  if (job.action === 're-audit') return 'Re-auditing';
  if (job.action === 'propose') return 'Drafting changes';
  return REQ_ACTION_LABEL[job.action] || job.action;
}

// The status line shown on a busy row: spinner + verb + live phase, an amber
// "needs your input" note, or a red error note (with a dismiss).
function cardJobRow(job, existing, kind) {
  const meta = REQ_STATUS[job.status] || REQ_STATUS.queued;
  const needsInput = !!job.needsInput && job.status !== 'done' && job.status !== 'error';
  const stale = isStaleJob(job);
  const verb = jobVerb(job, existing, kind);
  const phase = job.status === 'running' && job.phase ? ` · ${job.phase}` : '';
  const stateClass = needsInput ? 'needs' : (stale ? 'stale' : job.status);
  // A stale job must not keep spinning — a spinner on something nobody is running is the lie.
  const spin = (meta.spin || needsInput) && !stale;
  const rows = [
    h('div', { class: 'fc-job-line' },
      h('span', { class: `req-glyph req-glyph-${cssSafe(needsInput ? 'running' : (stale ? 'stalled' : job.status))} ${spin ? 'req-spin' : ''}`.trim() },
        stale ? '⏸' : (needsInput ? REQ_STATUS.running.glyph : meta.glyph)),
      h('span', { class: 'fc-job-verb' },
        needsInput || stale ? verb : verb + (job.status === 'queued' ? ' · queued' : phase))),
  ];
  if (needsInput) {
    rows.push(h('div', { class: 'fc-job-needs', role: 'alert' },
      h('span', { 'aria-hidden': 'true' }, '⚠ '), job.note || 'Waiting on you to continue.'));
  } else if (stale) {
    // Say the true thing: this is not in progress, it is waiting for a runner that isn't there.
    rows.push(h('div', { class: 'fc-job-stale' },
      `Not running — ${job.status === 'queued' ? 'queued' : 'started'} ${fmtAge(jobAgeMs(job))} ago with no runner picking it up. `,
      h('strong', {}, 'Nothing has been posted.'),
      ' Start ', h('code', {}, '/flowlever:watch'), ' in Claude Code, or cancel below.'));
  } else if (job.status === 'error' && job.note) {
    rows.push(h('div', { class: 'fc-job-err' }, job.note));
  }
  // A failed job is dismissible; a stale one is cancellable (which also releases the findings it
  // stranded in the Posting…/Applying… lane). A genuinely-running job stays untouched.
  let action = null;
  if (stale) {
    action = h('button', {
      class: 'btn-icon fc-job-dismiss', type: 'button',
      title: 'Cancel this job and put its findings back in the review queue',
      'aria-label': 'Cancel stalled job',
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); cancelStalledJob(job); },
    }, '×');
  } else if (job.status === 'error') {
    action = h('button', {
      class: 'btn-icon fc-job-dismiss', type: 'button', title: 'Dismiss this failed job',
      'aria-label': 'Dismiss failed job',
      onclick: async (e) => {
        e.preventDefault(); e.stopPropagation();
        // A failed apply leaves findings stranded in the in-flight lane too — release them.
        cancelStalledJob(job);
      } }, '×');
  }
  return h('div', { class: `fc-job fc-job-${cssSafe(stateClass)}` }, h('div', { class: 'fc-job-body' }, rows), action);
}

/* Drop a job that will never finish and release whatever it stranded. For a post/apply that means
 * clearing the findings' in-flight markers so they return to the review queue — otherwise the
 * workspace is stuck reading "Posting…" with nothing on the PR. Nothing is claimed as posted. */
async function cancelStalledJob(job) {
  const isWrite = job.action === 'apply';
  try {
    if (isWrite && job.wsId) {
      const res = await api(`/api/features/${encodeURIComponent(job.wsId)}/review/cancel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: job.id, reason: 'cancelled from the cockpit — job never ran' }),
      });
      toast(res.cancelled
        ? `Cancelled — ${plural(res.cancelled, 'item', 'items')} back in the review queue. Nothing was posted.`
        : 'Job cancelled. Nothing was posted.', 'success');
    } else {
      await api(`/api/requests/${encodeURIComponent(job.id)}`, { method: 'DELETE' });
      toast('Job cancelled', 'success');
    }
    if (current.view === 'detail' && current.id === job.wsId) {
      await loadDetail(current.id, true);
      rerenderDetail();
    }
    pollRequestsNow();
  } catch (e) {
    toast(`Could not cancel: ${e.message}`);
  }
}

// The post-posting wait state on a settled card (no job running): a passive "Waiting on
// author" line, or a highlighted "Author responded" once the runner detected a reply/commit.
function cardReviewRow(f) {
  const s = reviewStampsOf(f);
  if (f.authorResponded || s.newSinceReview) {
    // Name WHEN they responded (their real update time), not when we happened to notice.
    const when = fmtAgo(s.lastActivityAt);
    return h('div', { class: 'fc-review fc-review-responded' },
      h('span', { class: 'fc-review-dot' }, '●'),
      h('span', {},
        when ? `Author responded ${when}` : 'Author responded',
        f.reviewNote ? h('span', { class: 'meta-dim' }, ` — ${f.reviewNote}`) : null,
        ' · re-review'));
  }
  const since = fmtAgo(s.lastPostedAt);
  return h('div', { class: 'fc-review fc-review-waiting' },
    since ? `⏳ Waiting on author — posted ${since}` : '⏳ Waiting on author');
}

/* A workspace doesn't exist yet (a first review still running): show a placeholder row so the work
 * is visible exactly where its real row will land.
 *
 * Same row shape as a real workspace, and deliberately NOT workspaceRow itself: there is no
 * workspace here, so every argument that renderer takes — id, title, status, readiness, counts,
 * kind — would have to be invented, and inventing a workspace to draw one is exactly the fake data
 * this cockpit refuses. What it shares instead is the SHAPE (the `inbox-row` classes) and the job
 * line, so the two read as the same list; the dashed border is what says "not a workspace yet", and
 * it is the only thing here that is not a real row.
 *
 * `density` is the band's, like every other row's. A placeholder that ignored it sat at full
 * height among one-line compact rows, which breaks the only promise a compact band makes — that
 * everything under this header is a glance, not a read. What the compact form drops is what the
 * dial and the instructions line were already only guessing at: there is no workspace to score. */
function pendingJobRow(job, density = 'full', kind = null) {
  const title = pendingJobTitle(job);
  const compact = density === 'compact';
  // The instructions ARE the title when nothing else named the job, and printing them twice on one
  // row says the same sentence twice under itself.
  const showInstr = !compact && job.instructions && job.instructions !== title;
  return h('div', { class: `inbox-row ir-pending${compact ? ' ir-compact' : ''}` },
    // Where the real rows beside it carry their dial, so a pending row lines up with them instead
    // of shifting the whole list left by 44px when the workspace appears.
    compact ? null : h('div', { class: 'ir-pending-dial', 'aria-hidden': 'true' }, '—'),
    h('div', { class: 'ir-main' },
      h('div', { class: 'ir-top' }, h('span', { class: 'ir-title' }, title)),
      h('div', { class: 'ir-needs' }, h('span', { class: 'chip status-auditing' }, 'starting…')),
      // The section's kind, not the workspace's — there is no workspace. It is the right answer
      // anyway: a placeholder is only ever drawn in the section whose actions admitted the job
      // (actsOnKind), so the job's vocabulary and the page's are the same by construction.
      cardJobRow(job, false, kind),
      showInstr ? h('div', { class: 'ir-meta' }, h('span', { class: 'meta-dim' }, '↳ ', job.instructions)) : null));
}

/* What a placeholder calls itself, and — because a nameless card is worse than none — whether it may
 * exist at all (sectionEntries filters on this).
 *
 * A placeholder has no workspace to take a name from, so it needs one of its own. A PR job has the
 * number; a spec `audit` enqueued from "+ New spec analysis" has a title only if the user typed one,
 * and otherwise has the URLs/focus it was queued with, which is precisely what identifies the work
 * to the person who queued it. Null ⇒ nothing to call it, and no card. */
function pendingJobTitle(job) {
  if (job.title) return job.title;
  if (job.prId) return `PR ${job.prId}`;
  // `instructions` is a textarea — source URLs one per line, plus any focus note. The first non-
  // empty line is what identifies the run; the whole of it still prints on the card's meta line
  // below, so nothing is lost by taking one line for the heading.
  return String(job.instructions || '').split('\n').map((s) => s.trim()).find(Boolean) || null;
}

/* One shared requests poll. `scope` lets a re-render (e.g. the finish screen) reuse the running
 * registration instead of resetting it; `token` invalidates in-flight fetches after stopPolling so
 * a late response can't clobber a newer view.
 *
 * There is deliberately NO timer in here. The app's single interval is appTick() below, started
 * once at boot and never torn down, and startPolling/stopPolling only register/unregister which
 * callback that ticker feeds. When the heartbeat rode a timer owned by this poller, an outage
 * killed the very thing meant to report it: route() calls stopPolling() before rendering and every
 * view re-arms the poller only at the END of its async render, after an `await api(...)` that
 * throws while the server is down. So a cold load with the server down left no timer at all
 * (failure count stuck at 1, no banner, for the life of the tab), navigating during an outage
 * froze the count so the banner could neither trip nor clear when the server came back, and the
 * views with no poller of their own — the guide, and the review stepper, the one surface holding
 * unposted decisions — could never raise it at all. */
const poller = { token: 0, scope: null, fn: null };

function stopPolling() {
  poller.fn = null;
  poller.scope = null;
  poller.token++;
}

function startPolling(scope, fn) {
  if (poller.scope === scope && poller.fn) { poller.fn = fn; return; }
  stopPolling();
  poller.scope = scope;
  poller.fn = fn;
  // Poll once immediately so a freshly rendered view doesn't sit a whole tick behind the queue.
  pollRequestsTick(poller.token);
}

/* The per-view half of a tick: the requests queue plus the runner's liveness, handed to whichever
 * view is registered right now. Re-checks the token at every await boundary, because a navigation
 * mid-flight must not let a stale view's callback paint over the new one. */
async function pollRequestsTick(token) {
  if (token !== poller.token || !poller.fn) return;
  let reqs;
  // A failed /api/requests is transient here — keep the last view rather than blanking it. It is
  // no longer the heartbeat's problem either: appTick() has already run checkHeartbeat() before
  // calling this, so "the server is gone" is reported by the heartbeat, not inferred from here.
  try { reqs = await api('/api/requests'); } catch { return; }
  if (token !== poller.token || !poller.fn) return;
  // The runner's liveness rides the same tick: every surface that shows a job also wants to know
  // whether anything is draining it, and one extra tiny GET beats a second interval.
  await refreshRunner();
  if (token !== poller.token || !poller.fn) return;
  poller.fn(Array.isArray(reqs) ? reqs : []);
  renderRunnerZones();
}

/* The app's one and only ticker body (see the single setInterval at the bottom of the file). Order
 * matters: the heartbeat runs FIRST and UNCONDITIONALLY, on every tick, no matter what any view is
 * or isn't doing, because the failure it detects — the server not answering — is precisely the
 * condition under which every view-owned mechanism stops running. Only then does the currently
 * registered view get its requests poll. Both halves are guarded so a throw in one cannot stop the
 * timer the whole app now depends on. */
async function appTick() {
  try { await checkHeartbeat(); } catch { /* a bug in the heartbeat must not kill the only timer */ }
  try { await pollRequestsTick(poller.token); } catch { /* nor may a bug in a view's callback */ }
}

/* Force an out-of-band refresh right after an enqueue, so the queued row shows
 * without waiting for the next interval. */
function pollRequestsNow() {
  const token = poller.token;
  if (!poller.fn) return;
  api('/api/requests')
    .then((reqs) => { if (token === poller.token && poller.fn) poller.fn(Array.isArray(reqs) ? reqs : []); })
    .catch(() => {});
}

function requestTarget(r) {
  if (r.prId) return `PR ${r.prId}`;
  if (r.wsId) return r.wsId;
  // A refresh (`poll`) has no single target — name the section it covers, or "all PRs".
  if (r.action === 'poll') return r.kind ? kindMeta(r.kind).label : 'all PRs';
  return '';
}

/* A single request row: status glyph (spinner while running), action + target,
 * optional title, the live phase while running, and a note (errors) / workspace
 * link (done). When the job is blocked waiting on the user (needsInput) it grows a
 * prominent amber "needs your input" banner carrying the instruction (note). All
 * text escaped. */
function requestRow(r, onRow = false) {
  const meta = REQ_STATUS[r.status] || REQ_STATUS.queued;
  const target = requestTarget(r);
  const linkable = r.status === 'done' && r.wsId;
  const needsInput = !!r.needsInput && (r.status === 'queued' || r.status === 'running');
  const stale = isStaleJob(r);
  // While running, show the live phase next to the state, e.g. "Running · reviewing changes".
  const phaseText = r.status === 'running' && r.phase ? ` · ${r.phase}` : '';
  // The note doubles as the needs-input instruction; when the banner shows it, don't
  // repeat it in the sub line. Otherwise it's an error/progress note.
  const showSubNote = r.note && !needsInput;

  const main = h('div', { class: 'req-main' },
    h('div', { class: 'req-top' },
      h('span', { class: 'req-action' }, REQ_ACTION_LABEL[r.action] || r.action),
      target ? h('span', { class: 'req-target num-line' }, target) : null,
      r.title ? h('span', { class: 'req-title' }, r.title) : null,
      // Not "this is a duplicate" — it is a SECOND job on a PR that is already listed, and saying
      // so is what stops the two entries reading as two PRs.
      onRow ? h('span', {
        class: 'req-onrow',
        title: 'This PR already has a row below — this is a second job on it',
      }, 'also on a row below') : null),
    h('div', { class: 'req-sub meta-dim' },
      h('span', { class: `req-statetext req-state-${cssSafe(stale ? 'stalled' : r.status)}` },
        stale ? `Not running · ${meta.label.toLowerCase()} ${fmtAge(jobAgeMs(r))} ago` : meta.label + phaseText),
      showSubNote ? h('span', { class: 'req-note' }, ` — ${r.note}`) : null,
      linkable ? h('a', { class: 'req-open', href: `#/feature/${encodeURIComponent(r.wsId)}` }, 'open workspace →') : null),
    // The per-run scope/focus the runner will honor, shown as a small muted line.
    r.instructions ? h('div', { class: 'req-instr', title: 'Review scope for this run' }, '↳ ', r.instructions) : null,
    needsInput
      ? h('div', { class: 'req-needsinput', role: 'alert' },
          h('span', { class: 'req-ni-icon', 'aria-hidden': 'true' }, '⚠'),
          h('div', { class: 'req-ni-body' },
            h('span', { class: 'req-ni-label' }, 'Needs your input'),
            h('span', { class: 'req-ni-note' }, r.note || 'Waiting on you to continue.')))
      : null,
    // No runner is draining the queue — say so, rather than spinning indefinitely.
    stale
      ? h('div', { class: 'req-stalled' },
          h('span', { class: 'req-stalled-icon', 'aria-hidden': 'true' }, '⏸'),
          h('div', { class: 'req-stalled-body' },
            h('span', { class: 'req-stalled-label' }, 'No runner picked this up'),
            h('span', { class: 'req-stalled-note' },
              r.action === 'apply'
                ? 'Nothing has been posted. Start /flowlever:watch in Claude Code, or dismiss to put the items back in the review queue.'
                : 'Start /flowlever:watch in Claude Code to run it, or dismiss it.')))
      : null);
  const row = h('div', { class: `req-row req-${cssSafe(r.status)} ${needsInput ? 'req-needs' : ''} ${stale ? 'req-stale' : ''}`.trim() },
    h('span', { class: `req-glyph req-glyph-${cssSafe(stale ? 'stalled' : r.status)} ${meta.spin && !stale ? 'req-spin' : ''}`.trim(),
      'aria-label': stale ? 'not running' : meta.label }, stale ? '⏸' : meta.glyph),
    main,
    h('button', {
      class: 'btn-icon req-dismiss', type: 'button',
      'aria-label': 'Dismiss job', title: stale || r.status === 'error'
        ? 'Dismiss this job (its items go back to the review queue)'
        : 'Dismiss this job',
      onclick: async () => {
        // Dismissing a post/apply must also release the findings it stranded in the in-flight
        // lane, or the workspace keeps reading "Posting…" with no job behind it.
        if (r.action === 'apply' && r.wsId) { await cancelStalledJob(r); return; }
        try {
          await api(`/api/requests/${encodeURIComponent(r.id)}`, { method: 'DELETE' });
          row.remove();
        } catch (e) {
          toast(`Dismiss failed: ${e.message}`);
        }
      },
    }, '×'));
  return row;
}

/* Compact status legend shown above a requests strip so the meanings of
 * Queued / Running / Done / Error (and the needs-input flag) are clear. */
function requestsLegend() {
  const item = (cls, glyph, label, desc) => h('span', { class: 'reqleg-item', title: `${label} — ${desc}` },
    h('span', { class: `reqleg-glyph req-glyph-${cls}` }, glyph),
    h('span', { class: 'reqleg-label' }, label),
    h('span', { class: 'reqleg-desc' }, desc));
  return h('details', { class: 'requests-legend' },
    h('summary', {}, h('span', { class: 'reqleg-q', 'aria-hidden': 'true' }, '?'), 'What do these statuses mean?'),
    h('div', { class: 'reqleg-grid' },
      item('queued', REQ_STATUS.queued.glyph, 'Queued', 'waiting for the runner to pick it up'),
      item('running', REQ_STATUS.running.glyph, 'Running', 'being processed (shows the live phase)'),
      item('done', REQ_STATUS.done.glyph, 'Done', 'finished — workspace ready'),
      item('error', REQ_STATUS.error.glyph, 'Error', 'failed (shows why)'),
      h('span', { class: 'reqleg-item' },
        h('span', { class: 'reqleg-glyph reqleg-ni' }, '⚠'),
        h('span', { class: 'reqleg-label' }, 'Needs your input'),
        h('span', { class: 'reqleg-desc' }, 'blocked on you — e.g. approve a 2FA/auth prompt')),
      h('span', { class: 'reqleg-item' },
        h('span', { class: 'reqleg-glyph req-glyph-stalled' }, '⏸'),
        h('span', { class: 'reqleg-label' }, 'Not running'),
        h('span', { class: 'reqleg-desc' }, 'queued but no runner picked it up — start /flowlever:watch'))));
}

function requestsStripEl(requests, emptyText) {
  const strip = h('div', { class: 'requests-strip', id: 'requests-strip' });
  populateRequestsStrip(strip, requests, emptyText);
  return strip;
}

/* `opts.note` is the jobs this strip is NOT listing, and `opts.onRow(r)` says whether an entry's
 * workspace is already on the page below. Both exist because a strip that only counts itself lets
 * one screen state two different totals for one queue. Optional: the views that show the whole
 * queue (nothing folded away) pass neither and read exactly as they did. */
function populateRequestsStrip(strip, requests, emptyText, opts) {
  if (!strip) return;
  const o = opts || {};
  if (!requests.length) {
    if (emptyText) strip.replaceChildren(h('p', { class: 'meta-dim requests-empty' }, emptyText));
    else strip.replaceChildren();
    return;
  }
  const onRow = o.onRow || (() => false);
  // Jobs blocked on the user first, then errors/running/queued (stable within a rank).
  const ordered = [...requests].sort((a, b) => jobRank(b) - jobRank(a));
  strip.replaceChildren(
    h('div', { class: 'requests-head' },
      h('span', { class: 'f-suglabel' }, plural(requests.length, 'job', 'jobs')),
      o.note ? h('span', { class: 'requests-head-note meta-dim' }, o.note) : null,
      requestsLegend()),
    h('div', { class: 'requests-list' }, ordered.map((r) => requestRow(r, onRow(r)))));
}

/* ---- runner control (the "▶ Run queued jobs" button) ------------------------
 * A queued job only moves when a Claude Code session runs /flowlever:watch. The cockpit server is
 * a local process, so it can start that session for us — which is the difference between "your
 * Post is queued forever" and "your Post happens now". `state.runner` is the last known status;
 * the shared requests poller refreshes it, so every surface agrees. */
function runnerStatus() { return state.runner || null; }
function runnerBusy() { const r = runnerStatus(); return !!r && r.running; }

async function refreshRunner(withLog = false) {
  try {
    state.runner = await api(`/api/runner${withLog ? '?log=1' : ''}`);
  } catch { /* server hiccup — keep the last known status */ }
  return state.runner;
}

/* Jobs the runner would actually pick up right now. Drives the button's count + whether it shows:
 * offering "run 0 jobs" is noise, and hiding it while work is stuck is the bug we're fixing. */
function queuedJobs(reqs) {
  return (reqs || []).filter((r) => r.status === 'queued' || r.status === 'running');
}

/* Start the runner. `action` is 'watch' (drain what's queued) or 'poll' (discover, then drain). */
async function startRunner(action = 'watch', { silent = false } = {}) {
  try {
    state.runner = await api('/api/runner', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    if (!silent) {
      toast(action === 'poll'
        ? 'Runner started — discovering PRs, then draining the queue'
        : 'Runner started — working through the queued jobs now', 'success');
    }
    pollRequestsNow();
    renderRunnerZones();
  } catch (e) {
    // 503 = no `claude` binary; 409 = already going. Both are worth saying plainly.
    toast(`Could not start the runner: ${e.message}`);
    await refreshRunner();
    renderRunnerZones();
  }
}

async function stopRunner() {
  try {
    state.runner = await api('/api/runner', { method: 'DELETE' });
    toast('Runner stopped', 'success');
  } catch (e) {
    toast(`Could not stop the runner: ${e.message}`);
  }
  renderRunnerZones();
}

/* Re-render every runner control currently on the page (there may be one in the section header and
 * one inside a stalled banner). Cheap: they're tiny and keyed by class. */
function renderRunnerZones() {
  document.querySelectorAll('.runner-zone').forEach((zone) => {
    renderRunnerZone(zone, Number(zone.dataset.queued || 0), zone.dataset.label || '');
  });
}

/* `label` overrides the "Run N jobs" wording — used where the count would mislead (the stalled
 * banner talks about one job, but the runner always drains the whole queue). */
function runnerZone(queuedCount, label = '') {
  const zone = h('div', { class: 'runner-zone', dataset: { queued: String(queuedCount || 0), label } });
  renderRunnerZone(zone, queuedCount, label);
  return zone;
}

/* The button, in four honest states: running (with a stop), idle-with-work ("Run N jobs"),
 * unavailable (say why — a missing CLI must not look like a broken button), idle-with-nothing
 * (render nothing at all). */
function renderRunnerZone(zone, queuedCount, label = '') {
  if (!zone) return;
  const r = runnerStatus();
  zone.dataset.queued = String(queuedCount || 0);
  if (label) zone.dataset.label = label;
  // A runner is the one control that leaves this machine — it spawns a session that posts to real
  // pull requests, which is why read-only refuses it in src/runner.js too. Say so instead of
  // offering a button whose only outcome is a 403: a queue that cannot be drained is a fact about
  // the mode, not a failure worth a retry affordance.
  if (readOnlyMode()) {
    // Spread an array rather than passing the empty case straight through: replaceChildren() is a
    // DOM method, not h(), so it does NOT drop a null child — it stringifies it, and an empty queue
    // in read-only mode printed the word "null" next to the Refresh button.
    zone.replaceChildren(...(queuedCount
      ? [h('span', { class: 'runner-unavailable', title: READ_ONLY_TITLE },
          `🔒 ${plural(queuedCount, 'job', 'jobs')} queued — read-only mode will not run them`)]
      : []));
    return;
  }
  if (!r) { zone.replaceChildren(); return; }

  if (r.running) {
    zone.replaceChildren(
      h('span', { class: 'runner-live', title: `Started ${fmtDateTime(r.startedAt) || 'just now'} · pid ${r.pid}` },
        h('span', { class: 'spinner', 'aria-hidden': 'true' }),
        'Runner working…'),
      h('button', {
        class: 'btn btn-runner-stop', type: 'button',
        title: 'Stop the runner (it finishes the write it is in the middle of)',
        onclick: stopRunner,
      }, '■ Stop'));
    return;
  }
  if (!queuedCount) { zone.replaceChildren(); return; }
  if (!r.available) {
    zone.replaceChildren(h('span', { class: 'runner-unavailable', title: r.reason || '' },
      '⚠ Can’t start the runner from here — ', h('code', {}, '/flowlever:watch'), ' in Claude Code instead'));
    return;
  }
  // Two-click confirm: this posts to real pull requests. The user already approved the content when
  // they clicked Post; this confirms they want it to go out NOW.
  const showConfirm = () => zone.replaceChildren(
    h('span', { class: 'runner-confirm-msg' },
      'Run the queued jobs now? Approved comments get posted to Azure DevOps.'),
    h('button', { class: 'btn btn-accent', type: 'button', onclick: () => startRunner('watch') }, '▶ Run now'),
    h('button', { class: 'btn', type: 'button', onclick: () => renderRunnerZone(zone, queuedCount, label) }, 'Cancel'));
  zone.replaceChildren(h('button', {
    class: 'btn btn-runner', type: 'button',
    title: 'Start a headless /flowlever:watch session that works through the queued jobs now',
    onclick: showConfirm,
  }, label
    ? label
    : ['▶ Run ', h('span', { class: 'runner-n' }, String(queuedCount)), queuedCount === 1 ? ' job' : ' jobs']));
}

/* ---- manual refresh (the "↻ Refresh" button) --------------------------------
 * The scheduled /flowlever:poll pass runs every couple of hours. When you already KNOW a new
 * PR landed or a reviewer just commented, this enqueues a `poll` request so the runner does a
 * discovery pass NOW: find PRs you haven't got a workspace for, and re-check the known ones for
 * counterpart updates (which is what stamps `review.lastActivityAt`). Read-only — like the
 * scheduled pass it never posts to a PR. */
/* `kind` null = refresh BOTH PR sections (used on Home); otherwise scoped to one. */
function refreshZone(kind) {
  const zone = h('div', { class: 'refresh-zone', id: 'refresh-zone' });
  renderRefreshZone(zone, kind, null);
  return zone;
}

function refreshScopeLabel(kind) {
  return kind ? kindMeta(kind).label : 'PR review + PR respond';
}

/* Reflects the live `poll` job so the button itself is the progress indicator:
 * idle → "↻ Refresh", queued/running → spinner + live phase, error → the reason + retry. */
function renderRefreshZone(zone, kind, job) {
  if (!zone) return;
  const label = refreshScopeLabel(kind);
  const busy = !!job && (job.status === 'queued' || job.status === 'running');
  const failed = !!job && job.status === 'error';
  const btn = h('button', {
    class: `btn btn-refresh ${busy ? 'is-busy' : ''} ${failed ? 'is-error' : ''}`.trim(),
    type: 'button',
    // Refresh enqueues a poll job, which is a write to the request queue — and in read-only mode
    // nothing would ever drain it, so the button would only manufacture a queue it cannot clear.
    disabled: readOnlyMode() || busy || undefined,
    title: readOnlyMode() ? READ_ONLY_TITLE : busy
      ? 'A refresh pass is already in flight'
      : `Check Azure DevOps now for new ${label} PRs and updated comments — instead of waiting for the scheduled poll`,
    onclick: () => enqueueRefresh(kind),
  }, busy
    ? [h('span', { class: 'spinner', 'aria-hidden': 'true' }),
       job.status === 'queued' ? 'Refresh queued…' : (job.phase || 'Checking…')]
    : (failed ? '↻ Retry refresh' : '↻ Refresh'));
  const kids = [btn];
  if (busy && job.needsInput) {
    kids.push(h('span', { class: 'refresh-note refresh-needs', role: 'alert' },
      '⚠ ', job.note || 'Waiting on you — approve the auth prompt in your other window.'));
  } else if (failed && job.note) {
    kids.push(h('span', { class: 'refresh-note refresh-err' }, job.note));
  }
  zone.replaceChildren(...kids);
}

/* Which `poll` job the Refresh button reflects. In-flight beats failed on purpose: after a retry
 * the button must read "queued…", not keep showing the old error (which is what ranking by
 * urgency would do). Newest wins within each group. */
function pickPollJob(reqs, kind) {
  const mine = (reqs || []).filter((r) => r.action === 'poll' && (!r.kind || r.kind === kind || !kind));
  const newest = (list) => list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null;
  return newest(mine.filter((r) => r.status === 'queued' || r.status === 'running'))
      || newest(mine.filter((r) => r.status === 'error'));
}

async function enqueueRefresh(kind) {
  const label = refreshScopeLabel(kind);
  try {
    const res = await api('/api/requests', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // dedupe: a double-click (or a pass already in flight for this scope) must not fan out
      // two runs. `kind: null` is an explicit "both sections" scope, not "any scope".
      body: JSON.stringify({ action: 'poll', kind: kind || null, dedupe: true, title: `Refresh ${label}` }),
    });
    // A refresh only does something once a runner picks it up. If none is going, start one right
    // away instead of quietly queueing work nobody will do — the button says "Refresh", so refresh.
    const r = await refreshRunner();
    if (r && r.available && !r.running) {
      await startRunner('poll', { silent: true });
      toast('Refreshing — the runner is checking ADO for new and updated PRs', 'success');
    } else {
      toast(res && res.deduped
        ? 'A refresh is already in flight'
        : (r && r.running
          ? 'Refresh queued — the running session will pick it up'
          : 'Refresh queued — run /flowlever:watch in Claude Code to execute it'), 'success');
    }
    pollRequestsNow();
  } catch (e) {
    toast(`Could not queue the refresh: ${e.message}`);
  }
}

/* The "+ New PR review/respond" entry: a button that swaps in an inline form
 * (PR id + optional title) and POSTs a request, then resets. */
function newRequestZone(kind) {
  const actionLabel = REQ_ACTION_LABEL[kind] || kind;
  const zone = h('div', { class: 'new-request-zone', id: 'new-request-zone' });
  const showButton = () => zone.replaceChildren(h('button', {
    class: 'btn btn-accent nr-add', type: 'button', onclick: showForm,
  }, `+ New ${actionLabel}`));
  function showForm() {
    zone.replaceChildren(newRequestForm(kind, showButton));
    const inp = zone.querySelector('.nr-prid');
    if (inp) requestAnimationFrame(() => inp.focus());
  }
  showButton();
  return zone;
}

function newRequestForm(kind, onClose) {
  const actionLabel = REQ_ACTION_LABEL[kind] || kind;
  const prInput = h('input', {
    class: 'nr-prid', type: 'text', placeholder: 'PR id (e.g. 1481)', 'aria-label': 'PR id',
    onkeydown: (e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onClose(); },
  });
  const titleInput = h('input', {
    class: 'nr-title', type: 'text', placeholder: 'Title (optional)', 'aria-label': 'Title',
    onkeydown: (e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onClose(); },
  });
  // Optional per-run scope/focus passed straight to the runner (e.g. "front-end only").
  // Enter inserts a newline here (it's a textarea); only Escape closes the form.
  const instrInput = h('textarea', {
    class: 'nr-instructions', rows: '2', 'aria-label': 'Review instructions (optional)',
    placeholder: "Scope or focus for this review — e.g. 'front-end only', 'back-end only', 'focus on the import validation'",
    onkeydown: (e) => { if (e.key === 'Escape') onClose(); },
  });
  async function submit() {
    const prId = prInput.value.trim();
    if (!prId) { prInput.classList.add('invalid'); prInput.focus(); return; }
    try {
      await api('/api/requests', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: kind, prId,
          title: titleInput.value.trim() || undefined,
          instructions: instrInput.value.trim() || undefined,
        }),
      });
      toast(`Queued ${actionLabel} for PR ${prId}`, 'success');
      onClose();
      pollRequestsNow();
    } catch (e) {
      toast(`Could not queue: ${e.message}`);
    }
  }
  return h('div', { class: 'nr-form' },
    h('div', { class: 'nr-row' }, prInput, titleInput),
    h('label', { class: 'nr-instr-label' }, 'Review instructions (optional)'),
    instrInput,
    h('div', { class: 'nr-actions' },
      h('button', { class: 'btn btn-accent', type: 'button', onclick: submit }, `Queue ${actionLabel}`),
      h('button', { class: 'btn', type: 'button', onclick: onClose }, 'Cancel')));
}

/* The "+ New spec analysis" entry (spec section): a button that swaps in an inline form
 * (source URLs + optional title) and POSTs an `audit` request. The runner (/flowlever:watch)
 * creates the workspace from the URLs, registers the sources, and runs the audit sweep. */
function newAuditZone() {
  const zone = h('div', { class: 'new-request-zone', id: 'new-request-zone' });
  const showButton = () => zone.replaceChildren(h('button', {
    class: 'btn btn-accent nr-add', type: 'button', onclick: showForm,
  }, '+ New spec analysis'));
  function showForm() {
    zone.replaceChildren(newAuditForm(showButton));
    const ta = zone.querySelector('.nr-urls');
    if (ta) requestAnimationFrame(() => ta.focus());
  }
  showButton();
  return zone;
}

function newAuditForm(onClose) {
  const titleInput = h('input', {
    class: 'nr-title', type: 'text', placeholder: 'Title (optional, e.g. "Checkout redesign")', 'aria-label': 'Title',
    onkeydown: (e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onClose(); },
  });
  // The source URLs (Confluence spec / ADO work items / Figma) and any focus go in
  // `instructions`; the audit runner parses them, creates the workspace + sources, and audits.
  const urlsInput = h('textarea', {
    class: 'nr-urls nr-instructions', rows: '4', 'aria-label': 'Spec / work-item / Figma URLs',
    placeholder: "Paste the spec & work-item URLs (one per line) — Confluence spec, ADO user story / bug, Figma frame. Add a focus note if you like, e.g. 'just the payment flow'.",
    onkeydown: (e) => { if (e.key === 'Escape') onClose(); },
  });
  async function submit() {
    const instructions = urlsInput.value.trim();
    if (!instructions) { urlsInput.classList.add('invalid'); urlsInput.focus(); return; }
    try {
      await api('/api/requests', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'audit',
          title: titleInput.value.trim() || undefined,
          instructions,
        }),
      });
      toast('Queued spec analysis', 'success');
      onClose();
      ensureApplyPolling();
      pollRequestsNow();
    } catch (e) {
      toast(`Could not queue: ${e.message}`);
    }
  }
  return h('div', { class: 'nr-form' },
    h('div', { class: 'nr-row' }, titleInput),
    h('label', { class: 'nr-instr-label' }, 'Spec / work-item / Figma URLs'),
    urlsInput,
    h('div', { class: 'nr-actions' },
      h('button', { class: 'btn btn-accent', type: 'button', onclick: submit }, 'Queue analysis'),
      h('button', { class: 'btn', type: 'button', onclick: onClose }, 'Cancel')));
}

/* ============================== detail: load + shell ============================== */

async function loadDetail(id, force = false) {
  if (!force && state.detailId === id && state.detail) return state.detail;
  if (state.detailId !== id) {
    state.filters = { dims: new Set(), sevs: new Set(), status: 'all', q: '', draft: false };
    state.waiving = null;
    state.editingHunk = null;
    state.modalFp = null;
    state.modalMode = 'detail';
    state.modalTrigger = null;
    state.exportFp = null;
    state.exportAll = false;
    state.report = { id: null, md: null };
  }
  const data = await api(`/api/features/${encodeURIComponent(id)}`);
  state.detailId = id;
  state.detail = data;
  return data;
}

async function renderDetail(id, tab) {
  current.view = 'detail'; current.id = id; current.tab = tab;
  const seq = ++routeSeq;
  const app = $('#app');
  const cached = state.detailId === id && state.detail;
  if (!cached) app.replaceChildren(detailSkeleton());
  let data;
  try {
    data = await loadDetail(id);
  } catch (e) {
    if (seq !== routeSeq) return;
    toast(`Could not load feature: ${e.message}`);
    app.replaceChildren(errorView(`Could not load “${id}”`, e.message));
    return;
  }
  if (seq !== routeSeq) return;
  state.featureJob = null; state.featureJobSig = '';   // reset job banner when entering a feature
  app.replaceChildren(detailView(data, tab));
  ensureFeatureJobPolling(id);
  if (tab === 'report') loadReportInto(id, seq);
}

function rerenderDetail() {
  if (current.view !== 'detail' || !state.detail) return;
  $('#app').replaceChildren(detailView(state.detail, current.tab));
  if (current.tab === 'report') loadReportInto(current.id, routeSeq);
  // A propose/apply job finishing reloads state.detail behind an open finding modal — without
  // this the modal keeps showing the pre-reload finding while the board underneath moves on (C-24).
  syncModal();
}

/* Keep the feature view's job banner live: while a propose/apply job for THIS workspace is
 * queued/running it shows "Drafting…/Applying…"; the moment it finishes we reload the detail so
 * freshly-attached drafts / applied stamps appear, then flip the banner to "ready to review" /
 * "applied". This is what makes the draft/apply lifecycle auto-update and read clearly. */
function ensureFeatureJobPolling(id) {
  startPolling(`featjob:${id}`, (reqs) => {
    if (current.view !== 'detail' || current.id !== id) return;
    const mine = (reqs || []).filter((r) => DETAIL_JOB_ACTIONS.includes(r.action) && r.wsId === id);
    const latest = mine.length
      ? [...mine].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] : null;
    // Staleness rides in the signature: it flips with the passage of time, not with a server
    // change, so without it the banner would keep claiming "queued…" long after the job died.
    const sig = latest
      ? `${latest.id}:${latest.status}:${latest.phase || ''}:${latest.needsInput ? 1 : 0}:${isStaleJob(latest) ? 1 : 0}`
      : '';
    if (sig === (state.featureJobSig || '')) return;        // nothing changed
    const prev = state.featureJob;
    state.featureJob = latest; state.featureJobSig = sig;
    const justDone = latest && latest.status === 'done'
      && (!prev || prev.id !== latest.id || prev.status !== 'done');
    if (justDone) { loadDetail(id, true).then(() => rerenderDetail()).catch(() => rerenderDetail()); }
    else rerenderDetail();
  });
}

/* The summarize job's own banner. Deliberately quiet: this job reads registered sources and writes
 * one field, so there is nothing to reassure the user about and nothing to take back. It says what
 * is happening, and — the one case that matters — that nothing is running it. `done` returns null
 * because the detail reloads on completion and the filled-in summary is the better answer. */
function summarizeJobBanner(j) {
  if (j.needsInput) {
    return h('div', { class: 'apply-status apply-needs-input feat-job' },
      h('span', { class: 'apply-dot' }, '⚠'),
      h('span', {}, j.note || 'Waiting on you — approve the auth prompt in your other window.'));
  }
  if (j.status === 'error') {
    return h('div', { class: 'apply-status apply-stalled feat-job' },
      h('span', { class: 'apply-dot' }, '⚠'),
      h('span', {}, `Could not write the summary${j.note ? ` — ${j.note}` : '.'} Nothing else was changed.`));
  }
  if (isStaleJob(j)) {
    return h('div', { class: 'apply-status apply-stalled feat-job' },
      h('span', { class: 'apply-dot' }, '⏸'),
      h('div', { class: 'apply-stalled-body' },
        h('span', {}, `Summary — ${j.status} ${fmtAge(jobAgeMs(j))} ago and no runner picked it up.`),
        h('span', { class: 'meta-dim' }, 'Nothing has been read or written.')),
      h('div', { class: 'apply-stalled-actions' },
        runnerZone(1, '▶ Run it now'),
        h('button', { class: 'btn btn-cancel-pending', type: 'button', onclick: () => cancelStalledJob(j) },
          '✕ Cancel job')));
  }
  if (j.status === 'queued') {
    const idle = !runnerBusy();
    return h('div', { class: 'apply-status apply-running feat-job' },
      idle ? h('span', { class: 'apply-dot' }, '⏳') : h('span', { class: 'spinner', 'aria-hidden': 'true' }),
      h('span', {}, `Writing the summary — queued${idle ? ', nothing running it yet' : ' for the runner…'}`),
      idle ? runnerZone(1, '▶ Run it now') : null);
  }
  if (j.status === 'running') {
    return h('div', { class: 'apply-status apply-running feat-job' },
      h('span', { class: 'spinner', 'aria-hidden': 'true' }),
      h('span', {}, `Writing the summary${j.phase ? ` — ${j.phase}` : '…'}`));
  }
  return null;
}

/* The live banner above the board: what the runner is doing for this workspace right now — and,
 * just as important, when it is NOT doing anything. Wording is kind-aware ("Posting" for a PR,
 * "Applying" for a spec) because the verb is what the user checks against the real PR. */
function specJobBanner(data) {
  const fid = data.feature && data.feature.id;
  const kind = (data.feature && data.feature.kind) || 'spec';
  const isPr = kind === 'pr-review' || kind === 'pr-respond';
  const writeVerb = isPr ? 'Posting' : 'Applying';
  const j = state.featureJob && state.featureJob.wsId === fid ? state.featureJob : null;
  const pending = ((data.ledger && data.ledger.findings) || []).filter(isPending);

  // No job for this workspace, yet findings still sit in the in-flight lane: the job was dropped
  // (or never existed) and nothing will ever stamp them. This is the state that silently reads as
  // "Posting…" forever, so it gets the loudest, most explicit treatment.
  if (!j && pending.length) {
    return h('div', { class: 'apply-status apply-stalled feat-job' },
      h('span', { class: 'apply-dot' }, '⏸'),
      h('div', { class: 'apply-stalled-body' },
        h('span', {}, `${plural(pending.length, 'item', 'items')} marked “${writeVerb}…” but no job is running — `,
          h('strong', {}, isPr ? 'nothing has been posted' : 'nothing has been written'), '.'),
        h('span', { class: 'meta-dim' },
          'Put them back in the review queue, then Post again with ', h('code', {}, '/flowlever:watch'), ' running.')),
      h('button', {
        class: 'btn btn-cancel-pending', type: 'button',
        onclick: () => cancelPendingHere(fid, isPr),
      }, '↩ Back to the review queue'));
  }
  if (!j) return null;

  // A summarize job takes its own branch rather than borrowing the wording below. Everything after
  // this point is built for jobs that WRITE — the verbs are "Posting"/"Applying", the recovery is
  // "put the items back in the review queue", and the loud reassurance is "nothing has been
  // posted". All four are wrong here: this job posts nothing, moves no findings, and has no items
  // to put back. Left to fall through, it told the user their PR was mid-post.
  if (j.action === 'summarize') return summarizeJobBanner(j);

  const isPropose = j.action === 'propose';
  if (j.needsInput) {
    return h('div', { class: 'apply-status apply-needs-input feat-job' },
      h('span', { class: 'apply-dot' }, '⚠'),
      h('span', {}, j.note || 'Waiting on you — approve the auth prompt in your other window.'));
  }
  // Queued/running but untouched for too long: no runner is draining the queue. Never keep
  // spinning here — a spinner on a job nobody is running is exactly what made a Post look done.
  if (isStaleJob(j)) {
    // This is where the user actually notices the problem, so put the fix right here: one click to
    // run the job now, or one to take the items back.
    return h('div', { class: 'apply-status apply-stalled feat-job' },
      h('span', { class: 'apply-dot' }, '⏸'),
      h('div', { class: 'apply-stalled-body' },
        h('span', {}, `${isPropose ? 'Drafting proposals' : writeVerb} — ${j.status} ${fmtAge(jobAgeMs(j))} ago and no runner picked it up. `,
          h('strong', {}, isPr ? 'Nothing has been posted' : 'Nothing has been written'), '.'),
        h('span', { class: 'meta-dim' },
          'Run it now, or cancel to put the items back in the review queue.')),
      h('div', { class: 'apply-stalled-actions' },
        runnerZone(1, '▶ Run it now'),
        h('button', {
          class: 'btn btn-cancel-pending', type: 'button',
          onclick: () => cancelStalledJob(j),
        }, '✕ Cancel job')));
  }
  if (j.status === 'queued') {
    // Queued with a live runner = genuinely waiting its turn. Queued with nothing running = it needs
    // one click, offered right here rather than making the user wait out the staleness timeout.
    const idle = !runnerBusy();
    return h('div', { class: 'apply-status apply-running feat-job' },
      idle ? h('span', { class: 'apply-dot' }, '⏳') : h('span', { class: 'spinner', 'aria-hidden': 'true' }),
      h('span', {}, isPropose
        ? `Drafting proposals — queued${idle ? ', nothing running it yet' : ' for the runner…'}`
        : `${writeVerb} — queued${idle ? ', nothing running it yet' : ' for the runner…'}`),
      idle ? runnerZone(1, '▶ Run it now') : null);
  }
  if (j.status === 'running') {
    return h('div', { class: 'apply-status apply-running feat-job' },
      h('span', { class: 'spinner', 'aria-hidden': 'true' }),
      h('span', {}, isPropose ? `Drafting proposals${j.phase ? ` — ${j.phase}` : '…'}` : `${writeVerb}${j.phase ? ` — ${j.phase}` : '…'}`));
  }
  if (j.status === 'done') {
    // "done" is the runner's word, not proof of a stamp: if items are still pending after the job
    // finished, the write did not complete for them — say that instead of implying success.
    if (!isPropose && pending.length) {
      // Two very different situations wear the same "still pending" shape, and conflating them gives
      // actively wrong advice:
      //   (a) the work DID go out — a commit is recorded — and only the completion stamp is missing.
      //       Telling the user to "retry" here would re-push an applied fix.
      //   (b) nothing is recorded, so the write genuinely isn't confirmed.
      const withCommit = pending.filter((f) => f.fixCommit && f.fixCommit.sha);
      const without = pending.filter((f) => !(f.fixCommit && f.fixCommit.sha));
      if (withCommit.length && !without.length) {
        const shas = [...new Set(withCommit.map((f) => f.fixCommit.sha.slice(0, 8)))].join(', ');
        return h('div', { class: 'apply-status apply-done feat-job' },
          h('span', { class: 'apply-dot' }, '✓'),
          h('div', { class: 'apply-stalled-body' },
            h('span', {}, `${plural(withCommit.length, 'fix is', 'fixes are')} pushed (`,
              h('code', {}, shas), ') — only the completion stamp is missing, so they still show as ',
              `“${writeVerb}…”.`),
            h('span', { class: 'meta-dim' },
              'The code is on the branch. Mark them done to move them out of the queue — nothing gets re-pushed.')),
          h('button', {
            class: 'btn btn-good', type: 'button',
            title: 'Record these as done using the commit already on file',
            onclick: () => confirmPushedFixes(fid, withCommit.map((f) => f.fp)),
          }, `✔ Mark ${withCommit.length} done`));
      }
      return h('div', { class: 'apply-status apply-error feat-job' },
        h('span', { class: 'apply-dot' }, '⚠'),
        h('div', { class: 'apply-stalled-body' },
          h('span', {}, `The job finished but ${plural(without.length, 'item is', 'items are')} still marked “${writeVerb}…” with `,
            h('strong', {}, 'no commit on file'),
            isPr ? ' — not confirmed as posted.' : ' — not confirmed as written.'),
          h('span', { class: 'meta-dim' }, 'Check the PR, then put them back in the queue and retry if they are missing.')),
        h('button', {
          class: 'btn btn-cancel-pending', type: 'button',
          onclick: () => cancelPendingHere(fid, isPr),
        }, '↩ Back to the review queue'));
    }
    return h('div', { class: 'apply-status apply-done feat-job' },
      h('span', { class: 'apply-dot' }, '✓'),
      h('span', {}, isPropose
        ? 'Proposals ready — open a finding with a ± to review the red/green diff, then Apply.'
        : (isPr ? 'Posted — the comments are on the PR.' : 'Applied — re-audit (↻) to confirm the changes landed.')));
  }
  if (j.status === 'error') {
    return h('div', { class: 'apply-status apply-error feat-job' },
      h('span', { class: 'apply-dot' }, '⚠'),
      h('div', { class: 'apply-stalled-body' },
        h('span', {}, `${isPropose ? 'Drafting' : writeVerb} failed: ${j.note || 'see the Claude session'}`),
        pending.length ? h('span', { class: 'meta-dim' },
          `${plural(pending.length, 'item is', 'items are')} still marked “${writeVerb}…” — put them back in the queue to retry.`) : null),
      pending.length ? h('button', {
        class: 'btn btn-cancel-pending', type: 'button',
        onclick: () => cancelPendingHere(fid, isPr),
      }, '↩ Back to the review queue') : null);
  }
  return null;
}

/* Stamp findings whose fix is already pushed as done, using the commit already on file. Safe by
 * construction: the ledger's fix gate accepts this precisely because a fixCommit exists, so it can
 * never be used to fake a completion for work that didn't happen. */
async function confirmPushedFixes(wsId, fps) {
  try {
    await api(`/api/features/${encodeURIComponent(wsId)}/review/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fps, status: 'posted' }),
    });
    await loadDetail(wsId, true);
    rerenderDetail();
    toast(`${plural(fps.length, 'fix', 'fixes')} marked done — the commit was already on file`, 'success');
  } catch (e) {
    toast(`Could not mark done: ${e.message}`);
  }
}

/* Release this workspace's in-flight markers (no job to drop — just the stranded findings). */
async function cancelPendingHere(wsId, isPr) {
  try {
    const res = await api(`/api/features/${encodeURIComponent(wsId)}/review/cancel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'released from the cockpit — write never confirmed' }),
    });
    toast(`${plural(res.cancelled, 'item', 'items')} back in the review queue — ${isPr ? 'nothing was posted' : 'nothing was written'}.`, 'success');
    await loadDetail(wsId, true);
    rerenderDetail();
  } catch (e) {
    toast(`Could not release: ${e.message}`);
  }
}

function detailSkeleton() {
  return h('div', { class: 'detail' },
    h('div', { class: 'detail-head' },
      h('div', { class: 'dh-left' }, skel('skel-line w-120'), skel('skel-title'), skel('skel-line w-200')),
      skel('skel-dial'),
    ),
    skel('skel-strip'),
    h('div', { class: 'board' }, Array.from({ length: 4 }, () => skel('skel-col'))),
  );
}

function errorView(title, msg) {
  return h('div', { class: 'empty' },
    h('h2', {}, title),
    h('p', { class: 'meta-dim' }, msg),
    h('p', {}, h('a', { class: 'backlink', href: '#/' }, '← Back to overview')),
  );
}

function detailDeleteZone(feature) {
  const zone = h('div', { class: 'dh-delete-zone' });
  const label = feature.title || feature.id || 'this workspace';

  function showButton() {
    zone.replaceChildren(h('button', {
      class: 'btn-icon dh-delete', type: 'button',
      'aria-label': `Delete workspace ${label}`, title: 'Delete workspace',
      onclick: showConfirm,
    }, h('span', { class: 'icon', html: ICONS.trash })));
  }

  function showConfirm() {
    zone.replaceChildren(h('div', { class: 'delete-confirm-inline' },
      h('span', { class: 'delete-confirm-msg' },
        `Delete "${label}"? This removes its findings and history. This can't be undone.`),
      h('button', { class: 'btn btn-danger', type: 'button', onclick: doDelete }, 'Delete'),
      h('button', { class: 'btn', type: 'button', onclick: showButton }, 'Cancel')));
  }

  async function doDelete() {
    try {
      await api(`/api/features/${encodeURIComponent(feature.id)}`, { method: 'DELETE' });
      toast(`Deleted "${label}"`, 'success');
      location.hash = kindMeta(feature.kind || 'spec').section;
    } catch (e) {
      toast(`Delete failed: ${e.message}`);
      showButton();
    }
  }

  showButton();
  return zone;
}

function detailView(data, tab) {
  const feature = data.feature || {};
  const r = data.readiness || computeReadiness((data.ledger && data.ledger.findings) || []);
  const o = r.openBySeverity || {};
  const totalOpen = SEV_ORDER.reduce((n, s) => n + (o[s] ?? 0), 0);
  const blockers = o.blocker ?? 0;

  const tabs = ['findings', 'coverage', 'timeline', 'report'];
  const tabLabels = { findings: 'All findings', coverage: 'Coverage', timeline: 'Timeline', report: 'Report' };

  const kind = feature.kind || 'spec';
  const km = kindMeta(kind);
  return h('div', { class: 'detail' },
    h('div', { class: 'detail-head' },
      h('div', { class: 'dh-left' },
        h('a', { class: 'backlink', href: km.section }, `← ${km.label}`),
        // The title and the "open the PR" arrow ride the same line, so the quick link is where the
        // thing it opens is named rather than parked in the metadata row below.
        h('div', { class: 'dh-titlerow' },
          h('h1', { class: 'dh-title' }, feature.title || feature.id || current.id),
          prQuickLink(feature),
        ),
        h('div', { class: 'dh-meta' },
          kindBadge(kind),
          statusChip(feature.status),
          feature.id ? h('code', { class: 'feature-id' }, feature.id) : null,
          detailDeleteZone(feature),
        ),
        vertecRow(feature),
      ),
      h('div', { class: 'dh-right' },
        dialEl(r.score, r.gate, 96, 'dial-lg'),
        h('div', { class: 'dh-gate' },
          gateBadge(r.gate),
          h('div', { class: `dh-blocking ${blockers > 0 ? 'hot' : ''}` },
            blockers > 0 ? `${plural(blockers, 'blocker', 'blockers')} blocking` : 'nothing blocking'),
          h('div', { class: 'meta-dim num-line' }, `${totalOpen} open total`),
          // Which vote this review has earned — directly above the button that ends the review,
          // because "I finished in FlowLever and forgot to vote on the PR" is the gap it closes.
          approvalChip(data),
          completeControl(feature),
        ),
      ),
    ),
    // First thing under the header, because "what is this even about" is the question you have
    // before any of the workflow controls mean anything.
    summaryPanel(feature),
    loopStrip(data, reviewCta(data)),
    // When we reviewed vs. when the PR last changed — the re-review decision, in one line.
    reviewStampsRow(data, kind),
    unbackedFixBanner(data),
    specJobBanner(data),
    reviewScopeNote(feature),
    sourcesStrip(feature),
    h('nav', { class: 'tabs', role: 'tablist' },
      tabs.map((t) => h('a', {
        class: `tab ${t === tab ? 'active' : ''}`,
        role: 'tab',
        'aria-selected': t === tab ? 'true' : 'false',
        href: `#/feature/${encodeURIComponent(current.id)}/${t}`,
      }, tabLabels[t]))),
    h('div', { id: 'tab-content', class: 'tab-content' }, tabContent(data, tab)),
  );
}

function tabContent(data, tab) {
  switch (tab) {
    case 'coverage': return coverageView(data);
    case 'timeline': return timelineView(data);
    case 'report':   return reportView();
    default:         return findingsView(data);
  }
}

/* Loud, unmissable banner for the one state that must never pass silently: a finding closed as
 * handled whose agreed code change has no commit behind it. That means the reviewer was told their
 * point was addressed while the branch never changed — they will re-raise it, and rightly. Offers to
 * reopen them all so the fix can actually be made. */
function unbackedFixBanner(data) {
  const findings = (data.ledger && data.ledger.findings) || [];
  const bad = findings.filter((f) => isAgreedCodeFix(f) && !(f.fixCommit && f.fixCommit.sha)
    && (isPosted(f) || f.status === 'resolved'));
  if (!bad.length) return null;
  return h('div', { class: 'apply-status unbacked-fix' },
    h('span', { class: 'apply-dot' }, '⚠'),
    h('div', { class: 'apply-stalled-body' },
      h('span', {},
        `${plural(bad.length, 'agreed code fix is', 'agreed code fixes are')} closed as handled but `,
        h('strong', {}, 'no commit carries the change'), ' — the branch does not contain them.'),
      h('span', { class: 'meta-dim' },
        'The reviewer was told this was addressed. Reopen to make the fix for real: ',
        bad.map((f) => f.draft && f.draft.target).filter(Boolean).join(' · ') || bad.map((f) => f.locus).join(' · ')),
    ),
    h('button', {
      class: 'btn btn-cancel-pending', type: 'button',
      title: 'Set these back to open so the fix can actually be applied and pushed',
      onclick: () => reopenUnbackedFixes(bad.map((f) => f.fp)),
    }, `↩ Reopen ${bad.length}`));
}

async function reopenUnbackedFixes(fps) {
  try {
    for (const fp of fps) {
      await api(`/api/features/${encodeURIComponent(current.id)}/findings/${encodeURIComponent(fp)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'open', reason: 'reopened — closed as fixed but no commit carries the change' }),
      });
    }
    await loadDetail(current.id, true);
    rerenderDetail();
    toast(`${plural(fps.length, 'finding', 'findings')} reopened — the fix still needs to be pushed`, 'success');
  } catch (e) {
    toast(`Could not reopen: ${e.message}`);
  }
}

/* The per-run scope/focus the review was launched with, carried onto the
 * workspace as `reviewBrief` by the runner. Shown as a small note so the
 * applied scope is visible while stepping through findings. */
function reviewScopeNote(feature) {
  const brief = feature && typeof feature.reviewBrief === 'string' ? feature.reviewBrief.trim() : '';
  if (!brief) return null;
  return h('div', { class: 'review-scope' },
    h('span', { class: 'review-scope-label' }, 'Review scope'),
    h('span', { class: 'review-scope-text' }, brief));
}

/* ============================== sources: roles, badges, the strip ============================== */

/* What a linked source IS, as opposed to which system it lives in. The system was never the useful
 * distinction: a PR, the user story it implements and the epic above it are all "Azure DevOps" and
 * all wore the same checkbox icon, so the only way to tell the story from the PR was to read a
 * title that a chip truncates — i.e. after clicking the wrong one. `rank` orders the strip so the
 * two you reach for most (the PR and its story) are always the first two chips.
 * `tint` keys the colour in style.css. */
const SOURCE_ROLES = {
  pr:      { label: 'PR',        icon: 'srcPr',      rank: 0 },
  story:   { label: 'Story',     icon: 'srcStory',   rank: 1 },
  bug:     { label: 'Bug',       icon: 'srcBug',     rank: 2 },
  task:    { label: 'Task',      icon: 'srcTask',    rank: 3 },
  feature: { label: 'Feature',   icon: 'srcEpic',    rank: 4 },
  epic:    { label: 'Epic',      icon: 'srcEpic',    rank: 5 },
  item:    { label: 'Work item', icon: 'srcTask',    rank: 6 },
  spec:    { label: 'Spec',      icon: 'confluence', rank: 7 },
  design:  { label: 'Design',    icon: 'figma',      rank: 8 },
};

/* ADO work-item type (source.type, set via `source add --itemType`) → role.
 * The url fallback matters and is not cosmetic: every workspace registered before --itemType was
 * used carries no type at all, and those are exactly the PRs the user is looking at today. A PR
 * url is unambiguous (`/pullrequest/<id>`), so an untyped source at that url is a PR. */
function adoRole(it) {
  const t = String((it && it.type) || '').trim().toLowerCase();
  if (t === 'pull request' || t === 'pullrequest' || t === 'pr') return 'pr';
  if (t === 'user story' || t === 'product backlog item' || t === 'story' || t === 'requirement') return 'story';
  if (t === 'bug' || t === 'defect') return 'bug';
  if (t === 'task') return 'task';
  if (t === 'feature') return 'feature';
  if (t === 'epic') return 'epic';
  if (isPrUrl(it && it.url)) return 'pr';
  return 'item';
}

function isPrUrl(url) { return /\/pullrequest\/\d+/i.test(String(url ?? '')); }

/* Sources are registered with a title that frequently restates the id the badge now carries
 * ("#5882" + "PR #5882 — [43057] Atrius 2.3…"). Drop the leading restatement so the chip spends
 * its width on what the item is about. Never returns empty — a title that is ONLY its own id
 * keeps it. */
function trimIdPrefix(title, id) {
  const t = String(title ?? '').trim();
  if (id === undefined || id === null || t === '') return t;
  const esc = String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A BARE leading number is only a restatement when a separator follows it. Without that lookahead
  // a work item #5 titled "5 Whys analysis of the outage" renders as "Whys analysis of the outage"
  // — the strip mangling the very title it exists to make identifiable. The `#`/`PR` forms are
  // unambiguous and need no separator.
  const re = new RegExp(
    '^(?:'
    + `(?:pr\\s*)?#\\s*${esc}(?![\\w-])`        // "#5882", "PR #5882"
    + `|pr\\s+${esc}(?![\\w-])`                 // "PR 5882"
    + `|${esc}(?![\\w-])(?=\\s*[-—–:·])`        // bare "5882", but only before a separator
    + ')\\s*(?:[-—–:·]\\s*)?', 'i');
  const next = t.replace(re, '').trim();
  return next || t;
}

/* Every linked source as one uniform shape, ordered by role. */
function sourceEntries(feature) {
  const s = (feature && feature.sources) || {};
  const out = [];
  for (const it of s.ado || []) {
    if (!it) continue;
    const role = adoRole(it);
    out.push({
      role,
      // An ADO instance can carry work-item types we don't map ("Impediment", "Test Case"). Showing
      // the real type beats a generic "Work item" — the badge exists to name the thing exactly.
      label: role === 'item' && it.type ? String(it.type).trim() : SOURCE_ROLES[role].label,
      idText: it.id != null ? `#${it.id}` : '',
      text: trimIdPrefix(it.title, it.id) || (it.id != null ? `#${it.id}` : 'work item'),
      system: 'Azure DevOps',
      url: it.url,
    });
  }
  for (const it of s.confluence || []) {
    if (!it) continue;
    out.push({ role: 'spec', label: SOURCE_ROLES.spec.label, idText: '',
      text: String(it.title || it.id || 'page').trim(), system: 'Confluence', url: it.url });
  }
  for (const it of s.figma || []) {
    if (!it) continue;
    out.push({ role: 'design', label: SOURCE_ROLES.design.label, idText: '',
      text: String(it.title || it.fileKey || 'frame').trim(), system: 'Figma', url: it.url });
  }
  // Stable within a rank: sources keep the order they were registered in, which is the order the
  // review skill walked them.
  return out.map((e, i) => ({ e, i }))
    .sort((a, b) => (SOURCE_ROLES[a.e.role].rank - SOURCE_ROLES[b.e.role].rank) || (a.i - b.i))
    .map(({ e }) => e);
}

function sourcesStrip(feature) {
  const entries = sourceEntries(feature);
  return h('div', { class: 'sources-strip' },
    h('span', { class: 'src-label' }, 'Sources'),
    !entries.length ? h('span', { class: 'meta-dim' }, 'none linked') :
      h('div', { class: 'src-group' }, entries.map((e) => {
        const href = safeHref(e.url);
        const ttl = `${e.label} · ${e.system}${e.idText ? ` ${e.idText}` : ''} — ${e.text}`;
        const inner = [
          iconSpan(SOURCE_ROLES[e.role].icon, `icon src-icon src-${e.role}`),
          h('span', { class: `src-badge src-badge-${e.role}` }, e.label),
          e.idText ? h('span', { class: 'src-id' }, e.idText) : null,
          h('span', { class: 'src-text' }, e.text),
          href ? iconSpan('link', 'icon src-out') : null,
        ];
        return href
          ? h('a', { class: `src-link src-role-${e.role}`, href, target: '_blank', rel: 'noopener noreferrer', title: ttl }, inner)
          : h('span', { class: `src-link src-nolink src-role-${e.role}`, title: ttl }, inner);
      })),
  );
}

/* ============================== Vertec booking line ============================== */

/* The work item a Vertec booking is made against: the STORY (or bug/task) the change belongs to,
 * never the PR that implements it and, only as a last resort, the feature/epic above it. Ranked
 * rather than "first ado source" because the sources are registered in review order, which puts
 * the PR first.
 *
 * `item` — the UNTYPED fallback role — is deliberately absent from this table, and that is the
 * whole guard. A source registered without `--itemType` tells us two things we would otherwise
 * have to invent: which of several work items is the story (rather than the epic above it), and
 * whether `title` is the work item's own `System.Title` or the audit skill's paraphrase of it
 * ("FOAN00 #42700" is a real example from the ledger). Ranking an untyped item as bookable made
 * the ranking meaningless — it collapsed to "whichever was registered first" — and put a
 * plausible, wrong string on the clipboard, which is the one failure this feature cannot have:
 * it gets pasted into a real booking. Unverified ⇒ no booking line, exactly as an underivable
 * prefix means no booking line. The next review round records the type and it starts working. */
const VERTEC_RANK = { story: 0, bug: 1, task: 2, feature: 3, epic: 4 };
function bookingItem(feature) {
  const list = (((feature || {}).sources || {}).ado || []).filter(Boolean);
  let best = null;
  let bestRank = Infinity;
  for (const it of list) {
    const rank = VERTEC_RANK[adoRole(it)];
    if (rank === undefined) continue;          // a PR, or an untyped work item, is not bookable
    if (rank < bestRank) { best = it; bestRank = rank; }
  }
  return best;
}

/* The best candidate we had to REFUSE because its role is not bookable. It carries no booking line,
 * only the explanation: without this the row simply vanishes on the 36-of-55 workspaces reviewed
 * before `--itemType` was passed, and "missing" reads as "broken" rather than "not confirmed yet".
 * Prefers a candidate that at least has a phase recorded — that is the one carrying real data. */
function unverifiedBookingItem(feature) {
  const cands = (((feature || {}).sources || {}).ado || []).filter((it) => it && adoRole(it) === 'item');
  return cands.find((it) => typeof it.vertecPhase === 'string' && it.vertecPhase.trim()) || cands[0] || null;
}

/* Why that candidate is not bookable — and these are NOT the same problem, so they must not share
 * a sentence. `adoRole` returns 'item' both for "no type on file" and for a type Azure DevOps
 * records but we don't book against (Impediment, Test Case, Risk…). Telling the second case that
 * its "type was never recorded, the next review round records it" is simply false: the type IS
 * recorded, the badge beside it says so, and re-recording changes nothing — a dead end dressed as
 * an action. */
function unbookableReason(it) {
  const type = String((it && it.type) || '').trim();
  return type
    // No article before `${type}` — it comes from the ADO instance, so "a Impediment" is the
    // failure case of any article this code could pick.
    ? `Azure DevOps records #${it.id} with type "${type}", which isn't a bookable work-item type. `
      + 'Book against the story or bug this work belongs to.'
    : `No booking text — #${it.id}'s work-item type was never recorded, so this can't confirm `
      + 'which item to book or that its title matches Azure DevOps. The next review round records both.';
}

/* The booking key's prefix is the Azure DevOps ORGANISATION the work item lives in — `FZAG` in
 * `dev.azure.com/FZAG/dxp/_workitems/edit/43057`, `DXN` for DXN's board. That is derived, not
 * configured, so a new project needs no setup; `--vertecKey` on the source overrides it for an org
 * whose Vertec prefix is spelled differently. No url ⇒ no prefix ⇒ no booking line: an invented
 * prefix would be pasted into a real booking. */
function vertecPrefix(it) {
  const override = it && typeof it.vertecKey === 'string' ? it.vertecKey.trim() : '';
  if (override) return override.toUpperCase();
  let u = null;
  try { u = new URL(String((it && it.url) || ''), location.href); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (host === 'dev.azure.com' || host.endsWith('.dev.azure.com')) {
    const seg = u.pathname.split('/').filter(Boolean)[0];
    if (!seg) return null;
    try { return decodeURIComponent(seg).toUpperCase(); } catch { return seg.toUpperCase(); }
  }
  const legacy = /^([^.]+)\.visualstudio\.com$/.exec(host);   // the pre-dev.azure.com host form
  return legacy ? legacy[1].toUpperCase() : null;
}

/* `FZAG-43057 Atrius 2.3 — The map reads in the visitor's language` — the exact string that goes
 * into a Vertec booking, so it is assembled from the id and the work item's own title with nothing
 * added. Returns null when any part is missing rather than a half-built line. */
function vertecBookingText(it) {
  if (!it || it.id === undefined || it.id === null || String(it.id).trim() === '') return null;
  const prefix = vertecPrefix(it);
  if (!prefix) return null;
  const title = String(it.title || '').trim();
  return `${prefix}-${String(it.id).trim()}${title ? ` ${title}` : ''}`;
}

/* One-click booking text for Vertec, on the workspace header. The phase is shown beside it as
 * information only — it is not part of what gets copied.
 *
 * There are three outcomes, and only the first one gets a copy button. The other two state WHY
 * there is no booking text, because a row that silently disappears is indistinguishable from a
 * broken one — and, far worse, a row that quietly guessed would be believed. */
function vertecRow(feature) {
  const it = bookingItem(feature);
  const unverified = it ? null : unverifiedBookingItem(feature);
  const subject = it || unverified;
  // No work item at all (a PR-only or source-less workspace) is the ONE case with nothing to say.
  // Every other case renders and explains itself — a row that vanishes because the org happened to
  // be underivable is indistinguishable from a broken one, which is the whole reason this branch
  // exists. (It used to also vanish when there was no phase to carry it.)
  if (!subject) return null;

  const text = it ? vertecBookingText(it) : null;
  // The phase belongs to the item being booked, so it is read off THAT item — never borrowed from
  // a sibling, which would attribute one work item's booking phase to another.
  const phase = typeof subject.vertecPhase === 'string' && subject.vertecPhase.trim()
    ? subject.vertecPhase.trim() : null;

  let line;
  if (text) {
    // user-select:all (style.css) so a manual drag also grabs exactly the booking string.
    line = h('span', { class: 'vertec-text' }, text);
  } else if (unverified) {
    line = h('span', { class: 'vertec-text vertec-missing' }, unbookableReason(unverified));
  } else {
    line = h('span', { class: 'vertec-text vertec-missing' },
      `No booking text — no Azure DevOps organisation in #${subject.id}'s url. `
      + 'Re-register the source with --url, or set --vertecKey.');
  }

  return h('div', { class: 'vertec-row' },
    h('span', { class: 'vertec-label' }, 'Vertec'),
    h('div', { class: 'vertec-body' },
      line,
      h('span', { class: 'vertec-phase' },
        h('span', { class: 'vertec-phase-label' }, 'Phase'),
        phase
          ? h('span', { class: 'vertec-phase-text' }, phase)
          : h('span', { class: 'vertec-phase-text meta-dim' }, 'not recorded — the next review round reads it off the work item')),
    ),
    text ? copyButton(text, 'Vertec booking text', 'Copy the Vertec booking text') : null,
  );
}

/* A copy-to-clipboard icon button that confirms on itself (glyph swap) as well as in a toast.
 * `label` names WHAT was copied, so the toast reads "Vertec booking text copied". */
function copyButton(text, label, title) {
  let timer = null;
  const btn = h('button', {
    class: 'btn-icon copy-btn', type: 'button', title, 'aria-label': title,
    onclick: async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        toast('Clipboard unavailable — select the text and copy it manually');
        return;
      }
      toast(`${label} copied`, 'success');
      btn.classList.add('copied');
      btn.replaceChildren(iconSpan('copied', 'icon'));
      clearTimeout(timer);
      timer = setTimeout(() => {
        // The row is re-rendered on every poll tick, so the button may be detached by now; the
        // guard keeps the timer from resurrecting a node nobody is looking at.
        if (!btn.isConnected) return;
        btn.classList.remove('copied');
        btn.replaceChildren(iconSpan('copy', 'icon'));
      }, 1600);
    },
  }, iconSpan('copy', 'icon'));
  return btn;
}

/* ============================== the approval indicator ============================== */

/* The three votes, in the reviewer's words and Azure DevOps'. FlowLever never casts one — it only
 * says which the review has earned, because noticing that for yourself is the step that gets
 * skipped. `ado` is the literal vote name so the chip names the thing you press over there. */
const APPROVAL_VOTES = {
  approve:                   { label: 'Approve',                  ado: 'Approved',                   tone: 'go' },
  'approve-with-suggestions': { label: 'Approve with suggestions', ado: 'Approved with suggestions', tone: 'go-soft' },
  'wait-for-author':         { label: 'Wait for author',          ado: 'Waiting for the author',     tone: 'hold' },
};

/* The chip on the workspace header. Says the vote, and underneath it why — a recommendation whose
 * reasoning you cannot see is one you have to re-derive before you trust it, which costs more than
 * it saves. Renders nothing at all when the honest answer is "not yet": a greyed-out vote reads as
 * a broken control, whereas an absent one reads as "the review isn't finished", which is the
 * truth and is already said by the state pill beside it. */
function approvalChip(data) {
  const a = data && data.approval;
  if (!a || !a.vote) return null;
  const v = APPROVAL_VOTES[a.vote];
  if (!v) return null;                      // a vote from a newer server this build doesn't know
  return h('div', { class: `approval approval-${v.tone}`, title: `Vote "${v.ado}" on the pull request — FlowLever does not cast it` },
    h('div', { class: 'approval-head' },
      h('span', { class: 'approval-dot' }),
      h('span', { class: 'approval-label' }, v.label)),
    h('div', { class: 'approval-why' }, a.reason));
}

/* ============================== PR quick link + summary ============================== */

/* The PR this workspace is about, as a linkable source. */
function prSource(feature) {
  return (((feature || {}).sources || {}).ado || [])
    .find((it) => it && adoRole(it) === 'pr' && safeHref(it.url)) || null;
}

/* The diagonal arrow beside the workspace title: open the PR in Azure DevOps, in a new tab. */
function prQuickLink(feature) {
  const pr = prSource(feature);
  if (!pr) return null;
  const label = `Open PR${pr.id != null ? ` #${pr.id}` : ''} in Azure DevOps (new tab)`;
  return h('a', {
    class: 'dh-prlink', href: safeHref(pr.url), target: '_blank', rel: 'noopener noreferrer',
    title: label, 'aria-label': label,
  }, iconSpan('openExternal', 'icon'));
}

/* The plain-language "what is this change about" blurb (feature.summary), written by the review
 * skills from the PR description, the linked work item and the specs they already fetched. The app
 * has no model, so it NEVER invents one: a workspace reviewed before this existed says so, and
 * names the command that fills it, rather than paraphrasing its own title back at the reader. */
function summaryPanel(feature) {
  const text = feature && typeof feature.summary === 'string' ? feature.summary.trim() : '';
  if (text) {
    return h('div', { class: 'ws-summary' },
      h('span', { class: 'ws-summary-label' }, 'What this is about'),
      // `md-prose` strips the report view's document chrome off the rendered markdown — a bare
      // `.md` carries a panel + border and would draw a second box inside this one.
      h('div', { class: 'ws-summary-body' }, mdBlock(text, 'md-prose')));
  }
  return h('div', { class: 'ws-summary ws-summary-empty' },
    h('span', { class: 'ws-summary-label' }, 'What this is about'),
    h('div', { class: 'ws-summary-emptyrow' },
      h('span', { class: 'meta-dim' },
        'No summary yet. The sources are already registered, so this only needs a read — not a whole re-review.'),
      summarizeButton(feature)));
}

/* Ask the runner to write the summary for a workspace that has none. The sources are already on
 * the workspace, so this is a read of material the review skills have fetched before — which is
 * why it is its own small job rather than a full re-review.
 *
 * Read-only toward Azure DevOps and Confluence, and it writes nothing to the PR: the job fetches
 * the registered sources and fills in what the cockpit cannot derive — the summary, and while it
 * is there the work-item types and Vertec phase that a workspace reviewed before those existed is
 * missing. See skills/summarize. */
function summarizeButton(feature) {
  const wsId = feature && feature.id;
  if (!wsId) return null;
  if (readOnlyMode()) {
    return h('span', { class: 'meta-dim', title: READ_ONLY_TITLE }, 'read-only');
  }
  const btn = h('button', {
    class: 'btn btn-accent ws-summary-btn', type: 'button',
    title: 'Read the workspace\'s registered sources and write the summary — no PR writes, no re-review',
    onclick: async () => {
      btn.disabled = true;
      btn.textContent = 'Queueing…';
      try {
        await api('/api/requests', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'summarize', wsId, dedupe: true }),
        });
        // Same rule as Post/Apply: queueing a job nobody runs is a silent no-op, so the runner is
        // started here rather than left for the user to remember.
        const r = await refreshRunner();
        // Says the runner STARTED, not that anything has been read — the job banner above the
        // board reports the actual phases, and claiming progress the runner has not made is the
        // habit this app is careful about everywhere else.
        if (r && r.available && !r.running) {
          await startRunner('watch', { silent: true });
          toast('Summary queued — a runner is starting on it', 'success');
        } else if (r && r.running) {
          toast('Summary queued — the running session will pick it up', 'success');
        } else {
          toast('Summary queued — run /flowlever:watch in Claude Code to execute it', 'success');
        }
        // A pressed button must not read "Queueing…" for ever. It stays disabled because a second
        // press would only dedupe onto the same request; the job banner takes over from here, and
        // the panel is rebuilt (with a fresh, enabled button) the moment the job errors or ends.
        btn.textContent = 'Queued';
        ensureFeatureJobPolling(current.id);
        pollRequestsNow();
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Generate summary';
        toast(`Could not queue the summary: ${e.message}`);
      }
    },
  }, 'Generate summary');
  return btn;
}

/* ============================== diff engine + renderer ============================== */

const DIFF_MAX_LINES = 600; // cap per side — guards the O(n·m) LCS table on huge inputs

/* Line-level LCS diff. Returns { rows: [{type:'context'|'del'|'add', text}], truncated }.
 * Classic dynamic-programming LCS over lines, then a back-to-front walk to emit rows. */
function lcsDiff(beforeText, afterText) {
  const aAll = String(beforeText ?? '').split('\n');
  const bAll = String(afterText ?? '').split('\n');
  const truncated = aAll.length > DIFF_MAX_LINES || bAll.length > DIFF_MAX_LINES;
  const a = aAll.slice(0, DIFF_MAX_LINES);
  const b = bAll.slice(0, DIFF_MAX_LINES);
  const n = a.length, m = b.length;

  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const rows = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { rows.push({ type: 'context', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { rows.push({ type: 'del', text: a[i] }); i++; }
    else { rows.push({ type: 'add', text: b[j] }); j++; }
  }
  while (i < n) rows.push({ type: 'del', text: a[i++] });
  while (j < m) rows.push({ type: 'add', text: b[j++] });
  return { rows, truncated };
}

/* Pair unified rows into side-by-side { left, right } rows for the split view:
 * context lines mirror on both sides; a run of dels/adds zips left↔right. */
function toSplitRows(rows) {
  const out = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].type === 'context') { out.push({ left: rows[i], right: rows[i] }); i++; continue; }
    const dels = [], adds = [];
    while (i < rows.length && rows[i].type === 'del') dels.push(rows[i++]);
    while (i < rows.length && rows[i].type === 'add') adds.push(rows[i++]);
    const max = Math.max(dels.length, adds.length);
    for (let k = 0; k < max; k++) out.push({ left: dels[k] || null, right: adds[k] || null });
  }
  return out;
}

const GUTTER = { add: '+', del: '−', context: ' ', empty: '' };

/* ---- rendered proposal view for the READ view of a proposal diff. Reuses the app's
 * existing DOM markdown renderer (renderMarkdown / mdInline, defined later) so the proposed
 * text shows as real formatted content — tables, bold, code, links — instead of raw markup.
 * gherkin gets a small DOM builder that bolds Given/When/Then. Returns a DOM NODE (appended as
 * a child), NOT an HTML string. ---- */
function gherkinNode(src) {
  const KW = /^(\s*)(Given|When|Then|And|But|Scenario|Feature|Background|Examples)\b(.*)$/;
  const wrap = h('div', { class: 'rd-gherkin' });
  for (const l of String(src).replace(/\r\n/g, '\n').split('\n')) {
    if (l.trim() === '') { wrap.append(h('div', { class: 'rd-gblank' })); continue; }
    const m = KW.exec(l);
    if (m) {
      wrap.append(h('div', { class: 'rd-gline' },
        m[1] ? h('span', { class: 'rd-indent' }, m[1]) : null,
        h('strong', { class: 'rd-kw' }, m[2]),
        mdInline(m[3])));
    } else {
      wrap.append(h('div', { class: 'rd-gline' }, mdInline(l)));
    }
  }
  return wrap;
}
function proseNode(src, format) {
  if (format === 'markdown') return renderMarkdown(src);   // existing DOM renderer → a node
  if (format === 'gherkin') return gherkinNode(src);
  return h('pre', { class: 'rd-pre' }, String(src));
}
/* True when a draft's text is worth rendering (vs. a raw code diff). */
function canRenderProse(f) {
  const fmt = f && f.draft && f.draft.format;
  return fmt === 'markdown' || fmt === 'gherkin';
}
/* The rendered (read-only) view of one hunk: the current text (if this hunk
 * removes anything) and the proposed text, each rendered from the draft format.
 * Context + del → "current"; context + add → "proposed". */
function renderedHunkEl(f, hunk) {
  const fmt = (f.draft && f.draft.format) || 'text';
  const beforeText = hunk.rows.filter((r) => r.type === 'context' || r.type === 'del').map((r) => r.text).join('\n');
  const afterText = hunk.rows.filter((r) => r.type === 'context' || r.type === 'add').map((r) => r.text).join('\n');
  const removes = hunk.rows.some((r) => r.type === 'del');
  const adds = hunk.rows.some((r) => r.type === 'add');
  const blocks = [];
  if (removes && beforeText.trim()) {
    blocks.push(h('div', { class: 'rd-block rd-current' },
      h('div', { class: 'rd-label' }, 'Current'),
      h('div', { class: 'rd-body' }, proseNode(beforeText, fmt))));
  }
  if (afterText.trim()) {
    blocks.push(h('div', { class: 'rd-block rd-proposed' },
      h('div', { class: 'rd-label' }, removes ? 'Proposed' : 'Proposed addition'),
      h('div', { class: 'rd-body' }, proseNode(afterText, fmt))));
  }
  if (!blocks.length) blocks.push(h('div', { class: 'diff-empty-note' }, 'No changes.'));
  return h('div', { class: 'rendered-diff' }, ...blocks);
}

function diffUnified(rows) {
  const t = h('div', { class: 'diff-table diff-unified' });
  for (const r of rows) {
    t.append(h('div', { class: `diff-row diff-${r.type}` },
      h('span', { class: 'diff-gutter' }, GUTTER[r.type] ?? ' '),
      h('span', { class: 'diff-text' }, r.text)));
  }
  return t;
}

function diffSplit(rows) {
  const t = h('div', { class: 'diff-table diff-split' });
  const cell = (cr, side) => {
    const type = cr ? cr.type : 'empty';
    return h('div', { class: `diff-cell diff-cell-${side} diff-${type}` },
      h('span', { class: 'diff-gutter' }, GUTTER[type] ?? ''),
      h('span', { class: 'diff-text' }, cr ? cr.text : ''));
  };
  for (const pair of toSplitRows(rows)) {
    t.append(h('div', { class: 'diff-srow' }, cell(pair.left, 'left'), cell(pair.right, 'right')));
  }
  return t;
}

/* ---- hunk grouping: split the unified diff rows into reviewable hunks.
 * A hunk = a contiguous run of add/del rows plus up to HUNK_CONTEXT lines of
 * surrounding context. Change-runs separated by more than 2·HUNK_CONTEXT context
 * lines become distinct hunks (the gap collapses, GitHub-style). Each hunk gets a
 * stable index id within the finding, so decisions key off it. ---- */
const HUNK_CONTEXT = 3;

function groupHunks(rows) {
  const changed = [];
  for (let i = 0; i < rows.length; i++) if (rows[i].type !== 'context') changed.push(i);
  if (!changed.length) return [];
  const clusters = [];
  let cur = [changed[0]];
  for (let k = 1; k < changed.length; k++) {
    if (changed[k] - cur[cur.length - 1] - 1 <= 2 * HUNK_CONTEXT) cur.push(changed[k]);
    else { clusters.push(cur); cur = [changed[k]]; }
  }
  clusters.push(cur);
  return clusters.map((cl, idx) => {
    const start = Math.max(0, cl[0] - HUNK_CONTEXT);
    const end = Math.min(rows.length - 1, cl[cl.length - 1] + HUNK_CONTEXT);
    const hrows = rows.slice(start, end + 1);
    return {
      id: idx,
      rows: hrows,
      adds: hrows.filter((r) => r.type === 'add'),
      dels: hrows.filter((r) => r.type === 'del'),
    };
  });
}

function hunkAfterText(hunk) { return hunk.adds.map((r) => r.text).join('\n'); }

/* One-line summary of a hunk's proposed change, for the SKIP / UNDECIDED buckets. */
function hunkGist(hunk) {
  const firstAdd = hunk.adds.find((r) => r.text.trim());
  const firstDel = hunk.dels.find((r) => r.text.trim());
  let s;
  if (firstAdd && firstDel) s = `change “${firstDel.text.trim()}” → “${firstAdd.text.trim()}”`;
  else if (firstAdd) s = `add “${firstAdd.text.trim()}”`;
  else if (firstDel) s = `remove “${firstDel.text.trim()}”`;
  else s = '(whitespace-only change)';
  return s.length > 140 ? s.slice(0, 137) + '…' : s;
}

function reviewTally(hunks, review) {
  const t = { accepted: 0, rejected: 0, edited: 0, undecided: 0 };
  for (const hunk of hunks) {
    const dec = review[String(hunk.id)];
    const s = dec && dec.status;
    if (s === 'accepted' || s === 'rejected' || s === 'edited') t[s]++; else t.undecided++;
  }
  return t;
}

function tallyPart(n, label, cls) {
  return h('span', { class: `tally tally-${cls}` }, h('span', { class: 'num' }, String(n)), ' ', label);
}

/* Derive the diff/hunk/review shape for a finding's draft — shared by the
 * compact board trigger and the full-width review modal. */
function draftStats(f) {
  const d = f.draft;
  const { rows, truncated } = lcsDiff(d.before, d.after);
  const adds = rows.reduce((n, r) => n + (r.type === 'add' ? 1 : 0), 0);
  const dels = rows.reduce((n, r) => n + (r.type === 'del' ? 1 : 0), 0);
  const hunks = groupHunks(rows);
  const review = (d.review && d.review.hunks) || {};
  return { rows, truncated, adds, dels, hunks, review };
}

/* Finding-level counter-proposal accessors (verdict drives the override; note is
 * the free-text instruction for the coding agent). Default verdict is 'proposed'. */
function draftVerdict(f) {
  const r = f.draft && f.draft.review;
  return (r && r.verdict) || 'proposed';
}
function draftNote(f) {
  const r = f.draft && f.draft.review;
  return (r && r.note) || '';
}
const VERDICT_LABEL = { proposed: 'Proposed', redirect: '✋ Redirect', reject: '🚫 Reject' };
const VERDICT_GLYPH = { redirect: '✋', reject: '🚫' };

/* A finding counts as reviewed — for the "Export reviewed" count and inclusion —
 * if it has ANY hunk decision OR a non-empty note OR a non-default verdict. */
function isReviewed(f) {
  const r = f.draft && f.draft.review;
  if (!r) return false;
  if (r.hunks && Object.keys(r.hunks).length) return true;
  if (r.note && r.note.trim()) return true;
  if (r.verdict && r.verdict !== 'proposed') return true;
  return false;
}

/* In the finding modal's detail view: a single "Review change" button carrying
 * the ± glyph and +N −M counts. Clicking it switches the modal to its
 * full-width review sub-view (same modal, not a second dialog). */
function reviewTrigger(f) {
  const { adds, dels, hunks, review } = draftStats(f);
  const t = reviewTally(hunks, review);
  const reviewed = t.accepted + t.rejected + t.edited;
  return h('div', { class: 'f-review-trigger' },
    h('button', {
      class: 'btn btn-review', type: 'button',
      onclick: (e) => { e.stopPropagation(); state.modalMode = 'review'; syncModal(); },
    },
      h('span', { class: 'draft-glyph' }, '±'),
      h('span', { class: 'br-label' }, 'Review change'),
      h('span', { class: 'diff-counts' },
        h('span', { class: 'diff-add-n' }, `+${adds}`), ' ',
        h('span', { class: 'diff-del-n' }, `−${dels}`)),
      reviewed
        ? h('span', { class: 'br-progress num' }, `${reviewed}/${hunks.length} reviewed`)
        : null,
    ));
}

/* ---- finding modal: one roomy <dialog> reused for whichever finding is open.
 * It has two sub-views — a "detail" view (everything the inline expansion used
 * to show, with room) and a full-width "review" view (the diff experience).
 * Native showModal() gives us the dimmed backdrop, focus trap and Esc-to-close;
 * we add backdrop-click, body-scroll lock and focus restore on top. ---- */

function findFinding(fp) {
  const findings = (state.detail && state.detail.ledger && state.detail.ledger.findings) || [];
  return findings.find((x) => x.fp === fp) || null;
}

function ensureModal() {
  let dlg = document.getElementById('finding-modal');
  if (dlg) return dlg;
  dlg = h('dialog', {
    id: 'finding-modal', class: 'finding-modal',
    'aria-modal': 'true', role: 'dialog', 'aria-label': 'Finding detail',
    // a click whose target is the dialog box itself landed on the backdrop
    onclick: (e) => { if (e.target === dlg) closeModal(); },
    onclose: onModalClosed,
  });
  document.body.append(dlg);
  return dlg;
}

function openModal(fp, trigger) {
  const f = findFinding(fp);
  if (!f) return;
  state.modalFp = fp;
  // PR-kind workspaces present the same kind-aware triage as the stepper: open a
  // reviewable PR finding straight in the review sub-view (proposed comment +
  // Approve/Edit/Dismiss), crash-safe even with no code-diff draft. Spec findings
  // keep opening in the detail sub-view.
  const kind = (state.detail && state.detail.feature && state.detail.feature.kind) || 'spec';
  const isPr = kind === 'pr-review' || kind === 'pr-respond';
  if (isPr) ensureFlow();   // so a modal decision lands in the same state.flow the stepper reads
  state.modalMode = (isPr && (!!f.draft || hasSuggestion(f))) ? 'review' : 'detail';
  state.modalTrigger = trigger || null;
  state.waiving = null;
  state.editingHunk = null;
  state.exportFp = null;
  const dlg = ensureModal();
  renderModalContent(dlg, f);
  document.body.classList.add('modal-open');
  if (!dlg.open) dlg.showModal();
}

function closeModal() {
  const dlg = document.getElementById('finding-modal');
  if (dlg && dlg.open) dlg.close();   // fires 'close' → onModalClosed
  else onModalClosed();
}

function onModalClosed() {
  const trigger = state.modalTrigger;
  state.modalFp = null;
  state.modalMode = 'detail';   // reopening returns to the detail view by default
  state.modalTrigger = null;
  state.waiving = null;
  state.editingHunk = null;
  state.exportFp = null;
  document.body.classList.remove('modal-open');
  renderBoard();
  if (trigger && document.contains(trigger)) requestAnimationFrame(() => trigger.focus());
}

/* After any state change: keep the board fresh and, if the modal is open,
 * re-render its contents (closing it if the finding vanished entirely). */
function refreshModal() {
  renderBoard();
  syncModal();
  if (state.flow.active) renderFlowInto();   // the stepper reuses the same review widgets
}

function syncModal() {
  if (!state.modalFp) return;
  const dlg = document.getElementById('finding-modal');
  if (!dlg || !dlg.open) return;
  const f = findFinding(state.modalFp);
  if (!f) { closeModal(); return; }   // finding gone — nothing to show
  renderModalContent(dlg, f);
}

/* Dispatch to whichever sub-view is active. The review view only exists while
 * the finding still has a draft; otherwise we fall back to the detail view
 * (e.g. after the draft is discarded from inside the review view). */
function renderModalContent(dlg, f) {
  const kind = (state.detail && state.detail.feature && state.detail.feature.kind) || 'spec';
  const isPr = kind === 'pr-review' || kind === 'pr-respond';
  // Spec review needs a code-diff draft; a PR finding is reviewable on a proposed
  // comment alone (suggestion-only), so don't require a draft there.
  const reviewable = isPr ? (!!f.draft || hasSuggestion(f)) : !!f.draft;
  const reviewMode = state.modalMode === 'review' && reviewable;
  dlg.classList.toggle('modal-review', reviewMode);
  dlg.setAttribute('aria-label', reviewMode ? 'Review proposed change' : 'Finding detail');
  dlg.replaceChildren(reviewMode ? reviewFrame(f) : detailFrame(f));
}

/* The detail sub-view: header (severity · title · tags · status · close) and a
 * roomy body holding what the inline card expansion used to show. */
function detailFrame(f) {
  const sev = SEV[f.severity] ? f.severity : 'info';
  const badge = findingBadge(f, currentRoundNum());
  const header = h('header', { class: 'fm-head' },
    h('div', { class: 'fm-head-main' },
      h('div', { class: 'fm-titlerow' },
        h('span', { class: `sev-glyph sev-${sev}`, title: SEV[sev].label }, SEV[sev].glyph),
        h('h2', { class: 'rm-title' }, f.title || '(untitled finding)'),
        f.pinned ? iconSpan('pin', 'icon f-pin') : null,
      ),
      h('div', { class: 'fm-tags' },
        f.dimension ? h('span', { class: 'dim-tag' }, f.dimension) : null,
        badge ? h('span', { class: `f-badge f-badge-${badge}` }, badge === 'new' ? 'NEW' : 'REGRESSED') : null,
        statusChip(f.status),
        verdictChip(f),
        f.locus ? h('code', { class: 'f-locus' }, f.locus) : null,
      ),
    ),
    h('button', { class: 'rm-close', type: 'button', 'aria-label': 'Close',
      onclick: () => closeModal() }, '×'),
  );
  return h('div', { class: 'rm-frame' },
    header,
    h('div', { class: 'rm-body' }, findingBody(f)),
  );
}

/* The full-width review sub-view: header (← Back · title · target · format ·
 * counts · Unified/Split · close), scrolling diff body with per-hunk controls +
 * tally, and footer (Export decisions + Discard). Reuses the existing
 * hunk/export render functions — this is presentation, not new diff logic. */
/* Shared review body: the finding-level note/verdict control, the hunk tally,
 * each reviewable hunk, and a truncation note. Used by both the modal review
 * sub-view and the guided stepper so they stay pixel-identical. */
function reviewBodyKids(f) {
  const { hunks, review, truncated } = draftStats(f);
  const kids = [reviewNoteSection(f)];
  if (!hunks.length) {
    kids.push(h('div', { class: 'diff-table diff-nochange' },
      h('div', { class: 'diff-empty-note' }, 'No changes — proposed text is identical to the current text.')));
  } else {
    const t = reviewTally(hunks, review);
    // Captioned so the per-hunk ✅/❌/✏️ buttons read as scoped to each individual change,
    // not a second "the decision" — they sit below the finding-level Decision row and the
    // draft verdict control, and this heading is what makes that nesting legible (U-3).
    kids.push(h('div', { class: 'hunk-section-head' },
      h('span', { class: 'step-section-label' }, 'Per-change:'),
      h('div', { class: 'hunk-tally' },
        tallyPart(t.accepted, 'accepted', 'accepted'),
        tallyPart(t.rejected, 'rejected', 'rejected'),
        tallyPart(t.edited, 'edited', 'edited'),
        tallyPart(t.undecided, 'undecided', 'undecided'),
      )));
    for (const hunk of hunks) kids.push(hunkEl(f, hunk, review[String(hunk.id)]));
  }
  if (truncated) kids.push(h('div', { class: 'diff-trunc' }, `Diff truncated to ${DIFF_MAX_LINES} lines per side.`));
  return kids;
}

function reviewFrame(f) {
  const data = state.detail;
  const kind = (data && data.feature && data.feature.kind) || 'spec';
  const isPr = kind === 'pr-review' || kind === 'pr-respond';
  const hasDraft = !!f.draft;
  const d = f.draft;
  // Only touch draft-derived stats when there actually is a draft — a
  // suggestion-only PR finding has none and must not read draft.* (Bug A).
  const stats = hasDraft ? draftStats(f) : null;

  const renderable = canRenderProse(f);
  const mkTab = (mode, label) => h('button', {
    class: `diff-tab ${state.diffMode === mode ? 'active' : ''}`,
    type: 'button', 'aria-label': `${label} view`,
    onclick: () => { state.diffMode = mode; reviewRefresh(); },
  }, label);

  const headMeta = hasDraft
    ? h('div', { class: 'rm-headmeta' },
        h('code', { class: 'diff-target' }, d.target || f.locus || '—'),
        d.format ? h('span', { class: 'diff-fmt' }, d.format) : null,
        h('span', { class: 'diff-counts' },
          h('span', { class: 'diff-add-n' }, `+${stats.adds}`), ' ',
          h('span', { class: 'diff-del-n' }, `−${stats.dels}`)))
    : (f.locus ? h('div', { class: 'rm-headmeta' }, h('code', { class: 'diff-target' }, f.locus)) : null);

  const header = h('header', { class: 'rm-head' },
    h('div', { class: 'rm-head-main' },
      h('button', { class: 'btn rm-back', type: 'button',
        onclick: () => { state.modalMode = 'detail'; state.editingHunk = null; state.exportFp = null; syncModal(); } },
        '← Back'),
      h('h2', { class: 'rm-title' }, f.title || '(untitled finding)'),
      headMeta,
    ),
    h('div', { class: 'rm-head-right' },
      hasDraft && stats.hunks.length ? h('div', { class: 'diff-toggle', role: 'group', 'aria-label': 'Diff view mode' },
        renderable ? mkTab('rendered', 'Rendered') : null, mkTab('unified', 'Unified'), mkTab('split', 'Split')) : null,
      h('button', { class: 'rm-close', type: 'button', 'aria-label': 'Close review',
        onclick: () => closeModal() }, '×'),
    ),
  );

  const verdict = draftVerdict(f);

  // For a PR finding the review surface mirrors the stepper card: the finding
  // rationale, the editable proposed comment, the (optional) diff, and the
  // kind-aware decision row. Spec findings keep the pure diff-review body.
  const bodyKids = [];
  if (isPr) {
    if (f.detail) bodyKids.push(mdBlock(f.detail, 'rm-detail'));
    bodyKids.push(suggestionSection(kind, f));
    if (hasDraft) bodyKids.push(...reviewBodyKids(f));
    bodyKids.push(decisionRow(data, f));
  } else {
    bodyKids.push(...reviewBodyKids(f));
  }

  const exportOpen = state.exportFp === f.fp;
  // Export / discard act on a code-diff draft, so only show them when there is one.
  const footer = hasDraft ? h('footer', { class: 'rm-foot' },
    stats.hunks.length ? h('button', {
      class: `btn ${exportOpen ? 'btn-accent' : ''}`, type: 'button',
      onclick: () => { state.exportFp = exportOpen ? null : f.fp; refreshModal(); },
    }, exportOpen ? 'Hide export' : 'Export decisions') : null,
    h('button', { class: 'btn btn-danger', type: 'button',
      onclick: () => discardDraft(f.fp) }, 'Discard draft'),
  ) : null;

  const banner = verdict !== 'proposed'
    ? h('div', { class: `rm-verdict-banner verdict-${verdict}` },
        h('span', { class: 'verdict-glyph' }, VERDICT_GLYPH[verdict]),
        verdict === 'reject'
          ? 'Rejected — the proposed change below is overridden by your note; the agent will not apply it.'
          : 'Redirect — the proposed change below is superseded; the agent will follow your note instead.')
    : null;

  return h('div', { class: `rm-frame ${verdict !== 'proposed' ? `rm-frame-${verdict}` : ''}`.trim() },
    header,
    banner,
    h('div', { class: 'rm-body' }, bodyKids),
    exportOpen ? h('div', { class: 'rm-export' }, exportPanel(state.detail && state.detail.feature, [f], 'finding')) : null,
    footer,
  );
}

/* Finding-level counter-proposal: a compact verdict control (Proposed · Redirect ·
 * Reject) plus a free-text note to the coding agent. Both are FINDING-level (not
 * per-hunk). The note persists debounced on input + on blur WITHOUT re-rendering
 * (so the textarea keeps focus); the verdict persists on click and re-renders so
 * the banner / board marker update. */
function reviewNoteSection(f) {
  const stop = (e) => e.stopPropagation();
  const verdict = draftVerdict(f);

  const mkV = (val) => h('button', {
    class: `btn verdict-btn verdict-btn-${val} ${verdict === val ? 'active' : ''}`,
    type: 'button',
    'aria-pressed': verdict === val ? 'true' : 'false',
    title: val === 'redirect' ? 'Do it differently / elsewhere — see note'
      : val === 'reject' ? "Don't apply this at all" : 'Apply the proposed change',
    onclick: (e) => { e.stopPropagation(); setVerdict(f.fp, val); },
  }, VERDICT_LABEL[val]);

  const saved = h('span', { class: 'note-saved', 'aria-live': 'polite' },
    draftNote(f).trim() ? 'saved' : '');
  let timer = null;
  const ta = h('textarea', {
    class: 'review-note-ta', rows: '3', spellcheck: 'true',
    'aria-label': 'Note to the agent / counter-proposal',
    placeholder: "Wrong target? Reject and say where/how it should be done instead — e.g. 'these belong in systemProperties, not the component-fields table'.",
    onclick: stop,
    onkeydown: (e) => e.stopPropagation(),
    oninput: () => { saved.textContent = ''; if (timer) clearTimeout(timer); timer = setTimeout(commit, 600); },
    onblur: () => { if (timer) { clearTimeout(timer); timer = null; } commit(); },
  });
  ta.value = draftNote(f);

  let lastSaved = ta.value;
  async function commit() {
    const val = ta.value;
    if (val === lastSaved) { if (val.trim()) saved.textContent = 'saved'; return; }
    lastSaved = val;
    const cur = findFinding(f.fp);
    if (cur && cur.draft) {
      cur.draft.review = { ...(cur.draft.review || {}), hunks: (cur.draft.review && cur.draft.review.hunks) || {}, note: val };
    }
    try {
      await api(`/api/features/${encodeURIComponent(current.id)}/findings/${encodeURIComponent(f.fp)}/draft/review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: val }),
      });
      saved.textContent = 'saved';
    } catch (e) {
      saved.textContent = '';
      toast(`Note save failed: ${e.message}`);
    }
  }

  // When the proposal is redirected (rejected with a counter), offer to fire the loop:
  // POST /counter records the redirect + note AND queues a scoped re-audit so the proposer
  // re-evaluates just this item against the counter and re-drafts.
  const reauditBtn = verdict === 'redirect'
    ? h('button', {
        class: 'btn btn-accent reaudit-btn', type: 'button',
        title: 'Send your counter and re-audit just this item against it (a scoped re-audit job is queued for /flowlever:watch).',
        onclick: (e) => { e.stopPropagation(); sendCounter(f, ta); },
      }, '↻ Send counter & re-audit')
    : null;

  // The note only matters once you disagree — its own placeholder says so ("Wrong target?
  // Reject and say where/how…"). Rendered open on every card it cost ~100px of the card's
  // height for the rarest action, so it now appears with the verdict that needs it (or when
  // a note already exists), and stays one click away otherwise.
  const body = h('div', { class: 'review-note-body' });
  if (verdict !== 'proposed' || draftNote(f).trim()) {
    body.append(ta);
    if (reauditBtn) body.append(reauditBtn);
  } else {
    body.append(h('button', {
      class: 'btn note-add-btn', type: 'button',
      title: 'Leave a note for the agent without changing the verdict',
      onclick: (e) => { e.stopPropagation(); body.replaceChildren(ta); ta.focus(); },
    }, '＋ Add note'));
  }

  return h('div', { class: 'review-note', onclick: stop },
    h('div', { class: 'review-note-head' },
      h('span', { class: 'f-suglabel' }, 'Note to the agent / counter-proposal'),
      h('div', { class: 'verdict-control', role: 'group', 'aria-label': 'Finding verdict' },
        mkV('proposed'), mkV('redirect'), mkV('reject')),
      saved,
    ),
    body,
  );
}

/* Reject + counter: POST the counter to /counter, which records verdict=redirect + the note
 * AND enqueues a SCOPED re-audit so the proposer re-evaluates just this item against the
 * counter and re-drafts — the per-item refine loop the spec section mirrors from PR review. */
async function sendCounter(f, ta) {
  const note = ((ta && ta.value) || draftNote(f) || '').trim();
  if (!note) { toast('Write your counter-proposal in the note first'); return; }
  try {
    const res = await api(`/api/features/${encodeURIComponent(current.id)}/findings/${encodeURIComponent(f.fp)}/counter`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note }),
    });
    const cur = findFinding(f.fp);
    if (cur && res && res.finding && res.finding.draft) cur.draft = res.finding.draft;
    toast('Counter sent — scoped re-audit queued', 'success');
    ensureApplyPolling();
    pollRequestsNow();
    refreshModal();
  } catch (e) {
    toast(`Could not send counter: ${e.message}`);
  }
}

/* Optimistic finding-level verdict op: mutate locally, POST { verdict }, re-render
 * so the banner + board marker reflect it. No server reload — keeps it independent
 * of an in-flight note save (the server merges the two fields). */
async function setVerdict(fp, verdict) {
  const f = findFinding(fp);
  if (!f || !f.draft) return;
  const prev = f.draft.review ? structuredClone(f.draft.review) : undefined;
  const cur = f.draft.review || {};
  f.draft.review = { ...cur, hunks: cur.hunks || {}, verdict, updatedAt: new Date().toISOString() };
  refreshModal();
  try {
    await api(`/api/features/${encodeURIComponent(current.id)}/findings/${encodeURIComponent(fp)}/draft/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verdict }),
    });
  } catch (e) {
    if (prev === undefined) delete f.draft.review; else f.draft.review = prev;
    refreshModal();
    toast(`Verdict update failed: ${e.message}`);
  }
}

/* A single reviewable hunk: its mini diff + decision controls (or the edit form). */
function hunkEl(f, hunk, decision) {
  const status = (decision && decision.status) || 'undecided';
  const editing = state.editingHunk && state.editingHunk.fp === f.fp && state.editingHunk.idx === hunk.id;
  const rendered = !editing && canRenderProse(f) && state.diffMode === 'rendered';
  const parts = [
    h('div', { class: `hunk-diff${rendered ? ' hunk-diff-rendered' : ''}` },
      rendered ? renderedHunkEl(f, hunk)
        : (state.diffMode === 'split' ? diffSplit(hunk.rows) : diffUnified(hunk.rows))),
  ];
  if (editing) {
    parts.push(hunkEditForm(f, hunk, decision));
  } else {
    parts.push(hunkControls(f, hunk, status));
    if (status === 'edited' && decision && typeof decision.editedText === 'string') {
      parts.push(h('div', { class: 'hunk-edited-note' },
        h('span', { class: 'f-suglabel' }, 'applied edit'),
        h('pre', { class: 'hunk-edited-text' }, decision.editedText || '(empty — these lines are removed)')));
    }
  }
  return h('div', { class: `hunk hunk-${status}` }, parts);
}

function hunkControls(f, hunk, status) {
  const mk = (label, target, cls) => h('button', {
    class: `btn hunk-btn ${cls} ${status === target ? 'active' : ''}`,
    type: 'button',
    'aria-pressed': status === target ? 'true' : 'false',
    onclick: (e) => {
      e.stopPropagation();
      if (target === 'edited') { state.editingHunk = { fp: f.fp, idx: hunk.id }; refreshModal(); return; }
      // toggling the active decision clears it back to undecided
      reviewHunk(f.fp, { hunk: hunk.id, status: status === target ? 'undecided' : target });
    },
  }, label);
  return h('div', { class: 'hunk-actions' },
    mk('✅ Accept', 'accepted', 'hunk-accept'),
    mk('❌ Reject', 'rejected', 'hunk-reject'),
    mk('✏️ Edit', 'edited', 'hunk-edit'),
  );
}

function hunkEditForm(f, hunk, decision) {
  const initial = decision && decision.status === 'edited' && typeof decision.editedText === 'string'
    ? decision.editedText : hunkAfterText(hunk);
  const ta = h('textarea', {
    class: 'hunk-edit-ta', spellcheck: 'false',
    rows: String(Math.min(14, Math.max(2, initial.split('\n').length + 1))),
    'aria-label': 'Edited replacement text',
    onclick: (e) => e.stopPropagation(),
    onkeydown: (e) => { e.stopPropagation(); if (e.key === 'Escape') cancel(); },
  });
  ta.value = initial;
  function save() {
    state.editingHunk = null;
    reviewHunk(f.fp, { hunk: hunk.id, status: 'edited', editedText: ta.value });
  }
  function cancel() { state.editingHunk = null; refreshModal(); }
  function reset() { ta.value = hunkAfterText(hunk); ta.focus(); }
  const form = h('div', { class: 'hunk-edit', onclick: (e) => e.stopPropagation() },
    h('div', { class: 'hunk-edit-label meta-dim' }, 'Edit the replacement text, then Save:'),
    ta,
    h('div', { class: 'hunk-edit-actions' },
      h('button', { class: 'btn btn-accent', type: 'button', onclick: (e) => { e.stopPropagation(); save(); } }, 'Save edit'),
      h('button', { class: 'btn', type: 'button', onclick: (e) => { e.stopPropagation(); reset(); } }, 'Reset to proposal'),
      h('button', { class: 'btn', type: 'button', onclick: (e) => { e.stopPropagation(); cancel(); } }, 'Cancel'),
    ));
  requestAnimationFrame(() => ta.focus());
  return form;
}

/* Optimistic per-hunk review op: mutate locally, POST the single-hunk patch,
 * then reconcile from the server (authoritative). */
async function reviewHunk(fp, patch) {
  const d = state.detail;
  if (!d) return;
  const findings = (d.ledger && d.ledger.findings) || [];
  const f = findings.find((x) => x.fp === fp);
  if (!f || !f.draft) return;
  const prev = f.draft.review ? structuredClone(f.draft.review) : undefined;

  const hunks = { ...((f.draft.review && f.draft.review.hunks) || {}) };
  const idx = String(patch.hunk);
  if (patch.status === 'undecided' || patch.status == null) {
    delete hunks[idx];
  } else {
    const entry = { status: patch.status, at: new Date().toISOString() };
    if (patch.status === 'edited') entry.editedText = patch.editedText;
    hunks[idx] = entry;
  }
  f.draft.review = { hunks, updatedAt: new Date().toISOString() };
  refreshModal();

  try {
    await api(`/api/features/${encodeURIComponent(current.id)}/findings/${encodeURIComponent(fp)}/draft/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    await loadDetail(current.id, true); // server state is authoritative
    refreshModal();
  } catch (e) {
    if (prev === undefined) delete f.draft.review; else f.draft.review = prev;
    refreshModal();
    toast(`Review update failed: ${e.message}`);
  }
}

/* ---- export: build a copy-pasteable work order from the review decisions ---- */

function mdBlock(text) {
  const t = String(text);
  if (t === '') return '  - _(empty — remove the shown lines)_';
  if (!t.includes('\n')) return `  - ${t}`;
  return '  -\n    ```\n' + t.split('\n').map((l) => `    ${l}`).join('\n') + '\n    ```';
}

function buildExportMarkdown(feature, findings) {
  const title = (feature && (feature.title || feature.id)) || 'feature';
  const date = new Date().toISOString().slice(0, 10);
  const out = [`## Rework decisions — ${title} (${date})`, ''];

  // One section per reviewed finding/target. The finding-level verdict (redirect /
  // reject) overrides the per-hunk proposal; a plain note rides alongside it.
  let sectionCount = 0;
  for (const f of findings) {
    if (!f.draft) continue;
    const review = f.draft.review || {};
    const verdict = review.verdict || 'proposed';
    const note = (review.note || '').trim();
    const decisions = review.hunks || {};
    const hunks = groupHunks(lcsDiff(f.draft.before, f.draft.after).rows);

    // Skip findings with nothing to say: no hunks, no note, default verdict.
    if (!hunks.length && verdict === 'proposed' && !note) continue;

    const target = (f.draft.target && f.draft.target.trim()) || f.locus || '—';
    out.push(`### ${target}`, '');
    sectionCount++;

    if (verdict === 'reject') {
      // Reviewer rejected the whole proposal — the agent must not apply it.
      out.push(`🚫 DO NOT APPLY — ${note || '(reviewer gave no note)'}`, '');
    } else if (verdict === 'redirect') {
      // Apply differently / elsewhere; show the original proposal as muted context.
      out.push(`✋ APPLY DIFFERENTLY — ${note || '(reviewer gave no note)'}`, '');
      const orig = hunks.map(hunkAfterText).filter((t) => t.trim());
      if (orig.length) {
        out.push('_(original proposal, superseded)_');
        orig.forEach((t) => out.push(mdBlock(t)));
        out.push('');
      }
    } else {
      // Plain proposed: the normal Apply / Edit / Skip / Undecided buckets…
      const g = { accepted: [], edited: [], rejected: [], undecided: [] };
      for (const hunk of hunks) {
        const dec = decisions[String(hunk.id)];
        const status = dec && dec.status;
        if (status === 'accepted') g.accepted.push(hunkAfterText(hunk));
        else if (status === 'edited') g.edited.push(typeof dec.editedText === 'string' ? dec.editedText : hunkAfterText(hunk));
        else if (status === 'rejected') g.rejected.push(hunkGist(hunk));
        else g.undecided.push(hunkGist(hunk));
      }
      if (g.accepted.length) { out.push('✅ APPLY AS PROPOSED'); g.accepted.forEach((t) => out.push(mdBlock(t))); out.push(''); }
      if (g.edited.length) { out.push('✏️ APPLY WITH EDITS'); g.edited.forEach((t) => out.push(mdBlock(t))); out.push(''); }
      if (g.rejected.length) { out.push('❌ SKIP'); g.rejected.forEach((t) => out.push(`  - ${t}`)); out.push(''); }
      if (g.undecided.length) { out.push('⏳ UNDECIDED'); g.undecided.forEach((t) => out.push(`  - ${t}`)); out.push(''); }
      // …plus a free-text note if the reviewer left one.
      if (note) { out.push(`📝 NOTE: ${note}`, ''); }
    }
  }

  if (!sectionCount) { out.push('_No reviewed drafts yet._'); return out.join('\n') + '\n'; }
  return out.join('\n').trimEnd() + '\n';
}

/* readonly textarea (text content ⇒ XSS-safe) + clipboard copy. */
function exportPanel(feature, findings, scope) {
  const md = buildExportMarkdown(feature, findings);
  const ta = h('textarea', {
    class: 'export-md', readonly: true, spellcheck: 'false',
    'aria-label': 'Exported rework decisions work order',
    onclick: (e) => e.stopPropagation(),
  });
  ta.value = md;
  return h('div', { class: `export-panel export-${scope}`, onclick: (e) => e.stopPropagation() },
    h('div', { class: 'export-bar' },
      h('span', { class: 'f-suglabel' }, scope === 'finding' ? 'Work order — this finding' : 'Work order — all reviewed drafts'),
      h('button', { class: 'btn btn-accent', type: 'button',
        onclick: (e) => { e.stopPropagation(); copyExport(md); } }, 'Copy'),
    ),
    ta,
  );
}

async function copyExport(md) {
  try {
    await navigator.clipboard.writeText(md);
    toast('Work order copied', 'success');
  } catch {
    toast('Clipboard unavailable');
  }
}

/* Feature-level panel: a single work order spanning every reviewed draft. */
function featureExportPanel(data) {
  const feature = data.feature || {};
  const findings = ((data.ledger && data.ledger.findings) || []).filter(isReviewed);
  if (!findings.length) {
    return h('div', { class: 'export-panel export-feature' },
      h('div', { class: 'export-bar' }, h('span', { class: 'f-suglabel' }, 'Work order — all reviewed drafts')),
      h('p', { class: 'meta-dim export-empty' }, 'No reviewed drafts yet — accept, reject or edit hunks on a finding first.'));
  }
  return exportPanel(feature, findings, 'feature');
}

/* Optimistic draft discard: drop locally, DELETE, then reconcile from server. */
async function discardDraft(fp) {
  const d = state.detail;
  if (!d) return;
  const findings = (d.ledger && d.ledger.findings) || [];
  const f = findings.find((x) => x.fp === fp);
  if (!f || !f.draft) return;
  const prev = f.draft;
  delete f.draft;
  refreshModal();   // draft gone → review view falls back to the detail view
  try {
    await api(`/api/features/${encodeURIComponent(current.id)}/findings/${encodeURIComponent(fp)}/draft`, {
      method: 'DELETE',
    });
    await loadDetail(current.id, true); // server state is authoritative
    refreshModal();
    toast('Draft discarded', 'success');
  } catch (e) {
    f.draft = prev;
    refreshModal();
    toast(`Discard failed: ${e.message}`);
  }
}

/* ============================== findings tab ============================== */

function findingsView(data) {
  const findings = (data.ledger && data.ledger.findings) || [];
  const dims = [...new Set([...DIMENSIONS, ...findings.map((f) => f.dimension).filter(Boolean)])];
  const fl = state.filters;

  const dimChips = dims.map((d) => h('button', {
    class: `fchip ${fl.dims.has(d) ? 'active' : ''}`,
    type: 'button',
    onclick: (e) => {
      if (fl.dims.has(d)) fl.dims.delete(d); else fl.dims.add(d);
      e.currentTarget.classList.toggle('active');
      renderBoard();
    },
  }, d));

  const sevChips = SEV_ORDER.map((s) => h('button', {
    class: `fchip fchip-sev sev-${s} ${fl.sevs.has(s) ? 'active' : ''}`,
    type: 'button',
    onclick: (e) => {
      if (fl.sevs.has(s)) fl.sevs.delete(s); else fl.sevs.add(s);
      e.currentTarget.classList.toggle('active');
      renderBoard();
    },
  }, h('span', { class: 'sev-glyph' }, SEV[s].glyph), ' ', s));

  const draftPill = h('button', {
    class: `fchip fchip-draft ${fl.draft ? 'active' : ''}`,
    type: 'button',
    title: 'Show only findings with a proposed change',
    onclick: (e) => { fl.draft = !fl.draft; e.currentTarget.classList.toggle('active'); renderBoard(); },
  }, h('span', { class: 'draft-glyph' }, '±'), ' has draft');

  const statusSel = h('select', {
    class: 'fselect',
    'aria-label': 'Filter by status',
    onchange: (e) => { fl.status = e.target.value; renderBoard(); },
  },
    h('option', { value: 'all' }, 'All statuses'),
    STATUS_COLS.map((c) => h('option', { value: c.key, selected: fl.status === c.key }, c.label)));
  statusSel.value = fl.status;

  const search = h('input', {
    id: 'finding-search',
    class: 'fsearch',
    type: 'search',
    placeholder: 'Search findings…  ( / )',
    value: fl.q,
    oninput: (e) => { fl.q = e.target.value; renderBoard(); },
  });

  const reviewedCount = findings.filter(isReviewed).length;
  const exportAllBtn = h('button', {
    class: `fchip fchip-export ${state.exportAll ? 'active' : ''}`,
    type: 'button',
    title: 'Export all reviewed drafts as one agent work order',
    onclick: () => { state.exportAll = !state.exportAll; rerenderDetail(); },
  }, '⬇ Export reviewed', reviewedCount ? h('span', { class: 'fchip-count num' }, String(reviewedCount)) : null);

  const wrap = h('div', { class: 'findings-wrap' },
    h('div', { class: 'filterbar' },
      h('div', { class: 'fgroup' }, h('span', { class: 'fgroup-label' }, 'dimension'), dimChips),
      h('div', { class: 'fgroup' }, h('span', { class: 'fgroup-label' }, 'severity'), sevChips),
      h('div', { class: 'fgroup fgroup-end' }, draftPill, statusSel, search, exportAllBtn),
    ),
    state.exportAll ? featureExportPanel(data) : null,
    h('div', { id: 'board', class: 'board' }),
  );
  buildBoard(wrap.querySelector('#board'), findings);
  return wrap;
}

function matchesFilters(f) {
  const fl = state.filters;
  if (fl.dims.size && !fl.dims.has(f.dimension)) return false;
  if (fl.sevs.size && !fl.sevs.has(f.severity)) return false;
  if (fl.status !== 'all' && f.status !== fl.status) return false;
  if (fl.draft && !f.draft) return false;
  if (fl.q) {
    const q = fl.q.toLowerCase();
    const hay = `${f.title ?? ''} ${f.detail ?? ''} ${f.locus ?? ''} ${f.fp ?? ''} ${f.dimension ?? ''}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function renderBoard() {
  const board = $('#board');
  if (!board || !state.detail) return;
  buildBoard(board, (state.detail.ledger && state.detail.ledger.findings) || []);
}

function buildBoard(board, findings) {
  const filtered = findings.filter(matchesFilters);
  const sevRank = (s) => { const i = SEV_ORDER.indexOf(s); return i === -1 ? SEV_ORDER.length : i; };
  // Posted findings (comment sent, awaiting author) are reworking under the hood but get their
  // own lane so they read as "out, not in-progress". Inserted after Reworking, PR kinds only.
  const kind = (state.detail && state.detail.feature && state.detail.feature.kind) || 'spec';
  const isPr = kind === 'pr-review' || kind === 'pr-respond';
  // After Reworking, insert the transient in-flight lane (Posting…/Applying…) and the
  // "out, awaiting reconcile" lane (Posted — awaiting author for PR, Applied — awaiting re-audit
  // for spec). These are derived from the pending marker + the postedAt/appliedAt stamp, so an
  // item only reads "done-ish" once the runner has actually written it back.
  const inflightLane = isPr
    ? { key: 'pending', label: 'Posting…' }
    : { key: 'pending', label: 'Applying…' };
  const outLane = isPr
    ? { key: 'posted', label: 'Posted — awaiting author' }
    : { key: 'applied', label: 'Applied — awaiting re-audit' };
  const cols = [];
  for (const col of STATUS_COLS) {
    cols.push(col);
    if (col.key === 'reworking') { cols.push(inflightLane); cols.push(outLane); }
  }
  const inCol = (f, key) => {
    if (key === 'pending') return isPending(f);
    if (key === 'posted') return isPosted(f);
    if (key === 'applied') return isApplied(f);
    // base status lanes never show a finding that's in-flight or already out
    return f.status === key && !isInFlightOrOut(f);
  };
  board.classList.toggle('board-pr', true);          // wider grid: adds the in-flight + out lanes
  board.replaceChildren(...cols.map((col) => {
    const items = filtered
      .filter((f) => inCol(f, col.key))
      .sort((a, b) => sevRank(a.severity) - sevRank(b.severity)
        || String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
    return h('section', { class: `col col-${col.key}${items.length ? '' : ' col-vacant'}` },
      h('header', { class: 'col-head' },
        h('span', { class: 'col-title' }, col.label),
        h('span', { class: 'col-count num' }, String(items.length))),
      h('div', { class: 'col-body' },
        items.length ? items.map(findingCard) : h('div', { class: 'col-empty' }, '—')),
    );
  }).flat());
}

/* Compact board card: severity glyph, title, dimension tag, locus and a ±
 * indicator when the finding carries a draft. The whole card is a button that
 * opens the finding in the roomy modal — no inline expansion. */
function findingCard(f) {
  const sev = SEV[f.severity] ? f.severity : 'info';
  const open = state.modalFp === f.fp;
  const badge = findingBadge(f, currentRoundNum());
  const card = h('article', {
    class: `finding sevb-${sev} ${open ? 'open' : ''} ${f.pinned ? 'pinned' : ''}`,
    dataset: { fp: f.fp },
    tabindex: '0',
    role: 'button',
    'aria-haspopup': 'dialog',
    onclick: (e) => openModal(f.fp, e.currentTarget),
    onkeydown: (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
        e.preventDefault(); openModal(f.fp, e.currentTarget);
      }
    },
  },
    h('div', { class: 'f-head' },
      h('span', { class: `sev-glyph sev-${sev}`, title: SEV[sev].label }, SEV[sev].glyph),
      h('span', { class: 'f-title' }, f.title || '(untitled finding)'),
      f.pinned ? iconSpan('pin', 'icon f-pin') : null,
    ),
    h('div', { class: 'f-tags' },
      f.dimension ? h('span', { class: 'dim-tag' }, f.dimension) : null,
      badge ? h('span', { class: `f-badge f-badge-${badge}` }, badge === 'new' ? 'NEW' : 'REGRESSED') : null,
      duplicateChip(f),
      notDuplicateChip(f),
      // A drafted proposal that hasn't been decided yet → a clear "review me" cue.
      (f.draft && f.draft.targetRef && !isReviewed(f) && f.decision === undefined && !isInFlightOrOut(f))
        ? h('span', { class: 'f-review-chip', title: 'A proposed change is ready — open to review' }, '± review')
        : (f.draft ? h('span', { class: 'f-draft-chip', title: 'Has a proposed change' }, '±') : null),
      decisionChip(f),
      fixCommitChip(f),
      verdictChip(f),
      f.locus ? h('code', { class: 'f-locus' }, f.locus) : null,
    ),
  );
  return card;
}

/* Board / header marker shown when a finding's proposal is overridden by a
 * redirect or reject verdict. Null for the default 'proposed' verdict. */
/* Board chip for a persisted triage decision on a not-yet-posted PR comment, so the
 * board shows "Will post" / "Edited" without opening the card. (Dismissed findings already
 * move to the Waived lane; posted ones to the Posted lane.) */
/* Amber DUPLICATE chip: instantly flags a finding that mirrors an already-raised comment.
 * Links to the canonical comment when duplicateOf.url is set (click must not open the modal). */
function duplicateChip(f) {
  const d = f.duplicateOf;
  if (!d || !d.label) return null;
  const title = `Duplicate of ${d.label} — the full answer lives there`;
  if (d.url) {
    return h('a', { class: 'f-dup-chip', href: d.url, target: '_blank', rel: 'noopener', title,
      onclick: (e) => e.stopPropagation() }, 'DUPLICATE ↗');
  }
  return h('span', { class: 'f-dup-chip', title }, 'DUPLICATE');
}

/* The other side of the duplicate gate: this finding landed within a few lines of an existing
 * thread and the review argued it is a different point. Showing the stated reason on the board
 * makes that judgement reviewable — a weak reason is the tell that it IS a duplicate. */
function notDuplicateChip(f) {
  if (f.duplicateOf || !f.notDuplicate) return null;
  return h('span', { class: 'f-notdup-chip', title: `Near an existing thread; kept as a distinct point — ${f.notDuplicate}` }, 'DISTINCT');
}

function decisionChip(f) {
  if (isPosted(f) || f.status === 'waived') return null;
  if (f.decision === 'approve') return h('span', { class: 'f-dec-chip dec-accept', title: 'Approved — will post' }, 'Will post');
  if (f.decision === 'edit') return h('span', { class: 'f-dec-chip dec-edit', title: 'Edited — will post' }, 'Edited');
  if (f.decision === 'fix-only') return h('span', { class: 'f-dec-chip dec-fixonly', title: 'Fix will be pushed; no reply will be posted' }, 'Fix, no reply');
  return null;
}

/* Does this finding owe a code change? Mirrors ledger.isAgreedCodeFix — a before→after draft that
 * actually changes something and was signed off, either finding-level or hunk-by-hunk. */
function isAgreedCodeFix(f) {
  const d = f.draft;
  if (!d || typeof d.after !== 'string' || d.after === d.before) return false;
  const rv = d.review || {};
  if (rv.verdict === 'redirect' || rv.verdict === 'reject') return false;
  if (f.decision === 'edit' || f.decision === 'fix-only') return true;
  return Object.values(rv.hunks || {}).some((h) => h && (h.status === 'accepted' || h.status === 'edited'));
}

/* The proof, or the absence of it. A fix that landed shows its commit; a fix claimed done with NO
 * commit behind it gets a loud red chip — that combination means the reviewer was told their point
 * was handled while the branch never changed, which is the failure this whole gate exists to stop.
 * Legacy findings stamped before the gate existed surface here too, which is intended. */
function fixCommitChip(f) {
  const owed = isAgreedCodeFix(f);
  const sha = f.fixCommit && f.fixCommit.sha;
  if (sha) {
    return h('span', {
      class: 'f-fix-chip',
      title: `Fix pushed in ${sha}${f.fixCommit.branch ? ` on ${f.fixCommit.branch}` : ''}${f.fixCommit.repo ? ` (${f.fixCommit.repo})` : ''}`,
    }, `✔ fix ${sha.slice(0, 8)}`);
  }
  if (owed && (isPosted(f) || f.status === 'resolved')) {
    return h('span', {
      class: 'f-fix-chip f-fix-missing',
      title: 'This was closed as handled but no commit carries the change — the branch does not contain the fix. Reopen it and redo the fix.',
    }, '⚠ fix not pushed');
  }
  return null;
}

function verdictChip(f) {
  if (!f.draft) return null;
  const v = draftVerdict(f);
  if (v === 'proposed') return null;
  return h('span', {
    class: `f-verdict-chip f-verdict-${v}`,
    title: v === 'reject' ? 'Rejected — do not apply (see note)' : 'Redirect — apply differently (see note)',
  }, `${VERDICT_GLYPH[v]} ${v === 'reject' ? 'REJECT' : 'REDIRECT'}`);
}

function findingBody(f) {
  const stop = (e) => e.stopPropagation();
  const meta = [];
  meta.push(h('span', {}, 'fp ', h('code', {}, f.fp ?? '?')));
  if (f.firstSeenRound != null) {
    meta.push(h('span', { class: 'num-line' },
      `seen r${f.firstSeenRound}` + (f.lastSeenRound != null && f.lastSeenRound !== f.firstSeenRound ? `–r${f.lastSeenRound}` : '')));
  }
  if (f.resolvedInRound != null) meta.push(h('span', { class: 'num-line' }, `resolved r${f.resolvedInRound}`));
  if (f.status === 'waived' && f.statusReason) meta.push(h('span', { class: 'waive-reason' }, 'waived: ', f.statusReason));

  const history = Array.isArray(f.history) && f.history.length
    ? h('ul', { class: 'f-history' }, f.history.map((ev) =>
        h('li', {},
          h('span', { class: 'meta-dim num-line' }, fmtDateTime(ev.at) || '?'),
          ` ${ev.from ?? '?'} → ${ev.to ?? '?'} `,
          h('span', { class: 'meta-dim' }, `(${ev.by ?? '?'})`),
          ev.note ? h('span', { class: 'hist-note' }, ` — ${ev.note}`) : null)))
    : null;

  return h('div', { class: 'f-body', onclick: stop },
    f.detail ? mdBlock(f.detail, 'f-detail') : null,
    f.suggestion ? h('div', { class: 'f-suggestion' },
      h('span', { class: 'f-suglabel' }, 'suggestion'),
      mdBlock(f.suggestion, 'md-prose')) : null,
    f.draft ? reviewTrigger(f) : null,
    h('div', { class: 'f-meta' }, meta),
    history ? h('div', { class: 'f-histwrap' }, h('span', { class: 'f-suglabel' }, 'history'), history) : null,
    state.waiving === f.fp ? waiveForm(f) : actionsRow(f),
  );
}

function actionsRow(f) {
  // PR-kind workspaces use the kind-aware triage (Approve/Edit/Dismiss · Reply/
  // Apply fix/Push back/Skip), NOT the spec lifecycle verbs — same decision row
  // and underlying state.flow the stepper uses, so the two agree. Spec/default
  // keeps the Reworking / Resolved / Waive / Pin lifecycle below.
  const kind = (state.detail && state.detail.feature && state.detail.feature.kind) || 'spec';
  const btn = (label, body, cls = '') => h('button', {
    class: `btn ${cls}`.trim(),
    type: 'button',
    onclick: (e) => { e.stopPropagation(); doAction(f.fp, body); },
  }, label);
  if (kind === 'pr-review' || kind === 'pr-respond') {
    // A posted comment is past triage — it's awaiting the author. Offer manual override so it
    // can be closed/resolved at any time (no author response needed) or reopened to re-comment,
    // rather than the Approve/Edit/Dismiss triage row that only applies before posting.
    if (isPosted(f)) {
      const waiveBtnP = h('button', { class: 'btn', type: 'button',
        onclick: (e) => { e.stopPropagation(); state.waiving = f.fp; refreshModal(); } }, '→ Dismiss');
      return h('div', { class: 'f-actions' },
        h('span', { class: 'f-posted-note meta-dim' }, 'Posted — awaiting author.'),
        btn('✓ Mark resolved', { status: 'resolved' }, 'btn-good'),
        btn('↺ Reopen (re-comment)', { status: 'open' }),
        waiveBtnP);
    }
    ensureFlow();
    return decisionRow(state.detail, f);
  }
  const waiveBtn = h('button', {
    class: 'btn',
    type: 'button',
    onclick: (e) => { e.stopPropagation(); state.waiving = f.fp; refreshModal(); },
  }, '→ Waive');

  const out = [];
  if (f.status === 'open') {
    out.push(btn('→ Reworking', { status: 'reworking' }),
      btn('→ Resolved', { status: 'resolved' }, 'btn-good'), waiveBtn);
  } else if (f.status === 'reworking') {
    out.push(btn('→ Resolved', { status: 'resolved' }, 'btn-good'), waiveBtn,
      btn('Reopen', { status: 'open' }));
  } else {
    out.push(btn('Reopen', { status: 'open' }));
  }
  out.push(h('button', {
    class: `btn btn-pin ${f.pinned ? 'active' : ''}`,
    type: 'button',
    title: f.pinned ? 'Unpin (allow auto-resolve)' : 'Pin (never auto-resolve)',
    onclick: (e) => { e.stopPropagation(); doAction(f.fp, { pinned: !f.pinned }); },
  }, iconSpan('pin', 'icon'), ' ', f.pinned ? 'Pinned' : 'Pin'));
  return h('div', { class: 'f-actions' }, out);
}

function waiveForm(f) {
  const input = h('input', {
    class: 'waive-input',
    type: 'text',
    placeholder: 'Reason (required)',
    'aria-label': 'Waive reason',
    onclick: (e) => e.stopPropagation(),
    onkeydown: (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') submit();
      if (e.key === 'Escape') cancel();
    },
  });
  function submit() {
    const reason = input.value.trim();
    if (!reason) {
      input.classList.add('invalid');
      input.focus();
      return;
    }
    doAction(f.fp, { status: 'waived', reason });
  }
  function cancel() { state.waiving = null; refreshModal(); }
  const form = h('div', { class: 'waive-form', onclick: (e) => e.stopPropagation() },
    input,
    h('button', { class: 'btn btn-accent', type: 'button', onclick: submit }, 'Waive'),
    h('button', { class: 'btn', type: 'button', onclick: cancel }, 'Cancel'),
  );
  requestAnimationFrame(() => input.focus());
  return form;
}

/* Optimistic lifecycle op: mutate locally, POST, then reconcile from server. */
async function doAction(fp, body) {
  const d = state.detail;
  if (!d) return;
  const findings = (d.ledger && d.ledger.findings) || [];
  const f = findings.find((x) => x.fp === fp);
  if (!f) return;
  const prev = { status: f.status, statusReason: f.statusReason, pinned: f.pinned, updatedAt: f.updatedAt };

  if (body.status !== undefined) {
    f.status = body.status;
    f.statusReason = body.reason ?? null;
  }
  if (body.pinned !== undefined) f.pinned = body.pinned;
  f.updatedAt = new Date().toISOString();
  state.waiving = null;
  d.readiness = computeReadiness(findings);
  rerenderDetail();
  syncModal();

  try {
    await api(`/api/features/${encodeURIComponent(current.id)}/findings/${encodeURIComponent(fp)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    await loadDetail(current.id, true); // server state is authoritative
    rerenderDetail();
    syncModal();
  } catch (e) {
    Object.assign(f, prev);
    d.readiness = computeReadiness(findings);
    rerenderDetail();
    syncModal();
    toast(`Update failed: ${e.message}`);
  }
}

/* ============================== coverage tab ============================== */

function coverageView(data) {
  const feature = data.feature || {};
  const sections = feature.specSections || [];
  const coverage = feature.coverage || [];
  if (!sections.length && !coverage.length) {
    return h('div', { class: 'empty empty-tab' },
      h('h2', {}, 'No coverage data yet'),
      h('p', {}, 'Coverage is filled in by an audit round (', h('code', {}, '/flowlever:audit'),
        ') or via ', h('code', {}, 'coverage set'), '.'));
  }

  const sources = feature.sources || {};
  const adoById = new Map((sources.ado || []).map((it) => [String(it.id), it]));
  const figmaByNode = new Map((sources.figma || []).map((it) => [String(it.nodeId), it]));

  const adoChip = (id) => {
    const src = adoById.get(String(id));
    const href = src ? safeHref(src.url) : null;
    const label = `#${id}`;
    const title = src && src.title ? src.title : undefined;
    return href
      ? h('a', { class: 'mchip mchip-ado', href, target: '_blank', rel: 'noopener noreferrer', title }, label)
      : h('span', { class: 'mchip mchip-ado', title }, label);
  };
  const figmaChip = (nodeId) => {
    const src = figmaByNode.get(String(nodeId));
    const href = src ? safeHref(src.url) : null;
    const label = src && src.title ? src.title : String(nodeId);
    return href
      ? h('a', { class: 'mchip mchip-figma', href, target: '_blank', rel: 'noopener noreferrer' }, label)
      : h('span', { class: 'mchip mchip-figma' }, label);
  };
  const statusCell = (status) => {
    const s = ['covered', 'partial', 'uncovered', 'orphan'].includes(status) ? status : 'uncovered';
    return h('span', { class: `cov-status cov-${s}` }, h('span', { class: 'cov-dot' }), s);
  };

  const covBySection = new Map(coverage.filter((c) => c.sectionKey).map((c) => [c.sectionKey, c]));
  const rows = sections.map((sec) => {
    const entry = covBySection.get(sec.key);
    return h('tr', {},
      h('td', { class: 'cov-section' }, sec.title || sec.key),
      h('td', {}, h('div', { class: 'chiprow' },
        entry && entry.adoIds && entry.adoIds.length ? entry.adoIds.map(adoChip) : h('span', { class: 'meta-dim' }, '—'))),
      h('td', {}, h('div', { class: 'chiprow' },
        entry && entry.figmaNodeIds && entry.figmaNodeIds.length ? entry.figmaNodeIds.map(figmaChip) : h('span', { class: 'meta-dim' }, '—'))),
      h('td', {}, statusCell(entry ? entry.status : 'uncovered')),
    );
  });

  // orphans: explicit orphan entries + sources never referenced by a section row
  const referencedAdo = new Set();
  const referencedFigma = new Set();
  for (const c of coverage) {
    if (c.status === 'orphan' || !c.sectionKey) continue;
    (c.adoIds || []).forEach((id) => referencedAdo.add(String(id)));
    (c.figmaNodeIds || []).forEach((n) => referencedFigma.add(String(n)));
  }
  const orphanAdo = new Set();
  const orphanFigma = new Set();
  for (const c of coverage) {
    if (c.status !== 'orphan' && c.sectionKey) continue;
    (c.adoIds || []).forEach((id) => orphanAdo.add(String(id)));
    (c.figmaNodeIds || []).forEach((n) => orphanFigma.add(String(n)));
  }
  for (const it of sources.ado || []) {
    if (!referencedAdo.has(String(it.id))) orphanAdo.add(String(it.id));
  }
  for (const it of sources.figma || []) {
    if (!referencedFigma.has(String(it.nodeId))) orphanFigma.add(String(it.nodeId));
  }

  const orphanBlock = (orphanAdo.size || orphanFigma.size)
    ? h('div', { class: 'orphans' },
        h('h3', {}, 'Unmapped work items / designs'),
        h('div', { class: 'chiprow' },
          [...orphanAdo].map(adoChip),
          [...orphanFigma].map(figmaChip)))
    : null;

  return h('div', { class: 'coverage' },
    h('table', { class: 'cov-table' },
      h('thead', {}, h('tr', {},
        h('th', {}, 'Section'), h('th', {}, 'ADO items'), h('th', {}, 'Figma frames'), h('th', {}, 'Status'))),
      h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colspan: '4', class: 'meta-dim' }, 'No spec sections extracted'))),
    ),
    orphanBlock,
  );
}

/* ============================== timeline tab ============================== */

function discFindingList(label, findings, cls) {
  if (!findings.length) return null;
  return h('div', { class: `disc-section ${cls}` },
    h('div', { class: 'disc-label' }, label),
    h('ul', { class: 'disc-list' },
      findings.map((f) => {
        const sev = SEV[f.severity] ? f.severity : 'info';
        return h('li', { class: 'disc-item' },
          h('span', { class: `sev-glyph sev-${sev}` }, SEV[sev].glyph),
          ' ',
          f.title || '(untitled)');
      })));
}

function timelineView(data) {
  const rounds = ((data.rounds && data.rounds.rounds) || []).slice().sort((a, b) => (b.n ?? 0) - (a.n ?? 0));
  if (!rounds.length) {
    return h('div', { class: 'empty empty-tab' },
      h('h2', {}, 'No audit rounds yet'),
      h('p', {}, 'Run ', h('code', {}, '/flowlever:audit'), ' to start the ledger.'));
  }
  const allFindings = (data.ledger && data.ledger.findings) || [];
  const byN = new Map(rounds.map((r) => [r.n, r]));
  return h('ol', { class: 'timeline' }, rounds.map((r) => {
    const stats = r.stats || {};
    const rd = r.readiness || {};
    const prev = byN.get((r.n ?? 0) - 1);
    const prevScore = prev && prev.readiness ? prev.readiness.score : null;
    const delta = (prevScore != null && rd.score != null) ? rd.score - prevScore : null;

    const pills = [
      h('span', { class: 'pill pill-new num-line' }, `+${stats.new ?? 0} new`),
      h('span', { class: 'pill pill-resolved num-line' },
        `✓ ${plural(stats.autoResolved ?? 0, 'auto-resolved', 'auto-resolved')}`),
    ];
    if ((stats.regressions ?? 0) > 0) {
      pills.push(h('span', { class: 'pill pill-regress num-line' },
        `⚠︎ ${plural(stats.regressions, 'regression', 'regressions')}`));
    }
    pills.push(h('span', { class: 'pill pill-open num-line' },
      `${plural(stats.totalOpen ?? 0, 'open after', 'open after')}`));

    const scorePill = h('span', { class: 'pill pill-score num-line' },
      `score ${rd.score ?? '?'}`,
      delta == null || delta === 0
        ? h('span', { class: 'delta delta-flat' }, ' —')
        : h('span', { class: `delta ${delta > 0 ? 'delta-up' : 'delta-down'}` },
            ` ${delta > 0 ? '▲' : '▼'}${Math.abs(delta)}`));
    pills.push(scorePill);

    const { newF, autoResolved, regressed } = deriveRoundFindings(allFindings, r.n);
    const unknownRegressions = (stats.regressions ?? 0) - regressed.length;
    const hasDisc = newF.length || autoResolved.length || regressed.length || unknownRegressions > 0;

    const disc = hasDisc ? h('details', { class: 'round-disc' },
      h('summary', { class: 'round-disc-sum' }, 'Findings breakdown'),
      discFindingList('+ New', newF, 'disc-new'),
      discFindingList('✓ Auto-resolved', autoResolved, 'disc-resolved'),
      discFindingList('⚠︎ Regressed', regressed, 'disc-regressed'),
      unknownRegressions > 0
        ? h('p', { class: 'disc-note' },
            `${plural(unknownRegressions, 'regression', 'regressions')} stayed closed — finding remained in its prior resolved/waived state`)
        : null,
    ) : null;

    return h('li', { class: 'round' },
      h('div', { class: 'round-head' },
        h('span', { class: 'round-n num-line' }, `Round ${r.n ?? '?'}`),
        h('span', { class: 'meta-dim' }, fmtDateTime(r.at) || ''),
        r.trigger ? h('span', { class: 'chip chip-trigger' }, r.trigger) : null,
        rd.gate ? gateBadge(rd.gate) : null,
      ),
      r.note ? h('p', { class: 'round-note' }, r.note) : null,
      h('div', { class: 'round-pills' }, pills),
      disc,
    );
  }));
}

/* ============================== report tab ============================== */

function reportView() {
  const wrap = h('div', { class: 'report' },
    h('div', { class: 'report-bar' },
      h('span', { class: 'meta-dim' }, 'Markdown report (generated by src/report.js)'),
      h('button', {
        class: 'btn btn-accent',
        type: 'button',
        id: 'copy-md',
        disabled: state.report.id !== current.id || state.report.md == null,
        onclick: copyReport,
      }, 'Copy markdown'),
    ),
    h('div', { id: 'report-body', class: 'report-body' },
      state.report.id === current.id && state.report.md != null
        ? renderMarkdown(state.report.md)
        : h('div', { class: 'report-skel' }, skel('skel-line w-200'), skel('skel-line'), skel('skel-line'), skel('skel-line w-120'))),
  );
  return wrap;
}

async function loadReportInto(id, seq) {
  if (state.report.id === id && state.report.md != null) return; // already rendered by reportView
  let md;
  try {
    md = await api(`/api/report/${encodeURIComponent(id)}`);
  } catch (e) {
    if (seq !== routeSeq) return;
    const body = $('#report-body');
    if (body) body.replaceChildren(h('p', { class: 'meta-dim' }, `Could not load report: ${e.message}`));
    toast(`Could not load report: ${e.message}`);
    return;
  }
  if (seq !== routeSeq) return;
  state.report = { id, md: typeof md === 'string' ? md : JSON.stringify(md, null, 2) };
  const body = $('#report-body');
  if (body) body.replaceChildren(renderMarkdown(state.report.md));
  const btn = $('#copy-md');
  if (btn) btn.disabled = false;
}

async function copyReport() {
  if (state.report.md == null) return;
  try {
    await navigator.clipboard.writeText(state.report.md);
    toast('Report markdown copied', 'success');
  } catch {
    toast('Clipboard unavailable');
  }
}

/* ---- minimal markdown renderer (headings, bold/em/code, links, lists,
 * tables, fenced code, hr, blockquote). DOM-built ⇒ XSS-safe. ---- */

/* Review prose (a finding's detail, and the proposed comment/reply) IS markdown — it is
 * written as markdown and Azure DevOps renders it as markdown. Dumping it into a text node
 * showed `identifiers` with their backticks and swallowed lists, so the reviewer previewed
 * something that did not match what the author would receive. Every prose surface routes
 * through here instead, reusing the renderer the report view already uses. */
function mdBlock(src, cls) {
  const el = renderMarkdown(src);
  if (cls) el.className = `md ${cls}`;
  return el;
}

function renderMarkdown(md) {
  const root = h('div', { class: 'md' });
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  let para = [];
  const flush = () => {
    if (para.length) { root.append(h('p', {}, mdInline(para.join(' ')))); para = []; }
  };

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {                              // fenced code
      flush();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // closing fence
      root.append(h('pre', {}, h('code', {}, buf.join('\n'))));
      continue;
    }

    const hm = line.match(/^(#{1,6})\s+(.*)$/);           // heading
    if (hm) {
      flush();
      root.append(h(`h${hm[1].length}`, { class: 'md-h' }, mdInline(hm[2])));
      i++;
      continue;
    }

    if (/^\s*(-{3,}|_{3,}|\*{3,})\s*$/.test(line)) {      // hr
      flush();
      root.append(h('hr'));
      i++;
      continue;
    }

    if (/^\|.*\|\s*$/.test(line)) {                        // table
      flush();
      const tlines = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) { tlines.push(lines[i]); i++; }
      root.append(mdTable(tlines));
      continue;
    }

    if (/^\s*([-*+]\s+|\d+[.)]\s+)/.test(line)) {          // list
      flush();
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]\s+|\d+[.)]\s+)/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
        i++;
      }
      root.append(h(ordered ? 'ol' : 'ul', {}, items.map((t) => h('li', {}, mdInline(t)))));
      continue;
    }

    if (/^\s*>\s?/.test(line)) {                           // blockquote
      flush();
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      root.append(h('blockquote', {}, h('p', {}, mdInline(buf.join(' ')))));
      continue;
    }

    if (!line.trim()) { flush(); i++; continue; }          // blank

    para.push(line.trim());
    i++;
  }
  flush();
  return root;
}

function mdTable(tlines) {
  const parseRow = (l) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
  const isSep = (l) => /^\s*\|?\s*:?-{2,}.*$/.test(l) && /^[\s|:\-]+$/.test(l);
  const table = h('table', { class: 'md-table' });
  let rows = tlines;
  if (rows.length >= 2 && isSep(rows[1])) {
    table.append(h('thead', {}, h('tr', {}, parseRow(rows[0]).map((c) => h('th', {}, mdInline(c))))));
    rows = rows.slice(2);
  }
  table.append(h('tbody', {}, rows.filter((l) => !isSep(l)).map((l) =>
    h('tr', {}, parseRow(l).map((c) => h('td', {}, mdInline(c)))))));
  return table;
}

function mdInline(text) {
  const frag = document.createDocumentFragment();
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    if (m[1] != null) frag.append(h('strong', {}, m[1]));
    else if (m[2] != null) frag.append(h('code', {}, m[2]));
    else if (m[3] != null) {
      const href = safeHref(m[4]);
      frag.append(href
        ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, m[3])
        : h('span', {}, m[3]));
    } else if (m[5] != null) frag.append(h('em', {}, m[5]));
    else if (m[6] != null) frag.append(h('em', {}, m[6]));
    last = re.lastIndex;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

/* ============================== keyboard ============================== */

function isTyping(t) {
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !isTyping(e.target) && !e.metaKey && !e.ctrlKey && !e.altKey) {
    const s = $('#finding-search');
    if (s) { e.preventDefault(); s.focus(); s.select(); }
  } else if (e.key === 'Escape') {
    if (state.modalFp) return;   // the finding modal owns Escape (native <dialog> closes it)
    const search = document.getElementById('finding-search');
    if (search && document.activeElement === search) {
      state.filters.q = '';
      search.value = '';
      search.blur();
      renderBoard();
    } else if (isTyping(document.activeElement)) {
      document.activeElement.blur();
    }
  } else if (
    // Stepper-scoped decide-loop shortcuts (U-5): only while the focused card is showing (not
    // the finish screen), never while an inline editor is open (its own textarea/keys own input),
    // and never while any modifier is held or focus is in a field — isTyping already covers a
    // field with focus, this adds the belt-and-suspenders check for non-field-but-editing state.
    current.view === 'review-flow' && !state.flow.finish && !state.flow.waiving
    && !state.flow.editingComment && !state.editingHunk
    && !isTyping(e.target) && !e.metaKey && !e.ctrlKey && !e.altKey
  ) {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (key === 'j' || e.key === 'ArrowRight') { e.preventDefault(); stepGoNext(); return; }
    if (key === 'k' || e.key === 'ArrowLeft') { e.preventDefault(); stepGoPrev(); return; }
    const decKind = DECIDE_KEYS[key];
    if (!decKind || !state.detail) return;
    const data = state.detail;
    const fp = state.flow.items[state.flow.idx];
    const findings = (data.ledger && data.ledger.findings) || [];
    const f = findings.find((x) => x.fp === fp);
    if (!f) return;
    const kind = (data.feature && data.feature.kind) || 'spec';
    // Only fire a key the current workspace kind actually offers — the SAME handler the visible
    // decision button calls (decide()), so there is no separate, easier-to-drift code path.
    if (!decisionActions(kind).buttons.some((b) => b.kind === decKind)) return;
    e.preventDefault();
    decide(data, f, decKind);
  }
});

/* ============================== boot ============================== */

/* Multiple sticky top banners (#stale-server, #server-unreachable, #server-restarted) can be up at
 * once — a restart, for instance, clears the unreachable one but immediately raises the restart
 * one. `position: sticky; top: 0` siblings don't stack themselves (they all pin to the same spot
 * and the later one in the DOM just paints over the earlier one), so after any banner is
 * shown/hidden this walks the survivors in document order and gives each one a top offset equal to
 * the combined height of the banners above it. */
function restackBanners() {
  let offset = 0;
  document.querySelectorAll('.top-banner').forEach((el) => {
    el.style.top = `${offset}px`;
    offset += el.offsetHeight;
  });
  // The banners sit at z-index 100 and the nav (.topbar, style.css) is sticky at z-index 50, so a
  // full stack of three — measured at 148px against a 56px header — painted over the entire nav
  // and made it unclickable. Push the nav down by exactly the stack's height instead, and hand the
  // offset back to the stylesheet (top: 0) once the last banner is gone.
  const topbar = document.querySelector('.topbar');
  if (topbar) topbar.style.top = offset ? `${offset}px` : '';
}

/* Debounce for the unreachable banner: only trip it after this many CONSECUTIVE failed heartbeats
 * (~8s at the 4s tick interval) so one dropped request doesn't cry wolf, while a real outage is
 * still caught within a couple of ticks — this is the number called out in the diagnosis (a tab
 * that sat open for ~20 hours with no way to tell the server was gone). */
const HEARTBEAT_FAIL_THRESHOLD = 2;

/* Heartbeat state. Deliberately module-level and OUTSIDE `poller`, which route() unregisters on
 * every navigation: "is the server even there" has to survive that, or clicking around during a
 * real outage would keep resetting the failure count and the debounce would never trip. */
const heartbeat = {
  fails: 0,          // consecutive failed/errored /api/version checks
  lastOkAt: null,    // ISO stamp of the last time the server answered — drives "unreachable since…"
  startedAt: null,   // the server's own SERVER_STARTED_AT, from the first successful check; a LATER
                      // check reporting a different value means the process restarted underneath us
};

/* One request to the cheapest endpoint the server has (GET /api/version, src/server.js — "matched
 * first, must answer even when everything else about the build is mismatched") answers three
 * independent questions, each with its own banner:
 *   1. Is the server there at all? → #server-unreachable, after HEARTBEAT_FAIL_THRESHOLD misses.
 *   2. Did it restart since we last asked? → #server-restarted (the app.js/style.css this tab is
 *      running may now be stale — the server sends no ETag/Cache-Control, so nothing else notices).
 *   3. Does its API version match what this page was built for? → #stale-server (pre-existing).
 * Runs on every tick of the app-level ticker — never on a view's poller, which is exactly what an
 * outage takes down first; see the comment on `poller` for the failure that taught us that. */
/* The timeout is the whole point, not a nicety. A DEAD process on loopback refuses instantly and
 * any bare fetch catches it — but the outage that motivated this heartbeat was a WEDGED one: the
 * listen socket still accepted, headers came back, and the event loop never ran, so a fetch with no
 * deadline simply never settles. Without a deadline `fails` stays at 0 for as long as the server is
 * wedged and the tab keeps looking healthy — the exact bug, reproduced with SIGSTOP. 3s is twice
 * the ~1.5s worst case the server can legitimately block for behind a contended ledger write, so a
 * merely slow cockpit is not reported as gone. This also bounds how many ticks can pile up. */
const HEARTBEAT_TIMEOUT_MS = 3000;

async function checkHeartbeat() {
  let res;
  let body = null;
  try {
    res = await fetch('/api/version', { signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS) });
    if (res.ok) body = await res.json();
  } catch {
    onHeartbeatFail();   // refused, aborted at the deadline, or malformed body — all "not answering"
    return;
  }
  if (!res.ok && res.status !== 404) {
    onHeartbeatFail();   // a 5xx (or similar) is a real heartbeat failure, not just a thrown fetch
    return;
  }
  onHeartbeatOk();
  if (!res.ok) {
    // A 404 is not a failed heartbeat — the server answered, so the two concerns stay separate —
    // but it is conclusive evidence the SERVER is the stale side: it predates /api/version
    // entirely, which is also what a different process squatting the port looks like. Pass the
    // missing version through as `null` so checkVersionMismatch still renders the "server predates
    // the version check" banner (and refreshes it if one is already up). Treating this as healthy,
    // as an earlier cut of the heartbeat did, hid an old binary behind a green-looking tab.
    checkVersionMismatch(null);
    return;
  }
  checkRestart(body && body.startedAt);
  checkVersionMismatch(body && body.apiVersion);
}

function onHeartbeatFail() {
  heartbeat.fails += 1;
  if (heartbeat.fails >= HEARTBEAT_FAIL_THRESHOLD) showUnreachableBanner();
}

function onHeartbeatOk() {
  const wasUnreachable = heartbeat.fails >= HEARTBEAT_FAIL_THRESHOLD;
  heartbeat.fails = 0;
  heartbeat.lastOkAt = new Date().toISOString();
  if (!wasUnreachable) return;
  clearUnreachableBanner();
  // Whatever view is open may be showing minutes (or, per the incident that motivated this, hours)
  // of stale data gathered while the server was gone — don't let it linger now that it's back.
  refreshCurrentView();
}

function showUnreachableBanner() {
  const since = heartbeat.lastOkAt ? ` Last reached ${fmtAgo(heartbeat.lastOkAt)}.` : '';
  const msg = `${since} Still retrying every few seconds — this banner clears on its own once it is back.`;
  // Built ONCE, on the transition into the unreachable state, and only text-patched afterwards.
  // This runs on every failed tick for as long as the outage lasts, and a freshly inserted
  // role="alert" is re-announced by screen readers each time it appears: rebuilding the node every
  // 4s would have meant roughly 18,000 announcements across the ~20-hour outage that motivated the
  // banner. Only the "last reached …" age actually changes, so only that changes here.
  const existing = $('#server-unreachable');
  if (existing) {
    // Only write when the wording actually changed. This is a role="alert" region, so an
    // assistive technology may re-announce on any subtree mutation — and `fmtAgo` returns "just
    // now" for the first minute and only ~80 distinct values across a day, so an unconditional
    // write re-announced an identical sentence every 4s for the length of the outage.
    const msgEl = existing.querySelector('.server-unreachable-msg');
    if (msgEl && msgEl.textContent !== msg) {
      msgEl.textContent = msg;
      restackBanners();   // the age text can wrap, so the bar's height (and the stack) may shift
    }
    return;
  }
  const bar = h('div', { class: 'stale-server top-banner', id: 'server-unreachable', role: 'alert' },
    h('span', { class: 'stale-server-icon', 'aria-hidden': 'true' }, '⚠'),
    h('div', { class: 'stale-server-body' },
      h('strong', {}, 'The cockpit server is not answering.'),
      h('span', { class: 'server-unreachable-msg' }, msg)));
  document.body.prepend(bar);
  restackBanners();
}

function clearUnreachableBanner() {
  const bar = $('#server-unreachable');
  if (!bar) return;
  bar.remove();
  restackBanners();
}

/* Read-only mode has to be stated, not discovered. The whole point of the mode is that the cockpit
 * is safe to open, drive and demo against real data — and a reviewer who can read a finding, form a
 * decision and click Approve before learning that nothing will be recorded has been misled by the
 * UI, even though no harm reached the ledger. Unlike the unreachable and restarted banners this one
 * never clears: the mode is fixed for the life of the process (see READONLY in ledger.js), so there
 * is no recovery to wait for and no dismiss button to offer. */
function showReadOnlyBanner() {
  if ($('#read-only-mode')) return;         // fixed for the process; only ever shown once
  const bar = h('div', { class: 'stale-server top-banner read-only-banner', id: 'read-only-mode', role: 'status' },
    h('span', { class: 'stale-server-icon', 'aria-hidden': 'true' }, '🔒'),
    h('div', { class: 'stale-server-body' },
      h('strong', {}, 'Read-only mode.'),
      h('span', {}, ' You can open and read everything. Decisions, posts, applies and runner jobs '
        + 'are refused — nothing here can change your review data or reach Azure DevOps. Restart '
        + 'without '), h('code', {}, 'FLOWLEVER_READONLY=1'), h('span', {}, ' to make changes.')));
  document.body.prepend(bar);
  restackBanners();
}

/* Reload whatever the user is looking at, without doing what a full route() would do to an
 * in-progress review: route() unconditionally closes any open finding modal and resets the
 * stepper's flow before it does anything else, which would throw away exactly the in-progress
 * decisions this banner is trying not to disturb. Detail and review-flow reload their data in
 * place instead — the same path ensureFeatureJobPolling already uses when a background job
 * finishes (see its `justDone` branch) — and let their own re-render (rerenderDetail /
 * renderFlowInto, via reconcileFlowItems) reconcile the fresh data against whatever is open. Every
 * other view (home, the kind sections, guide) has no unsaved state to protect, so a plain route()
 * — the same reload every hash navigation already does — is enough. */
function refreshCurrentView() {
  if ((current.view === 'detail' || current.view === 'review-flow') && current.id) {
    loadDetail(current.id, true)
      .then(() => (current.view === 'review-flow' ? renderFlowInto() : rerenderDetail()))
      .catch(() => {});
    return;
  }
  route();
}

/* A later /api/version call reporting a DIFFERENT startedAt than the first one we ever saw means
 * the server process was replaced underneath this tab (a restart, a redeploy). The server sends no
 * ETag/Cache-Control on app.js/style.css, so the browser has no other way to learn the assets this
 * tab is running may now be stale. Never auto-reloads — the user may have unsaved editor text (an
 * open comment draft, an edited hunk) — it only offers the button. */
function checkRestart(startedAt) {
  if (!startedAt) return;
  if (heartbeat.startedAt == null) { heartbeat.startedAt = startedAt; return; }   // first observation: baseline only
  if (startedAt === heartbeat.startedAt) return;
  heartbeat.startedAt = startedAt;
  if ($('#server-restarted')) return;   // already showing
  const bar = h('div', { class: 'stale-server top-banner', id: 'server-restarted', role: 'alert' },
    h('span', { class: 'stale-server-icon', 'aria-hidden': 'true' }, '⚠'),
    h('div', { class: 'stale-server-body' },
      h('strong', {}, 'The cockpit server restarted.'),
      h('span', {}, ' This tab may be running a stale build (no cache-busting on app.js/style.css). '
        + 'Reload when convenient — your place is kept, but an open editor is not.')),
    h('button', {
      class: 'btn btn-accent stale-server-reload', type: 'button', onclick: () => location.reload(),
    }, 'Reload'),
    h('button', {
      class: 'btn-icon stale-server-dismiss', type: 'button', 'aria-label': 'Dismiss',
      title: 'Dismiss (the tab stays on the old build)', onclick: () => { bar.remove(); restackBanners(); },
    }, '×'));
  document.body.prepend(bar);
  restackBanners();
}

/* Compare the running server's API version against what this page was built for, and say so loudly
 * if they differ — in the RIGHT direction. A 404 on /api/version means the server predates the
 * check entirely, which is conclusive evidence the SERVER is the stale side; a numeric mismatch
 * can go either way (an upgraded server outliving a browser tab with a cached older app.js is just
 * as real as the reverse), so the two are told apart and each gets the instruction that actually
 * fixes it — the previous version only ever blamed the server, even when the PAGE was behind.
 * Re-checked on every heartbeat (not a second timer) so a tab left open across an upgrade catches
 * up instead of latching the boot-time verdict forever; a banner is dropped once versions agree
 * again (e.g. the server got restarted onto a matching build). */
function checkVersionMismatch(got) {
  const gotN = got == null ? NaN : Number(got);
  if (Number.isFinite(gotN) && gotN === Number(EXPECTED_API_VERSION)) {
    const bar = $('#stale-server');
    if (bar) { bar.remove(); restackBanners(); }   // back in sync since the last check
    return;
  }
  const serverIsNewer = Number.isFinite(gotN) && gotN > Number(EXPECTED_API_VERSION);
  showStaleServerBanner(got, serverIsNewer);
}

function showStaleServerBanner(got, serverIsNewer) {
  // Same reasoning as showUnreachableBanner: this is re-evaluated on every heartbeat, so leave an
  // identical banner's node alone rather than re-inserting a role="alert" every 4s. The signature
  // covers everything the wording depends on, so a genuine change — a numeric mismatch that starts
  // 404ing instead, or the direction flipping — still rebuilds the bar instead of leaving stale text.
  const sig = `${serverIsNewer ? 'page-behind' : 'server-behind'}:${got == null ? 'none' : got}`;
  const already = $('#stale-server');
  if (already && already.dataset.sig === sig) return;
  const versionNote = got ? ` (server API v${got}, page expects v${EXPECTED_API_VERSION})` : ' (server predates the version check)';
  const body = serverIsNewer
    ? h('div', { class: 'stale-server-body' },
        h('strong', {}, 'This page is running an older build than the cockpit server.'),
        h('span', {}, ' It may call routes or read fields the server has since changed. Hard-reload this tab', versionNote, '.'))
    : h('div', { class: 'stale-server-body' },
        h('strong', {}, 'The cockpit server is running an older build than this page.'),
        h('span', {}, ' Actions can fail with a bare “Not found” because the server has never heard of ',
          'the routes this page calls. Restart it: ', h('code', {}, 'node src/cli.js start'), versionNote));
  if (already) already.remove();   // rebuilt below — the direction or the version note has changed
  const bar = h('div', { class: 'stale-server top-banner', id: 'stale-server', role: 'alert', 'data-sig': sig },
    h('span', { class: 'stale-server-icon', 'aria-hidden': 'true' }, '⚠'),
    body,
    h('button', {
      class: 'btn-icon stale-server-dismiss', type: 'button', 'aria-label': 'Dismiss',
      title: 'Dismiss (the mismatch remains)', onclick: () => { bar.remove(); restackBanners(); },
    }, '×'));
  document.body.prepend(bar);
  restackBanners();
}

window.addEventListener('hashchange', route);
// Know whether a runner is going before the first paint settles, so the Run button doesn't pop in
// a tick later (the shared poller keeps it fresh from then on).
refreshRunner().then(renderRunnerZones).catch(() => {});
checkHeartbeat();
loadLiveConfig();
route();
// The app's ONE interval, and the only one there should ever be: started here at boot, owned by
// the app rather than by whichever view happens to be mounted, and never cleared. Navigation can
// only register/unregister the per-view callback it feeds (startPolling/stopPolling) — it cannot
// stop the heartbeat, which is the whole point: a cold load with the server already down, or a
// navigation mid-outage, used to leave no timer running and therefore no way to ever notice the
// server was gone or that it had come back.
setInterval(appTick, 4000);
