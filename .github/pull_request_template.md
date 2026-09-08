## Summary

<!--
Explain what this pull request changes and why the change is needed. Describe
the resulting behavior rather than listing modified files.
-->

## Linked issue

<!--
Identify exactly one primary issue whose result this pull request implements.
Use a closing keyword when merging this pull request should complete the issue,
for example: Closes #123.

Explain every other issue link as a parent, dependency, research source, or
related effect. An independently mergeable implementation must have its own
primary issue. A research artifact may link its research issue without closing
it.
-->

## Implemented behavior

<!--
Describe the observable behavior implemented by this pull request. Explain any
deliberate difference from the linked issue or an accepted design.
-->

## Test-driven development

Use the route that applies. For new or corrected distributed production
behavior, add one row for every useful red-green cycle and record the behavior,
focused test command, expected red result before its implementation, and
corresponding green result. One row may cover several layers only when the test
genuinely observes them. For a behavior-preserving production refactor, record
the passing characterization or contract baseline and the final passing
result. For a change without distributed production behavior, write `Not
applicable — no distributed production behavior changed`; report its
content-specific checks under **Verification** and **Required evidence**. See
`docs/quality.md#develop-production-behavior-test-first`. A failing commit is
not required.

| Observable behavior or route | Before implementation | Final result |
| --- | --- | --- |
| <!-- One behavior, behavior-preserving refactor, or no distributed production behavior. Add rows for further cycles. --> | <!-- Valid red evidence, passing baseline, or not applicable --> | <!-- Focused passing result, final refactor result, or content-specific checks below --> |

## Verification

List every command and manual check run against the final commit. Do not claim
that a check passed if it was skipped, could not run, or ran against an earlier
version of the change.

| Command or manual check | Result |
| --- | --- |
| <!-- Command or check --> | <!-- Passed, failed, or could not run. Include relevant details. --> |

## Independent verification and review

For a substantive coding-agent change, make this description otherwise
complete and record its exact source/head and target/comparison base below
before final review, then freeze the title and description. The final reviewer
computes SHA-256 digests of the exact title and description text and records
them and the digest method in the final report, not in the text they identify.
Verification and skeptical review may be performed by the same independent
agent, but their conclusions remain separate. The reviewer-authored inspectable
report is published afterward as a comment in this pull request and identifies
the repository and pull request, title and description digests, source/head,
and target/comparison base. Do not edit a snapshot field merely to add that
report or its link; the same-pull-request report locates itself without changing
the reviewed snapshot. Replace stale evidence after every real correction.
When the agent sequence does not apply, state the governing exception or other
reason.

| Source branch and exact head | Target branch and comparison base | Independent verifier and outcome | Final reviewer and report location | Required findings before final review |
| --- | --- | --- | --- | --- |
| <!-- Repository, branch, and head commit --> | <!-- Repository, branch, and comparison base revision --> | <!-- Identity and PASS, FAIL, or INCOMPLETE --> | <!-- Identity; same-PR comment to follow after freeze --> | <!-- None, or each unresolved required correction --> |

## Required evidence

Complete every row. Provide evidence when the subject applies. Otherwise,
write `Not applicable` and explain why it does not apply. Do not use an
unexplained `Not applicable`.

| Subject | Evidence or reason it does not apply |
| --- | --- |
| Code quality and design | <!-- Explain the governing invariant, chosen abstraction or reason no abstraction is needed, root-cause reasoning for a bug, and any material performance tradeoff. --> |
| Tests | <!-- Identify added or changed tests and the behavior they detect. --> |
| Documentation | <!-- Identify and link every affected durable source. When technical documentation applies, classify its architecture, concept, component, flow, or reference perspective and link each changed primary source or index. Otherwise, explain from the changed contracts why no documentation can become inaccurate. --> |
| PyTorch compatibility | <!-- Identify the reference behavior and comparison, or explain why compatibility is unaffected. --> |
| CPU | <!-- Give the result of CPU checks, or explain why CPU behavior is unaffected. --> |
| WebGPU | <!-- Give the result of WebGPU and WGSL checks, or explain why WebGPU behavior is unaffected. --> |
| Browser and Pyodide | <!-- Give the tested environments and results, or explain why browser integration is unaffected. --> |
| Performance, memory, and bundle size | <!-- Provide comparable measurements for material effects or explain why none are expected. --> |
| Security and privacy | <!-- Describe the assessment and any data-flow change. --> |
| Dependencies and licenses | <!-- Identify dependency and license changes, or state that there are none. --> |
| Generated files | <!-- Identify each generated output and its registered source and command, or state that there are none. --> |
| Development environment and CI | <!-- Identify changed commands, tool versions, workflows, or branch settings, or explain why they are unaffected. --> |
| Architecture | <!-- Link the accepted decision and documentation update, or explain why architecture is unaffected. --> |
| Release and migration notes | <!-- Link the notes, or explain why users need no release or migration guidance. --> |

## Known limitations and follow-up work

<!--
Describe every known limitation. Link separate issues for necessary follow-up
work. Write "None known" only after considering the completed change.
-->

## Reviewer attention

<!--
Point reviewers to the decisions, risks, or parts of the change that deserve
particular attention.
-->

## Ready for review

For a substantive coding-agent change, the final same-pull-request report—not a
self-certified checkbox—establishes that independent verification and review
pass for the frozen pull-request snapshot. If the agent sequence does
not apply, explain why under **Independent verification and review**.

- [ ] Exactly one primary issue was ready for implementation or explicitly
  requires this research artifact or lasting documentation, or this pull
  request is a small correction that `CONTRIBUTING.md` permits without an
  issue.
- [ ] This pull request satisfies the primary issue's completion conditions for
  the work it claims to complete, or its complete no-issue correction is
  described above.
- [ ] The change is limited to one coherent purpose and contains no unrelated
  cleanup or formatting.
- [ ] Maintained code follows `docs/quality.md` and every applicable
  configured formatter, linter, type checker, and compiler passes without an
  unexplained suppression.
- [ ] Responsibilities and variations use the smallest justified structure;
  no independently responsible helper is nested inside another function, and
  every local callback or closure satisfies `docs/quality.md`.
- [ ] Every distributed production-behavior change has a test that would fail
  without the change.
- [ ] Every useful cycle for new or corrected distributed production behavior
  has valid red and green evidence;
  a behavior-preserving production refactor has passing baseline and final
  evidence; or this pull request contains no distributed production-behavior
  change and says so above.
- [ ] If this pull request fixes a bug, it corrects the owning invariant rather
  than hiding the symptom and includes a regression test for the affected
  class of behavior.
- [ ] If this pull request changes behavior, important successful behavior and
  failure behavior are both tested.
- [ ] All applicable repository checks were run against the final commit and
  are reported above.
- [ ] Code, tests, documentation, and compatibility claims describe the same
  behavior.
- [ ] Every affected durable documentation source was updated; applicable
  technical effects were classified by reader perspective, or the reason no
  durable documentation changed is recorded above.
- [ ] When relevant, unsupported behavior and backend selection are explicit.
  No silent fallback has been introduced.
- [ ] Every material performance claim or hot-path risk has comparable
  evidence, or the explanation above establishes why measurement does not
  apply.
- [ ] If dependencies changed, each change has a justified purpose, compatible
  license, recorded origin, and acceptable browser and bundle-size
  consequences.
- [ ] Every committed generated file has a registered source, reproducible
  command, and clean regeneration check.
- [ ] The final diff contains no credentials, local configuration, debugging
  code, accidental generated files, or unrelated changes.
- [ ] Necessary follow-up work has a linked issue rather than being left only
  in a comment or unchecked box.

## Ready to merge

Complete this section after review. Checking these boxes does not replace the
required GitHub status checks, independent technical review, or applicable
formal approval.

- [ ] The pull request is no longer a draft.
- [ ] All required status checks pass for the latest commit.
- [ ] The required independent technical review applies to the latest commit.
- [ ] A maintainer with review permission who is independent of the work and
  is not the author has formally approved the latest commit when required by
  [`docs/continuous-integration.md`](../docs/continuous-integration.md);
  otherwise, the pull request records that the author is the only maintainer
  with review permission.
- [ ] Every required review comment has been resolved.
- [ ] Merge conflicts are resolved without changing the verified behavior.
- [ ] The issue, project, milestone, and follow-up links are current.
- [ ] Known limitations remain visible and are not presented as supported
  behavior.
- [ ] The person performing the merge has explicit authorization to do so.
