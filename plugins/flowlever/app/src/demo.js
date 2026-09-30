'use strict';

// Seeds one realistic feature that tells a 3-round spec-validation story, so the
// cockpit shows off everything: all four finding states, a waive-with-reason, a
// pinned finding, a regression, climbing readiness, and a coverage matrix with
// an uncovered section + an orphan work item.

const fs = require('node:fs');
const path = require('node:path');
const L = require('./ledger.js');

const FEATURE_ID = 'checkout-redesign';
const PR_REVIEW_ID = 'pr-482-checkout-api';
const PR_RESPOND_ID = 'pr-470-fix-floor';
const DEMO_IDS = [FEATURE_ID, PR_REVIEW_ID, PR_RESPOND_ID];

function resetDemo() {
  // Remove any prior demo data so re-seeding is clean and deterministic.
  for (const sub of ['features', 'ledger', 'rounds']) {
    for (const id of DEMO_IDS) {
      const p = path.join(L.DATA_DIR, sub, `${id}.json`);
      if (fs.existsSync(p)) fs.rmSync(p);
    }
  }
}

function seed() {
  L.initDataDir();
  resetDemo();

  const feature = L.createFeature({
    id: FEATURE_ID,
    kind: 'spec',
    title: 'Checkout Redesign — guest checkout & new payment methods',
  });

  // --- Sources (Confluence spec, ADO work items, Figma designs) ---
  L.addSource(FEATURE_ID, {
    type: 'confluence',
    id: '982341',
    title: 'Checkout Redesign — Functional Specification',
    url: 'https://uniccom.atlassian.net/wiki/spaces/DXP/pages/982341/Checkout+Redesign',
    version: 14,
  });
  L.addSource(FEATURE_ID, {
    type: 'ado', id: 42695, itemType: 'User Story',
    title: 'As a guest, I can check out without creating an account',
    url: 'https://dev.azure.com/FZAG/dxp/_workitems/edit/42695', state: 'Active',
  });
  L.addSource(FEATURE_ID, {
    type: 'ado', id: 42696, itemType: 'User Story',
    title: 'Support Twint and PayPal as payment methods',
    url: 'https://dev.azure.com/FZAG/dxp/_workitems/edit/42696', state: 'New',
  });
  L.addSource(FEATURE_ID, {
    type: 'ado', id: 42710, itemType: 'Task',
    title: 'Phased rollout behind feature flag (10% → 50% → 100%)',
    url: 'https://dev.azure.com/FZAG/dxp/_workitems/edit/42710', state: 'New',
  });
  L.addSource(FEATURE_ID, {
    type: 'figma', fileKey: 'aV3kCh3ck0ut', nodeId: '12:340',
    title: 'Checkout flow v3 — happy path',
    url: 'https://www.figma.com/design/aV3kCh3ck0ut/Checkout?node-id=12-340',
  });
  L.addSource(FEATURE_ID, {
    type: 'figma', fileKey: 'aV3kCh3ck0ut', nodeId: '12:880',
    title: 'Payment method selection',
    url: 'https://www.figma.com/design/aV3kCh3ck0ut/Checkout?node-id=12-880',
  });

  // --- Spec outline (stable section keys, used by the coverage matrix) ---
  const f = L.getFeature(FEATURE_ID);
  f.specSections = [
    { key: 'goals', title: 'Goals & Non-goals' },
    { key: 'user-flow', title: 'Guest checkout user flow' },
    { key: 'payment-methods', title: 'Payment methods' },
    { key: 'error-handling', title: 'Error handling & edge cases' },
    { key: 'analytics', title: 'Analytics & tracking' },
    { key: 'rollout', title: 'Rollout plan' },
  ];
  f.status = 'auditing';
  L.saveFeature(f);

  // ---------------------------------------------------------------------------
  // ROUND 1 — initial swarm audit. 11 findings: 2 blocker, 4 major, 4 minor, 1 info.
  // ---------------------------------------------------------------------------
  const round1 = [
    {
      dimension: 'consistency', severity: 'blocker',
      title: 'Payment methods differ between spec and work item',
      detail: 'Spec section "Payment methods" lists card and PayPal only. AB#42696 acceptance criteria also require Twint. Implementation target is ambiguous.',
      locus: 'confluence:982341#payment-methods vs ado:42696',
      suggestion: 'Decide the launch set. If Twint is in scope, add it to the spec section and its error states; otherwise move it to a follow-up story.',
    },
    {
      dimension: 'completeness', severity: 'blocker',
      title: 'No design frame for error handling section',
      detail: 'Spec "Error handling & edge cases" describes declined-payment and timeout flows, but no Figma frame covers them. Engineers have nothing to build the failure UI from.',
      locus: 'confluence:982341#error-handling vs figma:aV3kCh3ck0ut',
      suggestion: 'Add a Figma frame for payment-failure and network-timeout states, or explicitly defer with a placeholder note.',
    },
    {
      dimension: 'testability', severity: 'major',
      title: 'Fast checkout requirement is not measurable',
      detail: '"Checkout should feel fast" appears in Goals with no metric. Cannot be verified or accepted.',
      locus: 'confluence:982341#goals',
      suggestion: 'Quantify, e.g. "payment step renders < 1.5s on 4G p75" so QA can assert it.',
    },
    {
      dimension: 'consistency', severity: 'major',
      title: 'Rollout percentages differ between spec and task',
      detail: 'Spec "Rollout plan" describes 5% → 25% → 100%. AB#42710 says 10% → 50% → 100%. Conflicting source of truth.',
      locus: 'confluence:982341#rollout vs ado:42710',
      suggestion: 'Align the staged percentages in both places; name one as authoritative.',
    },
    {
      dimension: 'dor', severity: 'major',
      title: 'Guest checkout story has no acceptance criteria',
      detail: 'AB#42695 has a description but an empty acceptance-criteria field. Fails Definition of Ready.',
      locus: 'ado:42695',
      suggestion: 'Add Given/When/Then acceptance criteria covering the guest path incl. email capture.',
    },
    {
      dimension: 'design-match', severity: 'major',
      title: 'Design shows saved-address picker not described in spec',
      detail: 'Figma "Checkout flow v3" includes a saved-address selector. The guest-checkout spec never mentions saved addresses (guests have none).',
      locus: 'figma:aV3kCh3ck0ut:12:340 vs confluence:982341#user-flow',
      suggestion: 'Remove the picker from the guest variant in Figma, or document the logged-in variant in the spec.',
    },
    {
      dimension: 'ambiguity', severity: 'minor',
      title: 'Email capture timing is ambiguous',
      detail: 'Spec says email is collected "during checkout" without specifying before or after payment. Affects validation and abandonment tracking.',
      locus: 'confluence:982341#user-flow',
      suggestion: 'State the exact step where email is captured and whether it is required to proceed.',
    },
    {
      dimension: 'completeness', severity: 'minor',
      title: 'No analytics events defined for payment selection',
      detail: 'Analytics section tracks checkout start/complete but not which payment method was chosen — a key redesign metric.',
      locus: 'confluence:982341#analytics',
      suggestion: 'Add a payment_method_selected event with the method as a property.',
    },
    {
      dimension: 'feasibility', severity: 'minor',
      title: 'Twint requires server-side webhook not budgeted',
      detail: 'Twint settlement is asynchronous and needs a webhook endpoint. No task exists for backend webhook handling.',
      locus: 'ado:42696',
      suggestion: 'If Twint stays in scope, add a backend task for the settlement webhook.',
    },
    {
      dimension: 'testability', severity: 'minor',
      title: 'Abandonment metric lacks a definition window',
      detail: '"Reduce cart abandonment" has no time window or baseline, so success is unverifiable.',
      locus: 'confluence:982341#goals',
      suggestion: 'Define baseline and window, e.g. "−15% within 30 days of 100% rollout".',
    },
    {
      dimension: 'consistency', severity: 'info',
      title: 'Spec still references the old two-page checkout',
      detail: 'A leftover sentence in the intro mentions the legacy two-page flow being replaced — harmless but confusing.',
      locus: 'confluence:982341#goals',
      suggestion: 'Delete the stale reference once the single-page flow is confirmed.',
    },
  ];
  L.ingestRound(FEATURE_ID, round1, { note: 'Initial swarm audit — 7 dimensions across spec, 3 work items, 2 designs.' });

  // --- Between rounds: triage actions ---
  const fp = (dim, title, locus) => L.fingerprint(FEATURE_ID, dim, title, locus);

  // Waive the stale-reference info finding with a reason.
  L.setFindingStatus(FEATURE_ID, fp('consistency', 'Spec still references the old two-page checkout', 'confluence:982341#goals'),
    { status: 'waived', reason: 'Intentional context for reviewers; will clean up at spec freeze.' });

  // Pin the Twint feasibility finding so it survives re-audits until the backend decision lands.
  L.setFindingStatus(FEATURE_ID, fp('feasibility', 'Twint requires server-side webhook not budgeted', 'ado:42696'),
    { pinned: true });

  // ---------------------------------------------------------------------------
  // ROUND 2 — re-audit after a rework pass. Six round-1 findings are fixed (absent
  // → auto-resolved). One NEW major appears. One previously-resolved item gets
  // re-flagged (regression) without reopening.
  // ---------------------------------------------------------------------------
  const round2 = [
    // Still open — the hard cross-source conflicts persisted.
    {
      dimension: 'consistency', severity: 'blocker',
      title: 'Payment methods differ between spec and work item',
      detail: 'Spec now lists card and PayPal; Twint still only in AB#42696. Decision still pending.',
      locus: 'confluence:982341#payment-methods vs ado:42696',
      suggestion: 'Resolve the Twint scope decision and reflect it in both places.',
    },
    {
      dimension: 'consistency', severity: 'major',
      title: 'Rollout percentages differ between spec and task',
      detail: 'Spec updated to 10% → 50% → 100% but AB#42710 description still shows the old first sentence in a comment.',
      locus: 'confluence:982341#rollout vs ado:42710',
      suggestion: 'Tidy the stale comment on AB#42710 so the task reads cleanly.',
    },
    // Pinned finding — re-flagged, stays visible.
    {
      dimension: 'feasibility', severity: 'minor',
      title: 'Twint requires server-side webhook not budgeted',
      detail: 'Still no backend task for the Twint settlement webhook.',
      locus: 'ado:42696',
      suggestion: 'Add the backend webhook task before committing Twint to the launch set.',
    },
    // NEW major surfaced by the rework (a fixed AC introduced a gap).
    {
      dimension: 'completeness', severity: 'major',
      title: 'New acceptance criteria omit guest email validation errors',
      detail: 'The freshly-added AB#42695 acceptance criteria cover the happy path but not invalid/duplicate email handling for guests.',
      locus: 'ado:42695',
      suggestion: 'Add criteria for invalid-format and already-registered email during guest checkout.',
    },
    // Still open from round 1 — the design picker conflict persisted across the rework.
    {
      dimension: 'design-match', severity: 'major',
      title: 'Design shows saved-address picker not described in spec',
      detail: 'The picker is still present in the synced Figma frame for the guest variant.',
      locus: 'figma:aV3kCh3ck0ut:12:340 vs confluence:982341#user-flow',
      suggestion: 'Confirm the picker is gated to logged-in users only; remove from the guest frame.',
    },
  ];
  L.ingestRound(FEATURE_ID, round2, { note: 'Re-audit after rework pass #1. Six items fixed; watch the design regression.' });

  // ---------------------------------------------------------------------------
  // ROUND 3 — near the finish line. One small new minor; the rest stable.
  // ---------------------------------------------------------------------------
  const round3 = [
    {
      dimension: 'consistency', severity: 'major',
      title: 'Rollout percentages differ between spec and task',
      detail: 'Stale comment on AB#42710 still present.',
      locus: 'confluence:982341#rollout vs ado:42710',
      suggestion: 'One-line cleanup on the task.',
    },
    {
      dimension: 'feasibility', severity: 'minor',
      title: 'Twint requires server-side webhook not budgeted',
      detail: 'Pinned pending the scope decision.',
      locus: 'ado:42696',
      suggestion: 'Add backend task if Twint is confirmed.',
    },
    {
      dimension: 'completeness', severity: 'major',
      title: 'New acceptance criteria omit guest email validation errors',
      detail: 'Still open from round 2.',
      locus: 'ado:42695',
      suggestion: 'Add the missing validation criteria.',
    },
    {
      dimension: 'design-match', severity: 'major',
      title: 'Design shows saved-address picker not described in spec',
      detail: 'Still present in the guest frame.',
      locus: 'figma:aV3kCh3ck0ut:12:340 vs confluence:982341#user-flow',
      suggestion: 'Gate the picker to logged-in users.',
    },
    {
      dimension: 'design-match', severity: 'minor',
      title: 'Payment method icons missing for Twint in design',
      detail: 'The payment-selection frame has card and PayPal icons but no Twint icon, pending the scope decision.',
      locus: 'figma:aV3kCh3ck0ut:12:880',
      suggestion: 'Add a Twint icon to the selection frame if Twint ships.',
    },
    // REGRESSION: a minor finding that was fixed (auto-resolved in round 2) has
    // crept back in. Re-ingested without reopenResolved, so it is flagged as a
    // regression in the round stats while the resolved record is left intact —
    // exactly the "silently came back" case the ledger is built to catch.
    {
      dimension: 'ambiguity', severity: 'minor',
      title: 'Email capture timing is ambiguous',
      detail: 'A spec edit re-introduced vague wording about when the email is collected during checkout.',
      locus: 'confluence:982341#user-flow',
      suggestion: 'Re-state the exact step where email is captured and whether it blocks progress.',
    },
  ];
  L.ingestRound(FEATURE_ID, round3, { note: 'Re-audit after rework pass #2. Down to the payment-scope decision and small cleanups — note the regression.' });

  // --- Move two findings into "reworking" so the board shows that column populated ---
  L.setFindingStatus(FEATURE_ID, fp('consistency', 'Rollout percentages differ between spec and task', 'confluence:982341#rollout vs ado:42710'),
    { status: 'reworking' });
  L.setFindingStatus(FEATURE_ID, fp('completeness', 'New acceptance criteria omit guest email validation errors', 'ado:42695'),
    { status: 'reworking' });

  // --- Rework drafts: PR-style before→after proposals on three open/reworking findings ---
  // These render as red/green diffs in the cockpit before being written back to the source.
  L.setFindingDraft(FEATURE_ID,
    fp('completeness', 'New acceptance criteria omit guest email validation errors', 'ado:42695'),
    {
      target: 'AB#42695 — Acceptance Criteria',
      format: 'gherkin',
      before: [
        'Scenario: Guest completes checkout',
        '  Given I am a guest with items in my cart',
        '  When I enter a valid email and payment details',
        '  Then my order is placed',
        '  And I receive an order confirmation',
      ].join('\n'),
      after: [
        'Scenario: Guest completes checkout',
        '  Given I am a guest with items in my cart',
        '  When I enter a valid email and payment details',
        '  Then my order is placed',
        '  And I receive an order confirmation',
        '',
        'Scenario: Guest enters an invalid email',
        '  Given I am a guest at the email step',
        '  When I enter an email without an "@"',
        '  Then the email field shows "Enter a valid email"',
        '  And the continue button stays disabled',
        '',
        'Scenario: Guest email already has an account',
        '  Given I am a guest at the email step',
        '  When I enter an email tied to an existing account',
        '  Then I am offered to sign in or continue as a guest',
      ].join('\n'),
    });

  L.setFindingDraft(FEATURE_ID,
    fp('consistency', 'Rollout percentages differ between spec and task', 'confluence:982341#rollout vs ado:42710'),
    {
      target: 'Checkout Redesign Spec › Rollout plan',
      format: 'markdown',
      before: [
        '## Rollout plan',
        '',
        'Ship behind the `checkout_v3` flag in three stages:',
        '',
        '- Stage 1 — 5% of traffic',
        '- Stage 2 — 25% of traffic',
        '- Stage 3 — 100% of traffic',
      ].join('\n'),
      after: [
        '## Rollout plan',
        '',
        'Ship behind the `checkout_v3` flag in three stages:',
        '',
        '- Stage 1 — 10% of traffic',
        '- Stage 2 — 50% of traffic',
        '- Stage 3 — 100% of traffic',
        '',
        'Each stage holds for 48h and auto-rolls back if the checkout',
        'error rate exceeds 2%. AB#42710 is the source of truth for the',
        'staged percentages.',
      ].join('\n'),
    });

  L.setFindingDraft(FEATURE_ID,
    fp('design-match', 'Design shows saved-address picker not described in spec', 'figma:aV3kCh3ck0ut:12:340 vs confluence:982341#user-flow'),
    {
      target: 'Checkout Redesign Spec › Guest checkout user flow',
      format: 'markdown',
      before: [
        '## Guest checkout user flow',
        '',
        '1. Cart → Checkout',
        '2. Enter contact email',
        '3. Enter shipping address',
        '4. Choose payment method',
        '5. Review & place order',
      ].join('\n'),
      after: [
        '## Guest checkout user flow',
        '',
        '1. Cart → Checkout',
        '2. Enter contact email',
        '3. Enter shipping address',
        '   - Guests always type a new address. The saved-address',
        '     picker in the Figma frame is shown only to signed-in',
        '     users and is out of scope for guest checkout.',
        '4. Choose payment method',
        '5. Review & place order',
      ].join('\n'),
    });

  // A multi-hunk draft on the open blocker: two independent edits (add Twint to the
  // methods list; clarify the saved-card picker) separated by enough context to split
  // into two reviewable hunks — so per-hunk Accept/Reject/Edit is visible out of the box.
  L.setFindingDraft(FEATURE_ID,
    fp('consistency', 'Payment methods differ between spec and work item', 'confluence:982341#payment-methods vs ado:42696'),
    {
      target: 'Checkout Redesign Spec › Payment methods',
      format: 'markdown',
      before: [
        '## Payment methods',
        '',
        'Guest checkout accepts the following payment methods:',
        '',
        '- Credit or debit card',
        '- PayPal',
        '',
        'All payments are captured at order placement. Refunds are issued',
        'to the original payment method within 5 business days.',
        '',
        'Card details are tokenized by the PSP and never stored on our',
        'servers. PCI scope is limited to the hosted card iframe.',
        '',
        'Saved cards are available to signed-in users only.',
      ].join('\n'),
      after: [
        '## Payment methods',
        '',
        'Guest checkout accepts the following payment methods:',
        '',
        '- Credit or debit card',
        '- PayPal',
        '- Twint (online bank transfer)',
        '',
        'All payments are captured at order placement. Refunds are issued',
        'to the original payment method within 5 business days.',
        '',
        'Card details are tokenized by the PSP and never stored on our',
        'servers. PCI scope is limited to the hosted card iframe.',
        '',
        'Saved cards are available to signed-in users only. The saved-card',
        'picker is hidden entirely during guest checkout.',
      ].join('\n'),
    });

  // --- Pre-decide a couple of hunks so the per-hunk review + work-order export is
  //     demonstrable out of the box. Hunk 0 always exists when a draft has any change. ---
  L.setDraftReview(FEATURE_ID,
    fp('completeness', 'New acceptance criteria omit guest email validation errors', 'ado:42695'),
    { hunk: 0, status: 'accepted' });

  L.setDraftReview(FEATURE_ID,
    fp('consistency', 'Rollout percentages differ between spec and task', 'confluence:982341#rollout vs ado:42710'),
    {
      hunk: 0,
      status: 'edited',
      editedText: [
        '- Stage 1 — 10% of traffic',
        '- Stage 2 — 50% of traffic',
        '- Stage 3 — 100% of traffic',
      ].join('\n'),
    });

  // --- A finding-level counter-proposal: the reviewer rejects the proposed spot for
  //     the saved-address-picker change and redirects it elsewhere via a note. This
  //     overrides the per-hunk diff in the export ("✋ APPLY DIFFERENTLY — …"). ---
  L.setDraftReview(FEATURE_ID,
    fp('design-match', 'Design shows saved-address picker not described in spec', 'figma:aV3kCh3ck0ut:12:340 vs confluence:982341#user-flow'),
    {
      verdict: 'redirect',
      note: 'Reject — don\'t describe the saved-address picker in the guest-checkout user flow. '
        + 'It belongs in the signed-in checkout spec (systemProperties), since it never renders for guests. '
        + 'Add a one-line "out of scope for guests" pointer here instead.',
    });

  // --- Coverage matrix: mostly covered, one uncovered, one partial; one orphan work item ---
  L.setCoverage(FEATURE_ID, [
    { sectionKey: 'goals', adoIds: [42695], figmaNodeIds: [], status: 'covered' },
    { sectionKey: 'user-flow', adoIds: [42695], figmaNodeIds: ['12:340'], status: 'covered' },
    { sectionKey: 'payment-methods', adoIds: [42696], figmaNodeIds: ['12:880'], status: 'partial' },
    { sectionKey: 'error-handling', adoIds: [], figmaNodeIds: [], status: 'uncovered' },
    { sectionKey: 'analytics', adoIds: [], figmaNodeIds: [], status: 'partial' },
    { sectionKey: 'rollout', adoIds: [42710], figmaNodeIds: [], status: 'covered' },
    // Orphan: a work item with no matching spec section.
    { sectionKey: null, adoIds: [42711], figmaNodeIds: [], status: 'orphan' },
  ]);

  // The two PR workspaces ride the SAME finding model + stepper — only the kind differs.
  seedPrReview();
  seedPrRespond();

  return { id: FEATURE_ID, feature: L.getFeature(FEATURE_ID) };
}

// Record when the counterpart last touched the PR, so the demo shows the cockpit's stamp pair
// ("Reviewed <when> · PR updated <when> by <who>"). Backdated: the demo's review round is
// stamped at seed time, so real activity is necessarily older than it — which is why the demo
// deliberately does NOT light the "new since your review" badge (that needs the PR to move
// AFTER a review, which only happens in real use).
function stampDemoActivity(wsId, minutesAgo, who) {
  L.setFeatureReview(wsId, {
    lastActivityAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    lastActivityBy: who,
  });
}

// ---------------------------------------------------------------------------
// pr-review — reviewing someone else's PR. Findings model review comments anchored
// to a file:line; a couple carry before→after code drafts so they're reviewable in
// the shared stepper.
// ---------------------------------------------------------------------------
function seedPrReview() {
  L.createFeature({
    id: PR_REVIEW_ID,
    kind: 'pr-review',
    title: 'PR #482 — Checkout API validation',
  });
  const f = L.getFeature(PR_REVIEW_ID);
  f.status = 'auditing';
  L.saveFeature(f);

  // The comments the PR already carried when the review ran. Ingest reconciles against these, so
  // the review cannot open a second thread on a point a human reviewer already made.
  L.setPriorThreads(PR_REVIEW_ID, [
    {
      threadId: '5511', author: 'Mireia Solà',
      locus: 'pr:482:src/checkout/validate.ts:42',
      excerpt: 'Twint is missing from this allow-list — the spec added it to the launch set.',
      url: 'https://dev.azure.com/demo/_git/shop/pullrequest/482?discussionId=5511',
    },
    {
      threadId: '5512', author: 'Jonas Reber',
      locus: 'pr:482:src/checkout/validate.ts:60',
      excerpt: 'Can we return which field failed? The client has nothing to show the user.',
      url: 'https://dev.azure.com/demo/_git/shop/pullrequest/482?discussionId=5512',
    },
  ]);

  L.ingestRound(PR_REVIEW_ID, [
    {
      dimension: 'feasibility', severity: 'blocker',
      title: 'cart.total() called before the null guard',
      detail: 'validateCheckout() dereferences cart.total() one line above the `if (!cart) return` guard, so a missing cart throws a TypeError instead of a 400.',
      locus: 'pr:482:src/checkout/validate.ts:18',
      suggestion: 'Move the null/empty-cart guard above the total() call.',
    },
    {
      dimension: 'consistency', severity: 'major',
      title: 'Twint references rejected by the method allow-list',
      detail: 'The allow-list still reads ["card","paypal"]; a valid Twint order fails validation even though the spec added Twint to the launch set.',
      locus: 'pr:482:src/checkout/validate.ts:42',
      suggestion: 'Duplicate of [Mireia Solà\'s comment on validate.ts:42](https://dev.azure.com/demo/_git/shop/pullrequest/482?discussionId=5511) — already being handled there.',
      // Mireia got here first. Kept visible so it still gets triaged, but it posts as a
      // cross-reference instead of a second thread saying the same thing.
      duplicateOf: {
        label: 'Mireia Solà on validate.ts:42',
        url: 'https://dev.azure.com/demo/_git/shop/pullrequest/482?discussionId=5511',
        threadId: '5511',
      },
    },
    {
      dimension: 'completeness', severity: 'minor',
      title: 'Validation error omits the offending field',
      detail: 'On failure the handler returns a generic "invalid request"; the client cannot tell which field was wrong.',
      // Jonas asked for this already, but only as a question. This adds the concrete shape, so it
      // posts as a REPLY into his thread rather than a competing one.
      locus: 'pr:482:thread:5512',
      suggestion: 'Adding to Jonas Reber\'s point: include the field name in the 400 body, e.g. { error, field } — the client can then highlight the offending input.',
    },
    {
      dimension: 'testability', severity: 'minor',
      title: 'New validate() branch has no unit test',
      detail: 'The guest-email branch added in this PR is uncovered — the suite passes without ever exercising it.',
      locus: 'pr:482:test/validate.test.ts',
      suggestion: 'Add a case for the guest-email validation path.',
    },
  ], { note: 'Review pass on PR #482 — 4 comments across correctness, consistency and tests.', trigger: 'manual' });

  const fp = (dim, title, locus) => L.fingerprint(PR_REVIEW_ID, dim, title, locus);

  // Two review comments carry a concrete code suggestion (before→after).
  L.setFindingDraft(PR_REVIEW_ID,
    fp('feasibility', 'cart.total() called before the null guard', 'pr:482:src/checkout/validate.ts:18'),
    {
      target: 'src/checkout/validate.ts',
      format: 'text',
      before: [
        'export function validateCheckout(cart, body) {',
        '  const total = cart.total();',
        '  if (!cart || cart.items.length === 0) {',
        '    return { ok: false, error: "empty cart" };',
        '  }',
        '  return checkMethod(body.method, total);',
        '}',
      ].join('\n'),
      after: [
        'export function validateCheckout(cart, body) {',
        '  if (!cart || cart.items.length === 0) {',
        '    return { ok: false, error: "empty cart" };',
        '  }',
        '  const total = cart.total();',
        '  return checkMethod(body.method, total);',
        '}',
      ].join('\n'),
    });

  L.setFindingDraft(PR_REVIEW_ID,
    fp('consistency', 'Twint references rejected by the method allow-list', 'pr:482:src/checkout/validate.ts:42'),
    {
      target: 'src/checkout/validate.ts',
      format: 'text',
      before: [
        'const ACCEPTED_METHODS = ["card", "paypal"];',
        '',
        'function checkMethod(method, total) {',
        '  if (!ACCEPTED_METHODS.includes(method)) {',
        '    return { ok: false, error: "invalid request" };',
        '  }',
        '  return { ok: true, total };',
        '}',
      ].join('\n'),
      after: [
        'const ACCEPTED_METHODS = ["card", "paypal", "twint"];',
        '',
        'function checkMethod(method, total) {',
        '  if (!ACCEPTED_METHODS.includes(method)) {',
        '    return { ok: false, error: "unsupported payment method", field: "method" };',
        '  }',
        '  return { ok: true, total };',
        '}',
      ].join('\n'),
    });

  // On a pr-review workspace the counterpart is the PR's author.
  stampDemoActivity(PR_REVIEW_ID, 95, 'Lena Fischer');
}

// ---------------------------------------------------------------------------
// pr-respond — responding to reviewer threads on YOUR PR. Findings model the open
// threads awaiting a reply; drafts represent the proposed reply/fix. (Loosely tied
// to the FTD operating-hours floor work for flavor.)
// ---------------------------------------------------------------------------
function seedPrRespond() {
  L.createFeature({
    id: PR_RESPOND_ID,
    kind: 'pr-respond',
    title: 'PR #470 — operating-hours floor (your PR)',
  });
  const f = L.getFeature(PR_RESPOND_ID);
  f.status = 'reworking';
  L.saveFeature(f);

  // On pr-respond the reviewer threads ARE the work — each finding is anchored to one by thread
  // id, so nothing here can collide. Registering them still matters: it records who raised what,
  // and it is what the ingest gate checks for.
  L.setPriorThreads(PR_RESPOND_ID, [
    { threadId: '1', author: 'Mireia Solà', locus: 'pr:470:src/FloorResolver.ts:31', excerpt: 'What happens when airportOperatingStartTime is unset?' },
    { threadId: '2', author: 'Jonas Reber', locus: 'pr:470:test/floor.test.ts:12', excerpt: 'Is the DST boundary covered?' },
    { threadId: '3', author: 'Lena Fischer', locus: 'pr:470:src/FloorResolver.ts:58', excerpt: 'This branch reads inverted to me.' },
  ]);

  L.ingestRound(PR_RESPOND_ID, [
    {
      dimension: 'ambiguity', severity: 'major',
      title: 'Reviewer: what happens when airportOperatingStartTime is unset?',
      detail: 'Thread on FloorResolver.ts — reviewer asks whether an unset airportOperatingStartTime means "no floor" or "midnight". The PR description says no-floor but the code is not obviously doing that.',
      locus: 'pr:470:thread:1',
      suggestion: 'Reply confirming unset = no floor, and point at the guard that returns early.',
    },
    {
      dimension: 'testability', severity: 'minor',
      title: 'Reviewer: add a test for the ZRH 04:00 floor case',
      detail: 'Reviewer wants an explicit test that a 03:30 requested time is lifted to 04:00 for ZRH, since that is the motivating bug.',
      locus: 'pr:470:thread:2',
      suggestion: 'Add the ZRH 03:30→04:00 case and reply with the test name.',
    },
    {
      dimension: 'consistency', severity: 'minor',
      title: 'Reviewer: maximumPreDepartureArrivalMinutes naming nit',
      detail: 'Reviewer suggests the field is verbose and asks if it can match the spec wording. Minor — likely a push-back-with-rationale.',
      locus: 'pr:470:thread:3',
      suggestion: 'Reply: keep the name to match the FTD field contract; it is the agreed spec term.',
    },
  ], { note: 'Reviewer left 3 threads on PR #470 awaiting your response.', trigger: 'manual' });

  const fp = (dim, title, locus) => L.fingerprint(PR_RESPOND_ID, dim, title, locus);

  // Threads 1 & 2 get a concrete proposed reply/fix (before→after); thread 3 is a
  // push-back the author will answer in-flow.
  L.setFindingStatus(PR_RESPOND_ID,
    fp('ambiguity', 'Reviewer: what happens when airportOperatingStartTime is unset?', 'pr:470:thread:1'),
    { status: 'reworking' });

  L.setFindingDraft(PR_RESPOND_ID,
    fp('ambiguity', 'Reviewer: what happens when airportOperatingStartTime is unset?', 'pr:470:thread:1'),
    {
      target: 'src/scheduling/FloorResolver.ts',
      format: 'text',
      before: [
        'function resolveFloor(req, airport) {',
        '  const floor = airport.airportOperatingStartTime;',
        '  return req.time < floor ? floor : req.time;',
        '}',
      ].join('\n'),
      after: [
        'function resolveFloor(req, airport) {',
        '  const floor = airport.airportOperatingStartTime;',
        '  // Unset operating start time = no floor (e.g. 24h airports).',
        '  if (floor == null) return req.time;',
        '  return req.time < floor ? floor : req.time;',
        '}',
      ].join('\n'),
    });

  L.setFindingDraft(PR_RESPOND_ID,
    fp('testability', 'Reviewer: add a test for the ZRH 04:00 floor case', 'pr:470:thread:2'),
    {
      target: 'test/floor-resolver.test.ts',
      format: 'text',
      before: [
        "test('floors below the operating start time', () => {",
        "  expect(resolveFloor({ time: '05:00' }, lhr)).toBe('05:00');",
        '});',
      ].join('\n'),
      after: [
        "test('floors below the operating start time', () => {",
        "  expect(resolveFloor({ time: '05:00' }, lhr)).toBe('05:00');",
        '});',
        '',
        "test('lifts a 03:30 request to the ZRH 04:00 floor', () => {",
        "  expect(resolveFloor({ time: '03:30' }, zrh)).toBe('04:00');",
        '});',
      ].join('\n'),
    });

  // On a pr-respond workspace the counterpart is the reviewer who left the threads.
  stampDemoActivity(PR_RESPOND_ID, 20, 'Oriol Puig');
}

module.exports = { seed, seedPrReview, seedPrRespond, FEATURE_ID, PR_REVIEW_ID, PR_RESPOND_ID, DEMO_IDS };

if (require.main === module) {
  const r = seed();
  console.log(`Seeded ${r.id}`);
}
