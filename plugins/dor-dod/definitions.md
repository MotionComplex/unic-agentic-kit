# Definitions of Ready / Done — FZAG DXP

> **Source of truth.** Mirrors the Confluence page
> [Definition of Ready/Done](https://uniccom.atlassian.net/wiki/spaces/DXP/pages/117573747/Definition+of+Ready+Done)
> (space **DXP**, Flughafen — Digital Experience 2020+). Last synced from Confluence: **2026-02-25**
> (page "lastModified"). When the page changes, update **this file only** — every `dor-dod` skill
> reads it via `${CLAUDE_PLUGIN_ROOT}/definitions.md`, so all three stay in lockstep.

The board has **nine** checklists across the delivery lifecycle. The ones marked **★ in-scope**
are the dev + specification stages the skills actively drive; the rest are kept here for lookup.

| Stage | Handoff | In scope |
|---|---|---|
| DoR for UX/Design | PO → UX | reference |
| DoR for Specification | UX → Engineer | ★ |
| DoR for Implementation (User Story) | refinement gate | ★ |
| DoR for Implementation (Bug) | — | ★ |
| DoR for Testing | dev → QA | ★ |
| DoR for productive deployment | release | reference |
| DoD for User Story | — | ★ |
| DoD Release | — | reference |

Each checklist below is the authoritative list of items. Where Confluence supplied an
*Additional Description* or *Examples*, they are quoted under the item.

---

## ★ DoR for Specification — *UX → Engineer*

- **User needs and business goals are addressed.** Decide together if a PRD is necessary and valuable.
  - *The PRD (Product Refinement Document) is up to date.*
- **Accessibility requirements are taken into account.**
  - *Accessibility requirements (contrast, readability, etc.) are taken into account.*
- **Flows, Design and Interactions are complete.**
  - All element states are available (delayed, landed, etc.).
  - All interactive element states (hover, active, disabled, etc.) are defined.
  - All flow states are recorded (e.g. success, error, loading, empty states).
  - Design is available in all 6 defined screen sizes.
  - New colors/icons/components/etc. have been added to the Global Token & Assets File and Design System File.
  - Interactions have been defined.
- **Design is ready for development handoff.**
  - Design is stored in the *Figma 1.01 — DXP Digital Experience Platform* file and is up to date.
  - All components used are either from the system or documented as new patterns.
  - Special behaviors or animations have been documented.
  - Figma file is linked to the Product Requirement Documentation.
- **Design is reviewed and approved.**
  - The design has been discussed, the technical feasibility checked, and approved by the solution architect.
  - The design has been discussed with and approved by the client/PO.

---

## ★ DoR for Implementation (User Story) — *refinement gate*

- **Business Requirements are defined (User Stories) and a common understanding of the purpose and content of the story exists.**
  - Dependencies to other initiatives are clarified.
  - If necessary, requirements are explained by the PO during Iteration Planning.
  - Design requirements are defined and documented (only relevant for development stories).
  - *Examples:* "As a user I'd like to…", "As a developer I'd like to…", "As a product owner I'd like to…".
- **QA requirements are defined.**
  - By using the fields in the story template, or contact QA for assistance.
  - Unit tests; test automation.
- **Story is specified** in a rational detail level.
  - Either in the Confluence project space or within the Story.
  - Dependencies between domains are clarified.
- **Story is refined** (technical implementation approach is defined).
- **Acceptance Criteria are defined** — as Gherkin if possible. <https://cucumber.io/docs/gherkin/reference/>
- **Estimations are done** — in Story Points.
- **Financial aspects are clear** — information about the vertec phase is defined.

---

## ★ DoR for Implementation (Bug)

- **The issue is clearly described.**
  - What happens vs. what should happen is clear.
  - Steps to reproduce are documented.
  - Expected behavior is defined.
  - Relevant screenshots or log files are provided.
- **If necessary: Bug is refined** (technical implementation approach is defined).
  - Only necessary for complex bugs; the implementing dev decides whether refinement is necessary.
- **Financial aspects are clear** — information about the vertec phase is defined.
  - Usually the same budget as the parent work item.

---

## ★ DoR for Testing — *dev → QA*

- Functionalities of a Story are implemented and acceptance criteria are met.
- Code completed according to defined Standards.
- **Unit Tests are written.**
  - It is not the goal to cover 100%.
  - Define in the Refinement if needed, or define during implementation.
- Integration is tested on the Dev environment (if possible).
- Inventory Entries are created.
- Dictionary entries are created.
- Code is reviewed and all comments are solved.
- All Artifacts are merged.
- **All Unit Tests are passing green.**
  - If QA testing on a feature branch is required, add it while working on the ticket.
- Testcases (Azure DevOps) are in place.
- Documentation / Specification is updated if needed.
- All Tasks except QA are closed in the Taskboard.

---

## ★ DoD for User Story

- Functionalities are tested on the INT environment — *tested by Unic QA*.
- Automated Tests are evaluated and follow-up tickets are created.
- All automated tests related to the implemented functionality are green.
- **All found Bugs are triaged and prioritized** — *done by the test manager (PO supports if clarification is needed)*.
- **All found Bugs with Priorities 1 and 2 are fixed.**
  - The ticket stays open until prio 1 and 2 bugs are fixed.
  - Lower-priority bugs go to the backlog to be prioritized, and the story is closed.
- Manual deployment steps are documented in the release notes.
- Exceptions/errors on INT are checked — *via AppInsights*.

---

## DoR for UX/Design — *PO → UX* (reference)

- **Problem & Goals are clear.** The problem, expected outcome and success criteria are defined; UX understands what should be achieved and why.
  - Problem statement described; objective defined; success criteria/KPIs (if available).
- **Business context & target users are defined.** UX understands the business relevance and who the solution is for.
  - Business goal explained; target group described; usage context clarified.
- **Scope, constraints & expectations are clarified.** It is clear what UX should deliver and which limitations exist.
  - In-/out-of-scope defined; expected deliverables agreed; technical/brand/legal constraints shared.
- **Budget, timeline & decision process are transparent.** UX knows the framework conditions and approval setup.
  - Budget frame (if applicable); milestones/deadlines defined; stakeholders & approval process clarified.

---

## DoR for productive deployment — *release* (reference)

- All Stories have been Closed.
- No Prio 1 Bugs are open.
- Environments are prepared and Ready for Release — *infra deployment done and successful*.
- Code is ready and the release Branch is created.
- Deployment to Integration took place.
- Acceptance Tests are passed — *functionalities tested on INT by FZAG POs*.
- Deployment Schedule is created.
- Release notes are updated.
- Go/No-go decision is made — *meeting before PROD release with the customer*.

---

## DoD Release (reference)

- All Stories have been resolved.
- No Prio 1 Bugs are open.
- Environments are prepared and Ready for Release — *infra deployment done and successful*.
- Deployment to Production has been finished.
- All automated tests are passing green.
- Manual Smoke Tests have been covered and are passing green.
- Release branch has been closed and merged back according to the branching strategy.
- Release is tagged.
- Release schedule has been updated with the done state.
- Handover to Client — *in the Review Meeting*.

---

## Deprecated

**(Outdated) DoR for Specification (User Story)** — superseded by *DoR for Specification* above.
Retained only so the skills can recognize and flag it if encountered; do **not** drive work from it.
