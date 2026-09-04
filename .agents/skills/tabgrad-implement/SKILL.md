---
name: tabgrad-implement
description: Implement an approved Tabgrad issue as one focused repository change, including tests and documentation when applicable. Use when the user asks to create or modify code, documentation, tooling, configuration, or other repository content after the expected result and any required architecture are settled. Do not use to define an issue, decide unresolved architecture, perform independent review, or merge a pull request.
---

# Implement an approved Tabgrad issue

Leave a focused change that satisfies the issue and is ready for independent
verification and review. Code alone is not the result: tests, documentation,
compatibility information, and an explainable final diff are part of the same
implementation when they apply.

## Read the issue and repository rules

Read `README.md`, the complete issue and its relationships, and the `Before
starting work`, `Handling unexpected findings and pending decisions`, `Making
architectural decisions`, `Working on a branch`, `Implementing a change`,
`Testing`, `Documentation`, `Verification`, and `Opening a pull request`
sections of `CONTRIBUTING.md`. Read `docs/README.md`,
`docs/agent-workflow.md`, `docs/development.md`, and the
applicable rules in `docs/version-control.md`, together with the documentation,
[`docs/quality.md`](../../../docs/quality.md), code, tests, build configuration,
and earlier decisions
relevant to the affected behavior.

Treat the issue's expected result, boundaries, and completion conditions as the
definition of the requested work. Treat the repository and its configured
tools as the source of truth for current structure, style, generated files,
and commands. Do not fill a gap with a convention taken from another project.

## Confirm that implementation may begin

Implement an implementation issue when it is `Ready` or `In progress`, or when
it remains `In review` and the user has authorized a correction to its active
pull request. Its blocking dependencies must be complete, its completion
conditions must be verifiable, and no material decision about scope, behavior,
compatibility, architecture, security, privacy, or an important dependency may
remain unresolved. A correction performed while the issue remains `In review`
does not preserve earlier verification or review evidence and must follow the
later-change rules in `tabgrad-pull-request` before publication.

A research issue may use this skill for an authorized repository experiment
when it is `Ready` or `In progress`, its blocking dependencies are complete,
and the experiment's scope, method, safety, expected artifacts, and completion
conditions are settled. The decision that the experiment is intended to inform
may remain unresolved. Its research method, conclusion, and issue lifecycle are
governed by `tabgrad-research`. Also use `tabgrad-architecture` when the
research may establish or change a lasting architectural decision.

An accepted research issue may also use this skill while it remains `In
review`, solely to prepare lasting repository documentation that is part of
that issue's completion conditions. For architectural research, the record
must also satisfy `tabgrad-architecture`. This exception does not authorize
production implementation, expand the accepted conclusion, or bypass
verification and review of the documentation change.

Before editing files, inspect the issue's assignee, project status, linked
branches, and pull requests. For a research issue, `tabgrad-research`
establishes every research status transition and this skill governs only its
repository changes. For an implementation issue in `Ready`, identify the
responsible contributor and move it to `In progress` as the work begins. Use
`tabgrad-issue` when the user has authorized those GitHub changes. Otherwise,
present the proposed assignment and status change and wait; do not leave an
issue advertised as available while implementation has already started.

Apply the GitHub access diagnosis in `docs/development.md` to those remote
checks. A command without network access cannot establish invalid credentials,
and credential-changing actions retain their separate authority boundary.

When the issue is already `In progress`, confirm that the requested work
belongs to its responsible contributor or that collaboration or handoff has
been agreed. Do not create a competing implementation for work that another
contributor is actively performing.

When an implementation issue is `Blocked`, inspect the recorded impediment and
the evidence that it has been removed. If the same responsible contributor
will resume and the work otherwise remains ready, propose returning it to `In
progress`. If nobody will resume, propose returning it to `Ready` and updating
its assignment and branch information. Use `tabgrad-issue` for authorized
mutations and do not resume repository changes while the issue still advertises
a blocker that has not been resolved. Follow `tabgrad-research` instead for the
lifecycle of a blocked research issue.

Use `tabgrad-issue` when the user asks to correct or reclassify an issue. Do not
change GitHub state merely because implementation exposed a problem. If the
issue is not ready and the user has not authorized issue management, explain
what prevents implementation and stop before editing repository files.

A small, self-contained spelling or formatting correction may proceed without
an issue only when `CONTRIBUTING.md` permits that exception. Do not use the
exception for code, behavior, dependencies, infrastructure, a substantive
documentation change, or a collection of unrelated corrections.

Determine what the user authorized. A request to implement authorizes the
dedicated local branch, repository edits, checks, and coherent local commits
required for that implementation. It does not by itself authorize changing
GitHub metadata, pushing a branch, opening or editing a pull request, approving
a change, or merging it. Ask before any additional external mutation or
destructive action.

Before the first substantive repository edit, delegate the independent
read-only preflight required by `docs/agent-workflow.md`. Give the investigator
the original issue, accepted decisions, exact repository state, relevant
files, permission boundaries, and the specific readiness questions without
suggesting the desired conclusion. Do not pass the complete conversation
history by default.

Limit the assignment to deciding whether implementation may begin, whether the
issue and proposed file boundary still match the repository, which unresolved
decision or blocker exists, and which risks and checks later work must address.
The preflight must not run the full verification suite, assess hypothetical
implementation quality, design the solution, or inspect unrelated project
areas. It may reuse current evidence and expand to adjacent material only for a
reason permitted by `docs/agent-workflow.md`. Require it to stop as soon as the
readiness conclusions are supported or a blocker or justified expansion is
identified.

Inspect its cited evidence and stop if it shows that the issue is stale,
incomplete, duplicated, blocked, or no longer matches the repository. If the
required investigator is unavailable, do not begin the implementation.

## Protect the existing worktree

Inspect the current branch, working tree, default branch, and relevant history
before changing files. Do not discard, overwrite, reformat, move, commit, or
claim changes that belong to the user or another task.

Do not implement directly on the default branch. Follow
`docs/version-control.md` for the branch name, base, worktree isolation,
commits, history changes, and publication. If the current branch already
contains the authorized work, verify its purpose and continue there rather
than creating a competing branch.

When unrelated changes are present, use a separate worktree from the intended
base when it can be created without moving, copying, stashing, or rewriting
those changes. Otherwise, stop and report the files and the conflict that
prevents safe isolation.

Keep local commits coherent and describe their changes in clear language. Do
not amend, rebase, squash, or include an existing commit unless the request
authorizes that history change and it cannot disturb another person's work.

## Plan the smallest complete change

Translate each completion condition into observable behavior and identify the
code, tests, documentation, and configuration that may need to change. Record
important risks and the checks needed to detect them. Reproduce the current
behavior or bug before editing when doing so is practical and informative.

Inspect existing abstractions and nearby implementations before adding a new
one. Prefer the smallest complete change that fits the established design. A
small refactor may be included when it is necessary to implement the issue
safely and its preserved behavior can be verified. Put broader cleanup or an
independently useful refactor in separate work.

Before selecting an implementation, state the assumptions that affect it, the
invariant it must preserve, realistic alternatives, and the simplest
structurally correct option. Inspect evidence that can resolve uncertainty and
do not ask the user to repeat a decision already recorded by the issue or an
accepted architecture document. Stop for a decision when materially different
interpretations remain and would change the result.

For a bug, distinguish the observed symptom from the missing invariant and
trace the value or state to the highest layer that can own that invariant. Plan
a regression test for the class of input or state, not only the reported
example. Do not present a case-specific condition or silent recovery as the
solution.

If implementation requires an architectural choice that has not been
approved, stop the affected work and use `tabgrad-research` together with
`tabgrad-architecture` when the user authorizes that investigation. Do not
settle a lasting design incidentally in code.

Remain the only writer for the target working tree while implementing. Use
subagents for bounded read-only investigation, not for concurrent file edits.
If writing responsibility must move to another agent, make an explicit handoff
and stop editing before it begins. Parallel implementation belongs in
separately owned issues and isolated targets whose relationship has already
been classified under `docs/agent-workflow.md`. Do not begin dependent work
before its prerequisite result exists and its native GitHub dependency is
recorded. The coordinating agent remains responsible for inspecting and
integrating every result. Do not delegate user decisions or unauthorized
GitHub mutations.

## Implement behavior, tests, and documentation together

Apply `docs/quality.md`. Follow the surrounding structure and configured style.
Keep responsibilities, names, control flow, state ownership, errors, data
movement, and performance costs understandable. When several variations share
a real invariant, encode that rule once and make the differences explicit. Do
not introduce a speculative abstraction, dependency, fallback, compatibility
promise, or generated artifact without a demonstrated need in the issue.

Do not declare a helper with an independent responsibility inside another
function or method. Extract it to module scope or the type that owns it. A
callback or closure required by an API may remain local only under the cohesion
and clarity rule in `docs/quality.md`; extract reusable policy, multi-stage
logic, complex control or error handling, and independently testable behavior.

Do not add a knowingly temporary workaround, example-specific discriminator,
unjustified numeric threshold, swallowed error, or suppression that hides the
known cause of a failure. An explicitly authorized urgent mitigation remains
separate work and cannot be reported as the completed correction.

Preserve the project constraints recorded in `README.md` and
`CONTRIBUTING.md`. Apply only the domain-specific checks relevant to the
change. Do not assume that every implementation affects every public API,
runtime, backend, environment, or compatibility guarantee.

Add or update tests for every behavior change. A test must fail for the
incorrect or missing behavior and pass for the implemented result. Add a
regression test for a bug fix. Cover important successful behavior, failure
behavior, boundaries, and interactions that the change can affect. Do not
weaken, delete, skip, or rewrite a valid test merely to accommodate the new
implementation.

Update documentation in the same change whenever public interfaces,
compatibility, architecture, setup, examples, development procedures, or
supported environments would otherwise be described incorrectly or
incompletely. Apply the durable-document and work-tracking boundary in
`docs/documentation.md`: normative documents must not become progress reports
or roadmaps, while versioned support records must remain evidence-based.

When adding or changing a dependency or third-party code, establish its need,
origin, version policy, license compatibility, required attribution, security
consequences, maintenance cost, and effect on supported environments and
distributed artifacts. Stop for a user decision when those consequences were
not already accepted by the issue.

Run focused checks while working when they can expose errors early. Use the
repository's configured commands. Do not change a check, suppress a warning,
or add an exclusion solely to make the current change pass.

## Handle discoveries without losing scope

When the change causes a defect, correct it on the same branch and add evidence
that prevents its return. When a pre-existing defect blocks the issue, stop
the affected work and follow `CONTRIBUTING.md` for preserving evidence and
proposing an issue or dependency. When it does not block the issue, keep it out
of the branch and report the separate work that should be recorded.

Do not silently expand the issue for an adjacent feature, broad refactor,
optimization, or cleanup. Ask for a decision when a discovery would materially
change the expected result, public behavior, risk, size, or accepted design.
Continue only with work that does not depend on that answer.

Treat a possible security or privacy problem as sensitive. Do not publish its
details in code, logs, an issue, or a pull request. Follow the private handling
rule in `CONTRIBUTING.md`.

If a configured tool, test environment, or external service fails, determine
whether the cause is the proposed change, the existing repository, or the
environment. Preserve the command and result. Do not invent a passing result
or replace a required check with an easier one.

## Prepare the complete change for verification

Inspect the final diff against the issue rather than reviewing files in
isolation. Remove debugging code and accidental changes. Confirm that the diff
contains no credentials, private data, local configuration, unexplained
generated files, unrelated formatting, or work belonging to another task.

Confirm that:

- the implementation satisfies every completion condition it claims to
  complete;
- the code satisfies `docs/quality.md`, including its responsibility,
  abstraction, nested-helper, root-cause, scope, and performance rules;
- tests would detect the behavior added or corrected;
- code, tests, documentation, examples, and compatibility claims agree;
- important failure behavior and unsupported behavior remain explicit;
- necessary refactoring is limited and preserved behavior is covered;
- dependency, license, security, privacy, performance, and migration effects
  are recorded when relevant; and
- every known limitation or necessary follow-up is visible rather than hidden
  in code or memory.

Use `tabgrad-verify` against the final working-tree state before describing the
implementation as complete or ready for review. Verification and independent
review must examine the same final content. If the verification skill or a
required check is unavailable, report the exact gap and do not claim
completion.

Identify the final target precisely before handing it to verification. Include
the base, branch, revision or complete working-tree status, every tracked or
untracked file in the proposed result, and the reproducible content identity
required by `docs/agent-workflow.md` when no commit identifies the content. A
later edit invalidates every verification or review whose evidence may have
changed.

Do not use this skill as independent review. Do not approve or merge the
change. Use `tabgrad-pull-request` when the user asks to prepare, open, or
update a pull request. A draft may be published before verification only when
the user explicitly requests a draft; it must not be presented as ready for
review.

## Report the implementation

Report:

- the issue and branch used;
- the independent preflight, its evidence, and the sole writer for the target;
- the observable behavior implemented;
- the files, tests, documentation, compatibility information, and
  dependencies changed;
- the checks run so far and their exact results;
- any limitation, unexpected finding, blocked check, or follow-up work;
- the repository and GitHub mutations actually performed; and
- whether the change is awaiting verification, review, publication, or a user
  decision.

Distinguish completed actions from proposed next actions. Never claim that an
issue, implementation, pull request, or repository change is complete merely
because the code was written or a focused test passed.
