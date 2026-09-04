# Dependencies and third-party code

This document defines how Tabgrad selects, records, updates, and removes
dependencies and reused code. A dependency includes runtime packages,
development tools, browser assets, Python packages, WebAssembly modules,
GitHub Actions, vendored code, generated code derived from another project,
and external services required by the build or release process.

## Add a dependency only for a demonstrated need

Describe the capability the project needs and inspect whether existing code,
platform APIs, or a smaller maintained component already provides it. Compare
realistic alternatives when the choice materially affects runtime behavior,
bundle size, portability, security, licensing, maintenance, or architecture.

A material dependency change requires an issue with `concern: dependencies`.
An architectural dependency also follows the architectural decision process.
Do not add a package merely to avoid writing a small, clear, project-specific
function, and do not reject a well-maintained dependency merely to claim that
all code is local.

## Record the decision and origin

For every direct dependency, record in the pull request or dependency manifest
review:

- its purpose and why existing facilities are insufficient;
- whether it is required at runtime, build time, test time, or release time;
- the authoritative source, package registry, maintainer, and selected version;
- the license and any notice, attribution, source-offer, or redistribution
  obligation;
- relevant browser, Pyodide, WebGPU, operating-system, and toolchain effects;
- security history and the maintenance signals inspected;
- effect on installed size, downloaded size, startup, and build time when
  material; and
- the owner and condition for updating or removing it.

Use the package manifest as the source of accepted direct dependencies and the
lockfile as the source of the exact development and release resolution. Commit
the lockfile used to reproduce checks and releases. Update manifests and
lockfiles with the package manager rather than editing resolved dependency
data by hand.

Do not depend on an unpinned branch, mutable download, or unauthenticated
artifact. Verify integrity using the package manager's lockfile and checksums.
Pin GitHub Actions to a full commit and retain a comment identifying the
human-readable release. Review an action as executable third-party code.

## Check licenses and attribution

The dependency's license must permit Tabgrad to use and distribute it under
the project's Apache-2.0 license and intended delivery model. Preserve every
required copyright notice and attribution. Record uncertainty and resolve it
before distribution; a package being publicly downloadable does not grant
permission to copy or redistribute it.

Studying another implementation does not authorize copying its code. When code,
algorithms expressed as code, tests, shaders, generated tables, or substantial
documentation are reused, record the exact source revision, files, license,
changes, and required notices. Prefer an ordinary package dependency over
vendoring when it gives equivalent control and auditability.

Vendored code must live in a clearly identified location with its upstream
source, revision, license, local changes, update procedure, and integrity
information. Do not modify vendored code without preserving a reviewable
difference from upstream.

## Update dependencies deliberately

Review release notes, changed transitive dependencies, licenses, advisories,
supported environments, deprecations, and artifact-size effects. Run the full
set of checks affected by the dependency rather than only confirming that
installation succeeds.

Automated update proposals remain proposals. They must pass the same review,
verification, compatibility, and release requirements as human changes. Do
not enable an update bot until the actual package managers, manifests,
lockfiles, grouping policy, and review ownership exist.

A security update may receive urgent priority, but urgency does not justify
hiding failed tests or silently changing public behavior. Follow
[`SECURITY.md`](../SECURITY.md) when disclosure is sensitive.

## Remove unused dependencies

Remove a dependency when its capability is no longer needed or when the
project can replace it without disproportionate cost. Remove its manifest and
lockfile entries, configuration, imports, vendored files, notices that no
longer apply, caches, and documentation together. Verify clean installation,
build, tests, and distributed artifacts after removal.

The dependency record must always describe the repository that exists. Do not
keep a planned dependency in a manifest, and do not omit a tool that is needed
to reproduce a required check or release.

## Direct third-party tools

| Dependency | Purpose and environment | Selected version | Source and license |
| --- | --- | --- | --- |
| `actions/checkout` | Read-only repository checkout in GitHub Actions | Commit `3d3c42e5aac5ba805825da76410c181273ba90b1`, release `v7.0.1` | Official `actions/checkout` repository, MIT License |
| `actions/setup-python` | Provide the exact Python interpreter used by repository checks | Commit `5fda3b95a4ea91299a34e894583c3862153e4b97`, release `v7.0.0` | Official `actions/setup-python` repository, MIT License |
| `PyYAML` | Parse repository YAML during local and continuous-integration checks; development only | `6.0.3`, with accepted artifact hashes in `requirements-dev.lock` | Python Package Index and `yaml/pyyaml`, MIT License |
| `Ruff` | Format and lint maintained Python repository tooling and tests; development only | `0.16.5`, with accepted artifact hashes in `requirements-dev.lock` | Python Package Index and `astral-sh/ruff`, MIT License |

`requirements-dev.lock` is the authoritative direct development dependency
manifest and integrity record. It accepts every CPython 3.11 wheel published
for PyYAML 6.0.3 and every binary wheel published for Ruff 0.16.5. It does not
permit a source build. This keeps each installed artifact covered by a
recorded hash and avoids unpinned isolated build dependencies. Repository
tooling supports platforms for which the lock contains accepted binary
artifacts.

The repository validator compares the lockfile's direct package names and
versions with the visible rows in this table. It rejects unsupported lockfile
options, malformed or unfinished physical continuations, missing artifact
hashes, duplicate entries, and undocumented direct packages. Comments do not
satisfy the visible dependency record.

Ruff replaces the need for separate Python formatter, import sorter, and
linter dependencies. Its configuration is `ruff.toml`, and its commands are
registered in [`development.md`](development.md). It is not included in a
Tabgrad runtime or browser artifact. Remove it when the repository no longer
maintains Python code or when an accepted replacement provides the same
formatting and lint evidence with lower overall maintenance cost.
