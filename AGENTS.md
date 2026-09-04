# Tabgrad instructions

Read `README.md` to understand the purpose and public identity of Tabgrad.

Follow `CONTRIBUTING.md` whenever you create, modify, review, or verify
repository work.

Read the relevant documentation under `docs/` before changing behavior,
public APIs, compatibility guarantees, or architecture.

Keep project identity and normative documentation independent of implementation
phase or roadmap status. Apply the durable-document and work-tracking boundary
defined in `docs/documentation.md`.

Use `docs/README.md` to find the primary source for each project rule. Do not
create a competing rule in a skill or another document.

Before running a repository Python command, use the prepared virtual
environment defined in `docs/development.md`. Do not fall back to a global
interpreter when that environment is missing or incomplete. Repository setup
and dependency installation require the authority described there.

Apply the GitHub access diagnosis in `docs/development.md` before treating a
CLI failure as an invalid credential. A command that ran without required
network access cannot establish an authentication failure. Do not open a
browser or change stored credentials without the evidence and authority that
document requires.

Follow `docs/agent-instruction-review.md` when `AGENTS.md`, a repository skill,
or a project rule applied by a skill changes. Use its bounded reasoned review;
do not create or run a catalogue of model-behavior scenarios.

Read and follow `docs/agent-workflow.md` before a coding agent begins a
substantive repository change or delegates work to a subagent. Its independent
preflight, single-writer, final-state verification, and evidence rules are
required parts of the applicable skills.

Classify overlap with active issues, branches, and pull requests before
performing work concurrently. Follow `docs/agent-workflow.md` to keep
independent work parallel and to serialize work whose result or evidence can be
invalidated by another change.

Define the inspection and work boundaries before loading broad repository
context. Do not inspect the whole repository by default. Read the complete
proposed change and only the surrounding code, tests, documentation, history,
and external sources that evidence shows are relevant. Give every subagent a
bounded question, path or concern, and stopping condition under
`docs/agent-workflow.md`.

## Required skills

Use the repository skill that corresponds to the work being performed:

- Use `$tabgrad-start <issue-number>` only when the user explicitly invokes it
  to begin or resume an existing issue through every applicable skill.
- Use `$tabgrad-issue` to create or refine an issue.
- Use `$tabgrad-research` for a research issue or project experiment.
- Use `$tabgrad-architecture` in addition to `$tabgrad-research` when the
  result may establish or change a lasting architectural decision.
- Use `$tabgrad-implement` to implement an approved issue.
- Use `$tabgrad-verify` before reporting that repository work is complete.
- Use `$tabgrad-pull-request` to prepare, open, update, or mark a pull request
  ready for review.
- Use `$tabgrad-review` to review a proposed change.
- Use `$tabgrad-merge` to merge a reviewed and verified pull request and check
  its post-merge state.
- Use `$tabgrad-maintenance` when auditing duplication, complexity, obsolete
  code, or other technical debt.

Use every skill that applies when a task crosses more than one of these
activities.

Do not replace a required skill with an improvised procedure. If a required
skill or referenced document is missing or cannot be read, explain the problem
instead of pretending that its requirements were satisfied.
