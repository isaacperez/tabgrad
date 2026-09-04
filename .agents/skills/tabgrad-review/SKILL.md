---
name: tabgrad-review
description: Review a proposed Tabgrad repository change independently for correctness, scope, tests, documentation, compatibility, risk, and maintainability. Use when the user asks to review a working tree, commit, branch, or pull request after implementation. Do not use to implement fixes, perform verification alone, approve architecture, or merge.
---

# Review a Tabgrad repository change

Decide whether a proposed change is safe, complete, understandable, and ready
to continue through the workflow. Find material problems that the author or
automated checks may have missed. Do not treat review as a summary of the diff
or as confirmation that the author's intention sounds reasonable.

## Establish an independent review

The person or agent that materially implemented a change must not be its only
reviewer. Determine who produced the design and code before beginning.

When the current agent participated materially in the implementation, delegate
the primary review to a read-only subagent that did not produce the change.
Give it the exact target, base, issue, repository rules, accepted decisions,
and verification evidence. Require it to inspect the original files and
evidence rather than a summary prepared by the implementer.

The subagent must not edit files, create commits, submit a GitHub review, post
comments, change project state, approve, or merge. The coordinating agent must
inspect the cited evidence and is responsible for the final report. If no
independent reviewer is available, analysis may continue and preliminary
findings may be reported, but the review is incomplete and the change is not
ready to merge.

An independent reviewer may perform the review directly without delegating it
again. Additional reviewers or bounded specialist reviews are appropriate when
the change spans distinct high-risk areas, but do not add reviewers merely to
repeat the same inspection.

## Read the requirements and exact change

Read `README.md`, `CONTRIBUTING.md`, `docs/README.md`,
`docs/agent-workflow.md`, [`docs/quality.md`](../../../docs/quality.md), the linked issue
and its relationships when one is required, the relevant project documentation
and accepted decisions, and `.github/pull_request_template.md`. When reviewing
a pull request, read its description, commits, changed files, checks, reviews,
conversations, and known limitations.

When no issue exists, confirm that the entire change qualifies for the small
spelling or formatting exception in `CONTRIBUTING.md` and use the pull request
description as its stated result. Otherwise, the missing issue is a workflow
finding and the review cannot pass.

Identify the repository, base revision, target revision, branch, and working
tree state. Review every file in the complete diff and inspect enough
surrounding code, tests, documentation, configuration, and history to
understand its consequences. Do not review only the lines selected by the
author or only the latest fixup commit.

If the target changes, findings tied to the earlier state remain historical
evidence but do not establish the result of the new review. Inspect the new
complete diff and revisit every affected finding. Verification and review must
refer to the same final content before the change can pass.

For a pull request presented as ready for review, confirm that the linked issue
and project status describe the same stage of work. An implementation issue
with a verified review-ready pull request should be `In review`. Report a
mismatch without changing GitHub unless that mutation was authorized.

## Preserve review boundaries and authorization

A request to review authorizes read-only repository and GitHub inspection. It
does not authorize editing the change, running destructive commands, changing
Git history or GitHub state, submitting comments or a formal review, approving
the pull request, requesting changes on GitHub, or merging it.

When the user also authorizes corrections, report the findings first and send
the work back through `tabgrad-implement`. The corrected state must pass
`tabgrad-verify` and receive a new independent review. Do not quietly combine
authorship and approval because one task includes both activities.

Publishing a review, inline comment, approval, or request for changes requires
authority for that exact external action. Do not impersonate another reviewer
or present an agent's judgment as approval from a person.

Treat possible security or privacy vulnerabilities as sensitive. Preserve the
minimum evidence needed and follow the private reporting rule in
`CONTRIBUTING.md`. Do not expose exploit details in public findings, logs, or
pull request comments.

## Check the intended result and scope

Compare the change with the issue's problem, expected result, included and
excluded work, completion conditions, dependencies, and accepted decisions.
An implementation pull request must solve its primary issue rather than a
narrower convenient case or a different problem. For an experimental artifact
or lasting documentation required by a research issue, evaluate the bounded
result the change claims, confirm that the issue requires it, and ensure that
remaining research conditions are explicit and are neither claimed nor
contradicted.

Identify missing completion conditions, behavior that was added without being
requested, and unrelated cleanup or formatting. A deliberate departure from
the issue is acceptable only when its reason and approval are recorded and the
issue, implementation, tests, and documentation agree.

Do not require unrelated pre-existing problems to be fixed in the same change.
Report one only when the proposed change depends on it, makes it worse, exposes
a material risk, or cannot be evaluated safely without resolving it. Preserve
other findings for separate work under the process in `CONTRIBUTING.md`.

Classify findings under `docs/agent-workflow.md`. A reviewer may recommend
follow-up work, but must not expand the change or create an issue without the
required issue process and current authority.

## Review correctness and failure behavior

Trace the affected control flow, data flow, state changes, ownership,
interfaces, and error paths. Inspect callers, consumers, and shared
abstractions that can be affected even when they are outside the textual diff.

Look for incorrect assumptions, boundary errors, invalid states, partial
updates, stale state, unsafe ordering, lost errors, silent fallbacks,
resource-lifecycle problems, and behavior that changes with repeated or
concurrent use. Apply only the concerns that are relevant to the change, and
derive domain-specific expectations from the issue and current project
documentation rather than from a fixed technology list in this skill.

Check important successful behavior and failure behavior. Confirm that errors
are explicit and useful, cleanup occurs after both success and failure, and a
failure cannot leave observable state that contradicts the documented result.

For a public interface or compatibility claim, compare the implementation,
types, errors, examples, and compatibility records with the authoritative
behavior named by the project. Do not accept a broader claim than the evidence
supports.

## Review tests and verification evidence

Read the tests as critically as the implementation. Confirm that assertions
observe the promised result, that the tests would fail for the defect or
missing behavior, and that important boundaries and failure cases are not
hidden by mocks, fixtures, broad tolerances, snapshots, or implementation-only
assertions.

Look for weakened, deleted, skipped, nondeterministic, or undiscovered tests.
Check whether changed behavior invalidates existing tests elsewhere. A large
number of passing tests does not compensate for a missing test of the changed
result.

Read the `tabgrad-verify` report and its primary evidence. Confirm that it
targets the reviewed state, covers every applicable requirement, records
failures and unavailable environments, and does not rely on stale checks or
unexplained exclusions. Do not repeat the entire verification procedure as a
substitute for review. Run a focused non-destructive check only when it is
needed to investigate a review finding and the environment and authorization
permit it.

A review may report findings before verification passes. It cannot conclude
that the change is ready while verification has failed, is incomplete, or
describes another state.

## Review documentation and lasting consequences

Check that documentation, examples, compatibility records, migration notes,
and release information are updated wherever a reader would otherwise form an
incorrect understanding. Confirm that normative documentation describes the
complete product and permanent rules rather than project progress or a
roadmap. Check release-specific support and historical records against their
named evidence.

Check whether the change introduces or bypasses an architectural decision. A
lasting decision must have the evidence, user approval, and durable record
required by `tabgrad-architecture`; a pull request description or code comment
alone is not sufficient.

Inspect the affected design for unnecessary duplication, accidental coupling,
unclear responsibility, needless abstraction, dead code, and complexity that
the issue does not justify. Apply every applicable part of `docs/quality.md`:
confirm that assumptions and tradeoffs were surfaced, the change enforces the
real invariant at the correct owner, shared variations do not duplicate
knowledge, independently responsible helpers are not nested, local callbacks
and closures remain cohesive, comments explain non-obvious reasons, and the
resulting structure remains understandable to a new contributor.

Look actively for a simpler structurally correct implementation and for
refactoring or optimization needed because of the proposed change. Require a
correction when the change introduces or worsens a quality problem. Keep a
pre-existing improvement separate when it does not block or undermine the
result. Leave a broader audit of existing technical debt to
`tabgrad-maintenance`.

When relevant, examine performance and resource consequences, dependency and
license changes, generated artifacts, supply-chain exposure, security and
privacy boundaries, portability, migration, rollback, and effects on users or
downstream contributors. Inspect whether an abstraction adds allocation,
transfer, materialization, synchronization, dispatch, or retained state on an
affected hot path. Require comparable measurements under `docs/performance.md`
when a material claim or risk needs them; do not demand an irrelevant benchmark
or accept an unmeasured performance assertion.

## Write actionable findings

Each finding must identify a concrete problem, its location, the conditions
that trigger it, its consequence, and the evidence supporting it. Explain the
smallest required outcome of a correction without prescribing one
implementation when several could be valid.

Put findings that can cause incorrect behavior, data loss, a security or
privacy failure, a broken public contract, or an unusable build before less
severe findings. Distinguish corrections required for readiness from optional
suggestions. Do not block a change for personal style, speculative future
needs, or a refactor that is unrelated to the issue.

Keep locations precise and ranges small. Combine findings only when they have
the same cause and correction. Do not hide a material finding in a general
summary, and do not inflate the report with observations that require no
action.

When no actionable finding remains, state that clearly and describe any
residual risk, missing environment, or part that could not be inspected. The
absence of findings is not proof that unverified behavior works.

## Decide and report the review result

The review passes only when no required correction remains, verification
passes for the same final state, every completion condition the change claims
is satisfied, remaining issue conditions are represented accurately, and no
material uncertainty prevents approval. For a permitted no-issue correction,
the authorized request and pull request description define the complete
result.

The review requires changes when at least one actionable problem must be
corrected before the change can continue. The review is incomplete when the
target, a required issue, relevant files, independent reviewer, verification
evidence, or other information needed for a responsible judgment is
unavailable.

When required changes and missing evidence coexist, report that changes are
required and list the incomplete areas separately. Do not imply that resolving
the known findings will automatically make the next state pass.

Report findings first, ordered by consequence. Then report:

- the exact target and base reviewed;
- whether the reviewer was independent;
- the specialist assignments used, their coverage, and any uninspected area;
- the issue or no-issue requirements, bounded result, completion conditions
  evaluated, and issue conditions that remain;
- the verification state and whether it matches the reviewed content;
- open questions, assumptions, missing evidence, and residual risks;
- optional suggestions, clearly separated from required corrections;
- the final review result and the facts that determine it; and
- every external action performed or still requiring authorization.

Re-review the complete final change after corrections. Resolve a finding only
when the cited problem no longer exists and the correction has not introduced
an equivalent problem elsewhere. Do not approve, publish, or merge merely
because all earlier comments received a response.
