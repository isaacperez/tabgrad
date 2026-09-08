# Changelog

All notable user-visible changes to Tabgrad will be documented in this file.
The format follows the categories described in
[`docs/releases.md`](docs/releases.md), and versions follow Semantic
Versioning.

## Unreleased

### Added

- A direct JavaScript runtime path for lazy, out-of-place addition of
  one-dimensional contiguous CPU `float32` tensors, backed by prebuilt scalar
  and WebAssembly SIMD Rust kernels.
