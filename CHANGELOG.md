# Changelog

All notable user-visible changes to Tabgrad are documented here. Versions follow
Semantic Versioning under [`docs/releases.md`](docs/releases.md). A source entry
identifies its changes; public artifact availability and qualification are
established by the corresponding verified release record.

## Unreleased

### Fixed

- Isolated Chrome checks on macOS use a disposable mock keychain, avoiding a
  startup dependency on the real user keychain while retaining the isolated
  environment, temporary profile and GPU checks
  ([#409](https://github.com/isaacperez/tabgrad/issues/409)).

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
