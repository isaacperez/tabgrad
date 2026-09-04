---
name: tabgrad-research
description: Investigate a bounded Tabgrad research question and record reproducible evidence, limitations, and a supported conclusion. Use for any research issue or authorized experiment whose main result is knowledge rather than a production change. Use `tabgrad-architecture` in addition when the conclusion would establish or change a lasting architectural decision. Do not use to implement production behavior, approve architecture, independently review a repository change, or merge.
---

# Investigate a Tabgrad research question

Answer one recorded question with evidence that another contributor can
inspect, challenge, and reproduce. Preserve uncertainty and contrary results.
Do not turn a preferred implementation or desired conclusion into the premise
of the investigation.

## Read the question and project rules

Read `README.md`, `CONTRIBUTING.md`, `docs/README.md`,
`docs/project-management.md`,
`docs/agent-workflow.md`, the complete research issue and its relationships,
and every repository document, source, test, result, or accepted decision
relevant to the question.

Inspect current repository behavior before assuming what exists. When the
question depends on an external runtime, library, API, standard, dataset,
hardware capability, tool, paper, or implementation, use current primary
sources and identify the version, revision, specification, or date examined.
External projects provide evidence and alternatives; they do not determine
Tabgrad's requirements.

## Confirm that research may begin

Start substantive project research from an issue that satisfies the research
requirements in `docs/project-management.md`. It must state the exact question,
decision it will inform, boundaries, realistic alternatives, existing evidence,
missing evidence, method, environments, and completion conditions.

If the issue is absent, incomplete, duplicated, blocked by unresolved scope,
or no longer describes the question, use `tabgrad-issue` when the user asks to
create or refine it. A preliminary explanation or research plan may be useful
without an issue, but do not begin repository experiments, claim a completed
project investigation, or record a project decision from that preliminary
work.

Inspect the issue's assignee, project status, dependencies, branches, and
related work. When it is `Ready`, identify the responsible contributor and
propose moving it to `In progress`. Use `tabgrad-issue` when the user authorizes
the assignment and transition. Otherwise, present the proposed assignment and
status change and wait; do not begin substantive research while the issue is
still advertised as available. When it is already `In progress`, confirm that
the work belongs to its responsible contributor or that collaboration or
handoff has been agreed.

When the issue is `Blocked`, inspect the recorded impediment and evidence that
it has been removed. If the results already satisfy the entry conditions for
evaluation, propose returning it to `In review`. Otherwise, if the same
contributor will resume and the research remains ready, propose returning it to
`In progress`. If nobody will resume, propose returning it to `Ready` and
updating its assignment and related work. Use `tabgrad-issue` for authorized
mutations and do not resume substantive research while the recorded blocker
remains unresolved.

If the question would establish or change cross-cutting responsibilities,
interfaces, data or control flow, build or distribution design, fundamental
technology, or another lasting architectural choice, also use
`tabgrad-architecture`. Do not classify a decision as routine merely to avoid
its additional evidence, approval, and documentation requirements.

## Preserve research boundaries and authority

Determine whether the request authorizes a plan, read-only investigation,
experiment execution, repository changes, external services, or some
combination of them. Permission to explain or plan does not authorize running
experiments, installing dependencies, changing files, creating a branch, using
private credentials, incurring cost, or modifying GitHub.

Read-only use of public primary sources is part of an authorized investigation.
Ask before accessing private data or services, installing or updating tools,
using paid resources, physical devices, or environments outside the
repository's documented setup.

When an experiment changes repository files, use the issue's branch and
`tabgrad-implement`. Keep experimental artifacts separate from production code
unless the approved issue requires a reusable test or tool. Use
`tabgrad-verify` before describing repository work as complete. Research does
not authorize deploying the preferred alternative or turning experiment code
into production code.

Do not publish credentials, private data, proprietary inputs, or sensitive
vulnerability details in results, logs, issues, or pull requests. Follow the
private reporting process in `CONTRIBUTING.md`.

## Define a fair method before interpreting results

State the question in a form the available evidence can answer. Identify the
hypotheses or realistic alternatives, the criteria that distinguish them, and
the result that would contradict the leading expectation. Include the current
approach when it is a real alternative. Do not add an implausible alternative
only to make another appear stronger.

Define representative inputs, variables, controls, environments, comparison
conditions, measurements, and sources before interpreting results. Apply only
criteria relevant to the question. Do not combine incomparable observations
into an arbitrary score or treat a convenient benchmark as the project goal.

Choose the smallest investigation that can answer the question without
removing the behavior or cost being studied. Explain sampling and exclusions.
Do not describe a limited sample as complete coverage.

## Gather evidence and independent challenge

Use repository behavior, configured checks, specifications, documentation,
measurements, and existing implementations according to the question. Inspect
the original evidence behind material claims. Check the origin and license of
external code before reusing any detail; research permission is not reuse
permission.

For research with broad scope, material consequences, or evidence that depends
on several specialties, delegate bounded read-only assignments when subagents
are available. Require at least one independent challenge before presenting a
material conclusion as ready for evaluation. The challenger must inspect the
evidence and look for missing alternatives, invalid controls, contrary results,
unsupported generalizations, and conclusions broader than the data.

Subagents must not modify repository files, Git history, GitHub state, or an
external service. The coordinating agent must inspect the original sources and
reconcile disagreements. If independent challenge is unavailable, report that
limitation and do not present a material conclusion as conclusive. A narrow
investigation may proceed directly when delegation would merely repeat the same
inspection.

Apply the assignment, evidence, independence, and finding-classification rules
in `docs/agent-workflow.md`. A research subagent may recommend another
investigation or issue, but it must not create or expand one.

## Run reproducible experiments

Before execution, record the hypothesis, setup, commands, inputs, controls,
expected observations, measurements, stopping conditions, and sources of
variation. Use an appropriate reference or oracle and explain why it is valid
and where it is limited.

Record enough information for another contributor to reproduce the result:

- the repository revision and relevant dependency versions;
- the runtime, operating system, hardware, browser, backend, tool, dataset, and
  configuration information that can affect the result;
- setup, commands, inputs, workloads, repetitions, and raw observations;
- synchronization, warm-up, caching, and timing methods when they matter;
- failures, warnings, unavailable environments, deviations, and retries; and
- a durable location for evidence that cannot be represented faithfully in the
  issue.

Do not discard unexpected or failed results. Determine whether noise, caching,
measurement overhead, invalid controls, environment failure, or a mistaken
assumption could change the interpretation. Repeat or redesign the experiment
when that uncertainty is material. Do not generalize beyond the environments,
inputs, and conditions actually examined.

## Form and record the conclusion

Separate observed facts, conclusions supported by those facts, assumptions,
limitations, and unanswered questions. Compare the realistic alternatives
against the criteria chosen before the results were known. Describe both
benefits and costs and identify conditions under which the conclusion would no
longer apply.

When evidence is insufficient, state exactly what is missing and whether
another bounded investigation can obtain it. An inconclusive result can be a
valid research outcome when it supports a bounded decision such as preserving
the current behavior, deferring a change, or opening a specific follow-up
investigation. It must not be presented as support for a preferred decision.
An investigation that failed to satisfy its method or completion conditions is
unfinished, not an inconclusive conclusion.

Record the actual method, reproducible evidence, failures, limitations,
conclusion, reasoning, and consequences in the research issue when authorized.
Use `tabgrad-issue` for the issue and project mutations. Create or update
lasting repository documentation only through `tabgrad-implement` and verify
that change with `tabgrad-verify`.

## Manage the research lifecycle

Propose moving the issue to `In review` when its complete results, limitations,
conclusion, and consequences are recorded and ready for evaluation. If review
requires material new research, propose returning it to `In progress`.

A conclusion is accepted only when the user directing the work or a repository
maintainer authorized to decide the question explicitly accepts the exact
conclusion and its proposed project response after reviewing the evidence,
limitations, completion conditions, and independent challenge when one is
required. The researcher must not accept their own conclusion by inference.
Independent challenge, silence, a passing experiment, and approval of a
documentation pull request do not constitute acceptance. Record who accepted
what and when in the research issue through `tabgrad-issue` when that mutation
is authorized.

Propose moving the issue to `Done` only after its accepted conclusion supports
a recorded project response, every completion condition is satisfied, and
every required decision, follow-up issue, and relationship exists. Any lasting
repository documentation required by the issue must be merged into its target
branch and checked there; a local file, commit, draft, or open pull request is
not a lasting repository record. Architectural research must also satisfy
`tabgrad-architecture`. Use `tabgrad-issue` only for currently authorized
mutations; acceptance of a conclusion is not continuing authority to change
GitHub.

## Report the outcome

Report:

- the question, boundaries, revision, environments, and method;
- the evidence and primary sources used;
- results, failures, limitations, uncertainty, and independent challenges;
- the conclusion, its reasoning, and the decision it can support;
- whether `tabgrad-architecture` also applies and whether any decision was
  approved;
- the research issue and resulting project state;
- every repository, environment, or GitHub mutation actually performed; and
- missing evidence, follow-up work, or additional authority needed.

Never report that research is complete merely because an experiment ran, a
benchmark improved, a source agreed with the hypothesis, or the desired answer
appears plausible.
