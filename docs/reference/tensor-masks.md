# Boolean tensors and comparison

Boolean masks record a true or false value for each element. They remain on
the device that produced them and follow the usual tensor lifetime.

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

## Create and read boolean tensors

Python accepts explicit `dtype=torch.bool` in [tensor creation](python-tensors.md#create-a-tensor).
JavaScript accepts `{ dtype: "bool" }` with flat primitive booleans and
numbers. Numeric zero becomes false. Nonzero values, infinities and NaN
become true. Python `tolist()` returns Python booleans and preserves the
ordinary scalar, empty and list shape rules. JavaScript `toArray()` returns
numeric zeros and ones. Use `await mask.toArray({ format: "typed" })` for an
independently owned `Uint8Array` containing zeros and ones.

Masks support [shape-only views](tensor-view.md). Boolean gradient tracking
and in-place updates are outside this interface. See the [operation table](../compatibility.md#tensor-dtypes-by-operation)
for qualified signatures.
