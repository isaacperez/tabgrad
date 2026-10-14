# Two-dimensional tensor matrix products

This reference is for Python and JavaScript users multiplying dense contiguous
float32 matrices on CPU or an explicitly enabled WebGPU device. For inputs
`A[M,K]` and `B[K,N]`, the distinct result has shape `[M,N]` and the same device
and dtype. Both inputs belong to one session. Zero dimensions, whole-storage
views and repeated operands are included.

## Calls and differentiation

Inside a [managed Python entry](python-host.md):

```python
import torch

a = torch.tensor([[1., 2., 3.], [4., 5., 6.]],
                 dtype=torch.float32, requires_grad=True)
b = torch.tensor([[7., 8.], [9., 10.], [11., 12.]],
                 dtype=torch.float32, requires_grad=True)
y = a @ b
assert y.tolist() == [[58., 64.], [139., 154.]]
seed = torch.tensor([[1., 2.], [3., 4.]], dtype=torch.float32)
ga, gb = torch.autograd.grad(y, (a, b), grad_outputs=seed)
assert ga.tolist() == [[23., 29., 35.], [53., 67., 81.]]
assert gb.tolist() == [[13., 18.], [17., 24.], [21., 30.]]
```

`torch.matmul(input, other, *, out=None)` accepts the two tensor arguments
positionally or by name. `Tensor.matmul(other)` accepts its argument
positionally or by `other`. `@`, its reflected form, and direct `__matmul__`
and `__rmatmul__` calls use the same numerical admission. `@=` rebinds the Python
variable to a new result; it does not update the original tensor or aliases.
JavaScript uses `left.matmul(right)` with exactly one tensor argument and
observes its independent flat float32 result with `await result.toArray()`.
JavaScript handles, optimizers and their session have explicit close lifetimes.

Both [functional gradients](functional-gradients.md) and
[backward accumulation](backward-gradients.md) use `G @ Bᵀ` and `Aᵀ @ G`, with
internal orientation metadata and no public transposed payload. Each actual
differentiable edge saves its opposite operand. Repeated operands contribute
twice through ordinary gradient addition. Saved-version checks, special
no-grad views, per-node partial progress, result identities and reset retain
their existing contracts. A small resident training step can use
`loss=(inputs @ weights); loss=(loss*loss).sum(); loss.backward(); optimizer.step()`
with [basic SGD](sgd.md); reset gradients between steps as required.

## Numerical and resource boundaries

Each output starts at positive float32 zero and visits contraction indices in
ascending order. Every term rounds the exact accumulator plus product once to
nearest binary32, ties to even. CPU scalar/SIMD and GPU use this same
[sequential-FMA contract](../architecture/float32-matrix-product.md).
Subnormals, signed zero, infinities and NaN classification participate in every
term; NaN payload and sign are unspecified. A nonempty `K=0` result contains
positive zeros. An empty output still validates arguments and metadata, and
can have nonempty derivative contributions.

The accepted association can differ from PyTorch's matrix implementations,
including cancellation, signed zero and overflow/NaN classifications. The
architecture chapter states the concrete differences and the conditional
finite comparison bound. No universal bitwise native equality, optimized GEMM
speed, hardware portability or physical VRAM bound is implied.

Admission checks output capacity independently of input capacity: small
`[M,1]` and `[1,N]` inputs can require a large `[M,N]` output. Gradients reserve
their own sizes. Captured shape and orientation are immutable. Demand, resident
reuse, abandoned pure work, provenance and physical drain follow the ordinary
program and backend owners. GPU intermediates stay resident; each dispatch
owns a separate 16-byte geometry packet through completion. CPU module profile
6 provides the seven-argument raw export documented in
[the CPU ABI](../architecture/webassembly-cpu-backend.md#version-1-raw-abi-and-module-capabilities).

## Errors and exclusions

Malformed Python calls or non-tensor operands raise `TypeError`; invalid rank
or contraction, non-None tensor `out`, and output-capacity exhaustion raise
`RuntimeError`. Direct dunders return `NotImplemented` for unrecognized operands
and malformed argument forms so reflected dispatch retains native behavior.
Closed handles, different sessions and disabled or mixed devices retain
structured runtime errors through `JsException`. Incorrect JavaScript arity
raises `TypeError`; rank, contraction, ownership and capacity failures use the
existing structured codes. Rejection creates no operation or numerical work.

Vectors, batched products, broadcasting, other dtypes, noncontiguous layouts,
public transpose, `mm` aliases, non-None output mutation, retained or higher-order
gradients and implicit device transfers are outside this contract. Some are
valid PyTorch calls; their rejection is a subset boundary. Qualification belongs
to [the compatibility record](../compatibility.md), separately from this
operation's numerical design and release support.
