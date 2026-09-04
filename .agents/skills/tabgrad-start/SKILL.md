---
name: tabgrad-start
description: >-
  Start or resume one existing Tabgrad issue when the user explicitly invokes
  `$tabgrad-start` with an issue number, applying its bounded start transition
  and routing the work through every applicable repository skill. Do not use
  for an ordinary request that does not explicitly invoke this entry point.
---

# Start an existing Tabgrad issue

Turn one issue number into the applicable Tabgrad workflow without requiring
the user to repeat the normal assignment, status, delegation, and stopping
instructions. The issue defines the work. The specialized repository skills
remain responsible for performing it.

Read and follow `docs/agent-workflow.md`, `docs/project-management.md`,
`CONTRIBUTING.md`, and the complete issue before starting. Use `docs/README.md`
to locate any other primary project rules that the issue and selected activity
require.

## Interpret the explicit invocation

Use this skill only when the user explicitly invokes
`$tabgrad-start <issue-number>`. Require one unambiguous issue number and
resolve it in the repository associated with the current workspace. If the
repository or issue cannot be identified safely, stop and ask for the missing
identifier without changing local or GitHub state.

The explicit invocation authorizes these actions for the named issue and the
required sub-issues that this skill validly starts:

- inspect their GitHub and repository context and relevant public sources;
- assign them to the authenticated contributor responsible for the work and
  move them to `In progress` as one coherent start transition;
- record actual progress, evidence, results, and documented status transitions
  in those existing issues when the selected skills require it;
- perform the local research, audit, implementation, checks, commits, and
  bounded read-only delegation that their issue types and selected skills
  permit; and
- continue until the selected workflow reaches one of the stopping boundaries
  below.

The invocation does not authorize creating or expanding issues, changing
relationships, priority, size, or milestones, publishing a branch, opening or
editing a pull request, accepting a research conclusion, approving an
architectural decision, submitting a GitHub review, merging, releasing, using
private or paid resources, installing dependencies, or performing a
destructive action. Obtain the authorization required by the owning skill
before any of those actions.

Use `tabgrad-issue` for every authorized issue, assignment, relationship, or
project mutation and verify the resulting GitHub state. This entry point
describes the authority supplied by its invocation; it does not perform those
mutations through an improvised procedure.

## Confirm that work can start

Read the complete issue body, labels, assignee, project fields, milestone,
parent and sub-issue relationships, dependencies, active branches, pull
requests, comments that can change readiness, and accepted decisions. Inspect
only the repository context needed to evaluate those facts.

Do not repeat a complete duplicate search merely because work is starting.
Use the search already recorded during triage unless the issue has materially
expanded, new work creates a plausible conflict, or another concrete fact makes
that evidence stale. Apply `tabgrad-issue` when another search or issue
correction is needed.

Start an issue in `Ready` only when its content, classification, priority,
size, relationships, dependencies, and completion conditions still satisfy
`docs/project-management.md`. Identify the authenticated contributor who will
be responsible before changing its status. Assign the issue and move it to
`In progress` together before substantive work begins.

Resume an issue already in `In progress` only when it is assigned to the
contributor performing the work or an explicit collaboration or handoff is
recorded. Do not replay the start transition.

Do not start an issue in `Triage`, `Needs information`, `In review`, `Blocked`,
`Done`, or `Not planned`. Do not take over work assigned to another contributor
or continue through an unresolved dependency or material decision. Report the
exact reason and the smallest action needed to make the issue startable. The
invocation does not authorize that correction unless it is itself part of the
coherent start transition defined above.

If any part of a GitHub transition fails or returns an ambiguous result,
inspect the live issue and project state before retrying. Do not begin work
while assignment and status disagree about ownership.

## Determine the work represented by the issue

For an issue without sub-issues, start only that issue. For an issue with
sub-issues, read its completion conditions and native GitHub relationships.
Start the parent activity and only the direct sub-issues that are recorded as
required, are individually `Ready`, and can begin without an unresolved
dependency or decision. Do not treat a textual mention as a parent relationship
and do not start optional, merely related, or unready work.

Assign the parent to the coordinating contributor and move it to `In progress`
when its own substantive activity or at least one required sub-issue begins. If
none of that work can begin, leave the parent unchanged and report why.

Partition required sub-issues by their recorded results and dependencies.
Run independent work in parallel when doing so saves time or improves evidence,
and serialize work whose input depends on another result. Do not choose a fixed
number of agents. Give every subagent the bounded question, original issue,
paths or concerns, evidence, exclusions, permissions, and stopping condition
required by `docs/agent-workflow.md`. Subagents remain read-only and do not
mutate GitHub; the coordinating agent performs authorized mutations and checks
their results.

Do not recursively absorb unrelated descendants or create follow-up work. A
finding that may justify another issue is reported under the normal finding
classification and authorization rules.

## Route to the owning skills

Select the activity from the issue's main result, type, concerns, and
relationships. Use every skill that applies:

- Use `tabgrad-research` for `type: research`. Also use
  `tabgrad-architecture` when `concern: architecture` applies or the decision
  is architectural under that skill.
- Use `tabgrad-implement` for a bug, feature, documentation change, or defined
  maintenance correction whose main result is a repository change.
- Use `tabgrad-maintenance` when the issue's main result is an audit of
  existing technical debt rather than a repository correction.
- Use `tabgrad-issue` to coordinate a parent whose own result consists only of
  managing its sub-issues and their recorded outcome.

Apply `tabgrad-verify`, `tabgrad-review`, `tabgrad-pull-request`, and
`tabgrad-merge` only at the stages and under the authority defined by those
skills. An explicit start authorizes independent verification and review of a
local implementation result, but it does not authorize publishing or merging
that result.

If the type and expected result imply different owning activities, or the
correct route otherwise remains ambiguous after inspecting the issue, stop and
explain the conflict. Do not choose the most convenient workflow silently.

## Preserve the issue boundary while working

Use the issue's problem, expected result, included and excluded work,
completion conditions, relationships, risks, and accepted decisions as the
work-specific context. Do not replace missing issue context with the earlier
conversation or pass the complete conversation to subagents by default.

Let each selected skill determine its relevant evidence, checks, artifacts,
and lifecycle transitions. Do not repeat its full procedure in this entry
point. Expand inspection only when evidence establishes a dependency, conflict,
stale premise, material risk, or other reason allowed by
`docs/agent-workflow.md`.

## Stop at the next authority or decision boundary

Continue routine authorized work without asking the user to repeat the start
instruction. Stop and report when:

- the issue cannot begin or continue because its premise, scope, dependency,
  ownership, security, or environment is invalid or blocked;
- a material product, compatibility, architecture, dependency, performance,
  security, privacy, or scope decision belongs to the user;
- research reaches a checkpoint, provisional recommendation, conclusion, or
  acceptance boundary that requires user participation;
- an audit report is ready for acceptance or needs separately authorized
  remediation work;
- a local implementation has current independent verification and review and
  is waiting for authorization to publish its branch or pull request; or
- the owning skill defines another boundary that the invocation did not
  authorize crossing.

At the stopping point, report the issue and exact state, activities and agents
used, evidence produced, mutations performed, incomplete or blocked work, the
decision or authority now required, and the next applicable skill. Do not
describe an issue as complete merely because the entry point finished routing
it.
