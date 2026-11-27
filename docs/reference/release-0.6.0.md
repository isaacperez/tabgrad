# Tabgrad 0.6.0 source and support record

<!-- tabgrad-release
{
  "schemaVersion": 1,
  "version": "0.6.0",
  "title": "More operations with compact tensors",
  "documentationImpact": "The release adds bfloat16 and extends float16 to total sum and dense 2D matrix products. The version-owned compatibility table records dtypes by PyTorch module and operation, including CPU, WebGPU and gradient coverage. The numeric references explain the compact operations and their limits. Browser setup examples select 0.6.0. The 0.5.0 catalogue entry is pinned to its published source.",
  "inherits": "0.5.0",
  "support": {
    "summary": "Use float16 or bfloat16 for forward tensor arithmetic and keep float32 for gradients and SGD. The compatibility table shows which dtype each operation accepts.",
    "capabilities": [
      {
        "title": "Tensors and views",
        "description": "Create contiguous float32, float16 or bfloat16 tensors and reshape their full storage without copying.",
        "source": "docs/reference/python-tensors.md"
      },
      {
        "title": "Broadcast addition and multiplication",
        "description": "Add or multiply same-dtype tensors of compatible shapes on CPU or WebGPU.",
        "source": "docs/reference/tensor-multiplication.md"
      },
      {
        "title": "Reductions and matrix products",
        "description": "Sum a whole tensor or multiply two dense 2D matrices in float32, float16 or bfloat16. The result keeps its dtype.",
        "source": "docs/reference/tensor-matmul.md"
      },
      {
        "title": "Gradients and training",
        "description": "Compute first-order float32 gradients directly or accumulate them with backward. Update float32 parameters with SGD.",
        "source": "docs/reference/sgd.md"
      },
      {
        "title": "Execution diagnostics",
        "description": "Inspect measured operations, transfers and the buffer memory Tabgrad tracks on CPU or WebGPU.",
        "source": "docs/reference/python-host.md"
      }
    ],
    "limits": [
      {
        "title": "Compact dtype scope",
        "description": "Float16 and bfloat16 support forward execution. Gradients, tensor mutation and SGD require float32. Compact storage uses two logical bytes per value. Actual memory and speed depend on the workload and backend."
      },
      {
        "title": "Shapes and operations",
        "description": "Same-dtype broadcast add and multiply, whole-tensor sum and dense 2D matmul. Mixed dtypes, casting, slicing, axis reductions and batched matmul are unavailable."
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
        "description": "Tabgrad implements a documented portion of PyTorch. The documented torch, Tensor, autograd and optim entries describe the supported calls. Loading pretrained models and fine-tuning are not supported. The official PyTorch runtime and torch.nn are unavailable."
      }
    ]
  }
}
-->

This record identifies `@tabgrad/tabgrad@0.6.0`, npm channel `latest` and tag
`v0.6.0` under the [release policy](../releases.md). It describes the source
and compatibility boundary. Package availability, archive identity and public
delivery are verified separately.

## Choose a compact dtype

Python uses the explicit `torch.float16` or `torch.bfloat16` constants.
JavaScript accepts `{ dtype: "float16" }` or `{ dtype: "bfloat16" }` and
defaults to `"float32"`. CPU remains the default device. Both compact
types support creation, observation, views, same-dtype broadcast addition and
multiplication, total sum and dense 2D matmul on CPU and WebGPU.

The [compatibility table](../compatibility.md#tensor-dtypes-by-operation)
lists the supported dtypes by operation and the corresponding reference pages.
The [sum reference](tensor-sum.md#backend-numerical-contracts) explains exact
total rounding for the two compact formats. The [matrix reference](tensor-matmul.md#numerical-and-resource-boundaries)
explains ordered float32 accumulation and the separate product rounding for
bfloat16. Cancellation and exceptional values can differ from other PyTorch
backends. These rules apply to the stored values.

The compact types use two logical bytes per resident value. Alignment,
arithmetic scratch, readback and interpreter allocations have independent
costs. JavaScript numeric observation returns decoded values in a
`Float32Array`. The two-byte format describes tensor storage. Runtime
performance and the full working set depend on the calculation and device.

## Updating

Replace the package and its matching workers, WebAssembly and Python assets
together. Existing supported float32 and float16 calls require no API migration.
Use the [browser package](browser-package.md) and [Python setup](python-host.md)
examples for this version.

The [0.5.0 support record](release-0.5.0.md) describes the prior float16
pointwise domain and documents the CPU capacity and GPU dispatch contracts,
which carry forward. [#510](https://github.com/isaacperez/tabgrad/issues/510),
[#511](https://github.com/isaacperez/tabgrad/issues/511) and
[#512](https://github.com/isaacperez/tabgrad/issues/512) record the new numerical
and coverage evidence. The [publication procedure](release-publication.md)
defines the separate retained-package and delivery checks.
