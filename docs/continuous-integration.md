# Continuous integration and protected branches

This document defines the checks that GitHub Actions runs and the repository
settings that protect shared branches. Workflow files configure checks.
Branch protection and rulesets are GitHub repository settings and are not
activated merely by describing them in this repository.

## Local commands come first

Every continuous-integration step must call a documented local command from
[`development.md`](development.md). Contributors must be able to reproduce the
check without reconstructing hidden commands from workflow YAML.

Add a workflow only after its local command exists and succeeds. Update the
workflow and local command together. Continuous integration must not contain a
weaker substitute for a local required check or introduce a dependency that is
absent from [`dependencies.md`](dependencies.md).

## Repository consistency workflow

`.github/workflows/repository-checks.yml` runs on pull requests, pushes to
`main`, and manual dispatch. It has read-only repository permission and runs:

1. `python3 -m ruff format --check scripts tests`.
2. `python3 -m ruff check scripts tests`.
3. `python3 scripts/check_repository.py`.
4. `python3 scripts/run_tests.py`.

The workflow installs only the exact artifacts accepted by
`requirements-dev.lock`. The repository validator rejects a workflow until its
path has been registered as reviewed. It checks every workflow for read-only
repository permission, job-level permission overrides, `pull_request_target`,
and actions that are unregistered or are not pinned to a full commit. It also
rejects an undocumented shell command in any workflow and a registered command
that appears more than once across workflows. The test runner fails when
discovery finds zero tests. An empty suite is not a successful check.

The repository-consistency workflow must match its complete reviewed
executable definition. Event filters, the concurrency group, checkout inputs,
job containers, environments, conditions, shells, error-tolerance settings,
step order, and other executable fields cannot change merely because the
required command strings remain present. Review and register the complete new
definition whenever one of those controls must change.

The job's stable required-check name is `Repository checks /
repository-consistency`. It checks Python formatting and lint, repository
structure, policy consistency, and the validator itself. Coding-agent
instruction review remains a separate reasoned review under
[`agent-instruction-review.md`](agent-instruction-review.md). Continuous
integration does not invoke AI models.

The workflow pins third-party actions to reviewed commits, disables persisted
checkout credentials, uses an explicit runner and Python version, limits job
time, grants only `contents: read`, and cancels superseded runs for the same
reference. Treat every workflow as executable code with access to the
permissions stated in its file.

## Add checks by responsibility

Use separate jobs when failures have distinct owners, environments, or retry
needs. Formatting, static analysis, unit tests, CPU integration, browser and
Pyodide integration, WebGPU capability tests, package builds, compatibility,
generated-file consistency, and release checks require their own jobs when
they apply to repository behavior and cannot be covered responsibly by an
existing job.

Give every required job a stable descriptive name. The default permission
policy is `contents: read` at workflow level without job-level overrides. A
workflow that needs another permission must document the reason and register
its exact least-privilege policy in the repository validator before the
workflow is added. Pin actions to full commits and identify their release in a
comment. Avoid `pull_request_target` for code execution from pull requests.
Never expose write tokens or secrets to untrusted code.

Use concurrency only when canceling an earlier run cannot leave an external
mutation or shared environment incomplete. Set timeouts proportional to the
job. Preserve logs needed to diagnose failures without publishing credentials,
private data, vulnerability details, or excessive user input.

Do not make a check required until it is reliable enough that a genuine pass
is reproducible and an owner can address its failures. Do not remove a required
check, make it optional, or relax a threshold to merge one change.

## Required `main` ruleset

Configure a GitHub ruleset for `main` with these settings:

- Require changes through a pull request.
- Require one approving review from a reviewer independent of the writer.
- Dismiss approvals when the pull request head changes.
- Require all review conversations to be resolved.
- Require the `Repository checks / repository-consistency` status check.
- Require the branch to be current with `main` before merge when GitHub can
  evaluate the required checks on the updated state.
- Permit only squash merges under the policy in
  [`version-control.md`](version-control.md).
- Block force pushes and deletion of `main`.
- Apply the rules to administrators and disallow routine bypass.

Add a runtime, build, browser, WebGPU, compatibility, or release check to the
ruleset only when its workflow and local command satisfy this document. A
required specialized check may use path selection only when the ruleset always
receives a conclusive success for unaffected changes.

The ruleset must be inspected through GitHub after creation or modification.
Record its identifier, target, enforcement state, required checks, bypass
actors, and verification date in the issue or pull request that configures it.
A repository specification never proves that a remote ruleset is active;
remote enforcement requires direct inspection of GitHub.

## Interpret CI results

A green status applies only to the commit and environment named by the run.
Inspect that the expected jobs ran, discovered their tests, and did not pass
through an unintended skip. A canceled, neutral, skipped, timed-out, or missing
required result is not a pass.

When a workflow fails, classify the failure under `CONTRIBUTING.md`. Compare
with the base when necessary, preserve every failed attempt, and correct the
source or workflow through ordinary review. Do not rerun repeatedly until one
attempt happens to pass.

After changing CI or a ruleset, test pull-request and default-branch behavior.
Confirm that untrusted pull requests receive no secrets or write permission and
that the intended required-check names match GitHub's actual branch settings.
