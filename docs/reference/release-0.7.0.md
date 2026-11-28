# Tabgrad 0.7.0 source and support record

<!-- tabgrad-release
{
  "schemaVersion": 1,
  "version": "0.7.0",
  "title": "Boolean masks and exact indexing",
  "documentationImpact": "The compatibility table adds bool, int32 and int64 creation, observation and views, plus the verified torch.gt, torch.where, torch.argmax and torch.index_select signatures. The Python and JavaScript references describe exact signed values, gradients and when an invalid index is reported. Browser setup examples select 0.7.0. Version 0.6.0 retains its own published source.",
  "inherits": "0.6.0",
  "support": {
    "summary": "Compare tensors, select values with a mask and work with exact integer indices on CPU or WebGPU. The compatibility table lists inputs, results and gradients for each operation.",
    "capabilities": [
      {
        "title": "Tensors and views",
        "description": "Create and observe contiguous float32, float16, bfloat16, bool, int32 and int64 tensors. Views reshape their full storage without copying.",
        "source": "docs/reference/python-tensors.md"
      },
      {
        "title": "Boolean masks and selection",
        "description": "Compare float32 tensors with gt and feed the mask into where. The float32 branches support broadcasting and first-order gradients.",
        "source": "docs/reference/python-tensors.md"
      },
      {
        "title": "Exact integer indexing",
        "description": "Get int64 indices with argmax. Use int32 or int64 indices to select slices of float32, int32 or int64 data in order, including repeats.",
        "source": "docs/reference/python-tensors.md"
      },
      {
        "title": "Floating-point arithmetic",
        "description": "Add and multiply same-dtype tensors with broadcasting, sum a whole tensor or multiply two dense 2D matrices in float32, float16 or bfloat16.",
        "source": "docs/reference/tensor-matmul.md"
      },
      {
        "title": "Gradients and training",
        "description": "Compute first-order gradients for supported float32 operations and update float32 parameters with SGD.",
        "source": "docs/reference/sgd.md"
      },
      {
        "title": "Execution diagnostics",
        "description": "Inspect measured operations, tensor transfers and the buffer memory Tabgrad tracks on CPU or WebGPU.",
        "source": "docs/reference/python-host.md"
      }
    ],
    "limits": [
      {
        "title": "Integer and boolean scope",
        "description": "Bool represents masks. Int32 and int64 preserve exact values for creation, observation, views and the listed indexing operations. General arithmetic and type promotion are outside this scope."
      },
      {
        "title": "Index selection",
        "description": "Index selection is forward-only. Use no_grad for tracked inputs. Invalid index values can be reported when an observation or effect needs the result."
      },
      {
        "title": "Floating-point scope",
        "description": "Float16 and bfloat16 support forward execution. Gradients, tensor mutation and SGD require float32 within their documented operation scope. Floating-point sum reduces the full tensor, and matmul accepts dense 2D operands."
      },
      {
        "title": "Memory capacity",
        "description": "CPU linear memory defaults to 64 MiB with an explicit maximum of 256 MiB. Update reservations are separate. GPU work is subject to device limits and the working set."
      },
      {
        "title": "Gradients and training",
        "description": "First-order float32 gradients and basic SGD. Higher-order gradients, momentum and weight decay are unavailable."
      },
      {
        "title": "Python API",
        "description": "The compatibility table covers the documented subset of torch, Tensor, autograd and optim calls. Loading pretrained models and fine-tuning are not supported."
      }
    ]
  }
}
-->

This record identifies `@tabgrad/tabgrad@0.7.0`, npm channel `latest` and tag
`v0.7.0` under the [release policy](../releases.md). It records source and
compatibility. Release evidence establishes package identity and availability.

## Compare and select with masks

Compare two float32 tensors with `torch.gt` and pass the bool mask to
`torch.where` to choose between two float32 branches. Broadcasting applies to
the comparison and selection. The [mask reference](python-tensors.md#select-with-a-boolean-mask)
describes first-order gradients through the float32 branches and the
[accepted gradient behavior](../architecture/typed-tensors.md#boolean-masks-and-selection).

## Work with exact indices

Create signed tensors with `torch.int32` or `torch.int64` in Python. JavaScript
can read the stored values as an `Int32Array` or `BigInt64Array` using
`toArray({ format: "typed" })`. In both frontends, [argmax](python-tensors.md#find-the-index-of-a-maximum)
returns the first maximum's index as int64. [Index selection](python-tensors.md#select-values-along-an-axis)
accepts int32 or int64 indices and preserves order, duplicates and source dtype.
The intermediate index tensor can stay on the same device. Index selection
supports forward execution and checks payload bounds when the result is needed.

The [version-owned compatibility table](../compatibility.md#tensor-dtypes-by-operation)
lists the six index selection signatures and the other admitted operations on
CPU and WebGPU. The [0.6.0 record](release-0.6.0.md) describes the prior
float16 and bfloat16 scope, which carries forward.

## Updating

Replace the package, workers, WebAssembly and Python assets together. The
previously supported public calls retain their documented forms. The
[browser package guide](browser-package.md) and [Python setup guide](python-host.md)
use the file versions that match this release.
