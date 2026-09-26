# Generated files

This document records every generated file that Tabgrad stores in version
control and the source from which it must be reproduced. Generated output must
never become an unexplained second source of truth.

## Registration requirement

Before committing generated output, add an entry containing:

- the generated path or path pattern;
- the authoritative source files;
- the generator and its pinned version;
- the exact generation command from the repository root;
- relevant deterministic inputs and environment requirements;
- whether the output is committed and why;
- the check that detects stale or irreproducible output;
- any license, attribution, binary-review, or release requirement; and
- the safe cleanup procedure for disposable output.

Do not edit a generated file by hand. Change its source and run the registered
generator. Review both the source change and generated difference. A generator
must produce the same bytes from the same committed inputs, or document and
control every expected source of variation.

Commit generated output only when consumers cannot reasonably generate it,
when it is a distributed artifact whose source must remain reviewable, or when
including it materially improves supported use without creating unacceptable
drift. Caches, local build output, coverage data, logs, downloaded dependencies,
and editor files are not committed generated output.

## Generated-file register

Register every committed generated path in this section using the fields above.
An absent entry provides no authority to commit generated output. Reports,
caches, and other local outputs produced by checks are disposable and must not
be committed. Maintained checker or generator source is not generated output.

Update `.gitignore`, distribution manifests, dependency records, and release
checks in the same change as a registered generated path.

### JavaScript dependency lock

- **Path:** `package-lock.json`.
- **Sources:** `package.json` and the npm registry metadata selected from it.
- **Generator:** npm 11.1.0, selected by `packageManager` in `package.json`.
- **Command:** `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` when an authorized dependency change requires a new resolution.
- **Inputs:** Node.js 22.12.0, npm 11.1.0, the direct version constraints, and registry metadata.
- **Commit policy:** committed because development and release builds must resolve the same compiler artifact and integrity digest.
- **Verification:** `npm ci --ignore-scripts --no-audit --no-fund` accepts the lock without rewriting it; dependency review checks the resulting package tree and license.
- **License and review:** each direct and transitive package remains governed by [Dependencies and third-party code](dependencies.md).
- **Cleanup:** remove only the ignored `node_modules/` installation when a clean install is needed; do not delete the lockfile as cleanup.

### Python compatibility-oracle lock

- **Path:** `requirements-oracle.lock`.
- **Sources:** `requirements-oracle.in` and the reviewed PyPI wheel resolution reported by pip.
- **Generators:** pip 23.2.1 for resolution and `scripts/write-oracle-lock.mjs` under Node.js 22.12.0 for the deterministic requirements format.
- **Commands:** the oracle resolution and lock-generation commands registered in [Development environment and commands](development.md#prepare-python-integration-and-its-compatibility-oracle).
- **Inputs:** the direct requirements, CPython 3.11 on macOS 14+ arm64, exact wheel URLs and SHA-256 hashes in the pip report. Resolving again against a changed registry can select different transitive versions; that is an update to review, not a deterministic replay.
- **Commit policy:** committed so reference generation installs the same native oracle and transitive wheels. The disposable pip report and installed packages are not committed.
- **Verification:** install with `--only-binary=:all: --require-hashes`; translating the same reviewed report must reproduce the same lock bytes. Compatibility evidence identifies the actual installed build revision.
- **License and review:** inspect both direct and transitive wheel notices under [Dependencies and third-party code](dependencies.md); the native packages are not browser artifacts.
- **Cleanup:** remove only the disposable report when no longer needed. Installed oracle packages share `.venv` with repository tooling; do not remove that environment or shared pip caches as an automatic cleanup action.

### Python tensor oracle fixtures

- **Path:** `js-tests/fixtures/python-tensor-oracle.json`.
- **Source/generator:** `scripts/generate_tensor_oracle.py`, with its maintained cases and comparison policy; not Tabgrad's implementation.
- **Command:** `.venv/bin/python scripts/generate_tensor_oracle.py` from the repository root.
- **Inputs:** the prepared native environment and hashed oracle lock in [Development](development.md#prepare-python-integration-and-its-compatibility-oracle); PyTorch 2.14.0 build revision `08187d9e0fba026dc8217405802ab5381dc88d90`. The generator rejects another version/revision and bounds both thread pools to one. No NumPy is needed; its known initialization warning is retained.
- **Commit policy:** committed so CI and browser contributors can consume native expectations without installing the platform-specific development oracle. No native package is distributed.
- **Verification:** `.venv/bin/python scripts/generate_tensor_oracle.py --check` regenerates and compares exact bytes when the oracle is prepared; normal Node tests consume the fixture independently. Changes to cases or pins require regenerating and reviewing the fixture.
- **Comparison:** exact float32 bits except NaN payloads for exact arithmetic cases; total reduction uses the finite-error and explicit overflow-classification policy in [Total tensor sum](reference/tensor-sum.md#compatibility-evidence-and-comparison-method). Recorded metadata and Python exception classes compare exactly. Tests consume values through runtime handles and ordinary Python `tolist()`. The latter also checks list ownership and Python float presentation; neither route extends the fixture's bounded operation coverage.
- **License/review:** behavior observations only, no upstream source copied. Native oracle attribution remains in [Dependencies](dependencies.md).
- **Cleanup:** generated fixture is intentionally committed; do not delete it as build cleanup. No intermediate output is created.

### Rust dependency lock

- **Path:** `Cargo.lock`.
- **Sources:** the workspace and crate `Cargo.toml` manifests.
- **Generator:** Cargo 1.98.1 from the toolchain selected by `rust-toolchain.toml`.
- **Command:** `cargo generate-lockfile` after an authorized manifest change.
- **Inputs:** the committed Cargo manifests and the selected Rust toolchain.
- **Commit policy:** committed so kernel builds and checks use an explicit package resolution even when the workspace has no external crates.
- **Verification:** every Cargo build and Clippy command uses `--locked`.
- **License and review:** additions to the lock require the source, license, integrity, and distribution review in [Dependencies and third-party code](dependencies.md).
- **Cleanup:** Cargo's ignored `target/` directory may be removed independently; do not delete the lockfile as cleanup.

### Browser distribution

- **Paths:** `dist/index.js`, `dist/index.d.ts`, `dist/python.js`, `dist/python.d.ts`, their emitted internal JavaScript and declaration modules, `dist/manifest.json`, `dist/wasm/kernels-{scalar,simd128}.wasm`, and the static source and manifest under `dist/python/`.
- **Sources:** `src/**/*.ts`, `python/bootstrap.py`, `python/torch/__init__.py`, `crates/tabgrad-wasm-kernels/src/lib.rs`, the Cargo manifests and lock, `tsconfig.json`, `rust-toolchain.toml`, and the build scripts under `scripts/`.
- **Generators:** TypeScript 6.0.3, Rust and Cargo 1.98.1, and the maintained Node.js build scripts.
- **Command:** `npm run build` from the repository root.
- **Inputs:** the prepared environment in [Development environment and commands](development.md). The Rust build fixes release optimization, imported-memory bounds, and scalar or `simd128` target features. The manifest generator hashes the exact emitted module bytes with SHA-256.
- **Commit policy:** not committed. It is ignored because a repository checkout contains the authoritative source and consumers receive distribution artifacts from a controlled release build.
- **Verification:** `npm test` rebuilds the distribution, checks its manifest and raw ABI through Node.js, and loads the same files in Chrome and Firefox. A release additionally records and inspects artifact checksums under [Versions, releases, and migrations](releases.md).
- **License and review:** generated JavaScript and WebAssembly remain Tabgrad output under Apache-2.0; no third-party runtime code is linked into the kernel crate.
- **Cleanup:** `npm run clean` deletes only `dist/`.

`scripts/build-python.mjs` copies maintained Python source byte for byte into
`dist/python/` and writes its separate `manifest.json`. That manifest records
the source paths, byte lengths, SHA-256 hashes, bootstrap/bridge protocol version
and selected Pyodide version. It does not describe numerical kernels. Serving
the distribution must preserve these relative paths, or the host must supply
the Python manifest's location explicitly. The
[installation component](components/python-package-installation.md) explains
how source validation and interpreter mutation remain separate.

### Local Pyodide type sources

`scripts/prepare_pyodide_types.py`, called by `npm run check:python`, copies
the upstream `pyodide/` and `_pyodide/` modules from the installed
`node_modules/pyodide/python_stdlib.zip` into
`node_modules/pyodide/python-types/`. This is ignored, development-only output,
not maintained or distributed Tabgrad source. The npm lock selects the archive;
the extraction preserves its bytes and rejects paths escaping the named roots.
The upstream licensing and notices remain those of the installed Pyodide
distribution. No separate downloaded typing package or generated stub is used.

The [development command](development.md#configured-commands) regenerates these
files before checking; `npm ci` clears the dependency installation when a
package update changes the archive. Do not edit these copies to suppress a
diagnostic. A missing or invalid archive fails before the checker runs.

### Disposable runtime reports

`npm run measure` writes bounded raw observations under
`test-results/performance.json`. The report includes its environment and exact
revision but is not committed; the applicable issue or pull request preserves
the reviewed evidence and conclusion. The whole `test-results/` directory is
ignored and may be removed without affecting source. Browser profiles are
created in the operating system's temporary directory and removed by the
runner even after a failed case.

`npm run measure:python` writes timestamped
`test-results/python-performance-*.json` files. They preserve partial attempts,
source and distribution identities, ordinary comparisons and separately marked
diagnostic profiles. The maintained
[command reference](reference/python-boundary-measurements.md) defines their
metrics and limits. These local reports are not distributed or committed;
inspect them for privacy before publishing any evidence derived from them.

## Verify generated output

Run the registered generator in a controlled environment and compare the
complete result with the committed output. An unexpected diff fails the check.
Do not make CI regenerate and silently accept the changed result.

When generated output is binary, preserve a reproducible checksum and a way to
inspect its meaningful source-level content. Treat generation tools and
downloaded inputs as dependencies under [`dependencies.md`](dependencies.md).
