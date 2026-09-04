# Reviewing coding-agent instructions

This document defines how Tabgrad reviews changes to `AGENTS.md`, repository
skills, and the project rules that those skills apply. The review uses bounded
reasoning over the actual instructions. It does not run AI models through a
catalogue of simulated scenarios.

## Review the change that was made

Begin with the complete proposed change and identify which agent decisions it
can alter. Read the changed instruction, its primary project rule, its direct
callers and references, and the adjacent skills with which it hands work off.
Do not load every skill or every project document unless a concrete reference,
shared rule, contradiction, or risk requires that expansion.

The author checks the instruction while writing it. A substantive change also
requires one independent read-only reviewer. Add another reviewer only when a
distinct concern, such as security or release authority, needs expertise that
the first review does not cover.

## Reason through representative decisions

Reason through the situations that the changed instruction is intended to
govern. Include the ordinary path and the nearby cases that are most likely to
change the decision. Check, when applicable:

- what evidence the agent must inspect before acting;
- what authority permits local edits and what requires separate approval;
- what happens when information, an issue, a dependency, or an independent
  reviewer is missing;
- where the procedure stops and what it reports to the user;
- how work passes to another skill without duplicating or losing a rule;
- how later edits invalidate earlier verification or review evidence; and
- whether an unexpected bug, security concern, or unrelated finding stays
  within the authorized scope.

This is a reasoning exercise, not a scripted role-play. Record the conclusion
and the evidence that supports it. Do not manufacture transcripts, expected
phrases, pass rates, or claims about model behavior.

## Check the instruction as part of the whole

Confirm that the change has one authoritative source and that other files link
to it instead of restating it. Check for contradictory permissions, circular
handoffs, unreachable requirements, duplicated procedures, ambiguous stopping
conditions, and instructions that require unavailable tools or evidence.

Use plain established terminology. Remove detail that does not change an
agent's decision. Preserve judgment where several safe approaches are valid,
and use absolute steps only for permissions, safety, integrity, or another
failure mode that justifies them.

Repository validation should continue to check deterministic properties such
as required files, valid frontmatter, installed-skill routing, active links,
and configured commands. Do not turn a judgment about instruction quality into
a brittle text search merely to automate it.

## Record the result briefly

Record the review in the authorized issue, pull request, or conversation. State
the files and interactions inspected, each material finding with its location
and effect, the corrections made, and any limit that prevents a conclusion.
Classify the reasoned review as complete only when every material finding is
resolved and the reviewer has inspected the resulting final state.

A reasoned review supports a decision about instruction quality. It does not
prove that every model will behave identically, and it must not be reported as
an empirical behavioral test.
