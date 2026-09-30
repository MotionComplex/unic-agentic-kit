# Code Review Conventions

Status: **draft** — used personally; not yet promoted to team repos.

## Comment labels: Conventional Comments

Use [Conventional Comments](https://conventionalcomments.org/) for all review feedback —
markdown drafts, inline PR threads, ad-hoc pair-programming notes.

Format: `label (decoration): subject`.

Active labels:

| Label | Meaning | Decoration |
|---|---|---|
| `issue` | A problem in the code. | `(blocking)` if must be fixed before merge, `(non-blocking)` otherwise |
| `suggestion` | A concrete proposed change that isn't strictly required. | usually none |
| `question` | Needs the author to clarify. Prefer over `issue` when uncertain. | usually none |
| `nitpick` | Trivial preference (style, naming, wording). Always non-blocking. | `(non-blocking)` |

Other Conventional Comments labels (`praise`, `todo`, `thought`, `chore`, `note`) are
allowed when they fit, but the four above cover most cases.

**Do not** invent custom severity labels (🔴/🟡/🟢, P0/P1, "must-fix") in place of these.

Examples:
- `issue (blocking): missing null check on line 42`
- `suggestion: extract this retry policy into a helper`
- `question: should this short-circuit on empty input?`
- `nitpick (non-blocking): naming — prefer "fetch" over "get" here`

## Confidence floor

If a finding requires speculation about runtime behavior or external state you can't verify,
either drop it or convert it to a `question`. Speculative `issue`s waste the author's time
and erode review trust. Read more code first; if still uncertain, ask.

## Anchoring

Every finding must reference `path/to/file.ext:line` or `path/to/file.ext:start-end`. Findings
without a code anchor are unactionable — drop them or find the right anchor.

## Length

Budget: **≤300 characters, ≤2 sentences.** Measured over my own review ledger (~220 findings across
~45 workspaces, as of 2026-09): comment bodies ran a median of ~490 characters, ~15% of them over
1,000, the longest 3,386. Roughly half of a comment's wording also appeared in the supporting text
rendered directly above it, so one review decision cost ~1,300 characters of part-repeated prose
where a fraction would have done. That is one reviewer's snapshot rather than research, and it
drifts as the ledger changes — the order of magnitude is the point.

Structure, in order — then stop:

1. **Label** (see above).
2. **The ask.** Stated directly, not built up to through a paragraph of reasoning — that reasoning
   belongs wherever the review keeps its supporting text, not in the comment the author receives.
3. **At most one clause of consequence.** Why it matters, in a phrase, not a paragraph.

Rules that make the budget work:
- **Say it once.** If a sentence restates what the previous sentence — or the supporting text above
  it — already said, cut it. Repetition is the biggest cost a reviewer pays per finding.
- **No scene-setting.** Don't recap the PR, the file, or the reviewer's own point back to its
  author.
- **Plain words, precise specifics.** Keep the identifier, file, and number exact; say "this passes
  when the list is empty," not "exhibits a vacuous-pass boundary condition."
- **Split, don't stack.** A comment that needs more than 300 characters is usually two findings —
  file each on its own anchor.

The label pays for itself here too: in the same ledger about a third of comments opened with an
ad-hoc word instead ("adding", "agreed", "you're", "validate") — characters spent carrying no
information a label would not have carried better.

**Before → after:**

> `issue: Looking at this part of the diff, the retry loop here doesn't have any kind of ceiling
> on it, so if the endpoint keeps failing forever, this is going to keep retrying forever too,
> which could end up hammering the service and making the outage worse instead of better.
> Probably want some kind of max-attempts check before it loops back around and tries again.`
> (365 chars — scene-setting, then the ask arrives in the second sentence)

> `issue (blocking): Cap retries — `if (retryCount >= MAX_RETRIES) return;` — or a persistently
> failing endpoint retries forever.` (126 chars — label, ask, one clause of consequence)

## When to use this convention

- Personally, in any review I produce (markdown drafts, inline PR threads).
- The `pr-review` and `pr-respond` skills (standalone and FlowLever) enforce it.
- When promoting to a team: copy to the team repo's `docs/conventions/code-review.md`
  using `../templates/docs-conventions/code-review.template.md`.
