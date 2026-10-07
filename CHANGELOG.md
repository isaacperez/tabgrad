# Changelog

All notable user-visible changes to Tabgrad will be documented in this file.
The format follows the categories described in
[`docs/releases.md`](docs/releases.md), and versions follow Semantic
Versioning.

## Unreleased

### Added

- Basic CPU `torch.optim.SGD` and direct `session.sgd`, including ordered groups,
  closures, gradient reset and shared runtime ownership. See the
  [SGD reference](docs/reference/sgd.md) for numerical guarantees and exclusions.

- A direct JavaScript runtime path for lazy, out-of-place addition of
  one-dimensional contiguous CPU `float32` tensors, backed by prebuilt scalar
  and WebAssembly SIMD Rust kernels.
