# Experimental Docker Exec acquisition

This retained internal experiment connects one explicit local Docker Exec to
[startup controls](provenance-acquisition-startup.md) and
[binary capture](provenance-acquisition-capture.md). It creates no container,
image, group, policy or trust material. Imports perform no I/O. Native use
requires separately admitted infrastructure and authority under the
[release policy](../releases.md#qualify-mechanisms-before-claiming-readiness).
Tests use a finite local Unix peer, not Docker or an acquisition client.

## Meaning of the channels

The files preserve exactly the daemon's stdout/stderr channel payloads, without
establishing exclusive provenance from the program. The pinned
[Docker 29.9.1 route](https://github.com/moby/moby/blob/b26fb77d3e7b01f9d21b89539c1ab428f5ca431f/daemon/server/router/container/exec.go)
opens streaming before backend start and can write a later error through the
same stdout writer. Its [backend](https://github.com/moby/moby/blob/b26fb77d3e7b01f9d21b89539c1ab428f5ca431f/daemon/exec.go)
and [inspection](https://github.com/moby/moby/blob/b26fb77d3e7b01f9d21b89539c1ab428f5ca431f/daemon/inspect.go)
provide no separate definitive start/attach-error field. Framing, PID and
reported zero exit do not supply that attribution. This source inspection is
not physical Docker qualification.

No diagnostic text is removed or rewritten. HTTP errors and adapter diagnostics
stay outside originals; diagnostics inside daemon payloads stay there. A
consumer requiring process-only originals must establish that independently.
Results always retain `payloadOrigin`, `externalClosure`, `clockAdmission` and
`releaseAdmission` as `unqualified`.

## Input and ownership

`await createAcquisitionExec(input, {startup, clock?, request?, transfer?})`
copies the profile and opens existing capture files; no socket request or
actor launch occurs until `run`. `startup` is an owned unstarted startup
object. Optional clock, Node request factory and file-transfer port are trusted
test seams, not untrusted plugins. Input has exactly:

| Field | Domain |
| --- | --- |
| `operationId` | Existing lowercase 32-hex identity |
| `socket` | `{path,identity:{dev,ino}}`: canonical absolute Unix path, independent decimal uint64 native identity, nonzero inode |
| `containerId` | Full lowercase 64-hex ID of an independently admitted container |
| `command` | `{argv,env,user,workingDir}`: copied dense string arrays, nonempty command/user, canonical absolute container directory, no NUL, unique explicit environment names |
| `capture` | Existing binary-capture `{root,destinations}` |
| `timing` | `{t0MonotonicNs,deadlineNs,processBudgetNs,pollMs,closeWaitMs}` |
| `limits` | Explicit `{headerBytes,controlBytes}` positive safe integers within Node's maximum Buffer length |

Origin and positive nanosecond bounds are decimal uint64 strings. Operation,
origin/root must match startup's immutable `context`; the operation cutoff may
be tighter than that context's original cutoff. Host work admission and guard
observation horizons remain separate. `pollMs` is an integer from 1 to 5000;
`closeWaitMs` is positive within Node's signed 32-bit timer range.

Before each connection the path must still be a socket of the expected native
identity. Stable owned namespaces, daemon trust/permissions, admitted image,
tools/container, initial files/allocation and caller placement within the
supervisor budget remain host/caller premises. Path checking does not resist
privileged replacement between check and connect. Explicit environment does
not clear image defaults; inspection does not expose effective environment/cwd.
Declared budgets qualify neither aggregate RSS nor physical storage.

## Borrowed protocol attempt

`createAcquisitionExecAttempt(input, {gate, capture, request?})` is the
synchronous internal protocol entry from `provenance-acquisition-exec-attempt.mjs`.
It copies the same request profile before effects, without opening payload
files or starting controls. `input.capture` binds the declared root to the
gate; it does not verify or open those destinations. The caller supplies the
already admitted capture for that operation. The convenience entry above still
validates its startup and opens/owns its files. Its validation order remains
data and command first, startup observations second, final scalar copying last.

The gate has exactly four own data fields:

| Field | Collaboration contract |
| --- | --- |
| `context` | Readonly `{operationId,t0MonotonicNs,deadlineNs,root}` for the existing operation; identities/origin/canonical root match input and the attempt cutoff cannot exceed the context cutoff |
| `check()` | Synchronous current permission check returning the operation owner's accepted monotonic `bigint`; throws on loss of permission or clock failure |
| `appendIntent(event)` | Awaits the real supervisor acknowledgement of the same client-begun/body-hash intent before any daemon request |
| `revoke(code)` | Synchronously notifies the upper owner to revoke its borrowed work; takes no authority over startup finish, payload files or global closure |

The gate owns prior operation clock history, including file opening. There is
no independent clock port or fresh origin for this entry. On that same returned
sample the attempt checks nonregression and its possibly tighter operation
cutoff; it starts the process allowance just before Start. The convenience gate
shares that same bounds state so expiration still precedes a lost-permission
report on the same observation. A poll
also checks permission and these bounds while ACK or HTTP is pending. The
convenience owner checks the original clock while startup is pending and during
its own cleanup, preserving the opening sample and cutoff.

The borrowed capture supplies awaited `write(Buffer)` and synchronous `finish()`.
Here `finish` validates stream EOF/framing before after-inspect; it grants no
file-close or global-finish authority. The attempt never calls capture stop or
close. The upper owner must revoke its sink on notification, and remains
responsible for pending borrowed writes and eventual file disposal. Callback
ports are selected/bound at construction; later method replacement cannot
redirect an admitted attempt. These are trusted collaboration ports, not
untrusted plugins or proof of the capture's provenance.

`run()` returns one promise, settling after protocol completion or revocation.
`stop()` synchronously notifies once and aborts owned HTTP; stopping an already
successful protocol has no further effect. Parent notification precedes HTTP
abort callbacks. A failed notification remains visible as `revocationError`
without replacing `firstFailure`. `snapshot()` is passive and frozen; it contains
the same identities, phases and HTTP observations, plus `protocolComplete` and
`workPending`. It makes no assertion that capture files or controls are closed.
Nonzero reported exit remains protocol data. All four admission/origin flags
remain `unqualified`.

`join()` passively observes closure of currently known HTTP handles. It neither
starts work nor waits for a borrowed ACK/write nor closes files or controls.
Thus stop can return with `workPending`; a late ACK cannot issue a request and
a late write may still add a confirmed prefix. A later response can introduce
new close uncertainty after an earlier join. The caller must retain ownership
and inspect fresh observations; neither run nor join establishes physical
termination. The convenience entry delegates this exact four-phase sequence
and retains its original general cleanup contract below.

## One attempt and cleanup

`run({observedUtc})` returns one promise; repeated valid calls return it without
replaying effects. UTC is a caller observation. The adapter starts existing
controls, requires their observed permission, and acknowledges
`acquire/transition/client/begun` with the create-body hash before daemon effects.
It creates once, inspects identity/configuration and unstarted state, starts
connected once, captures complete framing, and inspects that Exec again.

The fixed API is 1.56. Create requires 201 with `{Id}`; inspect requires 200 and
the pinned exposed identity/configuration fields. Before start: PID 0,
Running=false, null exit. After stream end: positive reported PID,
Running=false, nonnegative integer exit. Neither authenticates physical launch
or exit; a nonzero reported exit remains visible.

Create explicitly selects stdin closed, stdout/stderr attached, Tty=false and
Privileged=false. Start selects 101 with HTTP 1.1, Upgrade/tcp and
`application/vnd.docker.multiplexed-stream`; 200/raw-stream/TTY alternatives,
redirects, compression or mismatches reject without fallback. The
[Node 22.12 HTTP API](https://nodejs.org/download/release/v22.12.0/docs/api/http.html)
owns parsing and upgrade `head` bytes. Early bytes precede subsequent chunks;
every capture write is awaited. Explicit Node header bounds and control buffers
apply before JSON admission. Invalid UTF-8 and duplicate decoded keys reject.
Four phase observations are retained, without a retry queue or transcript.
Capture keeps its existing one-borrowed-chunk contract; producer/Node/kernel
buffers and RSS are outside that structural claim. No speed improvement is claimed.

`stop()` revokes synchronously, excludes new HTTP/capture and notifies controls
without waiting behind I/O. It also initiates owned file closure, including
when `run()` has never been called; repeated stops do not reopen or close twice.
Snapshots retain pending or failed file closure without requiring actor launch.
Original monotonic nonregression and operation
cutoff are checked at effects/awaits and by a local poll. Process allowance
starts once before start and renews neither bound. Ambiguous create/start/write
effects are not retried; late effects cannot restore permission.

Cleanup joins owned HTTP/file operations and finishes controls within the
smaller of its local wait and remaining original operation budget. Missing
close receipts, pending writes/control finish stay uncertain. Native progress
and physical termination are not guaranteed. `finished` means the local wait
ended; fresh snapshots may retain late effects without rewriting an earlier one.
`cleanupWaitExpired` and its cleanup error are permanent: late closure can add
facts but cannot turn the expired result into local completion. The clock
sample accepted while opening capture also governs the first daemon effect.
Cleanup reobserves that same clock and operation cutoff after its await;
late reports survive a clock failure or an expired operation without allowing
local completion. Process allowance does not extend the operation cutoff.
A response arriving after cancellation is still owned: destruction requests
are distinct from observed stream closure. A fresh snapshot can reveal this
late pending stream even after an earlier snapshot observed all known handles
closed; earlier snapshots remain observations of their own known handles.

`snapshot()` contains identities, create/start phases, separate daemon reports,
first failure/cleanup error, pending work, each request/stream end/close, capture
prefixes/hashes and the controls' result. `locallyComplete` means this protocol
and observed cleanup with complete collected control records, not successful client content, exclusive
origin, physical closure or admission. Pending create/start becomes unknown
on revocation without reconstructing or replaying a missing result.

An actor receiving client intent ends conservatively with `clientState: unknown`,
even if the intent write/ack fails. Without it, default control-only consumers
keep `not_started`. Daemon exits and raw captures stay in the separate result;
they invent no authenticated client, custody or validation fact in the record.

Closed diagnostics are `EXEC_INPUT`, `EXEC_CLOCK`, `EXEC_DEADLINE`, `EXEC_GATE`,
`EXEC_IDENTITY`, `EXEC_PROTOCOL`, `EXEC_HTTP`, `EXEC_METADATA_LIMIT`,
`EXEC_CAPTURE`, `EXEC_STOPPED`, `EXEC_CLEANUP`; capture retains its own errors.
Errors expose no native message, path, stack, command or environment. Returned
identities/bytes/records still need content inspection before publication.

Registered checks use literal local wire peers, owned files, controlled failures
and finite startup/syscall fixtures. They qualify no real daemon, Linux
isolation/resources, clock, allocation, trust, custody, signing or release.
MJS is documented/dynamically tested outside runtime TypeScript; distributed
runtime behavior is unchanged and production TDD does not apply.
