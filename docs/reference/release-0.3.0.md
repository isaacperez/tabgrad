# Tabgrad 0.3.0 source and support record

This record identifies `@tabgrad/tabgrad@0.3.0`, selected npm channel `latest`
and tag `v0.3.0`, under the [release policy](../releases.md). Source metadata
does not establish registry availability. Delivery evidence separately identifies
the exact source, archive/inventory, producer proofs and publication outcome.

## Local managed Python observations

`attachPython()` returns `LocalPythonBinding`, extending the common binding
with `diagnostics(): RuntimeDiagnostics`. Both types are exported from the
Python entry. The [host reference](python-host.md#read-local-runtime-observations)
defines the data, errors and lifetime contract. Applications observe the session
that actually executes their Python, including CPU allocation peaks, Wasm
capacity, kernels, copies and existing semantic counters.

Reading creates detached frozen data without loading CPU or demanding a tensor
value. It adds no per-operation instrumentation, background sampling or retained
reader history. It reuses the runtime's scheduled semantic-cycle collection,
which can traverse ownership graphs, release resources and propagate cleanup
errors. Transient snapshot allocation and collection are not zero-cost; no
general negligible-time, RSS or total-memory bound is promised.

Local reads require the interpreter's JavaScript realm to make progress.
They do not serve an occupied or parked worker. The common/remote
`PythonBinding` and worker protocol retain run/close only. The independent
GPU-controller reader remains available outside the interpreter.

CPU context release resets capacity, current allocation and allocator peaks;
applications retain their own pre-close sample when needed. Cumulative work,
variant and timings remain readable after close. Snapshots do not own tensors
or execution resources and do not certify successful script completion or
cleanup. Tracked Tabgrad buffers and CPU Wasm capacity are not Pyodide heap,
physical RAM or hardware utilization.

Source qualification covers both CPU variants, deferred work, exact small
kernel/copy/allocation controls, gradients, partial failures, immutable old
records, real collector retirement errors, closure and fresh attachment.
GPU metadata detachment and local/remote declaration boundaries have separate
controls. Actual browser and installed-package reports identify their tested
environments and limitations; no other hardware is qualified by inference.

## Preserved support and updating

The [0.2.0 support record](release-0.2.0.md) and inherited tensor API/numerical
boundaries apply unchanged. PyTorch support remains **Partially supported**.
This additive host interface changes no tensor operation, dtype, gradient mode,
arithmetic, dependency, kernel or worker protocol.

Existing callers typed as `PythonBinding` keep that narrower shape. Infer the
attachment result or use `LocalPythonBinding` to access the new method. Replace
the complete matching distribution when updating; no tensor API migration or
new CPU hosting requirement is introduced. When admitted as latest, this
version supersedes 0.2.0 under default-branch maintenance, without a backport or
LTS promise.

The [accepted integration decision](../architecture/python-integration.md#observe-the-session-where-it-is-owned)
records alternatives and constraints. Producer proofs, supplied-archive
CPU/GPU observations and registry qualification remain separate delivery
evidence under the [publication procedure](release-publication.md).
