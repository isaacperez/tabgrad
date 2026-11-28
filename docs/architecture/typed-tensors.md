# Typed tensor storage and operation contracts

A tensor's dtype describes its logical values. It does not, by itself, tell
the runtime how an operation accumulates, how a device packs its buffers, or
which type an observation returns. Keeping those questions separate lets
Tabgrad add numerical types without duplicating its execution engine.

This chapter records the accepted type-extension architecture. It constrains
implementation; it is not a claim that every signature described here is
available. Use the [compatibility record](../compatibility.md) and the exact
[API references](../reference/README.md) for supported behavior.

## Separate meaning, representation and arithmetic

Consider channel scaling followed by a bias: multiply an activation tensor by
a scale tensor, then add a bias tensor. Broadcasting determines which elements
participate. A type policy determines whether their types can be combined and
what type the result has. The backend then selects arithmetic and storage that
preserve that result.

These decisions have different owners:

| Question | Authoritative boundary |
| --- | --- |
| What logical type and binary format does this value have? | Canonical immutable dtype identity and description. |
| Which operand types may this operation accept, and what does it produce? | The operation's type policy, shared by admission and reconstruction. |
| Which arithmetic, rounding and conversion rules apply? | The admitted operation signature, including any accumulator or coefficient rules. |
| Which bytes represent an imported or observed value? | A bounded encoded payload and its shared host codec. |
| How are those bytes aligned, packed and allocated? | The selected backend's physical planner and existing memory owner. |
| Can this type and operation participate in differentiation? | The admitted derivative capability and its resource proof. |

A dtype description must not become a catalogue of every operation's
accumulator or derivative. Conversely, a frontend must not invent promotion
rules independently of the semantic runtime. A new operation binds its
appropriate type policy; it does not add another dtype switch to scheduling,
collection or derivative traversal.

For contiguous homogeneous pointwise signatures that fit an existing physical
family, give each dtype one canonical declaration of its logical identity,
encoding, supported import and observation formats, and shared codecs. Derive
the frontend metadata that represents those same facts. JavaScript validates
explicit dtype names as primitive strings without coercion. Python owns
normalization and the borrow lifetime for imported buffers. Dtype registration
alone grants neither a default type nor arithmetic, differentiation or mutation
capability.

## Resolve type rules before numerical loops

Admission resolves the accepted input/result relation once, alongside shape
validation. Immutable program reconstruction validates that same relation.
Policies may be shared by an operation family when their actual rules agree;
an operation with a different result, coefficient or conversion rule keeps that
difference explicit.

Operand classification preserves distinctions that affect native behavior.
A rank-zero tensor, a dimensional tensor and an ordinary Python number are not
interchangeable promotion inputs. Rounding a Python number into a tensor before
applying an operation can also change its result. A policy must not erase that
information merely to reduce the number of call forms.

Tabgrad retains finite, explicitly typed executable computations. A resolved
signature connects semantic admission to a supported physical specialization;
it does not replace the program with a universal interpreter. Backend
capability checks and preparation use the same admitted facts. Unsupported
signatures fail before numerical work or observable state changes and never
silently move to another backend.

The semantic catalogue binds each executable identity to its operation family
and concrete input and result types. Admission indexes binary variants by their
ordered operand types. Reconstruction reads the family from the executable
identity, so a matrix signature inherits orientation and contraction rules
independent of its dtype. Backend preparation indexes advertised signatures
once per immutable capability list. The executable format and ordered worker
advertisements do not need additional fields for these lookups.

The [semantic catalogue](../../src/execution/operation-contracts.ts) owns the
signature. The [CPU catalogue](../../src/backends/cpu/kernel-catalogue.ts) and
[WebGPU catalogue](../../src/backends/webgpu/kernel-catalogue.ts) declare their
physical kernels independently. A backend can implement a subset. Its
registered entries drive its capabilities and preparation, and the CPU
loader validates the exports and capability bits required by its profile.
The operation family owns arity, shape and parameters. Admission and
reconstruction use the same validated input, result and arithmetic signature.
Selection uses direct lookup without scanning the catalogue per node. The
[contributor procedure](../reference/package-qualification.md#extend-dtype-coverage)
explains where to add a signature, its kernels and its conformance cases.

Physical preparation identities distinguish numerical signature, encoding,
layout and relevant capability/generation. Tensor shape remains runtime
geometry rather than an unbounded cache key. A numerical loop uses its selected
implementation, without consulting a dtype registry for every element. GPU
shader generation and compilation begin only when a validated signature and
layout request them. The device owner remains responsible for preparation
and cache lifetime.

## Give payloads explicit bounds

An encoded payload carries its encoding, logical element count and bounded
byte extent. Checked span calculations distinguish logical payload bytes from
physical alignment or packing, observation bytes and backend minimum
allocations. Validate type, encoding, offset, length, safe integer arithmetic
and transport limits before interpreting memory.

The byte allocator, resident allocation identity, virtual storage, aliases and
completion/drain owners retain their responsibilities. Whole-storage shape
views preserve logical dtype and encoding; changing shape does not reinterpret
the bytes as another type. CPU views must retain their memory-growth safety.
Python borrowed-buffer imports retain synchronous copying and lease release
on both success and failure.

A live resident tensor identity carries its canonical format and exact logical
byte extent. The format determines the encoding and bytes per element, so
padding never decides the logical element count. CPU and WebGPU validate the
format and extent at binding and readback before interpreting bytes or queuing
dependent work. Whole-storage views borrow the same identity. A recycled raw
range or buffer takes the format of its new resident tensor after its last use.

Storage and observation admit supported encodings independently of
computation signatures. For example, a device can store and read packed
binary16 bytes while its binding limits exclude packed arithmetic. The
storage capability does not enable any numerical kernel.

Raw readback returns a bounded encoded payload. A shared host observation codec
below the Python and JavaScript facades performs numeric decoding once.
Backend readers do not recreate language-level conversion rules independently.
The connected GPU worker transports bytes and joins physical drain; completion
headers remain protocol metadata rather than tensor data.

Version the CPU capability profile separately from the raw Wasm ABI and
validate its manifest and required symbols in both scalar and SIMD artifacts.
The GPU worker wire schema and matching package identity are separate
contracts. Worker requests reconstruct and validate the admitted signature,
and incompatible capabilities fail before use. Validate any change to worker
compatibility through the installed package path.

This boundary preserves the float32 path's direct decoding, copies and
lifetimes. Supporting another encoding does not justify an unconditional extra
conversion or payload copy for float32.

## The binary16 pointwise domain

Binary16 (`float16`) provides a concrete compact floating domain for creation,
whole-storage shape views and tensor add/mul, including broadcasting, on CPU
and explicitly selected GPU. Channel scale/bias is its motivating composition.
It is not a full model-inference or training contract.

| Boundary | Contract |
| --- | --- |
| Creation | Explicit float16 selection in both languages; preserve language normalization and errors. JavaScript's omitted dtype remains float32. Python requires a canonical dtype object explicitly. |
| Operands and result | Add/mul admit `(float16, float16) -> float16` Tensor signatures, including rank-zero and empty tensors under the common shape laws. Public addition retains `alpha=1`. |
| Numerical boundary | Each operation stores its own binary16 result with nearest-even rounding, preserved subnormals and IEEE exceptional classifications and zero signs. No NaN payload/sign identity is required. A scale/bias composition does not imply fused arithmetic. |
| CPU storage | Owned binary16 words within the existing byte allocator. |
| GPU storage | Two logical half values per u32 word; one invocation owns the complete output word. Each lane projects its own broadcast input indices. An odd tail neither reads a missing lane nor exposes padding. |
| JavaScript observation | `toArray()` returns decoded numeric `Float32Array` values; the tensor's dtype remains float16. The returned array is not raw half storage. |
| Python observation | `tolist()` returns ordinary numeric values through the same decoding boundary. |
| Eligibility | This domain excludes tracking/backward, persistent gradient state, SGD and mutation, including same-type and cross-type copy. Reject unsupported requests before history, pins or version changes. |

The pointwise domain also excludes numeric-operand overloads,
mixed-type promotion, inferred dtype, `.to`, dtype-reinterpreting views and
custom `grad_dtype`. These are Tabgrad domain boundaries, not claims that
native PyTorch lacks those capabilities. They do not restrict existing
float32 behavior.

Input conversion must use the original input value and precision. An
unconditional float32 intermediary can change a binary16 result, including
finite versus infinity near overflow. Numeric observation is a different
boundary: every finite binary16 value is exactly representable in float32.
This observation contract does not impose float32 transport on other future
types such as int64.

Portable arithmetic and codecs must establish the stated numerical behavior.
WGSL's optional native f16 conversions and packing builtins alone do not
guarantee it. Software/integer arithmetic or a qualified specialized path may
implement the contract; the architecture requires neither `shader-f16` nor a
new dependency. Selecting a dependency or optional feature retains the normal
integration, qualification and approval requirements.

## Compact floating reductions and matrix products

The [binary16](https://github.com/isaacperez/tabgrad/issues/509) and
[bfloat16](https://github.com/isaacperez/tabgrad/issues/521#issuecomment-7220653831)
decisions define forward arithmetic for total sum and dense two-dimensional
matrix products. The operation references and each release's compatibility
record identify the implementations and environments that are qualified.

Both forms retain contiguous, same-device operands and a result of their
declared compact dtype. Matrix operands use the same dtype.
Total sum accepts an input of any admitted rank, including a scalar, and
produces a distinct scalar. Dense matrix multiplication uses the existing
two-dimensional shape and contraction rules. A zero output dimension produces
an empty result. A zero contraction with nonempty output produces positive
zeros. Compact types participate only in forward execution under this
contract. The float32 derivative and receiving paths keep their own rules.

### Total sum

Accumulate exactly over the stored finite binary16 inputs on CPU and WebGPU.
Round the total once to nearest binary16, with ties to even. Every exact zero
produces positive zero, including an empty tensor and an input of negative
zeros. Any NaN or both signs of infinity produce NaN. Otherwise a single
infinity sign dominates all finite inputs. Overflow at the final rounding
produces infinity of the corresponding sign.

A finite half is a signed integer in units of 2⁻²⁴ with magnitude below 2⁴⁰.
A u32 element count bounds every disjoint partial and the finite total below
2⁷², so signed 96-bit accumulation suffices. Backend-private stage layout,
partial representation and dispatch remain with the reduction owner. Check
u32 ranges and nonoverlapping stage slices before execution.

### Dense matrix product

For each binary16 matrix output, start at positive zero and visit contraction
indices in ascending order. Compute each exact product plus accumulator with one
nearest-even binary32 rounding. Preserve the exceptional-value and signed-zero
behavior of the [float32 matrix contract](float32-matrix-product.md). Round
the final value once to nearest binary16, ties to even, retaining the sign of
a negative value rounded to zero. A finite binary16 product fits exactly in
binary32. A specialization must still establish equivalent accumulation and
terminal rounding, including exceptional values. WGSL builtins alone do not
establish that equivalence.

The backends keep compact operands and outputs resident. A GPU writer owns
a complete packed word, including separately indexed neighboring matrix
elements when a word crosses a row boundary. Decode values inside the
arithmetic path without full-size float32 copies of operands or results.
Private reduction partials and scalar accumulators can be wider. Dtype-specific
forward selection and stage planning use the existing semantic and physical
owners.

### Comparison boundary

Native PyTorch may associate the same values differently. On the observed
PyTorch 2.14 CPU path, the total of `[65504, 2**-24, -65504]` rounded to zero,
while the exact total preserves the least positive half subnormal. A padded
arrangement retained that subnormal in PyTorch. Arithmetic comparisons
must identify these association-sensitive cases separately from ordinary
value comparisons. Test the exact contract with an independent oracle and
the accepted public call forms against the pinned native oracle.

Float32 accumulation on both devices or float32 CPU with exact GPU sum
can reduce implementation cost, with association-dependent results.
The selected total sum gives CPU and WebGPU a common exact result rule.
The matrix product instead preserves the existing contraction order and
avoids adding a separate exact-dot contract. The experimental record in
[#509](https://github.com/isaacperez/tabgrad/issues/509) establishes numerical
feasibility. Timing and stage scratch costs require representative evidence
from the actual kernels. A material cost or a failed qualification warrants
review of the design.

### Bfloat16 range and rounding

The [bfloat16 arithmetic decision](https://github.com/isaacperez/tabgrad/issues/521#issuecomment-7220545574)
uses the same compact storage and forward-only scope. Numeric construction
stages through binary32 before rounding to bfloat16, as observed in the pinned
PyTorch constructor. Every stored bfloat16 value can be decoded into binary32
without losing information about its numerical value or sign of zero.

Total sum accumulates the stored finite values exactly and rounds the total
once, to nearest bfloat16 with ties to even. The exact-zero and nonfinite
rules are the same as for binary16 sum. At the bfloat16 scale of 2⁻¹³³, a
finite coefficient has magnitude below 2²⁶¹. A u32 element count bounds every
partial and the total below 2²⁹³, so five 64-bit limbs suffice. The existing
GPU exact reducer uses units of 2⁻¹⁴⁹, for which the corresponding bound is
below 2³⁰⁹. It can consume the compact format by embedding each value in
binary32 as it is read. Round directly from the exact accumulator to bfloat16.
An intermediate rounded binary32 sum can discard bits that decide the final
bfloat16 rounding. Exponent bins and stage partials are backend-private.

Each matrix output starts at positive zero and visits the contraction in
ascending order. Round each product to binary32 with ties to even. Add the
rounded product with a separate nearest-even binary32 rounding. Round the
final accumulator to bfloat16 with ties to even and retain the sign of a
negative value rounded to zero. Binary32 exceptional values and signed zeros
apply at each step. NaN payload and sign are outside the contract. Bfloat16
products can underflow or overflow before addition, so fusing the two steps
can change the result. The ordinary empty-axis and zero-contraction rules
still apply. Use packed operands and outputs with private arithmetic state.

In the pinned CPU comparison, separately rounded matrix arithmetic matched
the native subnormal-midpoint and opposite-overflow witnesses. Fused arithmetic
changed the output from one to two subnormal units in the first case and from
NaN to positive infinity in the second. The separate scalar Wasm prototype
was faster in its largest measured shape. The physical GPU timing ranges
overlapped. Exact whole-dot accumulation preserves cancellation across a
wider range at the cost of wider arithmetic per result and changes both
ordered and native outcomes.

The selected exact sum preserves a small term between opposite maximum finite
inputs. Ordered binary32 and the observed native reduction lost it. Ordered
binary32 uses less accumulator state, while native association can vary with
shape. For matrix operands with zero padding around an order-sensitive term,
the native path retained a value that both ordered binary32 matrix alternatives
lost. The [independent challenge](https://github.com/isaacperez/tabgrad/issues/521#issuecomment-7220544852)
records those witnesses and the limits of the prototypes. Test ordered rounding
with independent references and ordinary supported calls against the pinned
native environment. Reconsider the design if representative kernel measurements
show a material cost or if the compatibility contract changes.

## Boolean masks and selection

The [boolean mask decision](https://github.com/isaacperez/tabgrad/issues/527#issuecomment-7223499341)
defines a first slice of comparison and selection. The operation references
and versioned compatibility record identify the available implementations.

Explicit `bool` construction accepts the supported dense, rectangular inputs.
Both signs of numeric zero produce false. Nonzero numbers, NaN and infinities
produce true. Python normalizes the original value before transport, so a
binary64 subnormal or an integer outside machine range keeps its truth value.
Shape-only views keep the ordinary storage lifetime. Bool tensors reject
gradient requests. Python `tolist()` returns built-in booleans, including a
single boolean for a rank-zero tensor. JavaScript `toArray()` returns a
`Float32Array` of zeros and ones for bool. The explicit
`toArray({ format: "typed" })` returns a `Uint8Array` of zeros and ones for
bool and a `Float32Array` for the floating dtypes. Validate observation
options before executing a deferred tensor.

The operation contracts admit same-device contiguous tensors, including
rank-zero tensors, empty dimensions and broadcasting:

| Operation | Inputs → result | Behavior |
| --- | --- | --- |
| `torch.gt`, `Tensor.gt`, Python tensor `>` | `float32, float32 → bool` | False if either operand is NaN. Both zero signs compare equal. Order finite values, including subnormals, and infinities. Even tracked operands produce an untracked result with zero derivative edges. JavaScript exposes `Tensor.gt(other)`. |
| `torch.where(condition, input, other)` | `bool, float32, float32 → float32` | Broadcast the three operands and select the stored value from the chosen branch. Preserve its signed zero, finite value, infinity or NaN classification. NaN payload identity is outside this contract. JavaScript exposes `RuntimeSession.where(condition, input, other)`. |

The first slice covers out-of-place tensor forms. Scalar overloads, `out`,
compact floats, bool comparison operands and selection branches, promotion,
deprecated byte conditions, one-argument `where`, cross-device forms and
mutation require separate contracts.

For float32 branch gradients, capture the mask as a saved value with no
derivative edge. It remains available after its public handle closes. Later
changes to the comparison inputs or branches do not enter the saved mask.
For each tracked branch, select the incoming seed or positive zero and then
receive that contribution into the original branch shape. The selection
preserves a selected negative zero and isolates an unselected NaN. Both
contributions accumulate when the branches share an input. Apply the current
first-order gradient lifetime and reservation rules to local contributions and
receiving reductions. Exact-shape receiving performs no sum. Receiving that
changes shape uses the existing
[backend-specific group sum](broadcasting.md#numerical-meaning-of-each-receiving-group), including
projections that remove a singleton axis. For example, for a true mask of
shape `[4]` and a branch of shape `[1]`, the float32 seed
`[1e20, 1, -1e20, 1]` produces a branch gradient of 1 in the pinned PyTorch
reference, 0 on CPU and 2 on WebGPU under these receiving rules.

One canonical descriptor owns the byte encoding, with 0 or 1 per element.
CPU stores those bytes directly. WebGPU addresses four elements per
`u32` word. A producer owns its whole output word and clears tail padding.
Transfer the logical extent using the existing four-byte buffer alignment.
Observe the logical bytes through the shared codec. The existing floating
paths retain their copies and transport. A prototype demonstrated the packed
format with roughly one quarter of the mask storage of a word per value.
Its observed wall-clock timings overlap, so production performance requires
separate qualification.

Resolve operation signatures and arity before numerical execution. Reuse the
immutable program validation, checked broadcasting and resource ownership.
Keep the binary physical packet unchanged. The ternary binding uses a checked
projection for each operand and the same shape rules. Select specialized
CPU and WebGPU kernels before iterating. Compare stored float32 bits in
portable WebGPU code to establish the exceptional and subnormal behavior.
Selection and the gradient routing select stored bits directly, including
when the other branch is nonfinite.

The pinned PyTorch and physical GPU evidence, independent reasoning, and
alternatives are recorded in
[#527](https://github.com/isaacperez/tabgrad/issues/527). Qualification of the
published runtime belongs to the implementation issues.

## Signed integer tensors and indexing

The [accepted decision](https://github.com/isaacperez/tabgrad/issues/530#issuecomment-7237658235) separates exact integer values
from physical addressing. The operation references and versioned compatibility
inventory identify which parts of this contract have qualified implementations.

### Signed tensor types

- `int32` stores 4 logical bytes per element and `int64` stores 8. Each dtype uses
  signed two's complement and canonical little-endian bytes. A WebGPU int64 tensor uses
  the low word followed by the high word, both `u32`. CPU kernels may interpret the same
  bytes as native Wasm `i64`. There is one dtype descriptor and one checked transfer
  path per representation.
- Python construction takes the existing explicitly typed, rectangular built-in inputs.
  Python integers stay exact through range validation and `array('i')` or `array('q')`.
  Booleans convert to 0 and 1. For Python float inputs, check finiteness and the
  interval `[-2^(bits-1), 2^(bits-1))` before truncating toward zero. A Python integer
  outside signed int64 raises `ValueError`, including when targeting int32. Overflow of
  an otherwise valid integer into int32 and invalid floating conversions raise
  `RuntimeError`. The canonical Python constants are `torch.int32` and `torch.int64`.
  Keep `torch.int` and `torch.long` as aliases of those same objects without shadowing
  the built-in conversions the bridge uses. Dtype inference, new input container types
  and general conversion or integer arithmetic have separate contracts.
- JavaScript creation accepts safe integral Numbers or BigInts in signed range and
  matching typed arrays. Reject unsafe Numbers, fractional Numbers and overflow before
  packing. A preconstructed BigInt64Array contains already converted values and cannot
  reveal an earlier overflow in caller code. Integer observation uses `toArray({ format:
  "typed" })`. Int32 returns an owned Int32Array and int64 returns an owned
  BigInt64Array. The no-argument Float32Array path rejects integer dtypes without
  running an observation. Its existing return type stays intact and the typed overload's
  union gains these two array types. Python `tolist()` returns built-in ints at every
  rank, including a single int for rank zero. Keep integer tensors untracked and support
  existing whole contiguous views and normal session, device, ownership and capacity
  controls.
- Use the prepared typed Pyodide buffer on compatible hosts and copy only the admitted
  span into an owner. Copy retained host bytes at the existing worker handoff when
  detachment would invalidate their owner. A resident tensor stays a device allocation
  across operations. The portable byte representation is little-endian. A host with
  another native typed-array order needs a checked conversion at the boundary, or a
  clear capability failure until that conversion is qualified. No per-element BigInt
  work is needed in GPU kernels.
- Integer mutation, gradients on integer tensors, general promotion and casts are
  excluded from this slice.

### Argmax

- Python exposes `torch.argmax(input, dim=None, keepdim=False, *, out=None)` and
  `input.argmax(dim=None, keepdim=False)`. JavaScript exposes `input.argmax(dim?,
  keepdim?)` with null or omission for reduction over all elements. `out` accepts only
  None in the free Python function. The first slice admits dense contiguous float32,
  int32 and int64 inputs and returns a new same-device int64 tensor without derivative
  history, including for a float32 input that is tracked.
- An explicit signed axis is normalized against rank. Python takes an int or int
  subclass, with bool and generic `__index__` objects rejected. Python checks overflow and
  rank before transport. Values outside signed int64 raise ValueError and values within
  that range but outside the rank raise IndexError. Keepdim takes a bool. Native PyTorch
  also admits a rank-zero integer tensor as dim. This slice explicitly excludes that
  form because it makes output geometry depend on observing a device value. With no axis
  the result is the first maximum's index in the logical row-major traversal. Keepdim on
  a full reduction gives one singleton per original axis. An explicit axis removes that
  axis or replaces it with length one. A rank-zero input allows None, 0 and -1 and
  returns rank-zero int64 zero with either keepdim value.
- Ties choose the lowest index. The first NaN wins in floating inputs; both signs of
  zero compare equal, and infinities and subnormals keep their order. Integer
  comparisons use all bits, including negative values and values above 2^53. Reducing
  over all values of an empty input or over a selected axis of length zero raises
  IndexError at admission. If the chosen axis is nonempty and all result positions
  disappear through an unrelated empty axis, return the empty result with the calculated
  shape and no physical reduction. Avoid computing irrelevant large strides for empty
  domains.

### Index selection

- Python exposes `torch.index_select(input, dim, index, *, out=None)` and
  `input.index_select(dim, index)`. JavaScript exposes `input.indexSelect(dim, index)`.
  The free Python function admits `out=None`. Use contiguous rank-zero or rank-one int32
  or int64 indices on the input's device and in its session. Data inputs are contiguous
  float32, int32 or int64; preserve their dtype, selected bits and rank without aliasing
  source storage. For an ordinary input, replace the selection axis length with the
  number of indices. Keep order and duplicates. An input of rank zero accepts exactly
  one index, whose value must be zero, and returns rank zero. The same eager dimension
  rules and the exclusion of a tensor-valued dim apply. Negative axes normalize and
  negative index values are invalid. No indexing broadcast, casts, mixed-device move,
  non-None out or compact-float/boolean data support in this first slice.
- Validate dimension, rank, dtype, session and known impossibilities at the call. An
  empty index for a rank of at least one simply produces the corresponding empty output.
  A nonempty index must be checked even if an unrelated empty axis makes the output
  zero-sized. Compare full signed values to the full logical bound in that case. For
  example, selecting index 4294967297 in axis 1 of a tensor with shape `[0, 4294967298]`
  gives shape `[0, 1]`. The next index is invalid. The current safe-integer shape limit
  still applies.
- Preserve the pinned CPU exception categories in Python. Bad argument types use
  TypeError; out-of-range axes use IndexError; unsupported index dtype and scalar count
  use RuntimeError. For payload bounds, rank 0 or 1, or a nonempty input with normalized
  axis other than 1, uses IndexError. Rank greater than one with empty input, or
  normalized axis 1 in the admitted contiguous case, uses RuntimeError. An empty
  selected axis with nonempty indices can be rejected immediately from metadata. Errors
  should identify the operation, with the invalid index position available where
  practical. Exact native wording is unnecessary. An int64 value exposed in a diagnostic
  must be exact and can be serialized as decimal text.
- Timing of bounds errors. PyTorch CPU validates payload values during the call. Tabgrad
  validates them when a dependent observation or effect demands execution, on both
  backends and in both frontends, regardless of where the indices currently reside.
  Check before any potentially invalid address. Permit private results to be computed
  while collecting status, but do not publish new allocations or commit a payload to a
  mutation from a failed program. Preserve prior residents, drain temporary work and
  route effect failure through the existing writer outcome owner. A previously admitted
  deferred writer can still fail, including observable failure on affected aliases and
  mandatory completion. The existing writer policy can advance a target's version when
  copy_ is admitted and block later writes in that session when a deferred source fails.
  The failed gather must never write its invalid result into the target. Cover affected
  and independent observations and effect targets, including copy_ and normal managed
  completion, against that failure model.
- Gradient scope. The first forward selection rejects a tracked float32 source while
  recording is active. A tracked source may be read under no_grad. Native PyTorch does
  track selection, so this is an explicit limitation of the first delivery. The later
  float32 VJP uses the captured indices with no gradient edge for them. It starts with
  positive zeros and adds contributions to each source position in original index order,
  with one binary32 rounding per addition. Duplicate positions are accumulated; it is
  not a sum tree or an unordered atomic reduction. Native PyTorch gave 1 for `[1e20, 1,
  -1e20, 1]` and positive zero for an isolated negative-zero seed. Group indices stably
  so there is no search through the entire index vector for each source position. A
  separate derivative slice should verify bounded scratch and repeated-index workloads,
  including the skewed case where strict order limits parallelism, before promising
  support on both devices.

### Implementation boundaries and realistic alternatives

1. **Exact storage with checked local addressing** defines the contract. Retain
   canonical typed bytes throughout runtime and worker transport. Use unsigned 32-bit
   addressing only when checked shape and physical capacity prove the domain fits and
   when an index has passed bounds checking. Float32 and int32 data share a four-byte
   movement kernel where practical, while int64 uses paired-word movement. Reduction
   geometry for argmax and index geometry for selection are separate from dtype
   specialization. Do not put a data-type decision in the per-element loop.
2. **Compact 32-bit index tensors** would halve resident storage for values known to be
   offsets. Applying it to public int64 would lose information for user-created tensors
   or downstream consumers. A separate internal validated scratch vector can still be
   useful for large slices. One fused guarded gather avoids this scratch and a pass, but
   can repeat checks for a wide slice. A validation-only path is required in both
   approaches for zero output with nonempty indices; it keeps a potentially wide logical
   bound. Small physical probes verified correctness for both approaches. They did not
   select a latency or throughput winner. Choose the production dispatch strategy with
   targeted evidence in #532.
3. **Synchronously validate every index at the Python call** would match native timing.
   On resident GPU tensors it forces execution and a completion barrier even if the
   output is never used. Fast-pathing only host-resident inputs creates timing
   differences caused by internal residency. A deferred validated program lets an argmax
   result feed selection directly. A checked internal proof may make a range status
   unnecessary when the producer guarantees indices below a bound no greater than the
   selected axis length. Without that proof, collect a small status at completion before
   publishing output. No intermediate full index readback is admitted.
4. **Deliver float32 gradients with the initial selection** would offer more immediate
   PyTorch coverage. Native order, saved-index lifetime, duplicated indices, error
   propagation and bounded GPU resources are additional independent risks. The forward
   research prototype does not validate any GPU VJP cost or correctness. The proposal
   keeps that result separately reviewable, with no claim of full gradient parity for
   #532.

The reviewed research used PyTorch 2.14.0 arm64 CPU, wheel revision
`08187d9e0fba026dc8217405802ab5381dc88d90`, as its reference. A bounded Chrome
and Pyodide probe on physical Apple Metal-3 preserved signed endpoint values
and adjacent integers beyond 2^53. It exercised both fused bounds checking and
a separate validated scratch vector. Both produced exact selections with no
intermediate tensor readback. The staged approach adds four scratch bytes per
index. These results do not rank the algorithms by performance or qualify the
production kernels. The [research and independent findings](https://github.com/isaacperez/tabgrad/issues/530#issuecomment-7237045561)
identify implementation checks, including the result and effect failure paths.
Revisit the boundary if validation cannot preserve the existing publication and
failure owners, or the implementation cannot maintain bounded resource costs.

## Preserve derivative and protocol domains

The float32 derivative domain retains its history, implicit seeds, zeros,
gradient identity, saved-version checks, partial progress and resource proofs.
An inference-only half domain does not require speculative mixed-gradient
traversal. Eligibility belongs to type/operation/backend capabilities rather
than a global rule that every floating dtype is differentiable.

Default native gradient assignment constraints also do not establish a
universal `tensor.dtype == grad.dtype` law: PyTorch's configurable gradient
type is a separate contract. No such customization follows from this design.

Not every four-byte quantity is a float32 tensor element. U32 geometry packets,
Int32 completion headers, handle metadata and private reduction accumulators
have independent formats. In particular, the GPU float32 sum's wider private
accumulator is not a tensor item size. Keep those formats and float32
derivative reservations under their existing owners and proofs.

## Account for costs without inferring performance

For `n` binary16 values, the logical payload has `2n` bytes. The packed GPU
payload rounds that extent to four bytes; minimum allocation, staging and
retained resources are separate. Numeric float32 export needs `4n` bytes and
may add conversion or staging costs. A smaller logical payload therefore does
not establish a halving of total memory or an execution speedup.

Type policy and codec selection occur at admission, preparation or observation
boundaries. Packed addressing and conversion remain real work. Compare actual
float32 call/planning costs, copies and resource accounting before and after a
refactor, and measure conversion, preparation/compilation, steady computation,
readback and distributed-size changes separately under the
[performance measurement rules](../performance.md). No negligible-overhead,
startup, artifact-size or acceleration claim follows from clean interfaces.
CPU arena/default capacity, logical update reservations and GPU storage and
dispatch limits remain separate; adding a dtype does not raise their quotas.

## Alternatives and reconsideration

Retaining a float32-only domain is the lowest-change alternative when another
representation is unnecessary. The chosen common contracts retain the existing
engine and typed vocabulary while making the actual payload and type rules
explicit. Operation-plus-resolved-signature IR is a viable broader alternative,
but it needs the same specialized arithmetic, codecs and physical identities
and additionally migrates existing program producers and consumers. The
research does not establish fewer variants or lower cost for that replacement.

Binary16 prioritizes ten fraction bits within a smaller exponent range.
Bfloat16 has the same two-byte density, seven fraction bits and float32's
exponent range. Preferring binary16 for bounded-range scale/bias is an accepted
priority, not a measured winner over bfloat16; both need qualified portable
arithmetic under a strict contract. Int32 provides integer computation without
changing payload width, and native integral/bool sum defaults to int64. Exact
int64 host transport and GPU arithmetic require their own contracts. Boolean
masks need an actual producing operation and their own representation rules.

Reconsider the domain when a real consumer needs wider range, reductions,
matrix products, promotion or training. Reconsider the IR if demonstrated
heterogeneous families create semantic duplication or specialization growth
that shared policies cannot contain. A failed numerical contract or material
measured regression requires correction or a new decision, not a claim that
the abstraction is inherently efficient.

## Decision and evidence

The maintainer [accepted the bounded contract](https://github.com/isaacperez/tabgrad/issues/468#issuecomment-6947689676)
in [#468](https://github.com/isaacperez/tabgrad/issues/468).
Its [proposal and qualitative extension comparison](https://github.com/isaacperez/tabgrad/issues/468#issuecomment-6947445790)
compare responsibility changes, conversion/copies, preparation identities,
migration and unresolved costs. The
[canonical evidence](https://github.com/isaacperez/tabgrad/issues/468#issuecomment-6947429290)
contains pinned PyTorch 2.14 references, exact synthetic inputs, runnable
sources and complete observed results; it preserves warnings and limitations.
The [independent challenge](https://github.com/isaacperez/tabgrad/issues/468#issuecomment-6947456813)
found the contract ready for maintainer evaluation.

Those CPU and metadata controls establish representative reference facts and
representation obligations. They do not qualify a Tabgrad numerical kernel,
Pyodide integration, physical GPU behavior or universal equivalence across
platforms. The [existing numerical contracts](backend-execution.md) retain
their own evidence and domains.

The maintainer [accepted the static declaration boundary](https://github.com/isaacperez/tabgrad/issues/490#issuecomment-7161546207)
in [#490](https://github.com/isaacperez/tabgrad/issues/490). The
[research result](https://github.com/isaacperez/tabgrad/issues/490#issuecomment-7161526027)
records a local bfloat16 prototype and its independent challenge. The installed
trial exercised one compact floating representation on scalar/SIMD CPU and
WebGPU through JavaScript and Python. Its copy and allocation observations are
bounded by the measured workloads, and its timing samples establish no
equivalence bound. The compatibility record defines public support.

Migrate one owner at a time, retaining explicit registrations as a rollback
option. Compare current float32 and float16 semantics, copies, resources and
affected execution phases for each increment. Qualify an extension from the
exact installed archive using the [compact dtype procedure](../reference/package-qualification.md#qualify-an-added-compact-floating-dtype).
Reconsider the finite executable vocabulary when an
actual signature cannot fit its shared type and operation families.
