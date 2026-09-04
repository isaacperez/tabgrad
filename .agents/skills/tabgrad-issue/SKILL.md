---
name: tabgrad-issue
description: Create, refine, triage, split, relate, or update a Tabgrad GitHub issue throughout its lifecycle using the repository's issue rules. Use when issue content, metadata, relationships, or project state must be managed. Do not use to implement, verify, independently review, or merge a repository change.
---

# Manage a Tabgrad issue

Produce an issue that another contributor can understand, classify, and verify
without relying on an earlier conversation. Preserve uncertainty instead of
turning an unconfirmed implementation idea into a requirement.

## Read the rules and relevant evidence

Read `docs/README.md`, `docs/project-management.md`,
`docs/agent-workflow.md`, `docs/development.md`, and the `Before
starting work`, `Handling unexpected findings and pending decisions`,
`Defining an issue`, and `Making architectural decisions` sections of
`CONTRIBUTING.md`. Read `README.md` when the request depends on Tabgrad's public
purpose, identity, execution model, or compatibility promises.

Inspect the relevant repository documentation, code, tests, existing issues,
and pull requests before filling gaps from memory. Use authoritative external
sources when the issue depends on behavior defined outside Tabgrad.

Do not use this skill to decide unresolved architecture. When an architectural
question materially affects the expected result, prepare a research issue that
states the question, alternatives, and required evidence.

## Determine the requested action and authority

Distinguish between drafting content and changing GitHub. A request to discuss,
explain, assess, or draft an issue does not authorize creating or modifying it.
A request to create or update an issue authorizes only the specified issue and
the metadata or relationships that are clearly part of that request.

Before a mutation, resolve the repository and the exact issue when one already
exists. Identify every proposed GitHub change, including comments, labels,
project fields, milestones, parent or sub-issue relationships, and
dependencies. Ask the user about any additional mutation that is not already
authorized.

Do not publish credentials, private data, or sensitive vulnerability details
in a public issue. Follow the private reporting rule in `CONTRIBUTING.md`.

## Search before a publishable draft or creation

Before preparing a complete draft intended for publication or creating a new
issue, search open and closed issues and pull requests. Repeat the search
before materially expanding an existing issue when its recorded coverage no
longer includes the proposed result.

A rough outline may be discussed before this search. Mark it as preliminary,
do not claim that it is ready, and do not state that related work was not found.

Start with the least expensive method that can establish complete coverage. A
single enumeration may satisfy the search when it includes the complete issue
and pull-request history, lets the proposed problem and established alternative
terms be compared with titles and bodies, and is small enough to inspect
responsibly. Read every plausible match. Do not add redundant query variations
or delegate the same inspection merely to repeat evidence that is already
complete and unambiguous.

Expand the search when the initial result is incomplete, truncated, paginated
beyond the inspected data, too broad to inspect responsibly, or leaves a
plausible classification uncertain. Use targeted searches based on the
affected API or operation, symptoms, error messages, backend or browser area,
and established alternative terms. Inspect the additional results needed to
resolve the gap and stop when the classifications are supported or a remaining
limitation has been identified.

Delegate a bounded read-only check to one subagent when the scale of the result
or a material ambiguity makes independent judgment useful. Examples include
several plausible matches or uncertainty about whether work is a duplicate,
related work, a parent or sub-issue, or a dependency. Do not require a
subagent for a complete and reproducible search whose classifications are
unambiguous.

Give the subagent the proposed problem and result, the repository identity,
the unresolved candidates or coverage gap, the search evidence already
obtained, and `docs/project-management.md`. Apply the read-only assignment and
evidence rules in `docs/agent-workflow.md`. Ask it to inspect the unresolved
part instead of repeating completed work. Require it to return:

- the method and searches it used;
- the work population or result set it actually covered;
- exact duplicates;
- related but independent work;
- possible parent or sub-issue relationships;
- possible blocking relationships;
- the evidence for each classification; and
- any remaining uncertainty.

The subagent must not create or edit issues, comments, relationships, labels,
milestones, project items, or other GitHub state.

If required search coverage or a materially necessary independent judgment is
unavailable, stop before creating the issue and explain the exact gap. A
preliminary draft may still be provided when useful, but it must identify the
search as pending and must not be classified as `Ready`. The absence of a
subagent is not a gap when the completed search is reproducible, fully covered,
and unambiguous.

Record the search method, its actual coverage, material classifications, and
remaining uncertainty. When a subagent was used, inspect the evidence behind
its material classifications. Do not accept a classification without checking
the issue or pull request that supports it, but do not repeat the entire search
solely to reproduce the subagent's work.

Do not create an exact duplicate. Propose adding genuinely new evidence to the
existing issue instead. When a similar issue is closed, read its closing reason
before deciding whether changed circumstances justify reopening it or creating
separate work.

## Define one verifiable result

Keep one independently verifiable result in each issue. Split work when parts
can be implemented, reviewed, accepted, or reversed independently.

Use a parent issue to describe a larger result and sub-issues for its
independently completable parts. Use a dependency when one issue cannot proceed
until another produces a required result. Use a plain related link only when
neither hierarchy nor blocking applies.

Do not prescribe an implementation that has not been investigated. Distinguish
known facts, reasonable conclusions supported by evidence, and questions that
remain unanswered.

When information from the user is required, explain the evidence, affected
work, realistic alternatives, consequences, recommendation, and exact decision
needed. Continue only with work that does not assume the answer.

## Write the issue

Use the common sections and the additional content for the selected type from
`docs/project-management.md`. Keep the title specific and do not add a type
marker to it.

Use the headings produced by the applicable repository issue form. When no
form is available, use descriptive headings for the required type-specific
information rather than hiding it in an unrelated common section.

Completion conditions must describe observable behavior or reproducible
evidence. Do not use generic activities such as writing code, adding tests, or
updating documentation as substitutes for the required result. The normal
testing and documentation rules already apply through `CONTRIBUTING.md`.

Record the duplicate search in `Dependencies and related work`. Link every
relevant issue or pull request and explain the relationship. If nothing was
found, state that no related issues or pull requests were found after
searching.

For a research issue, require a reproducible investigation and a reasoned
conclusion, not a predetermined technical outcome.

## Classify and plan the work

After triage, apply exactly one documented `type:` label and at least one
documented `area:` label. Apply every relevant `concern:` label and no
irrelevant label. An incomplete report may remain temporarily unclassified
only while it is in `Triage` or `Needs information`. Do not invent a label when
the documented catalog cannot express a one-off detail.

Propose a project status, priority, and size using the definitions in
`docs/project-management.md`. Do not duplicate those values as labels.

Use `Needs information` when the issue cannot yet be evaluated because a
specific answer or piece of evidence is missing. Use `Blocked` only when work
that was ready or active cannot continue because of a documented impediment.

Assign a milestone only when the issue is necessary to complete that
milestone's stated result. Topical similarity is not sufficient.

Before marking an issue `Ready`, check every readiness condition in
`docs/project-management.md`. Keep it in `Triage` or `Needs information` when a
condition is not met.

## Manage project status changes

Use the responsibility table and transition conditions in
`docs/project-management.md`. The skill performing implementation, research,
pull request publication, verification, review, merge, or other active work
establishes when its transition conditions are met. This skill performs and
verifies the authorized issue and project mutation.

Before changing a status, identify the current status, proposed destination,
evidence for the destination, responsible contributor, related branch or pull
request, blocker or closing reason when applicable, and every accompanying
metadata change. Set the issue to its actual current state rather than replaying
intermediate states that are already obsolete.

Do not infer authority from the status that was set earlier. Confirm that the
current request authorizes this transition and its required comment,
assignment, relationship, or other metadata. If only part of the coherent
transition is authorized, present the complete proposed mutation and wait
rather than leaving the issue misleading.

After changing the status, reopen both the issue and project item. Confirm that
the status, assignee, relationships, branch or pull request links, and required
explanation agree with the work's actual state.

## Review before changing GitHub

Inspect the complete proposed issue and metadata. Confirm that:

- the title and body agree;
- the problem, reason, expected result, boundaries, and completion conditions
  are clear;
- all type-specific information is present;
- duplicate, related, parent, sub-issue, and dependency findings are handled;
- labels and project fields follow the documented definitions;
- known effects, risks, limitations, and uncertainty are visible;
- the issue contains no unsupported compatibility or implementation claim; and
- every intended GitHub mutation is authorized.

If a material decision remains with the user, present the proposed issue and
the exact question, then wait. Do not perform a partial mutation that would
leave misleading metadata or relationships.

## Perform and verify authorized mutations

Use an authenticated GitHub interface appropriate to the environment. Apply
only the authorized content, labels, project fields, milestone, and
relationships.

Apply the GitHub access diagnosis in `docs/development.md` before classifying a
failed request as an invalid credential or asking the user to authenticate.
Network, authentication, authorization, and credential-scope failures have
different remedies. Do not use a browser or change a stored credential without
the evidence and authority required by that document.

Before creating an issue, confirm that every required label and project field
exists and that the available credentials can read and apply the required
metadata. Do not create missing repository infrastructure as an incidental
part of issue creation. If required infrastructure is absent or inaccessible,
stop and report the exact setup or permission that is needed. Create an
incomplete issue in `Triage` only when the user explicitly authorizes that
exception and its missing metadata is visible.

If a create or update operation fails or returns an ambiguous result, inspect
GitHub before retrying. Do not create a duplicate because the first result was
unclear.

After a mutation, reopen the issue and verify its title, body, labels, project
fields, milestone, state, and relationships against the approved proposal.
Correct a discrepancy only when that correction is authorized.

## Report the result

Report:

- whether an issue was drafted, created, updated, or left unchanged;
- the issue link and number when one exists;
- the duplicate search conclusion and important related work;
- its type, areas, concerns, status, priority, size, milestone, and
  relationships;
- every GitHub mutation performed; and
- missing information, blockers, uncertainty, or further authorization needed.

Never report that an issue is ready merely because it was created.
