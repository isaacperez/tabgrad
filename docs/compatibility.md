# Compatibility and public API support

This document defines how Tabgrad records compatibility with PyTorch and the
support boundaries of its public Python and JavaScript interfaces. A
compatibility record describes a named release and evidence, not implementation
progress or a product roadmap.

## Meaning of compatibility

Tabgrad is an independent implementation. A compatible operation must match
the referenced PyTorch behavior for every dimension claimed in its entry,
including the applicable signature, values, shapes, data types, broadcasting,
views and aliasing, gradients, devices, errors, and state changes.

Compatibility is bounded by a named PyTorch version or documentation revision,
specified inputs, and tested environments. Passing a few examples does not
establish general compatibility. Differences must be explicit and must not be
hidden behind silent fallback behavior.

Use these statuses:

| Status | Meaning |
| --- | --- |
| `Supported` | The documented scope is implemented and verified on every environment and dimension listed in the entry. |
| `Partially supported` | A precisely stated subset is implemented and verified; the missing or different behavior is listed. |
| `Unsupported` | Tabgrad deliberately does not provide the behavior and rejects it clearly. |
| `Unavailable` | The named release does not provide the behavior and makes no compatibility claim for it. |
| `Not evaluated` | An implementation may exist, but the evidence is insufficient to make a compatibility claim. |

Do not use `Supported` for proposed behavior, an unmerged change, a backend
that was not tested, or an implementation that silently uses another backend.

## Required operation record

Each public operation or coherent API group in a release must record:

- its public Python and JavaScript names and supported signatures;
- the reference PyTorch version, documentation, and observed oracle behavior;
- the overall status and exact supported subset;
- supported CPU and WebGPU behavior, including any explicit backend limits;
- supported data types, shapes, layouts, devices, and view or aliasing rules;
- autograd support, differentiability limits, and higher-order behavior;
- errors and unsupported inputs;
- intentional differences and the reason they exist;
- tests and environments that establish the claim; and
- the release in which the support became public or changed.

Use separate rows when overloads or backends have meaningfully different
support. A generated matrix may replace hand-maintained rows only after its
source and generation procedure are registered in
[`generated-files.md`](generated-files.md).

## Establish a compatibility claim

Use official PyTorch documentation and reproducible behavior from a named
official PyTorch release. Documentation establishes the public contract;
oracle tests help clarify behavior that the documentation leaves incomplete.
Do not copy PyTorch source code into Tabgrad merely because it was inspected.

Define representative valid inputs, boundaries, invalid inputs, data types,
devices, gradients, and tolerances before interpreting results. Run the
Tabgrad and PyTorch sides in controlled environments and preserve versions,
commands, inputs, and raw differences. Explain every exclusion.

The CPU backend may serve as Tabgrad's reference for WebGPU after CPU behavior
has independent compatibility evidence. Agreement between two Tabgrad
backends is not by itself evidence of agreement with PyTorch.

## Change or remove supported behavior

A change to a supported public signature, result, error, data type, gradient,
device, serialization form, or backend guarantee is a compatibility change.
Classify whether it corrects an erroneous claim, adds compatible behavior, or
breaks supported user code.

Breaking changes require `concern: breaking-change`, an explicit decision,
migration guidance, release notes, and the version change defined in
[`releases.md`](releases.md). Deprecation must state the replacement, first
deprecated release, planned removal boundary, warning behavior, and migration
path. Do not silently remove a compatibility claim by deleting its row.

A correction that brings Tabgrad into agreement with the already documented
reference can still affect users who relied on the defect. Record that effect
and provide migration guidance when it is material.

Update implementation, tests, API documentation, examples, the applicable
release record, and release information together. Use the narrowest status
supported by the recorded evidence.
