# Functional first-order gradients

This reference defines differentiation through contiguous CPU float32 addition,
multiplication, total sum and shape-only views. It is for Python and JavaScript
users who need gradients of one output with respect to named inputs. The result
is a vector-Jacobian product: an incoming tensor weights the output elements,
and the returned tensors describe that weighted output's sensitivity to each
requested input. The runtime does not construct a full Jacobian matrix.

The [history component](../components/derivative-history.md) explains ownership;
the [functional derivative flow](../flows/functional-gradients.md) follows one
calculation through forward admission, differentiation and observation.

## Python call and example

Inside a managed Python script, `torch.tensor(..., requires_grad=True)` enables
tracking at creation. The read-only `Tensor.requires_grad` property reports
tracking without observing payloads. With recording enabled, an arithmetic
result tracks if any input tracks. The default remains false. The
[no-grad reference](gradient-recording.md) defines disabled recording,
explicit tracked factories and special views whose advertised tracking has no
ordinary derivative accumulator.

```python
import torch

x = torch.tensor([2.0, 3.0], dtype=torch.float32, requires_grad=True)
y = torch.tensor([5.0, 7.0], dtype=torch.float32, requires_grad=True)
loss = (x * y + x * x).sum()
dx, dy = torch.autograd.grad(loss, (x, y))
assert dx.tolist() == [9.0, 13.0]
assert dy.tolist() == [2.0, 3.0]
assert not dx.requires_grad
```

The example runs in the real-Pyodide and browser fixtures. The corresponding
native PyTorch 2.14 case is recorded under
[compatibility evidence](../compatibility.md#python-tensor-evidence). Python
requires explicit `dtype=torch.float32`; this example assumes a host already
attached the interpreter using the [host contract](python-host.md).

The supported signature is:

```python
torch.autograd.grad(outputs, inputs, grad_outputs=None,
                    retain_graph=None, create_graph=False, only_inputs=True,
                    allow_unused=None, is_grads_batched=False,
                    materialize_grads=False)
```

`outputs` is a tensor or a one-element tensor sequence. `inputs` is a tensor or
a nonempty tensor sequence. Every requested input and the output must track,
and every input must contribute to that output. Inputs may be leaves or
intermediate results. Repeated inputs return repeated entries in the same
order. The result is always a tuple of ordinary tensors with the corresponding
input shapes, dtype and device.

`grad_outputs` may be a tensor, `None`, or a one-element sequence containing
either. `None` supplies a unit seed only when the output has exactly one element,
at any rank. A tensor seed must match the entire output shape, including empty
dimensions, and must not track gradients. For example, a seed `[2, 3]` for a
vector output weights its first and second elements separately. A zero-element
output requires an explicit zero-element seed of the same shape. Total sum of
an empty input accepts its ordinary implicit scalar seed and returns an empty
gradient with the input shape.

Only `retain_graph=None/False`, `create_graph=False`, `only_inputs=True`,
`allow_unused=None/False`, `is_grads_batched=False` and `materialize_grads=False`
are accepted. Non-boolean mode values reject, except the stated `None` forms.
Enabled retained, higher-order, batched or unused-input modes are unsupported.
`only_inputs=False` is explicitly unsupported, even though native PyTorch
deprecates and ignores that option. Tracking seeds are also an explicit subset
restriction: native identity/view paths can preserve a seed's existing history
with `create_graph=False`, contrary to this API's wholly untracked result.

## JavaScript call

`session.tensor(data, { requiresGrad: true })` and read-only
`tensor.requiresGrad` use the same tracking state. The direct entry is:

```typescript
session.grad(output: Tensor, inputs: readonly Tensor[], gradient?: Tensor): Tensor[]
```

JavaScript supplies exactly one output handle, a nonempty actual array of
requested handles, and optionally one nontracking seed handle. Shape, tracking,
connectivity and seed semantics match the Python interface. Each returned entry
owns an independently closeable handle, including repeated requests for the
same input. Call `await gradient.toArray()` to observe a result and close every
result under the ordinary [session lifetime](../javascript-api.md) contract.

## History consumption and validation

Global argument validation occurs before admitting any derivative operation
or consuming saved values. Wrong shapes, unused/nontracking inputs,
unsupported modes, foreign handles and closed handles leave existing history
available for a corrected request. After admission, results remain lazy;
differentiation itself performs no numerical readback.

Saved-state checks and consumption belong to each executing recipe. A recipe
that succeeds before a later saved-version failure remains consumed; retrying
the request or separately requesting that branch can therefore report consumed
history. The failing recipe retains its saved state. Selected dependencies must
be ready before execution, and ready recipes use creation sequence priority
for the pinned native cases. This is not a universal ordering guarantee for
arbitrary PyTorch graphs; see the bounded
[compatibility evidence](../compatibility.md#functional-failure-progress).

Multiplication saves the operand needed by each tracked input's derivative.
Traversing that multiplication consumes its saved values once. Repeating a
request that needs those values fails, even if the first returned gradient was
closed without observation. Addition, sum and views need only metadata, so
their histories can be reused. Direct copy is also reusable; traversed
whole-storage view copy is consumable independently of numeric saves.
Every save of an executed node is version checked before that recipe's admission,
including saves for pruned positions. The [copy reference](tensor-copy.md) owns
rebasing, special-view guards and captured writer outcomes. The successful
history/cutoff and failure-progress distinctions follow the pinned native oracle.
It is not a blanket rule that every derivative request consumes every
ancestor.

Requesting a gradient with respect to the output itself does not traverse its
ancestors. Requesting an intermediate stops numerical differentiation at that
intermediate unless another requested input lies farther upstream. An unrelated
consumed branch therefore does not invalidate a derivative whose selected path
does not need it. Forward observation may reclaim all normal producer records
without consuming independently owned derivative history.

| JavaScript error code | Meaning | Python presentation |
| --- | --- | --- |
| `GRADIENT_NOT_TRACKED` | Output has no derivative entry, or requested input does not track | `RuntimeError` |
| `UNUSED_INPUT` | Requested input is disconnected from the output, including a tracked no-grad view with no accumulator | `RuntimeError` |
| `INVALID_GRADIENT` | An implicit seed was requested for a non-singleton output | `RuntimeError` |
| `UNSUPPORTED_GRADIENT` | Explicit seed tracks gradients | `RuntimeError` |
| `SHAPE_MISMATCH` | Seed and output shapes differ | `RuntimeError` |
| `SAVED_VERSION_MISMATCH`, `INPLACE_VIEW` | Changed numeric save or dirty special-view derivative entry | `RuntimeError` |
| `SAVED_DETACHED` | Saved tensor detached in place, including by numeric SGD gradient reset | `RuntimeError` |
| `CONSUMED_HISTORY` | Selected derivative needs already consumed saved values | `RuntimeError` |
| `INVALID_TENSOR`, `CLOSED_TENSOR`, `CLOSED_SESSION`, `DIFFERENT_SESSION` | Invalid handle or lifetime/session mismatch | Existing `JsException` lifecycle contract |

Malformed containers/arguments raise `TypeError`; Python's unsupported modes
raise `RuntimeError`. Exact native wording is not promised. Backend failures
occur on ordinary observation and retain normal runtime failure context.

## Numerical and execution boundary

Local derivative rules admit ordinary multiplication and addition, metadata
views and one internal scalar expansion. Expansion reads one float32 scalar
and fills a fresh contiguous output, including an empty output, through the CPU
scalar or SIMD kernel. It is not a public broadcast operation. The raw export
`tabgrad_expand_f32(input_offset, output_offset, length)` requires one readable
aligned float32 input, a valid aligned output range and non-overlap when the
output is nonempty. It accepts an empty output at the memory endpoint. ABI
statuses follow the [CPU contract](../architecture/webassembly-cpu-backend.md#version-1-raw-abi-and-module-capabilities).

Multiplication and contribution addition retain ordinary float32 rounding;
sum-derived incoming gradients need not equal one. General numerical guarantees
remain bounded by the underlying operation references. Oracle cases use small,
exactly representable values to establish derivative semantics rather than
claiming bitwise equivalence for every floating-point graph.

Functional calls do not automatically accumulate leaf gradients. Already
retained nonleaves can receive contributions, including at input cutoffs; the
[backward reference](backward-gradients.md) owns persistent slot behavior.
Optimizers, higher-order graphs, JVP, public broadcasting, axis reduction and
broader dtype/device/layout remain excluded. These exclusions do not change
ordinary nontracking computation or introduce a backend fallback.
