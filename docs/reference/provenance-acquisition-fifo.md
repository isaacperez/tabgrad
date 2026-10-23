# Experimental acquisition FIFO transport

This retained internal experiment owns three existing host-view FIFO readers
and their auxiliary writers (sentinels). It delivers borrowed raw bytes to
independent sinks. It does not create IPC, start a program, invoke Docker,
decode control or admit evidence. Imports and construction perform no I/O.
The [release policy](../releases.md) governs authority and qualification.

## Profile and native premises

`createAcquisitionFifos({ipc,timing}, ports?)` synchronously validates and copies
ordinary own-data fields, returning the owner before any native operation.
Unknown keys, accessors, malformed Unicode/NUL and aliased identities reject
with `FIFO_INPUT`. The profile is independent of the launcher's program,
credentials and container-view paths:

| Field | Domain |
| --- | --- |
| `ipc.root` | `{path,identity:{dev,ino}}`; canonical absolute host directory |
| `ipc.stdout`, `ipc.stderr`, `ipc.control` | `{name,identity:{dev,ino}}`; three distinct basenames |
| `timing` | `{t0MonotonicNs,workUntilNs,closeUntilNs,pollMs}` |

Identities and times are canonical uint64 decimal strings, inode nonzero.
Root and endpoints have four distinct expected effective identities. Root and
derived paths are at most 4096 UTF-8 bytes and 64 components. Work is positive
and no later than close; cutoffs are elapsed from the original T0. Close is
at most Node's timer range, 2147483647 milliseconds; `pollMs` is an integer
from 1 through 5000. These are format/timer guards, not measured performance
thresholds or an authenticated time allowance.

`open()` starts one preparation and always returns its same promise. Snapshots
and stop remain available during opening. The native adapter checks the root's
directory identity, no symlink and canonical realpath; opens **all readers
before any sentinel**; verifies each handle's FIFO type and expected dev/ino;
and rechecks the root after opening. Readers use O_RDONLY, sentinels O_WRONLY,
both with NONBLOCK/NOFOLLOW, without create/truncate/append or blocking fallback.
Sentinels never write. Every returned handle is adopted before the subsequent
clock check, including a late handle after stop or local wait expiry.

The separately admitted owner must provide prepared endpoints, permissions,
stable namespace, host/container correspondence and clock correspondence.
Checks here do not establish isolation against a hostile client or race-free
namespace stability. Regular payload reservations still require regular files;
the FIFO adapter does not broaden that file opener.

## Independent reads and sinks

After successful opening, `drain({stdout,stderr,control})` validates exactly
three functions and starts one drain. Repeated calls return the same promise,
without replacing sinks. Each sink receives one Buffer view borrowed until its
returned operation settles; it must not mutate the view or retain it afterwards.
There is no second read on that role while the sink is pending. Other roles
can progress independently. This owner never finishes or closes a sink.

| Role | Maximum submitted prefix | Scratch/read quantum |
| --- | --- | --- |
| stdout | 1 MiB | 16 KiB |
| stderr | 256 KiB | 16 KiB |
| control | 890 bytes | 178 bytes |

Payload capacities come from the [raw writer](provenance-acquisition-payload.md);
control bounds come from the [launch protocol](provenance-acquisition-launch.md#control-protocol).
Each role retains one fixed scratch Buffer. Reads request
`min(quantum, remaining + 1)`. Known positive bytes are delivered in order;
short reads do not cause replay. A read containing excess submits only the
allowed prefix, records `FIFO_LIMIT` before the post-read clock check and
immediately starts cleanup without awaiting the sink's settlement. Only that
first overflow read may submit its allowed prefix, with a valid clock and no
intervening stop/deadline; otherwise the prefix remains unsubmitted. The extra
byte proves local excess; it is not submitted. At an exact capacity a one-byte probe still
distinguishes EOF from excess. No chunk history or input queue is retained.

Each positive chunk yields before another read. EAGAIN/EWOULDBLOCK and early
zero reads use a bounded idle poll, never a synchronous retry loop. A zero is
local EOF only when observed after release was requested and that sentinel's
close was confirmed. `releaseSentinels()` requests the three closes once and
returns the same promise, without waiting for reads, sinks or EOF. A failed
sentinel close cannot establish EOF. The surrounding coordinator owns the
decision to release after terminal control E and settled Exec; this standalone
owner neither observes nor invents those facts. EOF alone proves neither
program origin nor absence of descendants/other writers.

The future control destination writer, destination-set admission and complete
Exec/startup/session composition are outside this transport. A test sink
does not supply those responsibilities.

## Failure, clock and local waiting

The default clock is `process.hrtime.bigint()`. One nonregressive elapsed
history covers all roles. Checks surround awaited root/open/stat/read/sink/
close effects and admission; timers retain the original cutoffs even if an
early callback needs rearming. Known native effects and failures are recorded
before their subsequent clock check. This orders local observations, not
independent actors physically.

`stop()` synchronously revokes new work and requests sentinel and reader closes
without awaiting a retained read or sink. Late native results remain owned;
known late read bytes are counted but not delivered to a sink after revocation.
Each adopted handle gets at most one close attempt. Close failure stays unknown
and is not retried. Pending sink input remains borrowed until its settlement.

`close()` also revokes, returning one promise. It ends the local wait when owned
work settles or the original close cutoff expires. A broken clock immediately
ends that wait with failure because no further wait can be authenticated.
Pending effects/handles remain owned and visible in fresh snapshots; neither
returning nor `finished` asserts their physical termination. Late effects
cannot restore success or mutate an earlier snapshot. Successful drain joins
local reads, sinks and handle closure; calling close after that preserves it.

Diagnostics are closed codes, without native paths/messages: `FIFO_INPUT`,
`FIFO_STATE`, `FIFO_CLOCK`, `FIFO_TIMER`, `FIFO_ROOT`, `FIFO_OPEN`,
`FIFO_IDENTITY`, `FIFO_READ`, `FIFO_READ_EXTENT`, `FIFO_SINK`, `FIFO_LIMIT`,
`FIFO_CLOSE`, `FIFO_STOPPED`, `FIFO_DEADLINE`. Invalid call/profile shapes throw;
operational failures resolve lifecycle promises to incomplete snapshots.
The first cause is sticky; cleanup clock/timer/close/deadline failures are
recorded separately. A known overflow remains the cause even if its prefix
sink synchronously stops or fails.

## Observations and verification domain

`snapshot()` performs no I/O or clock read and returns frozen nested data:

- `state`: pending, complete, incomplete or limit; `firstError`, `cleanupError`;
- `prepared`, `opening`, `finished`, `cleanupWaitExpired`, `releaseRequested`,
  total `pendingEffects`, last valid elapsed `lastAtNs` and `ioClosed`
  (not_opened, open, pending, closed, unknown);
- each channel's `readBytes`, `submittedBytes`, `readUncertain`, `sinkFailed`,
  `overflow`, `eof`, `readPending`, `sinkPending`, `pollPending`, and
  reader/sentinel `{state,verified}`.

Read bytes include a known excess or late read. Submitted bytes count admitted
prefix lengths, including a sink that later fails. Unknown read extents are
flagged and never guessed. No confirmed-byte or digest claim is inferred from
a sink returning; persistence belongs to its owner. `complete` requires three
local EOFs, settled work, confirmed handle closure and no failure/expiry.
`payloadOrigin`, `externalClosure`, `clockAdmission`, `releaseAdmission` always
remain `unqualified`.

Trusted finite test ports are `clock()`, `root(expected)`, `open(path,kind)`,
`read(handle,buffer,length)`, `close(handle)`, `schedule(callback,ms)` and
`cancel(token)`. Open returns a Node-style handle with `stat({bigint:true})`;
read returns `{bytesRead}`. Scheduled callbacks are asynchronous; zero delay
yields with setImmediate, positive delay uses setTimeout. Ports are copied own
enumerable functions, not an extension/plugin or filesystem admission interface.

Tests use synthetic FIFO metadata, finite native effects/clocks and ordinary
owned temporary files. They cover flags, identity/type/root failure, independent
channels, exact/excess limits, short reads, borrowed-buffer lifetime, EAGAIN,
early zero/EOF, stop during opening/read/sink/close, deadline/clock/timer failure,
late results and composition with the actual raw file writer. Payload size,
partition, role and repetition vary separately with structural counters.
They create no FIFO, Docker/client, host laboratory, trust material or pilot,
and establish no physical resource, clock, payload-origin, custody, release,
RSS or temporal-performance qualification. These MJS contracts are exercised
by Node tests, outside the runtime TypeScript check.
