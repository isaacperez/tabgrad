# Documentation

This document defines how Tabgrad documentation is organized, written,
verified, and kept current. Documentation is part of the behavior that the
project presents to users and contributors, not a summary added after the code
is finished.

## Write for a defined reader

Identify who needs the document, what they are trying to understand or do, and
which knowledge they can reasonably be expected to have. Give a new reader the
context needed to understand why a rule, interface, or component exists before
introducing its details.

Clarity is the priority because readers use the documentation to make
decisions. Write plain prose in complete sentences. Each sentence should have
a clear subject and verb. Avoid telegraphic fragments, compressed chains of
nouns, unexplained abbreviations, unnecessary adjectives, and dense strings of
hyphenated modifiers.

Use standard, established terminology. Do not invent names, labels, stages,
codes, or bureaucratic ceremonies when an ordinary term already expresses the
idea. Define necessary technical terms on first use and use the same term for
the same concept throughout the repository.

Explain unfamiliar subjects as a teacher would. State the background,
mechanism, consequence, and practical meaning. Do not assume that the reader
knows a fact merely because it is familiar to the author.

## Develop explanations before compressing them

Explanatory chapters teach a reader how to reason about a subject. They need
room for motivation, mechanisms and consequences, not merely an inventory of
names or a table of contracts. Use sustained prose between diagrams, examples
and summaries so the reader can follow why one idea leads to the next. A long
chapter is appropriate when the subject needs that development; brevity is not
a reason to omit the reasoning that makes a correct statement understandable.

Begin with a defined reader and question. For introductory technical material,
the usual reader is a programmer familiar with functions, objects and ordinary
software abstractions, but unfamiliar with deep-learning runtime design or the
specific browser integration being explained. Do not reteach that reader basic
programming. Do explain domain-specific prerequisites, including the role and
limits of external technologies, before relying on them.

Develop the explanation in dependency order: establish the practical problem,
introduce the necessary concepts and participants, explain their mechanism,
and show its consequences through a representative situation. Introduce a
necessary term before using it in a diagram, comparison or failure analysis.
A glossary entry or a link does not repair an unexplained first use. When a
later topic must be mentioned early, provide a short plain-language preview
that makes the current paragraph understandable without following the link.

Choose an example whose prerequisites the reader already has. Walk through
what enters the system, what changes, which result is observable and why it
matters. Discuss the nearby failure or boundary case when it exposes an
important constraint. A catalogue of edge cases without the normal mechanism
is no more helpful than a happy path that hides its limits. Apply the example
verification rules below; conceptual illustrations must not resemble a
verified installation procedure or unsupported API promise.

Introduce each diagram's participants and explain what its arrows represent.
Follow it with the interpretation the reader should take away, including any
important distinction it omits. Diagrams support the argument; readers should
not have to infer that argument from labels. Use a table for a useful comparison
or lookup, not as a replacement for explaining unfamiliar alternatives.

Depth is proportional to the reader's task, not a minimum word count or a
mandatory section template. Exact reference entries may stay compact and link
to background. Small corrections need not generate an introductory chapter.
Conversely, an introductory chapter should not be reduced to a reference card.
Remove repetition and unrelated background, not necessary causal explanation.

Provide a reading path when several existing chapters serve different levels
of familiarity. State what a reader gains from each step and keep direct
access for readers who already know the prerequisites. This navigation belongs
in the existing indexes; it does not require a second folder hierarchy by
experience level. Brief local reminders are appropriate, while the complete
contract retains its single authoritative home.

## Put information in its authoritative place

Use [`docs/README.md`](README.md) to find the primary source for each subject.
Choose the document from the reader's need:

- The root `README.md` describes Tabgrad's complete identity, purpose,
  high-level execution model, and public entry points.
- `CONTRIBUTING.md` describes how to contribute and links detailed project
  policies.
- API documentation explains supported public interfaces with verified
  examples and errors.
- [`compatibility.md`](compatibility.md) records the exact support and
  compatibility claim.
- Architecture documentation records approved lasting decisions and the
  relationships contributors must preserve.
- Development documentation gives reproducible setup and command information.
- Issues contain the need, scope, investigation, and progress for bounded work.
- Pull requests contain the proposed diff and evidence for that diff.

Do not copy a full rule into several documents. Summarize only the part a
reader needs and link to the primary source. A code comment should explain a
local reason or invariant that the code cannot make clear; it is not a
replacement for public API or architecture documentation.

## Navigate technical documentation by reader question

Technical documentation offers several perspectives over one system. These
perspectives help a reader choose an entry point; they do not create separate
authorities for the same fact.

| Perspective | Dominant reader question | Included material | Excluded material |
| --- | --- | --- | --- |
| [Architecture](architecture/README.md) | Why does the system have these boundaries and constraints? | The system map, accepted responsibilities, cross-system invariants, and lasting decisions | Release support claims, source-file walkthroughs, and task instructions |
| [Concepts](concepts/README.md) | What does this abstraction mean independently of one implementation? | Semantic distinctions, terminology, relationships, and consequences that apply across components | Ownership details, exact APIs, and chronological execution traces |
| [Components](components/README.md) | Which internal owner is responsible, and what contract must it preserve? | Concrete owners, boundaries, lifetimes, failure behavior, and material costs that matter outside one local implementation | A page for every source file, class, helper, or hypothetical subsystem |
| [Flows](flows/README.md) | How do several owners collaborate from an initiating event to completion? | End-to-end control, data, error, and resource-lifetime sequences | A second copy of each participant's complete contract |
| [Reference](reference/README.md) | What exact contract or supported behavior can I look up? | Public APIs, compatibility records, internal binary interfaces, registered artifacts, commands, and defined terms | Design rationale, implementation progress, and unverified examples |

Place a document according to the dominant question its intended reader brings
to it. A document may mention another perspective when the explanation needs
context, but it must link to that perspective's primary source instead of
restating the complete fact. Record that source in [`docs/README.md`](README.md)
when contributors need an authoritative project-wide location.

Do not divide a cohesive document merely because some paragraphs can be viewed
from different perspectives. Divide it when its parts serve meaningfully
different audiences, own independent contracts, or change for independent
reasons. Move the primary content, source-of-truth registration, incoming
links, and necessary summaries together so that no transitional duplicate can
be mistaken for another authority.

Every perspective index must explain its audience, boundary, relationship to
the other perspectives, and admission criteria. When the perspective contains
topic pages, the index also provides the path through that substantive
material. Do not add empty topic lists, headings, or pages merely to reserve a
place for anticipated work. A task-oriented guide is justified by a verified
user or contributor task that needs a maintained procedure; the perspectives
above do not require an empty guide hierarchy.

## Separate durable documentation from work tracking

The root `README.md` and normative documents describe Tabgrad as a complete
product, its permanent constraints, and the procedures that apply throughout
the project. They must not narrate the project's implementation phase, list
missing components, reserve placeholders for later work, or promise that a
capability or check is to be added later.

Issues, pull requests, and project fields record work in progress, unanswered
questions, experiments, sequencing, and implementation status. `CHANGELOG.md`,
release notes, security advisories, and release-specific compatibility records
record historical or versioned facts. Configuration registers may identify
the exact dependencies, commands, generated outputs, or checks that govern a
repository revision, but they must not become roadmaps or inventories of
absent facilities.

Architecture research questions, hypotheses, experiments, and tentative
conclusions belong in research issues. Approved lasting decisions belong in
architecture documentation. Do not place a tentative design in a permanent
document merely to show what may be built.

Remove an obsolete instruction when its rule changes. Preserve a historical
decision only when it still explains an active constraint; otherwise
supersede it clearly and link the replacement record.

## Write and verify examples

An example must identify its environment, prerequisites, inputs, expected
result, and important limitation. Prefer the smallest example that demonstrates
the public behavior without relying on hidden setup.

Runnable examples must be exercised by an automated documentation or
integration check when the toolchain permits it. If the required automation is
absent, track that work in an issue and do not present the example as verified.
Do not show output copied from another runtime as though Tabgrad produced it.

For PyTorch-compatible examples, link the corresponding compatibility entry
and distinguish the official PyTorch reference from the Tabgrad result. For
WebGPU, CPU, browser, or Pyodide examples, state which environments were
actually checked.

## Update documentation with each change

Inspect every reader-visible consequence of a change. Update the same pull
request when it affects:

- public behavior, signatures, errors, examples, or compatibility;
- setup, commands, supported tools, browsers, backends, or environments;
- architecture, data flow, ownership, security, or privacy boundaries;
- dependencies, licenses, generated files, packaging, releases, or migration;
  or
- contributor rules, templates, automation, or coding-agent instructions.

When no documentation changes, explain why no reader-facing statement can
become inaccurate. Do not use a generic statement that documentation is
unaffected without inspecting the relevant sources.

### Make implementation details concrete when they become true

As code establishes a concrete design, document the facts another contributor
or user must preserve or rely on. Put each fact at the level that owns it:

- public signatures, behavior, errors, and examples belong in API
  documentation;
- verified PyTorch behavior and environmental coverage belong in the
  compatibility record;
- lasting system boundaries, cross-system invariants, and accepted technical
  decisions belong in architecture documentation;
- meanings and distinctions shared across implementations belong in concept
  documentation;
- concrete internal ownership, externally relevant contracts, lifetimes,
  failures, and material costs belong in component documentation;
- ordering, data movement, error propagation, and resource release across
  owners belong in flow documentation;
- exact maintained public or internal contracts belong in reference
  documentation;
- setup, commands, and required tool versions belong in development
  documentation; and
- local mechanisms and non-obvious implementation invariants belong beside
  the relevant type, function, module, or focused internal document.

Do not document a source file or class as an architectural component merely
because it exists. A concrete internal detail belongs in durable documentation
when readers outside its local implementation need it to preserve a contract,
understand a material lifetime or cost, or use a supported extension point.
Ordinary private mechanics should remain near the code.

Progress, missing behavior, sequencing, experiments, and tentative
implementation choices remain in issues, project items, and pull requests.
Do not create empty document sections for anticipated modules. The integrated
workflow for making documentation more concrete as implementation proceeds is
explained in
[`implementation-workflow.md`](implementation-workflow.md#make-documentation-concrete-with-the-implementation).

## Review documentation

Check facts against source, tests, configured behavior, accepted decisions, and
authoritative external documentation. Check that terminology and support
statuses agree across code, examples, compatibility records, release notes,
and issue or pull request claims.

Run the configured repository checker for links, formatting, required files,
policy structure, and common project-progress wording in durable documents.
The automated wording check protects known failure patterns; semantic review
is still responsible for equivalent phrasing and misplaced status information.
Review rendered Markdown when tables, nested lists, code blocks, anchors, or
images could be misleading. Check external links when they are material
evidence, while recognizing that availability can change after review.

A documentation review must also ask whether a new contributor can understand
the text without the conversation that produced it. Shorter text is useful
when it removes repetition, but it must not remove context required for a
correct decision.

Apply [the explanatory-depth rule](#develop-explanations-before-compressing-them)
from the stated reader's starting knowledge. Follow the actual reading path:
check whether each prerequisite is available before the text relies on it,
whether the prose explains why the mechanism exists, and whether the example
and diagram teach the same result. For substantive changes, the independent
review required by the agent workflow includes this editorial judgment as well
as technical accuracy. Material unexplained concepts, missing causal steps or
misleading examples are required corrections, even when automated checks pass.
Personal preferences about paragraph length or optional background are not.

Record the affected readers and questions, the primary documents changed, and
the review evidence in the issue or pull request. Do not introduce prose TDD,
word-count gates or simulated model scenarios to replace this judgment.
