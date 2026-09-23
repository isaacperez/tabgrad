# Contiguous tensor views

`Tensor.view` gives an existing contiguous CPU float32 value another shape
without copying its numerical data. This reference covers the Python and
JavaScript shape overloads. The [shape concept](../concepts/tensor-shape.md)
explains why shape and storage are different; [semantic lifetimes](../components/semantic-value-lifetimes.md)
explains how the runtime keeps their owners independent.

## Call forms and shape rules

Python accepts `tensor.view(*shape)`: positional built-in integer dimensions,
or one built-in tuple or list of dimensions. An empty tuple or list requests a
scalar. Calling `view()` without arguments is invalid. Booleans, floats,
custom integer or container types, keyword shapes and the dtype overload are
not accepted. JavaScript accepts `tensor.view(shape)`, where `shape` is an
array of dimensions. Each result owns a frozen shape and a separate handle.

Dimensions must be non-negative safe integers, except that one dimension may
be `-1`. The runtime infers that dimension by dividing the source element count
by the product of the other dimensions. The division must be exact and
unambiguous. For example, six elements can become `(2, 3)` or `(-1, 3)`.
One element can become a scalar; zero elements cannot.

An explicit zero preserves an empty shape, including dimensions after the zero.
For empty input, `(-1, 2)` becomes `(0, 2)`, but `(0, -1)` is ambiguous and is
rejected. Two inferred dimensions, dimensions below `-1`, incompatible counts
and dimensions outside the runtime's safe-integer range are also rejected.
Tabgrad retains its [shape representability rules](../javascript-api.md#create-compute-observe-and-release):
a zero makes the explicit product zero even after a large prefix. That rule is
not a claim to reproduce native PyTorch integer-overflow behavior for enormous
empty shapes. Physical allocation limits remain separate from shape admission.

Python syntax and dimension-type failures raise `TypeError`. Runtime shape
failures become `RuntimeError`; exact error text is not a compatibility claim.
JavaScript shape failures use `TabgradError` with code `INVALID_SHAPE`.
Closed or invalid handles retain the ordinary frontend lifecycle errors.
Admission is synchronous, and rejection creates no tensor owner or numerical
work. Frontends normalize syntax; the shared runtime validates and infers shape.

## Storage and observation

A view preserves flat row-major element order and the entire storage extent.
It may refer to host data, pending computation or a resident CPU result.
Creating it does not execute pending arithmetic, allocate numerical payload,
upload data or read data back. Sibling and chained views refer directly to the
same storage rather than retaining a history of intermediate view handles.

Closing a JavaScript base handle does not invalidate a live view. Closing one
view does not invalidate the base or its siblings. Python wrappers retain their
own runtime handles and release them when their Python owners disappear.
Pending arithmetic and accepted observations also retain the storage they
need. Its final owner releases it once, after applicable physical work ends.

Existing addition still requires exactly equal shapes. Views with the same
element count but different shapes cannot be added until explicitly viewed to
the same shape. Addition creates independent output storage. Observation uses
the existing `tolist()` or asynchronous `toArray()` entry and returns owned
copies, so changing a returned container cannot mutate shared storage.

Within a managed Python entry, the browser integration suite exercises:

```python
import torch

base = torch.tensor([1, 2, 3, 4, 5, 6], dtype=torch.float32)
matrix = base.view(2, 3)
assert base.shape == (6,)
assert matrix.shape == (2, 3)
assert (matrix + matrix).tolist() == [[2.0, 4.0, 6.0], [8.0, 10.0, 12.0]]
assert matrix.view(-1).shape == (6,)
```

The equivalent JavaScript shape call is `base.view([2, 3])`; applications close
each handle and the session using the [ordinary lifecycle](../javascript-api.md).
Python observation needs the managed entry but no JSPI or async observation
extension. The [compatibility evidence](../compatibility.md#python-tensor-evidence)
identifies the pinned native oracle and the distinction from release claims.

## Limits and cost

This operation covers shape changes of whole contiguous CPU float32 storage.
It does not provide dtype reinterpretation, reshape with copy fallback,
`view_as`, transpose, slicing, offsets, arbitrary strides, mutation or autograd.
There is no public storage-pointer interface.

Admission costs are proportional to source and target rank, not payload size
or the number of sibling views. Each live view needs a small value/handle and
its shape. First materialization uploads or computes shared storage once;
later demands reuse that materialization. Numerical copies made by ordinary
observation remain proportional to payload size. Python nested output can
also allocate containers for empty dimensions. Formation and physical reuse
costs are governed by [program formation](../components/program-formation.md)
and [CPU invocation storage](../components/cpu-invocation-storage.md).
