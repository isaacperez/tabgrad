# Reference

This perspective provides exact contracts for lookup. It is for readers who
already know which interface, record, command, or term they need and want its
accepted form and scope without following a complete design narrative.

## Questions this perspective answers

Use [Python host attachment and worker connection](python-host.md) for the
application's loading, entry, connection and cleanup contracts.

Use [Python tensor creation, metadata, addition and observation](python-tensors.md) for the
bounded Python call forms, metadata objects, errors and ownership obligations.

Use [Contiguous tensor views](tensor-view.md) for Python and JavaScript shape
syntax, inference, shared-storage lifetime, errors and operation limits.

Use [Total tensor sum](tensor-sum.md) for reduction signatures, scalar results,
floating-point accumulation, empty inputs, numerical comparison and CPU limits.

Use [Elementwise tensor multiplication](tensor-multiplication.md) for tensor
product signatures, equal-shape inputs, numerical behavior and CPU limits.

For contributor measurements, use
[WebAssembly addition measurements](webassembly-addition-measurements.md) for
the direct JavaScript path and resident CPU kernel, or
[Python tensor boundary measurements](python-boundary-measurements.md) for
baseline configuration and equivalent JavaScript/Python workloads. These are
command references; the shared [performance policy](../performance.md) owns
the rules for interpreting and preserving evidence.

Reference documentation answers questions such as:

- What exact name, signature, value, layout, or command applies?
- Which inputs, outputs, errors, and capability conditions form the contract?
- Is the contract public, contributor-facing, or internal?
- Which version or evidence bounds a support statement?

It records what a reader may rely on. It does not own design rationale,
implementation progress, or an unverified example.

## What belongs here

Reference material may describe a supported public interface, a maintained
internal boundary, a compatibility record, a reproducible contributor
command, a registered artifact contract, or defined terminology. Every entry
identifies its audience and the source that governs it.

A public reference describes behavior applications may rely on. An internal
reference describes a maintained boundary between owners and changes together
with its governing architecture and consumers. Neither kind turns an intended
capability into supported behavior without the required evidence.

## Relationship to the other perspectives

- [Architecture](../architecture/README.md) provides design rationale.
- [Concepts](../concepts/README.md) explains meaning and semantic
  relationships.
- [Components](../components/README.md) explains ownership and lifecycle.
- [Flows](../flows/README.md) explains how exact contracts participate in a
  larger interaction.

The project-wide [source registry](../README.md#sources-of-truth) identifies
the primary source for each established contract.

## Adding reference documentation

Use stable names and state the complete contract, scope, errors, version or
capability conditions, and evidence appropriate to its audience. Verify every
example and avoid implying broader support than the authoritative
compatibility record. Add reference material only when there is an exact,
maintained fact to record.
