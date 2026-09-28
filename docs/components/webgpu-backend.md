# WebGPU physical execution owner

A tensor's logical identity is not a GPU buffer. The runtime owns the former:
shape, operation dependencies, views and public lifetime. The WebGPU backend
owns the latter: an acquired device, opaque allocations, prepared pipelines,
submission and readback. Keeping those responsibilities separate lets one
semantic graph use the same formation and observation machinery as CPU work.

The accepted [integration architecture](../architecture/webgpu-integration.md)
governs this division. The concrete boundaries are
[`ExecutionBackend`](../../src/backend.ts),
[`WebGpuBackend`](../../src/webgpu-backend.ts) and the
[common request owner](runtime-observation.md). The backend is internal, not a
public plugin interface or another semantic engine.

## What crosses the boundary

The runtime consults immutable backend capabilities during operation admission.
These describe computation kinds, gradient support and maximum tensor extent.
Preparation validates the same computation domain; it does not reinterpret
an unsupported operation or select a fallback implementation.

Execution receives an immutable program, separate bindings and fresh retention
obligations. Programs contain shape, logical slots, canonical storage slots and
use counts, not buffers. Bindings supply owned host arrays or opaque resident
identities. Returned allocations remain interpreted and released by their
recorded backend owner; the runtime never casts a GPU identity into a CPU
offset. The session's materialization association records that owner.

CPU execution can return a value directly. Asynchronous physical work returns
an `ExecutionTicket` with a logical `result` and an independently accounted
`drained` signal. The common request uses those two signals without imposing a
Promise allocation on a prepared synchronous CPU call.

## Storage inside one invocation

Host bindings are uploaded once when they become resident. Existing resident
bindings are borrowed, not overwritten or put into the invocation's scratch
pool. Each numerical output has distinct storage from its live operands.
Whole-storage views reuse their canonical storage slot without a numerical
dispatch.

After the final encoded use of a disposable intermediate, its buffer can serve
a later same-sized output in the same ordered command stream. Program storage
use counts include repeated input positions; runtime retention protects owners
outside that internal use graph. This is invocation-local reuse, not a
persistent allocator cache. Retained outputs survive in the materialization
table, while scratch allocations are destroyed after the submission drains.

For a fixed-width chain whose intermediate handles are closed, numerical
scratch storage is bounded independently of chain depth. Executable metadata
and encoded work still grow with the selected operations. Keeping every
intermediate handle deliberately changes the storage obligation; the backend
must not treat that retention as disposable scratch.

## Pipeline and readback lifetimes

The acquired device is ready before the factory returns, but a compute pipeline
is prepared only when numerical execution first needs it. Preparation is shared
within that backend owner. The numerical implementation and its precision
constraints are defined in the
[addition decision](../architecture/webgpu-float32-addition.md), not in the
runtime's generic dispatch policy.

Readback uses a dedicated staging allocation: encode a copy, submit it, map
the staging bytes, copy them into an independent host array and unmap. The
staging allocation and source remain protected through both queue completion
and the mapping continuation. A mapping error can become observable before
those physical obligations are finished.

Error scopes capture validation, allocation and internal device failures.
Rejected browser promises retain their cause. An upload is itself queued work:
failure while creating a subsequent command does not make an earlier
`writeBuffer` safe to destroy immediately. The backend's cleanup joins all work
that actually started, whether a logical result succeeded or failed.

## Loss, release and extension boundaries

Device loss retires this physical owner and wakes its pending logical waiters.
Every continuation checks availability before publishing state. Physical bytes
whose completion is unknown remain explicitly accounted for, even after
terminal destruction of JavaScript buffer handles. CPU owns an independent
context and is not retired by GPU loss.

This backend supports no replacement generation or transfer route. Adding a
computation requires its backend capability, numerical implementation and
encoding, together with contract tests and qualification. It does not require
another tensor graph, observation queue or frontend support table. Extending
layouts or device transfers would require their accepted contracts; arbitrary
buffer reuse or implicit copying must not be smuggled into an operator kernel.

Exact diagnostics and public limits are in the
[WebGPU runtime reference](../reference/webgpu-runtime.md). Allocation accounting
and structural bounds do not replace measured latency, memory peaks or
browser/adapter qualification.
