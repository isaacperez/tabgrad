# Changelog

All notable user-visible changes to Tabgrad are documented here. Versions follow
Semantic Versioning under [`docs/releases.md`](docs/releases.md). A source entry
identifies its changes; public artifact availability and qualification are
established by the corresponding verified release record.

## Unreleased

## 0.7.0 - 2026-11-28

### Added

- Create, view and read bool tensors on CPU and WebGPU. Compare float32
  tensors with broadcasting to produce a bool mask. Use that mask in
  `where` to select values from two float32 tensors with support for
  first-order branch gradients
  ([#528](https://github.com/isaacperez/tabgrad/issues/528),
  [#529](https://github.com/isaacperez/tabgrad/issues/529)).
- Create and read exact int32 and int64 tensors. `argmax` returns int64
  indices for float32, int32 and int64 sources. Both CPU and WebGPU preserve
  the first winning position, including ties
  ([#531](https://github.com/isaacperez/tabgrad/issues/531)).
- Select slices with int32 or int64 indices using `index_select` in Python
  and `indexSelect` in JavaScript. Results retain their dtype and the order
  of indices, including repeats. This forward operation validates index
  values when an observation or effect requires the result
  ([#532](https://github.com/isaacperez/tabgrad/issues/532)).

### Changed

- The versioned compatibility table shows the new input and result types,
  backend coverage and gradient limits for each operation.

The [0.7.0 source and support record](docs/reference/release-0.7.0.md) explains
the new operations and their limits. Replace the package, workers, WebAssembly
and Python assets together when upgrading.

## 0.6.0 - 2026-11-27

### Added

- Sum a whole float16 tensor on CPU or GPU in JavaScript and Python. Both
  backends round the exact total once to a float16 scalar
  ([#510](https://github.com/isaacperez/tabgrad/issues/510)).
- Multiply two float16 matrices on CPU or GPU in JavaScript and Python,
  with ordered float32 accumulation and compact float16 operands and results
  ([#511](https://github.com/isaacperez/tabgrad/issues/511)).
- Use bfloat16 tensors on CPU and GPU in JavaScript and Python. Forward
  operations include views, broadcast add and multiply, exact total sum and
  2D matrix multiplication. Values use two logical bytes and matrix products
  round the multiply and add separately in float32
  ([#512](https://github.com/isaacperez/tabgrad/issues/512)).

### Changed

- Browse PyTorch compatibility by module and operation, with dtype filters
  and CPU and GPU support for the selected documentation version
  ([#514](https://github.com/isaacperez/tabgrad/issues/514)).

## 0.5.0 - 2026-11-18

### Added

- Create compact float16 tensors, reshape their full storage without copying,
  and add or multiply them with broadcasting on CPU or GPU, in JavaScript and
  Python. Each value uses two logical storage bytes; observations return
  ordinary numbers. Float16 training, mutation, reductions, matrix products
  and mixed-type promotion are not included
  ([#471](https://github.com/isaacperez/tabgrad/issues/471)).
- Configure CPU linear-memory capacity independently of update reservations.
  Sessions still default to 64 MiB and initially allocate 2 MiB; applications
  can explicitly request up to 256 MiB of CPU linear memory. This does not
  bound total RAM or guarantee that an arbitrary graph fits
  ([#464](https://github.com/isaacperez/tabgrad/issues/464)).
- Use GPU tensors beyond a single dispatch row when storage and operation
  limits allow it. Checked multidimensional dispatch covers the existing
  operation families without requesting larger device limits or changing
  their numerical contracts
  ([#465](https://github.com/isaacperez/tabgrad/issues/465)).

### Fixed

- Internal CPU allocation validation rejects references owned by another
  context before reading or changing their state, even when generation numbers
  match ([#451](https://github.com/isaacperez/tabgrad/issues/451)).
- Release tooling selects retained history by creation time rather than
  assuming artifact IDs are chronological, and rejects ambiguous default
  selection ([#449](https://github.com/isaacperez/tabgrad/issues/449)).
- Disposable Chrome checks exclude ordinary and built-in background extensions,
  keeping unrelated extension processes out of the controlled test environment
  without changing GPU selection or the sandbox
  ([#477](https://github.com/isaacperez/tabgrad/issues/477)).

The [0.5.0 source and support record](docs/reference/release-0.5.0.md) describes
the float16 domain, capacity boundaries and memory costs. Existing supported
float32 calls retain their defaults and numerical contracts. Replace the entire
matched distribution, including workers and numerical assets. Source notes do
not establish package availability or qualification of a retained release archive.

## 0.4.0 - 2026-11-15

### Added

- Add and multiply tensors with broadcast-compatible shapes on CPU and GPU,
  from JavaScript or Python. Functional gradients and `backward()` reduce each
  contribution to its original input shape without expanding operand storage
  ([#430](https://github.com/isaacperez/tabgrad/issues/430)).
- Browse documentation by release, with version-aware navigation and search.
  Versions now presents each release's own notes, capabilities and limits;
  dated notes and matching documentation are required before release readiness
  ([#441](https://github.com/isaacperez/tabgrad/issues/441)).
- Maintainers can approve a candidate before its version tag and deliver it
  through npm, immutable GitHub completion and a matching website. Existing
  manual publication and site-only recovery remain available; service
  activation and qualification are separate
  ([#434](https://github.com/isaacperez/tabgrad/issues/434)).

- Publication plans can preserve an existing exact-source version tag without
  trying to create it again. Earlier plans retain their original effect
  identities and unresolved-call history
  ([#432](https://github.com/isaacperez/tabgrad/issues/432)).

### Fixed

- Automatic release environments recognize GitHub's native branch-policy rule
  while preserving main-only deployment and rejecting pending approval rules
  ([#447](https://github.com/isaacperez/tabgrad/issues/447)).
- Release consumers wait for an unavailable registry attestation within the
  existing metadata-readiness budget, while retaining strict proof association
  and never repeating publication
  ([#411](https://github.com/isaacperez/tabgrad/issues/411)).
- Isolated Chrome checks on macOS use a disposable mock keychain, avoiding a
  startup dependency on the real user keychain while retaining the isolated
  environment, temporary profile and GPU checks
  ([#409](https://github.com/isaacperez/tabgrad/issues/409)).

The [0.4.0 source and support record](docs/reference/release-0.4.0.md)
describes the new shape domain and existing float32, first-order and device
limits, including backend differences in grouped gradient reduction. Replace
the complete matched distribution; existing supported calls need no API
migration. Source notes do not establish registry availability or actual
retained-archive qualification.

## 0.3.0 - 2026-11-05

### Added

- Applications can read their local managed Python session through
  `binding.diagnostics()`, including CPU buffer peaks, Wasm capacity, kernels
  and transfers. Snapshots are detached and frozen; reading preserves the
  existing runtime collection/error behavior and adds no per-operation
  instrumentation or retained history
  ([#406](https://github.com/isaacperez/tabgrad/issues/406)).

The [0.3.0 source and support record](docs/reference/release-0.3.0.md) describes
the local/remote distinction, pre-close observations and unchanged tensor
support. Update the complete matched distribution; registry availability and
exact-byte qualification are verified separately from this source record.

## 0.2.0 - 2026-11-04

### Added

- Applications can read managed Python's GPU counters and adapter information
  through `controller.diagnostics()`, including while Python is busy. Returned
  snapshots are detached and frozen; reading adds no tensor demand, GPU work or
  retained history ([#402](https://github.com/isaacperez/tabgrad/issues/402)).

The [0.2.0 source and support record](docs/reference/release-0.2.0.md) describes
this additive host API and its observation limits. Existing tensor calls and
numerical support are preserved; replace the complete matched distribution
when updating. Registry availability and exact-byte qualification are verified
separately from this source record.

## 0.1.3 - 2026-11-01

### Fixed

- Generated release digests such as `plan_sha256` are written to the actual
  GitHub Actions output sink without being rejected as invalid names
  ([#398](https://github.com/isaacperez/tabgrad/issues/398)).
- Release verification bounds registry-propagation waiting and preserves safe
  consumer diagnostics; browser selection uses the qualifier's supported
  interface ([#382](https://github.com/isaacperez/tabgrad/pull/382),
  [#386](https://github.com/isaacperez/tabgrad/pull/386)).

### Changed

- Maintainers can prepare the exact release plan from reviewed version/source
  against stable enrolled trust, with protected approvals and separate physical
  archive/registry reports. Complete retained CI history can be reused directly
  ([#394](https://github.com/isaacperez/tabgrad/pull/394),
  [#395](https://github.com/isaacperez/tabgrad/pull/395),
  [#384](https://github.com/isaacperez/tabgrad/pull/384)).
- Contributor validation selects affected work for main pushes and reuses valid
  independent evidence through proportionate handoffs
  ([#388](https://github.com/isaacperez/tabgrad/pull/388),
  [#390](https://github.com/isaacperez/tabgrad/pull/390)).

The [0.1.3 source and support record](docs/reference/release-0.1.3.md) preserves
existing tensor behavior and support limits. Applications need no API migration;
source integration alone does not activate or qualify the new publication route.

## 0.1.2 - 2026-11-01

### Fixed

- Release consumer verification and GitHub completion remain eligible after an
  unused authentication branch is skipped, while requiring successful
  prerequisites and rejecting cancellation
  ([#376](https://github.com/isaacperez/tabgrad/pull/376)).

### Removed

- Retired the superseded native acquisition laboratory, its contributor
  commands, tests and reference contracts; application and release-tool
  reference navigation is separated by audience. The active hosted producer,
  proof verification and publication tooling are preserved
  ([#377](https://github.com/isaacperez/tabgrad/issues/377)).

The [0.1.2 source and support record](docs/reference/release-0.1.2.md) preserves
the existing tensor API and support limits. Applications need no API migration.

## 0.1.1 - 2026-11-01

### Fixed

- Browser builds use one explicit Cargo output directory, preventing an old
  Wasm module from being copied under the wrong variant when environment or
  Cargo configuration selects another directory ([#362](https://github.com/isaacperez/tabgrad/issues/362)).
- Release tooling preserves producer-proof association when Sigstore JSON
  contains empty defaults, and shows human authentication links within the
  admitted window ([#368](https://github.com/isaacperez/tabgrad/pull/368),
  [#364](https://github.com/isaacperez/tabgrad/pull/364)).
- Explicitly admitted release-history recovery preserves uncertain calls and
  original authority while allowing a different candidate to proceed
  ([#371](https://github.com/isaacperez/tabgrad/pull/371)).

The [0.1.1 source and support record](docs/reference/release-0.1.1.md) preserves
the existing API and numerical boundaries and explains the build correction,
maintenance and qualification. No new tensor functionality is added.

## 0.1.0 - 2026-10-29

### Added

- A browser-native float32 tensor runtime with direct JavaScript and optional,
  application-owned Python/Pyodide integration. CPU uses prebuilt scalar and
  WebAssembly SIMD kernels; WebGPU is selected explicitly without silent fallback.
- Contiguous tensor creation and whole-storage views, equal-shape addition and
  multiplication, total sum, two-dimensional matrix products and same-device
  persistent copy, with the documented numerical and aliasing boundaries.
- Functional first-order gradients, `backward()`/`.grad`, recording scopes and
  basic SGD on CPU and an enabled WebGPU device. Retained/higher-order gradients,
  momentum and broader optimizer options remain outside the supported subset.
- Matched JavaScript, Python, worker and static asset entries; retained archive
  and external application qualification; producer proof verification and
  controlled release tooling with explicit approvals and failure recovery.

### Fixed

- The root Python example now uses available operations and explicit float32;
  browser checks execute that exact snippet in the attached interpreter.
- Publication admission can corroborate an exact active role when GitHub reports
  its aggregate run as queued, and rechecks authority expiry after provider reads.

The [0.1.0 source and support record](docs/reference/release-0.1.0.md) defines
signatures, supported domains, intentional differences, environment evidence
and exclusions. This is an independent subset implementation, not the official
PyTorch runtime or a general PyTorch compatibility claim.
