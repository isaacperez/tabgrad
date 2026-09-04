---
name: tabgrad-maintenance
description: Audit existing Tabgrad code, tests, documentation, tooling, dependencies, or agent instructions for evidence-based technical debt. Use to assess duplication, complexity, obsolete elements, weak tests, inconsistency, or maintainability outside the review of one proposed change. Do not use to implement fixes, decide unresolved architecture, review a pull request, or merge.
---

# Audit Tabgrad maintenance needs

Find existing conditions that make the project harder to understand, verify,
change, secure, or operate. Produce evidence and bounded recommendations. Do
not turn a preference for different code or a tool's score into a maintenance
requirement.

## Define the audit target

Identify the repository state, requested area, reason for the audit, and the
decisions its result should support. Record the branch, revision, working-tree
state, included paths and concerns, and explicit exclusions. Do not describe a
sampled or limited inspection as a complete repository audit.

Read `README.md`, `CONTRIBUTING.md`, `docs/README.md`,
`docs/project-management.md`, `docs/agent-workflow.md`,
[`docs/quality.md`](../../../docs/quality.md), and the documentation, code,
tests, configuration,
history, issues, and accepted decisions relevant to the target. Inspect
generated-file rules and third-party origins before treating repetition or an
unusual structure as accidental.

A read-only audit may begin from the user's bounded request without an existing
issue. Remediation that changes the repository must follow a maintenance issue
or another appropriate issue type, except for the narrow no-issue correction
allowed by `CONTRIBUTING.md`.

When an audit is tracked by an issue, inspect its assignee, project status,
dependencies, and related work before beginning. If it is `Ready`, identify
the responsible contributor and propose moving it to `In progress`. Use
`tabgrad-issue` when the user authorizes the assignment and transition.
Otherwise, present the proposed assignment and status change and wait; do not
begin the tracked audit while its issue is still advertised as available.
When the issue is already `In progress`, confirm that the audit belongs to its
responsible contributor or that collaboration or handoff has been agreed.

When the audit issue is `Blocked`, inspect the recorded impediment and evidence
that it has been removed. If the same responsible contributor will resume and
the audit otherwise remains ready, propose returning it to `In progress`. If
nobody will resume, propose returning it to `Ready` and updating its
assignment. Use `tabgrad-issue` for authorized mutations and do not resume the
tracked audit while the recorded blocker remains unresolved.

When the requested scope is too broad to inspect responsibly, divide it into
named areas or representative samples and explain the resulting coverage. Do
not silently narrow the work or claim that uninspected areas are healthy.

## Preserve audit boundaries and authority

A request to audit authorizes read-only inspection and configured
non-destructive analysis. It does not authorize editing or deleting files,
running an automatic fix, changing dependencies or Git history, creating or
modifying GitHub items, publishing findings outside the response to the user,
or implementing recommendations.

Read-only inspection of the repository's public GitHub state and public
authoritative sources is part of an audit when needed to establish a claim.
Do not install a new analysis tool, use private credentials, access non-public
data, or use a paid or state-changing external service unless that action is
authorized. When an existing tool cannot run, record the missing environment
and continue only with conclusions that do not depend on it.

Some analysis tools create caches or reports. Prefer modes and locations that
do not alter the target. Inspect repository status before and after execution,
and do not delete or claim an unexpected file until its origin and ownership
are known.

Treat a possible vulnerability or privacy exposure as sensitive. Preserve the
minimum evidence needed and use the private reporting process in
`CONTRIBUTING.md`. Do not publish exploit details in a general maintenance
report or public issue.

## Gather independent evidence

For an audit that crosses several project areas or types of maintenance risk,
delegate bounded read-only assignments to separate subagents when available.
Partition them by paths or concerns so that each assignment has a clear scope
and no agent assumes that another covered the same requirement.

Include one independent challenge of material findings in a broad audit. The
challenger must inspect the cited files and evidence, look for intentional
exceptions and false positives, and identify the behavior and evidence that a
future remediation must preserve. Subagents must not modify files or GitHub
state and must not create issues.

The coordinating agent must review the original evidence and reconcile
disagreement. If independent challenge is unavailable, report that limitation
and do not describe a broad audit as conclusive. A bounded inspection may be
performed directly when extra delegation would merely repeat the same work.

Apply the assignment, evidence, authority, and finding-classification rules in
`docs/agent-workflow.md`. Audit subagents may recommend bounded follow-up work,
but they must not create issues or implement remedies.

## Look for maintenance problems, not preferred style

Choose checks from the target and evidence. Consider these concerns only when
they apply:

- repeated logic, data definitions, configuration, documentation, or sources
  of truth that can diverge;
- functions, modules, responsibilities, interfaces, or workflows whose
  complexity obscures behavior or makes safe testing difficult;
- unreachable, unused, superseded, deprecated, generated, vendored, or
  compatibility code whose purpose may no longer exist;
- abstractions that add indirection without serving current behavior, and
  missing shared abstractions where independent copies must remain aligned;
- repeated variations that encode the same invariant separately, independently
  responsible helpers nested inside functions, and callbacks or closures that
  hide reusable policy, multi-stage processing, complex control flow, or
  failure behavior;
- example-specific conditions, unexplained thresholds, silent fallbacks,
  swallowed errors, and knowingly temporary workarounds that conceal a cause;
- weak, brittle, slow, flaky, duplicated, skipped, or undiscovered tests and
  behavior that lacks meaningful regression protection;
- stale or contradictory documentation, examples, compatibility records,
  configuration, automation, templates, or contributor and agent
  instructions;
- unnecessary, unused, outdated, vulnerable, incompatible, or poorly
  attributed dependencies and third-party code;
- recurring failures, warnings, manual steps, fragile generation, difficult
  setup, or other tooling that consumes ongoing maintenance effort; and
- resource, performance, security, privacy, portability, or migration risks
  caused by the existing implementation's structure.

Do not require every audit to cover every concern. Do not embed a fixed list of
project technologies, packages, modules, or current experiments in this skill.
Obtain domain-specific expectations from the current repository and the audit
request.

## Establish evidence and reject false positives

For each candidate finding, identify the exact paths, symbols, configuration,
or behavior involved. Explain how the condition causes or is likely to cause a
concrete problem in correctness, comprehension, testability, performance,
security, compatibility, or ongoing maintenance.

Use configured static analysis, dependency analysis, test reports, history,
and measurements when they help, but inspect the underlying code and behavior.
A threshold, warning, coverage percentage, file length, age, or textual match
is a signal to investigate, not proof of technical debt.

Check for intentional reasons before reporting a problem:

- Similar code may express different behavior, ownership, lifecycle, or
  compatibility requirements.
- Repetition may be safer than coupling unrelated components through a shared
  abstraction.
- A callback or closure required by an API may be clearer at its call site when
  its behavior is cohesive and local, even when it captures state or contains
  minor control flow. It is not by itself a nested responsibility.
- A threshold may be valid when a semantic, physical, compatibility, or format
  boundary defines and documents it.
- Apparently unused code may be loaded dynamically, exposed publicly,
  referenced by generated output, or retained for a documented compatibility
  reason.
- A large or complex unit may already be the clearest boundary for an
  indivisible responsibility.
- Low measured coverage does not prove that a particular behavior is untested,
  while high coverage does not prove that assertions are meaningful.
- An old dependency is not automatically unsafe, and a newer version is not
  automatically compatible or beneficial.
- Divergent documentation or configuration may serve distinct audiences or
  environments rather than duplicate one source of truth.

Confirm current dependency, vulnerability, deprecation, and compatibility
claims with authoritative sources and record the version and date examined.
Distinguish confirmed findings, plausible concerns needing more evidence, and
areas that could not be evaluated.

When a finding depends on existing behavior, run the authorized reproducible
checks needed by the audit and record their exact target and results. Use
`tabgrad-verify` after a remediation has produced a proposed repository change.
Do not claim that a refactor would preserve behavior merely because the
intended output appears unchanged in a few examples.

## Assess consequences and boundaries

Explain the consequence, affected users or contributors, frequency or
conditions, reach across the repository, and likelihood of divergence or
failure. Also identify remediation cost, risk, dependencies, reversibility,
and the behavior that must remain unchanged.

Prioritize from those facts. Do not invent numerical scores or labels, and do
not rank a cosmetic preference above a smaller problem with demonstrated
correctness, security, or recurring maintenance consequences.

Group occurrences when they share one cause and can be corrected and verified
together. Split findings when they require independent decisions, touch
different responsibilities, can be delivered separately, or would make one
change difficult to review or reverse.

A cleanup that changes a public contract or lasting project structure is not
merely maintenance. Require `tabgrad-architecture` when it introduces or
changes an architectural decision. Use the issue type that describes the real
result when remediation intentionally changes observable behavior.

## Turn confirmed findings into proposed work

For each actionable finding, provide:

- the evidence and exact affected locations;
- the concrete maintenance consequence;
- the behavior and interfaces that must remain unchanged;
- the bounded improvement that should result;
- important exclusions and relationships to other work;
- how the result can be verified; and
- uncertainty or investigation still required.

Search existing issues and pull requests before proposing a new issue. Use
`tabgrad-issue` only when the user asks to draft, create, relate, or classify
the work. Do not create one issue for every superficial occurrence, and do not
create a vague repository-wide cleanup issue that cannot be completed or
verified.

Remediation is a separate activity. Use `tabgrad-implement` only after an issue
is ready and the user authorizes implementation. The change must then pass
`tabgrad-verify` and `tabgrad-review`; the audit report is not evidence that
the remediation is correct.

For an audit tracked by an issue, propose moving it to `In review` when its
scope, methods, evidence, findings, rejected candidates, and limitations are
complete enough for evaluation. After the report is accepted and every
required follow-up issue, relationship, and completion condition has been
recorded, propose moving it to `Done`. Use `tabgrad-issue` only for authorized
mutations. If evaluation requires material additional audit work, propose
returning the issue to `In progress` rather than leaving an incomplete report
under review.

## Report the audit

Report confirmed findings first, ordered by demonstrated consequence. Each
finding must include its evidence, impact, scope, preservation requirements,
and smallest coherent next result. Separate concerns that need more evidence
from actionable findings and optional observations.

Also report:

- the exact revision, working-tree state, scope, exclusions, and methods;
- configured tools and commands used, including failures and limitations;
- areas inspected, sampled, delegated, challenged, or not inspected;
- rejected candidates and important reasons they were not findings;
- recurring trends only when comparable historical evidence supports them;
- proposed issue boundaries and relationships without creating them unless
  authorized; and
- every repository, environment, or GitHub mutation actually performed.

When no confirmed finding remains, say so without claiming that uninspected or
unmeasurable areas contain no debt. A maintenance audit is complete when its
stated scope and methods are accounted for, not when it produces a desired
number of findings.
