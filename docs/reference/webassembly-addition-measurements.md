# Measuring WebAssembly addition

This command reference is for contributors comparing the cost of the direct
JavaScript addition path and its resident CPU kernel. It defines the maintained
workloads, measurements and resource limits of `npm run measure`, not a general
performance guarantee. Read the [performance policy](../performance.md) for
comparison and evidence rules, and [development setup](../development.md) for
the required toolchains and installed browsers.

## Run the measurement

`npm run measure` is the measurement entry point for the direct
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
backend context, or measurement JavaScript thread at a time. The fixed 64 MiB
limit belongs to the raw-kernel WebAssembly memory;
it is not a bound on the whole browser process or every host allocation.

## Read and preserve the report

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
report and conclusion. Preserve an attempt before rerunning: this output path
is reused, unlike the Python boundary tool's timestamped reports. The dirty
fingerprint hashes Git status text, not changed file contents, so also retain
the exact patch and identities of untracked inputs when measuring a dirty tree.

The measurement is intentionally not a required CI
threshold because short browser durations are quantized and shared-runner noise
would make an absolute gate misleading. Deterministic call, copy, payload, and
reuse invariants remain assertions in the ordinary test suite.

This microbenchmark establishes the boundary's cost shape only. It cannot be
used to claim general tensor, transformer, training, or large-language-model
performance.
