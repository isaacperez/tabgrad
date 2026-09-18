# Measuring the Python tensor boundary

This command reference is for contributors comparing Python integration costs
with equivalent direct JavaScript work. It describes the maintained procedure
and report fields of `npm run measure:python`. Results from a particular run
belong with its issue or pull request evidence, not in this reference. The
[performance policy](../performance.md) governs comparisons and conclusions;
[development setup](../development.md) supplies the pinned tools and browsers.

## Run the measurement

`npm run measure:python` answers a deliberately bounded question:
what does creation, lazy addition and ordinary observation cost at the Python
boundary, and does the shared runtime change the equivalent JavaScript path?
It is not the
[large-array kernel measurement](webassembly-addition-measurements.md).
It runs vectors of lengths
0, 1, 4, 256 and 4,096, each with chains of 1, 4 and 16 additions. For every
case there is one warm-up followed by five retained timing samples. These
limits expose fixed boundary costs and growth with payload and chain length
without trying to occupy the machine for a throughput measurement.

Prepare an isolated distribution from the intended base revision using the
same pinned TypeScript and Rust toolchain and build settings as the current
checkout. Do not switch or reset a dirty worktree to obtain it. The base must
implement the direct JavaScript tensor contract, but does not need a Python
entry. Set `TABGRAD_MEASURE_BASELINE` to that distribution's absolute `dist`
directory and `TABGRAD_MEASURE_BASELINE_REVISION` to the exact source revision,
then run the command from the current checkout. The command rebuilds only the
current distribution. The operator is responsible for preserving the baseline
build command and its output beside the report: naming a revision cannot prove
that a separate directory was actually built from it.

The runner records hashes of the tracked patch and untracked file contents,
plus exact hashes and raw/gzip/Brotli sizes for both distributions. It checks
that these identities remain unchanged during measurement. A new timestamped
`test-results/python-performance-*.json` retains raw samples, partial case
results and failures rather than overwriting a previous attempt. Reports are
local generated output; review them for publication separately. Distribution
size entries are per file, not a sum claiming that every declaration or module
is downloaded by a browser. Pyodide is host-owned and its distribution must be
accounted separately from the Tabgrad Python entry and source assets.

### Keep the comparisons equivalent

Chrome and Firefox run sequentially, with a fresh profile for each run and
`cache-control: no-store` on served assets. For each CPU variant, the runner
first compares base and current direct JavaScript without loading Pyodide in
either process. Their order reverses between scalar and SIMD. A separate
current-build worker compares Python and direct JavaScript with the same
interpreter already loaded. This keeps interpreter initialization out of the
base-versus-current comparison. The worker alternates which language runs first
by vector-length parity; this is a recorded order, not randomized sampling.

Both the original manifest and the numerical WebAssembly files are served
unchanged. In the scalar profile, a fixture makes only the backend's exact
SIMD feature probe return false. This is controlled feature detection, not
evidence of a machine lacking SIMD. Other validation and all compilation,
instantiation and kernel execution remain real. The SIMD profile uses native
feature detection. Every case asserts its actual selected variant. CPU cases
run without cross-origin isolation and with JSPI disabled before Pyodide loads.

Each case starts with a fresh runtime session, which bounds its allocator's
high-water window to that case. Python reuses the host-owned interpreter but
attaches a fresh binding. The first managed `pass` prepares Python's CPU
backend; direct JavaScript prepares through an empty addition and readback.
These startup operations differ, so their preparation times are descriptive,
not interchangeable performance scores. All timed samples then create two
fresh inputs, form the same chain, observe twice and release their handles.

### Understand what each number measures

The worker records import (including input-container creation, validation and
conversion), lazy operation admission, first demand plus observation, cached
observation, handle cleanup and session close separately. The first observation
includes program formation, kernel execution, data readback and Python list
presentation where applicable. Cached observation includes a new independent
copy and its language presentation. It is not legitimate to subtract their
medians and label the difference as kernel time. The Python managed-entry
duration also includes the measurement script and its diagnostic snapshots;
it is not an isolated host-port round-trip or admission latency measurement.

Backend counters assert two input uploads, one kernel call per addition and two
explicit readbacks per sample, with byte counts determined by vector length.
These establish backend work and transfer equivalence. The separate diagnostic
profile below counts the project-owned language boundaries as well. For each
ordinary duration, all five samples, median,
minimum and maximum are retained. Short samples may fall below browser timer
resolution; a zero or a ratio of tiny quantized durations is not proof that a
boundary has no cost. Startup has one observation per profile and is not a
startup-latency distribution.

Python allocation tracing runs once more per case, separately from the timing
samples. `tracemalloc` reports allocations made while tracing, their actual
peak, live traced bytes before explicit cycle collection and live traced bytes
after it. This includes the measurement's own Python bookkeeping and excludes
pre-existing interpreter allocations and native/JavaScript allocations not
tracked by Python. It is not the interpreter's total live heap. The pinned
Pyodide implementation also exposes the linear-memory buffer extent through
`_module.HEAPU8`; this development-only observation is capacity, not live data,
and is not part of Tabgrad's public host API.

Runtime diagnostics separately record live numerical payload, reserved backend
capacity and logical handle/value/operation/materialization/request counts.
The allocator peak is captured before session close, because close releases
the context and resets its diagnostics. Logical snapshots at formation,
observation and cleanup do not see every synchronous intermediate transition
and must not be labeled complete transient logical peaks. After each sample,
the live runtime counters must return to zero; after close the CPU memory must
also be released. Ordinary handle release and explicit Python collection are
reported separately, not used as interchangeable lifetime proofs.

Only one browser and one measurement worker run at a time. Input sizes and
chain depths keep live numerical payloads below 8 MiB; the runner checks the
64 MiB Tabgrad CPU bound and stops at a failed numerical, ownership or resource
assertion. Browser navigation and application timeouts bound failed runs.
The interpreter and unrelated browser allocations are outside that CPU quota.
Stop the run if observed system pressure contradicts these assumptions.

## Separate call boundaries from ordinary timing

For each browser and CPU variant, a further fresh current-build worker runs a
`boundary-diagnostics` profile after the ordinary comparisons. It exercises the
same lengths, depths and numerical work, once per language and case. These are
diagnostic samples, not extra warm timing samples or a latency distribution.
They never enter the ordinary timing summaries or the base/current comparison.

The measurement fixture wraps actual methods in the emitted runtime modules
and the native `tabgrad_add_f32` export. It forwards receivers, arguments,
return values and exceptions unchanged. Module bytes, integrity validation,
memory and native arithmetic remain real. A temporary export facade allows the
native function to be timed without modifying its non-configurable export
property; unrelated WebAssembly exports are untouched. Wrappers are installed
only in this disposable worker after Pyodide loads and before CPU preparation,
and their original descriptors are restored when the run finishes. None of
this instrumentation is imported by the distributed library.

| Diagnostic boundary | What its inclusive duration contains |
| --- | --- |
| `pythonBufferImport` | Python buffer borrowing, runtime-owned input copy and borrowed-view release |
| `tensorAdd` | The shared runtime's addition admission, not Python argument preparation |
| `pythonObservation` | Synchronous runtime demand, program formation, materialization and readback, not the later Python list conversion |
| `backendExecution` | Allocation, input upload, kernel dispatch and native calls |
| `kernel` | One real native addition call, including its ABI validation |
| `backendReadback` | Allocation validation and copying the resident result out of WebAssembly |
| `tensorClose` | Public handle release, including any resource retirement it triggers |

These boundaries nest: kernel time is contained in backend execution, which
is contained in an uncached Python observation. Do not add their durations or
subtract medians from unrelated samples. The clocks and wrappers add cost, and
very small spans can be zero at the browser's timer resolution. Their purpose
is to identify the measured owners and call growth, not to claim an isolated
planner time or an uninstrumented kernel latency.

Counters reset after session preparation and before each diagnostic workload.
For a chain of depth `d`, the fixture checks `d` additions and native calls,
`d + 2` handle releases, one backend execution and two readbacks, independently
of vector length. Python also checks two buffer imports and two synchronous
observations. These counts exclude attachment, preparation, diagnostic
snapshots and final session close. A scoped Python profiler counts the actual
`to_py()` and memoryview `tolist()` calls inside the tensor observation method;
both must occur twice, and the previous profiler is restored on every exit.
This covers conversion calls without labelling the numerical list conversion
itself constant-time: it still allocates and processes the output elements.

These are counts at named Tabgrad and conversion boundaries, not a census of
every internal Pyodide foreign-function interaction. The report also does not
measure isolated planner duration, total JavaScript heap, live PyProxy count
or all transient logical-record peaks. It is evidence for the named boundaries
and allocator windows, not a claim about general models, training, long-lived
sessions or total browser memory.
