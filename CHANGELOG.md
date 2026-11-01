# Changelog

All notable user-visible changes to Tabgrad are documented here. Versions follow
Semantic Versioning under [`docs/releases.md`](docs/releases.md). A source entry
identifies its changes; public artifact availability and qualification are
established by the corresponding verified release record.

## Unreleased

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
