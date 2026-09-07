---
name: tabgrad-pull-request
description: Prepare, open, update, or mark a Tabgrad pull request ready for review from a focused issue branch. Use when a branch must be published as a draft or review-ready proposal, or when an existing pull request's description or readiness state must be maintained. Do not use to implement, verify, independently review, approve, or merge the change.
---

# Manage a Tabgrad pull request

Publish one accurate proposal from an issue branch without confusing work in
progress with work that is ready for review. Keep the pull request, issue,
branch, verification evidence, and project state consistent.

## Read the repository rules and exact work

Read `README.md`, `CONTRIBUTING.md`, `docs/README.md`,
`docs/project-management.md`,
`docs/implementation-workflow.md`,
`docs/version-control.md`, `docs/continuous-integration.md`,
`docs/agent-workflow.md`, and
`.github/pull_request_template.md`. Read the
complete linked issue and its relationships. Inspect the branch, commits,
complete diff from the intended base, working-tree state, verification
evidence, and any existing pull request from the same source branch.

Resolve the repository, source branch, target branch, current head commit,
linked issue, and requested publication state. Do not publish from the default
branch. Do not assume that the target is the default branch when the issue or
repository says otherwise.

Use `tabgrad-implement` for repository changes and `tabgrad-verify` for
verification. This skill publishes and maintains their result; it does not
perform either task itself.

## Determine the requested action and authority

Distinguish these requests:

- Preparing a pull request produces proposed title and body text without
  changing GitHub.
- Opening a draft authorizes an ordinary push of the exact source branch when
  needed and creation or update of its draft pull request.
- Opening a pull request for review, or marking a draft ready, authorizes the
  same publication actions, the bounded transient-draft and final-report
  sequence required below, and the linked implementation issue's transition to
  `In review` after the gate passes.
- Updating an existing pull request authorizes only the title, body, links, or
  draft state identified by the request. It does not authorize new repository
  changes.
- Publishing a new local head to an existing pull request authorizes an
  ordinary push only when the request identifies that branch or pull request
  and the commits to publish. When every ready condition that can be established
  before publication passes and the prepared snapshot has independent review,
  the same request authorizes one bounded transition: the ordinary push, the
  minimum title or description update needed to make its evidence current,
  remote snapshot confirmation, and one relayed final-report comment. The
  comment is an output of that transition, not a prerequisite for its own
  authority. The request does not authorize unrelated title, body, metadata,
  or reviewer changes.
- Returning a review-ready pull request to draft and its issue to `In progress`
  requires current authority for both state changes. Earlier authority to mark
  the pull request ready does not carry forward to later work.

A request that merely asks to inspect, explain, verify, or review a branch or
pull request does not authorize any of those mutations. A request simply to
open a pull request means ready for review only when all readiness conditions
can pass through the bounded publication sequence below. The transient draft
used by that sequence is not a substitute for the requested ready result. If a
different readiness condition fails, explain what prevents that state and ask
whether the user wants a draft; do not silently publish a draft instead.

None of these requests authorizes force-pushing, rebasing, rewriting commits,
changing repository settings or protections, selecting or notifying individual
reviewers, submitting a formal review, approving, closing, or merging. The one
reviewer-authored evidence comment in the bounded ready-publication sequence is
not a formal review or approval. Obtain specific authority before any additional
external or destructive action.

## Reuse the correct pull request

Search open and closed pull requests for the source branch and linked issue.
When an open pull request already represents the same branch and result, update
that pull request when authorized instead of creating a duplicate.

Do not reopen a closed pull request, add new work to a merged branch, or replace
a pull request that records a different result without a user decision. When
another active pull request overlaps the work, explain the relationship and
resolve the intended ownership before publishing competing work.

The source branch must contain the intended commits. Uncommitted local changes
cannot be included in a GitHub pull request. If commits or implementation work
are still needed, return the work to `tabgrad-implement` rather than creating
them under this skill.

## Prepare an accurate proposal

Use `.github/pull_request_template.md`. Give the pull request a plain title
that describes the resulting change. Describe the complete diff and its reason,
not merely the latest commit or a list of files.

When the work requires an issue, identify exactly one primary issue whose
result the pull request implements. Link every other issue that the pull
request materially affects and explain whether it is a parent, dependency,
research source, or related effect. An implementation pull request must
complete its primary issue. If its claimed part can be merged and verified
independently, return to `tabgrad-issue` and define that part as its own issue
before publication. A pull request may provide an experimental artifact or
lasting documentation required by a research issue without completing that
research issue. Use a closing keyword only when merging the pull request should
satisfy the primary issue's complete result.

Map each claimed completion condition to evidence. Include the exact commands
and manual checks run against the current head, their outcomes, the tests that
detect changed behavior, documentation and compatibility effects, known
limitations, and required follow-up issues. Explain every applicable omission
or `Not applicable` entry.

When a change adds or corrects executable behavior distributed as part of
Tabgrad, record every useful red-green cycle. For each smallest useful behavior,
include the focused test command, relevant red failure observed before its
implementation, why that failure represented the missing or incorrect
behavior, and the corresponding green result. Add as many table rows as the
change needs; one row may cover several layers only when its test genuinely
observes them. For a behavior-preserving production refactor, record the
passing characterization or contract baseline and the final passing result.
When no distributed production behavior changed, state that TDD does not apply
and report the content-specific checks elsewhere in the template. Classify the
resulting behavior rather than the edited file type when generators, manifests,
export maps, build sources, or configuration determine distributed executable
behavior. Do not require a failing commit or expose irrelevant logs merely to
demonstrate the sequence.

Identify the independent preflight, verification, specialist, and review
evidence required by `docs/agent-workflow.md`. Confirm that each report refers
to the pull request's current head and that any later change was followed by
the necessary repeated checks. Preserve enough durable evidence for a later
coordinator to inspect the agent or reviewer role, exact target, assignment and
coverage, outcome, required findings, limitations, and primary evidence. A
bare anonymous pass statement is not sufficient.

Before final review, make the pull request title and description otherwise
complete and freeze them. The final reviewer records the repository and pull
request, SHA-256 digests of the exact title and description text, source
repository and branch, exact head, target repository and branch, comparison
base revision, and digest method. Do not put the digests in the title or
description they identify. The report locates itself and does not change the
reviewed snapshot. Do not edit a snapshot field afterward merely to add the
report link, outcome, or contents; any deliberate change creates a new snapshot
and requires the affected checks and review again. Publishing the report
requires authority for that external action.

The final reviewer may inspect the exact prepared title and description before
they are published. After publication, rederive every remote snapshot field;
publish the reviewer-authored report only when all fields match its reviewed
snapshot, and identify the reviewer rather than presenting a relayed report as
the coordinator's own independent work. If the target branch advanced, apply
the overlap rules in `docs/agent-workflow.md`, record the current comparison
state, and repeat the evidence that the advance can affect.

Do not copy stale evidence from an earlier commit. Do not check a statement
because the intended work should eventually make it true. Keep credentials,
private information, and sensitive vulnerability details out of public pull
request content.

## Keep drafts visibly incomplete

A draft may be useful for collaboration before implementation or verification
is complete. It must still have a coherent purpose, an issue link unless the
documented small-correction exception applies, and enough context for another
person to understand why it exists.

State what remains unfinished, which checks failed or could not run, which
evidence is stale or missing, and which decisions remain open. Leave readiness
statements unchecked when they are not true. Do not request approval or move
the issue to `In review`. The issue remains `In progress` unless another
documented condition requires a different state.

## Apply the ready-for-review gate

The completed publication may leave a pull request ready for review only when:

- the issue was ready for implementation, the research issue explicitly
  requires this verified experimental artifact as part of its method or this
  lasting documentation as a completion condition, or the complete change
  qualifies for the documented no-issue exception;
- when an issue is required, exactly one primary issue is identified and an
  implementation pull request will complete it or the pull request will provide
  an artifact explicitly required by its research issue;
- the branch contains one coherent change and its complete diff matches the
  claimed result;
- the implementation satisfies every completion condition it claims;
- `tabgrad-verify` passed against the current head commit;
- for a substantive coding-agent change, independent verification and
  skeptical review passed for the frozen pull-request snapshot and
  their final same-pull-request report is inspectable; the documented single
  spelling or formatting correction exception does not require this agent
  sequence;
- tests, documentation, compatibility records, and other required artifacts
  agree with the proposed behavior;
- the pull request template is complete and every readiness statement checked
  is supported by evidence;
- no known required correction, unresolved decision, conflict, or hidden
  limitation prevents review; and
- necessary follow-up work is recorded rather than left only in prose or
  memory.

Pull-request-only checks may begin after publication. Their pending state does
not make the proposal a draft, but they must pass before merge. A failure is a
finding, not an inconvenience to hide or bypass.

When publication for review is authorized, use `tabgrad-issue` to move the
linked implementation issue to `In review` after the non-draft pull request
exists and its content has been verified. Do not move a research issue merely
because an experimental or documentation pull request exists; follow the
research transition defined in `docs/project-management.md`.

## Perform and check authorized GitHub changes

Before pushing, confirm that the local source branch and remote destination are
the intended ones and that an ordinary push will not overwrite remote work.
Stop before a force push or history rewrite.

When opening a new substantive coding-agent pull request for review, use the
authority described above to create it first as a draft with the frozen title
and description. Verify every remote snapshot field, relay the reviewer-authored
final report in one pull request comment after independent review of that exact
snapshot, and only then mark the pull request ready and transition its
implementation issue to `In review`. If any step or gate fails, leave the pull
request draft and the issue out of `In review`, then report the incomplete
requested outcome. This transient draft is an internal safety stage of the
authorized ready-publication operation, not its delivered result.

Create or update the pull request with the approved title, body, source, target,
and draft state. If an operation fails or has an ambiguous result, inspect
GitHub before retrying. Do not create a duplicate pull request or repeat a
notification because the first response was unclear.

Reopen the resulting pull request and verify its number, URL, title, body,
source branch, target branch, head commit, draft state, issue links, and visible
checks. Verify any authorized project transition separately. Correct a mismatch
only when the correction falls within the authority already given.

Do not wait indefinitely for checks. Report whether they passed, failed, or are
still running. A pull request can be ready for review while pull-request-only
checks run, but it cannot be ready to merge until every required check and the
independent technical review apply to the final head and every formal GitHub
approval required by `docs/continuous-integration.md` is present.

## Handle later changes

When implementation or review corrections change the head commit, treat prior
verification and review as stale wherever the change can affect them. Use
`tabgrad-implement` for the correction, run `tabgrad-verify` against the new
state, update the pull request evidence, and obtain review of that same state.

When only pull request content changes, use this skill rather than creating a
repository commit. Recheck the corrected metadata and claims and repeat review
of the affected pull-request snapshot. Reuse mechanical checks for the
unchanged head unless the correction reveals that their coverage, result, or
applicability was stated incorrectly.

Publishing the final independent report as a comment, or as a formal review
under separate authority, after the snapshot is frozen does not change or
invalidate the snapshot it identifies. If the report requires a correction,
update the owned artifact, create a new snapshot, and repeat the affected checks
and complete review before a later final report.

When every ready condition available before publication passes and the exact
prepared snapshot has independent review, an existing pull request may remain
non-draft and its issue may remain `In review` during the bounded update. After
publication, rederive the remote snapshot and publish the final-report comment;
only then does that report satisfy the remaining gate condition. If another
condition is missing before publication, obtain authority to return the pull
request to draft and move its linked implementation issue to `In progress`
before publishing. When that authority is absent, leave the remote pull request
unchanged and report that the local work has not been published.

If the bounded update fails after publication, report the inconsistent remote
state and request current authority to return the pull request to draft and its
issue to `In progress`; do not claim that the ready gate still passes.

If a material new head was already published by someone else and does not pass
the ready-for-review gate, report the inconsistent state and request current
authority to mark the pull request as draft and move the issue to `In
progress`. Perform both transitions when authorized. Do not treat an earlier
readiness request as permanent authority for either case.

After a pull request has been returned to draft, require a new request to mark
it ready and move the issue back to `In review` once the new head passes
verification. Do not dismiss reviews, resolve another person's conversation,
or claim that a requested correction is complete without checking the new
evidence.

## Report the result

Report:

- whether content was prepared locally or GitHub was changed;
- the pull request number and URL when one exists;
- its source, target, head commit, and draft or review-ready state;
- the linked issues and whether a closing keyword was used;
- the primary issue and the explained role of every other link;
- the verification evidence represented and any stale or missing evidence;
- checks that passed, failed, could not run, or remain in progress;
- the resulting issue and project state;
- every push, pull request update, notification, or other external mutation;
  and
- any blocker, inconsistency, uncertainty, or additional authority needed.

Never report that a pull request is ready for review or merge merely because
it was created, its template contains checked boxes, or some checks passed.
