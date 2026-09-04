---
name: tabgrad-merge
description: Verify and merge an approved Tabgrad pull request, then check and report its post-merge state. Use when the user asks to merge or finalize a pull request. Do not use for implementation, review, or verification alone.
---

# Merge a Tabgrad pull request

Merge only a change that has already completed implementation, verification,
and review. Do not use this skill to repair the pull request or to replace any
earlier stage of the workflow.

## Read the repository rules

Read `CONTRIBUTING.md`, `docs/README.md`, `docs/project-management.md`,
`docs/version-control.md`, `docs/agent-workflow.md`, and
`.github/pull_request_template.md`. Read the
primary and other linked issues when they are required, and read the complete
pull request, including its current diff, commits, checks, reviews,
conversations, and metadata.

Use the repository's configured checks and GitHub rules as the source of truth.
Do not invent substitute checks or waive a requirement because its tooling is
unavailable.

## Identify the exact action

Resolve the repository, pull request, source branch, target branch, current
head commit, and the primary and other linked issues when the work requires
them before taking any action.

Confirm that the current user request explicitly authorizes merging this exact
pull request. A request to inspect, review, verify, prepare, or explain a pull
request is not authorization to merge it.

Use the default squash merge defined in `docs/version-control.md`. Use another
permitted method only when a maintainer has explicitly approved the exception
for a concrete reason.

Treat authorization to merge as authorization for the merge itself. Perform
additional changes, such as manually closing an issue, changing project
fields, creating follow-up issues, or deleting a branch, only when the request
also authorizes finalization or repository automation performs them as a
direct consequence of the merge.

## Require an independent readiness audit

Before any merge action, delegate one read-only audit to a subagent. Give the
subagent the pull request, linked issues when required, repository rules, and
current head commit. Tell it to inspect the original evidence rather than
relying on a summary from the main agent. Apply the assignment, independence,
evidence, and authority rules in `docs/agent-workflow.md`.

The subagent must check:

- whether an implementation pull request completes its primary issue, the pull
  request provides an artifact explicitly required by its research issue, or
  the complete change qualifies for the documented no-issue exception, without
  unrelated work;
- whether the completion conditions it claims are satisfied or the merge
  itself will satisfy them;
- whether required tests, documentation, compatibility information, and other
  evidence are present;
- whether all required checks and reviews apply to the current head commit;
- whether unresolved conversations, conflicts, hidden limitations, or missing
  follow-up issues remain; and
- whether the primary issue and other linked issues when required, project,
  milestone, closing keyword, and pull request metadata agree with the result
  the pull request actually completes.

Require the subagent to return a concise report containing blockers, supporting
evidence, and unresolved uncertainty. The subagent must not edit files, push
commits, approve the pull request, merge it, change GitHub metadata, close an
issue, or delete a branch.

If subagent delegation is unavailable, stop before merging and explain that the
required independent audit could not be performed. Do not present a manual
substitute as satisfying this requirement.

## Apply the final merge gate

Review the subagent's report, but do not accept it without checking the current
GitHub state directly. Immediately before merging, confirm that:

- the pull request is open and is not a draft;
- its target branch is the intended branch;
- its head commit has not changed since verification and review;
- its primary issue and other issue relationships when required, claimed
  result, and use or absence of a closing keyword are clear and accurate;
- every completion condition the pull request claims is satisfied or the merge
  itself will satisfy it;
- if the pull request will close an issue, all of that issue's completion
  conditions will be satisfied by the merged result;
- the pull request template contains evidence or an explained `Not applicable`
  entry for every required subject;
- all required status checks pass for the current head commit;
- all required reviews apply to the current head commit;
- all required review comments are resolved;
- no merge conflict remains;
- implementation, tests, documentation, and compatibility claims agree;
- known limitations are visible and necessary follow-up work is recorded; and
- no repository rule, security finding, or dependency finding prevents the
  merge.

Do not rely only on checked boxes in the pull request description. Inspect the
evidence to the extent needed to establish that the statements are true.

Do not approve a pull request on behalf of another reviewer. Do not use an
administrator bypass, dismiss a review, weaken a required check, enable
auto-merge, or alter branch protection unless the user separately requests that
exact action and its consequences have been explained.

## Stop when the pull request is not ready

Do not merge when any required evidence is missing, a required check is
failing or incomplete, a required review is absent or stale, the head commit
changed after verification, or a material uncertainty remains.

Report each blocker with its evidence and the action needed to resolve it. Do
not implement a correction or change GitHub state unless the user explicitly
asks for that additional work.

## Perform the merge

Recheck the pull request head commit immediately before the mutation. Merge the
approved commit into the resolved target branch using the authorized merge
method.

Do not retry a failed or ambiguous merge blindly. Read the resulting GitHub
state first. If it is unclear whether the merge occurred, stop further
mutations until the state is known.

Record the pull request, target branch, merge method, and resulting commit.

## Check the result

After the merge, confirm:

- that the expected commit is reachable from the intended target branch;
- that GitHub records the pull request as merged;
- that checks on the target branch pass or are still running;
- whether the linked issue closed as intended;
- whether the project status and milestone reflect the actual result;
- whether the source branch still exists; and
- whether any required follow-up work remains recorded and linked.

If a target-branch check fails, report it immediately. Do not revert the merge,
push a fix, reopen or close an issue, or change project state without authority
for that action.

When finalization is authorized, update the primary implementation issue to
`Done` only when the merged change completed its conditions. Use
`tabgrad-issue` to perform and verify that authorized issue and project
mutation. Other linked implementation issues retain their own status. A merge
whose primary issue is research establishes only that the required artifact
now exists on the target branch. Return control to `tabgrad-research`, which
establishes whether the research issue satisfies all of its completion
conditions; do not move it to `Done` merely because an experiment or
documentation pull request merged. Use `Not planned` only for the reasons
defined in `docs/project-management.md`. Delete the source branch only when
repository policy or the user's request authorizes deletion and no remaining
work depends on it.

## Report the outcome

Report:

- whether the merge occurred;
- the pull request and resulting commit;
- the target branch and merge method;
- the status of target-branch checks;
- the resulting issue, project, milestone, and branch state;
- every post-merge action that was performed; and
- any remaining failure, uncertainty, or follow-up action.

Distinguish completed actions from recommended actions. Never report the work
as complete while a required check, documentation update, compatibility update,
or issue condition remains unresolved.
