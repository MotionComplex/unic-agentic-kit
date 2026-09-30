# Azure DevOps Conventions

Status: **draft** — partial. Mention syntax investigation is unresolved.

## Mentions in comments — UNRESOLVED

Neither `@Display Name` nor `@<Display Name>` produces a real Azure DevOps @-mention with
notification when posted via the ADO MCP. Both render as plain text in the rendered comment.
The angle-bracket form gets HTML-escaped to `@&lt;Name&gt;`.

**Investigated:** 2026-05-08 on PR 5541 / story #41633. Trial inserted just `@` with no name.

**Workaround until resolved:** write the name plainly in the comment body and ping the
person out-of-band (Teams/email) if the comment is time-sensitive. Don't rely on ADO to
notify them.

**TODO:** identify the correct format. Candidates to try:
- API-level user ID (e.g. `@<user-guid>` or unique-name)
- Different escaping
- Posting via REST API directly rather than through MCP
- Confirm whether MCP's comment endpoint preserves mention markup at all

## Comment placement: PR vs work item

- **Findings about the diff itself** → inline thread on the PR (`repo_create_pull_request_thread`),
  anchored to the file/line range.
- **Cross-cutting findings** (spec ambiguity, scope question, test gap spanning files) → one
  **top-level PR thread per topic**. Don't bundle unrelated topics into a single overview thread.
- **Strategic / acceptance-criteria mismatches** → comment on the parent user story
  (`wit_add_work_item_comment`), not on individual sub-tasks.
- **Phase-X scope clarifications referenced in the user story's sub-tasks** → comment on the
  PR, not the ticket. The PR is where the team is currently looking.

When in doubt, ask the user where to post — don't reroute silently.

## Large diffs

`repo_get_pull_request_changes` exceeds the response token limit on PRs with >3MB diff.
Fallback:

1. `repo_get_pull_request_by_id` to get the changed-file list and the source commit SHA.
2. `repo_get_file_content` per file at that SHA.

This loses the hunk delta but gives full file content, which is usually more useful for
review anyway (you need surrounding context, not just the changed lines).

## Recursive spec discovery

Specs in Confluence often link to sub-specs (event matrices, error tables, API contracts)
that hold the actual acceptance criteria. When fetching a spec, scan it for further
Confluence links and fetch the obviously relevant ones. Limit depth to 2 to avoid running
forever.

## Don't vote on PRs unprompted

`repo_vote_pull_request` is a stronger action than commenting. Only vote when the user
explicitly asks for it.
