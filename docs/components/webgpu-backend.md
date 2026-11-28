# WebGPU physical execution owner

A tensor's logical identity is not a GPU buffer. The runtime owns the former:
shape, operation dependencies, views and public lifetime. The WebGPU backend
owns the latter: an acquired device, opaque allocations, prepared pipelines,
submission and readback. Keeping those responsibilities separate lets one
semantic graph use the same formation and observation machinery as CPU work.

The accepted [integration architecture](../architecture/webgpu-integration.md)
governs this division. The concrete boundaries are
[`ExecutionBackend`](../../src/execution/backend.ts),
[`WebGpuBackend`](../../src/backends/webgpu/webgpu-backend.ts) and the
[common request owner](runtime-observation.md). The backend is internal, not a
public plugin interface or another semantic engine.

## What crosses the boundary

The runtime consults immutable backend capabilities during operation admission.
These describe computation kinds, tracking and first-order gradient support,
and maximum tensor extent. Persistent gradient state and update ordering
belong to the common runtime on CPU and WebGPU; their numerical work stays on
the selected device. The [backward](../reference/backward-gradients.md) and
[basic SGD](../reference/sgd.md) references define their support and limits.
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

### Elementwise kernel launch geometry

A workgroup is the set of shader invocations launched together. Dense addition and
multiplication each process one element per invocation along a single dimension,
so each launch width connects two physical facts: how many elements one group can
cover, and how many groups the host must dispatch for a given output. That
knowledge belongs to the kernel, not to tensor semantics or device acquisition.

[`kernels/addition.ts`](../../src/backends/webgpu/kernels/addition.ts) owns
`WEBGPU_ADDITION_WORKGROUP_SIZE`, with width 64;
[`kernels/multiplication.ts`](../../src/backends/webgpu/kernels/multiplication.ts)
owns its separate `WEBGPU_MULTIPLICATION_WORKGROUP_SIZE`, also 64. Each shader
uses its own constant in `@workgroup_size`.
[`kernels/expansion.ts`](../../src/backends/webgpu/kernels/expansion.ts) owns the
same-width unary scalar-copy launch for sum derivatives. It copies unsigned
stored words to a separate output, without floating-point arithmetic. The
physical kernel table uses those constants with an explicit index class
and span. The common linear planner derives launch geometry without using it
as a global tensor-storage bound.

For a nonempty dense output of `n` elements, dispatch uses `ceil(n / 64)` logical
groups. The
shader's output-length guard prevents surplus invocations in the final partial
group from accessing an element outside the output. Empty outputs encode no
compute pass. Storage admission and checked launch geometry are separate. A
larger linear
extent uses a checked grid with flattened indices and bounded padding; a
cooperative group returns uniformly before barriers when it is padding. The
[dispatch decision](../architecture/webgpu-dispatch.md) owns this separation.

Derivative programs use the same storage-use accounting and physical completion
as forward programs. Saved pins retain resident operands until common history
transfers them to derivative work. No backend derivative graph or persistent
gradient slot is introduced.

Binary addition and multiplication own their three storage bindings and
unsigned binary32 arithmetic. Another computation may own different geometry; this
operation-specific constant is not a runtime-wide launch policy or a kernel
registry. Changing its value would still require device-limit, dispatch and
numerical qualification, not just changing a shared declaration.

[Broadcast forward](../architecture/broadcasting.md) adds one immutable storage
parameter buffer. It specializes arithmetic by operation kind, while using
common coalesced address projection. Four adjacent values share an invocation
when the common inner run is divisible by four; otherwise each invocation
handles one value. Cache keys do not include rank or shape.

Receiving reduction shares the exact integer sum helpers. It derives ordered
group/term projections and uses private staged partials when terms exceed one
stage. Dispatch windows carry global group/chunk offsets in separately owned,
immutable uniforms. Tensor extent, parameter size, group-times-chunk products,
partial size and dispatch limits are checked independently. Parameters and
partials retire with the invocation's known drain; loss preserves unknown
completion accounting. They never become persistent tensor history or a
shape-keyed cache. Preparation validates every known capability before starting
compilation and attributes failures to the actual requesting program slot,
including cached compilation failures.

### Preparation and observation

The acquired device is ready before the factory returns, but a compute pipeline
is prepared only when numerical execution first needs it. Preparation is shared
within that backend owner, separately for each numerical kind and index layout. A prepared
addition pipeline cannot satisfy multiplication or sum preparation. Cache identity
is bounded
by that owner's device lifetime and the selected kernel semantics; it retains
neither uniforms nor partial buffers. The numerical implementation and its precision
constraints are defined in the
[addition decision](../architecture/webgpu-float32-addition.md) and
[multiplication reference](../reference/tensor-multiplication.md), not in the
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

### Total-sum geometry and private storage

The [float32](../../src/backends/webgpu/kernels/sum.ts),
[float16](../../src/backends/webgpu/kernels/sum-f16.ts) and
[bfloat16](../../src/backends/webgpu/kernels/sum-bf16.ts) sum kernels process
128 elements per group with 64 invocations. Nonfinal stages write 44-byte
partials for float32 and bfloat16, and 16-byte partials for float16. Dispatches establish
the dependency between stages; no device-wide barrier is assumed within a
dispatch. The final stage writes a four-byte word, holding a float32 scalar or
one compact scalar in its low lane. Even empty input dispatches
one guarded group to write positive zero rather than reuse stale scalar data.

Each stage has a distinct 16-byte uniform. Partial and parameter allocations
belong to the invocation's physical owner, not semantic tensor slots, and are
released only after drain. A queued uniform write creates this obligation even
when all inputs are resident or empty and command encoding later fails.

The acquired workgroup limits must permit 64 invocations and the specialization's
workgroup storage: 2,816 bytes for float32 and bfloat16, or 1,024 bytes for float16. The buffer
limit must permit a uniform. The existing tensor
extent bound limits the unsigned input count; stage planning separately checks
each dispatch and its padded indices. Each stage selects its own original or
grid pipeline, so a large first stage does not change later partitions.
For `N >= 129`, each first partial buffer fits its admitted input extent:
`44 * ceil(N/128) <= 4*N` for float32, `44 * ceil(N/128) <= 2*N` for bfloat16,
and `16 * ceil(N/128) <= 2*N` for float16. Later stages shrink further.
See the [float32](../architecture/webgpu-float32-sum.md) and
[compact](../architecture/typed-tensors.md#compact-floating-reductions-and-matrix-products) decisions for the
integer-width proofs. These storage bounds describe buffers owned by Tabgrad.

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

## Validate indexed reads before publication

Index selection uses checked address geometry shared with CPU. A fused dispatch
validates the full signed index before the load and copies the selected bits
in their original representation. Empty results with nonempty indices dispatch
a bounds-only check even when their logical axis length exceeds 32 bits.

All selection dispatches in an invocation share one private four-byte status
word. The first failing operation is reported after a single staging map.
The GPU ticket waits for validation before returning any new resident
allocation. The owner joins mapping and queue completion before retiring
temporary buffers. In a composition with argmax, only the status is read
for validation. The intermediate index tensor remains on the device.
