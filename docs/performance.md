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

## Measure the WebAssembly addition path

`npm run measure` is the bounded measurement entry point for the direct
JavaScript `float32` addition path. It rebuilds the release-style browser
distribution and runs one headless browser process at a time. It measures the
scalar and `simd128` modules separately in Chrome and Firefox. There are two
complementary views because a raw kernel and a public lazy tensor observation
answer different performance questions.

The public-path view uses lengths 1, 4,096, 262,144, and 1,048,576. Each case
has one cold observation and five sequential warm observations. A duration
starts immediately before `toArray()` and therefore includes every cost users
actually encounter at that observation boundary: on the cold path this can
include loading and initializing the backend; on every newly formed result it
includes program formation, allocations, the kernel call, and result readback.
The runtime diagnostics separate the setup and data-movement counters needed
to interpret that end-to-end duration.

The raw resident-kernel view exists only to make an equivalent comparison with
the accepted experiment in issue #31. It invokes the exact production
WebAssembly artifact over already resident inputs and output with vector length
262,144, seven warm-ups and 31 timed calls in each of three rounds. Each round
runs in a fresh, cross-origin-isolated browser process with one fixed 64 MiB
WebAssembly memory. The report retains all 93 samples, their median and 95th
percentile (using the nearest-rank definition), and the duration and artifact
size differences and ratios against #31 for the same browser and variant.
Those historical measurements belong only to this raw view;
comparing them with public-path durations would conflate kernel execution with
runtime and transfer work.

The largest public-path case contains two source inputs, runtime-owned host
copies, at most three resident tensor payloads, and sequential readbacks. The
raw view uses exactly one 64 MiB WebAssembly memory and resident buffers. The
command does not create workers and never runs more than one browser process,
backend context, or JavaScript thread at a time. This preserves the declared
64 MiB experiment-owned limit and avoids using all machine cores.

The report records:

- exact Git revision, dirty-state fingerprint, time, operating system,
  architecture, Node.js, npm, Rust, browser, and module variant;
- raw, gzip, and Brotli sizes for each generated distribution file;
- individual cold and warm observation durations rather than only a fastest
  sample;
- all raw resident-kernel samples, round boundaries, robust summaries, and the
  exact #31 revision and medians used for the equivalent comparison;
- manifest fetch, module fetch, integrity check, WebAssembly compilation, and
  instantiation durations exposed by runtime diagnostics;
- host-to-WebAssembly and result-readback bytes and copy counts, kernel-call
  count, live and high-water payload and aligned allocation bytes, and
  WebAssembly memory size; each observation also records the diagnostic
  snapshot after explicit tensor and session cleanup;
  and
- the workload and concurrency limits needed to interpret the observations.

The command writes `test-results/performance.json`. That file is disposable and
ignored; the issue or pull request under review preserves the relevant raw
report and conclusion. The measurement is intentionally not a required CI
threshold because short browser durations are quantized and shared-runner noise
would make an absolute gate misleading. Deterministic call, copy, payload, and
reuse invariants remain assertions in the ordinary test suite.

This microbenchmark establishes the boundary's cost shape only. It cannot be
used to claim general tensor, transformer, training, or large-language-model
performance.
