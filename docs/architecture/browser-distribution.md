# Versioned browser distribution

**Decision:** accepted on 2026-10-14 under
[research issue #296](https://github.com/isaacperez/tabgrad/issues/296), with an
[explicit acceptance record](https://github.com/isaacperez/tabgrad/issues/296#issuecomment-6167192081).

This chapter explains the distribution design for contributors and application
integrators: why modules and assets belong to one matched set, and which
responsibilities remain with the application. It records an approved design;
published versions, installation paths and supported environments require the
artifact evidence defined by the [release policy](../releases.md).

Use the [JavaScript reference](../javascript-api.md) for tensor calls and the
[Python host reference](../reference/python-host.md) for interpreter attachment
and worker lifetimes. The
[generated-file register](../generated-files.md#browser-distribution)
identifies build inputs and outputs rather than publication destinations.

## A distribution contains cooperating files

A JavaScript module imports other modules and resolves a numerical manifest
relative to its URL. The manifest identifies compatible WebAssembly files and
their hashes. Python attachment separately validates source files before
installing them into a borrowed interpreter. Managed Python GPU execution also
needs a physical worker that progresses independently while Python waits.

Copying one JavaScript file therefore does not reproduce the integration. The
approved distribution keeps an unbundled ECMAScript module tree and matching
assets together. The npm package and directly served static payload use the
same generated runtime bytes. Applications may place that tree below their own
URL prefix while preserving its internal relationships.

| Distribution role | Static location or boundary |
| --- | --- |
| Direct JavaScript interface | Root `index.js` and its declaration/import dependencies |
| Optional Python integration | Root `python.js` and its declaration/import dependencies |
| Managed physical GPU worker | Root `webgpu-worker.js` and its import dependencies |
| CPU numerical assets | Root `manifest.json` and selected files under `wasm/` |
| Python installation assets | Source files and their manifest under `python/` |

Public package entries expose the direct interface, optional Python integration
and compatible worker resource. Resource aliases are bounded to the CPU
manifest/binaries and Python source/manifest subtrees, rather than a wildcard
over implementation modules. Exact package resolution is verified against the
released artifact; a static filename does not prove that the package exports it.

Public artifacts omit the standalone testing entry and retain the transitive
modules and declarations required by their public entries. Development build
output and selected release content have different responsibilities. This does
not require a text-based import scan to prune modules or make every emitted
private declaration a public API.

## Module identity belongs to the integration

The direct interface and Python frontend share runtime owners, including
registries associating tensor and session objects with their state. Cooperating
entries in one realm must resolve the same runtime module instances.
Byte-identical modules evaluated at different URLs can create different class
identities and registries; equal package versions alone do not make their
opaque objects interchangeable.

A realm is the execution environment of a page or worker. Separate workers
evaluate modules independently under their ownership contracts; the design
does not impose a process-wide singleton. Within a realm, a host or packager
preserves common imports instead of independently embedding another runtime
copy into each cooperating entry.

Private module paths are artifact dependencies, not supported application
interfaces. Export maps define a package interface; they do not prevent a
browser or absolute filesystem import from inspecting JavaScript source.
Restricting exports and omitting the testing entry are support/content
boundaries, not confidentiality or browser security mechanisms.

## The application owns hosting and Python

Plain-browser integrations serve the complete tree and use explicit module URLs
or an application import map. The application supplies the secure context,
resource types and CORS/CSP permissions required by the
[JavaScript delivery contract](../javascript-api.md#browser-delivery-requires-no-developer-toolchain).

Importing the direct interface does not load Python integration, interpreter
files or Python sources. Pyodide remains an optional application-owned
interpreter with the version admitted by the
[attachment contract](../reference/python-host.md#attach-in-the-interpreter-worker).
The application owns its interpreter worker, bootstrap and failure reporting.
Distribution does not create a second semantic engine or silently move an
existing interpreter.

The physical worker entry must have the caller document's origin, or use a
separately qualified same-origin wrapper. Permission to import cross-origin
modules does not remove the `Worker` constructor's origin requirement. Managed
Python GPU use also preserves the secure isolation and independent progress in
[Python observation](python-observation.md#hosting-requirements-are-part-of-the-decision).
CPU defaults, explicit device selection, no silent fallback and joined cleanup
retain their existing owners.

Relocation options have distinct scopes. A direct session's manifest option
locates CPU assets. Python attachment's manifest option locates Python sources;
it does not independently redirect its CPU manifest or runtime module graph.
The worker URL option selects a compatible packaged physical worker, not an
arbitrary protocol. Preserving the tree keeps these default relationships intact.

## One public version identifies the matched set

The distribution uses one public version under the
[SemVer and release rules](../releases.md#version-public-artifacts), distinct
from CPU module/ABI versions, the Python bridge protocol and the admitted
Pyodide version. These identifiers answer different questions and need not
advance together.

The controlled release identifies their pairing and exact artifact bytes.
Integrators update or restore the complete matched set instead of combining
entries, manifests and resources from different releases. Runtime hashes and
compatibility guards validate the properties they cover; they are not
signatures or universal detection of mixed releases. Two releases can share a
private protocol version without being a supported mixed distribution.

Package-facing documentation describes the actual artifact with links that do
not depend on checkout-only files. Installation verification starts from the
candidate or published artifact under the release policy. Publication
destinations and operational configuration are separate from this design.

## Alternatives and consequences

The unbundled tree preserves the established module, asset and ownership
relationships without a bundler dependency or new cross-package boundary. It
requires applications to serve multiple files and retain the matching tree.
Including optional Python files in a package is separate from downloading or
executing them during direct JavaScript use. Neither property establishes a
startup-time advantage.

Bundled public entries remain viable. Shared modules or chunks can retain
runtime identity; independently bundling each entry can duplicate its owners.
Such a distribution needs a qualified generator, asset/worker anchors and
installation paths. An application bundler may combine a direct entry with a
separately served optional tree; this deployment possibility is not evidence
for arbitrary bundlers or publisher-generated bundles.

Separately published optional packages also remain viable, but need a qualified
common-runtime interface. Python integration uses private runtime preparation
and connected-session helpers, so splitting packages changes more than file
placement. Asset defaults, version mapping and release ownership must remain
coherent.

The [reproducible investigation](https://github.com/isaacperez/tabgrad/issues/296#issuecomment-6166819821),
[conclusion and alternatives](https://github.com/isaacperez/tabgrad/issues/296#issuecomment-6166919078)
and [independent challenge](https://github.com/isaacperez/tabgrad/issues/296#issuecomment-6166918646)
support this bounded loading decision. They do not establish registry/CDN
transformation behavior, production-host deployment, automatic bundler
integration, request latency, universal browser/GPU support or model-scale
resource performance.

Reconsider the choice when a supported integration cannot preserve these
relationships, or adequate measurements identify a material cost that another
qualified layout can improve. Preserve runtime identity, asset admission,
optional loading and host ownership when comparing alternatives. A preference
for fewer files is not by itself such evidence.
