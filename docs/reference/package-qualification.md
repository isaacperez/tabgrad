# Qualifying a browser package

This contributor command checks a Tabgrad archive or an exact registry version in a disposable
application outside the checkout. It checks the bytes installed by npm and
the relocated static files, then runs the public entry, type, asset and
application profiles. It does not rebuild or repack a supplied or downloaded archive.

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

## Exact registry installation

Use this route only for an explicitly authorized anonymous read of the selected
registry and archive origins. It has no authentication option or publishing
identity. A local fixture is not evidence about a real registry, package owner,
TLS chain, trusted publisher or producer signature.

```console
npm run test:package:browser -- --registry-plan path/to/private-registry.json --expected path/to/candidate.json
```

Use the same options with `test:package:webgpu` for explicitly selected hardware.
`--registry-plan` excludes `--tarball` and requires `--expected`. It never invokes
the source builder. The private plan is schema version 1 with exactly these
fields; these are placeholders, not live destinations:

```json
{
  "schemaVersion": 1,
  "registry": "https://registry.example.invalid/",
  "allowedOrigins": ["https://registry.example.invalid", "https://archive.example.invalid"],
  "channel": "latest",
  "clientTimeoutMs": 120000,
  "maxClientOutputBytes": 1048576
}
```

The registry base ends with a slash. Origins identify complete scheme/host/port
combinations, without paths; aliases that normalize to the same origin cannot
be repeated. Endpoints exclude user information, query strings and fragments.
The metadata client uses its ordinary certificate verification; raw archive
requests explicitly use the prepared Node runtime's bundled certificate roots
and require certificate validation, without inherited proxy or CA configuration.
Only
`http://127.0.0.1` is accepted for disposable loopback fixtures; arbitrary HTTP
or a silent registry default is rejected. The selected channel must begin with
a lowercase letter and contain only lowercase letters, digits, dots, underscores
or hyphens. The candidate version must be an exact semantic version, including
an optional valid prerelease/build suffix, rather than a range or tag.

The timeout is a positive integer in milliseconds, at most `2147483647` (Node's
timer limit), per npm invocation. The positive integer output limit counts both
client output streams. The example bounds are operational choices, not measured
performance promises; choose and authorize bounds for the actual run. Exceeding
either bound fails and terminates the owned client. This is not a sandbox for
arbitrary executables, hostile-input resource bounds, or proof of termination
of unrelated descendants after an abrupt host/process failure.

The route creates a fresh application, cache, HOME and empty configuration. npm
receives an explicit environment without inherited npm/GitHub tokens, npm
configuration, Node injection, proxies or SSH identity. The prepared PATH is a
trusted tool input. The selected repository Node/npm versions are checked;
these verification tools are distinct from any separately qualified publishing
client. Installed dependencies, lifecycle scripts and binary links are excluded.
No interpreter or dependency is downloaded by the consumer profiles.

An owned proxy admits only configured origins. Plain HTTP accepts only GET
without authorization headers; HTTPS uses CONNECT tunnels to admitted origins,
with the actual sanitized npm client responsible for the encrypted requests and
certificate checks. The proxy cannot inspect encrypted paths, methods or headers
and does not isolate arbitrary programs or privileged host changes. Redirects
to another origin require that origin's explicit admission; any denied request
makes the qualification fail, even if npm later succeeds. The proxy and its
connections are closed with owned cleanup. Actual npm controls use loopback
HTTP; real HTTPS/registry operation requires separate qualification.

Acquisition uses the real npm client's `view name@version` through that origin
guard. It checks name/version, SHA-512 integrity, channel, admitted archive origin
and the absence of an installed dependency graph. The downloader then requests
that exact admitted archive URL, checking every redirect before following it and
bounding raw body bytes by the admitted archive length. Only identity HTTP
content encoding is supported; archive gzip is part of the payload, not a
separate HTTP decoding step. Its entire redirect/body
sequence has one acquisition deadline. It does not let another npm metadata
representation select a new source. The archive receives the same structure,
complete inventory, metadata and README source checks as a supplied archive
before npm parses or extracts it. A channel result is a dated observation, not a
lock on future registry state or publication permission.

The admitted copy is added offline to the fresh npm cache. Installation uses the
real `npm install name@version` with a newly written lock binding the observed
registry URL and admitted SHA-512 integrity, scripts/links disabled and offline
resolution. It does not install a local tarball pathname. This deliberately
qualifies a registry-resolved cached installation, not an independent second
live resolution during install. The resulting lock, complete installed tree
and actual content-addressed cache archive before/after installation must agree.
The SRI-checked install and its pinned lock bind the consumed archive; hashing
another pathname alone would not establish that fact.

The cache witness is qualified specifically for npm 11.1.0, pacote 21.0.0 and
cacache 19.0.1's `content-v2/sha512` layout: the client reads content by its lock's
SHA-512 digest. The tool locates that owned object without importing global
private packages. It checks its exact size, SHA-256 and SHA-512; actual-client
controls reject corruption even when another owned archive copy remains valid.
Another client/layout requires interoperability qualification rather than a
fallback path or an assumption that a version string proves behavior.

The driver also installs the downloaded exact archive through the supplied-file
route and compares its complete installed tree. Public entry/type/asset and
browser assertions then execute on the registry application's same verified
content; they are shared evidence, not a claim to have run the browser profiles
twice. Browser and GPU availability remain separate explicit requirements.

The maintained `createRegistryPackageApplication` API returns an owned fixture
with `close()`, a public-safe `registry` observation, its checked `tarball` and
`privateRegistryEvidence` containing the original selected metadata output,
normalized private plan, resolved URL and actual admitted download URLs. An
integration coordinator must retain required exact originals/copies before `close()` and
inspect them before any publication. API errors retain private causes and any
available private evidence; never serialize the whole fixture or error into
public output. The CLI keeps the original plan/evidence inputs, emits the safe
report and removes its temporary downloaded archive/cache/application. Its
report alone is not a retained release evidence set or publication admission.

## Read the report

The underlying Node driver emits one JSON report on stdout and returns a
nonzero status on failure. npm itself prints its usual command banner when
using `npm run`; consumers needing a JSON-only stream can invoke the same
driver directly:

```console
node scripts/run-package-browser-tests.mjs --tarball path/to/approved-package.tgz --expected path/to/candidate.json
```

Use `--gpu` with that driver for the GPU route. Optional `--browsers Chrome,Firefox`
selects an explicit ordered list of unique canonical browser names, overriding
`TABGRAD_BROWSER`. Empty, repeated or unknown names reject before preparation.
Without the flag, the existing single-browser environment selection and CPU/all
or GPU/Chrome defaults remain. The release consumer passes its declared list
through this flag rather than assigning a list to the single-browser environment
variable.

On a failed release consumer child, the publication diagnostic may retain only
the recognized bounded `failure.phase` and `failure.code` from this report.
Arbitrary child output, error messages and private paths are excluded; these
diagnostics grant no authority or successful qualification.

The report has `schemaVersion: 1`:

- `input` distinguishes `supplied-archive`, `source-candidate` and `registry-version`; `candidate`
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

For registry input, `registryPlanInputSha256` identifies the exact private input
bytes. The nested `registry` observation separately identifies the normalized
plan, selected metadata output and resolved URL by SHA-256, without printing
those private values. It records actual npm, initial metadata observation time,
channel, completed registry checks, guarded metadata request and raw archive acquisition counts, origin digests and requested-URL digests.
On failure it retains its last phase and earlier checks. `producerAuthentication`
and `releaseAdmission` remain `unqualified`, including on content success.
Retain the private originals when these identifiers are needed as evidence.

Success is reported only after owned application/candidate state is removed.
The existing browser harness owns its process, profile and loopback-server
cleanup; its [diagnostic limits](browser-diagnostics.md) still apply. Inputs
and completed observations remain distinct from that cleanup. Neither route authenticates producer signatures, admits a release, creates
control records, signs, publishes, deploys or changes account settings.
