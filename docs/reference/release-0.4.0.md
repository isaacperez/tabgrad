# Tabgrad 0.4.0 source and support record

<!-- tabgrad-release
{
  "schemaVersion": 1,
  "version": "0.4.0",
  "title": "Broadcasting with gradients",
  "documentationImpact": "The JavaScript, Python tensor, multiplication, gradient and compatibility references describe broadcast-compatible addition and multiplication and reduction to each original input shape. The shared broadcasting contract records numerical and resource limits. Complete JavaScript and Python integration examples use 0.4.0. Other support is explicitly inherited from 0.3.0; its separately pinned archive and attributed corrections remain unchanged.",
  "inherits": "0.3.0",
  "support": {
    "summary": "Combine differently shaped tensors with addition or multiplication and compute gradients for their original shapes.",
    "capabilities": [
      {
        "title": "Tensors & shapes",
        "description": "Create tensors, reshape their full storage without copying and copy values on the same device.",
        "source": "docs/reference/python-tensors.md"
      },
      {
        "title": "Arithmetic & matrices",
        "description": "Add and multiply tensors with compatible shapes, including scalars, rows and columns. Multiply 2D matrices.",
        "source": "docs/reference/tensor-multiplication.md"
      },
      {
        "title": "Automatic gradients",
        "description": "Find how a result responds to its inputs. Compute gradients directly or accumulate them with `backward()`.",
        "source": "docs/reference/functional-gradients.md"
      },
      {
        "title": "Parameter updates",
        "description": "Update model parameters with basic stochastic gradient descent (SGD).",
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
        "description": "Contiguous float32 tensors. Views reshape the full storage without copying. No dtype conversion, arbitrary strides or cross-device transfer."
      },
      {
        "title": "Shapes and operations",
        "description": "Addition and multiplication broadcast compatible shapes. Other operations retain their documented shape rules. Matrix multiplication supports 2D inputs; slicing and batched matrix products are unavailable."
      },
      {
        "title": "Gradients and training",
        "description": "First-order gradients and basic SGD. Higher-order gradients, momentum and weight decay are unavailable."
      },
      {
        "title": "Python API",
        "description": "The official PyTorch runtime is not used. `torch.nn`, `torch.nn.functional` and activations such as `relu` are unavailable. Loading pretrained models and fine-tuning are not supported."
      }
    ]
  }
}
-->

This record identifies `@tabgrad/tabgrad@0.4.0`, selected npm channel `latest`
and tag `v0.4.0`, under the [release policy](../releases.md). Source metadata
does not establish registry availability. The verified delivery record separately
identifies the exact source, archive, inventory, producer proofs and outcome.

## Broadcasting with gradients

Addition and multiplication accept two contiguous float32 tensors with
broadcast-compatible shapes on the same device. Dimensions align from the
right; each pair must match or contain a size-one dimension. For example,
combining shapes `[2, 1]` and `[1, 3]` produces `[2, 3]` without expanding either
input's stored values. JavaScript and Python use the same shape rules on CPU
and explicitly selected GPU.

First-order functional gradients and `backward()` reduce each contribution to
its original input shape. Existing view identity, saved-version checks,
accumulation and resource cleanup continue to apply. Gradient seeds and ordinary
accumulation still require exact shapes. This release does not add number
operands, arbitrary strides, slicing, new public operations or batched matrix
multiplication. See the [tensor reference](python-tensors.md),
[multiplication reference](tensor-multiplication.md) and
[broadcasting contract](../architecture/broadcasting.md) for the supported domain.

The shared geometry is independent of operation arithmetic. Dense equal-shape
paths remain in place, while projected traversal reads broadcast inputs without
materializing expanded copies. GPU receiving gradients use bounded reduction
work and temporary storage. These are implementation properties, not a claim
of zero overhead or universal speedup.

Grouped gradient reductions retain each backend's existing sum semantics:
float32 reduction on CPU and exact integer accumulation followed by rounding
on GPU. Results can differ between devices and PyTorch for cancellation or
exceptional inputs. Broadcasting does not promise universal bitwise equality;
the linked contract and compatibility evidence define that boundary.

## Updating and support

The [0.3.0 support record](release-0.3.0.md) supplies unchanged capabilities and
qualified environment descriptions through explicit metadata inheritance.
PyTorch compatibility remains **Partially supported**. Previously accepted
matching-shape addition and multiplication retain their behavior; compatible
unequal shapes are newly accepted. Replace the complete matching distribution
when updating. Existing callers need no API migration.

The version-owned notes also describe automatic tag delivery and documentation
archives. Admission requires meaningful dated notes and matching support and
documentation records before candidate readiness. Published documentation is
bound to the delivered version's source, with separately attributed editorial
corrections; advancing main does not change that version's behavior baseline.

Source numerical/oracle, composition, lifecycle and bounded performance evidence
belongs to the broadcasting implementation. Actual retained-archive CPU and
physical GPU observations, signing, registry verification and public delivery
remain separate qualification under the [publication procedure](release-publication.md).
