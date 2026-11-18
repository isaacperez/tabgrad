# Tabgrad 0.5.0 source and support record

<!-- tabgrad-release
{
  "schemaVersion": 1,
  "version": "0.5.0",
  "title": "Float16 tensors on CPU and GPU",
  "documentationImpact": "The float16 reference defines creation, views, same-type pointwise arithmetic, numerical rounding, observations and exclusions. Tensor, JavaScript, Python, execution and compatibility documentation records the typed domain. The memory-capacity reference and GPU dispatch documentation describe independent physical capacity, update reservations and dispatch geometry. Current integration examples select 0.5.0. Both new references are admitted to the versioned catalogue and shared navigation. The completed 0.4.0 documentation is pinned to its released source; older baselines and corrections are preserved. Other support is explicitly inherited from 0.4.0.",
  "inherits": "0.4.0",
  "support": {
    "summary": "Use compact float16 tensors for addition and multiplication, alongside the existing float32 operations and gradients.",
    "capabilities": [
      {
        "title": "Tensors & shapes",
        "description": "Create float32 or float16 tensors and reshape their full storage without copying.",
        "source": "docs/reference/python-tensors.md"
      },
      {
        "title": "Float16 arithmetic",
        "description": "Add and multiply float16 tensors with compatible shapes on CPU or GPU. Read results as ordinary numbers.",
        "source": "docs/reference/float16.md"
      },
      {
        "title": "Arithmetic & matrices",
        "description": "Add and multiply float32 tensors with broadcasting. Multiply 2D float32 matrices.",
        "source": "docs/reference/tensor-multiplication.md"
      },
      {
        "title": "Automatic gradients",
        "description": "Compute float32 gradients directly or accumulate them with `backward()`.",
        "source": "docs/reference/functional-gradients.md"
      },
      {
        "title": "Parameter updates",
        "description": "Update float32 parameters with basic stochastic gradient descent (SGD).",
        "source": "docs/reference/sgd.md"
      },
      {
        "title": "Execution diagnostics",
        "description": "Inspect executed operations, transfers and the buffer memory Tabgrad tracks on CPU or GPU, in JavaScript and Python.",
        "source": "docs/reference/python-host.md"
      }
    ],
    "limits": [
      {
        "title": "Data and storage",
        "description": "Contiguous float32 tensors and explicit float16 for its pointwise domain. Views reshape the full storage. No mixed-type promotion, dtype conversion, arbitrary strides or cross-device transfer."
      },
      {
        "title": "Float16 scope",
        "description": "Creation, whole-storage views and tensor addition or multiplication, including broadcasting. Float16 gradients, training, mutation, reductions and matrix products are unavailable. Two-byte storage does not mean half the total RAM or faster execution."
      },
      {
        "title": "Shapes and operations",
        "description": "Addition and multiplication broadcast compatible shapes. Matrix multiplication supports 2D float32 inputs. Slicing and batched matrix products are unavailable."
      },
      {
        "title": "Memory capacity",
        "description": "CPU linear memory defaults to 64 MiB, with an explicit maximum of 256 MiB. Update reservations remain separate. GPU work must fit actual device, indexing and operation limits. These limits do not bound total RAM or guarantee that a model fits."
      },
      {
        "title": "Gradients and training",
        "description": "First-order float32 gradients and basic SGD. Higher-order gradients, momentum and weight decay are unavailable."
      },
      {
        "title": "Python API",
        "description": "The official PyTorch runtime is not used. `torch.nn`, `torch.nn.functional` and activations such as `relu` are unavailable. Loading pretrained models and fine-tuning are not supported."
      }
    ]
  }
}
-->

This record identifies `@tabgrad/tabgrad@0.5.0`, selected npm channel `latest`
and tag `v0.5.0`, under the [release policy](../releases.md). It describes the
version's source and support boundaries. Package availability, exact archive
identity, producer proofs and delivery outcomes are verified separately.

## Float16 tensors

Python can explicitly select `torch.float16`; JavaScript can select
`{ dtype: "float16" }` when creating a tensor. CPU remains the default device.
Whole-storage views and same-type tensor addition and multiplication work on
CPU and explicitly selected GPU, including broadcasting. GPU execution does
not require the optional `shader-f16` feature.

Each operation stores its own binary16 result with round-to-nearest,
ties-to-even. Construction converts the original numeric input directly,
without an intermediate float32 rounding. JavaScript `toArray()` returns
decoded `Float32Array` values; Python `tolist()` returns ordinary numbers.
The [float16 reference](float16.md) defines exceptional values, subnormals,
signed zero and the supported signatures.

Float16 does not include gradient tracking, functional or persistent backward,
SGD, mutation/copy, reductions or matrix products. Mixed-type promotion,
number-operand overloads and dtype conversion remain unavailable. Unsupported
calls reject before changing tensor history or state. Previously supported
float32 calls retain their defaults and numerical contracts.

Float16 uses two logical bytes per value. Physical allocations, alignment,
staging and interpreter memory remain additional costs; numeric observation
allocates four bytes per value. Neither a speedup nor a halving of total RAM
follows from the storage format. The existing diagnostics retain their
separate meanings for logical data and accounted device buffers.

## CPU capacity and GPU dispatch

Applications can configure CPU linear memory independently of logical update
reservations through `memoryLimits`. CPU linear memory defaults to 64 MiB,
starts at 2 MiB and can be explicitly configured up to 256 MiB. Logical update
backing still defaults to, and cannot exceed, 64 MiB. A larger CPU allowance
does not allocate that maximum at startup or guarantee host growth succeeds.
See [memory limits](memory-capacity.md) for validated fields, errors and
diagnostics, including costs outside these budgets.

GPU tensor storage is checked against actual buffer/binding, indexing and
transport limits, separately from dispatch geometry. Existing kernels keep
their ordinary one-dimensional path when it fits and use checked grids for
larger work. Numerical contracts, explicit device selection and normal
completion accounting remain in place. Admission of one tensor does not
guarantee that an entire graph, temporary working set or training step fits.
See the [GPU reference](webgpu-runtime.md) and
[dispatch contract](../architecture/webgpu-dispatch.md).

## Updating and qualification

Replace the complete matched distribution, including workers, Python sources
and CPU numerical assets. Existing supported calls need no API migration.
Float32 remains the default; applications opt into float16 and larger CPU
capacity explicitly. The [browser package](browser-package.md) and
[Python setup](python-host.md) examples select this version.

The [0.4.0 support record](release-0.4.0.md) supplies unchanged capabilities
and environment families through explicit inheritance. Its documentation
remains pinned to its released source and must not be read as describing
float16. The new version owns the float16 and capacity guides, notes and
support overrides above. PyTorch compatibility remains **Partially supported**.
This does not add pretrained model loading, `torch.nn` or complete PyTorch
coverage.

Source, numerical/oracle, composition, lifecycle and bounded cost evidence is
recorded in [#464](https://github.com/isaacperez/tabgrad/issues/464),
[#465](https://github.com/isaacperez/tabgrad/issues/465) and
[#471](https://github.com/isaacperez/tabgrad/issues/471). Measured costs depend
on the path and environment; half encoding and decoding are not free. No
general performance claim or arbitrary-model qualification is made. Actual
retained-archive CPU and physical GPU qualification, signing and public
delivery remain separate under the [publication procedure](release-publication.md).
