# Compatibility and public API support

This document defines how Tabgrad records compatibility with PyTorch and the
support boundaries of its public Python and JavaScript interfaces. A
compatibility record describes a named release and evidence, not implementation
progress or a product roadmap.

## Meaning of compatibility

Tabgrad is an independent implementation. A compatible operation must match
the referenced PyTorch behavior for every dimension claimed in its entry,
including the applicable signature, values, shapes, data types, broadcasting,
views and aliasing, gradients, devices, errors, and state changes.

Compatibility is bounded by a named PyTorch version or documentation revision,
specified inputs, and tested environments. Passing a few examples does not
establish general compatibility. Differences must be explicit and must not be
hidden behind silent fallback behavior.

### Preserve observable PyTorch behavior throughout the work

For a PyTorch-facing operation, establish the reference behavior before choosing
its design or implementation. The internal representation, execution strategy
and backend may differ; the covered user-visible behavior may not be replaced
with a simpler or more convenient contract.

Record the relevant signatures, defaults and calling forms; return types and
identity; numerical comparison rules; shapes, dtypes and devices; aliasing and
mutation; gradient recording and connectivity; state transitions; and error
categories and observable validation boundaries. Include composition and mode
interactions when they can change those facts. Use versioned official sources
and the prepared native oracle for unresolved behavior. Missing evidence is an
unresolved question, not permission to invent semantics.

Define the intended subset before evaluating alternatives. A new exclusion or
Tabgrad-specific requirement that rejects a valid reference call needs an
explicit scope decision under [CONTRIBUTING.md](../CONTRIBUTING.md) and
[project management](project-management.md), with its consequence explained;
implementation convenience or documenting the difference afterward does not
establish that decision. Existing documented exclusions remain bounded
exclusions, not evidence that PyTorch rejects the call. This rule does not claim
the entire PyTorch surface or turn Tabgrad integration/lifecycle extensions
into native PyTorch behavior.

Carry that observable contract and its contrary cases through research,
implementation and independent verification. Compare the same covered calls
against the pinned reference, with declared numerical tolerances and explicit
environment limits. A discrepancy requires correction or an unresolved scope
decision; do not change a reference-backed expected result to accommodate the
implementation, silently narrow the domain or declare compatibility merely
because Tabgrad's own tests agree. An internal architectural alternative that
changes covered observable semantics does not qualify as a compatible
alternative.

Use these statuses:

| Status | Meaning |
| --- | --- |
| `Supported` | The documented scope is implemented and verified on every environment and dimension listed in the entry. |
| `Partially supported` | A precisely stated subset is implemented and verified; the missing or different behavior is listed. |
| `Unsupported` | Tabgrad deliberately does not provide the behavior and rejects it clearly. |
| `Unavailable` | The named release does not provide the behavior and makes no compatibility claim for it. |
| `Not evaluated` | An implementation may exist, but the evidence is insufficient to make a compatibility claim. |

Do not use `Supported` for proposed behavior, an unmerged change, a backend
that was not tested, or an implementation that silently uses another backend.

An accepted numerical design is a requirement, not release-support evidence.
The [WebGPU float32 addition decision](architecture/webgpu-float32-addition.md)
defines a bounded operation's rounding and exceptional-value contract. It does
not establish an implemented WebGPU interface, qualify every browser or extend
that numerical rule to unrelated operations. A release record must separately
identify the implementation, environment and conformance evidence it claims.

## Direct JavaScript behavior without a PyTorch claim

Tabgrad can establish its own browser integration behavior without claiming
that the behavior implements a PyTorch interface. The direct contract in the
[JavaScript tensor API](javascript-api.md)—session and tensor creation,
equal-shape contiguous CPU `float32` addition and multiplication, total sum, functional gradients,
asynchronous observation, diagnostics,
and explicit close—is such an interface. Its tests establish Tabgrad's
JavaScript and WebAssembly behavior only. The names are not `torch` names, and
the bounded example does not establish PyTorch signatures, promotion,
broadcasting, errors, gradients, or Python behavior.

Do not add that interface to a release's PyTorch support matrix as `Supported`
or `Partially supported` unless an independently tested Python compatibility
surface gives it a real PyTorch counterpart. Its precise support and browser
limits belong in the JavaScript API reference; this document records why those
facts are not a disguised compatibility claim.

The [direct JavaScript WebGPU interface](reference/webgpu-runtime.md) likewise
has its own device and operation domain. Its exact-integer numerical oracle,
packaged real-device browser checks and controlled lifecycle tests answer
different questions: numerical cases, physical integration and failure
ownership respectively. A controlled device double does not qualify real GPU
execution. Neither that interface nor a successful GPU browser run establishes
Python GPU support. Release evidence must name the browser, operating system,
adapter, enabled features and limits, and whether the adapter is a fallback.

## Required operation record

### Python tensor evidence

The [managed GPU connection reference](reference/python-host.md) defines the
host helper, single-use attachment, independent physical worker and ordinary
Python observation. `webgpu` is a Tabgrad device extension, not a native
PyTorch device identifier. The packaged Python GPU fixtures combine the
accepted exact float32 addition and total-sum corpora with scalar, nested, empty, chained,
branched and contiguous-view cases; they explicitly remove JSPI before loading
the pinned interpreter. CPU remains independently available in that binding.

Separate lifecycle profiles use a real GPU and a controlled acknowledgment
gate after actual queue completion. They distinguish revocation, deliberate
device destruction, an injected physical-worker error and host-reported
interpreter termination. These controls establish boundary behavior, not the
frequency of real hardware failures or automatic detection of a silent hang.
Unacknowledged worker loss preserves last-known owned/pending counters and
unknown-completion accounting rather than reporting successful drain or zero
physical VRAM. Exact qualified browser, operating-system, adapter and artifact
identities belong in the verification evidence. This evidence does not expand
GPU support to multiplication, dimensional reductions, gradients or untested environments,
and does not itself establish a release's support status.

The [multiplication reference](reference/tensor-multiplication.md) defines the
tensor-only equal-shape product. Native `mulCases` and `mulOperations` record
operand/result float32 bits, metadata and positional/keyword forms. Exact bit
comparison excludes NaN payload identity; signed zero, subnormal/underflow,
overflow, non-finite products and separate multiply-add rounding have dedicated
cases. Raw scalar/SIMD and real Pyodide tests consume this evidence. Direct
runtime and Chrome/Firefox tests exercise composition, aliases, cleanup and
ordinary Python observation, including both CPU variants in interpreter workers
with JSPI disabled. Broadcasting, host-number operands, mutation, promotion and
higher-order gradients remain explicit subset exclusions rather than claimed PyTorch errors.

The [total sum reference](reference/tensor-sum.md) defines unary total reduction
and its numerical domain. Native `sumCases` record scalar metadata, input bits,
ordinary finite results and explicit cancellation/overflow cases. CPU variants
and Pyodide consume those fixtures with the stated comparison method; permitted
overflow-order differences are recorded separately from ordinary error bounds.
Lifecycle, mixed-graph and browser checks complement numerical comparisons.
This sum-specific evidence does not cover dimensional reductions or promotion.
Functional derivative evidence is recorded separately below.

The [Python tensor reference](reference/python-tensors.md) defines the bounded
creation, metadata, addition and ordinary observation contract. Its native expectations are generated
from the pinned oracle by `scripts/generate_tensor_oracle.py` and consumed by
real-interpreter tests. The fixture records exact build/source revisions,
inputs, comparison rules and selected error classes. Tabgrad-only restrictions
have separate assertions rather than being attributed to PyTorch.

The [contiguous view reference](reference/tensor-view.md) defines the shape-only
Python and JavaScript overloads. Native `viewCases` cover positional, tuple and
list syntax, scalar and empty results, singleton dimensions and unambiguous
inference. Selected invalid calls record native error categories. Real Pyodide
tests compare metadata and nested values, exercise addition and wrapper cleanup,
and reject excluded overloads. Direct runtime tests establish shared allocation,
materialization, alias retention, reuse and rollback; numerical equality alone
does not prove storage sharing. Browser fixtures exercise views through both
the managed Python and direct JavaScript paths. These bounded cases exclude
dtype reinterpretation and non-contiguous access;
Tabgrad's large-empty-shape representability policy is not attributed to PyTorch.

The [functional gradient reference](reference/functional-gradients.md) defines
creation-time tracking and one-output first-order `torch.autograd.grad` through
addition, multiplication, total sum and contiguous views. Native PyTorch 2.14.0
`gradientCases` record exact small-number values, shapes and result tracking for
branches, repeated inputs, leaves/intermediates, nonunit seeds, interior sums,
empty dimensions, hidden computed operands and reusable payload-free history.
`gradientErrors` record selected nontracking, disconnected-input, seed-shape,
implicit-seed and consumed-history error categories. Real Pyodide consumes that
same source and expected result data. The generator uses one intra-operation
and one inter-operation thread; no NumPy or native runtime is distributed.

The [recording scope reference](reference/gradient-recording.md) defines
`torch.no_grad()` contexts and the direct JavaScript callback integration.
`noGradCases` freeze native context returns, binding error classes, sequential
reuse, same-object reentry, captured overlap, factory exceptions, explicit
gradients and joined asyncio mode sharing. `noGradViewCases` record scalar,
empty and matrix values/shapes/tracking, derivative connectivity and error
classes for immutable plain/leaf/nonleaf/ordinary-view bases, special views,
children and active absent-edge nodes. Both real Pyodide and direct CPU
scalar/SIMD consumers use the pinned expectations. Callback result/throw,
Promise settlement, cross-entry state, stale binding contexts and explicit-GC
retention have separate Tabgrad integration tests. Browser fixtures exercise
ordinary CPU Python and direct calls with controlled-absent JSPI. These cases
do not independently qualify mutation, decorators, inference mode or GPU gradients, and do
not establish a speed or total-memory claim. The official reference is
[PyTorch 2.14 no-grad](https://docs.pytorch.org/docs/2.14/generated/torch.no_grad.html).

Direct scalar/SIMD runtime and raw expansion tests additionally cover current
Tabgrad admission atomicity, saved pins, iterative deep traversal/release, dropped results, backend
failure and shutdown. Browser fixtures exercise direct scalar/SIMD derivatives
and managed Python observation with native and controlled-absent JSPI. Exact
tested browser versions belong in verification evidence. Tracking seeds,
retained/higher-order modes and unused-input modes in the functional API are
intentional subset exclusions tested as Tabgrad restrictions, not attributed
to native rejection. Official references are
[PyTorch 2.14 functional gradients](https://docs.pytorch.org/docs/2.14/generated/torch.autograd.grad.html)
and [autograd mechanics](https://docs.pytorch.org/docs/2.14/notes/autograd.html).

Real Pyodide tests also consume those numerical fixtures through `tolist()` and
check independent lists of Python floats, nested control flow, common demand
with JavaScript, entry-context rejection and failure ownership. Browser
fixtures exercise ordinary CPU observation with unmodified capabilities and a
controlled absence of JSPI established before Pyodide loads. That control is
reported as such, not as evidence from an older native browser build.

The worker fixture additionally exercises application-owned interpreter
placement, off-worker entry and close, borrowed globals and stale wrappers.
Normal CPU cases run without isolation; a separate shared test gate verifies
host responsiveness while Python is parked. The gate is not a runtime CPU
requirement. Endpoint tests separately cover loss and diagnostic transport.

This evidence group does not establish a release support status, general
PyTorch compatibility or coverage of every CPU variant in every Python/browser combination. A release
record must still identify its exact environment and interface dimensions
under the rules below.

The [persistent copy reference](reference/tensor-copy.md) defines the CPU
same-session equal-shape tensor subset. Native `copyCases` preserve effective
`other` binding, boolean options, return identity, scalar/empty/matrix values,
active/no-grad connectivity, saved invalidation, consumable view history and
inherited special-view provenance. Packaged Node and browser Pyodide consume
these same cases; direct CPU scalar/SIMD tests independently establish float32
bits, snapshots, failure responsibility, real owner/lease release and finite
admission. This scope excludes native broadcasting, number sources, conversion,
GPU mutation and broader gradients. Deferred backend failure is a Tabgrad
integration contract. Existing read-only GPU consumers retain their separate
qualification; CPU mutation does not expand that GPU domain.

### Functional failure progress

At integrated revision `7177488b66db00629e3737cee8b36495534d4d89`, functional
CPU differentiation prevalidates every selected save and consumes history only
after complete derivative construction. This is a known observable discrepancy
from native PyTorch 2.14.0, not a native argument restriction or a compatible
atomicity guarantee. With a newer good multiplication before an older branch
whose saved operand was mutated, native executes and consumes the good recipe
before the later saved-version error. Retrying or separately requesting the
good branch then fails with consumed history. That Tabgrad scalar/SIMD revision
instead reports saved-version failure again and can still return the separate
good gradient (`[10, 14]` in the pinned control).

The [native matrix](https://github.com/isaacperez/tabgrad/issues/167#issuecomment-5996427284)
and [production reproduction](https://github.com/isaacperez/tabgrad/issues/167#issuecomment-5996430687)
record environments, frozen sources and complete failure/retry observations.
The functional implementation now validates saved state at the executing node,
respects selected dependency readiness, prioritizes newer ready recipes and
consumes each successful recipe before continuing. The `gradientProgressCases`
matrix generated by `scripts/generate_tensor_oracle.py` freezes 13 native
PyTorch 2.14.0 cases: actual construction reversal, operand reversal, shared
ready nodes, repeated edges, payload-free history, all-save validation with a
pruned position, direct/view copy, and scalar, singleton, matrix and empty
shapes. Calls include the original failure, retry, separate good/bad branches
and a cutoff. Scalar/SIMD Node, real Pyodide, direct browser and managed Python
browser consumers compare values, shapes, tracking and error categories with
these fixtures. Existing successful gradient fixtures remain unchanged.

This evidence corrects the historical discrepancy for those supported
functional cases; it does not establish universal scheduling or floating-point
equivalence across arbitrary graphs. The
[per-node design](architecture/cpu-gradient-state.md#progress-and-failure-belong-to-executing-nodes)
also governs accumulating differentiation, but this evidence qualifies no
`backward`, `.grad` or training support. Cleanup-fault and fixed-owner cycle
tests separately establish Tabgrad's logical owner retirement and mandatory
copy failure contracts; they are not native backend fault evidence.

### Contents of a release record

Each public operation or coherent API group in a release must record:

- its public Python and JavaScript names and supported signatures;
- the reference PyTorch version, documentation, and observed oracle behavior;
- the overall status and exact supported subset;
- supported CPU and WebGPU behavior, including any explicit backend limits;
- supported data types, shapes, layouts, devices, and view or aliasing rules;
- autograd support, differentiability limits, and higher-order behavior;
- errors and unsupported inputs;
- intentional differences and the reason they exist;
- tests and environments that establish the claim; and
- the release in which the support became public or changed.

Use separate rows when overloads or backends have meaningfully different
support. A generated matrix may replace hand-maintained rows only after its
source and generation procedure are registered in
[`generated-files.md`](generated-files.md).

## Establish a compatibility claim

Use official PyTorch documentation and reproducible behavior from a named
official PyTorch release. Documentation establishes the public contract;
oracle tests help clarify behavior that the documentation leaves incomplete.
Do not copy PyTorch source code into Tabgrad merely because it was inspected.

Define representative valid inputs, boundaries, invalid inputs, data types,
devices, gradients, and tolerances before interpreting results. Run the
Tabgrad and PyTorch sides in controlled environments and preserve versions,
commands, inputs, and raw differences. Explain every exclusion.

The CPU backend may serve as Tabgrad's reference for WebGPU after CPU behavior
has independent compatibility evidence. Agreement between two Tabgrad
backends is not by itself evidence of agreement with PyTorch.

## Change or remove supported behavior

A change to a supported public signature, result, error, data type, gradient,
device, serialization form, or backend guarantee is a compatibility change.
Classify whether it corrects an erroneous claim, adds compatible behavior, or
breaks supported user code.

Breaking changes require `concern: breaking-change`, an explicit decision,
migration guidance, release notes, and the version change defined in
[`releases.md`](releases.md). Deprecation must state the replacement, first
deprecated release, planned removal boundary, warning behavior, and migration
path. Do not silently remove a compatibility claim by deleting its row.

A correction that brings Tabgrad into agreement with the already documented
reference can still affect users who relied on the defect. Record that effect
and provide migration guidance when it is material.

Update implementation, tests, API documentation, examples, the applicable
release record, and release information together. Use the narrowest status
supported by the recorded evidence.

### CPU backward evidence

The `backwardCases` field in the registered tensor oracle freezes native
PyTorch 2.14.0 wheel revision `08187d9e0fba026dc8217405802ab5381dc88d90`
with both thread pools fixed to one. Its maintained sources are
`scripts/backward_oracle.py`; prior fixture fields remain unchanged. The corpus
covers Python defaults, positional/keyword/container/error forms, assignment,
leaf accumulation/reset, nonleaf replacement, retained functional reception,
selected recipe failure, partial commits/retries, retained entry rebase, shapes,
tracked seeds and conditional incoming acquisition across shared/repeated/view
and sum paths. Special no-grad views distinguish advertised tracking from a
true accumulator. Setup controls distinguish global seed/root rejection from
incremental input retention before a later malformed target.

Direct scalar/SIMD and browser consumers explicitly select semantically
applicable rows; Python-only normalization rows run through real Pyodide and
managed browser Python. Consumers compare public values, shape, tracking,
identity observations and error classes. Internal version controls are
separate from the public API: native leaf clone acquisition starts at version one,
view-derived shared acquisition and retained nonleaf cloning at zero, and later leaf accumulation increments
the existing gradient's shared counter. Native explanatory tagged sources have
a different revision from the actual wheel and do not prove identical source.
The [backward reference](reference/backward-gradients.md) defines support and
explicit exclusions; the functional API keeps its narrower seed/input modes.

Separate Tabgrad lifetime and controlled-fault tests exercise strong leaf
endpoints, weak retained hooks, canonical wrappers, rooted/unreachable cycles,
fixed live owning occurrences, cleared/replaced/dropped gradient effects,
terminal write failure, independent cleanup errors and accepted read pins.
These establish runtime ownership and error obligations, not native backend
fault correspondence. Logical counters, pooled/reserved storage, Wasm memory
and process RSS are different measurements. Passing numerical and lifecycle
checks establish neither a speed comparison nor bounded total process memory.
Exact distribution identities, browser versions, command outcomes and material
cost measurements belong to the change's verification evidence.

### CPU SGD evidence

The `sgdCases` field in the registered tensor oracle comes from
`scripts/sgd_oracle.py`, executed by the pinned PyTorch 2.14.0 build
`08187d9e0fba026dc8217405802ab5381dc88d90` with one thread in each pool.
It covers repeated scalar/singleton/matrix/empty training, groups and repeats,
crossed aliases, absent/present/empty gradients, zero/nonfinite/group-negative
rates, integer midpoint neighbors, binding/validation phases, native false
forms, closure identity/errors and reset/detachment/view/history interactions.
The dictionary-reentry trace compares 22 selected cases with the same native
sources: occurrence-interleaved selection, changed/cleared current and later
associations, repeated parameters, numerical aliases, recursive calls,
params/closure ordering, single rate access, post-update errors and earlier-group
progress. It compares the native access trace together with values, associations,
versions, original exception identity and recording restoration.
Saved detachment after numeric reset is checked through both `backward()` and
`torch.autograd.grad`, including the preserved gradient association and alias.
Float32 bits, shape, tracking, mutation counters and Python exception classes
compare exactly; NaN payloads remain excluded. Internal version inspection is
test instrumentation, not a new public tensor property.

The [SGD reference](reference/sgd.md) states the included domain and exclusions.
Direct scalar/SIMD consumers select applicable numerical/state rows; the real
Python presentation executes all sources. Production Chrome/Firefox profiles
exercise direct auto/scalar/SIMD and managed Python lifecycle/worker entry,
native/disabled JSPI and explicit scalar/SIMD worker selection. These tests
qualify CPU behavior, not momentum, GPU SGD, general modules or compiled training.

Separate host tests cover close priority, original closure throws, accepted
captures, dropped mandatory writes, terminal barriers, independent release
errors and Python finalization. Fixed-owner windows retain aliases and old
saves while checking actual drain and retirement. Logical counts, Wasm
allocated/reserved capacity and host heap/RSS remain separate measurements;
they establish no universal speed or total-process-memory bound. Exact source,
browser versions and raw cost observations belong to verification evidence.

#### Group-dictionary capture evidence

Dictionary subclasses returning built-in basic options are covered. Clearing
the association during momentum access after capture still updates a parameter
at 2 with captured gradient 3 and rate 0.5 to 0.5, leaving the association absent.
Identity capture follows native occurrence phases; numerical values remain
sequential. The maintained corpus covers this class rather than freezing only
one numerical reproduction. The [research and native observations](https://github.com/isaacperez/tabgrad/issues/202)
record the bounded source/build evidence; tests qualify the implemented owner
and actual Python/browser consumers separately. These selected observations do
not cover custom scalars, broader modes or arbitrary structural tampering.

The reset corpus independently observes each group's `params` getter directly
before that group's reset. It covers clearing, replacing and installing a
gradient, original exception identity and earlier-group progress for numeric
and truthy resets. Association identity, float32 bits, tracked metadata, aliases,
versions, scalar/empty shapes and absent/present-zero controls come from the
pinned native build. The same Python sources execute in Node Pyodide and the
managed Chrome/Firefox profiles; host close checks qualify Tabgrad admission
separately. This preserves the existing dictionary-subclass domain and does
not qualify structural tampering or custom reset values.
