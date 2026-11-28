# Python tensor creation, metadata, addition and observation

This reference defines the bounded tensor-admission interface provided by
Tabgrad's installed Python `torch` package. It is intended for programmers who
know Python but need to distinguish familiar PyTorch spellings from the precise
behavior Tabgrad accepts. The package runs inside a host-supplied Pyodide
interpreter attached through the [script binding](../components/python-script-binding.md).
It is not the official PyTorch runtime.

CPU first-order `Tensor.backward()` and read/write `Tensor.grad` are specified
in the [backward reference](backward-gradients.md), including calling forms,
warning categories, identity, reset and lifetime.

`torch.optim.SGD` is described in the [SGD reference](sgd.md), including basic
CPU and enabled GPU groups, closures, numeric reset and the explicit optimizer exclusions.

For `torch.matmul`, `Tensor.matmul`, `@`, matrix geometry, both first-order
gradients and numerical differences, use the [matrix product reference](tensor-matmul.md).

The [wrapper component](../components/python-tensor-wrappers.md) explains the
owners behind these calls. This page covers creation, metadata, addition
admission and ordinary observation, not general PyTorch support. GPU use
requires the explicit [managed connection](python-host.md#acquire-a-managed-gpu-connection).
See [tensor dtypes by operation](../compatibility.md#tensor-dtypes-by-operation)
for the supported types and devices.

Shape-only `Tensor.view` has its own [operation reference](tensor-view.md),
covering syntax, inference, errors and storage sharing.
Total reduction has its own [sum reference](tensor-sum.md), covering
`Tensor.sum()` and `torch.sum(input)`, scalar results and numerical limits.
Elementwise products use `*`, `Tensor.mul(other)` or `torch.mul(input, other)`;
the [multiplication reference](tensor-multiplication.md) owns their signatures,
broadcast-compatible domain and numerical limits.
The [functional gradient reference](functional-gradients.md) defines
`torch.autograd.grad`, tracked creation and first-order result ownership.

`Tensor.copy_(other, non_blocking=False)` has its own
[persistent copy reference](tensor-copy.md), covering identity, alias updates,
recording, saved-version guards and deferred execution.

## Create a tensor

```python
import torch

left = torch.tensor([1.0, 2.0], dtype=torch.float32, device="cpu")
right = torch.tensor((3, 4), dtype=torch.float32)
```

The accepted form is
`torch.tensor(data, *, dtype, device='cpu', requires_grad=False, pin_memory=False)`.
Pass the dtype explicitly.

- `data` must be a built-in `int`, `float` or `bool`, or a rectangular nested
  structure of built-in lists/tuples containing those types. A numeric scalar
  produces shape `()`. Empty input produces shape `(0,)`; `[[], []]` produces
  `(2, 0)`. Nesting cannot imply dimensions after an empty sequence.
- Select the canonical `torch.float32`, `torch.float16`, `torch.bfloat16`, `torch.bool`,
  `torch.int32` or `torch.int64` object. The [dtype table](../compatibility.md#tensor-dtypes-by-operation)
  lists the supported operations.
- The device may be the string `'cpu'` or `'webgpu'`, or the corresponding
  `torch.device` descriptor. CPU is the default even with GPU attached.
  `webgpu` is a Tabgrad extension, not an upstream PyTorch device name.
- Gradient and pinned-memory flags must be booleans. `requires_grad=True`
  enables float32 tracking; `pin_memory` must remain false.
  CPU and WebGPU support tracking for [functional gradients](functional-gradients.md)
  and [backward accumulation](backward-gradients.md).
- Creation converts to the selected dtype and owns a copy. Later input mutations cannot
  change the tensor. Integer overflow during floating conversion raises `OverflowError`.
  [Boolean creation](#create-and-read-boolean-tensors) keeps the
  original integer's truth value.
- Ragged inputs, mixed numerical/container depth and cycles are rejected.
  Reusing an acyclic child container is allowed and copies its values at each
  occurrence. No partially admitted tensor survives an invalid input.
- Custom numeric/container classes, other dtypes,
  indexed/other devices and additional keywords are outside this contract.

Use `torch.tensor`, not `torch.Tensor(...)`. The latter constructor is rejected;
an opaque handle cannot be manufactured by a public constructor.

## Bfloat16 tensors

Use `torch.bfloat16` when you need the exponent range of float32 with a
two-byte tensor format. Values are converted through float32 and then rounded
to bfloat16, with ties to even. For example, `torch.tensor([1.0, 2.0], dtype=torch.bfloat16)`
creates a CPU tensor and `tensor.tolist()` returns the stored values as Python numbers.
In JavaScript, the corresponding option is `{ dtype: "bfloat16" }`; numeric
observation returns decoded values in a `Float32Array`.

CPU and WebGPU support whole-storage views, same-dtype addition and
multiplication with broadcasting, [total sum](tensor-sum.md#bfloat16-on-cpu-and-webgpu)
and [2D matrix products](tensor-matmul.md#numerical-and-resource-boundaries).
Pointwise operations round to float32 before storing each bfloat16 result.
Bfloat16 supports forward operations. Gradients, in-place mutation and
optimizers require float32.

## Create and read boolean tensors

Python accepts explicit `dtype=torch.bool` in [tensor creation](#create-a-tensor).
JavaScript accepts `{ dtype: "bool" }` with flat primitive booleans and
numbers. Numeric zero becomes false. Nonzero values, infinities and NaN
become true. Python `tolist()` returns Python booleans and preserves the
ordinary scalar, empty and list shape rules. JavaScript `toArray()` returns
numeric zeros and ones. Use `await mask.toArray({ format: "typed" })` for an
independently owned `Uint8Array` containing zeros and ones.

Masks support [shape-only views](tensor-view.md). Boolean gradient tracking
and in-place updates are outside this interface. See the [operation table](../compatibility.md#tensor-dtypes-by-operation)
for qualified signatures.

## Greater-than comparison

```python
import torch

scores = torch.tensor([[1.0], [4.0]], dtype=torch.float32)
thresholds = torch.tensor([0.0, 2.0, 5.0], dtype=torch.float32)
mask = torch.gt(scores, thresholds)
print(mask.tolist())  # [[True, False, False], [True, True, False]]
```

`torch.gt(input, other)`, `input.gt(other)`, and `input > other` compare
two same-device contiguous float32 tensors. Shape broadcasting
follows the [shared rules](../architecture/broadcasting.md#operation-policies-and-a-common-engine)
and includes scalar tensors and empty dimensions. The result is a new
`torch.bool` tensor on the same device. Tracked float32 operands are allowed
and the result has no gradient history. Both signs of zero compare equal,
finite float32 values retain their ordering including subnormals, and a
comparison with either NaN returns false. The tensor forms cover CPU and
WebGPU. Python number operands, `out` and mixed dtypes are outside this scope.

JavaScript exposes the same signature as `scores.gt(thresholds)`.
Compare against another tensor, using shape `[]` for a scalar tensor if
needed. The result keeps the usual asynchronous observation path.

## Select with a boolean mask

```python
import torch

scores = torch.tensor([[1.0], [4.0]], dtype=torch.float32)
thresholds = torch.tensor([0.0, 2.0, 5.0], dtype=torch.float32)
mask = torch.gt(scores, thresholds)
values = torch.where(mask, scores, torch.tensor(0.0, dtype=torch.float32))
print(values.tolist())  # [[1.0, 0.0, 0.0], [4.0, 4.0, 0.0]]
```

`torch.where(condition, input, other)` broadcasts the three shapes together.
A true condition selects from `input` and a false condition selects from
`other`. The condition is a contiguous bool tensor and both alternatives
are contiguous float32 tensors. All three belong to the same session and
device. The new float32 tensor can have scalar shape or empty axes. The
selected value preserves the sign of zero, subnormals and infinities.
A selected NaN remains NaN.
This form takes three tensor arguments and creates its own output.

With gradient recording enabled, each selected seed contributes to its
float32 branch and each unselected position contributes positive zero.
The mask has no gradient. Broadcasted branches receive a sum over their
expanded axes using the existing receiving reduction for that device.
This arithmetic can differ across CPU, WebGPU and native PyTorch under
cancellation or overflow. For example, the expanded seed
`[1e20, 1, -1e20, 1]` in a fully selected scalar branch reduces to `0` on
CPU and `2` on WebGPU. See the
[boolean selection contract](../architecture/typed-tensors.md#boolean-masks-and-selection).

Use `session.where(mask, input, other)` in JavaScript. A mask made by
`gt` can feed selection directly on either device before observation.

## Find the index of a maximum

```python
import torch

scores = torch.tensor([[2, 5, 5], [8, 7, 9]], dtype=torch.float32)
print(torch.argmax(scores, dim=1).tolist())  # [1, 2]
```

`torch.argmax(input, dim=None, keepdim=False)` and `input.argmax(dim, keepdim)`
accept contiguous float32, int32 and int64 on CPU and WebGPU. The result is
a new int64 tensor on the input's device. It has no gradient history.
Omit `dim` to search the whole tensor in row-major order. A negative axis
counts from the end. `keepdim=True` retains singleton dimensions. A scalar
returns a scalar zero, and a reduction over an empty axis raises `IndexError`.
If another axis is empty and the reduced axis has values, the result is empty.

Equal maxima use the first index, as do multiple NaN values. A NaN takes
precedence over a numerical value. The free function also accepts `out=None`.
Declare an integer axis as a Python `int`.

## Select values along an axis

```python
rows = torch.tensor([[10, 11], [20, 21]], dtype=torch.float32)
positions = torch.tensor([1, 0, 1], dtype=torch.int64)
print(torch.index_select(rows, 0, positions).tolist())
# [[20.0, 21.0], [10.0, 11.0], [20.0, 21.0]]
```

Use `torch.index_select(input, dim, index)` or `input.index_select(dim, index)`.
The source can be contiguous float32, int32 or int64. The index is a contiguous
int32 or int64 scalar or vector in the same session and on the same device.
The result has its own storage and retains the source dtype. Along the selected
axis, it contains one position per index, in the order supplied. Repeated indices
repeat the corresponding slices. A scalar source accepts one zero index and
returns a scalar. The free function accepts `out=None`.

You can use a negative dimension. Every index value must be nonnegative and
less than the length of the selected axis. Bad arguments and impossible shapes
fail at the call. Index values are checked when an observation or an effect such
as `copy_` needs the result. For example, `invalid.tolist()` can raise after a
successful `index_select` call. This also applies when a different axis makes
the output empty. The pinned PyTorch CPU exceptions determine whether an
out-of-range value raises `IndexError` or `RuntimeError`.

The operation supports forward computation. If the input tracks gradients,
use `torch.no_grad()` to select from it. An int64 result from
[`argmax`](#find-the-index-of-a-maximum) can feed selection on the same device
without reading the indices into the host.

## Create and read signed integer tensors

Use `dtype=torch.int32` or `dtype=torch.int64` for exact signed integers.
`torch.int` and `torch.long` are aliases. An int64 tensor holds values from
`-2**63` through `2**63 - 1`, including consecutive integers above `2**53`.
`tolist()` returns Python integers, including a single integer for a scalar.
Integer tensors support whole contiguous views and reject `requires_grad=True`.
For construction from finite floats, Tabgrad checks the signed range before
truncating toward zero. See the
[signed integer contract](../architecture/typed-tensors.md#signed-integer-tensors-and-indexing)
for overflow categories and representation.

## Read metadata

`tensor.shape`, `tensor.dtype`, `tensor.device` and `tensor.requires_grad` are read-only properties.
Their content comes from the runtime on each access; a closed handle cannot
serve cached metadata.

| Property | Python presentation | Bounded behavior |
| --- | --- | --- |
| `shape` | `torch.Size`, an immutable integer tuple | Iteration, indexing, tuple equality/hash, representation, slicing, concatenation, repetition and `numel()` |
| `dtype` | The selected canonical `torch.dtype` constant | Identity, representation, read-only `is_floating_point`, `is_complex` and `is_signed`. Bool has all three properties false. |
| `device` | A `torch.device` object for the runtime's device | Equality with the same device name, hashing, representation, string form, read-only `type` and `index=None`; supported names are `cpu` and `webgpu` |
| `requires_grad` | Python `bool` | Advertised tracking; propagation follows the [recording mode and view rules](gradient-recording.md), and functional gradients return untracked tensors |

`torch.Size(iterable)` uses integer-index conversion, including Python booleans;
`numel()` is the product of its dimensions, with the empty product equal to one.
Constructing a `Size` does not create a tensor or validate a storage layout.
`torch.dtype()` is not constructible. The device constructor accepts the two
unindexed names above, not other device types, indices, context management or
transfer requests. Constructing a descriptor does not acquire a backend.

## Admit addition

The following spellings reach the same canonical runtime operation:

```python
functional = torch.add(left, right)
method = left.add(right)
operator = left + right
```

`torch.add(input, other, *, alpha=1, out=None)` and
`Tensor.add(other, *, alpha=1)` require two broadcast-compatible tensors in
one session on the same device. Both operands must use the same dtype: `float32`,
[`float16`](float16.md) or [`bfloat16`](#bfloat16-tensors). The result keeps that dtype.
GPU admission also requires an attached, ready backend that supports the
selected dtype for addition.
Align dimensions from the right: each pair must be equal or include a
singleton; missing leading axes act as singletons. Thus `[2, 1]` plus `[3]`
produces `[2, 3]`, and a scalar tensor can pair with a vector or matrix.
Zero with one produces zero; all other axes must still be compatible.
There is no Python-number operand, promotion or in-place result. The inferred
output has its own device-capacity check. [Broadcasting](../architecture/broadcasting.md)
also defines how gradients reduce to the complete original input shape.
The numeric `alpha` value must equal one and cannot be a boolean. Only the
functional spelling accepts `out`, and only its `None` value is accepted.

Addition validates synchronously and records deferred work. It does not demand
numerical execution. Python wrappers pass handles, not numerical arrays, to
the runtime. A result retains the input values it needs even when their Python
wrappers become ordinary expression temporaries.

Tensor `+` returns `NotImplemented` for an unrecognized right-hand operand so
Python can try that operand's reflected method. This is dispatch behavior, not
support for host-number operands. An unresolved operator raises Python's normal
`TypeError`.

## Observe numerical values

`Tensor.tolist()` takes no arguments and returns a Python float or bool for a
scalar, or independent Python lists holding those values for higher rank.
Its return annotation is recursive: `float | bool | list[TensorList]`, where
`TensorList` denotes that same union. A vector returns a flat list.
Empty dimensions preserve the outer structure: `(2, 0)` returns `[[], []]`,
whereas `(0, 3)` returns `[]`. The tensor's `shape` remains authoritative when
the returned structure cannot express trailing empty dimensions.
The tensor must belong to this binding's session, and the call must occur inside
its managed `runPythonAsync` entry. Ordinary nested functions and branches can
use the returned list without an `await` or JSPI. There is no `tolist_async`
extension. This does not add scalar `item()` or other operations.

```python
values = (left + right).tolist()
if values == [4.0, 6.0]:
    assert left.tolist() == [1.0, 2.0]
```

Observation demands the recorded computation through the same request owner
used by JavaScript `Tensor.toArray()`. Repeated observation reuses a computed
materialization but creates independent returned containers; modifying a row
cannot change the tensor, another row or a later observation. Ready host values are copied directly by the
runtime, without uploading them to CPU memory solely to read them back.

The [runtime observation component](../components/runtime-observation.md)
explains preparation, progression and copying. During ordinary observation,
the interpreter does not yield to other Python tasks. The managed script may
use unrelated explicit await points but must join its tasks before returning.
The host must not drive raw interpreter calls concurrently with that entry.

## Errors and resource ownership

Invalid container/element forms, mixed nesting depth, non-boolean flags, non-tensor addition operands,
unexpected keywords and non-integer `Size` elements raise `TypeError`.
Unsupported dtype/device/pinned-memory/alpha/out choices raise
`RuntimeError`. A shape mismatch also raises `RuntimeError`, chained from the
runtime rejection; exact error wording is not a compatibility claim.
Inconsistent sibling lengths and cyclic input raise `ValueError`. Rectangular
input is an intentional Tabgrad requirement even where the pinned PyTorch
oracle accepts an irregular input beginning with an empty sequence. This is
not a promise to reproduce native treatment of every malformed container.

Closed tensors/sessions, foreign-session handles and invalid runtime handles
preserve `pyodide.ffi.JsException`. Its `js_error.code` distinguishes
`CLOSED_TENSOR`, `CLOSED_SESSION`, `DIFFERENT_SESSION` and `INVALID_TENSOR`.
These are Tabgrad lifecycle contracts, not native PyTorch error classes.
The private `_handle` and factory mechanics are not user-facing escape APIs.

Outside an active managed entry, ordinary observation rejects with
`PYTHON_SYNC_CONTEXT_REQUIRED` before demanding numerical work, including for
ready host data. The error remains a `JsException`; inspect `js_error.code`,
not a substring of its formatted traceback. Local CPU execution and readback
failures preserve the backend code, phase, cause and internal causal program
context. Remote physical failures use the bounded projection described below.
The internal runtime observer can reject
`SYNCHRONOUS_OBSERVATION_UNAVAILABLE` before admission when local readiness is
absent or an asynchronous predecessor still owns the queue. Managed CPU entry
establishes readiness before Python starts; that internal guard is not a JSPI
requirement or a second Python API.

Managed GPU observation consumes authoritative shared completion from the
independently progressing physical worker. It may park the interpreter, but
does not require a local Promise callback to advance the calculation. GPU
addition, [multiplication](tensor-multiplication.md), total sum, shape-only views
and functional gradients share the ordinary runtime path.
[Backward and persistent gradient slots](backward-gradients.md) use that same
path, including immediate ordinary Python observation. [Basic SGD](sgd.md)
supports enabled WebGPU parameters and same-device gradients within its
[qualified GPU environment](../compatibility.md#gpu-sgd-evidence). Dimensional
reduction and broader optimizer options and modes remain outside the declared domains.
Missing backend or unsupported computation is an explicit capability error,
not implicit CPU execution.

Physical GPU errors cross a bounded diagnostic boundary: code, message,
scalar backend/phase/program-slot locators and the immediate native cause's
name/message survive, with explicit truncation when needed. The cause is a
reconstructed diagnostic, not the original remote exception object, stack or
nested cause graph. The local runtime still attaches its causal invocation context.
This differs from a local CPU failure's directly retained cause; applications
must inspect available fields rather than assume remote object identity.

Ordinary Python temporary wrappers release their runtime handles without
manual per-expression close. Cycles and retained tracebacks follow their actual
Python owners. The host closes the script binding to drain session resources;
keeping old Python references does not allow them to rebind to a fresh session.

## Compatibility evidence boundary

[`python-tensor-oracle.json`](../../js-tests/fixtures/python-tensor-oracle.json)
names PyTorch 2.14.0's actual wheel revision and source tag, and Pyodide 314.0.6's
source revision. Its maintained generator records finite/empty/float32-edge
addition results, scalar and nested result structures, metadata and selected
native error classes. Other rejection
tests explicitly exercise Tabgrad-only limits; they must not be described as
matching PyTorch's much larger supported surface.

The CPU scalar/SIMD kernel contract, Python interpreter support and a release's
published API coverage are separate evidence dimensions. Agreement on these
fixtures alone is not a claim about all PyTorch operations or browsers.
