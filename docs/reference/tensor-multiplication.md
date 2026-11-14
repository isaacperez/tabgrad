# Elementwise tensor multiplication

This reference is for Python and JavaScript users composing tensor products,
and contributors maintaining the operation. Elementwise multiplication pairs
corresponding elements, reusing singleton axes when needed: `[2, 3]` times
`[3]` produces six products of shape `[2, 3]`. It is not matrix multiplication, which combines elements
along a dimension. Creation and observation follow the
[Python tensor reference](python-tensors.md) and
[JavaScript API](../javascript-api.md).

## Call forms and result

Inside a managed Python entry:

```python
import torch

x = torch.tensor([[2., -3.], [0., 4.]], dtype=torch.float32)
y = torch.tensor([[5., 2.], [7., -1.]], dtype=torch.float32)
product = x * y
assert product.shape == torch.Size([2, 2])
assert product.tolist() == [[10., -6.], [0., -4.]]
assert torch.mul(input=x, other=y).tolist() == product.tolist()
assert x.mul(other=y).sum().tolist() == 0.
```

`Tensor.mul(other)` accepts one tensor positionally or by `other`.
`torch.mul(input, other, *, out=None)` accepts both tensor arguments positionally
or by their names, including `torch.mul(x, other=y)`. The functional form
accepts `out=None` as the ordinary out-of-place default; a tensor output buffer
is rejected. `Tensor.__mul__` implements `*` and returns `NotImplemented` for
an unrecognized right operand so Python can perform reflected dispatch.

JavaScript exposes `left.mul(right)` with exactly one tensor argument. Its
result has the broadcast output shape and its inputs' dtype and device; `await result.toArray()`
returns the ordinary independent flat `Float32Array`. Close JavaScript handles
and their session under the existing explicit lifetime contract.

The supported domain is two broadcast-compatible contiguous float32 tensors on the same
device in one session: CPU, or `webgpu` with an attached ready GPU owner. It
includes scalar tensors, every supported contiguous rank,
singleton and empty dimensions, and whole-contiguous views. Align axes from
the right; each pair must be equal or include a singleton, including missing
leading axes. Zero with one produces zero, without excusing incompatible
axes elsewhere. Equal element counts alone are insufficient. A rank-zero tensor
can multiply any supported tensor; a tensor
and a Python or JavaScript number do not. The result owns distinct logical
storage and never mutates either input or a live alias.

Host-number operands, promotion, other dtypes or device mixing,
non-contiguous layouts, in-place multiplication, output-buffer
mutation and `multiply` aliases are outside this contract. PyTorch supports
many of these forms; their rejection is Tabgrad's intentional subset boundary.

Tracked CPU and WebGPU operands participate in
[functional gradients](functional-gradients.md).
Each tracked input's derivative saves the opposite operand, including when that
operand does not track. Numerical saved values have an independent lifetime
from the forward execution dependencies described below.
The local derivative multiplies the incoming gradient by that captured value
in the output domain. The [shared receiving adapter](../architecture/broadcasting.md)
then reduces it to the original input shape. CPU groups use the ordinary
float32 sum tree; GPU groups use exact integer accumulation with one final
rounding. These can differ from each other and PyTorch, as the linked contract
shows. Seeds and gradient accumulation require exact shapes.
[Backward accumulation](backward-gradients.md) uses this same operation on both devices.

## Admission and resource ownership

Python normalizes syntax and passes opaque handles. The canonical runtime
definition shares pointwise binary admission with addition, checks handles,
open lifetimes, session ownership and metadata, then records two ordered input
occurrences and one new value. The same input in both positions still contributes
two occurrences. Admission neither scans tensor elements nor prepares or calls
a numerical backend. Its work depends on operand and rank metadata.

Views, addition, multiplication and total sum compose before observation.
Observation selects a finite graph using the common
[program formation owner](../components/program-formation.md), then invokes the
selected device kernels. Closing input handles after admission preserves a pending
result. Repeated observation reuses completed numerical work. Abandoned pending
work and completed ancestry follow the shared
[semantic lifetime rules](../components/semantic-value-lifetimes.md).
Ordinary Python `tolist()` works inside managed entry without mandatory JSPI or
a separate asynchronous tensor method.

Input ownership and physical reuse remain distinct. Live aliases and pending
consumers retain their logical values; the backend reuses private scratch only
after all physical input occurrences finish. It allocates an output disjoint
from both inputs before retiring them. Failure rollback preserves unrelated
resident values and records multiplication provenance; a trap quarantines the
CPU context. The [CPU storage contract](../components/cpu-invocation-storage.md)
and [GPU physical owner](../components/webgpu-backend.md) define their respective
reuse, failure and drain rules. GPU multiplication keeps intermediate values
resident. Dense forward multiplication needs only its distinct output;
broadcast forward also owns rank-sized parameters, and receiving reduction
can require staged partials. No expanded input or gather tensor is required.

## Numerical behavior

Each pair of stored binary32 elements has its exact product rounded once to
nearest, ties to even. Products can underflow to signed
zero or overflow to signed infinity. Subnormal values remain part of the
domain. NaN propagates by classification, and zero times infinity produces
NaN; NaN payload bits are not promised. A product followed by addition remains
two operations with a float32 rounding boundary between them, not an incidental
fused multiply-add.

The pinned native PyTorch fixtures compare exact float32 bits for their finite,
zero, subnormal and infinity cases, and compare NaN classification without
payload identity. Inputs cover exactly representable and rounded products,
mixed signs and magnitudes, underflow, overflow and non-finite values. The
separate multiply-add case distinguishes rounding after multiplication from
fusion. These bounded comparisons do not imply universal native/browser bitwise
identity or support for PyTorch's broader operand and dtype rules.

The GPU shader uses integer arithmetic because WGSL floating-point evaluation
permits flushing subnormals and relaxing non-finite and signed-zero behavior.
It normalizes each nonzero finite significand to 24 bits, retains the complete
48-bit product in two unsigned words, and rounds with all discarded bits.
Subnormal output uses the same single rounding step with a larger shift;
normal carry and overflow are applied afterwards. The bounds and carry argument
are local to [the kernel](../../src/backends/webgpu/kernels/multiplication.ts).
The [WGSL evaluation rules](https://www.w3.org/TR/2026/CRD-WGSL-20260921/#floating-point-evaluation)
explain why ordinary shader `f32` multiplication is insufficient for this domain.
An independent BigInt quotient/remainder oracle, calibrated against the native
fixture and binary64 products, exercises exponent pairs, significand boundaries,
all subnormal normalization distances, exceptional values and repeated products
in physical direct and managed GPU tests. This is bounded qualification, not
exhaustive enumeration of all operand pairs or all hardware.

## Errors and the kernel contract

Malformed Python calls, non-tensor operands and invalid receivers raise
`TypeError`. Incompatible tensor shapes and non-None functional `out` raise
`RuntimeError`. Closed or incompatible runtime ownership retains its structured
runtime code through `JsException`. JavaScript invalid handles fail with
`INVALID_TENSOR`, closed state with `CLOSED_TENSOR` or `CLOSED_SESSION`, mixed
sessions with `DIFFERENT_SESSION`, and incompatible shapes with `SHAPE_MISMATCH`.
An inferred output exceeding the device's tensor domain fails with
`RESOURCE_EXHAUSTED` before recording work, even if both inputs fit.
Incorrect JavaScript arity raises `TypeError`. Rejection records no operation
or numerical request.

On CPU the private raw export is
`tabgrad_mul_f32(left_offset, right_offset, output_offset, length) -> status`.
The scalar and SIMD modules share the unsigned 32-bit ABI and range validation.
Every range must be four-byte aligned, start at or above the host arena, and
fit in memory. Output must not overlap either nonempty input; repeated or
overlapping read-only inputs are legal. Zero length reads and writes nothing,
including when all offsets are at memory's end. Status and module validation
follow the [CPU ABI reference](../architecture/webassembly-cpu-backend.md#version-1-raw-abi-and-module-capabilities).

Dense kernels perform linear work with constant local state. Broadcast address
projection uses coalesced rank-sized metadata, a CPU outer odometer with
contiguous/scalar inner runs, and GPU coalesced projection. CPU SIMD processes
four elements per contiguous/scalar inner step and a tail of up to three.
GPU processes four adjacent values per invocation when the shared inner run
is divisible by four, otherwise one. No payload-sized expansion or gather
is introduced. GPU launch geometry is owned by its kernel and guarded at
the output length; empty outputs dispatch no compute pass. Required
materialization, output storage, upload and readback remain
separate costs. Graph formation and retirement preserve their existing linear
bounds in selected values and operand occurrences. Payload counters, aligned
allocator reservations, WebAssembly capacity and process memory are different
quantities; timing and memory claims follow the
[performance policy](../performance.md).

## Evidence

The [native fixture](../../js-tests/fixtures/python-tensor-oracle.json) records
the pinned PyTorch build, source expressions, supported syntax, metadata,
operand/result bits and selected error categories. Its generator uses one
native intra-operation and inter-operation thread. Raw scalar/SIMD, direct
runtime, real Pyodide and Chrome/Firefox browser tests exercise the declared
operation and lifecycle. Intentional subset rejections have separate tests
from native errors. The [compatibility record](../compatibility.md) explains
the limits of this evidence and the requirements for a named release claim.
