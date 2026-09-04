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
