# Performance and resource measurements

This document defines how Tabgrad measures runtime speed, startup, compilation,
memory, transfer cost, and distributed size. Performance evidence must be
comparable and reproducible; one fast run is not a benchmark.

## Decide when measurement is required

Measure when an issue claims an improvement, when a change affects scheduling,
kernels, storage, memory reuse, transfers, graph execution, package loading, or
another known hot path, or when review identifies a material regression risk.
Do not require benchmarks for changes that cannot plausibly affect a measured
resource.

Define the metric and acceptable consequence before interpreting results. The
issue should state whether the goal concerns latency, throughput, warm-up,
shader compilation, Python-to-JavaScript calls, CPU or GPU memory, transfer
volume, bundle size, or another observable cost. Do not combine unrelated
metrics into an arbitrary score.

## Establish measurement adequacy

Before collecting measurements intended to support a performance conclusion or
design recommendation, establish that the method can answer the stated
question. Record this justification with the measurement plan; naming a
representative workload or taking many samples is not sufficient by itself.

- Identify the realistic operating conditions and the effect or bound that
  would matter to the decision. Explain how the selected workloads and scales
  preserve the computation, allocation, transfer, or retention cost at issue.
- Define the observation boundary and demonstrate sufficient sensitivity to
  that effect or bound, using relevant existing evidence or a bounded pilot.
  Account for instrument resolution, variation, measurement overhead, and
  fixed costs that could mask the behavior being studied. Apply this to memory
  measurements as well as timing; distinguish counted allocations from
  observed process or device memory.
- For a growth claim, vary the relevant dimension across a justified range
  that can expose the expected compute or memory regimes. Repeating one small
  workload is not evidence of scaling. Repetition or batching may improve
  sensitivity only when it preserves the relevant execution, cache, and
  resource-lifetime behavior; it cannot replace representative workload scale.

Keep correctness checks, calibration, and decision evidence distinct. Small
inputs are useful for functional tests and can be representative for a
small-workload latency question. A pilot may reveal that the proposed method
is inadequate; its purpose is to establish sensitivity, not to justify the
preferred outcome. Neither a minimum tensor size nor a full-model benchmark
is required universally.

If adequacy cannot be established, revise the workload, instrumentation, or
method before proceeding to decision measurements, or report the performance
question as unresolved. Stay within authorized time, concurrency, and memory
limits. Do not silently increase resource use or shrink the workload until
the relevant effect disappears; request a changed budget when necessary.

Reassess adequacy if the collected results contradict the calibration or
reveal a different cost regime. Evidence that cannot resolve a material effect
must not support a dependent conclusion or recommendation, including claims
of equivalence or negligible overhead. Conversely, a sufficiently sensitive
method may support a bounded conclusion of no meaningful difference; finding
a nonzero difference is not a requirement. Retain independently valid
correctness observations, and limit every performance conclusion to the
workloads, ranges, and sensitivity actually established.

## Compare equivalent states

Compare the proposed change with its intended base using the same machine,
browser, backend, power state, build mode, dependency resolution, input,
random seed, and benchmark procedure. Record both exact revisions.

Use representative workloads and include boundaries that might expose a
different cost. Explain why the selected shapes, data types, operation chains,
model fragments, or data transfers represent the behavior at issue. Do not
generalize a narrow microbenchmark to whole-application performance.

For WebGPU, account for asynchronous submission and synchronize at a defined
observation point. Separate setup, shader compilation, data transfer, and
steady-state execution when they answer different questions. For browser and
Pyodide startup, distinguish cached from uncached resources.

## Control variation

Record warm-up, repetitions, sample order, synchronization, cache state,
background-load controls, and measurement tool. Report the individual samples
or a durable raw result, not only the best run. Use a robust summary such as
the median together with spread or percentiles appropriate to the sample.

Investigate outliers, throttling, timer resolution, compilation reuse, garbage
collection, GPU queue overlap, and other sources of noise when they could
change the conclusion. A retry does not erase an earlier result.

Memory evidence must state what was measured, when it was measured, and
whether it includes host arrays, GPU allocations, caches, compiled pipelines,
and retained autograd state. Bundle evidence must compare the files users
actually download and distinguish raw, minified, and compressed sizes.

## Interpret a change

A performance change is acceptable when it satisfies the budget or tradeoff
approved by the issue and does not hide a material cost in another metric or
workload. When no numeric budget exists, report the measured difference and
uncertainty and require a decision if the regression is material to common or
documented use.

Do not trade correctness, determinism, compatibility, security, privacy, or
clear failure behavior for speed unless the issue explicitly defines and the
project approves that public tradeoff. An optimization must preserve behavior
with tests separate from its performance measurements.

Store the method, environment, raw observations, analysis, limitations, and
conclusion in the research issue or another durable artifact linked from the
pull request. Register generated benchmark artifacts under
[`generated-files.md`](generated-files.md) if they are committed.

## Detect regressions over time

Add a continuous benchmark only when its environment is stable enough to
produce actionable results and its ownership and cost are clear. Set thresholds
from measured variation, not convenience. A noisy shared runner should report
trend evidence rather than block every change on an unreliable absolute time.

When a regression appears, confirm it with comparable runs, identify whether
the change caused it, and preserve the evidence. Do not increase the threshold
or remove the benchmark merely to make the result pass.

## Choose a maintained measurement procedure

A concrete measurement tool defines which workload it runs, where its clocks
start and stop, which resources it observes and what it cannot establish.
Choose a procedure whose observed boundary answers the issue's question; do
not interpret a public observation duration as an isolated kernel duration.

- [WebAssembly addition measurements](reference/webassembly-addition-measurements.md)
  describes the direct JavaScript path and resident CPU-kernel comparison.
- [Python tensor boundary measurements](reference/python-boundary-measurements.md)
  describes equivalent JavaScript/Python workloads, baseline setup, conversion
  and observation timings, and bounded resource diagnostics.

These references own their command-specific workloads and interpretation.
They do not establish general performance guarantees. Keep each actual run's
configuration, observations, failures and conclusions with its evidence as
specified above.
