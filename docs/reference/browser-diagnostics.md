# Browser qualification diagnostics

This reference is for contributors investigating a failed browser check. It
describes the shared harness used by the browser test and measurement commands,
not a tensor-runtime API. Command setup and selection belong in the
[development guide](../development.md); publication of evidence follows
[SECURITY.md](../../SECURITY.md#publication-confidentiality).

A timeout is an observation, not a root-cause diagnosis. Starting a process,
receiving an HTTP request, admitting that request to a run, serving a page and
executing its JavaScript are different events. A process can exist without
navigating; a request can reach the server with an invalid token; an admitted
page request can be waiting on a file read. The records below preserve those
distinctions without changing the check's admission or success criteria.

## Read a failure in boundary order

First inspect `failureKind` and the reported lifecycle phase. Navigation has a
60-second bound; after page admission, loading and application execution have
a separate 30-second bound. The harness does not retry a failed run. Browser
launch, asset, control-report, assertion, premature-exit, diagnostic-channel,
termination and profile-cleanup failures retain their existing classifications.

Then compare three sources:

1. `incomingRequests` records passive ingress during the active diagnostic
   interval, including traffic that cannot be authenticated to that run.
2. `requests` is the existing associated-request history. Its entries follow
   token association and, for ordinary assets, asynchronous file reading. An
   empty history alone does not prove that no request arrived.
3. `timeoutSnapshot`, present for navigation/application timeout, preserves
   observations before cancellation and cleanup. Top-level `process`,
   `terminationFailure` and `cleanupFailure` instead describe final cleanup.

A later successful run does not explain an earlier failed one. In particular,
none of these records proves a browser startup defect, an OS deadlock or a
numerical runtime failure without further evidence.

## Incoming-request records

Ingress is recorded before token association and before awaiting request bodies
or files. It is passive: an incoming observation never resolves navigation,
advances a phase or supplies a result. Existing explicit control-token checks
and page/result assertions remain authoritative.

Each interval retains at most 64 records, in arrival order. Each record describes
one request's latest observed progress, not a complete packet trace or a list of
every intermediate state. `incomingRequestsTruncated` means further arrivals
were omitted. No diagnostic response callbacks are added for those omitted
records. Retention resets at the next registration.

| Field | Meaning |
| --- | --- |
| `elapsedMilliseconds` | Rounded monotonic arrival time since this run's registration. |
| `method` | A known HTTP method, or `OTHER`; arbitrary method text is not retained. |
| `resource` | An explicitly registered page/fixture identifier, a known Pyodide asset or control endpoint. Other paths become `[unregistered]`. A registered identifier longer than 256 characters becomes `[registered-identifier-omitted]`. |
| `association` | Whether existing routing associated the request by matching token, active fallback, missing control token or unmatched token. |
| `stage` | Latest observed body/file/control disposition. |
| `progressMilliseconds` | Rounded time when that latest progress was observed. |
| `responseStatus` | Status observed when the response finishes, or `null` before that event. |
| `responseFinished` | Whether Node emitted the response's `finish` event during the active interval. |
| `responseFinishedMilliseconds` | Finish-event time, when observed. |
| `responseClosed` | Whether the response's `close` event was observed during the active interval. |

Association categories are `matching-token`, `active-fallback`,
`missing-control-token` and `unmatched-token`; `unresolved` denotes the instant
before association is recorded. Ordinary tokenless assets can use the existing
active-run fallback. Control reports cannot. An unmatched incoming request
does not enter the associated history or complete the active run.

Progress categories are `received`, `reading-body`, `reading-file`,
`control-rejected`, `control-accepted`, `control-invalid`, `asset-rejected`,
`file-served` and `file-failed`. For example, `reading-file` without a finished
response shows serving work admitted but not yet completed. It does not reveal
why the read is pending. `finish` means Node handed the response to its transport;
it is not proof that the browser received it or executed JavaScript.

The diagnostic interval is not proof of request provenance. A late request
carrying an obsolete token can appear as unmatched traffic in a later interval,
but cannot authenticate as that run. Response callbacks retain their original
owner, and cancellation closes that owner. They cannot mutate a later run or
previously returned snapshot. The final post-cleanup snapshot can therefore
omit completion events that occur after the interval was closed.

## Failure-time observation and cleanup

After navigation or application times out, the runner immediately copies its
ingress, phase and Node child-event state. It then inspects only metadata for
the disposable profile directory it created. These observations occur before
run cancellation, termination and profile removal.

`timeoutSnapshot` contains registration-relative `elapsedMilliseconds`,
`lastPhase`, detached incoming records and their truncation flag, plus:

| Observation | Meaning and limit |
| --- | --- |
| `process.pidAssigned` | Node assigned a PID; the PID itself is not retained here. |
| `process.spawnObserved` | The runner observed the child's `spawn` event. |
| `process.spawnFailed` | A child-process error was observed; its message is not copied here. |
| `process.exitCode` / `process.signal` | Exit information already observed at the failure boundary, or `null`. |
| `profile.state` | `directory-present`, `missing`, `not-directory` or `unavailable`. |
| `profile.reason` | For unavailable metadata: `permission-denied`, `inspection-error` or `inspection-timeout`. |

A null exit observation does not prove OS-level liveness. Directory presence
does not prove successful profile selection or page startup. No browser process
tree, command line, stack, profile contents or user-owned profile is inspected.
The metadata operation is `lstat`, so a replaced symlink is not followed into
another directory. Node event state is copied before awaiting that read;
the metadata observation is not an atomic snapshot of the same instant.

Metadata inspection has a dedicated two-second maximum wait, matching the
harness's finite diagnostic-cleanup granularity. This is not a larger
navigation/application deadline. Missing, denied, erroneous or late metadata
produces an explicit observation rather than replacing the original timeout.
The timer is cleared when the wait ends, and late promise settlement remains
observed. This is a cooperative promise bound: Node's filesystem metadata
operation cannot be forcibly canceled, and the bound is not a guarantee against
an OS-level blocked filesystem operation.

Cleanup retains its separate responsibilities. The runner joins the process it
launched, closes its receiving diagnostic handle and removes its owned profile.
The [development guide](../development.md#prepare-the-browser-runtime-build-environment)
explains the TERM/KILL and handle-closure bounds and incomplete-stderr notices.
A failure-time `exitCode: null` followed by final `signal: SIGTERM` means that
termination was observed during cleanup; it does not establish why startup
failed. Cleanup errors remain visible without replacing an earlier failure.

## Privacy and evidence handling

The new ingress and timeout fields omit query values, run tokens, request
bodies, arbitrary incoming paths, local paths, actual PIDs, command lines,
environment values and profile contents. Their identifiers and categories are
bounded. A raw known resource identifier is retained only from the harness's
trusted registration configuration; that configuration still requires ordinary
publication inspection.

These restrictions do not certify the entire `BrowserRunError` as public-safe.
Existing fields include executable context, associated paths, native error
messages and bounded stderr. Keep original output protected, inspect it and
prepare a separate technical derivative before sharing it. A checksum or a
successful token-redaction test is not a general confidentiality guarantee.

Retain every actual failure separately from later successes. State which
observations were unavailable or truncated and what remains unknown. The
diagnostics improve the next failing run's evidence; they cannot recover the
state of a process and profile that have already been cleaned up.
