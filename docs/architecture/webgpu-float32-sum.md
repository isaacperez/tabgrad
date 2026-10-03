# Numerical and execution contract for WebGPU float32 total sum

This decision is for contributors implementing or optimizing total sum on an
explicitly selected WebGPU backend. It defines the scalar that the operation
must produce and the execution boundaries that preserve it. The contract covers
whole contiguous binary32 inputs, including scalars, singletons, empty
dimensions, multidimensional tensors and whole-contiguous views. The result is
a distinct rank-zero tensor on the same device and with the same public dtype.

The [sum reference](../reference/tensor-sum.md) owns public call forms and
supported behavior. This chapter records an accepted architectural requirement;
it does not establish a release's operation or browser coverage. Those claims
require the evidence defined by the [compatibility policy](../compatibility.md).
Axis reductions, options, other dtypes, strided access and GPU differentiation
are outside this decision.

## Define the total before choosing its accumulator

A stored float32 value, also called binary32, represents one precise number.
Tensor creation has already converted the original Python or JavaScript value
to that representation. Total sum operates on these stored numbers. It does
not recover information lost during creation or silently use the original
language-level values instead.

The public dtype determines how the scalar result and subsequent operands are
stored. It does not require every physical intermediate to have that dtype.
The CPU reduction chooses float32 accumulation with a bounded association.
The [WebGPU addition decision](webgpu-float32-addition.md) rounds each logical
binary addition. Neither choice determines the result of a distinct total
reduction. Even perfectly rounded binary additions can lose information that
affects the correctly rounded total.

Tabgrad chooses the exact mathematical total rounded to binary32, using the
nearest representable value and resolving halfway cases toward an even low
significand bit. The guarantee fixes the result, not an obligatory sequence of
internal steps. It gives total sum a meaning independent of the physical tree,
partition or permutation of the finite stored inputs. This stability is a
deliberate numerical tradeoff, rather than a consequence of the return dtype
or a universal PyTorch equality promise.

## Required scalar and composition

| Stored input case | Required result |
| --- | --- |
| All inputs finite | Exact mathematical total, rounded once to binary32 nearest with ties to even. |
| Empty input or exact zero total | Positive zero, including an input containing only negative zeros. |
| Nonzero subnormal total | Preserve its exact binary32 value; do not flush it to zero. |
| Finite total that rounds beyond binary32 range | The appropriately signed infinity under nearest-even overflow. |
| Any explicit NaN | NaN category. |
| Both signs of explicit infinity, without NaN | NaN category. |
| One sign of explicit infinity, without NaN or the opposite infinity | The infinity with that sign, regardless of the finite inputs. |

NaN payload, sign and signaling distinctions are unspecified. IEEE exception
flags and configurable rounding modes are not public state. The rule for
explicit input infinities is separate from finite-input overflow: an infinity
created by a rounded partial is not evidence of an input infinity.

Every finite binary32 number is an integer multiple of `2^-149`. A nonzero
subnormal exact total therefore lies on the representable subnormal lattice;
there is no smaller nonzero total between zero and that lattice. Wider
accumulation preserves those contributions rather than flushing them.

Only final rounding error remains. If the exact total is normal and rounds to a
finite value, absolute error is at most `2^-24 * abs(total)`. Exact zero and
subnormal totals have no rounding error. This guarantee concerns the stored
inputs' mathematical total, not agreement with another backend's algorithm.

Let `M` be the largest finite binary32 value. The mathematical total of
`[M, M, -M, -M]` is zero, so this contract requires positive zero. A float32
tree can overflow its positive and negative partials and then produce NaN.
For the finite total `M + 2^102`, nearest-even rounding returns `M`; the overflow
threshold is `M + 2^103`. With an explicit positive infinity and two `-M`
inputs, the explicit-infinity rule requires positive infinity. These examples
explain intentional backend differences, not an error tolerance.

Logical operation boundaries remain binary32. For example, total sum of stored
`[1, 2^-24]` rounds to `1`; adding `2^-24` to that scalar also rounds to `1`.
Carrying the hidden exact subtotal into the consumer would produce `1 + 2^-23`
and violate composition. Conversely, a single total sum of
`[1, 2^-24, 2^-149]` must produce `1 + 2^-23`: rounding the first two elements
as a physical float32 partial would lose the information needed by the total.

Fusion may remove buffers or dispatches, but it must preserve the stored value
of every logical producer before sum and the rounded scalar before a consumer.
Internal rounding, overflow or reassociation is legal only when equivalence to
the required logical result is established. CPU accumulation remains governed
by its own [reference contract](../reference/tensor-sum.md#floating-point-accumulation-is-not-exact-arithmetic).

## Alternatives and the accepted tradeoff

Native WGSL arithmetic is attractive because it uses small state and direct
floating-point instructions. However, its
[floating-point rules](https://www.w3.org/TR/2026/CRD-WGSL-20260921/#floating-point-evaluation)
allow unspecified rounding direction, flushing of subnormals and weaker zero,
overflow and non-finite behavior. Observing a satisfactory result on one device
does not strengthen that portable contract.

A tree using Tabgrad's nearest-even binary32 addition can instead establish
portable binary steps and an association-dependent forward error bound. For
finite inputs with no intermediate overflow, a depth bound `h` gives absolute
error at most `gamma(h) * A`, where `A` is the sum of input magnitudes,
`u = 2^-24` and `gamma(h) = h*u / (1-h*u)`, provided `h*u < 1`. This is a viable
different contract. It still permits severe relative error under cancellation
and finite totals lost to intermediate overflow. The analysis follows
[Higham's summation bounds](https://nhigham.com/wp-content/uploads/2023/10/high93s.pdf).

Compensated accumulation can improve forward error under strict arithmetic
assumptions. An error-free transformation recovers the rounding residual of a
primitive operation; algorithms that use it need those primitive guarantees
and a proof for how parallel partials merge. A sequential compensated bound
does not automatically establish a parallel reduction's bound or the exact
rounded total. Native WGSL expressions alone do not supply all the required
assumptions. Such algorithms are alternatives to evaluate, rather than
inherently impossible or slower strategies; the
[Ogita, Rump and Oishi analysis](https://ogilab.w.waseda.jp/ogita/math/doc/2005_OgRuOi.pdf)
states the sequential guarantees and assumptions.

The accepted contract favors a precise total under cancellation and freedom to
change physical partitioning, while accepting wider private state and extra
arithmetic. It does not depend on exact accumulation being faster than an
emulated binary32 tree, equally costly, or close to native speed. Numerical
quality and cost remain separate evidence.

An equivalent specialization may use native or shorter accumulation when a
sound certificate proves the same result, and an exact path otherwise. As a
concrete example, inputs `z/4096` with integer `abs(z) <= 8` can be classified
on GPU. If the sums of positive and negative coefficients are `P` and `Q` and
`max(P, Q) < 2^24`, every subset total is exactly representable; nonzero totals
are normal. Native additions then preserve those values despite unspecified
rounding direction. A zero result must still be normalized explicitly using
integer bits, because WGSL does not guarantee its sign. The classifier must
also avoid integer overflow and preserve certificate lifetime and uniform
barrier control flow. Classification, another input traversal, gating and
conservatively reserved scratch have costs; the certificate does not prove
profitability. No classification subsystem or restricted input admission is
required by this decision.

## A bounded backend-private execution strategy

The initial strategy decodes stored bits into exact signed integer coefficients,
merges them with explicit non-finite flags and rounds at the terminal stage.
For a finite input `x = q * 2^-149`, `abs(q) < 2^277`. Over an unsigned 32-bit
count domain, every subset coefficient magnitude is below `2^309`, so 310
signed bits suffice. A 320-bit accumulator represented by ten unsigned 32-bit
words, plus flags, uses 44 bytes per partial. This is a sufficient physical
representation, not a public tensor dtype, format or promise to admit every
count in that mathematical domain.

One concrete partition uses 64 threads and two inputs per thread, followed by
six local tree levels. Each workgroup emits a partial for up to 128 inputs;
out-of-range lanes contribute the neutral coefficient and flags. Later
dispatches reduce the partials until the allocated logical scalar is written.
Inter-workgroup dependencies use separate dispatches, not a nonexistent global
WGSL barrier. Dependent stages may be encoded in one compute pass and submission
under the [WebGPU usage-scope and queue rules](https://github.com/gpuweb/gpuweb/blob/454d33cfdf6b8c8a1efafe490623cf0905e6c245/spec/index.bs).
Stage input/output ranges must not alias, and stage parameters remain immutable
through their physical uses.

Empty reduction still owns a four-byte scalar and must write positive zero.
A guarded kernel or an encoder buffer clear can implement that write while
preserving ordinary invocation ownership. Assuming that storage begins zero
does not preserve the result when allocations are reused.

For positive input count `N`, this partition has
`D = max(1, ceil(log_128(N)))` stages. Let `S` be the sum of the nonterminal
stage output counts. Retaining every partial and 16-byte parameter block needs
`44*S + 16*D` temporary payload bytes, plus input, logical scalar and ordinary
materializations separately. The corresponding native or binary32 tree uses
`4*S + 16*D`. Declared workgroup storage is 2,816 bytes for the exact candidate,
compared with 256 bytes for the four-byte partials.

The concrete tree performs 127 merges and six workgroup barrier encounters per
workgroup, including neutral padding. Total work is linear in `N`, with bounded
ten-word arithmetic per merge; staged dependency depth is logarithmic. Logical
payload movement per reduction is `4*N + 88*S + 4` bytes for the exact candidate,
versus `4*N + 8*S + 4` for four-byte partials, excluding parameters. These are
analytical payload counts, not physical bandwidth, VRAM, occupancy or spill
measurements. Pooling and alternating stage buffers can change allocation
counts only with corresponding ownership evidence. None of these constants
freeze the public algorithm.

## Preserve the existing runtime boundaries

The common operation and lowering retain one logical `sum-f32` and its scalar
metadata. Wider partials, flags and stage parameters remain private to backend
execution; they are not float32 program values, semantic storage slots or a
sequence of logical binary additions. This uses the existing
[program representation](internal-representations.md) and
[backend execution contract](backend-execution.md), without another IR or
numerical manager.

Admission checks compact metadata, selected capabilities and known
representation, binding, dispatch and temporary-size limits. It does not scan
payloads on the host or silently fall back to CPU. Device limits do not reveal
available physical memory: preparation or execution can still encounter an
ordinary allocation failure. Mathematical capacity and experimental resource
ceilings do not raise the backend's admitted tensor limits.

Preparation establishes sum pipeline readiness independently of another
operation's readiness. Its existing reuse identity must distinguish relevant
operation/lowering semantics, kernel/compiler/capability choices and GPU
context generation. Per-request scratch and parameters are not prepared
weights or persistent cached materializations. Dispatch geometry follows the
input count; scalar output allocation cannot determine the traversal.

Execution retains the canonical input storage, resolves its ordinary resident
binding or upload and allocates the distinct logical scalar. Private temporary
owners protect all stage resources and queued parameter writes until physical
uses drain, including when encoding fails before submission or the input is
already resident. The final stage writes the logical scalar directly. Subsequent
GPU operations may consume it without an intermediate host readback. Managed
Python uses the existing finite-program worker and ordinary observation path,
without new asynchronous methods or mandatory JSPI.

Operation provenance, rollback and context quarantine follow the shared
[completion and failure contract](execution-lifecycle.md). Pending close retains
required logical inputs, and dropping all owners of unobserved work does not
launch it. Semantic result settlement can precede physical drain; error, abort,
close or device loss must not claim scratch reclaimed while completion is
unknown. No sum-specific exception weakens those common obligations.

## Evidence, qualification and reconsideration

[Research #155](https://github.com/isaacperez/tabgrad/issues/155) records the
question, alternatives, methods, sources, failures and independent challenges.
The [accepted proposal](https://github.com/isaacperez/tabgrad/issues/155#issuecomment-5969697368)
and [acceptance record](https://github.com/isaacperez/tabgrad/issues/155#issuecomment-5970467022)
establish this choice. The issue links the exact candidate, independent
stored-bit oracle and complete raw observations. Functional sampling supports
feasibility; it is not exhaustive shader conformance or packaged integration.

The bounded cost study records a material logged consequence relative to native
arithmetic in one dyadic workload and browser/device environment. It separates
calibration from a fixed new sample and preserves failed instruments and
contrary results. Statistical intervals rely on an independent common-block
distribution that was not established; instrumental sensitivity scenarios are
hypothetical, not certified timestamp-error bounds. No physical percentage
premium, scaling, full-model speed or cost equivalence with the emulated
binary32 tree follows. Exact sources, allocation checkpoints and measurements
belong in the research record, rather than becoming release guarantees here.

Qualification must use exact arithmetic over stored bits for finite results;
binary64 or `math.fsum` followed by float32 conversion can double-round. An
average or relative tolerance cannot establish this exact scalar contract.
Checks must cover ties, cancellation, subnormals, zeros, final overflow,
explicit specials, workgroup/stage boundaries, composition and resource failure.
NaN assertions compare the category rather than accidental payload identity.
Integration and ordinary Python observation require their own packaged-browser
evidence, separate from numerical samples and cost measurements.

Reconsider the contract explicitly if wider private state, CPU differences or
representative resource/performance costs are unacceptable, if a selected
environment cannot preserve it, or if the intended semantics change. A faster
equivalent algorithm requires verification and adequate measurements under the
[performance policy](../performance.md); weakening an observable result requires
a compatibility decision. The contract does not turn one experimental
partition into permanent architecture or a general performance budget.
