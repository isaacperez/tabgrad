# Experimental local program capture

This retained internal experiment composes the [launcher profile and control](provenance-acquisition-launch.md),
[FIFO transport](provenance-acquisition-fifo.md), [binary writers](provenance-acquisition-payload.md)
and [borrowed Exec attempt](provenance-acquisition-exec.md#borrowed-protocol-attempt).
It separates program stdout/stderr, original launcher control, and raw Docker
channels. Imports and construction perform no I/O. No distributed library API
or tensor behavior changes.

The caller owns preparation, startup, physical observation, validation,
readonly conversion, custody and global closure. This component never starts
or finishes startup. Its local completion is insufficient to admit an
acquisition or release. Native use requires separate authority and qualification
under the [release policy](../releases.md#qualify-mechanisms-before-claiming-readiness).
The [local acquisition caller](provenance-acquisition-attempt.md) composes
startup and this capture without taking the remaining admission responsibilities.

## Input and preparation

`createAcquisitionCaptureAttempt(input, {gate,clock?,files?,fifo?,request?})`
copies closed data and selects trusted test ports synchronously. The gate has
the existing exact context/check/appendIntent/revoke contract. Its context
binds operation, original T0, cutoff and canonical evidence root. The input has
exactly these six fields:

| Field | Meaning |
| --- | --- |
| `exec` | Existing Exec input; its capture pair holds the daemon's raw channels |
| `launcherProfile` | `{hostPath,containerPath,identity,sha256,bytes}`; independently identified canonical readonly file, 1–32768 bytes |
| `ipcHostRoot` | `{path,identity}`; host view of the launch profile's separately admitted IPC directory |
| `programCapture` | `{root,destinations}` with identified stdout/stderr reserves |
| `controlCapture` | `{root,destination}` with one identified 890-byte reserve |
| `recordCapture` | `{root,destinations}` with header/progress/supervisor/watchdog, for readonly admission checks; their writers stay with the caller |

Destination roots equal the gate's evidence root. Each destination is the
existing `{name,identity:{dev,ino}}` ordinary-data shape. All nine names and
identities are distinct; aliases with the known launch profile reject too.
Live checks require regular single-link files, independent effective identity
and exact capacities: program and daemon pairs 1 MiB/256 KiB, control890,
record32/960/16/16 KiB. There is no create, append or truncate. The five capture
files are opened read/write. Only temporary readonly check handles for the
profile and four record files belong to this owner; it closes them before
launch without touching the caller's writers.

The profile is read in bounded positional transfers, exact P plus one EOF
probe, checking identity/size again and canonical hash/encoding. The exact Exec
argv is runtime, fixed launcher entry, container profile path, hash, decimal P,
device and inode; user matches the profile's UID:GID. Operation, T0, IPC
identities and cutoffs match independently. The hash chain is exact Exec-body
hash -> profile hash -> program-recipe hash, without self-reference.

`open()` returns one promise for preparation: identified files, profile binding
and all FIFO readers/sentinels. It makes no Docker request and never calls
`gate.check()` as a substitute for a pre-startup clock. The caller can prepare
capture, start its own controls, then call `run()`. A run before successful
preparation fails rather than inventing permission. `clock()` observes the same
original monotonic domain; accepted gate samples must not precede that history.
Preparation and entry to run must remain within the original 15-second startup
horizon. Work is capped by the profile (at most135s), process allowance by Exec
(at most120s), and closure by its profile/original authorization (at most180s).
No phase renews T0 or extends authorization.

All namespace stability, host/container mappings, tool/runtime bytes,
permissions, mounts, physical reservation and protection from other readonly
inputs or caller control files remain independently admitted preparation
premises. This local owner sees the nine destinations and launcher profile;
it does not discover or certify separation from files it was never given.
`otherInputSeparation` remains `unqualified`. The program receives no evidence
file descriptors or evidence mount through this component. These premises do
not protect against a deliberately hostile client sharing the launcher UID.

## Data, permission and closure

`run()` publishes one promise before invoking callbacks. The three FIFO pumps
start before Exec; real permission and acknowledged intent precede daemon
effects. FIFO quanta/capacities and the existing Docker framing prechecks stay
unchanged. There is no invented Docker framing around program/control bytes.

Each control chunk is written to its own file before the same borrowed bytes
enter the incremental decoder. A failed write leaves its confirmed prefix and
uncertainty without claiming that unconfirmed E was observed. The stored
original is never a reencoding. Control parsing retains one178-byte line and
five observation slots; it accepts at most890 bytes. An explicit launcher
failure, malformed sequence or out-of-horizon observation prevents success.

Any nonempty daemon payload revokes local capture, independently of text or a
reported zero exit. Its actual submitted/confirmed prefixes remain in the
daemon files. Empty daemon payload alone supplies no client-origin proof. No
diagnostic is filtered, removed or reassigned to a program channel.
The decoder notifies this owner synchronously on actual nonempty submission,
before awaiting its transfer. Empty-frame yields, chunk boundaries and a held
write cannot postpone notification. The borrowed write still remains owned.

Normal sentinel release requires both persisted/valid E and settled successful
Exec; either can arrive first. It never waits for EOF while retaining the
sentinels needed to make EOF possible. Missing E remains incomplete until
revocation or the original cutoff; no synthetic E fills the gap. Failure/stop
requests FIFO closure immediately. Already admitted sink work remains owned
until it settles or the local wait expires, including the allowed overflow
prefix; excess bytes never enter files. Program roles progress independently.

Local success requires R/S/X/E, child exit0, no signal/cause/cleanup failure,
reported launcher exit0, complete empty Docker framing, all three EOF after
sentinel release and all owned effects/files closed. A close failure prevents
success even after valid E. Stop and cleanup failure preserve the first cause.
The original clock, closure horizon and caller permission are observed again
after the final owned await; a periodic poll cannot substitute for that check.
Closing observations use the original closure bound without admitting new work
past the data cutoff.
Snapshot counters distinguish FIFO read/submitted bytes, file submitted/
confirmed extents and their hashes; none means durable storage or receipt.

`stop()` is synchronous and idempotent; it excludes new work and notifies the
upper owner once without taking finish authority. `join()` waits for the local
closure result. `finished` and a resolved run/join describe that bounded wait;
pending native operations can remain. `cleanupWaitExpired`, pending counters,
FIFO states, file checks and writer reports preserve uncertainty. Late opens
are adopted and closed, late facts remain visible in fresh immutable snapshots,
and prior snapshots never change. A late result cannot restore success.

## Implementation and evidence domain

The passive `timing` getter exposes the frozen, already copied Exec timing to
that caller. It performs no I/O, clock sample or original input read.

The capture-attempt module owns orchestration, its profile module owns closed
data/bindings, and its file module owns global file admission and transfer to
the existing writer stores. Internal already-owned-store constructors allow
the composing owner to admit the full set once; public pair-opening entries
retain their existing validation, framing, quotas and cleanup. The only added
writer layout is the fixed control890 role; this is no configurable writer
registry or public plugin API. Store state is bounded by its fixed roles, not
the number of chunks, reads or frames.

Finite tests use real owned regular files and a local Unix HTTP peer, synthetic
FIFO metadata/transfers and clocks, literal control bytes, failure injection
and structural counters. They check separation, independent progress, both
E/Exec orders, mutations/reentry, nine-file admission, prefix/hash accounting,
overflow, held/failed effects and conservative closure. Existing component
tests continue to protect their contracts. These controls establish neither
physical FIFO/Docker behavior, Linux isolation/FDs, resource or clock admission,
real-client/TUF acquisition, readonly/custody, CI signing nor temporal/RSS gains.
`payloadOrigin`, `externalClosure`, `clockAdmission` and `releaseAdmission`
remain `unqualified`. MJS tooling is dynamically tested outside the runtime
TypeScript compiler; production TDD does not apply to this retained experiment.
