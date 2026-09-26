# Python tensor creation, metadata, addition and observation

This reference defines the bounded tensor-admission interface provided by
Tabgrad's installed Python `torch` package. It is intended for programmers who
know Python but need to distinguish familiar PyTorch spellings from the precise
behavior Tabgrad accepts. The package runs inside a host-supplied Pyodide
interpreter attached through the [script binding](../components/python-script-binding.md).
It is not the official PyTorch runtime.

The [wrapper component](../components/python-tensor-wrappers.md) explains the
owners behind these calls. This page covers creation, metadata, addition
admission and ordinary CPU observation, not general PyTorch support.
Release claims follow the [compatibility policy](../compatibility.md).

Shape-only `Tensor.view` has its own [operation reference](tensor-view.md),
covering syntax, inference, errors and storage sharing.
Total reduction has its own [sum reference](tensor-sum.md), covering
`Tensor.sum()` and `torch.sum(input)`, scalar results and numerical limits.

## Create a tensor

```python
import torch

left = torch.tensor([1.0, 2.0], dtype=torch.float32, device="cpu")
right = torch.tensor((3, 4), dtype=torch.float32)
```

The accepted form is
`torch.tensor(data, *, dtype=torch.float32, device='cpu', requires_grad=False, pin_memory=False)`.
The explicit dtype argument is required by policy even though omission can be
bound by Python: there is no silent inference of an integer or default dtype.

- `data` must be a built-in `int`, `float` or `bool`, or a rectangular nested
  structure of built-in lists/tuples containing those types. A numeric scalar
  produces shape `()`. Empty input produces shape `(0,)`; `[[], []]` produces
  `(2, 0)`. Nesting cannot imply dimensions after an empty sequence.
- The only accepted dtype is the `torch.float32` object, not its string name.
- The device may be the string `'cpu'` or a `torch.device('cpu')` descriptor.
- Gradient and pinned-memory flags must be booleans and must be false.
- Creation converts to float32 and owns a copy. Later input mutations cannot
  change the tensor. Integer overflow during conversion raises `OverflowError`.
- Ragged inputs, mixed numerical/container depth and cycles are rejected.
  Reusing an acyclic child container is allowed and copies its values at each
  occurrence. No partially admitted tensor survives an invalid input.
- Custom numeric/container classes, other dtypes,
  indexed/non-CPU devices and additional keywords are outside this contract.

Use `torch.tensor`, not `torch.Tensor(...)`. The latter constructor is rejected;
an opaque handle cannot be manufactured by a public constructor.

## Read metadata

`tensor.shape`, `tensor.dtype` and `tensor.device` are read-only properties.
Their content comes from the runtime on each access; a closed handle cannot
serve cached metadata.

| Property | Python presentation | Bounded behavior |
| --- | --- | --- |
| `shape` | `torch.Size`, an immutable integer tuple | Iteration, indexing, tuple equality/hash, representation, slicing, concatenation, repetition and `numel()` |
| `dtype` | The `torch.float32` constant of type `torch.dtype` | Identity, representation, read-only `is_floating_point=True`, `is_complex=False`, `is_signed=True` |
| `device` | A `torch.device('cpu')` object | Equality with CPU descriptors, hashing, representation, string form, read-only `type='cpu'` and `index=None` |

`torch.Size(iterable)` uses integer-index conversion, including Python booleans;
`numel()` is the product of its dimensions, with the empty product equal to one.
Constructing a `Size` does not create a tensor or validate a storage layout.
`torch.dtype()` is not constructible. The device constructor accepts only a CPU
string, not other device types, indices, context management or transfer requests.

## Admit addition

The following spellings reach the same canonical runtime operation:

```python
functional = torch.add(left, right)
method = left.add(right)
operator = left + right
```

`torch.add(input, other, *, alpha=1, out=None)` and
`Tensor.add(other, *, alpha=1)` require two equal-shape CPU float32 tensors.
There is no broadcasting, Python-number operand, promotion or in-place result.
Two scalar tensors can be added; a scalar tensor and a one-element vector
cannot. Every dimension must match, even for tensors with zero elements.
The numeric `alpha` value must equal one and cannot be a boolean. Only the
functional spelling accepts `out`, and only its `None` value is accepted.

Addition validates synchronously and records deferred work. It does not demand
numerical execution. Python wrappers pass handles, not numerical arrays, to
the runtime. A result retains the input values it needs even when their Python
wrappers become ordinary expression temporaries.

Tensor `+` returns `NotImplemented` for an unrecognized right-hand operand so
Python can try that operand's reflected method. This is dispatch behavior, not
support for scalar broadcasting. An unresolved operator raises Python's normal
`TypeError`.

## Observe numerical values

`Tensor.tolist()` takes no arguments and returns a Python float for a scalar,
or independent nested Python lists with floating-point leaves for higher rank.
Its return annotation is recursive: `float | list[TensorList]`, where
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
Unsupported dtype/device/gradient/pinned-memory/alpha/out choices raise
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
not a substring of its formatted traceback. Execution and readback failures
preserve the backend code, phase, cause and internal causal program context.
The internal runtime observer can reject
`SYNCHRONOUS_OBSERVATION_UNAVAILABLE` before admission when local readiness is
absent or an asynchronous predecessor still owns the queue. Managed CPU entry
establishes readiness before Python starts; that internal guard is not a JSPI
requirement or a second Python API.

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
