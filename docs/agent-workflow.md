# Coordinating coding agents

This document defines how a coding agent coordinates independent agents while
working on Tabgrad. Its purpose is to make delegated work inspectable and to
prevent one agent from silently confirming its own assumptions or changes.

The repository skills define the requirements of each activity. This document
defines the rules shared by issue investigation, research, implementation,
verification, review, maintenance audits, and merge checks. Delegation never
replaces the applicable skill or expands the authority given by the user.

## Bound work before loading broad context

An issue, the coordinating agent, and each subagent have separate boundaries.
Defining one of them does not automatically define the others.

The issue defines one result, the behavior and project areas it includes, its
explicit exclusions, and the evidence needed to finish it. When a useful result
cannot be bounded, create a parent issue and independently completable
sub-issues or use a research issue to resolve the missing boundary. Do not use
an instruction to consider all possible concerns as a substitute for deciding
which concerns can materially affect the result.

Before substantive inspection, the coordinating agent must state its current
work boundary. It includes the issue, complete proposed diff when one exists,
directly affected files and interfaces, relevant callers or consumers, tests,
documentation, configuration, accepted decisions, and material risk areas. It
must also state exclusions and the condition that would justify expanding the
inspection. Reading the common project rules does not authorize an undirected
scan of every source, document, issue, or historical change.

Start with repository search, indexes, manifests, and the named files. Open
additional content only when a reference, dependency, call path, generated
relationship, shared source of truth, failing check, or plausible material risk
connects it to the result. Review every file in the proposed diff, but inspect
only enough surrounding context to evaluate its effects. A repository-wide
audit, search across all history, or complete external literature review occurs
only when the request or issue requires it and its areas are divided into
reviewable assignments.

Every subagent receives one bounded question or result, included paths or
concerns, explicit exclusions, permitted evidence, and a stopping condition.
A subagent must not broaden its assignment merely because adjacent code or a
new topic appears interesting. It may inspect the minimum adjacent evidence
needed to decide whether a finding affects its assignment. Otherwise, it
returns a concise pointer, explains the possible relationship, and asks the
coordinator to classify it before more context is consumed.

Partition parallel assignments so that their coverage is complementary and
named. Do not give several agents the same general request to review everything
and do not delegate a whole-repository inspection when separate paths, risks,
or questions can be assigned. The coordinator records which requirement each
agent covers and which relevant area remains uncovered.

Use an explicit time or token limit when the user, tool, or task provides one.
Without an explicit limit, choose the smallest inspection that can support the
required conclusion and stop when the completion conditions are evidenced or
a blocker, missing authority, or justified expansion is found. Never claim
complete coverage beyond the paths, concerns, environments, and evidence that
were actually inspected.

## When independent agents are required

A repository change is substantive when `CONTRIBUTING.md` requires it to have
an issue. When a coding agent performs such a change:

- an independent agent must perform a read-only preflight before the first
  repository edit;
- only one agent at a time may own and modify the target working tree;
- at least one agent independent of the writer must verify the final state;
- the change must receive the independent review required by
  `tabgrad-review`; and
- additional specialist agents must be used when distinct material risks
  cannot be assessed responsibly by one verifier or reviewer.

The small spelling or formatting exception in `CONTRIBUTING.md` does not
require this complete sequence. The agent must not use that exception for a
collection of corrections or any change in behavior, rules, tooling, tests,
dependencies, or substantive documentation.

Research, architecture, issue management, maintenance, and merge work retain
the independent checks required by their own skills. One bounded assignment
may satisfy requirements from more than one skill only when it explicitly
covers each purpose and preserves the required independence. Renaming the same
inspection does not create additional evidence.

## Keep roles independent

The coordinating agent defines assignments, checks the original evidence,
reconciles results, preserves authorization boundaries, and reports the final
state. It remains responsible for the result and must not accept a subagent's
conclusion without examining its supporting evidence.

The writer is the only agent permitted to modify the target working tree at a
given time. Ownership may be handed to another writer, but the handoff must be
explicit and the first writer must stop before the next begins. A verifier or
reviewer ceases to be independent for any area it materially designs or edits.

Preflight investigators, verifiers, reviewers, and other specialists are
read-only by default. They may inspect the repository and run authorized
non-destructive commands. They must not modify target files, Git history,
GitHub state, project fields, external services, or persistent environments.
When a check normally creates outputs or caches, use an isolated disposable
workspace or let the coordinating agent run it under the applicable skill.

Only the coordinating agent may delegate further work unless an assignment
expressly permits another bounded delegation. A subagent must not choose for
the user, approve its own work, create follow-up work, or treat its assignment
as authority for another action.

## Give every agent an evidence-based assignment

An assignment must identify:

- the question or result being checked;
- the issue and accepted decisions when they exist;
- the repository, base, branch, revision, working-tree state, and relevant
  files;
- the included concerns and explicit exclusions;
- the commands or evidence the agent may use;
- whether the work is strictly read-only and what isolated outputs are
  permitted; and
- the required report, including uncertainty and missing evidence.

Provide the original files, issue, checks, and decisions rather than only the
coordinator's summary. Do not tell an independent agent which conclusion it is
expected to reach. An assignment should be small enough that its coverage and
omissions can be understood.

For preflight, verification, and review, provide only the context needed to
answer the assigned question about the exact repository state. That context
normally consists of:

- the issue, its completion conditions, relevant relationships, and accepted
  decisions;
- the base, target revision or working-tree identity, branch, and permission
  boundaries;
- the complete proposed diff and changed-file list when a change exists;
- the directly affected files, interfaces, tests, and primary project rules;
- current command results and other evidence, including their environment and
  exact target; and
- known findings, limitations, material risks, and uncovered areas.

Do not pass the complete conversation history, an undirected repository dump,
or every project document by default. When the delegation mechanism can omit
inherited conversation context, use that mode and supply the bounded context
explicitly. This restriction does not permit replacing original requirements
or files with the writer's interpretation. The agent must be able to inspect
the original issue, relevant source files, complete diff when one exists, and
primary evidence.

Expand this context only when a concrete dependency, call path, failing check,
stale input, contradiction, security concern, or other material risk connects
additional evidence to the assigned conclusion. Record what was added and why.
Stop when the assigned conclusions have sufficient evidence, or when a blocker,
missing authority, or justified expansion is identified.

Every agent report must distinguish observed facts, conclusions, assumptions,
limitations, and unanswered questions. It must cite precise paths, lines,
commands, results, issue or pull request links, and source versions when they
support a material statement.

## Perform a preflight before implementation

The preflight tests whether the recorded work still matches reality before any
repository file is changed. The investigator must inspect the current issue,
dependencies, related work, accepted decisions, affected code, tests,
documentation, configuration, and relevant history.

These are possible evidence categories, not a requirement to inspect each one
exhaustively. Start with the issue, exact base, named affected files, and the
current work boundary. Inspect another category only when it can change whether
implementation may begin, the boundary of the work, an unresolved decision or
blocker, or the risks and checks that later work must address. Do not run the
full verification suite or evaluate final implementation quality during
preflight. Reuse current evidence when it already establishes a premise, and
run a focused observation only when it is practical and materially informs
readiness.

The report must establish:

- which issue assumptions and completion conditions are confirmed by current
  evidence;
- whether the described behavior or defect can be observed when that is
  practical and informative;
- whether existing abstractions, tests, documentation, or active work alter
  the expected scope;
- which questions can be answered from the repository and which still require
  a decision;
- whether a dependency, conflict, security concern, or stale premise prevents
  implementation; and
- the checks and risks that the implementation and final verification must
  address.

Stop after these conclusions have sufficient evidence. Report the inspected
paths and any category deliberately not opened; do not continue into solution
design, implementation, final verification, or an unrelated maintenance
investigation.

The coordinating agent must inspect the evidence behind material findings. If
the issue is stale, duplicated, incomplete, incorrectly scoped, or blocked,
stop the affected implementation. Use `tabgrad-issue` for a proposed or
authorized correction. Do not edit code first and repair the issue afterward.

## Preserve one writer and one coherent target

The writer integrates the preflight evidence and performs the authorized
change under `tabgrad-implement`. Read-only investigation may proceed in
parallel, but two agents must not edit the same target concurrently, even when
they intend to touch different files. This prevents hidden dependencies,
partially integrated results, and uncertainty about which state was tested.

Parallel implementation requires separately owned issues and isolated targets
whose relationship has been established before work begins. It is not created
implicitly by assigning different files from one issue to several agents.

Before handing the target to verification, the writer must record enough state
to identify the complete result. For a commit or pull request this includes the
base and exact commit. For an uncommitted working tree it includes the base
revision, branch, complete status, and a reproducible content identity. That
identity must cover the complete binary-safe tracked patch, staged changes,
deletions, file modes, and a cryptographic hash and path for every untracked
file in the proposed result. Record the method and use it again when checking
whether later evidence still applies.

## Verify and review the same final state

An independent verifier must inspect the complete proposed result and the
original requirements. The verifier must map every completion condition the
change claims and every material changed area to direct evidence, inspect test
meaning, and confirm the applicable configured checks under `tabgrad-verify`.
When a research artifact or lasting document is an intentionally bounded part
of an unfinished research issue, the verifier and reviewer must also identify
the remaining conditions and confirm that the change neither claims nor
contradicts them.

Use additional specialists when the change has distinct material concerns,
such as compatibility, documentation, security, dependencies, performance, or
separate execution environments. Divide assignments by clear concerns or
paths, state who covers each requirement, and identify anything no agent
covered. Do not choose a fixed number of agents or ask several agents to repeat
an undifferentiated review.

Subagent inspection does not replace commands enforced by the repository. A
passing test does not replace inspection of whether that test detects the
claimed behavior. Do not run stateful checks concurrently when they can share
files, caches, ports, devices, accounts, or other external state.

The independent review must examine the same final content and verification
evidence. Verification establishes reproducible facts about the change;
review looks for incorrect reasoning, missing cases, unintended consequences,
and maintainability risks. Neither activity substitutes for the other.

One agent that is independent of the writer may perform both verification and
review for the same proposed state when no distinct material concern requires
a specialist. The assignment and report must keep the two responsibilities and
conclusions separate. Commands and primary evidence are gathered once and may
be used by both conclusions; combining the assignment does not permit review to
be omitted or verification to become a reviewer's unsupported judgment.

Review must use current verification evidence instead of repeating successful
mechanical checks by default. A reviewer runs a focused check only to
investigate a concrete finding, missing evidence, stale result, or material
uncertainty, and records that reason. A later merge check likewise reuses
current independent verification and review evidence for the exact pull
request head. It needs a fresh independent assignment only when merge-readiness
coverage is absent, stale, contradicted, or insufficient for a newly identified
material risk. The merge coordinator must still inspect the live pull request,
head, required checks, review state, authorization, and branch safety
immediately before the mutation.

## Invalidate stale evidence

Any edit after a check may invalidate its result. Record the new target and
rerun every verification or review whose inputs, assumptions, generated
outputs, or conclusions may have changed. When the effect cannot be bounded
reliably, repeat the complete check.

Do not combine results from different commits or working-tree states into one
passing report. A reviewer or verifier may resolve an earlier finding only
after inspecting the correction and the resulting complete state.

## Classify findings without expanding the work

The coordinating agent must classify every material finding before deciding
what happens next:

- A problem caused by the current change belongs in the same work and must be
  corrected and covered by evidence before it can continue.
- A pre-existing problem that prevents the required result blocks the affected
  work and must be recorded with the condition needed to resume.
- A pre-existing problem that does not block the result remains outside the
  current change and is reported as possible separate work.
- A finding that changes scope, public behavior, compatibility, architecture,
  security, privacy, or another accepted constraint requires the appropriate
  user decision before dependent work continues.
- A possible vulnerability or private-data exposure follows the private
  handling rules in `CONTRIBUTING.md` and must not be published in an ordinary
  report or issue.

A subagent may recommend that separate work be considered, but it must not
create an issue or change a relationship. Before a follow-up issue is drafted
for publication, use `tabgrad-issue` to search for duplicates and establish
the correct scope and relationship. Creating or changing GitHub work still
requires current user authority.

## Stop when required independence is unavailable

If the required preflight agent is unavailable, do not begin a substantive
agent-authored repository change. If independent verification or review is
unavailable afterward, preserve the work and report the missing check, but do
not describe it as complete, ready for review, or ready to merge.

A failed or incomplete subagent run is evidence of missing coverage, not
permission for the coordinating agent to impersonate an independent result.
Retry only when the failure is understood and another attempt is authorized by
the same task and safe for the environment.

If substantive edits began without the required preflight, stop writing and
preserve the work. Do not describe a later inspection of the edited state as a
preflight. When the original base can be reconstructed safely in an isolated
workspace, give that state and the original issue to an independent
investigator, then compare its evidence with the preserved work. When the base
cannot be reconstructed, report the missing evidence and do not claim the
implementation is complete. Do not discard or restart work without authority.

## Report coordinated work

The final report must identify the exact target, the writer, every independent
assignment, the evidence each agent produced, disagreements and their
resolution, checks run, unavailable coverage, findings and their
classification, and every repository or external mutation performed. It must
distinguish completed work from proposed follow-up actions.
