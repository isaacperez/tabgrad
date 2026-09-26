# Elementwise tensor multiplication

This reference is for Python and JavaScript users composing tensor products,
and contributors maintaining the operation. Elementwise multiplication pairs
corresponding elements: two tensors of shape `[2, 3]` produce six products with
that same shape. It is not matrix multiplication, which combines elements
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
result has the same shape, dtype and device as its inputs; `await result.toArray()`
returns the ordinary independent flat `Float32Array`. Close JavaScript handles
and their session under the existing explicit lifetime contract.

The supported domain is two equal-shape contiguous CPU float32 tensors in one
session. It includes scalar tensors, every supported contiguous rank,
singleton and empty dimensions, and whole-contiguous views. Shape equality
compares every dimension: equal element counts, or broadcastable unequal
shapes, are insufficient. Two rank-zero tensors multiply normally; a tensor
and a Python or JavaScript number do not. The result owns distinct logical
storage and never mutates either input or a live alias.

Broadcasting, host-number operands, promotion, other dtypes or devices,
non-contiguous layouts, gradients, in-place multiplication, output-buffer
mutation and `multiply` aliases are outside this contract. PyTorch supports
many of these forms; their rejection is Tabgrad's intentional subset boundary.

## Admission and resource ownership

Python normalizes syntax and passes opaque handles. The canonical runtime
definition shares equal-shape binary admission with addition, checks handles,
open lifetimes, session ownership and metadata, then records two ordered input
occurrences and one new value. The same input in both positions still contributes
two occurrences. Admission neither scans tensor elements nor prepares or calls
a numerical backend. Its work depends on operand and rank metadata.

Views, addition, multiplication and total sum compose before observation.
Observation selects a finite graph using the common
[program formation owner](../components/program-formation.md), then invokes the
selected CPU kernels. Closing input handles after admission preserves a pending
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
context. The [CPU storage contract](../components/cpu-invocation-storage.md)
owns those shared rules.

## Numerical behavior

Each element is multiplied in float32. Products can round, underflow to signed
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

## Errors and the kernel contract

Malformed Python calls, non-tensor operands and invalid receivers raise
`TypeError`. Unequal tensor shapes and non-None functional `out` raise
`RuntimeError`. Closed or incompatible runtime ownership retains its structured
runtime code through `JsException`. JavaScript invalid handles fail with
`INVALID_TENSOR`, closed state with `CLOSED_TENSOR` or `CLOSED_SESSION`, mixed
sessions with `DIFFERENT_SESSION`, and unequal shapes with `SHAPE_MISMATCH`.
Incorrect JavaScript arity raises `TypeError`. Rejection records no operation
or numerical request.

The private raw export is
`tabgrad_mul_f32(left_offset, right_offset, output_offset, length) -> status`.
The scalar and SIMD modules share the unsigned 32-bit ABI and range validation.
Every range must be four-byte aligned, start at or above the host arena, and
fit in memory. Output must not overlap either nonempty input; repeated or
overlapping read-only inputs are legal. Zero length reads and writes nothing,
including when all offsets are at memory's end. Status and module validation
follow the [CPU ABI reference](../architecture/webassembly-cpu-backend.md#version-1-raw-abi-and-module-capabilities).

The kernel performs linear work with constant local state and no input-sized
scratch. SIMD processes four elements at a time and a scalar tail of up to
three. Required materialization, output storage, upload and readback remain
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
