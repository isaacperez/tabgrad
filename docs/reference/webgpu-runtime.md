# Direct JavaScript WebGPU runtime

This reference describes an explicitly GPU-enabled Tabgrad session. GPU
execution does not introduce another tensor API: applications create the same
handles, record operations and observe results through the ordinary runtime.
The extra factory establishes a usable device before returning the session.
Device choice belongs to tensor creation, not to the observation method.

Read the [JavaScript API](../javascript-api.md) for shape, ownership and common
errors, and the [observation flow](../flows/webgpu-observation.md) for how those
contracts cross the GPU boundary. This interface concerns direct JavaScript;
it does not grant Python GPU support or a release-wide browser guarantee.

## Establish a ready session

```javascript
import { createWebGpuRuntimeSession } from "./tabgrad/index.js";

const session = await createWebGpuRuntimeSession();
try {
  const input = session.tensor([1, 2, 3], { device: "webgpu" });
  const output = input.add(input);
  input.close();
  console.log(Array.from(await output.toArray())); // [2, 4, 6]
  output.close();
} finally {
  await session.close();
}
```

`createWebGpuRuntimeSession(options?)` returns `Promise<RuntimeSession>`. It
uses the browser's WebGPU adapter/device acquisition and owns the acquired
device. No partially initialized session is published. The optional
`manifestUrl` has the same CPU-asset meaning as in `createRuntimeSession`.
The optional `setupAbortSignal: AbortSignal` cancels acquisition, including
cleanup of a device returned after cancellation. It does not revoke a session
already returned; use `session.close()` for that lifetime.

The factory requires `navigator.gpu` in an eligible secure browser context and
a usable adapter. Missing WebGPU or no adapter rejects with
`UNSUPPORTED_DEVICE`; acquisition failure uses `BACKEND_LOAD_FAILED` with its
cause. Setup cancellation uses `BACKEND_LOAD_FAILED` as well. The application
must handle rejection rather than assume that a browser name guarantees a
device. No browser flags, native installation or alternate arithmetic engine
are installed by Tabgrad.

Direct JavaScript execution requires neither a worker nor `SharedArrayBuffer`,
cross-origin isolation or JSPI. Ordinary browser security and hosting rules
still apply. A browser's ability to acquire a device is not numerical or
performance qualification for that environment.

## Device and operation domain

`createRuntimeSession()` enables CPU only. The GPU factory enables one
session-owned `webgpu` device **in addition to CPU**. Omitting `device` still
means `cpu`; there are no indexed device names, implicit migrations or silent
fallbacks. Handles from different sessions cannot be mixed.

GPU tensors have contiguous `float32` storage. Creation accepts the common
scalar, multidimensional and empty shapes. It copies input into owned host
storage; upload is deferred until observation. GPU observation uploads even
a creation-only value, so the explicitly selected device is not bypassed by
a host-copy shortcut. Whole-storage `view(shape)` changes metadata without
copying numerical data or performing a GPU dispatch.

GPU `add` accepts two tensors with equal shape on the same device. Repeated
operands, branches and deferred chains follow the shared value/storage rules.
Its precise rounding and exceptional-value contract is the
[binary32 addition decision](../architecture/webgpu-float32-addition.md),
including a separately rounded result for every logical addition. It does not
promise native WGSL floating-point behavior or NaN payload preservation.

GPU `sum()` reduces the whole contiguous tensor to a distinct scalar, including
an empty input's positive-zero write. Its exact-total accumulation and logical
rounding boundaries are specified by the [sum reference](tensor-sum.md).
Admission requires the acquired device's sum workgroup and parameter-buffer
limits before recording work. Kernels use input geometry, not the output's
single element.

GPU `mul` accepts the same equal-shape operands and composes with addition,
views and total sum. The [multiplication reference](tensor-multiplication.md)
owns its call forms, exact stored-binary32 product rounding and exclusions.

Creation accepts `requiresGrad: true`; `session.grad` returns resident-capable,
untracked first-order gradients through add/mul/total sum/views under the
[functional reference](functional-gradients.md). Shared history owns saved
values; derivative operations use this backend, including internal scalar
expansion, without a CPU numerical detour. Reading absent `.grad` remains valid.

First-order [backward and persistent gradients](backward-gradients.md) use these
same operations, histories and mandatory effects. Leaf slots retain canonical
identity across accumulation; selected nonleaf slots can be replaced. Assignment
and clearing preserve exposed gradients and their aliases.

[Basic SGD](sgd.md) uses ordinary coefficient computations, immutable
per-computation metadata and device-local numerical reset. Groups may mix
enabled CPU/GPU parameters while each gradient stays on its parameter's device.
Its arithmetic has one rounding of the exact product plus parameter, as defined
by the [GPU SGD chapter](../architecture/webgpu-sgd.md). Dimensional reductions
and broader optimizer modes remain excluded. Unsupported computations use `BACKEND_CAPABILITY_MISMATCH`.
Capability rejection happens before recording unsupported work. Mixing CPU and GPU
operands is rejected, not interpreted as a transfer. CPU behavior remains
governed by its own operation references.

Same-device equal-shape [`copy_`](tensor-copy.md) updates a tensor and its
whole-storage aliases while preserving public identity and captured old reads.
Source and destination remain independently mutable families even when they
share immutable resident storage. Functional copy derivatives and no-grad
parameter updates use this same runtime and backend.

Allocation admission is bounded by the acquired device's buffer and storage
binding limits and the encoder's one-dimensional dispatch capacity. For the
64-invocation workgroups used by this backend, the latter permits at most
`64 * maxComputeWorkgroupsPerDimension` elements in one tensor. Exceeding
the supported byte extent produces `RESOURCE_EXHAUSTED`. These are admission
limits, not a promise that all permitted allocations will fit available memory.

## Observation, errors and shutdown

`toArray()` returns the ordinary Promise for an independent host
`Float32Array`. Kernels and intermediate values remain on GPU; readback copies
only the demanded storage. Repeating an observation reads the resident result
without rerunning its producer. Closing a handle does not cancel work that
already owns its value.

An asynchronous failure retains the selected program, operation provenance,
phase and native cause. Device loss invalidates GPU admission and GPU resident
values but does not invalidate independent CPU tensors. There is no automatic
device recreation or recovery. Errors from a lost generation cannot publish a
new result through a late callback.

Logical failure and physical completion are different. A failed readback can
reject promptly while its submitted copy still owns resources. The request
keeps its semantic pins and the backend keeps buffers until completion or
explicitly accounted device loss. `session.close()` stops admission and joins
these obligations. It does not replay an error already owned by an observation
as a second cleanup failure, and it does not claim that device loss confirms
hardware memory reclamation.

## Inspect the GPU resource domain

`session.diagnostics().webgpu` is `null` in a CPU-only session, otherwise a
snapshot of the GPU owner. Existing top-level kernel, copy and memory counters
remain CPU counters; adding this device does not change their meaning.

| Field | Meaning |
| --- | --- |
| `state` | `ready`, `lost` or `closed`; a lost owner remains reported as lost after terminal cleanup |
| `adapter`, `features`, `limits` | Browser-provided acquired-device identity, enabled features and relevant limits; identity strings can be empty |
| `ownedBufferBytes` | Bytes in currently owned buffers, including private sum partials and uniforms, readback staging and the minimum four-byte allocation for an empty value |
| `peakOwnedBufferBytes` | High-water mark of that accounting for this backend lifetime |
| `pendingSubmissions` | Completion checkpoints not yet confirmed, including queued uploads; not a hardware queue-depth measurement |
| `unknownCompletionBytes` | Owned bytes conservatively recorded when completion becomes unconfirmable; not reset to suggest confirmed reclamation |
| `uploadBytes`, `readbackBytes` | Cumulative bytes at the named host/device boundaries |
| `kernelCalls` | Encoded numerical dispatches, including an empty sum's scalar identity write; not a count of successfully completed kernels after failure |

These counters are not browser RSS or physical VRAM. They do not include
driver caches, compiler state or every host copy. The common
`liveRequestLeases` includes a failed request that still retains physical-drain
obligations. Use the [performance policy](../performance.md) when interpreting
timing or resource differences, and preserve exact environment qualification
with the evidence rather than inferring portability from one successful run.
