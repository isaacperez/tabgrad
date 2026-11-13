# Broadcast addition and receiving gradients

Adding a vector to each row of a matrix reuses that vector without making it a
matrix. Differentiation must reverse this reuse: each vector element receives
the contributions from every row that used it. These are related shape rules,
but neither rule requires copying the input or creating a graph node per
element.

This contract covers out-of-place, tensor-only float32 addition and its
first-order gradients on CPU and explicitly selected WebGPU, through both
frontends. It defines responsibilities and numerical meaning, not a release's
support status. Multiplication broadcasting, public strided views, general
axis-reduction APIs, promotion, host-number operands, new alpha/out forms,
mutation, implicit transfers and higher-order gradients are separate domains.

## One shape relation, ordinary computation

Align operand dimensions from the right. Dimensions are compatible when they
are equal or one is a singleton; the output takes the other dimension when
one is a singleton. In particular, zero with one produces zero. Missing leading
dimensions act as singletons. Scalars, unequal ranks, separated singleton axes
and empty dimensions follow this same relation. Empty payload does not excuse
an incompatible dimension elsewhere.

A pure geometry owner derives immutable output shapes and index projections
from owned validated shapes. Metadata is proportional to rank, never to output
payload. Semantic admission checks handles, sessions, dtype, layout and device,
then validates the inferred output's own safe element count and device capacity
before recording work. Equal-shape addition retains its dense path. Sharing
binary admission machinery does not broaden multiplication or copy semantics.

The ordinary executable program records logical shaped values, ordered operand
occurrences and canonical contiguous storage. Program reconstruction validates
the captured geometry, arity, device and distinct output storage; a structured
clone is not trusted admission. Raw kernels separately validate physical spans
and packet bounds. Those boundaries share the shape definition rather than
maintaining independent broadcast rules.

Backend index projection reads the corresponding operand element for each
output position. Receiving reduction enumerates only the source positions for
that receiver, in increasing source row-major order. The groups partition the
source; scanning the entire source independently for every receiver is not an
equivalent cost structure. General projection takes work proportional to
source/output elements times rank, with dense special cases permitted.
Broadcasting itself requires no expanded input or gather tensor. Existing
scalar-projection owners retain their separate materialization and snapshot
responsibilities; this decision does not replace them with public strided
storage or a frontend executor.

## Receiving identity and state

Exact-shape addition passes the incoming gradient through the existing
[incoming-identity mechanism](functional-gradient-identity.md). A receiving
shape that differs requires reduction over every extra leading axis, including
a leading axis of size one, and over aligned receiver-singleton axes whose
source size differs. This distinction is observable even when each group has
one element: reduction starts from positive zero, can change negative zero to
positive zero, and owns a result independent of the seed.

For a non-scalar receiver, removing leading axes produces a no-grad view of a
fresh keep-dimension reduction base. A scalar receiver is a plain scalar.
Numerical derivative work remains untracked under the existing first-order
contract. Addition saves no numerical input payload for its derivative. The
existing gradient acquisition, version, accumulation and effect owners retain
responsibility for exposure and persistent `.grad` state. Copy derivatives do
not acquire a reduce-to-shape rule simply because they share pass-through code.

An empty source can require a nonempty receiving tensor of positive zeros.
Validate all dimensions, but avoid unused overflowing stride products and
32-bit encoding of large empty dimensions. Empty work and a true one-term
reduction are distinct from returning the seed.

Repeated inputs and requested targets preserve occurrence and result-identity
rules. A later failure does not undo already committed gradients: the native
branch controls accumulate the bias before reporting a saved-version
failure in another branch. New reduction and optional view records must fit an
explicit gradient-control/capacity bound. Mandatory pending or failed outcomes
remain owned after temporary handles disappear.

## Numerical meaning of each receiving group

Forward addition keeps the existing [binary32 addition
contract](webgpu-float32-addition.md) for each projected pair. Addressing changes
neither separately rounded logical results nor exceptional-value behavior.

Each actually reduced group's source-row-major subsequence uses its backend's
existing total-sum meaning:

- CPU uses the float32 balanced subdivision above 128 terms, aligned split,
  four-lane leaf, pairwise lane combination and scalar tail defined in the
  [sum reference](../reference/tensor-sum.md). Scalar and SIMD use that same
  association without implicit widening.
- WebGPU uses the [exact integer total](webgpu-float32-sum.md), in units of
  `2^-149`, and rounds once per group to nearest-even float32. Explicit NaN or
  opposite infinities produce NaN; one infinity sign dominates finite terms;
  exact zero and an empty group produce positive zero. Private partials do not
  become tensor values.
- The exact-shape identity path performs no reduction and preserves the seed's
  negative zero. NaN payload/sign identity and floating exception flags are
  outside these numerical contracts.

This deliberately does not require native PyTorch or cross-device bitwise
equality. The pinned native controls demonstrate material differences:

| Stored terms per receiving group | Native reference | CPU association | Exact GPU total |
| --- | --- | --- | --- |
| `2^30, 1, -2^30` | 0 | 0 | 1 |
| `float32(1e20), 1, -float32(1e20), 1` | 1 | 0 | 2 |
| `F, F, -F, -F`, maximum finite float32 F | +infinity | NaN | +0 |

Finite comparisons use exact assertions where inputs and intermediate sums are
representable. Otherwise apply the sum reference's magnitude/depth-based
absolute comparison per group, with its subnormal allowance, native bound and
no-intermediate-overflow conditions. This is not a universal relative-error or
exceptional-classification promise. Keep cancellation and overflow contrary
results explicit rather than increasing a tolerance to hide them.

## Physical ownership and limits

CPU raw kernels own range, overlap and geometry validation. Numerical helpers
are shared with dense operations; broadcast indexing does not redefine their
arithmetic. WebGPU owns kind-bounded pipelines, immutable dispatch parameters,
private staged partials and retirement after known completion. Shape or rank
values are not unbounded shader-cache keys.

Validate tensor bytes, parameter bytes, receiver counts, groups-times-chunks,
partial storage and workgroup windows separately. For example, reducing
`[2, 65536]` to `[65536]` has small payloads but more groups than a 65,535-wide
dispatch axis. Equivalent windows must preserve global receiver/chunk offsets
and immutable parameter ownership. Known unsupported resource/capability
requests reject explicitly at the applicable boundary, without fallback.
Successful forward admission does not guarantee that every later gradient has
sufficient physical resources.

Scratch and packets belong to invocation/pending-work owners, not permanent
tensor history. Failure preserves the primary cause, accepted partial progress
and unknown-completion accounting. Normal drain is not evidence of device-loss
or abandoned-work cleanup; those paths need their own controls.

## Alternatives and reasons

Indexed access with dense special cases avoids mandatory expanded payloads and
keeps shape logic independent of numerical kernels. Explicit expansion plus
dense add, or gathering groups before reduction, remains a viable alternative.
A hybrid can reuse already dense operands or contiguous groups. Indexed
address arithmetic also has a cost; the sampled prototype's additional copied
bytes and dispatches do not establish a temporal winner or a minimum for every
expansion implementation.

The numerical choice is independent of that access choice. A fixed common
binary32 association can run on both devices using correctly rounded GPU
binary additions. Common exact accumulation is also viable using CPU software
integers. Reproducing the pinned native dimension-reduction association would
require a separately bounded algorithm/build contract. This decision instead
extends each backend's existing sum meaning and reuses its reviewed numerical
components. Common-device bits, smallest partial state and best latency are
not its selection criteria.

Changing private addressing remains possible while preserving arithmetic,
identity and ownership. Changing the numerical meaning is a compatibility
decision. Reconsider the implementation strategy when measured address cost,
rank metadata, device constraints or representative workloads justify it.
Quantitative claims follow the [measurement policy](../performance.md).

## Evidence and qualification boundary

[Research #428](https://github.com/isaacperez/tabgrad/issues/428) records the
[accepted proposal](https://github.com/isaacperez/tabgrad/issues/428#issuecomment-6859997873),
[native/CPU sources and observations](https://github.com/isaacperez/tabgrad/issues/428#issuecomment-6859995528),
[physical GPU experiments](https://github.com/isaacperez/tabgrad/issues/428#issuecomment-6859996194),
[experimental challenge](https://github.com/isaacperez/tabgrad/issues/428#issuecomment-6859996766)
and [architectural challenge](https://github.com/isaacperez/tabgrad/issues/428#issuecomment-6859997284).
The prototypes establish bounded indexing/arithmetic feasibility and reference
constraints. They do not qualify production program/ABI admission, Python
integration, failed/abandoned cleanup, all dispatch limits, timing, RSS/VRAM or
other hardware. A release's supported behavior requires its own named
implementation and conformance evidence under the
[compatibility policy](../compatibility.md).
