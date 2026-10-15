# Qualifying a retained browser package

This contributor command checks one supplied Tabgrad archive in a disposable
application outside the checkout. It checks the bytes installed by npm and
the relocated static files, then runs the public entry, type, asset and
application profiles. It does not rebuild or repack the supplied archive.

Use the [installation reference](browser-package.md) to integrate a package.
Use the [release policy](../releases.md) to admit its producer, expected evidence
and execution authority. This verifier consumes those admitted expectations;
a matching sidecar, checksum or source label does not authenticate a producer
or authorize running its code. This is not a sandbox for untrusted packages.

## Inputs and prepared environment

Prepare the pinned Node/npm, TypeScript and Pyodide dependencies and installed
browsers under [development setup](../development.md). The retained-input route
needs the verifier's tooling and application fixtures, but no checkout `dist/`,
Rust toolchain or source build. Package identity comes from the admitted input,
not the verifier checkout's `package.json`.

Supply both paths, quoted if they contain spaces:

```console
npm run test:package:browser -- --tarball path/to/approved-package.tgz --expected path/to/candidate.json
```

This selects Chrome and Firefox unless `TABGRAD_BROWSER` selects one. It runs
the installed README's JavaScript example, application-owned Python in a worker
without JSPI, and explicit rejection when GPU hosting prerequisites are absent.
For managed physical GPU qualification:

```console
npm run test:package:webgpu -- --tarball path/to/approved-package.tgz --expected path/to/candidate.json
```

That route selects Chrome by default and requires a real nonfallback adapter,
effective secure isolation and the prepared browser. Its profiles check the
managed Python/physical-worker result, gradients, shared identity and joined
normal drain, plus rejection of a worker from another origin. It does not
establish timing, memory growth or broader hardware support.

Omit both input options to retain source-candidate qualification. That route
requires clean, identified source and the full prepared build environment;
it builds a disposable candidate before using the same verifier. Supplying
only one option, repeating an option or using an unknown option fails.

## Admitted evidence and archive format

The expected JSON uses the producer's `candidate.json` schema version 1:

| Field | Meaning checked |
| --- | --- |
| `schemaVersion` | Exactly `1` |
| `name`, `version`, optional `private` | Exact agreement with archived module-package metadata; an omitted private flag remains distinct from `false` |
| `sourceRevision` | Forty lowercase hexadecimal characters, also present in the archived README source header; this is a label consistency check |
| `staticDirectory` | Exactly `package/dist` |
| `tarball.byteLength`, `tarball.sha256`, `tarball.integrity` | Size, SHA-256 and SHA-512 integrity of the exact compressed archive consumed |
| `files` | Complete unique inventory of paths, byte lengths and SHA-256 digests; includes `package.json`, `README.md`, `LICENSE` and selected `dist/` content |

The sidecar's tarball filename is descriptive: `--tarball` chooses the input.
Every admitted file must match, and missing or unlisted installed/static files
fail. The archive must contain only portable ustar regular files rooted at
`package/`, using canonical ASCII paths within that inventory. Links, special
files, directory entries, extension records, duplicate paths, traversal,
ambiguous headers, invalid gzip and truncated framing reject before npm sees
the archive. This is the producer's bounded format, not a general tar reader.
Nonempty installed-dependency declarations reject in this offline profile.
The archive is read and decompressed in memory; there is no hostile-input
resource bound or quantitative memory claim.

The verifier snapshots the expected data, reads the archive once, checks its
identity and content, and places a verified exact copy in owned storage. npm
receives that copy, with lifecycle scripts and binary links disabled, offline
resolution, empty owned npm configuration files and an isolated cache. The
installed complete tree is checked again, followed by the relocated `dist/`
tree. The original archive and sidecar are never verifier cleanup targets.

## Read the report

The underlying Node driver emits one JSON report on stdout and returns a
nonzero status on failure. npm itself prints its usual command banner when
using `npm run`; consumers needing a JSON-only stream can invoke the same
driver directly:

```console
node scripts/run-package-browser-tests.mjs --tarball path/to/approved-package.tgz --expected path/to/candidate.json
```

Use `--gpu` with that driver for the GPU route. The report has `schemaVersion: 1`:

- `input` distinguishes a supplied archive from source preparation; `candidate`
  records admitted and observed identity after successful installation.
  `archive` retains actual compressed identity when admission or install fails
  after the archive was read. Unread or malformed evidence cannot establish it.
- `expectedEvidenceSha256` identifies the exact expected JSON bytes read.
  It is not a producer signature or approval.
- `environment` records Node, OS/kernel, architecture and observed npm and
  TypeScript versions. Successful profiles record browser/version and Python
  environment; GPU profiles add actual adapter/features/limits.
- `requested` states selected browsers and profiles. `checks` and `profiles`
  contain only completed validated observations; requested coverage is not a
  pass. Earlier successes remain visible after a later failure.
- Profile `notes` preserve harness diagnostics such as stderr capture ending
  without EOF. That note does not prove termination of browser descendants.
- `failure` records the failed phase, a bounded diagnostic code/message and an
  available child exit code. Raw process errors, stacks and input paths are
  excluded. Browser failures retain the harness failure kind, exit/signal,
  stderr-cutoff and cleanup/termination flags. Separately reported cleanup
  failures prevent a passed result.

Success is reported only after owned application/candidate state is removed.
The existing browser harness owns its process, profile and loopback-server
cleanup; its [diagnostic limits](browser-diagnostics.md) still apply. Inputs
and completed observations remain distinct from that cleanup. This command
does not resolve a registry version, authenticate signatures, create release
control records, sign, publish, deploy or change account settings.
