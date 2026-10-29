# Changelog

All notable user-visible changes to Tabgrad are documented here. Versions follow
Semantic Versioning under [`docs/releases.md`](docs/releases.md). A source entry
identifies its changes; public artifact availability and qualification are
established by the corresponding verified release record.

## Unreleased

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

The [0.1.0 source and support record](docs/reference/release-0.1.0.md) defines
signatures, supported domains, intentional differences, environment evidence
and exclusions. This is an independent subset implementation, not the official
PyTorch runtime or a general PyTorch compatibility claim.
