---
name: apply-spec
description: >
  Write a spec workspace's ACCEPTED change proposals back to their real sources — Azure DevOps
  work-item fields and Confluence pages — surgically and only on the user's explicit Apply. The
  spec-side counterpart of posting PR comments: it reads each finding's reviewed draft from the
  ledger and applies the accepted/edited ones, patching a single field/section without rewriting
  the rest of the page. Use when an `apply` request targets a `spec` workspace (the /flowlever:watch
  runner dispatches it), or when the user says "apply the accepted spec changes for X".
---

# /flowlever:apply-spec — write accepted proposals back (surgically)

You write a spec workspace's **accepted** change proposals back to ADO and Confluence. This is the
spec mirror of PR-review's "post comments" Apply: it exists **only because the user clicked Apply**
(the `apply` request IS their confirmation). Still — surface exactly what you wrote.

**The cardinal rule for Confluence: patch the target node, never regenerate the page.** The storage
format embeds proprietary macros (`<ac:structured-macro>`, `<ri:…>`, layouts) that must survive
**byte-for-byte**. Rewriting the whole body silently drops them. You edit one section and leave the
rest verbatim.

## 0. Preconditions
Self-contained: app at `${CLAUDE_PLUGIN_ROOT}/app`, ledger at `~/.flowlever`. The argument is the
spec `<wsId>`. Load the deferred MCP tools (ADO + Atlassian Rovo) with ToolSearch before writing.

> **From the queue (`/flowlever:watch`), emit phases and flag `needsInput` before the first write**
> (it can pop a 2FA/auth prompt):
> `requests set <reqId> --phase "applying spec changes (may need your approval)" --needs-input --note "Approve the auth prompt in your other window if asked."`
> then clear it after the first call succeeds. Skip when invoked directly.

## 1. Read the reviewed proposals
```
FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" finding list <wsId> --json
```
Apply a finding **only if** it carries a `draft` with a `targetRef` AND the reviewer accepted it:
- **Apply** when `draft.review.verdict` is `proposed` (or absent) and the finding is not `waived` —
  i.e. Accept or Edit.
- **Skip** when `draft.review.verdict` is `redirect` (countered — it's waiting on a re-audit re-draft)
  or `reject` (the user said don't apply), or the finding is `waived`, or there's no `targetRef`
  (Figma / hand-off drafts are not auto-written — list them for the user instead).

The **effective new text** for a finding = the edited text if the user edited it
(`draft.review.hunks["0"].editedText` when that hunk's `status` is `edited`), otherwise `draft.after`.

## 2. Apply each accepted proposal — surgically, with a concurrency check
Re-fetch the live source first and 3-way check it against `draft.before`. If the source changed
materially since the proposal was drafted, **do not clobber it** — skip that finding, set it back to
`open`, and report it so the user can re-propose against the new reality.

### Azure DevOps (`targetRef.system === "ado"`)
1. `mcp__azure-devops__wit_get_work_item` for `targetRef.adoId`; read the current value of
   `targetRef.field`.
2. If it still matches `draft.before` (ignoring trivial whitespace), `mcp__azure-devops__wit_update_work_item`
   setting `targetRef.field` to the effective new text. If it diverged, skip + report (see above).

### Confluence (`targetRef.system === "confluence"`)
1. `mcp__claude_ai_Atlassian_Rovo__getConfluencePage` for `targetRef.pageId` **in storage format**,
   with its current `version.number`.
2. **Concurrency:** if the live `version.number` !== `targetRef.version`, the page was edited since you
   drafted — skip + report (don't overwrite a newer version blindly), unless the user explicitly asked
   to force it.
3. **Surgical patch:** in the storage XHTML, find ONLY the target node — the section under the
   `targetRef.anchor` heading, or the exact element whose text matches `draft.before`. Replace that
   node's inner content with the effective new text rendered to **valid storage XHTML**. Leave every
   other byte — especially every `<ac:…>` / `<ri:…>` macro and layout wrapper — untouched. Never
   serialize a freshly-built body; mutate the fetched one.
4. `mcp__claude_ai_Atlassian_Rovo__updateConfluencePage` with the patched storage body and
   `version.number = <the version you fetched>` (the API stores it as +1). Title and representation
   unchanged.

If a node can't be located unambiguously (heading missing, `before` doesn't match), **do not guess** —
skip that finding and report it for a manual/re-proposed fix.

## 3. Record what landed
For each finding you **successfully wrote**, mark it `applied` — this stamps `appliedAt`, moves the card
from the transient **Applying…** lane into **Applied — awaiting re-audit**, and clears the in-flight
`pending` marker. (Resolution is still earned by the next audit — don't pre-declare it resolved; if the
edit didn't truly fix it, the re-audit keeps it open and catches regressions.)
```
FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" finding applied <wsId> --fps <fp>[,<fp>...]
```
For any finding you **skipped** (concurrent edit / unlocatable node / countered / rejected), clear its
in-flight marker so it doesn't sit stuck in "Applying…" — send it back to `open` (or `reworking`):
```
FLOWLEVER_DATA="${FLOWLEVER_DATA:-$HOME/.flowlever}" node "${CLAUDE_PLUGIN_ROOT}/app/src/cli.js" finding set <wsId> <fp> --status open
```
(A status change clears `pending` automatically.) Leave countered/rejected findings' verdicts as they are.

## 4. Summary + next step
Report, per finding: ✅ written (`ado:<id>#<field>` / `confluence:<page>#<section> v<old>→v<new>`),
⏭ skipped (why: countered / concurrent edit / no target / unlocatable node). From the queue, mark the
request `done --phase "applied to spec"`. Then recommend re-running **`/flowlever:audit <wsId>`** to
verify the edits landed, auto-resolve what's genuinely fixed, and catch any regression.
