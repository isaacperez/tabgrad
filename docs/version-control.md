# Version control

This document defines how Tabgrad uses branches, worktrees, commits, and merge
history. The purpose is to isolate work, make each proposed result
identifiable, and preserve a history that another contributor can understand.

## One issue, branch, and primary pull request

Each implementation issue has one active branch and one primary pull request.
A research issue may have a branch when it produces an experiment or lasting
document. An issue that only coordinates other issues does not need a branch.

A branch contains one coherent result. Do not add an unrelated fix, cleanup,
refactor, or formatting pass. If a discovered change can be completed,
verified, reviewed, and merged independently, it belongs in separate tracked
work.

The small correction that `CONTRIBUTING.md` permits without an issue may use a
branch without an issue number. It must still remain one coherent change.

## Name the branch

Use this form for work with an issue:

```text
<owner-or-tool>/<issue-number>-<short-description>
```

Use lowercase ASCII words separated by hyphens. The description states the
result rather than a vague activity. A coding agent created by Codex uses
`codex` as its first component. For example:

```text
codex/123-add-tensor-sum
```

For a permitted no-issue correction, omit the number and keep the description
specific, such as `codex/fix-readme-link`.

Do not encode status, priority, a person's private data, or a second issue
number in the branch name. Those facts have other authoritative locations.

## Start from the intended base

Before creating a branch, identify the repository's default branch and the
base revision intended for the work. Fetching or updating a remote branch is
an external operation and requires the authority and access needed for that
operation. Do not say that a branch is current merely because the local
default branch exists.

Create new work from the current remote default branch when it can be checked.
If work must use another base, record the reason in the issue and pull request.
Do not build new work on an unrelated feature branch merely because it is
already checked out.

## Use `main` as the integration branch

Tabgrad uses `main` as its default integration branch and does not maintain a
separate permanent `develop` branch. Issue branches normally start from the
current remote `main` and target `main` through a pull request. A different
base or target must be justified in the issue and pull request.

Merging into `main` updates the repository's integrated development state; it
does not create a Tabgrad release. A release is a separate, explicitly
authorized operation governed by [`releases.md`](releases.md).

## Protect existing working trees

Inspect the branch and complete working-tree status before changing files.
Uncommitted or untracked content may belong to another person or task. Do not
discard, move, reformat, stash, commit, or claim it without establishing its
ownership and obtaining any authority needed to change it.

Use a separate worktree when the current working tree contains unrelated work,
when two issues must proceed independently, or when a clean comparison with a
base revision is needed. Each worktree owns one active branch. Do not attach
the same branch to competing worktrees or allow two writers to modify the same
target.

Record the path, branch, base revision, and purpose of a worktree used by a
coding agent. Creating or removing a worktree changes Git metadata and must be
within the authorized work. Before removing one, confirm that it contains no
uncommitted or unpushed work that still needs to be preserved.

## Make coherent commits

A commit must leave the repository internally consistent for the part it
claims to complete. Group code with the tests and documentation needed to
understand that change. Do not create commits that intentionally fail required
checks merely to narrate intermediate typing steps.

Write the subject as an imperative description of the result, such as `Add
shape validation for sum`. Keep it specific. Use the body when the reason,
tradeoff, migration, or relationship to the issue is not clear from the diff.

Do not commit credentials, private data, local environment files, caches,
editor state, unexplained generated files, or unrelated changes. Inspect the
staged diff rather than assuming that staging selected the intended content.

Do not amend, rebase, squash, or otherwise rewrite commits that another person
may rely on without explicit agreement. Do not force-push a branch. If an
exception is genuinely necessary, identify every affected collaborator and
obtain explicit authorization immediately before the rewrite.

## Keep the branch current

Update an active branch when its base has moved far enough to affect the work,
when a conflict exists, or before final verification if the repository rules
require the latest base. Use a normal merge from the default branch unless the
maintainer has explicitly chosen a safe history rewrite for an unpublished,
solely owned branch.

Apply the concurrent-work classification in
[`agent-workflow.md`](agent-workflow.md) before developing related issue
branches in parallel. A branch ordered after another change may exist and may
use a draft pull request for coordination, but it must not enter final
verification or be marked ready for review until the prerequisite result is on
`main` and has been incorporated. An unrelated change to `main` does not by
itself require an immediate branch update or repeated checks.

Conflict resolution is part of the proposed change. Inspect the complete
result, rerun every affected check, and obtain review of the new state. A clean
Git operation is not evidence that the resolved behavior is correct.

## Publish and link the branch

Pushing is an external mutation. A request to implement locally does not
authorize it. When publication is authorized, verify the remote and branch
name, use an ordinary non-forced push, and check the remote state after an
ambiguous result before retrying.

Search for an existing pull request from the same branch before opening
another. The pull request identifies exactly one primary implementation issue
except for the documented research and no-issue cases. The complete
relationship is defined in `CONTRIBUTING.md` and
[`project-management.md`](project-management.md).

## Merge and retire the branch

Use squash merge for every pull request. The resulting commit must use a clear
subject and retain the issue relationship. Do not use merge commits or rebase
merges.

Use a source branch dedicated to one pull request. Do not merge from a shared
branch or from a branch that another open pull request, worktree, or continuing
piece of work still needs. Move the proposed change to a dedicated branch
before review when the existing source branch is not disposable. This check
must happen before merge because GitHub's automatic deletion setting applies
after the merge has already occurred.

Authorization to merge includes retiring the dedicated source branch. A branch
that must remain after the merge must not be used as the pull request head;
move the proposed commits to a disposable branch before review. Merge
authorization does not permit deleting `main`, a protected or shared branch,
a branch with work outside the merged pull request, or a branch whose state is
uncertain.

GitHub must automatically delete an eligible same-repository source branch
after merge. Confirm the remote result rather than assuming that the setting
applied. A source branch owned by a fork may remain outside the base
repository's control; report that limitation instead of claiming deletion.

Also retire the corresponding local branch in the clone controlled by the
merge process. First confirm that the merge contains the reviewed pull request
head, the local branch still identifies that head, its working tree is clean,
no other worktree uses it, and it contains no additional work. A squash merge
does not make the source branch an ancestor of the target branch, so ancestry
alone is not proof that local deletion is safe. If the source is checked out
in the controlled primary worktree, move that worktree to the target branch.
If it belongs to an auxiliary worktree owned only by the completed change,
remove that clean worktree from another controlled repository location. Then
delete the local source branch. If any condition cannot be proved, preserve
the branch and report the exact reason.

Verify the target commit, issue state, project state, release implications,
and remaining related work after merge. A merged pull request is not by itself
proof that every linked issue should close.
