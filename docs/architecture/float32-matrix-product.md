# Float32 matrix products and first-order derivatives

This decision defines the numerical meaning and execution boundaries of dense
contiguous two-dimensional float32 matrix products on CPU and explicitly
selected WebGPU. It is for contributors preserving matrix results, derivative
recipes and backend integration. For matrices `A[M,K]` and `B[K,N]`, the result
has shape `[M,N]`, the same dtype and device, and distinct logical storage.

The domain includes zero dimensions, whole-contiguous shape-only views and
first-order functional or persistent gradients. Vectors, batched products,
broadcasting, other dtypes, public strided transpose views, non-None output
buffers and higher-order or retained differentiation are outside this bounded
decision. PyTorch supports several of those forms; their exclusion is a Tabgrad
subset boundary, not a native error. Architectural acceptance is separate from
implemented interfaces and release qualification under
[the compatibility policy](../compatibility.md).

## Define the accumulation before choosing a kernel

Each stored binary32 operand represents one precise number. For output position
`[i,j]`, start with positive binary32 zero and traverse `t=0..K-1` in ascending
index order. Each term computes the exact expression
`accumulator + A[i,t] * B[t,j]`, then rounds once to the nearest binary32 value,
resolving a halfway tie toward an even low significand bit. The next term uses
that stored rounded accumulator. This is a sequential fused multiply-add
(FMA) dot product, not an exact total of products.

Preserve gradual underflow, signed underflow and overflow, signed-zero
arithmetic and true infinity/NaN classification at every FMA boundary. An exact
finite product may exceed binary32 range before its addition without being
rounded to infinity prematurely. A previously rounded infinite accumulator
remains subject to the ordinary FMA special-value rules. Zero times infinity
produces NaN; zero operands do not skip arithmetic. NaN payload, sign and
signaling distinctions are unspecified. IEEE flags and configurable rounding
modes are not public state.

For `K=0`, every nonempty output element is positive zero. Empty output has no
numerical elements, but still receives complete argument, shape, device and
metadata validation. A minimum physical allocation for an empty tensor cannot
invent an operand, contraction term or output element.

The result is binary32 before any consumer. Existing elementwise multiplication,
addition, total sum and coefficient updates retain their own rounding rules.
Replacing a matrix product with separately rounded public `mul`/`sum`, carrying
an exact hidden dot into a consumer, or reassociating the contraction can change
its meaning. Physical tiling, vectorization or packing is legal when it
preserves these per-output boundaries and order.

## Native comparisons have an explicit numerical boundary

[PyTorch's numerical policy](https://docs.pytorch.org/docs/2.14/notes/numerical_accuracy.html)
does not guarantee bitwise equality across association, matrix geometry,
platforms or backends, and acknowledges extremal-value overflow differences.
That policy does not choose Tabgrad's accumulation rule. This decision accepts
known differences explicitly rather than hiding them with a tolerance.

For the largest finite binary32 value `F`, the dot
`[F,F,-F,-F]` with `[1,1,1,1]` produced positive zero in the pinned native
one-output matrix and positive infinity when replicated across a larger native
matrix. Sequential FMA produces positive infinity. The dot `[F,-F]` with
`[2,2]` likewise produced native NaN or positive infinity according to geometry,
while this contract produces positive infinity. Native cancellation and
negative-zero results can also differ from this fixed association. These remain
valid calls with declared numerical differences, not narrower input admission.

Exact stored-bit controls establish the required FMA result. Finite native
fixture comparisons additionally use conditioning-aware absolute error bounds.
Let `u=2^-24` and `A=sum(abs(a[t]*b[t]))` over exact stored operands. With
`K*u<1` and no intermediate overflow, the sequential-FMA forward error is bounded
by `[K*u*A + K*2^-150]/[1-K*u]`; the second term accounts for propagated gradual
underflow errors. A conservative native fixture diagnostic uses `2K` rounded
terms and combines both bounds. This diagnostic assumes ordinary binary32
accumulation and is not a theorem about every proprietary BLAS or native
platform. Explicit zero, infinity and NaN observations are separate from finite
error comparisons. No relative or average tolerance establishes the exact
Tabgrad recurrence or excuses a contradictory special-value result.

## Derivatives are ordinary matrix computations

For incoming gradient `G[M,N]`, the vector-Jacobian products are
`dA = G @ Bᵀ` with shape `[M,K]` and `dB = Aᵀ @ G` with shape `[K,N]`.
Each uses the same matrix accumulation meaning. Repeated operands retain two
ordered contributions, followed by the existing ordinary gradient addition;
they cannot be replaced by twice one contribution.

Represent orientation as immutable internal matrix-computation attributes over
contiguous stored operands. Forward uses normal/normal orientation; the two
derivatives select normal/transposed and transposed/normal. Captured operand
shapes determine effective geometry, including for values that alias one whole
storage with different shapes. Orientation does not create a public
noncontiguous tensor or transfer payloads to the host.

The canonical operation admits this computation, ordinary program formation
carries its attributes, and actual worker reconstruction validates their copied
meaning before preparation, including empty work. Capture metadata once and own
it immutably; an outer object freeze does not own a nested mutable object.
Validate rank, contraction agreement, output metadata and attributes together.
Do not let absent or malformed transported attributes become invented defaults.

[DerivativeHistory](../components/derivative-history.md) retains the logical
opposite operand for each actual differentiable forward edge and validates all
saves of an executing recipe before later contribution pruning. A no-grad-created
view can advertise `requires_grad` without a traversable edge. Saving and guards
follow those actual edges, not just advertised metadata. Borrow the saved
logical version when emitting the ordinary derivative computation; close its
temporary exposure through existing ownership. Native calls, views, identity,
saved-version failures and per-node partial progress remain governed by
[automatic differentiation](autograd-and-training.md) and
[gradient state](cpu-gradient-state.md).

## Keep geometry, capacity and drain with their existing owners

Matrix output size is not inherited from either input: `[M,1] @ [1,N]` may
produce more bytes than either operand. Admission checks safe output size and
the selected backend's truthful capacity. Gradient reservations account for
selected contribution sizes and owners before partial effects. Empty forward
output can require a nonempty zero-contraction VJP; skipping all derivative
work merely because forward has no elements is incorrect.

Distinguish safe large empty shape metadata from dimensions actually used by
physical indexing. Nonempty CPU ABI and WGSL work must prove its index, length,
byte and dispatch ranges representable. CPU inputs and output have distinct
`MK`, `KN` and `MN` ranges. Output is disjoint from nonempty inputs; readable
input-input aliasing is legal. Range validation precedes pointer formation and
follows the existing [raw ABI](webassembly-cpu-backend.md).

The backend owns numerical loops and private layout. A concrete GPU packet uses
four unsigned words for effective `M`, `N`, `K` and orientation, with a separate
immutable packet per computation. It follows existing invocation ownership:
queued writes already create drain obligations before encoding or submission
can fail. Parameters and optional private packing survive until their physical
uses drain, under [the shared failure contract](execution-lifecycle.md).
Generation, provenance, rollback, once-delivered causal effects and logical
versus physical completion are unchanged. There is no matrix-specific execution,
gradient or transport engine, and no implicit CPU fallback.

## Alternatives and accepted consequences

Sequential separate multiplication/addition, several independent FMA partials,
wider accumulation and exact summed stored products are viable different
numerical contracts. Exact product accumulation can recover a finite total lost
to intermediate overflow, but does not preserve the selected FMA recurrence or
every observed native result. The accepted response favors a defined association
and reuse of the existing backend-local single-rounding primitives. It does
not assert that this is the fastest or universally most accurate algorithm.

The CPU response can use the compensated-binary64 FMA primitive; the GPU response
can use the two-word integer primitive described by
[GPU coefficient arithmetic](webgpu-sgd.md). Share their respective arithmetic
invariants across matrix and coefficient computation rather than maintain
divergent copies. Native WGSL `fma` alone has
[weaker portable guarantees](https://www.w3.org/TR/WGSL/#floating-point-evaluation),
including separate product/add rounding and subnormal/special-value freedoms.
A certified native fast path requires a preserving proof and its own cost
evidence; it cannot exclude ordinary valid payloads.

Materialized ordinary transposes are also viable and can improve physical
access, but add semantic computations and payloads. For only A tracking with
`M=1,K=N=L`, a transpose of untracked B adds `4L²` bytes while a contribution-only
derivative reservation is proportional to `L`. Such a design needs a different
capacity proof. Distinct ordinary VJP kinds avoid those payloads but enlarge
vocabulary and dispatch. Internal orientations avoid both obligations while
allowing measured backend-private packing without a public layout API. No
transpose temporal ranking follows from those structural costs.

## Evidence and reconsideration

[Research #273](https://github.com/isaacperez/tabgrad/issues/273), its
[method and evidence](https://github.com/isaacperez/tabgrad/issues/273#issuecomment-6140608900),
[independent challenge](https://github.com/isaacperez/tabgrad/issues/273#issuecomment-6140609253)
and [exact acceptance](https://github.com/isaacperez/tabgrad/issues/273#issuecomment-6141143478)
record the numerical alternatives, original controls, known failures and limits.
Sampled scalar/SIMD Wasm and Chrome 155/Apple metal-3 nonfallback candidates each
matched 20,501 independent matrix/VJP result words. Independent alternate
quantization and complete result-length checks complement those samples; they
are not exhaustive arithmetic or integrated-runtime qualification.

A separately calibrated physical comparison found a material logged cost for
the preserving GPU candidate. Eight resident products at `512³` took about
41 ms versus about 5.35 ms for the untiled native-WGSL control. The boundary was
encoding, submission and queue completion, excluding initial compilation,
upload and readback. Smaller-shape variation, unestablished background/power
conditions and limited sampling prevent universal ratios, kernel-only timing,
optimized-GEMM comparisons or model-performance claims. Counted buffer owners
do not measure shader-private memory, registers, RSS or VRAM. Complete current
methods, samples and historical-source availability limits belong in the
research record, not a release guarantee.

Reconsider this contract explicitly if native-valid behavior contradicts its
declared comparisons, the selected execution cannot preserve its ownership,
another adapter changes qualification, or representative costs are unacceptable
for intended use. Equivalent tiling, vectorization, packing or certified
specialization requires numerical, lifetime and adequate cost verification.
Changing association, tolerance or exceptional-value meaning requires a new
compatibility decision, not a silent optimization.
