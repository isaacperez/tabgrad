# Contributing to Tabgrad

This document explains how work moves from an idea to a merged change in
Tabgrad. It applies to human contributors and to coding agents.

The normal path is:

1. Define the work in a GitHub issue.
2. Create a branch for that issue.
3. Implement the change together with its tests and documentation.
4. Verify the complete change.
5. Open a pull request or mark its existing draft ready for review.
6. Review the proposed change.
7. Merge the pull request and close the issue.

Each step leaves a useful record. The issue explains why the work is needed,
the branch contains the work in progress, the pull request presents the
proposed result, and the repository documentation describes the behavior that
remains after the change is merged.

## How GitHub is used

A GitHub issue represents a problem, improvement, or other unit of work. It is
the main place for defining the desired result and discussing questions before
implementation begins.

A branch isolates the changes for one issue from the default branch. Branches
allow work to be tested and reviewed before it affects the shared codebase.

A pull request proposes merging a branch. It connects the implementation to
its issue and provides the place where the complete change is reviewed.

Labels classify issues by their type, affected areas, and important concerns.
Project fields record workflow status, priority, and size. Labels should
describe work; they should not replace a clear issue description.

A milestone groups issues and pull requests that contribute to the same
release or other concrete project objective. A milestone is useful only when
that shared objective and its completion conditions are known.

A GitHub project provides a planning view across issues and pull requests. It
can show what is waiting, in progress, or complete, but it does not replace the
details recorded in each issue and pull request.

The required issue content, label catalog, project fields, milestones, and work
transitions are defined in
[`docs/project-management.md`](docs/project-management.md).

The documentation index in [`docs/README.md`](docs/README.md) identifies the
primary source for each other project rule.

## Before starting work

Read the `README.md`, the relevant issue, and any documentation related to the
part of the project you will change. Inspect the existing code and tests before
deciding how to implement the change.

Search for related issues and pull requests so that the same work is not
started twice. If the expected result is unclear or important design questions
remain open, resolve them before implementation begins.

Work that changes code, behavior, public documentation, architecture,
dependencies, or development infrastructure must have an issue. A small,
self-contained correction to spelling or formatting may be explained directly
in its pull request.

## Coordinating coding agents

Coding agents must follow
[`docs/agent-workflow.md`](docs/agent-workflow.md) when they delegate work or
perform a substantive repository change.

Before the first edit, an independent read-only agent must check the issue's
current assumptions against the repository and report evidence, conflicts, and
unresolved questions. Only one agent at a time may modify the target working
tree. Delegated investigators, verifiers, reviewers, and specialists remain
read-only unless a later, explicit handoff makes one of them the sole writer.

After implementation, an agent independent of the writer must verify the exact
final state. The independent review must examine that same state and its
verification evidence. Use additional specialists when separate material risks
need different expertise, but do not choose a fixed number or ask several
agents to repeat the same undivided check.

Every assignment and result must identify the target, scope, evidence,
commands, limitations, and unanswered questions. An agent's judgment does not
replace configured repository checks. Any later edit makes affected evidence
stale and requires the relevant verification and review to be repeated.

Delegation does not authorize repository edits, Git or GitHub mutations,
external actions, publication, or decisions reserved for the user. Findings
must follow the scope, blocking, security, and follow-up rules below; subagents
must not create issues or expand the current work automatically.

## Handling unexpected findings and pending decisions

Do not ignore an unexpected bug, hide it in a pull request comment, or expand
the current change automatically to fix it. First reproduce the problem when
possible, preserve the relevant evidence, determine whether the current change
caused it, search for related issues and pull requests, and decide whether it
blocks the requested work.

If the current change introduced the problem, correct it in the same branch
before review. Add a regression test that detects the problem and inspect
similar code when there is evidence that the same defect may appear elsewhere.

If a pre-existing problem blocks the current work, stop the affected work. Link
an existing issue as a dependency, or prepare a new bug issue when none exists.
Move an issue that was already ready or in progress to `Blocked` only when the
impediment and the condition for removing it are documented.

If a pre-existing problem does not block the current work, do not include an
unrelated correction in the current branch. Preserve the evidence, prepare a
separate issue, and continue only when doing so remains safe.

Creating or modifying an issue, dependency, project item, or other GitHub state
requires authority for that action. When that authority has not already been
given, present the proposed change and wait for approval.

Ask the user for a decision when the available alternatives would materially
change public behavior, issue scope, architecture, compatibility, an important
dependency, performance, package size, security, privacy, or an external action
that has not been authorized. Do not ask the user to resolve a question that
can be answered by inspecting the repository, reading authoritative
documentation, or running an appropriate test.

A request for a decision must explain:

- what was discovered and the evidence for it;
- which work is affected and whether it is blocked;
- the realistic alternatives and their consequences;
- the recommended alternative and the reason for it; and
- the exact decision that is needed.

Use `Needs information` when an issue cannot yet be defined or evaluated
because information is missing. Use `Blocked` when work that was ready or in
progress cannot continue. Do not create a separate label to indicate that a
user response is pending.

Do not publish sensitive details about a possible security or privacy problem
in a public issue, pull request, test, or log. Stop public disclosure, preserve
only the information needed for investigation, inform the repository owner,
and follow [`SECURITY.md`](SECURITY.md). If the private reporting form is not
available, ask the repository owner for a private contact without including
sensitive details in the request. Do not publish a fix until it is safe to
disclose the problem.

When a test, tool, service, or development environment fails, determine whether
the failure comes from the proposed change, already exists in the repository,
or is external to the code. Record the command and result. Do not weaken or
disable a valid check, invent a substitute, or report that the check passed.

If a material problem is discovered after merge, report its evidence and known
impact immediately. Explain whether investigation, a revert, or a separate fix
is the safest next action. Do not revert the merge, push a correction, reopen
or close an issue, or change project state without authority for that action.

While waiting for a required answer, continue only with independent work that
does not assume the answer. Report the finding, its evidence, its effect, its
blocking status, and any remaining decision in the final result.

## Defining an issue

Every issue must contain the common information and the additional information
for its type defined in
[`docs/project-management.md`](docs/project-management.md). That document also
defines how an issue is classified and when it is ready to begin.

The completion conditions must be specific enough to test or inspect. They
should describe the result rather than merely state that code must be written.

If investigation shows that an issue contains several independent changes,
split it into separate issues and record their relationship. This keeps each
change small enough to understand, review, and reverse.

## Making architectural decisions

Discuss the design before implementation when a change affects the execution
model, public API, tensor semantics, automatic differentiation, the division
between CPU and WebGPU, the Python and JavaScript boundary, or a fundamental
dependency.

The discussion should state the problem, the realistic alternatives, the
reasons for the chosen approach, and its important consequences. A decision
that future contributors will need to understand must also be recorded in the
repository documentation. An issue or pull request discussion alone is not a
durable replacement for that documentation.

Do not introduce a new implementation language, native runtime dependency, or
major framework as an incidental part of another change. Such a choice needs
an explicit architectural decision because it affects how the whole project is
built, distributed, and maintained.

## Working on a branch

Follow [`docs/version-control.md`](docs/version-control.md) for branches,
worktrees, commits, history changes, publication, conflicts, merging, and
branch removal.

Do not implement changes directly on the default branch. Create a short-lived
branch from the intended current base for each issue. Give it a descriptive
name and include the issue number when one exists.

A branch should contain one coherent change. Do not mix unrelated cleanup,
features, or fixes into the same branch. Keeping the branch focused makes test
failures easier to diagnose and the pull request easier to review.

Commit messages must explain the change in clear language. Do not include
generated files, local configuration, credentials, or unrelated formatting
changes unless the repository explicitly requires them. Do not rewrite shared
history or force-push.

## Implementing a change

Follow [`docs/quality.md`](docs/quality.md) for code style, design preparation,
responsibility boundaries, abstractions, root-cause corrections, scope,
performance, tests, and review. Make the smallest complete change that
satisfies the issue. The result must be readable and testable, enforce the real
invariant, and use a shared abstraction when genuine variations would otherwise
duplicate knowledge. Do not introduce speculative generality or a workaround
that hides a known cause.

Keep helpers with an independent responsibility at module or type scope. Do
not declare them inside another function. A callback or closure required by an
API may remain local when it satisfies the cohesion and clarity rule in
`docs/quality.md`; do not use one to hide an independently testable
responsibility. Before coding, expose unsupported assumptions, realistic
alternatives, and material tradeoffs. Ask for a decision only when repository
evidence and accepted work do not already settle a choice that affects the
result.

Tabgrad is a browser-native project. Runtime changes must remain compatible
with the browser execution model described in `README.md`. The tensor runtime
is implemented in TypeScript or JavaScript, with WGSL for WebGPU shaders.
Python provides the compatibility layer that runs through Pyodide and may also
be used for development tools and compatibility tests. Pyodide is not the
tensor runtime. C and C++ are not runtime implementation languages for
Tabgrad. Do not introduce a server requirement or an official PyTorch runtime
dependency into Tabgrad execution.

When a change affects tensor behavior, consider every relevant part of that
behavior: shapes, data types, values, gradients, errors, devices, and backend
selection. Unsupported behavior must fail clearly. A backend substitution or
other fallback must not happen silently.

Avoid copying an existing implementation when the project already has a
suitable shared abstraction. If a small refactor is necessary to implement the
issue safely, include it and explain why. If the refactor is broader or useful
independently, create a separate issue instead of hiding it inside the change.

Third-party code and dependencies must have compatible licenses. Record their
origin and any attribution that their licenses require. Add a dependency only
when its benefit justifies its effect on download size, browser compatibility,
security, and maintenance. Follow
[`docs/dependencies.md`](docs/dependencies.md) for selection, integrity,
lockfiles, updates, vendored code, and removal.

## Testing

Follow [`docs/quality.md`](docs/quality.md) for selecting checks, writing
meaningful tests, comparing references, interpreting failures, and reviewing
refactoring or duplication.

Every behavior change must have tests that would fail without the change. A bug
fix should include a regression test. Test both successful behavior and
important failure cases.

The required tests depend on the affected behavior. Relevant checks may
include:

- tensor values, shapes, and data types;
- gradients and repeated backward operations;
- CPU and WebGPU behavior;
- agreement between backends;
- agreement with the documented PyTorch behavior;
- explicit errors for unsupported inputs or operations;
- Python and JavaScript integration through Pyodide;
- browser behavior, including worker boundaries and data transfer; and
- performance or memory use when the change can materially affect them.

The CPU backend serves as a reference for checking WebGPU behavior. The
official PyTorch runtime may be used by development tests as a compatibility
oracle, but it must not become a runtime dependency.

Tests should be deterministic and should explain failures clearly. Do not
weaken or remove a valid test merely to make a change pass.

## Documentation

Follow [`docs/documentation.md`](docs/documentation.md) for documentation
structure, sources of truth, writing, examples, and review.

Documentation is part of the implementation. Update it in the same pull
request whenever a change affects behavior, public APIs, compatibility,
architecture, setup, examples, or contributor instructions.

Use the appropriate kind of documentation:

- `README.md` explains the project's purpose and high-level behavior.
- API documentation explains how supported public interfaces are used.
- Compatibility documentation defines and records bounded, evidence-backed
  support claims for named releases.
- Architecture documentation records design that future contributors need to
  understand.
- Examples demonstrate behavior that the project actually supports and tests.

Normative documentation describes Tabgrad's complete product contract and
permanent project rules. It must not narrate implementation progress or promise
later capabilities. Issues, pull requests, project fields, changelogs, release
notes, and release-specific compatibility records hold bounded work or release
state. When a change adds or alters PyTorch-compatible behavior, update both
the relevant tests and [`docs/compatibility.md`](docs/compatibility.md).

## Verification

Before opening a pull request for review, run every repository check that
applies to the changed files. This normally includes formatting, linting, type
checking, unit tests, integration tests, and the build. Run browser, WebGPU, or
performance checks when the change affects those areas.

The repository's configured tools and continuous integration define the exact
commands. The command registry is
[`docs/development.md`](docs/development.md), and
[`docs/continuous-integration.md`](docs/continuous-integration.md) defines
their remote enforcement. Do not invent a substitute when a required check is unavailable.
Report which commands were run, their results, and any check that could not be
run. Never claim that a check passed if it was skipped or could not execute.

Review the final diff as a whole. Confirm that it contains no debugging code,
credentials, accidental generated files, unrelated changes, or unsupported
claims.

## Opening a pull request

Use one pull request for the coherent change on one issue branch. Search for an
existing pull request from the same branch before opening another one. Target
the repository branch intended by the issue and inspect the complete diff that
GitHub will present, not only the latest commit.

When the work requires an issue, identify exactly one primary issue whose
result the pull request implements. Explain every other issue link as a parent,
dependency, research source, or related effect. An implementation pull request
should complete its primary issue. If one part can be merged and verified
independently, define that part as its own issue before publication rather than
leaving the primary issue in an ambiguous partial state. A pull request may
instead provide an experimental artifact or lasting documentation explicitly
required by a research issue; that research issue remains under its research
lifecycle.

A draft pull request shares work that is still in progress. It may be opened
before verification passes when collaboration or early feedback is useful. Its
description must identify unfinished work, failed or missing checks, unresolved
questions, and any evidence that is not current. A draft must not claim to be
ready for review, request approval, or move its issue from `In progress` to `In
review`.

A pull request is ready for review only when the implementation is complete
for the result it claims, `tabgrad-verify` passes against its current head, the
description contains the required evidence, and no unresolved decision or
known required correction prevents review. Checks that run only on the pull
request may still be in progress after publication; they remain required
before merge. Marking a pull request ready moves its implementation issue to
`In review`.

If the pull request head changes materially after verification, its earlier
verification and review are stale. Run verification against the new head,
update the description, and obtain review of that same state before merge. A
new head that already satisfies the ready-for-review conditions may remain in
review. When the new head does not satisfy them, return the pull request to
draft and move its implementation issue to `In progress` before publishing it,
or as soon as an already-published change is detected. Changing the pull
request and project state requires current authority; an earlier request to
mark the pull request ready is not continuing authority for later mutations.

The pull request should:

- use a title that describes the resulting change;
- link the issue it addresses, using a closing keyword only when the pull
  request will complete that issue;
- explain what changed and why;
- identify any deliberate difference from the issue or original design;
- describe the tests and other checks that were run;
- list documentation that was updated;
- state known limitations and compatibility effects; and
- call attention to changes in dependencies, performance, memory use,
  security, or privacy.

Include screenshots, logs, or measurements when they are needed to verify a
claim. Keep evidence concise and make it possible for a reviewer to reproduce
the result. Complete `.github/pull_request_template.md` without checking a
statement that is not yet true. An item that does not apply needs a short
reason rather than an unexplained `Not applicable`.

Preparing text or inspecting a pull request does not authorize a coding agent
to change GitHub. A request to open a draft authorizes the ordinary push of the
exact issue branch when needed and creation of that draft. A request to open a
pull request for review or mark one ready also authorizes the corresponding
`In review` project transition. These requests do not authorize force-pushing,
changing repository settings, choosing or notifying individual reviewers,
approving, closing, or merging. Those actions require their own authority.

A request to publish a new verified head to an existing review-ready pull
request authorizes its ordinary push and the minimum description update needed
to make its verification evidence current. It does not authorize unrelated
changes to the pull request. If the user excludes the evidence update, do not
publish a head that would leave the pull request misleading.

If a GitHub operation fails or returns an ambiguous result, inspect the remote
state before retrying. Do not create a duplicate pull request or repeat a
notification because the first result was unclear.

## Reviewing a change

Review the complete result, not only whether the new code appears to work. A
review must apply the engineering standard in
[`docs/quality.md`](docs/quality.md) and should consider:

- whether an implementation pull request completes its primary issue, or a
  research artifact or lasting documentation satisfies its bounded required
  result without claiming the unfinished research, and whether the change
  contains unrelated work;
- correctness and clear failure behavior;
- test quality and missing cases;
- agreement between code, tests, documentation, and compatibility claims;
- public API and architectural consequences;
- CPU, WebGPU, Pyodide, and browser constraints where relevant;
- performance and memory consequences;
- security, privacy, dependency, and licensing concerns; and
- symptom-only corrections, magic discriminants, nested helpers, unnecessary
  duplication, complexity, or abstractions; and
- refactoring or optimization required to keep the changed design clear,
  coherent, and efficient without expanding into unrelated cleanup.

Apply the detailed policies for compatibility, dependencies, generated files,
performance, releases, security, and documentation when the change affects
those subjects. Use [`docs/README.md`](docs/README.md) to find their primary
sources.

A reviewer should explain the consequence of a problem and distinguish a
required correction from an optional suggestion. The author should answer or
resolve every required correction before merge.

## Merging and completing the issue

A pull request is ready to merge when:

- it satisfies every issue completion condition that it claims to complete, or
  the merge itself will satisfy that condition;
- it uses a closing keyword only when the merged result will satisfy all of the
  issue's completion conditions;
- required tests and repository checks pass;
- the implementation, tests, and documentation agree;
- compatibility information is current;
- the independent technical review required by
  [`docs/agent-workflow.md`](docs/agent-workflow.md) applies to the current
  pull request head;
- a maintainer with review permission who is independent of the work and is
  not the author has formally approved the current head when one exists, or
  the author is confirmed as the only maintainer with review permission;
- required review corrections are resolved; and
- no known limitation is hidden or presented as supported behavior.

Merge only through a pull request after review, and always use the squash
merge method. A sole maintainer cannot approve their own pull request; in that
case, independent technical review, passing checks, and the maintainer's
explicit merge authorization replace only the formal GitHub approval. Follow
the maintainer-count and per-pull-request approval rules in
[`docs/continuous-integration.md`](docs/continuous-integration.md). After the
merge, confirm that
each linked issue is closed or remains open as required by the relationship and
the result actually completed. Confirm that any necessary follow-up work has
its own issue. Remove the dedicated branch after confirming that its change is
merged and that it contains no other work, when branch deletion is authorized.

Follow [`docs/releases.md`](docs/releases.md) when a merge is intended for a
versioned release, migration, deprecation, or correction to published behavior.

Completion means that the repository is left in a consistent and explainable
state. Writing code alone is not completion.
