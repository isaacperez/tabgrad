# Managed Python and direct JavaScript GPU boundary measurements

GPU arithmetic is only part of a user-visible observation. Input construction,
validation, program formation, physical preparation, transport, readback and
Python container conversion contribute different costs. This contributor tool
compares the complete public observation paths while recording their resource
and data-movement boundaries. It does not compare Tabgrad with native PyTorch
or measure an isolated hardware kernel.

The [performance policy](../performance.md) requires a method adequate for the
question before decision measurements. This page defines the maintained
procedure. Each actual calibration, raw result and conclusion belongs with
issue evidence, not in this reference as a universal speed guarantee.

## Build matching artifacts and run the pilot

Use a prepared development environment and a fresh `npm run build`. Then run
`npm run measure:python:webgpu -- pilot`. An installed real-WebGPU Chrome is
the default; `TABGRAD_BROWSER` selects another installed browser. GPU absence
fails the run rather than skipping a sample. The runner serves local pinned
Pyodide and matching distribution files over isolated loopback HTTP and starts
one disposable browser profile at a time. It downloads nothing.

The host acquires the managed GPU controller outside the interpreter worker.
The worker loads Pyodide, removes JSPI capabilities, attaches the single-use
connection and also acquires a direct JavaScript GPU session. These are two
device owners using the same numerical backend, not two concurrent workloads.
Only one measured case runs at a time. Direct JavaScript can await its own
GPU callbacks; ordinary Python observes through the independent physical
worker. That placement difference is part of the comparison.

The pilot uses 65,536, 262,144 and 1,048,576 float32 elements: 256 KiB, 1 MiB
and 4 MiB payloads. Each case has depth eight, one excluded warmup and three
recorded samples. The inputs use identical deterministic mixed-sign dyadic
values in both languages. Their repetition is a declared synthetic
distribution, not a claim about a full model's activations. Sampled output
checks establish the measurement's arithmetic; the separately qualified exact
numerical corpus remains the compatibility evidence.

Inspect timer resolution, individual sample variation and sensitivity across
the size range. The method can resolve a coarse output-dependent cost while
remaining inadequate for a very small formation or transport difference.
Do not interpret repetition alone as proof of growth or convert an
inconclusive small signal into a design conclusion.

## Run the size and depth matrix

After recording the pilot's adequacy for the chosen question, run
`npm run measure:python:webgpu -- measure`. It uses the same sizes with depths
1, 8 and 32, one excluded warmup and five measured samples. The first language
alternates between cases to reduce a systematic order effect. There is no
overlap between requests, measured cases or browsers.

Each sample creates two equal-shape inputs, records the addition chain and
closes expression intermediates without demanding their host values. It
observes the final result twice. The second observation reuses residency but
still performs readback and creates independent host output. Inputs and the
final result remain live until the sample releases their handles. No array
of previous tensor outputs is retained as the sampling history.

The reported timing boundaries have distinct meanings:

| Boundary | Included work and interpretation |
| --- | --- |
| Worker acquisition | Host helper setup and device readiness; separate from Python startup or tensor execution |
| Interpreter startup | Local pinned Pyodide loading and interpreter initialization |
| Direct acquisition | Direct factory and its independently owned ready device |
| Import | Input generation, frontend normalization, conversion and owned input creation; not GPU upload time |
| Admission | Record and validate the lazy chain; not numerical execution |
| First demand and observation | Common formation, needed preparation/upload/execution, result readback and language presentation |
| Cached observation | Readback and language presentation of an already resident result; no producer recomputation |
| Managed entry | Python script coordination and its complete case, including cleanup; not a kernel-only duration |

The JavaScript result is a `Float32Array`; Python returns ordinary Python lists
and numeric objects. The subtraction of their observation times does not
isolate transport overhead: it also includes language presentation and
placement differences. Setup and first-demand samples describe the observed
browser/driver cache state, not guaranteed uncached compilation. No per-stage
hardware timestamp is implied by these wall-clock measurements.

## Inspect costs without changing the decision timings

`npm run measure:python:webgpu -- diagnose` runs a separate disposable profile
with 262,144 elements and depth eight, once per language. It installs
instrumentation only in test workers, not in the distributed implementation.
This profile is a diagnostic, with no excluded warmup or latency-ranking claim;
its instrumented durations must not be pooled with the normal matrix.

The interpreter probe records common request advancement, Python's runtime
observation and connected backend calls. Request advancement includes program
formation, local bookkeeping, submission and retirement; it is not an isolated
formation-function benchmark. Connected execution/read timings cover synchronous
encoding and submission, not completion on the remote GPU. Connected release
joins its physical acknowledgment and therefore includes a wait. The Python
probe separately times construction of the returned nested lists, after the
runtime observation and Pyodide buffer conversion.

The physical-worker probe records preparation and each execution/read result
and drain boundary. Its execution includes command encoding, uploads and queue
completion; its read includes staging, mapping and copying. These are inclusive
wall clocks, not hardware timestamps. Preparation, result, drain and release
can be nested or overlap; their durations must not be added to reconstruct a
total. The observers installed by this diagnostic also have their own overhead.

These boundaries locate costs at their actual owners without presenting every
small contribution as separately resolved. A finer attribution requires its
own adequate method before it can support an optimization decision. The normal
matrix remains the uninstrumented public-boundary comparison.

## Record finite transport and resource ownership

A measurement-only wrapper counts interpreter-side physical requests, host
binding copies and bytes, transferred program computations and allocated
shared-record bytes. The counters do not replace backend byte diagnostics or
measure general browser memory. A sample checks one finite execution, two
readbacks and two host input copies rather than a semantic message per
addition. Release requests are counted separately. Changing the chain depth
must not turn the transport into one remote semantic call per operation.

GPU diagnostics record resident ownership, cumulative boundary bytes and the
owner's cumulative peak. A peak snapshot is not an independently reset peak
for each case; do not subtract historical high-water counters to invent one.
After handle release, resource inspection waits for request retirement before
asserting zero owned GPU bytes, pending submissions, unknown obligations and
semantic records. Direct JavaScript's result Promise can settle before that
retirement. Waiting on this separately observable boundary is outside the
observation latency clock, and does not relabel logical completion as drain.

The interpreter's linear-memory capacity is recorded separately from live
Python allocations. Capacity can grow and remain reserved after objects are
released. It is not live heap, total process RSS or evidence of a leak. Shared
record bytes report allocation volume at that boundary, not simultaneous
live shared payload or physical VRAM. A conclusion about any unmeasured
resource must remain explicitly unresolved.

## Stay within the declared budget

The tool limits backend-owned GPU buffers to 32 MiB and interpreter linear
memory capacity to 256 MiB, each measured burst to five seconds and total
in-worker measurement time to sixty seconds, including interpreter startup,
sampling and worker-side cleanup. The report records this elapsed interval as
`totalMilliseconds`; checks before and after each sample and after cleanup
prevent a late final sample or cleanup from being reported as successful.
Its outer browser deadline is 65 seconds and terminates an unresponsive run.
The in-worker checks are cooperative: they cannot interrupt a browser call
that is stuck or prevent an already running call from crossing the limit;
they reject the run and stop subsequent sampling when the violation becomes
observable. No retry silently expands the limit or shrinks
the workload to hide the effect.

The sizes prebound input payload and retained GPU storage for this declared
workload. These caps are not guarantees on total process memory, driver
allocation or operating-system cache. An unavailable or pressured environment
is a failed measurement, not permission to saturate the machine or manufacture
a passing result. Changing the budget requires the issue's authority.

## Preserve and identify the evidence

Timestamped `test-results/python-webgpu-{pilot,measure,diagnose}-*.json` reports are
ignored local output. They contain the source fingerprint, environment,
individual timings, transport counts and diagnostics, including a failed
partial run when the page returns a report. Inspect reports for privacy before
publishing derived evidence. A harness failure before page reporting remains
in its command diagnostics and must not disappear through a retry.

The host closes its managed GPU controller and terminates its application-owned
interpreter worker before reporting. A successful page result alone still does
not establish a successful command: native browser termination and profile
cleanup are independently checked by the harness. A failed closure remains a
failed run even when its workload produced valid observations.

The source fingerprint covers regular TypeScript files throughout `src/`,
including nested directories, using the [shared source-identity method](webgpu-measurements.md#typescript-source-identity)
also used by direct GPU measurements. It is not proof that a stale distribution
was rebuilt, and does not identify the Python source, interpreter, measurement
fixtures or contributor tools. Final evidence must identify those exact inputs
and the emitted distribution too. Keep the first failed attempts,
calibration rationale, successful observations, uncertainty and resulting
decision together under the performance policy.
