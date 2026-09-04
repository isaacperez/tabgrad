---
name: tabgrad-architecture
description: Evaluate, obtain approval for, and document a lasting Tabgrad technical decision using explicit alternatives, research evidence, and consequences. Use in addition to `tabgrad-research` when a choice may establish or change cross-cutting structure, responsibilities, interfaces, data or control flow, build or distribution design, or fundamental technology. Do not use for non-architectural research or routine implementation choices already settled by repository documentation.
---

# Decide a Tabgrad architectural question

Add the scrutiny required before a research conclusion becomes a lasting
architectural decision. Use `tabgrad-research` for the common research method,
experiments, evidence, reproducibility, conclusion, and issue lifecycle. This
skill does not replace that work and does not turn research permission into
approval or implementation authority.

## Read the decision context and research evidence

Read `README.md`, `CONTRIBUTING.md`, `docs/README.md`,
`docs/project-management.md`,
`docs/agent-workflow.md`, the complete research issue and its relationships,
every relevant architecture and compatibility document, earlier decisions
that may be changed, and the evidence produced under `tabgrad-research`.

Inspect the relevant repository boundaries, responsibilities, interfaces, data
and control flow, build and distribution behavior, tests, and current
implementation before accepting a description of the existing architecture.
When external sources or implementations inform the decision, use the primary
sources, versions, constraints, origins, and licenses recorded by the research.
Another project's choice is evidence about an alternative, not a requirement
for Tabgrad.

## Confirm that the question is architectural

Use this skill only when the choice can establish or change a lasting project
structure, responsibility boundary, public or internal interface used across
components, data or control flow, persistence or distribution design,
fundamental technology, or another constraint that future work must preserve.
A difficult, performance-sensitive, or important implementation choice is not
automatically architectural.

The research issue must identify the exact decision, its boundaries, realistic
alternatives, required evidence, affected constraints, and completion
conditions. It should carry `concern: architecture`. If the issue is missing,
incomplete, duplicated, or no longer represents the decision revealed by the
evidence, use `tabgrad-issue` when the user asks to create or refine it. Do not
approve the architecture or implement a choice while the authoritative issue
still describes a different question.

Separate the architectural decision from production implementation. Research
may include bounded experiments, but experimental code does not become the
chosen production design merely because it produced useful evidence.

## Involve the user at material decision points

Before the research issue is treated as ready for architectural investigation,
present the exact decision question, boundaries, realistic alternatives,
decision criteria, evidence plan, proposed experiments, and material
assumptions in plain language. Ask the user to correct or confirm the parts
that depend on their intended result, priorities, or acceptance of tradeoffs.
Do not request another confirmation when those choices were already explicit
and the issue still records them accurately.

Do not ask the user to resolve a fact that can be established from the
repository, authoritative sources, or an appropriate test. The coordinating
agent remains responsible for gathering evidence, evaluating technical
consequences, exposing uncertainty, and recommending an alternative. The user
sets product priorities and decides which material tradeoffs are acceptable.

Continue routine investigation without pausing after every source, observation,
or result. Return to the user when new evidence could materially change the
question, boundaries, viable alternatives, relative importance of the
criteria, experiment design, recommendation, or an important consequence the
user may need to accept. Explain what changed, the evidence, the realistic
options, and the exact priority or decision needed. If the evidence does not
create such a choice, continue the investigation.

Before running a material experiment whose design assumes a user preference or
would exclude a viable direction, explain the hypothesis, the assumption, and
how the result could affect the decision. Obtain the needed user choice before
running an experiment that depends on it. Do not introduce an extra pause for
an experiment whose method and tradeoffs are already authorized by the issue.

When the evidence supports a recommendation, present it first as provisional.
Give the user a meaningful opportunity to challenge assumptions, add an
alternative or representative case, question a consequence, or request
additional material evidence. Investigate factual challenges rather than
asking the user to prove or disprove them. Silence is not acceptance.

If user feedback materially changes the recorded question, boundaries,
alternatives, criteria, or evidence plan, stop work that depends on the old
framing. Use `tabgrad-issue` to reconcile the authoritative research issue when
the user authorizes that mutation before continuing the affected work.

Subagents may gather or challenge evidence, but they must not choose for the
user or treat their conclusion as approval. The coordinating agent must inspect
and reconcile their evidence, explain material disagreements to the user, and
ask only for the decision that remains after discoverable facts have been
resolved.

## Compare viable architectural alternatives

Include the current design when it exists and can still satisfy the required
result. Compare every realistic alternative and any hybrid with meaningfully
different consequences. Do not add an implausible option merely to make a
preferred choice look justified.

For each alternative, state its assumptions, responsibility boundaries,
interfaces, ownership, data and control flow, failure behavior, migration path,
reversibility, and the conditions under which it would stop being suitable.
Evaluate only consequences relevant to the decision, including when applicable:

- correctness, semantics, invariants, failure modes, and recoverability;
- concurrency, scheduling, synchronization, determinism, and scaling;
- latency, throughput, startup, compilation, transfer, memory, and artifact
  size;
- compatibility, portability, public interfaces, and supported environments;
- testing, debugging, observability, and reproducibility;
- implementation cost, duplication, coupling, maintainability, and extension;
- dependencies, licensing, supply-chain risk, security, and privacy; and
- migration cost, rollback, future constraints, and irreversible effects.

Choose the decision criteria before interpreting the evidence. Do not combine
incomparable criteria into an arbitrary score. Explain tradeoffs directly and
identify which project constraint makes one consequence more important than
another.

## Require adequate and independent evidence

Confirm that the evidence satisfies `tabgrad-research`: its method is
reproducible, comparisons are fair, sources are current and primary where
available, failures and contrary results are preserved, and conclusions do not
extend beyond the examined conditions.

Require an independent challenge before presenting a lasting architectural
choice as ready for approval. When subagents are available, delegate a
read-only challenge that inspects the original issue, evidence, alternatives,
and repository context. It must look for missing alternatives, hidden coupling,
unfair comparisons, unsupported generalization, migration hazards, and
consequences the recommendation omits.

The challenge required by `tabgrad-research` may satisfy this requirement only
when its assignment and evidence explicitly cover both research validity and
architectural consequences. Otherwise use a separate challenger. Subagents
must not edit files, change GitHub state, choose for the user, or implement the
preferred option. The coordinating agent must inspect the original evidence
and resolve material disagreement.

Apply the common assignment, independence, evidence, and authority rules in
`docs/agent-workflow.md`. Do not disclose the preferred alternative as an
expected answer in an independent challenge.

If no independent challenge is available, the analysis may remain preliminary,
but do not present the architecture as ready for approval. When evidence is
missing or uncertainty could change the choice, return the bounded question to
`tabgrad-research` instead of filling the gap with confidence or preference.

## Present the decision for approval

After resolving material challenges to the provisional recommendation, present
the question, evidence, viable alternatives, important benefits and costs,
uncertainty, independent challenge, and recommended alternative in plain
language. Explain why the recommendation fits Tabgrad's documented constraints
rather than relying on authority, popularity, or analogy.

Ask the user to approve or reject the exact architectural choice and identify
any consequence that cannot be reversed cheaply. Permission to investigate,
run experiments, edit the issue, prepare a recommendation, or discuss an option
is not approval. Continue only with work that does not assume an unanswered
decision.

If the user rejects every evaluated alternative or requests a materially
different result, return the question to `tabgrad-research` and update the issue
when authorized. Do not reinterpret a rejection as permission to choose the
next option automatically.

## Record an approved decision

Approval of the technical choice does not by itself authorize editing the
repository, changing GitHub state, creating implementation issues, committing,
pushing, publishing, or implementing the chosen design. Determine which
recording actions the user authorized and wait before every additional
mutation.

When authorized, update the research issue with the approved choice, evidence,
reasoning, limitations, consequences, and approval. Use `tabgrad-issue` for the
issue, relationships, and project fields.

Record the decision in the relevant repository architecture documentation when
future contributors need it to understand or preserve the design. Use
`tabgrad-implement` for the authorized documentation change and
`tabgrad-verify` before describing that repository work as complete. The
research issue may remain `In review` while this required record is prepared.
The durable documentation must explain:

- the context and exact decision;
- the alternatives seriously considered;
- the evidence and reasoning supporting the choice;
- the consequences and constraints introduced;
- known limitations and conditions that justify reconsideration; and
- links to the research issue, experiments, measurements, and other evidence.

Keep transient progress in the issue instead of permanent architecture
documentation. Describe only approved or implemented behavior as current. If
the decision changes existing architecture, update or clearly supersede the
old explanation so that the repository does not present contradictory designs.

When authorized, create separate implementation issues for independently
reviewable production changes and record their parent and dependency
relationships through `tabgrad-issue`. Do not hide production implementation
inside the research issue.

`tabgrad-research` establishes when the research issue can move to `In review`,
return to `In progress`, or move to `Done`. Architectural research cannot move
to `Done` until the approved decision, required durable documentation,
implementation issues, relationships, and every research completion condition
have been recorded. Required repository documentation must be merged into its
target branch and checked there; an unmerged change is not the project's
durable architectural record.

## Report the architectural result

Report:

- the exact decision and architectural boundaries;
- the alternatives, criteria, research evidence, and independent challenge;
- benefits, costs, limitations, uncertainty, and conditions for reconsidering;
- the recommendation and whether the user approved it;
- every issue, documentation, repository, or GitHub mutation performed;
- the current research status and remaining records or implementation issues;
  and
- the next research or implementation work without performing it unless it was
  separately authorized.

Never report an architectural decision as complete while material evidence is
missing, independent challenge is absent, the user has not approved the exact
choice, required documentation disagrees, or the research issue's completion
conditions remain unsatisfied.
