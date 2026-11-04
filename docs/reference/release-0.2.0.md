# Tabgrad 0.2.0 source and support record

This record identifies `@tabgrad/tabgrad@0.2.0`, selected npm channel `latest`
and tag `v0.2.0`, under the [release policy](../releases.md). Source metadata
does not establish registry availability. Release evidence separately identifies
the exact source, archive/inventory, producer proofs and publication outcome.

## Managed GPU observations

The controller returned by `createWebGpuWorker` adds
`diagnostics(): WebGpuDiagnostics`; its result type is exported from the Python
entry. The [host reference](python-host.md#read-managed-gpu-observations) defines
the fields and lifetime semantics. The application reads existing physical
service observations outside the interpreter, including while Python is parked.
No method is added to local or remote `PythonBinding`.

Snapshots contain detached frozen data, not tensors, device handles or live
execution owners. Reading does not demand output, flush a queue, read back a
numerical payload or add GPU work/history. Explicit reads create bounded
transient objects and load the existing shared record; code and observation
cost are not literally zero. There is no new per-operation publication or
instrumentation. No general latency, process-memory or physical-VRAM bound is
promised.

The supported observation boundary covers acquired metadata, empty/zero data,
connection transfer, intentional retirement, acknowledged close and last-known
obligations after unacknowledged worker loss. Fields can span publication
updates and do not certify script success or physical completion. Browser
privacy may leave adapter strings empty. These are service-owned buffers,
transfers and encoded work, not all-device utilization or completed-kernel time.

Source checks cover public typing/imports and controlled lifetime/resource
contracts. Managed physical-browser checks cover exact small payload/operation
expectations, gradients, CPU-only control, reading outside a parked interpreter,
partial script failure and final acknowledged cleanup. Actual reports identify
the browser/device and limitations; no other hardware is qualified by inference.

## Preserved support and updating

The [0.1.3 support record](release-0.1.3.md) and inherited tensor API/numerical
boundaries apply unchanged. PyTorch support remains **Partially supported**.
This additive host observation API is not a new PyTorch operation, data type,
gradient mode or arithmetic promise. No dependency, worker protocol, kernel or
Python tensor behavior changes.

Existing applications need no tensor API migration. Applications using the
new reader must update the complete matching distribution and retain the
controller they already own. CPU-only Python does not acquire a GPU implicitly.
When admitted as latest, this version supersedes 0.1.3 under the default-branch
maintenance policy; no LTS or backport promise is added.

The controlled producer qualifies/signs its retained bytes. Supplied-archive
CPU/GPU observations and installed-registry qualification remain separate
delivery evidence under the [publication procedure](release-publication.md).
The accepted [observation decision](../architecture/webgpu-integration.md#observe-the-gpu-owner-outside-python)
records alternatives and the reasons for this boundary.
