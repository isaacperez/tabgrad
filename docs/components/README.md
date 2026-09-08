# Components

This perspective explains the concrete internal owners that cooperate to
implement Tabgrad. It is for contributors who need to know where a
responsibility lives, which boundary other code may depend on, and which
lifecycle or cost must be preserved.

## Questions this perspective answers

Component documentation answers questions such as:

- Which owner is responsible for a behavior or decision?
- What may enter or leave its boundary?
- Which state and resources does it own, borrow, or release?
- How does it report failure and interact with concurrent work?
- Which material costs cross its boundary?

A component is not synonymous with a directory, source file, class, or
architectural noun. Ordinary private mechanics remain beside the code.

## What belongs here

Component-level documentation is warranted when an owner has a contract that
crosses modules, a lifecycle another owner must respect, a failure or resource
boundary that must remain visible, or a supported extension point. A component
document identifies the responsibility and its limits, inputs and outputs,
owned state, lifetime, failure behavior, concurrency boundary, material data
movement or cost, and dependencies on other owners.

Do not create a page merely because a class or file exists. Do not mirror the
source tree or describe an anticipated owner whose contract has not been
established by the implementation and governing architecture.

## Relationship to the other perspectives

- [Architecture](../architecture/README.md) explains why the broader division
  of responsibilities exists.
- [Concepts](../concepts/README.md) defines shared meanings used by component
  contracts.
- [Flows](../flows/README.md) follows collaboration that crosses component
  boundaries.
- [Reference](../reference/README.md) records the exact maintained contract at
  a boundary when lookup documentation is justified.

## Adding component documentation

Create a component page only when its boundary matters outside one local
implementation. Link semantic terms to their primary concept and multi-owner
sequences to their primary flow instead of repeating them. Keep the document
aligned with implemented ownership without turning implementation progress
into durable prose.
