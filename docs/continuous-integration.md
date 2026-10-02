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
`main`, and manual dispatch. It has read-only repository permission and three
job definitions. The browser matrix expands its definition into independent
Chrome and Firefox jobs.

The `repository-consistency` job prepares an isolated `.venv` with locked
Python tooling and the selected Node/npm environment with locked Pyright. It runs:

1. `.venv/bin/python -m ruff format --check scripts tests python`.
2. `.venv/bin/python -m ruff check scripts tests python`.
3. `npm run check:python` for strict Python type checking.
4. `.venv/bin/python scripts/check_repository.py`.
5. `.venv/bin/python scripts/run_tests.py`.

After Node setup it also selects execution applicability with
`node scripts/validation-scope.mjs` and always runs
`node --test --test-concurrency=2 js-tests/unit/validation-scope.test.mjs`.
Those tests need only Node and disposable local Git trees, not a distribution
build. The selector cannot decide to omit its own tests. Consistency remains
unconditional and publishes the validated runtime/browser decision to the
execution jobs only after its complete result succeeds.

Python type checking includes the maintained compatibility source with the
Pyodide interpreter target, separately from native tooling's Python target.
The check reads upstream type sources from the locked npm-installed Pyodide
archive; it does not install dependencies or import browser modules into
native Python. See [the command coverage](development.md#configured-commands).

When runtime execution applies, the `runtime` job uses Node.js 22.12.0 from `.node-version`, installs the Rust
1.98.1 minimal toolchain with `wasm32-unknown-unknown`, Rustfmt, and Clippy,
installs the npm lockfile without lifecycle scripts, and runs:

1. `npm run check` for strict TypeScript compilation and Rustfmt plus Clippy on
   both fixed WebAssembly feature variants.
2. `npm run test:node` to build the distribution and run the Node.js
   integration and raw-ABI tests.

The `browser` matrix creates one job with `TABGRAD_BROWSER=Chrome` and another
with `TABGRAD_BROWSER=Firefox`. Each isolated job prepares the same locked
Node.js, npm, and Rust environment and runs
`npm run test:browser:from-source` when browser execution applies. The command builds its own distribution and
executes scalar and SIMD additions only in the selected installed browser.
`fail-fast` is disabled, so one browser failure does not suppress evidence from
the other browser. This deliberately duplicates a small build and setup cost in
exchange for independent logs, results, and reruns without cross-job artifacts
or additional actions.

The repository-consistency job installs Python artifacts accepted by
`requirements-dev.lock` and the exact npm resolution from `package-lock.json`.
The runtime job installs the exact npm resolution,
selected Rust toolchain, and direct tools recorded in
[`dependencies.md`](dependencies.md). The repository validator rejects a
workflow until its path has been registered as reviewed. It checks every
workflow for read-only repository permission, job-level permission overrides,
`pull_request_target`, and actions that are unregistered or are not pinned to a
full commit. It also rejects undocumented shell commands. Validation commands
may appear only once; exact, idempotent environment-setup commands may repeat
where isolated jobs require the same toolchain. The test runner fails when
discovery finds zero tests. An empty suite is not a successful check.

The repository-consistency workflow must match its complete reviewed
executable definition. Event filters, the concurrency group, checkout inputs,
job containers, environments, conditions, shells, error-tolerance settings,
step order, and other executable fields cannot change merely because the
required command strings remain present. Review and register the complete new
definition whenever one of those controls must change.

The stable check names are `Repository checks / repository-consistency`,
`Repository checks / runtime`, `Repository checks / browser-Chrome`, and
`Repository checks / browser-Firefox`. The first checks Python formatting and
lint, static types, repository structure, policy consistency, and the validator itself. The
second checks TypeScript and Rust source plus the generated distribution and
Node.js behavior. The last two independently exercise the generated runtime in
their named real browser. Coding-agent instruction review remains a separate
reasoned review under
[`agent-instruction-review.md`](agent-instruction-review.md). Continuous
integration does not invoke AI models.

The workflow pins third-party actions to reviewed commits, disables persisted
checkout credentials, uses an explicit runner and Python version, limits job
time, grants only `contents: read`, and cancels superseded runs for the same
reference. Treat every workflow as executable code with access to the
permissions stated in its file.

## Select CI execution by impact

CI selects execution families, not individual tests. The selection owner is
[`scripts/validation-scope.mjs`](../scripts/validation-scope.mjs); it does not
invoke agents, infer semantic correctness or replace the independent review's
contextual validation plan. Local specialized checks may still be required by
a changed contract even when a generic CI family cannot cover that environment.

For a pull request, compare the event base commit with the actual checked-out
candidate (`github.sha`, normally the PR merge commit). Full history is fetched
in the consistency job. Both identifiers must be complete commit hashes, the
candidate must match checkout HEAD and the base must be its ancestor. Read the
complete NUL-separated Git diff with rename detection disabled so removed and
added homes both influence coverage. Do not classify a guessed head-only diff
while testing a different merge result.

The conservative policy is:

| Complete change set | Execution coverage |
| --- | --- |
| Maintained Markdown documentation/root policy files, brand Markdown/SVG, issue forms/template, or native Python tests under `tests/` only | Repository consistency and the applicable independent content/instruction/tooling review; no runtime build or browser execution |
| Node unit `.mjs` cases under `js-tests/unit/`, optionally mixed with the previous group | Runtime checks and the complete Node suite; unchanged browser execution is not selected |
| Runtime, Python compatibility, Rust, browser fixtures, build/dependency inputs, selector/workflow code, mixed executable areas, or an unclassified path | Both runtime and browser families |
| Main push, manual or unknown event, empty diff, malformed identifiers, missing history, checkout mismatch or failed/incomplete Git comparison | Both runtime and browser families |

Only known exclusions narrow coverage. New maintained locations default to full
coverage until their ownership and consumers justify a reviewed policy update.
The path policy is an automation boundary, not proof that a document's runnable
example or changed contract needs no additional check. Review decides that from
the actual result under [quality rules](quality.md#select-checks-from-the-affected-risks).

The four existing check names remain. Runtime and browser jobs wait for the
successful consistency decision, set up Node, and always record applicability
using `node scripts/validation-scope.mjs --report runtime` or `--report browser`.
Only their costly Rust/npm installation, compilation and execution steps are
conditional. A validated `false` is explicit non-applicability, **not** evidence
that those tests ran or passed. Missing/invalid outputs fail the reporting
command. A failed consistency job blocks downstream jobs and merge; it is not
an unaffected result. This admission ordering avoids running expensive jobs on
a rejected consistency result; it is not a measured speed improvement for
execution-affecting changes.

All configured execution runs on `main` and manual dispatch. There are no
workflow-level PR path filters, relaxed protections, error-tolerance flags,
new dependencies or secrets. Review and register the complete workflow and
selection policy together. CI evidence must include the actual decision,
selected step results and explicit exclusions, not merely four green badges.

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
- Set the required approving-review count from the number of maintainers with
  repository review permission: zero while there is only one such maintainer,
  and one when there are at least two.
- Dismiss approvals when the pull request head changes.
- Require all review conversations to be resolved.
- Require the `Repository checks / repository-consistency` status check.
- Require the branch to be current with `main` before merge when GitHub can
  evaluate the required checks on the updated state.
- Permit only squash merges under the policy in
  [`version-control.md`](version-control.md).
- Block force pushes and deletion of `main`.
- Apply the rules to administrators and disallow routine bypass.

Configure the repository to allow squash merges only and to delete head
branches automatically after their pull requests merge. The branch-lifecycle
and safety rules in [`version-control.md`](version-control.md) determine which
branches may be used as pull request heads: a branch that must survive a merge
must not be used as a disposable pull request branch.

The ruleset count is static, but the review requirement for an individual pull
request also depends on its author. When a maintainer with review permission
who is independent of the work and is not the author exists, that maintainer
must approve the current pull request head before merge, even when the ruleset
count is zero. When the author is the repository's only maintainer with review
permission, GitHub cannot record a self-approval. In that case, the pull request
may merge without a formal GitHub approval only after the independent technical
review required by [`agent-workflow.md`](agent-workflow.md) is current, all
other merge conditions pass, and the maintainer explicitly authorizes the
merge. A formal approval does not replace that technical review.

Reevaluate the ruleset count whenever the set of maintainers with review
permission changes. Do not use an administrator bypass to substitute for the
applicable count, review, checks, or merge authorization.

Add a runtime, build, browser, WebGPU, compatibility, or release check to the
ruleset only when its workflow and local command satisfy this document. A
required specialized check may use path selection only when the ruleset always
receives a conclusive success for unaffected changes.

The ruleset must be inspected through GitHub after creation, modification, or
a change in maintainer eligibility. Record its identifier, target, enforcement
state, approving-review count, eligible maintainers, required checks, bypass
actors, allowed merge methods, automatic head-branch deletion setting, and
verification date in the issue or pull request that configures it. A
repository specification never proves that a remote ruleset or repository
setting is active or correct for the current maintainers; remote enforcement
requires direct inspection of GitHub.

## Interpret CI results

A green status applies only to the commit and environment named by the run.
Inspect that expected jobs ran and selected tests were discovered and executed.
For explicitly unaffected families, verify the reviewed selection decision and
successful applicability report; describe conditional execution steps as not
applicable, never as passed tests. An unintended skip or missing applicability
record is not valid coverage. A canceled, neutral, skipped, timed-out, or
missing required result is not a pass.

When a workflow fails, classify the failure under `CONTRIBUTING.md`. Compare
with the base when necessary, preserve every failed attempt, and correct the
source or workflow through ordinary review. Do not rerun repeatedly until one
attempt happens to pass.

After changing CI or a ruleset, test pull-request and default-branch behavior.
Confirm that untrusted pull requests receive no secrets or write permission and
that the intended required-check names match GitHub's actual branch settings.
