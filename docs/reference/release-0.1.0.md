# Tabgrad 0.1.0 source and support record

This versioned record identifies the public source contract for ordinary
`@tabgrad/tabgrad@0.1.0`, its initially selected npm channel `latest` and repository
tag `v0.1.0`. It is a bounded support record under the
[compatibility policy](../compatibility.md#contents-of-a-release-record), not a
claim that a registry artifact or GitHub release is available. Actual
availability, source revision, archive/static inventory, original proofs and
publication outcome must agree in the authenticated release evidence. A later
`latest` version does not change this record.

## Distribution and application ownership

The public entries are the [direct JavaScript module](../javascript-api.md),
[Python attachment module](python-host.md), physical worker entry and recorded
Wasm/Python assets in the [package guide](browser-package.md). Public declarations
ship with the JavaScript entries; standalone testing and private implementation
paths are not public API. The archive includes the project's Apache License 2.0.
Build/publishing tools and their installed packages are not bundled in the
browser distribution. The official PyTorch runtime is not a runtime dependency. Pyodide is supplied separately by the application;
its admitted integration version is `314.0.6`.

Applications serve the complete matched `dist/` tree, preserve module identity
and replace/restore the complete set together. Ordinary CPU execution needs
baseline Wasm; SIMD is selected only when available. Python executes in a borrowed
interpreter under a managed entry. Direct JavaScript WebGPU needs an eligible
secure context and a usable adapter, without requiring a worker, shared memory,
cross-origin isolation or JSPI. Managed Python GPU additionally uses an
application-owned same-origin physical worker and cross-origin isolation.
CPU remains the default; the physical evidence below identifies a nonfallback
adapter. These checks do not qualify arbitrary
bundler/CDN transforms, transfer between devices, other interpreters or all GPUs.

Direct JavaScript is Tabgrad's own interface, not an assertion of PyTorch call
signatures. `createRuntimeSession`, `createWebGpuRuntimeSession`,
`createWebGpuWorker`, tensor methods, `session.grad`, `session.noGrad`,
`session.sgd`, diagnostics and explicit handle/session/worker close follow their
linked references and shipped declarations. An observation returns owned values;
handles, aliases and independently retained results have distinct lifetimes.
Logical resource diagnostics do not establish RSS, physical VRAM or termination
of every browser descendant.

## Python compatibility boundary

The reference is the maintained native oracle reporting PyTorch `2.14.0`, build
`08187d9e0fba026dc8217405802ab5381dc88d90`, with reference source
`2b3ec34829036a65cd9d1398ea72a0167dc37470`. The retained
[oracle metadata and cases](../../js-tests/fixtures/python-tensor-oracle.json)
and [evidence groups](../compatibility.md#python-tensor-evidence) identify the
observed comparisons. This release reuses that declared reference; it does not
infer PyTorch behavior from agreement between Tabgrad backends.

All groups below first enter the public versioned source at `0.1.0`. Their overall
PyTorch status is **Partially supported**: only the precisely documented subset
is provided. The operation references own the complete accepted signatures,
validation/error boundaries, aliases and gradient interactions; this table fixes
which of those contracts belong to this version, without expanding them.
CPU means both scalar and SIMD Wasm variants. GPU means explicitly enabled
WebGPU in the qualified environment, not CUDA or an upstream PyTorch device.

| Coherent API group and signature reference | 0.1.0 subset and backend | Differentiation, errors and intentional limits |
| --- | --- | --- |
| [Creation, metadata, addition and observation](python-tensors.md): `torch.tensor(data, *, dtype, device, requires_grad, pin_memory)`, `torch.Size`, `torch.dtype`/`torch.float32`, `torch.device`, tensor metadata, documented `torch.add`/`Tensor.add`/`+`, `tolist()` and `item()` | CPU/GPU contiguous float32; scalar or rectangular builtin nested values, empty dimensions and exact equal-shape tensor addition. `dtype=torch.float32` must be explicit. Creation owns a copy; observation returns owned values. | Tracked creation/addition support first-order differentiation. `webgpu` and explicit dtype admission are Tabgrad boundaries; other dtypes/devices, custom input containers, broadcasting, promotion and host-number arithmetic are excluded. The reference distinguishes native binding/error categories from deliberate subset rejection. |
| [Whole-storage views](tensor-view.md): `Tensor.view(*shape)` | CPU/GPU contiguous shape changes preserving the entire storage, with one unambiguous `-1`; scalar/empty cases have their documented rules. | Views alias live numerical state, retain independent wrappers and preserve the specified tracking/history distinctions. No slicing, offsets, arbitrary strides or dtype reinterpretation. Safe-integer shape representability is not native enormous-shape overflow equivalence. |
| [Multiplication](tensor-multiplication.md): `torch.mul(input, other, *, out=None)`, `Tensor.mul(other)`, `*` | CPU/GPU equal-shape, same-device contiguous float32 tensors, including scalars/empty shapes and repeated operands. Results are independent values. | Both first-order input contributions, saved opposite operands and version guards are covered. No broadcasting, scalar operands, promotion, in-place product or mutating `out`. NaN category is compared, not payload identity. |
| [Total sum](tensor-sum.md): `torch.sum(input)`, `Tensor.sum()` | CPU/GPU unary total reduction at any supported contiguous rank, returning a same-device scalar; empty input returns positive zero. | First-order scalar expansion preserves the documented seed/result alias family. CPU and GPU accumulation rules and permitted native differences are explicit; dimensional reduction, `keepdim`, dtype/out options and promotion are excluded. |
| [Matrix product](tensor-matmul.md): `torch.matmul(input, other, *, out=None)`, `Tensor.matmul(other)`, `@`/reflected forms | CPU/GPU contiguous float32 `[M,K] @ [K,N]`, including zero dimensions. Each output uses the declared sequential single-rounding accumulator. | First-order left/right derivatives use internal orientations. Association, cancellation, signed-zero and overflow/NaN cases can differ from PyTorch; there is no universal native bit equality. No vector/batched/broadcast product, public transpose/stride interface, mutating out or optimized-GEMM speed claim. |
| [Persistent copy](tensor-copy.md): `Tensor.copy_(other, non_blocking=False)` | CPU/GPU same-session/device and equal-shape float32, preserving destination identity/whole-storage aliases and copied bits. | Active/no-grad history, saved versions, partial failure and derivative seed aliases retain the reference rules. Larger overlapping scalar-expansion destinations reject independent writes. No conversion, broadcasting, scalar source, arbitrary stride/offset or cross-device transfer. |
| [Recording mode](gradient-recording.md): `torch.no_grad()` | One shared mode per attached session on CPU/GPU; captured restoration and explicitly tracked factories follow the documented rules. | Special views can advertise tracking without a normal accumulator. This is not task-local state, a decorator surface or support for every native grad-mode API. |
| [Functional gradients](functional-gradients.md): `torch.autograd.grad(...)` | CPU/GPU first-order VJP of one output through supported arithmetic/views/copy history, with connected tracked inputs and documented scalar/matching seeds. | Exact result identity/aliases, repeated inputs, retained nonleaf effects, history consumption and conditional waits/failures are covered. Enabled retained/higher-order, batched/materialized or unused-gradient modes are excluded. |
| [Backward and slots](backward-gradients.md): `Tensor.backward(...)`, read/write `Tensor.grad` | CPU/GPU first-order accumulation with documented target/seed forms, identity, warning categories, reset and partial progress. | Leaf slots update existing identities; retained nonleaf slots can be replaced. Assignment and aliases have their stated guards. Enabled retained/higher-order modes, unrelated native tensor introspection and exact error wording are not promised. |
| [Basic SGD](sgd.md): `torch.optim.SGD(...)`, `step(closure=None)`, `zero_grad(set_to_none=True)` | CPU/GPU contiguous float32; ordered groups may mix devices while each parameter/gradient stays on its own. Basic learning rates, closures and resets follow the reference. | Parameter/gradient identities, native-phase dictionary/iterable callbacks, captured associations, one-rounding updates and partial progress are covered. No momentum/decay/Nesterov/maximize training, named parameters, tensor rates, hooks, group addition, state serialization or higher-order training. |

The underlying numerical references define comparison conditions, exceptional
values and tolerated differences for their own operation. A few examples or
backend agreement do not extend those conditions. Errors for valid PyTorch calls
outside this subset are Tabgrad exclusions, not claims that PyTorch rejects them.

`torch.nn`, `torch.nn.functional`, activation families such as `relu`, broader
operators/layouts/dtypes, model-scale compatibility and unrestricted native
PyTorch execution are **Unavailable** in this version. Unqualified browser/device
combinations are **Not evaluated**, even where an implementation might run.

## Qualification and evidence limits

The source is checked by the maintained TypeScript/Rust, Node, browser and
package suites. [Package qualification](package-qualification.md) installs an
identified retained archive outside the checkout, checks public entries/types,
LICENSE and complete installed/static bytes, executes the package README
JavaScript and declared Python examples, and joins owned cleanup. The root
README Python snippet is also executed verbatim in the attached interpreter;
it is not inferred from a similar test string.

Source qualification uses Chrome `156.0.8078.48` and Firefox `158.0.1` on Darwin
`25.6.0` arm64 for the CPU direct/Python/prerequisite profiles, with scalar/SIMD
runtime regression. Physical GPU qualification is Chrome on the reported Apple
adapter, with fallback=false and actual features/limits retained in the report.
The exact candidate inventory and reports in the release source PR identify
what was executed. CI additionally records its actual Ubuntu24.04/browser/tool
versions and selected execution results. Publication qualification must use its
own exact protected-main candidate and originals; an earlier source candidate
cannot be relabeled as that final payload.

The maintained [CPU/WebGPU conformance suites](../development.md#configured-commands)
and native fixture groups protect the supported numerical, alias/identity,
warning/error, callback-order, gradient, resource and failure invariants. Reusing
unchanged runtime/conformance inputs is recorded explicitly; this matrix does
not turn package examples into exhaustive conformance evidence. No new native
oracle generation, timing investigation or whole-model benchmark is implied.

This record establishes no universal browser/GPU support, throughput improvement,
RSS/VRAM bound, whole-model performance or exactly-once remote effects. The
[release policy](../releases.md) and [publication procedure](release-publication.md)
govern actual approval, producer evidence, installation verification, conservation
and recovery. The versioned scope and numerical differences remain the same when
that delivery is verified.
