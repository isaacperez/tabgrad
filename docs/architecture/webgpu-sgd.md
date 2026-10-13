# Basic SGD on WebGPU

An optimizer update has observable numerical behavior even when its formula
looks simple. Basic SGD subtracts a scaled gradient from a parameter, but
separately rounding the scaling and addition can erase a small cancellation
result. A GPU shader that finishes successfully has not necessarily preserved
the update that the caller requested.

This chapter records the accepted WebGPU specialization of contiguous float32
basic SGD. It is for contributors implementing or preserving its numerical,
coefficient and lifetime boundaries. The [ordinary SGD contract](cpu-sgd.md)
owns calls, group and callback phases, gradient capture, reset metadata,
identity, versions and partial progress. Read that contract first, then this
chapter for the GPU response. The [SGD reference](../reference/sgd.md) and
[compatibility record](../compatibility.md#gpu-sgd-evidence) establish actual
public support; architectural acceptance does not establish it.

## Preserve the stored update

The ordinary computation consumes the stored binary32 parameter and gradient,
plus the binary32 coefficient produced by the existing checked learning-rate
conversion. For each element it computes the exact expression
`parameter + coefficient * gradient` and rounds once to the nearest binary32
value, resolving a halfway tie toward an even significand. Coefficient
negation, range checks and capture remain at their native phases. An absent
gradient skips conversion and the update; an empty present gradient does not.

For example, a stored parameter of 50.29061508178711, gradient of
502.9061279296875 and learning rate 0.1 give the native cancellation result
with bits `35ce9e68`. Separately rounded multiplication and addition give
positive zero. This numerical illustration is from the pinned CPU reference,
not a runnable GPU API example or a universal native GPU-build claim.

Preserve signed zeros, subnormal operands and results, gradual underflow,
nearest-even overflow and cancellation of a finite product that exceeds the
binary32 range before addition. Classify true infinities and NaNs explicitly.
A zero coefficient still multiplies an infinite gradient and produces NaN;
it does not skip arithmetic. NaN is a category guarantee, with no payload or
sign promise. Existing public addition and multiplication keep their separate
rounding boundaries, and the CPU compensated-float64 response stays unchanged.

Empty tensors retain ordinary metadata, coefficient validation, logical version
and effect semantics without requiring arithmetic dispatch. Other types,
layouts, transfers and optimizer modes are outside this specialization.

## Why floating shader arithmetic is insufficient

[WGSL floating-point evaluation](https://www.w3.org/TR/2026/CRD-WGSL-20260921/#floating-point-evaluation)
permits a built-in `fma` to use a rounded multiplication followed by a rounded
addition. Floating operations can also discard subnormals, lose a zero sign
or have weaker nonfinite behavior. Calling `fma` therefore does not establish
the required single-rounding result. A successful case on one adapter cannot
turn those specification freedoms into a portable guarantee.

The selected response uses unsigned integer words to preserve stored bits and
rounding information. This is specific to the coefficient computation; it
does not require integer emulation for every GPU operation.

## Bounded two-word arithmetic

Each finite binary32 operand has at most 24 significant bits. Form the full
24-by-24-bit coefficient/gradient product before rounding, retaining its at
most 48 bits. The multiplication and coefficient kernels share this exact
split-product and carry invariant rather than maintaining two implementations
that could diverge.

Represent each magnitude with two unsigned 32-bit words and an exponent.
Normalize the leading bit to position 61. The product then has 14 or 15 zero
low positions, while the parameter has 38. Align the smaller exponent by a
right shift that retains a sticky bit: this bit says whether any discarded
position was nonzero. Add or subtract magnitudes according to their signs.
Round only the resulting sum, using all retained guard and sticky information.
The normal rounding distance is 38 positions; gradual underflow increases it
by `max(0, -126 - exponent)`.

The bounds explain why this representation preserves cancellation:

- At exponent distance zero or one, alignment discards no significant bit.
  Deep cancellation therefore remains exact before normalization.
- At distance two or greater, the smaller aligned magnitude is below `2^60`
  while the larger is at least `2^61`. Opposite-sign subtraction can require
  at most one left normalization shift.
- When alignment actually discards a nonzero tail, the larger magnitude has
  an even low position and the jammed smaller one is odd. The result retains
  a nonzero low residue after that limited shift. It cannot masquerade as an
  exact midpoint whose rounding quantum is at least `2^38`.

A same-sign sum fits through bit 62. Preserve sticky information when shifting
that carry. Classify zero and nonfinite words before finite arithmetic, and
handle exact ties, signed underflow and either overflow boundary explicitly.
Shift helpers must distinguish distances zero, 32 and 64 instead of relying
on the language's modulo shift behavior. These operand bounds complement
tests; finite samples are not an exhaustive compiler or hardware proof.

## Immutable coefficient data follows invocation ownership

Coefficient bits already belong to an ordinary operation record and its
executable computation. Keep that metadata immutable through program
formation and worker reconstruction. The backend must validate required
coefficient metadata before skipping empty arithmetic; missing or invalid
bits cannot become an invented coefficient.

Each executed GPU coefficient computation receives its own immutable 16-byte
uniform packet alongside ordinary input and output bindings. Retain the
packet among the invocation's created allocations. Mark queued writes before
`queue.writeBuffer`: writing already creates a drain obligation even if later
encoding fails before submit. Retire the packet only through the existing
independent completion, loss and cleanup owners. Cache preparation by
computation kind, never by coefficient value.

Consider two computations encoded before one submit, with coefficients 0.5
and -0.25 and the same parameter `[10,20]` and gradient `[4,8]`. Distinct
packets preserve `[12,24]` and `[9,18]`. Rewriting one shared packet before
submit can make both dispatches use -0.25. Keeping the packets immutable
preserves captured meaning without a coefficient-dependent pipeline cache
or a new optimizer numerical engine.

The [persistent-update path](cpu-tensor-updates.md#webgpu-publication-and-request-progression)
owns publication, mandatory effects, generation and physical drain. Clearing
a gradient, dropping exposures, closing an optimizer or encountering a later
semantic error cannot cancel earlier accepted updates. Preserve `SGD.step`
and program-slot failure provenance, once-delivered causal responsibility and
the terminal mutation barrier. Unknown completion remains distinct from
confirmed reclamation; physical failure does not create a whole-step rollback.

## Shared semantics and device-local reset

CPU and GPU parameters may coexist in an enabled session's optimizer groups.
Each occurrence executes on its parameter's device with a same-device
gradient. Selection does not transfer operands. Native group and callback
phases, synchronous capture expiry and retirement, closure returns, recording
restoration, registered-exposure checks and earlier progress remain common.
Do not reconstruct those responsibilities inside the GPU backend.

Numeric reset creates positive zero on the selected gradient device. An
ordinary dense gradient uses stored-scalar expansion; a larger scalar-derived
sum alias fills its shared scalar without admitting an overlapping copy.
Both use the common persistent-write owner, effects and device-local execution.
An empty projection preserves the scalar payload and advances its version,
as specified by [numeric reset](cpu-sgd.md#gradient-reset-changes-associations-or-metadata).
Preserve metadata
detachment before the write, caller-mode provenance guards, gradient identity,
aliases, versions and saved-state errors. Association clearing remains
different from numerical reset. Existing semantic identity and frontend
finalization owners collect unreachable cycles; the optimizer does not add
another collector or retain completed training history.

## Alternatives, evidence and consequences

A fixed 18-word exact accumulator is also preserving. With a common unit of
`2^-298`, the highest finite product bit is 553 and the parameter bit is 425,
so 576 bits suffice for their exact signed sum and final rounding. Prefer two
words per magnitude because the stated operand bounds make that smaller
representation sufficient, avoiding full-range array arithmetic. This is a
structural choice, not a measured register, spill, memory or latency advantage.
Both integer candidates matched the selected physical controls. Built-in
`fma` is a refuted language control; separate public mul/add or implicit CPU
execution is not a preserving fallback.

[Research #269](https://github.com/isaacperez/tabgrad/issues/269), its
[reproducible proposal and evidence](https://github.com/isaacperez/tabgrad/issues/269#issuecomment-6122186220),
[independent challenge](https://github.com/isaacperez/tabgrad/issues/269#issuecomment-6122201150)
and [exact acceptance](https://github.com/isaacperez/tabgrad/issues/269#issuecomment-6122692428)
support this decision. The exact reference forms a BigInt signed product and
sum before nearest-even quantization. It is independent of the CPU float64
response. The selected corpus covers normal and exceptional values,
cancellation, alignment distances, midpoint residuals, overflow, empty work
and launch boundaries. The native CPU semantic reference does not establish
native CUDA scheduling or all native GPU-build arithmetic.

Physical prototype qualification is limited to the recorded Chrome/Apple
nonfallback environment. Coefficient capture and pre-submit drain controls
qualify a physical pattern, not the complete optimizer, worker, failure-ledger
or frontend lifecycle. Those owners require actual integration evidence.
Counted buffers do not measure shader-private memory, registers, spills, RSS
or VRAM. Candidate timing and payload attribution remain unresolved; no
temporal winner or equivalence follows from the observations.

Revisit the response if native-valid observations contradict the numerical
contract, actual integration cannot preserve immutable capture or ownership,
or qualification on a different build or adapter changes the supported
policy. Preserve contrary results. An equivalent physical optimization still
needs numerical, lifecycle and adequate cost qualification; tolerance changes
or new input exclusions cannot conceal a known discrepancy.
