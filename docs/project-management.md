# Managing work on GitHub

This document defines how Tabgrad uses GitHub issues, labels, projects,
milestones, and relationships. Its purpose is to make the state and meaning of
work consistent and understandable to contributors and coding agents.

The general development workflow is described in
[`CONTRIBUTING.md`](../CONTRIBUTING.md). This document defines the information
and classification that each unit of work must carry.

## General rules

Each piece of information has one authoritative location:

- The issue explains the problem and the result that is needed.
- Labels classify the kind of work, the affected areas, and important
  concerns.
- The project records workflow status, priority, and size.
- A milestone groups work needed to complete one bounded objective or release.
- Sub-issues divide a larger result into independently completable work.
- Issue dependencies record which work blocks other work.
- A pull request contains and verifies the proposed repository change.

Except for the small no-issue correction allowed by `CONTRIBUTING.md`, every
pull request identifies exactly one primary issue whose result it implements.
Other linked issues retain their own status and must state their relationship
to the change. An independently mergeable part of an implementation becomes
its own issue rather than a partial pull request for a larger implementation
issue. Research artifacts and lasting documentation may remain linked to their
research issue as defined below.

Do not represent the same property in more than one of these places. In
particular, do not create status or priority labels when those values already
exist as project fields.

All issues accepted for work must be added to the Tabgrad development project.
Pull requests are linked to their issues rather than tracked as duplicate
project items. A pull request without an issue is permitted only for a small,
self-contained correction allowed by `CONTRIBUTING.md`.

## Before creating an issue

Search existing issues and pull requests before creating a new issue. Search
both open and closed work because a closed item may already contain the answer,
record a rejected approach, or identify the issue that replaced it.

Use more than the proposed title in the search. Relevant terms may include the
affected API or operation, observable symptoms, error messages, backend,
browser component, and established alternative names. Read plausible matches
before deciding that no related work exists.

Classify each relevant result as one of the following:

- An exact duplicate describes the same problem and needs the same result.
- Related work shares context or an affected area but has an independent
  result.
- A parent issue describes a larger result of which the proposed work is one
  independently completable part.
- A dependency must be completed before the proposed work can proceed, or will
  itself be blocked by the proposed work.

Do not create an exact duplicate. Add missing evidence or requirements to the
existing issue when authorized. Do not create a replacement merely because the
existing issue is closed; first read why it was closed and decide whether it
should be reopened or whether changed circumstances justify separate work.

Create a separate issue for related work only when it has an independently
verifiable result. Link the related issue for context. Use GitHub's parent,
sub-issue, and dependency relationships when they describe the relationship
directly.

The `Dependencies and related work` section of a new issue must contain the
relevant links and explain each relationship. When the search finds nothing,
state that no related issues or pull requests were found after searching.

Creating an issue, adding a comment, reopening an issue, or changing a GitHub
relationship or project field requires authority for that external action. A
coding agent may perform the searches and prepare the proposed content without
such authority, but it must not perform the mutation.

## Minimum content for every issue

An issue must contain enough information for another contributor to understand
the need, decide whether the work is ready, and verify the result. A title and
a checklist alone are not sufficient.

Use the common section headings below in the order shown. An issue form may
present the same information as separate fields, but it must preserve the same
meaning and produce a readable issue body. Add the information required by the
selected issue type after the common sections.

### Title

The title must describe the result or question in plain language. It should be
specific enough to distinguish the issue from other work.

Do not add markers such as `[Bug]` or `[Feature]` to the title. Labels carry
that information.

### Problem

Explain the current problem, missing capability, or unanswered question. State
what is known rather than assuming that the reader has followed an earlier
conversation.

### Why it matters

Explain the effect on users, contributors, compatibility, correctness,
performance, maintainability, or another project goal. This section should
make clear why the issue is worth doing.

### Expected result

Describe the observable result after the issue is complete. Do not prescribe a
particular implementation unless that implementation has already been decided
and documented.

### Included and excluded work

State the behavior, interfaces, components, files, environments, and risks that
the issue includes when they are known. State what it deliberately excludes and
which nearby concerns do not need investigation for this result. An exclusion
should become a separate issue when it is still necessary work.

The issue must be narrow enough that a contributor can identify the relevant
evidence without reviewing the whole repository by default. If the boundary is
unknown, use a research issue to establish it. If the result contains parts
that can be completed and verified independently, use a parent and sub-issues
or separate related issues instead of one open-ended issue.

### Completion conditions

List conditions that can be tested, inspected, or otherwise demonstrated. The
conditions must describe completed behavior or evidence, not merely activities
such as writing code or adding tests.

Tests, documentation, formatting, and repository checks remain required by
`CONTRIBUTING.md`. They should be mentioned explicitly when the issue has
unusual requirements, but they do not need to be repeated as generic
checkboxes in every issue.

### Dependencies and related work

Link any issue that blocks this work, is blocked by it, overlaps with it, or
provides necessary context. Use GitHub's dependency and sub-issue relationships
when they express the relationship directly. A plain link is sufficient only
for related context that is neither a dependency nor a parent-child
relationship.

If there are no known dependencies or related issues, say so.

### Effects and risks

State every known effect on public APIs, PyTorch compatibility, architecture,
performance, memory use, browser support, security, privacy, dependencies, and
documentation. An issue does not need a separate paragraph for every item, but
it must not hide an effect that is already known.

Unknowns that could materially change the scope or design must be resolved
before implementation, or the work must first become a research issue.
For non-trivial implementation, the issue or a linked accepted decision must
also identify the governing invariant, assumptions that affect the design,
realistic alternatives, and any material tradeoff that remains. Do not mark an
issue `Ready` while the implementer would still have to choose silently among
materially different results.

## Additional content by issue type

The common content above is always required. The following information is also
required when it applies to the selected issue type.

### Bug

A bug issue must include:

- the smallest available reproduction;
- the actual behavior;
- the expected behavior and the source for that expectation;
- the Tabgrad version or commit where the problem was observed;
- the relevant browser, operating system, backend, and hardware information;
- error messages, logs, screenshots, or other evidence when available; and
- whether the behavior is known to have worked before.

When the report lacks enough information to reproduce or understand the
problem, keep it in `Needs information` rather than moving it to `Ready`.

Do not publish exploit details or sensitive information in a public bug issue.
Use the private reporting process described by the repository security policy
when one is available.

### Feature

A feature issue must include:

- the user or developer need that motivates the feature;
- an example of the intended observable behavior;
- the affected public interface, if one is known;
- relevant PyTorch documentation or behavior when compatibility is claimed;
  and
- important behavior that is deliberately deferred.

A feature issue should describe what users need. It should not turn an
unresolved implementation idea into a requirement.

### Research

A research issue must initially include:

- the exact question that needs an answer;
- the decision that the answer will inform;
- the realistic alternatives to compare;
- the evidence that is already available;
- the experiment or investigation that will produce missing evidence;
- the environments, inputs, and measurements needed for a fair comparison;
  and
- the conditions that will make the investigation complete.

Before the issue is completed, it must also record:

- the method that was actually used;
- the results and enough information to reproduce them;
- limitations or uncertainty in the evidence;
- the conclusion and the reasons for it; and
- the consequences for Tabgrad's architecture, implementation, tests, or
  documentation.

A research issue is not complete because an experiment ran. It is complete
when it provides evidence that supports a bounded decision. An inconclusive
result can support a decision to preserve the current behavior, defer a change,
or perform a specific follow-up investigation. A failed or incomplete method
does not satisfy the issue merely because it produced no answer. Completion
conditions must not require a predetermined conclusion.

### Maintenance

A maintenance issue must include:

- evidence of the duplication, complexity, obsolete code, dependency problem,
  weak test, or other maintenance concern;
- the code, tooling, or documentation affected;
- the behavior that must remain unchanged; and
- the concrete improvement expected from the work.

Do not create a maintenance issue solely from a preference for a different
style. There must be a specific effect on correctness, comprehension,
testability, performance, security, or ongoing maintenance.

### Documentation

A documentation issue must include:

- the intended reader;
- the question that the current documentation does not answer correctly;
- the documents or public behavior involved; and
- the sources that establish the correct information.

Examples must describe behavior that Tabgrad implements and verifies. Planned
behavior must not be presented as current behavior.

## Labels

Labels classify relatively stable properties of an issue. They do not replace
the issue description and they do not record workflow progress.

After triage, every issue accepted for work must have exactly one `type:` label
and at least one `area:` label. It may have any number of relevant `concern:`
labels. An incomplete external report may remain temporarily unclassified
while its project status is `Triage` or `Needs information`.

Label names use lowercase English. Category labels use a category followed by
a colon and a space. Labels must have a complete description in GitHub.

### Type labels

Type labels use the color `#7057ff`.

| Label | Use |
| --- | --- |
| `type: bug` | Existing behavior is incorrect. |
| `type: feature` | The work adds or extends observable behavior. |
| `type: research` | Evidence is needed before a decision can be made. |
| `type: maintenance` | The work improves the repository without intentionally changing public behavior. |
| `type: documentation` | Documentation is the main result of the work. |

Choose the type from the main result of the issue. For example, implementing a
missing compatible operation is a feature, while correcting an implemented
operation that disagrees with its documented behavior is a bug. Both may also
carry `concern: compatibility`.

### Area labels

Area labels use the color `#1d76db`.

| Label | Use |
| --- | --- |
| `area: python-api` | The Python-facing API or its behavior is affected. |
| `area: javascript-api` | The JavaScript-facing API or its behavior is affected. |
| `area: browser` | Browser execution, workers, Pyodide integration, or browser support is affected. |
| `area: tensors` | Tensor representation, operations, shapes, data types, storage, or views are affected. |
| `area: autograd` | Automatic differentiation or gradient behavior is affected. |
| `area: cpu` | CPU execution is affected. |
| `area: webgpu` | WebGPU execution or WGSL code is affected. |
| `area: tooling` | Build, test, development, packaging, or repository tooling is affected. |
| `area: documentation` | Documentation itself is the affected project area. |

These areas describe stable project responsibilities rather than an internal
module layout. Add a new area only when several issues need to be filtered or
assigned by a responsibility that the existing areas cannot express.

### Concern labels

Concern labels normally use the color `#fbca04`. Security and breaking changes
use `#d73a4a` because overlooking them can cause serious harm.

| Label | Use |
| --- | --- |
| `concern: compatibility` | The work changes or verifies a PyTorch compatibility claim. |
| `concern: architecture` | The work may establish or change a lasting architectural decision. |
| `concern: performance` | Runtime speed, startup time, shader compilation, or transfer cost is material to the work. |
| `concern: security` | The work has a security consequence. |
| `concern: privacy` | The work affects where user code or data is processed or retained. |
| `concern: dependencies` | A third-party package, tool, license, or update policy is involved. |
| `concern: breaking-change` | Existing supported code may need to change. |

### Contributor labels

Contributor labels use the color `#0e8a16`.

| Label | Use |
| --- | --- |
| `good first issue` | The issue is ready, small, well explained, and does not require an unresolved architectural decision. |
| `help wanted` | The issue is ready and maintainers are actively inviting an external contribution. |

Do not use `good first issue` merely because a change looks short. A new
contributor must be able to complete it from the issue and repository
documentation without discovering hidden requirements.

### Labels that are not used

Do not create labels for status, priority, size, missing tests, or missing
documentation. Those facts already have another authoritative location or are
normal requirements for completing work.

Do not create a label for a single issue. A new label must support repeated
filtering, assignment, reporting, or automation. Before adding one, check that
an existing label cannot express the same property.

When a label is renamed or removed, update this document and migrate every
open issue that uses it as part of the same change.

## The Tabgrad development project

The project tracks issues accepted for work. It uses the following fields.

### Status

Every project item has exactly one status:

| Status | Meaning |
| --- | --- |
| `Triage` | The issue has not yet been fully understood, classified, and evaluated. |
| `Needs information` | A specific answer or piece of evidence is needed before triage can finish. |
| `Ready` | The work is sufficiently defined and can be started. |
| `In progress` | A responsible contributor has begun the work. |
| `In review` | The implementation or research conclusion is ready for review. |
| `Blocked` | Ready or active work cannot continue because of a documented impediment. |
| `Done` | The completion conditions and repository requirements have been satisfied. |
| `Not planned` | The issue has been declined, superseded, made obsolete, or closed as a duplicate. |

`Needs information` is used for incomplete understanding. `Blocked` is used
only when otherwise ready or active work is prevented from continuing.

An issue moved to `Not planned` must have a closing comment that explains why.
A duplicate must link to the issue that remains authoritative.

### Priority

Every issue accepted for work receives exactly one priority during triage:

| Priority | Meaning |
| --- | --- |
| `Critical` | The issue concerns a serious security problem, data loss, broadly incorrect results, an unusable default branch, or a release that cannot proceed. |
| `High` | The issue causes substantial harm to common work or blocks an important project objective. |
| `Normal` | The issue is worthwhile but does not justify displacing higher-priority work. This is the usual priority. |
| `Low` | The issue has narrow impact, is optional, or can reasonably wait without harming other work. |

Priority describes importance and urgency. Dependencies describe execution
order. Do not raise priority merely because another issue depends on the work.

### Size

Every issue accepted for work receives one size before it moves to `Ready`:

| Size | Meaning |
| --- | --- |
| `Small` | The change is localized, the expected behavior is clear, and no architectural decision remains. |
| `Medium` | The change crosses several files or components, but its design and boundaries are understood. |
| `Large` | The result crosses major responsibilities, contains substantial uncertainty, or may need several independently reviewable changes. |

Size expresses scope and uncertainty, not a promised duration. A large issue
must be considered for division into sub-issues before implementation. If it
cannot be divided safely, the issue must explain why.

### Project views

The project should provide these saved views:

- `Triage` shows items in `Triage` and `Needs information`.
- `Ready` shows ready work ordered by priority.
- `Current work` shows `In progress`, `In review`, and `Blocked` work.
- `Milestones` groups unfinished work by milestone.

Views present the same underlying fields. They must not introduce a second
status or priority system.

## Moving work through the project

The skill responsible for the current kind of work establishes whether the
conditions for a transition are satisfied. `tabgrad-issue` performs and
verifies every authorized issue or project mutation. Documented automation may
perform a deterministic transition, but it does not replace the judgment that
establishes whether the destination is truthful.

| Destination | Who establishes that the conditions are satisfied |
| --- | --- |
| `Triage` | `tabgrad-issue`, or project automation when a new issue is added. |
| `Needs information` | `tabgrad-issue` during issue definition or triage. |
| `Ready` | `tabgrad-issue` after complete triage. |
| `In progress` | `tabgrad-implement` for implementation, `tabgrad-research` for research, `tabgrad-maintenance` for a tracked audit, or `tabgrad-issue` for coordination-only work. |
| `In review` | `tabgrad-pull-request` for implementation, `tabgrad-research` for a research conclusion, or `tabgrad-maintenance` for a tracked audit report. |
| `Blocked` | The skill performing the work when it establishes a concrete impediment. |
| `Done` | `tabgrad-merge` for merged implementation, `tabgrad-research` for completed research, `tabgrad-maintenance` for an accepted tracked audit, or `tabgrad-issue` for coordination-only work. |
| `Not planned` | `tabgrad-issue` after the closing reason and relationships have been established. |

The skill named in the second column does not gain authority to change GitHub
merely because it established the condition. It must use `tabgrad-issue` for
the mutation when the user authorized it. A previous transition does not grant
continuing authority for later transitions.

Set the status to the work's current state, not the state expected next. Do not
move an issue because time passed, a branch exists, a draft pull request was
opened, or some checks passed. If the recorded status is stale, correct it only
after establishing the actual state and obtaining authority for the mutation.

### Moving to Triage or Needs information

A new issue enters `Triage` so that its content, relationships, labels,
priority, size, and readiness can be evaluated. An issue reopened because its
earlier resolution was incorrect also returns to `Triage`. Create a separate
issue instead when a completed issue remains valid and a later regression or
new requirement needs different work.

Move an issue to `Needs information` when a specific answer or piece of
evidence is required to finish triage. Record what is missing and who or what
can provide it. When the information arrives, return the issue to `Triage` for
evaluation, or move it directly to `Ready` only when the same authorized
triage establishes every readiness condition.

### Moving to Ready

An issue can move to `Ready` only when:

- it contains all common information and all information required by its type;
- it has exactly one type label and at least one area label;
- its concern labels are current;
- it has a priority and a size;
- its completion conditions are verifiable;
- its dependencies and sub-issues are represented in GitHub;
- no material question about scope or expected behavior remains; and
- any earlier architectural investigation on which the issue depends has
  concluded.

A research issue may move to `Ready` with its research question unanswered
because answering that question is the issue's purpose. Its investigation
method and completion conditions must still be defined.

An issue returns to `Ready` when previously started work is relinquished, no
active pull request or investigation remains, and the issue is still complete
and unblocked. Remove or update the assignee and branch information as part of
the same authorized change so that the issue is not falsely advertised as
active.

### Moving to In progress

An issue can move to `In progress` only when a responsible contributor is
assigned and work has actually begun. Repository changes must use the branch
and pull request workflow in `CONTRIBUTING.md`.

An issue that only coordinates sub-issues does not need its own branch. Its
status reflects whether work on its required sub-issues has begun.

`tabgrad-implement` establishes this transition for implementation work.
`tabgrad-research` establishes it for research, and `tabgrad-maintenance`
establishes it for an audit tracked by an issue.
`tabgrad-issue` establishes it for an issue whose only work is coordinating
other issues. Each workflow must identify the responsible contributor before
requesting the mutation.

### Moving to In review

An implementation issue moves to `In review` when it has a linked pull request
that is ready for review, contains the required verification evidence, and
will complete that issue. Independently mergeable partial results must be
represented by their own issues before this transition.

A research issue moves to `In review` when its results, limitations,
conclusion, and consequences for the decision it informs have been recorded for
evaluation. `tabgrad-research` establishes this transition. Also use
`tabgrad-architecture` when the conclusion may establish or change lasting
architecture. A documentation change resulting from the decision may use a
separate pull request linked to the research issue.

After a research conclusion is accepted, the issue may remain `In review`
while lasting repository documentation required by its completion conditions
is prepared, reviewed, merged, and checked under the same issue. Architectural
research must also satisfy `tabgrad-architecture`. Use a separate
implementation issue when the work changes production behavior or has an
independently reviewable result other than lasting documentation or an
experimental artifact already required by the research issue; do not create
one merely to work around the project status.

A maintenance issue whose result is an audit moves to `In review` when its
scope, methods, evidence, findings, rejected candidates, and limitations are
recorded for evaluation. A maintenance issue whose result is a repository
change follows the implementation and pull request path instead.

If an implementation pull request no longer satisfies the ready-for-review
conditions, `tabgrad-pull-request` establishes its return to draft and the
issue's return to `In progress`. If a research conclusion needs material new
investigation, `tabgrad-research` establishes the research issue's return to
`In progress`. Both changes require current authority and are performed through
`tabgrad-issue`.

### Moving to Blocked

An issue can move to `Blocked` only when it names the concrete impediment and
what must happen to remove it. Use a GitHub issue dependency when another issue
is the impediment. For an external impediment, add a comment with the evidence
and the next possible action.

The skill performing the current work establishes whether the impediment
actually prevents progress and uses `tabgrad-issue` for an authorized status,
comment, or dependency change. Do not use `Blocked` merely because a task is
difficult, a review found corrections, or a nonessential environment is
unavailable.

When the impediment is removed, return the issue to `In progress` if its
responsible contributor resumes work, to `Ready` if nobody is continuing it,
or to `In review` only when that status's entry conditions are already
satisfied. Record the evidence that removed the impediment.

### Moving to Done

An implementation issue can move to `Done` only after its change has been
merged and all completion requirements in `CONTRIBUTING.md` have been met.

A research issue can move to `Done` when its exact conclusion and proposed
project response have been explicitly accepted by the user directing the work
or a repository maintainer authorized to decide the question. The acceptance,
required decisions, and follow-up issues must be recorded. Required repository
documentation must be merged into its target branch and checked there. An
issue that only coordinates sub-issues can move to `Done` when all of its own
completion conditions and required sub-issues are complete.

Closing an issue is not by itself evidence that the work is done. Issues closed
without completing the intended result use `Not planned`.

`tabgrad-merge` establishes `Done` for implementation after checking the merge
and post-merge state. `tabgrad-research` establishes it for research;
architectural research must also satisfy `tabgrad-architecture`.
`tabgrad-maintenance` establishes it for a tracked audit after its report has
been accepted and its required follow-up work has been recorded.
`tabgrad-issue` establishes it for coordination-only work. The mutation is
performed through `tabgrad-issue` or by documented project automation and must
be checked against the actual issue state afterward.

### Moving to Not planned

Move an issue to `Not planned` only after deciding that it is declined,
duplicated, superseded, or obsolete. The closing comment must state the reason.
A duplicate or superseded issue must link the issue that remains authoritative.

Only `tabgrad-issue` establishes and performs this transition. Do not move
active work to `Not planned` merely because implementation stopped or a
different approach is preferred. First record the decision and preserve any
result or evidence that future work may need.

## Milestones

A milestone represents one bounded result, such as a release or a defined
project objective. It does not represent a permanent area such as WebGPU,
autograd, or documentation.

Every milestone must state:

- the result that will exist when it is complete;
- the conditions for completing it;
- what is deliberately outside it; and
- a due date only when there is a real scheduling reason for one.

An issue belongs to a milestone only when it is necessary for that milestone's
result. An issue should not be added merely because it is related to the same
area. Work needed by several objectives should be assigned to the earliest
milestone that actually requires it, with dependencies used to show the other
relationships.

Close a milestone when its stated result and conditions are complete. Move
newly discovered optional work to later issues rather than silently expanding
the milestone.

## Parent issues, sub-issues, and dependencies

Use a parent issue when one result requires several independently completable
issues. The parent explains the overall result and the sub-issues contain the
work that can be implemented or investigated separately.

Use a dependency when one issue cannot proceed until another issue reaches a
specific result. Do not use issue numbers in label names to represent this
relationship.

A checklist containing issue links may summarize work for readers, but it does
not replace GitHub's parent, sub-issue, or dependency relationships.

## Issue forms and automation

The repository provides separate issue forms for bugs, features, research,
maintenance, and documentation. Each form applies its type label and requires
the common and type-specific information defined here. Blank public issues are
disabled. Security reports use the private route in
[`SECURITY.md`](../SECURITY.md) rather than a public issue form.

Issues created through the command line, an API, or a coding agent must meet
the same requirements as issues created through a form.

Project automation must add new issues with status `Triage`. Priority and size
remain unset until someone evaluates the issue. Closing a completed issue moves
it to `Done`; closing it as unplanned moves it to `Not planned`.

A project-field transition is manual unless configured and verified automation
performs it. A desired transition is not active automation merely because this
document defines it.

Automation may check labels, fields, links, and required sections, but it does
not decide whether the explanation or evidence is correct. Review remains
responsible for that judgment.

## Changing these rules

Do not create labels, fields, statuses, or issue formats ad hoc. Propose the
change in an issue and explain the organizational problem it solves, how it
differs from the existing system, and how existing open work will be migrated.

Update this document, repository templates, skills, automation, and existing
open issues together when a rule changes. The written rules and the behavior of
the repository must not knowingly disagree.
