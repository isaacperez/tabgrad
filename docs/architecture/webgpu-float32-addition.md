# Numerical contract for WebGPU float32 addition

Choosing a graphics processor does not by itself define how an operation treats
rounding, very small numbers, infinities or invalid results. A shader can execute
successfully while producing a result that violates the tensor operation's
meaning. Tabgrad therefore distinguishes the numerical contract from the kernel
used to implement it.

This decision defines tensor-only, equal-shape, contiguous `float32` addition on
an explicitly selected WebGPU target. It explains what an implementation must
preserve, why native shader addition alone is not a sufficient portable guarantee,
and where optimization remains possible. It is an architectural requirement,
not a statement that a release implements or qualifies the operation. Release
claims follow the [compatibility rules](../compatibility.md).

## Start from the stored operands

A `float32` value is a number encoded in the 32-bit binary floating-point format
also called binary32. Only a finite set of real numbers can be represented, so
an exact arithmetic result may lie between two representable values. **Rounding**
chooses the stored result. This contract uses the nearest value, resolving an
exact halfway case toward the value whose significand has an even low bit. This
is round-to-nearest, ties-to-even; it does not mean rounding to an even integer.

The operands here are the values already stored as float32, after tensor
creation has performed its own conversion. This addition contract does not
redefine how a Python number, JavaScript number or serialized value becomes a
tensor element. Separating these boundaries prevents a conversion difference
from being mistaken for a kernel rounding difference.

Binary32 also includes signed zeros, infinities and NaNs (not-a-number values).
Near zero it can represent **subnormal** numbers, whose precision decreases as
their magnitude decreases. Preserving those values is called gradual underflow;
replacing them immediately with zero is called flushing to zero. These are
observable differences, including when a later operation consumes the result.

## The required result

For each pair of corresponding stored operands, addition follows these rules:

| Case | Required result |
| --- | --- |
| Finite operands | Add their exact values and round once to binary32 with round-to-nearest, ties-to-even. |
| Subnormal operand or result | Preserve it according to that rounding rule; do not flush it to zero. |
| Overflow | Produce the appropriately signed infinity when nearest-even rounding overflows binary32. |
| Two negative zeros | Negative zero. |
| Oppositely signed zeros or exact cancellation | Positive zero. |
| Infinity plus a finite value, or same-sign infinities | The infinity with that sign. |
| Opposite infinities | NaN. |
| Either operand is NaN | NaN. |

NaN is a category guarantee, not a promise to preserve its payload bits, sign or
signaling distinction. A canonical quiet NaN is permitted. IEEE exception flags,
traps and a configurable floating-point rounding environment are not part of
the contract.

The rule applies to **each logical addition**, not just the final observation.
For example, in `(a + b) + c`, the result of `a + b` has the required binary32
rounding and exceptional-value behavior before becoming the next operand.
Removing an intermediate allocation does not remove that semantic boundary.
Scalar tensors have one such element; empty tensors have no elements to add and
retain the ordinary shape and lifecycle rules.

The domain does not include broadcasting, promotion to another dtype, a scaled
addition argument, mutation, transfer semantics or GPU differentiation. Other
operation families define their own precise numerical domains. In particular,
this decision does not prescribe a reduction order for a sum or matrix product,
require integer emulation for every GPU kernel, or promise universal bitwise
agreement between all CPU and GPU computations.

## Why native addition is not the contract

The [WGSL floating-point rules](https://www.w3.org/TR/2026/CRD-WGSL-20260921/#floating-point-evaluation)
allow behavior broader than these requirements: rounding is not universally
nearest-even, subnormals may be flushed, zero sign may be disregarded, and
non-finite values and overflowing runtime expressions have weaker guarantees.
Transformation permissions also matter when expressions are combined. A result
observed on one adapter cannot strengthen the portable language contract.

Conversely, the
[PyTorch numerical-accuracy guidance](https://docs.pytorch.org/docs/2.14/notes/numerical_accuracy.html)
does not promise universal bitwise equality across platforms or mathematically
equivalent computations. That limitation is not a substitute for defining the
result of this bounded Tabgrad operation. The chosen rule is explicit so that
implementations and tests can evaluate the same requirement.

The alternatives differ in what they guarantee, not just in speed:

| Alternative | Benefit | Consequence |
| --- | --- | --- |
| Accept native WGSL behavior | Small, direct kernels using native arithmetic. | Exposes weaker numerical semantics than the chosen operation contract. |
| Restrict native execution to a proven safe domain | May avoid extra arithmetic for qualifying inputs. | Needs sound domain proofs or backend checks and a defined result outside that domain; ordinary finite inputs alone do not prove every rounding requirement. |
| Guarantee the full bounded contract | Stable operation meaning across admitted inputs. | May require extra backend arithmetic and must account for its cost. |
| Combine native and corrective paths | Can preserve the same strong contract while specializing work. | Correctness and profitability of classification and correction must be established, not assumed. |

Tabgrad chooses the full bounded contract. This fixes the semantics, not a
permanent algorithm. Native, hybrid or integer implementations are eligible when
they demonstrably preserve it. A checked-domain optimization cannot turn an
otherwise valid input into an undocumented numerical restriction.

## Keep numerical meaning in the existing owners

The common runtime's `OperationDefinition` owns operation meaning. Program
formation and semantic lowering must retain the constraints needed to preserve
that meaning. Backend preparation chooses physical kernels for the selected
target; it does not silently weaken the operation to match a device's easiest
arithmetic path. The existing
[backend contract](backend-execution.md) and
[program representation](internal-representations.md) supply these boundaries.

No separate numerical manager, public policy toggle or parallel intermediate
representation is required for this fixed contract. Relevant semantic changes
belong in operation/lowering versions and the program's semantic requirements;
physical changes belong in compiler, kernel and capability fingerprints used by
preparation. Reuse must not mix prepared work with different numerical meaning.
This uses the existing [reuse identity](reusable-programs.md), not a second
cache-identity system.

Operation admission remains metadata-based. It must not scan tensor payloads
on the host to select an arithmetic policy. A future domain-specialized kernel
could use a sound compact proof or a backend-local check where justified, but
that is an implementation option requiring its own evidence, not a new required
admission mechanism.

Fusion, resident intermediates and scratch reuse remain legal. A fused kernel
may avoid a dispatch or buffer while preserving each logical result. Arbitrary
reassociation, contraction or increased intermediate precision is not
automatically legal when it changes the required rounding, zero sign, infinity
or NaN category. The semantic runtime establishes legality; the backend judges
profitability. Preserving this distinction supports optimization without
making correctness depend on whether an expression happened to be fused.

## Evidence behind the choice

The [accepted research decision](https://github.com/isaacperez/tabgrad/issues/98#issuecomment-5857720548)
records the comparison, review and limitations; the
[original numerical probe](https://github.com/isaacperez/tabgrad/issues/98#issuecomment-5854509583)
contains public experimental evidence. An integer candidate established sampled
feasibility against an independent oracle, including chains and exceptional
values. Sampling is not exhaustive binary32 conformance and does not establish
a production backend's integration or browser coverage.

A separate bounded timing study found a material cost in one qualified resident
workload: 4,194,304 elements, eight additions per chain and 16 repeated chains
per batch. Across 21 paired observations, native and candidate medians were
25.0 ms and 44.6 ms, with a median paired ratio of about 1.77. These were
host-observed encoding, submission and completion times, excluding preparation,
upload and readback, not isolated shader times or complete model latency.

Only that workload qualified after calibration; no scaling conclusion follows.
It used ordinary finite inputs, one browser/device environment, and diagnostics
showed background activity whose timing effect is unknown. The fresh timing
artifacts were reviewed locally but are not a public reproduction package;
the original linked probe must not be presented as reproducing the newer timing
method. Detailed method and availability limits belong in the linked research
record rather than a benchmark matrix in this architectural document.

The decision accepts the observed tradeoff without setting a general performance
budget. It neither promises near-native speed nor assigns a fixed percentage
overhead to models. Equivalent optimization is welcome, but its value requires
comparable evidence under the [performance methodology](../performance.md).

## Consequences and reconsideration

An implementation needs evidence for finite rounding boundaries, subnormals,
zeros, overflow, infinities, NaNs and chained results, alongside resource and
integration correctness. An average error tolerance cannot establish an exact
rounding rule. NaN payload identity must not accidentally become a stronger
requirement through a raw-bit assertion. Qualification must distinguish those
numerical tests from realistic cost measurements and from browser support.

The contract should be reconsidered explicitly if representative measurements
show an unacceptable cost for the intended use, if a target cannot implement it
within supported constraints, or if requirements change. A faster equivalent
kernel needs verification, not a new public numerical choice. A proposal to
weaken observable results is a different decision and must explain compatibility
consequences; it cannot be introduced silently as an optimization.
