# Experimental acquisition program launcher

This retained internal experiment owns a closed launch profile, a bounded
control protocol and one nonprivileged program attempt. It is separate from
[Docker Exec](provenance-acquisition-exec.md), whose raw channels remain daemon
channels. Imports and constructors perform no I/O. Nothing enters the library
distribution or authorizes acquisition, a pilot, signing or publication.

The model trusts independently admitted client/runtime/launcher/host and a
stable owned namespace. It does not resist a deliberately hostile client sharing
the launcher's UID. Evidence reserves and critical records must remain outside
the program's mounts and permissions. The launcher does not create files,
FIFOs, containers, mounts, groups, credentials or trust material.

## Profile and identity

`encodeLaunchProfile(data)` validates ordinary own-data objects and dense string
arrays before encoding compact canonical UTF-8 JSON. `copyLaunchProfile(bytes,
{sha256,bytes})` requires the independently supplied exact hash and length P,
with 1 <= P <= 32768, and returns immutable `{profile,sha256,bytes}`. It rejects
invalid UTF-8, Unicode/NUL, duplicate or unknown keys, noncanonical order,
escaping and whitespace rather than normalizing them into admission.

Fields and nested fields have this exact encoding order:

| Field | Domain |
| --- | --- |
| `schemaVersion`, `operationId` | Number 1; lowercase 32-hex identity |
| `launcher` | `{runtimePath,runtimeSha256,entryPath,entrySha256,uid,gid,groups}`; canonical absolute paths, lowercase 64-hex hashes; nonzero decimal uint32 credentials; unique numerically sorted groups including effective GID |
| `program` | `{binarySha256,argv,env,workingDir}`; hash, nonempty explicit argv beginning with an absolute binary, unique explicit `NAME=value` environment, canonical absolute working directory; no ambient environment inheritance |
| `programRecipeSha256` | Hash of canonical `{program,credentials}`, where credentials is exactly `{uid,gid,groups}` inherited from launcher |
| `ipc` | `{root,stdout,stderr,control}`; root `{path,identity}` and endpoints `{name,identity}`; distinct basenames and effective identities; identity is `{dev,ino}` with decimal uint64 values and nonzero inode |
| `timing` | `{t0MonotonicNs,workUntilNs,closeUntilNs}`; decimal uint64 strings, positive work cutoff no later than close cutoff, both elapsed from the original T0 |

Paths are canonical, at most 4096 UTF-8 bytes and 64 components. Array order
identifies argv and environment; it is not sorted. P bounds the encoded
profile, not a promise that every application configuration fits. Strings and
array copying also have bounded admission guards. No accessor is invoked to
admit an ordinary-data field.

`readLaunchProfile(path,{sha256,bytes,identity})` opens an existing regular,
single-link file readonly with NONBLOCK/NOFOLLOW, verifies independently
supplied identity/size, reads P bytes and a one-byte EOF probe, checks canonical
bytes/hash and final identity/size, and closes the known handle. It does not
perform an unbounded `readFile` or infer P from untrusted stat. Native waiting
and namespace immutability still require the separately admitted outer guard.
P, hash and identity are copied before the first await; later caller mutation
cannot change the admitted allocation or read. Derived endpoint paths obey the
same byte/component limits as the root.

The future binding is Exec-body hash -> profile hash -> program-recipe hash;
the profile contains neither its own digest nor the Exec-body digest. Tool
hashes are identities admitted independently, not authentication established by
self-hashing. This owner does not reread whole tools to admit itself. The caller
must bind the original authorization cutoff, mappings and clock correspondence;
standalone profile validation cannot authenticate them.

## Control protocol

`encodeLaunchObservation(record)` checks one observation.
`createLaunchControlDecoder({operationId,profileSha256})` provides synchronous
`push(Buffer)`, `finish()` and immutable `snapshot()`. The wire is ASCII with
exactly thirteen fields, twelve separators and one LF:

```text
TGL1|op|profile|kind|at|launcher|child|attempt|exit|signal|fds|cause|cleanup
```

Object fields are `operationId`, `profileSha256`, `kind`, `atNs`, `launcherPid`,
`childPid`, `attempted`, `exitCode`, `signal`, `fds`, `cause`, `cleanupError`.
Null encodes `-`; attempt is 0/1. Time is the last valid elapsed monotonic uint64
sample, or null if none exists. PIDs are positive uint32 strings in the launcher's
namespace. Exit is 0..255; signal is Linux 1..64; they cannot both be present.
An unknown Node signal name fails closed, without exposing its text.

There is at most one observation of each kind:

- R: profile, credentials and three endpoints verified; no spawn attempt, two
  output copies open, no cause/cleanup. Its whole record must be confirmed
  before spawn is permitted.
- S: actual spawn event, positive child identity, attempted=true, no outcome.
- X: settled attempt. With a ChildProcess this requires `close`, not `exit`.
  A synchronous spawn throw without an object is a settled exception with no
  invented child close, PID or outcome; it does not prove no physical effect.
- F: first failure or stop. Without prior R, only E may follow; after an
  attempted spawn, already-admitted late S/X observations may still follow.
- E: terminal observation after previous owned effects and attempt settle;
  it precedes control-FD closure and does not claim that closure.

The two `fds` characters describe the parent's stdout/stderr copies: n never
adopted, o open, p close pending, c close confirmed, u close failed/uncertain.
Transitions are monotonic; c/u are terminal. IDs, outcomes, first cause and
cleanup error cannot be replaced; time and attempted cannot regress.
An unsuccessful child outcome introduces cause `child` when there was no prior
failure. An X without a known outcome requires a prior failure; a cleanup error
also requires a failure cause.
No new spawn follows F. Success requires R/S/X/E, child exit0 and output cc.
Child close is not FIFO EOF, disappearance of descendants or external closure.

Cause is null or `input`, `clock`, `deadline`, `open`, `identity`, `spawn`,
`child`, `protocol`, `control`, `close`, `stopped`. Cleanup is separately null
or `close`, `clock`, `deadline`. Pending is represented by owned work/FD states
and missing E, never a fabricated cleanup success. No paths, environment,
native messages or program bytes enter this channel.

Independent scalar maxima give 178 bytes per record and 890 total. These are
conservative format bounds, not reachable-size assertions or performance
thresholds. The decoder checks quotas before retaining bytes, keeps one fixed
178-byte line buffer and five fixed observation slots, and requires complete E
at EOF. It performs no CRLF repair, resynchronization, retry or fallback. Its
snapshot counters expose total submitted and peak retained bytes; the outer
capture must identify originals, not a re-encoding of parsed records.

## Attempt and lifetime

`createAcquisitionLauncher(admitted,ports?)` copies/validates before effects.
`run()` returns one promise, `stop()` synchronously revokes and starts output
closure, `join()` joins an existing run without starting one, and `snapshot()`
does no I/O. Trusted ports are `clock`, `credentials`, `root`, `openWriter`,
`spawn`, `schedule`, `cancel`; they are finite-test dependencies, not plugins or
another CLI mode. Clock returns the original absolute monotonic BigInt; root
checks identity/namespace; openWriter returns an owned Node-style handle;
spawn returns a ChildProcess or throws; timers use the given remaining delay.

Native entry accepts only `PROFILE_PATH EXPECTED_SHA256 P EXPECTED_DEV
EXPECTED_INO`. It requires Linux, matching runtime/entry paths and matching
current UID/GID/groups, without changing credentials. Control is opened first,
then stdout/stderr: existing O_WRONLY|NONBLOCK|NOFOLLOW FIFOs, with verified
type/identity. Only the two output FD numbers are passed to the child, with
stdin ignored, explicit cwd/environment, no shell or additional stdio. The
parent does not write program payload. It starts closing its output copies
on spawn/error without waiting for control writes.

Node 22.12's [bundled libuv](https://github.com/nodejs/node/blob/v22.12.0/deps/uv/src/unix/process.c)
attempts to clear NONBLOCK on inherited child stdio. That flag shares the
parent's open-file-description; control and future sentinels use separate opens.
The source does not check that flag-change result there. This experiment does
not qualify effective native flags or a real client's behavior on a full pipe.

Work and closure keep the original T0/cutoffs. Checks surround awaited effects;
local timers do not create a new allowance. Timer-range overflow rejects
instead of using Node's clamped delay. Stop or deadline prevents new work;
closure observes already-admitted effects. Control has one sequential writer
and at most five queued observation objects. Known positive short writes
advance only the confirmed range. Zero, invalid extent or throw stops that
channel without replaying an unknown effect. R must complete before spawn.

Close-cutoff expiry resolves the local wait with permanent
`cleanupWaitExpired`, retains pending native effects and prevents later E.
A late open is still adopted and closed; fresh snapshots add late facts while
earlier snapshots remain unchanged. No child-kill or retry service replaces
the external guard. Native calls can remain pending. A final control close
failure after E gives exit1 without rewriting E. Entry diagnostics contain only
`LAUNCH_FAILED`; API validation uses closed `LAUNCH_*`/shared file codes.

Snapshots separate attempt, child outcome, output/control FD states, pending
effects, first cause and cleanup. Observations describe queued local facts;
`confirmedControlBytes` counts confirmed transfers, not proof of external
receipt. `finished` describes the local wait. `exitStatus` is zero only after
child exit0, successful control and all owned closure within the original
budget. `payloadOrigin`, `externalClosure`, `clockAdmission`, `releaseAdmission`
always remain `unqualified`.
`pendingEffects` counts owned root/open/stat/write/close promises; the separate
`childSettled` field describes the child attempt. A rejected native effect is
classified before checking the post-await clock, preserving the observed
operation failure and first cleanup failure if that clock also fails.

## Validation domain

Tooling tests use independent literal profile/control vectors, chunk splits,
quota counters, ordinary owned files, synthetic FIFO stat/clock ports and a
finite local child. They cover separate channels, explicit stdio/environment,
open/identity failures, cancellation, child outcomes, partial/unknown writes,
late effects and failure-preserving cleanup. They create no FIFO, Docker
client/daemon, network service or host control. They qualify no Linux isolation,
clock, resource bound, real-client/TUF acquisition, custody or release. There
is no temporal/RSS improvement claim.

This MJS tooling is documented and dynamically tested outside the runtime
TypeScript check. Distributed executable behavior is unchanged; production
TDD does not apply. [Development commands](../development.md) own test entry
points. Transport, global destination admission, full acquisition coordination
and physical qualification are outside this standalone owner's contract.
