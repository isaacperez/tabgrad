# Reference

This perspective provides exact contracts for lookup. It is for readers who
already know which interface, record, command, or term they need and want its
accepted form and scope without following a complete design narrative.

## Questions this perspective answers

Use [JavaScript tensor API](../javascript-api.md) for the direct session and
tensor interface, observation and explicit resource cleanup.

Use [Basic SGD](sgd.md) for Python and JavaScript optimizer calls, parameter
groups, numerical reset, ordered updates and host ownership.

Use [Compatibility and public API support](../compatibility.md) for the meaning
and scope of support records, the evidence they require and explicit
differences from the reference behavior.

For a reminder of a term already introduced in the design guide, use the
[Architecture glossary](../architecture/glossary.md). It complements the
explanations in each architecture chapter rather than replacing them.

Use [Direct JavaScript WebGPU runtime](webgpu-runtime.md) for ready-session
acquisition, device selection, operation limits, lifecycle and GPU diagnostics.

Use [Python host attachment and worker connection](python-host.md) for the
application's loading, entry, connection and cleanup contracts.

Use [Browser package installation](browser-package.md) for inspected tarballs,
public entries, matched static files and the executable JavaScript example.

Use [Qualifying a browser package](package-qualification.md) for admitted local
archives or exact registry installations, shared consumers and JSON reports.

Use [Verifying retained producer proofs](package-provenance.md) for offline
signature, identity, claim and original-candidate verification under admitted trust.

Use [Release record tooling](release-record.md) for enrolled Git history,
bounded event data, exact intent/observation relationships and recorder commands.

Use [Acquisition control record](provenance-acquisition-record.md) for the internal
experimental JSONL profile, independent file reserves, confirmed prefixes and
bounded local readback, separate from trust admission and producer proofs.

Use [Local acquisition coordination](provenance-acquisition-control.md) for
separate actor states, exact action confirmations, irreversible revocation and
the experimental ordinary-file session, distinct from external supervision.

Use [Acquisition coordination across local processes](provenance-acquisition-process.md)
for the experimental two-actor launcher, closed IPC, peer observations and
failure-preserving direct-child cleanup, separate from physical containment.

Use [Experimental Linux acquisition host control](provenance-acquisition-host.md)
for prepared group identities, direct controller routes, an external deadline
entry and conservative native observations, distinct from host qualification.

Use [Experimental acquisition startup](provenance-acquisition-startup.md) for
explicit pre-case self-entry, the three-control local gate, guard-channel
correlation and separate record/guard cleanup over prepared premises.

Use [Experimental binary acquisition capture](provenance-acquisition-capture.md)
for the finite non-TTY framing subset, separate payload reservations, confirmed
prefixes and incomplete outcomes, without transport or client admission.

Use [Experimental raw acquisition payload writer](provenance-acquisition-payload.md)
for independent raw stdout/stderr writes, shared clock history, confirmed
prefixes and owned-handle cleanup without framing or upstream admission.

Use [Experimental Docker Exec acquisition](provenance-acquisition-exec.md) for
one local request sequence, raw daemon-channel capture and observed startup/
cleanup composition, separate from process provenance and admission.

Use [Experimental acquisition program launcher](provenance-acquisition-launch.md)
for the canonical program/profile binding, bounded separate control channel and
single nonprivileged attempt over independently prepared endpoints.

Use [Experimental acquisition FIFO transport](provenance-acquisition-fifo.md)
for independent host-view readers, sentinel release, borrowed prefix delivery
and conservative local waiting over existing identified endpoints.

Use [Experimental local program capture](provenance-acquisition-capture-attempt.md)
for nine-file admission, original control persistence and FIFO/Exec coordination
under borrowed permission, with startup and global acquisition kept by the caller.

Use [Experimental local acquisition attempt](provenance-acquisition-attempt.md)
for startup/capture ordering and their conservative local join, retaining
original results without physical observation, custody or release admission.

Use [Python tensor creation, metadata, addition and observation](python-tensors.md) for the
bounded Python call forms, metadata objects, errors and ownership obligations.

Use [Contiguous tensor views](tensor-view.md) for Python and JavaScript shape
syntax, inference, shared-storage lifetime, errors and operation limits.

Use [Total tensor sum](tensor-sum.md) for reduction signatures, scalar results,
floating-point accumulation, empty inputs, numerical comparison and CPU limits.

Use [Elementwise tensor multiplication](tensor-multiplication.md) for tensor
product signatures, equal-shape inputs, numerical behavior and CPU limits.

Use [Two-dimensional matrix products](tensor-matmul.md) for contraction geometry,
sequential FMA, CPU/GPU calls, both first-order derivatives and exclusions.

Use [Functional first-order gradients](functional-gradients.md) for tracked
creation, seed and input forms, saved-history consumption, errors and limits.

Use [Backward and persistent gradients](backward-gradients.md) for backward
calls, gradient identity, accumulation, retention, reset and lifetime.

Use [Persistent tensor copy](tensor-copy.md) for identity-preserving updates,
recording, alias versions, derivative guards and deferred failure.

Use [Gradient recording scopes](gradient-recording.md) for Python `no_grad`,
JavaScript callbacks, shared mode restoration and special-view tracking.

For contributor measurements, use
[WebAssembly addition measurements](webassembly-addition-measurements.md) for
the direct JavaScript path and resident CPU kernel, or
[Python tensor boundary measurements](python-boundary-measurements.md) for
baseline configuration and equivalent JavaScript/Python workloads. These are
complemented by [WebGPU resource measurements](webgpu-measurements.md), which
separate setup, upload, resident execution, readback and retention. They are
command references; the shared [performance policy](../performance.md) owns
the rules for interpreting and preserving evidence.

[Managed Python and direct JavaScript GPU boundary measurements](python-webgpu-measurements.md)
adds the shared-connection comparison, with representative payload/depth
variation and explicit limits on what its wall clocks and owned counters mean.

For contributor browser checks, use
[Browser qualification diagnostics](browser-diagnostics.md) to interpret
incoming traffic, registered progress, failure-time process/profile observations
and final cleanup without overclaiming what a timeout proves.

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
