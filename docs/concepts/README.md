# Concepts

This perspective explains the stable ideas a reader must understand before
reasoning about a particular implementation. It is for readers who need the
meaning of an abstraction, the distinctions around it, and the relationships
that remain true when implementation details change.

## Start with browser Python

[Python in the browser](python-in-the-browser.md) introduces Pyodide and the
difference between executing a language and executing tensor operations. It
assumes programming experience, not familiarity with browser interpreters.
The chapter leads into the integration architecture and its lifecycle flow.

## Questions this perspective answers

Concept documentation answers questions such as:

- What does a term or abstraction mean in Tabgrad?
- Why is it distinct from a related idea?
- Which relationships and invariants define it?
- What consequences follow from that meaning?

It does not assign an implementation responsibility, narrate an end-to-end
interaction, or state an exact supported interface. Those questions belong to
the component, flow, and reference perspectives.

## What belongs here

A concept deserves its own document when contributors or users need the same
semantic explanation in several contexts and a local code comment or API entry
cannot communicate it reliably. The document should provide enough motivation
to explain why the distinction exists, define the idea in plain language,
relate it to nearby concepts, and state the invariants or edge conditions that
are part of its meaning.

Examples may clarify an established concept, but they must not imply support
beyond the public evidence. Physical ownership, source organization, callable
signatures, and chronological execution belong in their corresponding primary
sources.

## Relationship to the other perspectives

- [Architecture](../architecture/README.md) explains why lasting system
  boundaries and constraints exist.
- [Components](../components/README.md) explains which concrete owner preserves
  a responsibility or contract.
- [Flows](../flows/README.md) explains how several owners collaborate over
  time.
- [Reference](../reference/README.md) records exact contracts and supported
  behavior for lookup.

## Adding concept documentation

Define the reader question before creating a page. Keep one primary source for
the concept, link to it where another perspective needs context, and avoid a
page for every type or identifier. Add the page only when the concept itself is
established and the explanation is useful without relying on implementation
plans.
