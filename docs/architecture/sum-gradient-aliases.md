# Scalar aliases in total-sum gradients

A total sum accepts one incoming scalar gradient. Its input gradient repeats
that scalar across the input shape, but repetition does not imply independent
storage. In the examined native behavior, a functional result can remain a
view of the scalar: writing the seed changes later gradient reads, and a
supported write through the result can change the seed. An empty result can
share the mutation version even though it has no elements to read.

This decision specializes [semantic state](semantic-state.md) and
[gradient acquisition](cpu-gradient-state.md#leaf-accumulation-and-nonleaf-retention-differ)
for internal first-order float32 total-sum gradients on CPU and WebGPU. It is
separate from [result object identity](functional-gradient-identity.md).
[Compatibility](../compatibility.md) owns versioned support; this architectural
contract does not establish support for arbitrary public strides, broadcasting,
higher-order gradients or every native layout.

## Preserve a logical alias separately from an execution value

The semantic runtime represents a scalar-derived gradient as a logical
projection into its requested shape, sharing the scalar family's current value
and mutation version. A shape with one element uses the ordinary storage/view
path. Empty and larger shapes need the projection relationship; their logical
shape does not become the scalar's shape.

Ordinary numerical execution still consumes contiguous immutable values.
When execution needs an empty or repeated scalar, it forms a dense expansion
of the particular scalar version captured for that use. Existing CPU and GPU
expansion kernels preserve the stored binary32 word. This changes no scalar
rounding, factory conversion or kernel arithmetic contract, and creates no
public broadcast operation or second executor.

| Relationship | Required responsibility |
| --- | --- |
| Live numerical alias | The family selects the current scalar and shared mutation version for a new use. |
| Numerical capture | An admitted calculation owns the immutable value and prerequisites selected for that calculation. |
| Incoming layout and acquisition | Derivative/result owners preserve the receiving class, view provenance and native acquisition conditions. |
| Public object identity | The frontend follows incoming equivalence and exposure ownership independently of the numerical family. |

For example, a functional two-element sum gradient initially reads `[3, 3]`
from a scalar seed of `3`. A multiplication captured at that point must still
produce `[9, 9]` after a later seed write to `4`; a fresh gradient read must
produce `[4, 4]`. Keeping both obligations requires a live alias and an older
immutable numerical capture. Sharing one mutable dense array would not preserve
the captured calculation; creating unrelated result families would not preserve
the live alias.

A captured value must not strongly retain the alias family's latest root.
Otherwise one old calculation can retain an unrelated, growing replacement
graph. A shared version counter can validate saves without retaining that
latest root. Weak references can identify whether an expansion remains eligible
for reuse, but they do not own a numerical value or physical allocation.

## Receiving layout is a semantic fact

Physical contiguous materialization does not make every receiving gradient
semantically dense. An expanded singleton can have the native zero-stride
receiving class despite containing only one element. A view through rank zero
can restore the dense class; reshaping an empty result can also change that
class without changing a single number. These distinctions affect first leaf
acquisition and subsequent mutation guards.

Keep the incoming class and acquisition relationship separate from numerical
storage and public equivalence. A true leaf can clone or acquire a detached
incoming value under the existing gradient-state rules; a retained nonleaf has
its own policy. Acquisition must not infer its result from dense backend
storage alone or turn a numerical alias into an ordinary view with the wrong
active-copy guard. Python conversion remains presentation and error translation,
with no sum-specific acquisition or layout logic.

This internal distinction is sufficient for the examined scalar, singleton,
empty and larger results. It does not expose a general stride system or relax
the supported domains of `view`, `copy_` or differentiation.

## Writes preserve alias versions, guards and effects

A scalar-family write publishes a new current logical value and advances its
shared version. Existing immutable captures keep their payload; new gradient
uses capture the updated scalar. Saved-history checks still observe the shared
mutation version through their ordinary owner.

A larger repeated-scalar destination has overlapping logical elements. A copy
from an independent family must preserve native overlap rejection and its ordering
relative to other guards. Exact self-copy and the examined equal-shape,
same-family exceptions cannot be rejected merely because the destination has
that layout. Valid empty and self copies can advance a version without changing
the scalar's payload. Their source controls, derivative recording, mandatory
effects and partial progress remain observable and cannot be removed because
there are no new numbers to write.

History describes the semantic receiver's shape, which may differ from the
family's physical scalar shape. Admission, publication and predecessor cleanup
retain their existing boundaries. A fallible cache release after a committed
write must not roll back that write or skip independent retirement. Primary
and cleanup failures remain available through the common effect/request owners.

## Retain outputs that can receive a later capture

Structural program uses describe the selected invocation. They do not count a
calculation that can be admitted while backend preparation or execution is
pending. A live projection can request the same expansion after the first
invocation has classified its selected uses. Treating that output as scratch
can therefore leave the later calculation without an input binding.

At ordinary execution admission, the semantic runtime supplies retention for an
origin still reachable through a live projection and its current reusable
metadata. This obligation is independent of the optional cache below. The
backend owns physical scheduling and drain under the existing
[intermediate-reuse boundary](cpu-intermediate-reuse.md#take-ownership-facts-at-the-execution-boundary).
No new per-operation executor, scheduler or physical lifetime authority is
introduced.

When the final retained projected identity retires, discard reusable metadata,
including when no cache pin was admitted. A later projection must not reuse an
old origin whose producer has been detached and whose numerical storage has
retired. Independently owned pending captures still retain their own values and
physical obligations until ordinary completion and retirement allow release.

## One optional last-size expansion

Keep at most one optional dense expansion per family with retained projected
identities. The cache is a pin to an ordinary numerical value, charged to the
existing owner and backing-byte accounting; it is not another store, history
or independent quota. Admit the optional pin only when the existing owner
budget permits it. Required captures and their capacity checks still apply
when that pin is omitted.

Reuse requires the same current scalar version and logical element count.
Materializing another size replaces the optional cached value. A scalar write
invalidates reusable metadata and retires the old cache. Final retirement of
the last projected identity retires the cache even when the scalar seed remains
alive. Internal gradient associations and view-base ownership can retain that
identity; public exposure count alone cannot determine its lifetime. Ordinary
single-element aliases do not require this dense cache.

One cached payload can be larger than the remaining live projection. In the
examined CPU control, a last 257-element expansion retains 1,032 registered
Wasm bytes, including the scalar, while only an empty projection survives.
Replacement, scalar mutation or last projection retirement releases that pin.
This is an explicit resource tradeoff, not a promise that cache size follows the
smallest current view or that registered bytes measure RSS or physical VRAM.

Cache activation, replacement and release belong to ordinary materialization
and retirement, with their failure handling. Merely acquiring an immutable
numerical capture must not perform a fallible backend eviction. Weak eligibility
metadata does not replace explicit pins, paired release or the common budget.

## Alternatives, costs and reconsideration

Independent materialization preserves initial values but loses demonstrated
live aliases, versions and guards. Sharing only scalar/singleton views fixes
part of that domain but leaves larger and empty relationships incorrect.
Logical projection preserves the relationship without imposing arbitrary
layouts on backend programs.

Uncached ordinary expansion remains viable. It avoids the optional persistent
pin and can reconstruct on each observation. The selected cache avoids repeated
expansion in the examined repeated-read workloads, while retaining a last-size
payload and adding replacement/retirement work. Both alternatives require the
future-capture retention rule. No temporal winner or universal memory bound is
established by their structural counts.

Projection eligibility and cache inspection add work proportional to the
selected numerical values at invocation admission. Independent requested
occurrences and their controls still require their own semantic work. Payload
expansion and explicit readback remain real costs; eliminating repeated
expansion does not eliminate every repeated read or transfer.

A virtual scalar operand in backend kernels is a serious alternative if
production evidence makes ordinary dense materialization unacceptable. It
would require additional operand/lowering contracts and qualification. The
examined semantic solution supplies no reason to impose that extension now.
Reconsider the optional pin policy if resource pressure or different access
patterns make its retained payload outweigh avoided reconstruction. Reconsider
layout/acquisition rules when a new operation or supported layout introduces
a different native receiving class. Broader numerical, device or model claims
require their own evidence.

## Evidence and limits

The [accepted research response](https://github.com/isaacperez/tabgrad/issues/279)
links the [complete prototype and common controls](https://github.com/isaacperez/tabgrad/issues/279#issuecomment-6152184897),
[observed semantic records](https://github.com/isaacperez/tabgrad/issues/279#issuecomment-6152186795),
[small decisive failure and retirement observations](https://github.com/isaacperez/tabgrad/issues/279#issuecomment-6152187560),
[structural counts](https://github.com/isaacperez/tabgrad/issues/279#issuecomment-6152188020)
and [independent challenge](https://github.com/isaacperez/tabgrad/issues/279#issuecomment-6152188985).
The pinned native oracle is PyTorch 2.14 at
`08187d9e0fba026dc8217405802ab5381dc88d90`.
[Sum backward](https://github.com/pytorch/pytorch/blob/08187d9e0fba026dc8217405802ab5381dc88d90/torch/csrc/autograd/FunctionsManual.cpp),
[view-stride calculation](https://github.com/pytorch/pytorch/blob/08187d9e0fba026dc8217405802ab5381dc88d90/aten/src/ATen/TensorUtils.cpp)
and [gradient acquisition](https://github.com/pytorch/pytorch/blob/08187d9e0fba026dc8217405802ab5381dc88d90/torch/csrc/autograd/functions/accumulate_grad.h)
explain the examined distinctions; their code is not reused.

The bounded candidate matched all 5,775 recorded CPU objects, with supplemental
603 physical-GPU objects, 20 isolated matrix compositions and stored-word
controls on the named Chrome/Apple adapter. This does not establish arbitrary
PyTorch equivalence, other GPUs, whole models, RSS, universal GC, physical VRAM
or kernel/wall time. Error-category comparisons do not promise universal exact
wording. Large original arrays were independently inspected locally; public
records sample repetitions and explicitly distinguish recipes from raw files.

Contrary candidates, invalid setup attempts, the historical 39-cohort versus
32-batch method deviation and the separate shared-byte diagnostic defect are
preserved in the research records. Normal drain counts do not prove physical
reclamation after worker loss; unknown completion remains distinct. These
limits constrain the evidence, without changing the ordinary ownership and
compatibility obligations above.
