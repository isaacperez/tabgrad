---
name: tabgrad-verify
description: Verify a Tabgrad repository change against its issue, project rules, tests, documentation, and configured checks, and report reproducible evidence. Use before claiming that implementation or other repository work is complete or ready for review. Do not use to implement fixes, provide independent code review, publish a pull request, or merge it.
---

# Verify a Tabgrad repository change

Establish what was checked, against which exact repository state, and with
what result. Verification is evidence about the proposed change. It is not a
promise based on intended behavior, an earlier run, or a successful exit code
whose actual coverage is unknown.

## Read the requirements and identify the target

Read `README.md`, the sections of `CONTRIBUTING.md` that govern the proposed
change and verification, `docs/README.md`, `docs/agent-workflow.md`, the
applicable issue and its relationships, and `.github/pull_request_template.md`.
Use `docs/README.md` to select only the primary project rules connected to the
issue, diff, and material risks; read [`docs/quality.md`](../../../docs/quality.md)
when test or implementation quality applies. Inspect the complete proposed
change and existing verification evidence without loading unaffected project
areas by default.

When no issue exists, confirm that the complete change qualifies for the small
spelling or formatting exception in `CONTRIBUTING.md`. Use the authorized user
request and, when it exists, the pull request description as the requirements.
Otherwise, the missing issue makes verification incomplete.

When the target is an experimental artifact or lasting documentation required
by a research issue, identify the bounded result this change claims and the
research conditions it does and does not complete. Do not require the artifact
to contain the later research conclusion that it exists to help establish.

Identify whether the target is a working tree, a local commit, or the head
commit of a pull request. Record the repository, branch, base revision, target
revision, and working-tree status. Include untracked and uncommitted files when
they are part of the proposed result. For an uncommitted target, record the
reproducible content identity required by `docs/agent-workflow.md`, including
the complete tracked patch and hashes for untracked files. Do not combine
evidence from different states as though it described one final change.

If the target changes during verification, discard the readiness conclusion.
Determine which evidence remains valid, rerun every affected check, and report
the new target state. Verification and later review must examine the same
content.

## Establish independent verification

For a substantive repository change, at least one verifier must be independent
of its writer. When the coordinating agent materially authored the change,
delegate verification to a read-only subagent under
`docs/agent-workflow.md`. Give it the exact target, base, issue, accepted
decisions, complete diff, changed and relevant surrounding files,
configured-check information, and current command evidence. Do not pass the
complete conversation history by default. Require it to inspect the original
requirements, files, and evidence rather than relying on the writer's summary.

The same independent agent may also perform `tabgrad-review` for the same state
when the assignment explicitly covers both responsibilities and no distinct
material concern requires a specialist. It must report verification and review
as separate conclusions. Do not launch another general verifier or reviewer to
repeat that coverage.

Use additional read-only specialists when separate material concerns require
distinct inspection. Partition their assignments by risks, paths, environments,
or completion conditions and record who covers each requirement. Do not use a
fixed number or treat repeated general reviews as independent evidence.

The coordinating agent must inspect cited evidence, reconcile every conflict,
and account for unassigned requirements. If an independent verifier is
unavailable, verification is incomplete. Do not present the coordinating
agent's own inspection as a substitute.

## Preserve verification boundaries

A request to verify authorizes read-only inspection, the repository's
configured non-destructive checks, and disposable isolated files needed to run
those checks without changing the target. It does not authorize changing the
target's source, tests, documentation, dependencies, lockfiles, Git metadata
or history, GitHub state, an external service, or a user's persistent
environment.

Use an already prepared environment when possible. Do not install or update
dependencies, download a runtime, start a paid or externally visible service,
use private credentials, or access physical devices unless that action was
authorized or is already part of the authorized implementation workflow.
Report an applicable check as unable to run when its required environment is
not available.

Prefer check modes that do not rewrite files. Some configured builds and tests
may create disposable outputs or caches as part of normal execution. Inspect
the working tree before and after each such command. Do not delete, restore,
commit, or claim an unexpected file without first establishing its origin and
authority to change it.

Verification does not repair a failure. When the current request also
authorizes implementation, return the evidence to `tabgrad-implement`, make
the focused correction there, and verify the resulting state again. Otherwise,
report the failure and the work needed without editing the change.

## Determine every applicable check

Derive exact commands from the repository's current configuration,
documentation, package scripts, and continuous integration. Account for checks
selected by changed paths, environments, or event conditions. Do not maintain
a technology-specific command list in this skill and do not replace a missing
required command with an improvised approximation.

Map every completion condition the proposed change claims to complete and each
material part of the diff to evidence. Record the issue conditions that remain
outside this bounded result and confirm that the change neither claims nor
contradicts them. Consider the following categories only when they apply:

- formatting and generated-file consistency;
- linting, static analysis, and type checking;
- unit, integration, system, compatibility, and regression tests;
- builds, packages, examples, and installation paths;
- supported runtime, platform, browser, backend, and hardware environments;
- documentation, public API, compatibility, migration, and release records;
- performance, memory use, startup cost, and distributed artifact size;
- security, privacy, dependencies, licenses, and required attribution; and
- repository structure, automation, links, templates, and contributor
  instructions.

This list identifies concerns, not mandatory commands. Explain why a category
does or does not apply from the issue and diff. An unexplained `Not applicable`
is not evidence.

Include both focused checks for the changed behavior and the broader configured
checks needed to detect regressions. A focused test cannot replace the relevant
full suite. A full suite cannot replace missing evidence for a specialized
environment or completion condition.

Confirm that every applicable formatter, linter, type checker, compiler, and
static analysis command registered by the repository ran against the exact
target. Inspect narrow suppressions and exclusions to ensure that their stated
technical reason applies; a passing command does not justify hiding a valid
diagnostic.

A current, reproducible command result may be inspected and reused. Do not
rerun a successful command solely so that an independent agent can claim to
have executed it. Independence applies to evaluation of the target and
evidence, while commands should run once unless a result is missing, stale,
ambiguous, inconsistent, or needed to investigate a concrete finding.

When the repository has no defined check for a material claim, identify the
gap. Use a direct manual check only when it can genuinely demonstrate the
claim, record its procedure and expected result, and do not present it as the
configured automated check that is still missing.

## Verify that the tests are meaningful

Do not infer test quality only from passing results. Inspect which behavior the
new or changed tests exercise, their assertions, important failure cases, and
whether the test runner actually discovered them.

Establish that a behavior test can detect the incorrect or missing behavior.
When practical and safe, reproduce the original failure or run the relevant
new test against the base revision in a disposable isolated copy or an
existing separate worktree. Creating a new worktree changes Git metadata and
requires authority for that mutation. A compile failure caused by a newly
introduced interface can be valid evidence that the old revision lacks the
behavior, but it is not evidence for the runtime semantics of the new
implementation.

When a direct comparison with the base is not practical, explain why and use
the strongest available evidence, such as a documented reproduction, a test
whose assertion targets the changed outcome, or an independently established
reference result. Do not require mutation testing or a fabricated failure when
it would not provide useful evidence.

Confirm that tests are deterministic under their documented conditions and
that expected skips are justified. Treat zero discovered tests, unexpected
skips, crashes, timeouts, truncated output, leaked work, and unexplained
warnings as findings rather than a pass.

## Run checks against a controlled state

Run commands from the documented location and with the relevant configuration.
Record the exact command, environment information that can affect the result,
scope, start state, outcome, and useful output or durable evidence. Preserve
all failures, including failures followed by a successful retry.

Do not run stateful checks concurrently in the same working tree when they can
share outputs, ports, caches, devices, or external state. Independent check
groups may be delegated only when each agent receives the exact target,
requirements, environment boundaries, and an isolated disposable workspace
when needed. Subagents must not modify the target working tree. The
coordinating agent must inspect their evidence and reconcile every result.

If a check fails, determine whether the proposed change caused it, the same
failure exists at the base revision, or the environment prevented a valid run.
Use the same command and comparable environment when checking the base. A
pre-existing failure remains a reported failure and does not satisfy a
required check merely because the current change did not introduce it.

Do not label a flaky check as passed because a retry succeeded. Record every
attempt, investigate the variability to the extent authorized, and leave the
result unresolved when the cause is not established. Do not weaken, skip,
quarantine, or alter a valid check during verification.

## Inspect consistency beyond command results

Compare the final diff with the issue's expected result, included and excluded
work, completion conditions, and accepted decisions. Confirm that every
claimed condition has direct evidence and that the change does not depend on
unrecorded behavior or an unresolved decision.

Check that implementation, tests, documentation, examples, compatibility
records, dependency records, and generated outputs agree. Confirm that
normative documents do not narrate implementation progress or promise later
capabilities, and that versioned support records make no claim broader than
their evidence. Verify links and examples when their correctness is part of
the change.

Inspect the complete diff and status for unrelated changes, credentials,
private data, local configuration, debugging code, accidental generated files,
unexplained binary files, dependency drift, disabled checks, and unsupported
claims. Do not expose sensitive findings in a public report.

Verification may confirm observable consistency, but it does not replace the
independent reasoning required by `tabgrad-review`. Record code-quality or
design concerns that are directly visible, including a temporary workaround,
an unexplained magic threshold, or a helper nested contrary to
`docs/quality.md`, then leave judgment about maintainability, abstraction
quality, refactoring, and optimization to that skill.

## Decide and report the verification result

Use these ordinary outcomes:

- Verification passes only when every applicable required check ran
  successfully against the final state, every completion condition the change
  claims to complete has adequate evidence, all remaining issue conditions are
  represented accurately, and no material inconsistency remains.
- Verification fails when a check or completion condition demonstrates an
  incorrect result.
- Verification is incomplete when an applicable check, environment, artifact,
  requirement, or piece of evidence is unavailable or its result remains
  uncertain.

Decide the overall outcome in that order. A demonstrated incorrect result
makes verification fail even when other evidence is also missing; report the
unevaluated areas without implying that verification was otherwise complete.
When no incorrect result has been demonstrated but evidence is missing or
uncertain, verification is incomplete. It passes only when neither condition
applies.

An incomplete result is not a pass. A passing verification means only that the
defined checks and evidence succeeded; it is not independent review,
acceptance of an architectural decision, authorization to publish, or approval
to merge.

When verification fails or becomes incomplete for a pull request recorded as
ready for review, report that its readiness evidence is no longer valid. Do not
change its draft or project state under this skill. Use
`tabgrad-pull-request`, and through it `tabgrad-issue`, only when the user
authorizes the necessary transition.

Report:

- the exact target, base, branch, and working-tree state verified;
- the independent agents used, their assignments, evidence, and coverage;
- the issue or no-issue requirements, bounded result, completion conditions
  evaluated, and issue conditions that remain;
- every command and manual check, with its scope and result;
- evidence that changed tests detect the intended behavior;
- applicable categories and justified exclusions;
- failures, retries, skips, missing environments, and baseline comparisons;
- consistency of code, tests, documentation, compatibility, and dependencies;
- unexpected files, sensitive findings described safely, and other risks;
- the final verification outcome and the facts that determine it; and
- the next required action without performing an unauthorized fix, GitHub
  mutation, review, publication, or merge.

Identify which evidence was reused, which checks were run during this
verification, and why any context or command scope expanded. Stop when every
applicable completion condition and changed area has adequate evidence, or as
soon as a failure, missing requirement, unavailable environment, or material
uncertainty determines that the result is failed or incomplete.

Provide the verification evidence to `tabgrad-pull-request` when the user asks
to prepare, open, or update a pull request. Verification alone does not
authorize changing GitHub. Do not check a readiness statement until it is true
for the final target.
