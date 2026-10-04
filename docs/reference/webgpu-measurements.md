# Bounded WebGPU resource measurements

This contributor procedure separates device acquisition, pipeline preparation,
host upload, resident execution and staging readback. It measures the concrete
contiguous float32 addition backend, not whole-model throughput, native PyTorch
performance or isolated hardware kernel time. Use the shared
[performance policy](../performance.md) to decide whether its observation
boundaries can answer a particular question.

## Calibrate before interpreting

Build the distribution with `npm run build`, then run
`npm run measure:webgpu -- pilot`. The command requires an installed Chrome
with a usable WebGPU device and permission to launch a temporary profile and
serve loopback HTTP. `TABGRAD_BROWSER` selects another installed browser;
unavailable GPU execution is an error, not a skipped sample. No flags enable
an otherwise unsupported device, and no packages are downloaded by this tool.

The pilot records the smallest observed timer increment and three samples at
262,144, 1,048,576 and 2,097,152 elements, with depth eight. Each execution
sample contains sixteen sequential resident invocations, with three unrecorded
warmup batches. There is no overlap between requests or browsers. Batching
keeps input residency and per-invocation output allocation/release intact; it
does not replace realistic payload scale with tiny inputs.

Inspect raw spread as well as resolution before choosing a conclusion. A
coarse timing difference substantially larger than both may be observable
while a small overhead difference remains unresolved. Readback samples are
not batched and can be too short for fine comparisons. Device and pipeline
acquisition describe the observed browser/driver cache state, not a guaranteed
uncached startup. An inadequate pilot must not be converted into a performance
claim merely because the functional results are correct.

## Run the declared matrix

After recording why the method is adequate, run
`npm run measure:webgpu -- measure`. This uses the same three payload sizes
with depths 1, 8 and 32, closed disposable intermediates and five measured
batches per case. Two independently seeded deterministic inputs contain
mixed-sign float32 values in `[-1, 1]`, exercising alignment and cancellation
instead of one uniform arithmetic branch. They are a declared synthetic
distribution, not a claim about a particular model's activation statistics.
A separate 262,144-element comparison retains all
intermediates at those depths. One public runtime observation at 1,048,576
elements and depth 32 records an end-to-end integration boundary separately.
That public sample uses uniform positive ones and labels that distribution in
its report. It is descriptive, not a latency distribution or the same-input
counterpart of a physical sample.

Each case acquires its own device owner, prepares its pipeline, uploads two
inputs, performs warmup and measures execution/readback. Resident execution
times include encoding, output allocation, queue completion and intermediate
cleanup, plus release between the sixteen invocations. Divide by the recorded
batch count only when describing mean time per invocation inside that batch;
do not label it an isolated GPU kernel duration. Readback includes staging,
mapping, host copying and physical retirement.

The physical samples call the maintained backend/program boundary. The public
sample also includes shared runtime formation and observation. The two paths
have different costs and retention conditions; subtracting them does not
isolate a single abstraction's overhead.

## Resource limits and accounting

The tool preflights a 64 MiB cap for backend-owned GPU buffers, checks the
observed high-water counter, limits each measured phase to five seconds and
the browser workload to sixty seconds, and runs only one browser at a time.
The runner's outer deadline terminates an unresponsive browser; an in-page
clock check cannot interrupt a stuck GPU operation itself.

Host references retain bounded input/result arrays rather than an array per
invocation. Driver allocations, garbage-collector timing, browser caches and
process RSS are not measured or capped by the GPU byte counter. These are
small resource-qualification workloads, not an attempt to fill device memory.
Do not increase them beyond the authorized budget to obtain a preferred result.

Every physical case checks sampled output values, records resident and peak
owned bytes, releases outputs between invocations and verifies zero owned
bytes and pending checkpoints after input release. Retained intermediates must
change storage obligations; closed intermediates must not accumulate payload
merely because the chain is deeper. Correctness qualification uses the separate
exact numerical corpus; the measurement's sampled values do not replace it.

## Preserve results and limits

Timestamped `test-results/webgpu-{pilot,measure}-*.json` reports are ignored
local output. They contain environment, source fingerprint, raw samples,
adapter information and resource snapshots. Inspect reports for privacy
before publishing derived evidence. Preserve unsuccessful attempts as well
as successful runs with the issue or reviewed evidence, not in normative docs.

The verifier must identify the exact distribution, measurement tool and fixture
revision as well as the source fingerprint described below; that fingerprint
alone does not prove that a stale distribution was rebuilt. Report whether the
adapter is a fallback and distinguish accounted bytes from physical VRAM or total browser
memory. Neither a bounded growth observation nor one adapter's timings
establishes general asymptotic or cross-browser performance guarantees.

## TypeScript source identity

The direct and managed GPU measurement commands use the same contributor helper,
`scripts/source-identity.mjs`, for the report's `sourceSha256`. It enumerates all
regular files ending in `.ts` beneath `src/`, including nested directories and
`.d.ts` declarations. It sorts root-relative paths using JavaScript's default
string order, with `/` as the directory separator, then feeds each UTF-8 path
followed immediately by that file's raw bytes into one SHA-256 hash. There are
no added delimiters or length fields: an unchanged flat tree retains the former
sorted filename/byte identity. Empty trees use the empty byte-stream digest;
other extensions and empty directories contribute nothing.

Symbolic-link entries are rejected, even when they name a directory or an
excluded extension. The helper does not follow external trees, silently omit
linked sources or loop through directory links. Enumeration and file-read
failures propagate rather than yield a partial report identity. The caller
supplies the trusted local source directory and must keep it stable while the
tool reads it; this method is not an atomic snapshot of concurrent edits.

This is a bounded contributor source fingerprint, not a canonical provenance
commitment or execution proof. It does not cover the contributor helper itself,
Python assets, interpreter, measurement fixtures or emitted distribution. Record
those inputs separately under the [performance policy](../performance.md).
Discovery and hashing require no browser, GPU workload or dependency installation.

## Total-sum workload

`npm run measure:webgpu -- pilot sum` and, after adequate calibration,
`npm run measure:webgpu -- measure sum` select the maintained total-sum page.
Omitting the last argument retains the addition procedure above. Sum uses
65,536, 262,144 and 1,048,576 elements, one resident input and a four-byte scalar
result. The deterministic input is `(index % 17 - 8) / 4096`; all subset sums
are exactly representable at these sizes. The independent expected total is
checked on each observed batch. This is a synthetic resource workload, not
the numerical qualification corpus or a native PyTorch benchmark.

Each size acquires a fresh owner, separately times preparation/upload, then
runs three excluded warmup batches and three pilot or five decision batches.
Each batch performs sixteen serialized complete invocations, retiring private
partials/uniforms and the previous scalar between invocations. Input stays
resident; readback observes only the final scalar. The reported execution
clock includes encoding, allocation, submission, completion and cleanup.
Preparation describes the observed driver cache state, not cold compilation.

For each case, the report records analytical input/output/private bytes beside
fresh-owner peak, resident and released counters. With stage count `D` and
nonfinal partial count `S`, private bytes are `44*S + 16*D`. Readback owns four
additional bytes at its distinct phase. Prepared pipelines retain no partials
or uniforms. Accounting does not measure compiler memory or physical VRAM.
The same direct-tool 64 MiB, five-second phase and sixty-second workload caps
apply. Reports use `test-results/webgpu-sum-{pilot,measure}-*.json`.

Inspect timer resolution and batch spread before interpreting coarse costs;
short individual scalar readbacks may remain unresolved. All three sizes use
three stages, so this range does not measure a stage-count transition. There
is no earlier production GPU sum to serve as a before/after timing baseline.
Descriptive cost, accuracy and resource evidence must not be relabeled as a
speedup, CPU/GPU numerical equivalence or general scaling guarantee.
