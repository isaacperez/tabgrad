# Float16 tensors

`float16` stores each logical value as IEEE binary16. It supports explicitly
typed creation, whole-storage shape views, tensor addition and multiplication,
[total sum](tensor-sum.md) and [two-dimensional matrix products](tensor-matmul.md)
on CPU and an explicitly enabled GPU. Both Python and JavaScript use the same
runtime and numerical domain. A release's own compatibility record determines
whether that release includes this domain.

## Create and compose

```python
import torch

x = torch.tensor([[1., 2., 3.], [4., 5., 6.]], dtype=torch.float16)
scale = torch.tensor([0.5, 1., 2.], dtype=torch.float16)
bias = torch.tensor([1., 0., -1.], dtype=torch.float16)
result = x * scale + bias
print(result.tolist())  # [[1.5, 2.0, 5.0], [3.0, 5.0, 11.0]]
```

Python requires the canonical `torch.float16` object, rather than a string or
inferred dtype. Its built-in scalar and rectangular list/tuple normalization is
the same as [tensor creation](python-tensors.md). Use `device="webgpu"` on each
input to select an attached GPU; CPU remains the default. `torch.float16` is an
immutable dtype constant with the same floating-point metadata as `torch.float32`.

JavaScript selects `{ dtype: "float16" }` in `session.tensor(data, options)`.
Omitting `dtype` still selects `float32`. Inputs are copied synchronously into
owned storage; deferred work cannot borrow the caller's input. `tensor.dtype`
remains `"float16"`, while `await tensor.toArray()` returns numeric
`Float32Array` values. Python `tolist()` returns ordinary numbers, including a
scalar number for a rank-zero tensor. These are decoded observations, not raw
half-word interfaces. Every finite binary16 number is exactly representable in
the float32 observation format.

Both operands of `add` or `mul` must be float16 tensors from the same session
and device. The usual [broadcasting laws](../architecture/broadcasting.md)
apply to scalars, empty dimensions and higher-rank contiguous shapes. Python
addition accepts `alpha=1` and `out=None`; no host-number operand or mixed-type
promotion is implied. Whole-storage `view` changes shape without reinterpreting
dtype, copying bytes or tying the view's lifetime to its original handle.

## Numerical boundaries

Construction converts the original numeric input directly to binary16 with
round-to-nearest, ties-to-even. In particular, Python input is not first rounded
through a float32 buffer. Values just above a midpoint and just below the
overflow threshold can otherwise produce a different result.

Each operation rounds and stores its own binary16 result. Multiplication followed
by addition has two storage-rounding boundaries; it is not fused arithmetic.
Pointwise arithmetic supports subnormals and signed zeros. Finite overflow produces the
corresponding infinity; NaN and infinity classifications follow IEEE arithmetic.
NaN payload and sign identity are excluded.

For addition and multiplication, CPU uses owned half words and native float32 arithmetic followed by
one half conversion. Half products have at most 22 significant bits; a half-add
rounding boundary is exactly representable in float32, while larger exponent
gaps cannot cross that midpoint. GPU execution uses bounded integer significands
and a single output-word writer. It needs neither `shader-f16` nor relaxed
floating-point packing builtins.

Total sum uses exact integer accumulation with a single binary16 rounding on
both backends. Its [numerical rules](tensor-sum.md#float16-on-cpu-and-webgpu)
cover signed zero, nonfinite values and the distinction from native PyTorch
under cancellation.

Two-dimensional matrix products multiply the stored half operands exactly and
accumulate in binary32 in contraction order. The [matrix reference](tensor-matmul.md)
explains the final binary16 rounding and how the kernels preserve compact storage.

The pinned PyTorch 2.14 CPU corpus records construction midpoints, exceptional
classes and separate stored operations. Actual browser CPU, direct GPU and
managed Python/GPU checks compare complete outputs. This evidence qualifies its
declared environments, not every browser, adapter or model.

## Memory and transfer accounting

For `n` values, logical tensor storage and encoded readback occupy `2n` bytes.
GPU allocation rounds that extent to four bytes and retains its usual minimum
allocation. Odd uploads transfer a word-aligned prefix and a separately padded
final word; only that final partial word needs a host copy. Readback transfers
the aligned extent but exposes exactly `2n` bytes to the codec. Padding is never
a public tensor value.

GPU pointwise kernels write both halves of an output word in one invocation.
Each broadcast lane projects its own input indices, including when an odd inner
axis crosses a word boundary. An absent final lane is not read.

Numeric observation allocates `4n` float32 bytes. Staging, alignment, allocator
reservations, interpreter memory and pipeline caches remain separate costs.
The existing CPU/GPU diagnostics retain their meanings: logical transfer bytes
are distinct from accounted physical GPU allocations. Two-byte storage does
not establish a speedup or a halving of total RAM. Capacity settings and quotas
are unchanged.

## Exclusions

This domain rejects tracking, functional or persistent backward, non-null
gradient assignment, SGD, and mutation/copy before their history or state
changes. Clearing a null gradient does not create a gradient payload.
Axis reductions, batched matrix products, numeric-operand overloads, mixed promotion,
inferred dtype, `.to`, dtype-reinterpreting views and custom gradient dtypes
are outside this contract. These are Tabgrad boundaries; native PyTorch has a
broader float16 interface. Existing float32 operation and training contracts
remain separate and unchanged.
