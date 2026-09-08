# Flows

This perspective follows one event or unit of work across several owners. It
is for readers who understand the participants individually but need to see
their ordering, control and data movement, observation points, errors, and
resource-release obligations as one coherent sequence.

A flow is not another execution layer. It connects contracts owned elsewhere
and links back to those primary sources rather than restating every
participant's complete design.

## Questions this perspective answers

Flow documentation answers questions such as:

- What event starts this collaboration, and what marks its completion?
- Which owners participate, and in what order?
- Which state, data, or control signal crosses each boundary?
- Where can work wait, fail, be cancelled, or become observable?
- When can each participant release its resources safely?

## What belongs here

A flow document is justified when correctness or understanding depends on the
interaction of several independently owned contracts. It states one clear
initiating event and one completion or failure boundary, names every
participant, and makes relevant asynchronous ordering, errors, cancellation,
and resource release visible.

Use a sequence or flow diagram when it makes those relationships easier to
understand, accompanied by prose that explains the normal path and material
failure paths. Keep component-local algorithms and the complete definition of
each shared concept in their own primary sources.

## Relationship to the other perspectives

- [Architecture](../architecture/README.md) explains why the participating
  boundaries exist.
- [Concepts](../concepts/README.md) explains the meaning of entities carried
  through the flow.
- [Components](../components/README.md) explains what each participant owns.
- [Reference](../reference/README.md) records exact contracts used at the
  boundaries.

## Adding flow documentation

Create a flow page only after its participants and boundaries are established.
Do not reserve pages for anticipated sequences, and do not create a flow for
steps that remain wholly inside one owner.
