# GPU storage and checked dispatch geometry

Tensor storage and a kernel's dispatch window are different capacities. A large
input can feed a small matrix output; a scalar sum can traverse many input
partitions. A single device-wide tensor limit derived from one output launch
would therefore reject usable storage and would still fail to describe private
partials, transport or other kernel index spaces.

This decision separates those responsibilities below the semantic runtime.
The [GPU reference](../reference/webgpu-runtime.md) owns the application-facing
capacity/error contract; the [backend component](../components/webgpu-backend.md)
explains its owners and lifetimes. No tensor operation or numerical policy is
added by this separation.

## Declare the kernel's index space

Each physical kernel declares independent invocation indexing, cooperative
group indexing or an existing immutable-offset window strategy. Invocation
indexing specifies workgroup size and elements per invocation; cooperative
indexing specifies the workgroup size and elements covered by a group. These
are physical contracts, not an operation name interpreted for every element.
Future tiled or differently synchronized kernels must supply an appropriate
strategy; they cannot silently inherit independent invocation indexing.

The common linear planner validates logical counts and spans, per-axis limits,
logical group count and padded unsigned index extent before numerical work.
Zero independent work has no dispatch. Empty total sum deliberately plans one
identity-writing group. Each positive linear extent that fits one axis keeps
its original one-dimensional source and launch. Larger extents use the minimum
row count needed to fit the axis, distributing columns across those rows.
The planner checks both dimensions and the resulting padded span, including
width-four broadcast lanes. It rejects unrepresentable work rather than
wrapping indices or moving it to CPU.

Grid shaders derive a linear index from the acquired dispatch dimensions.
Independent invocations retain their ordinary output guard. Cooperative sum
flattens group IDs and returns an entire padded group uniformly before any
workgroup barrier or partial access. It preserves the existing 128-element
partitions, exact integer arithmetic, 44-byte partial layout and staged
rounding boundary. A later stage can use the original one-dimensional layout
even when an earlier stage needs a grid.

Receiving reductions retain separately owned immutable offset windows. Their
group/chunk offsets already define the global index, so applying grid flattening
to that source would count offsets twice. The common reduction-stage owner
checks partial sizes; receiver projection, window uniforms and physical buffer
ownership remain distinct.

## Prepare bounded identities and finite invocation metadata

The WebGPU kernel catalogue binds executable signatures to physical variants and
device requirements. The device advertises the eligible declarations in order.
The planner looks up the chosen signature, then selects the calling layout and
shader source for its existing geometry. A two-lane packed pointwise declaration
supplies its own arithmetic to a shared shader traversal. The traversal owns
whole-word writes, independent broadcast indices for each lane, and odd tails.

Pipeline identity contains numerical kind and index layout within one device
generation. There is no shape, rank, tensor length or invocation in its cache
key. Receiving has one windowed layout; each other registered physical kind
can have an original and a grid layout. The finite set of registered kinds and
layouts bounds the cache. A small-then-large or large-then-small sequence selects
the same appropriate identities. Failed preparation retains its original cause
while each requester receives its own program-slot provenance.

All known storage, stage, parameter and dispatch bounds are checked before
starting compilation or enqueuing numerical writes. Execution derives its own
finite metadata before creating buffers, protecting its direct backend entry
as well. This repeats bounded metadata work at those two boundaries; it does
not retain shape plans or allocate expanded operands. Planning costs grow with
selected program metadata, ranks and reduction stages, not with a host visit
for every numerical element. No negligible-overhead or timing-optimum claim
follows from this structure.

Every private parameter, partial and output still belongs to the existing
invocation owner. Grid indexing adds no base uniform or extra numerical
scratch. A queued write remains an obligation after failed encoding; logical
failure cannot destroy in-flight buffers or manufacture confirmed completion.
Readback, managed-worker result capacity and physical drain retain their own
checks and failure owners.

## Choice, alternatives and evidence limits

The maintainer accepted the [dispatch investigation](https://github.com/isaacperez/tabgrad/issues/463)
and its [production response](https://github.com/isaacperez/tabgrad/issues/463#issuecomment-6920039372).
Checked grids avoid extra base packets and split launches for these declared
linear classes. Immutable windows remain a viable alternative and remain the
receiving strategy. Strided traversal is another option for independent
invocations; it does not automatically preserve cooperative partitions and
barriers. Merely requesting larger optional device limits would neither define
these contracts nor establish their portability.

The investigation selected no performance winner. Correctness and bounded
ownership tests establish their observed domains, not universal GPU capacity,
physical RAM availability, full-model training support or a latency guarantee.
The implementation requests no optional features/limits and changes neither
semantic admission quotas nor the CPU memory policy. Numerical kernel and
complete-model optimization require their own evidence.
