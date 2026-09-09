# Tabgrad project documentation

This directory contains the durable technical and project rules for Tabgrad.
An issue records why a particular piece of work is needed. A pull request
records a proposed change and its evidence. The documents listed here describe
the product contract and rules that all work must follow.

## Choose a technical perspective

The same library can be understood through different questions. Choose the
perspective that matches the question you are trying to answer:

| Reader question | Start here |
| --- | --- |
| Why does the system have these boundaries and constraints? | [Architecture](architecture/README.md) |
| What does a shared abstraction mean? | [Concepts](concepts/README.md) |
| Which internal owner is responsible, and what contract does it preserve? | [Components](components/README.md) |
| How does work pass through several owners from request to completion? | [Flows](flows/README.md) |
| What exact API, support claim, binary interface, command, or term applies? | [Reference](reference/README.md) |

These perspectives are navigation aids over one body of knowledge, not
competing sources of truth. The [documentation policy](documentation.md#navigate-technical-documentation-by-reader-question)
defines how a fact receives one primary home and how the other perspectives
refer to it.

## Sources of truth

Each subject has one primary source. Other documents may summarize a rule and
link to its primary source, but they must not create a competing version.

| Subject | Primary source |
| --- | --- |
| Project identity and public purpose | [`README.md`](../README.md) |
| Central execution architecture and ownership boundaries | [`architecture/README.md`](architecture/README.md) |
| Python interpreter attachment, bridge ownership, and integration constraints | [`architecture/python-integration.md`](architecture/python-integration.md) |
| WebAssembly CPU kernel language, binary interface, modules, and memory ownership | [`architecture/webassembly-cpu-backend.md`](architecture/webassembly-cpu-backend.md) |
| Contribution workflow | [`CONTRIBUTING.md`](../CONTRIBUTING.md) |
| Integrated implementation workflow and reading guide | [`implementation-workflow.md`](implementation-workflow.md) |
| Issues, labels, project fields, and milestones | [`project-management.md`](project-management.md) |
| Agent delegation and independent checks | [`agent-workflow.md`](agent-workflow.md) |
| Unexpected findings, blockers, and pending decisions | [`CONTRIBUTING.md`](../CONTRIBUTING.md#handling-unexpected-findings-and-pending-decisions) |
| Branches, worktrees, commits, and merge history | [`version-control.md`](version-control.md) |
| Code style, design quality, abstractions, and root-cause corrections | [`quality.md`](quality.md) |
| Test-driven development for distributed production behavior | [`quality.md`](quality.md#develop-production-behavior-test-first) |
| Tests and repository quality checks | [`quality.md`](quality.md#select-checks-from-the-affected-risks) |
| Refactoring, duplication, and technical debt | [`quality.md`](quality.md#review-code-quality-without-speculative-redesign) |
| Security and private vulnerability reporting | [`SECURITY.md`](../SECURITY.md) |
| Dependencies, licenses, and third-party code | [`dependencies.md`](dependencies.md) |
| PyTorch compatibility and public API support | [`compatibility.md`](compatibility.md) |
| Direct JavaScript API | [`javascript-api.md`](javascript-api.md) |
| Documentation structure and writing rules | [`documentation.md`](documentation.md) |
| Technical documentation perspectives and placement | [`documentation.md`](documentation.md#navigate-technical-documentation-by-reader-question) |
| Development environment and commands | [`development.md`](development.md) |
| Generated files and their source files | [`generated-files.md`](generated-files.md) |
| Performance and resource measurements | [`performance.md`](performance.md) |
| Versions, releases, migrations, and release notes | [`releases.md`](releases.md) |
| Coding-agent instruction review | [`agent-instruction-review.md`](agent-instruction-review.md) |
| Continuous integration and protected branches | [`continuous-integration.md`](continuous-integration.md) |

Repository skills define agent procedures that apply these primary sources;
they do not form competing policy sources. For example, the
`tabgrad-maintenance` skill applies the maintenance policy in `quality.md`.

## Resolving disagreement

When two sources appear to disagree, first determine whether they govern
different subjects or different states. If they genuinely contradict each
other, stop the affected work and correct the sources together. Do not choose
the more convenient rule silently.

Repository files and configured commands establish executable behavior. An
issue, example, or proposed architecture does not establish a compatibility or
release claim. Accepted architecture documentation establishes lasting design
constraints; versioned compatibility records establish the supported public
behavior of a release.

## Changing project rules

Change a rule in its primary source and update every template, skill, check,
and cross-reference that depends on it in the same work. Record migrations for
existing work when a changed rule cannot be applied prospectively without
leaving the repository inconsistent.
