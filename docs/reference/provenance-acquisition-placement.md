# Experimental Linux acquisition placement

This internal retained experiment observes three identified processes in one
prepared cgroupfs leaf. It creates no infrastructure, starts no container and
does not migrate, signal, freeze or kill processes. Construction performs no I/O
or clock observation. It is outside the browser distribution. Native use needs
independently admitted preparation and the separate authority in the
[release policy](../releases.md#qualify-mechanisms-before-claiming-readiness).

## Domain and conditional admission

The laboratory profile is deliberately specific: an admitted Linux procfs view
in the initial observer PID/cgroup namespace, a cgroup2 mount of the complete
hierarchy, a stable identified case, and the cgroupfs runtime destination
`case/<fullContainerId>`. A single trusted init has PID1 in a private container
PID namespace. Init, launcher and program stay in that one leaf; no participant
creates task-bearing subgroups or migrates out. Runtime normal/fallback
destinations remain there. Preparation also excludes restart, healthcheck,
Docker-init, automatic removal, competing privileged creation/replacement and
PID reuse between a reported launch and its first native correlation. These
are external qualification premises, not facts established by a hash or a
deterministic pathname. Other topologies are outside this contract.

The examined [Moby cgroup construction](https://github.com/moby/moby/blob/b26fb77d3e7b01f9d21b89539c1ab428f5ca431f/daemon/oci_linux.go#L796-L811)
joins the configured parent with the container ID for cgroupfs. That is a spec
construction, not a qualification of its materialization by a particular
runtime. This narrow recipe permits direct native correlation without another
Container/Exec inspect request or relying on the daemon's reported PID. A
daemon inspect would add corroboration while retaining its own trust limits.

The [kernel proc contract](https://docs.kernel.org/filesystems/proc.html#process-specific-subdirectories)
distinguishes retained proc openings from future reuse of a numeric PID. The
observer retains those openings, checks birth identity across its reads and
correlates PID namespace identities and NSpid/NStgid vectors. Initial
attribution still depends on the qualified recipe and original launch controls;
it is not a general proof of all activity between two observations.

## Input and borrowed boundaries

`createAcquisitionPlacement(input,{gate,io?})` copies closed ordinary data before
selecting callbacks. Accessors, extra fields, symbols and exotic input objects
reject. The immutable `binding` getter returns that same copied profile without
I/O. The optional syscall port is trusted finite-test machinery, not an
operational plugin or physical evidence.

| Field | Domain |
| --- | --- |
| `context` | Exactly `{operationId,t0MonotonicNs,deadlineNs,root}`, using the acquisition token/uint domains, positive duration at most180s and canonical absolute evidence root |
| `containerId` | Full lowercase64hex ID; the exact runtime-leaf name, never a name to resolve |
| `preparedContainerSha256` | Lowercase64hex reference to independently retained preparation evidence; no authentication by syntax |
| `launcherProfileSha256` | Lowercase64hex identity expected in the persisted launch controls |
| `hierarchy` | `{root:{path,identity:{dev,ino}},case:[{name,identity},...]}`; canonical cgroup2 mount root, nonaliasing case chain of1..16 components using the existing host component domain |
| `proc` | `{path,identity:{dev,ino}}` for the independently expected procfs mount |
| `namespaces` | Exactly `pid`, `cgroup`, `time`, each `{dev,ino}`, identifying the observer's admitted views; subjects share its time namespace under the default policy |
| `clockPolicy` | Optional literal `"monotonic_offsets"`; without this field the original strict namespace-identity policy applies |
| `limits` | Exactly `procsBytes`, `procBytes`, `maxProcesses`: positive safe integers below Node's maximum Buffer length; byte limits include a separate one-byte overflow probe |

Device/inode values are canonical decimal uint64 strings with nonzero inode.
Paths are well-formed strings, exclude control characters, backslashes and noncanonical components and
are at most4096 UTF8 bytes. Case names/chain bounds match the prepared host
profile's domain; this is not arbitrary hierarchy discovery.

### Conditional common monotonic domain

The explicit `monotonic_offsets` policy permits different observer/init time
namespaces only when retained native originals establish equal monotonic
offsets. The observer and init each bind active `ns/time` and
`ns/time_for_children` before and after reading `timens_offsets` from the same
retained proc directory; both links must identify that subject's active
namespace. PID, PPID, starttime and nondead state are checked again across that
observation. Launcher and program still require init's time namespace.
Missing files, changed associations or unequal offsets reject admission.

For the admitted Node22.12/Linux implementation, `hrtime.bigint()` reads
CLOCK_MONOTONIC without subtracting a process origin. On the same admitted
kernel/boot, the counter is global monotonic time plus its namespace's
monotonic offset. Equal exact offsets support a common counter domain even
with different namespace inodes; neither zero offsets nor nearby timestamp
samples are assumed. Linux freezes an entered namespace's offsets. Its proc
offsets file reports **the namespace for children**, which explains the extra
active/children association checks. The parser retains separate signed
monotonic/boottime values using integer nanoseconds. Its 84-byte maximum follows
the two kernel lines, each with a 10-character name field, signed64 seconds,
9-digit nanoseconds, spaces and newline; an independent extra byte detects
overflow. A failed read retains its known prefix and uncertainty.

This is conditional on independently admitted implementations and stable
trusted participants with no intervening namespace migration. Endpoint samples
do not exclude ABA or prove continuity. Equal monotonic offsets do not establish
equal boottime. Proc starttime uses the **reader's** boottime namespace; birth
comparisons remain in the same stable exterior observer. No timer scheduling,
precision, physical-deadline or native-qualification guarantee follows.

The [source investigation](https://github.com/isaacperez/tabgrad/issues/314#issuecomment-6441667974)
and [independent challenge](https://github.com/isaacperez/tabgrad/issues/314#issuecomment-6441671397)
fix the examined source revisions. Retaining shared namespace identity was
considered; the examined Docker API offers no host-TimeNS selector. Introducing
a runtime wrapper would add a privileged tool/recipe boundary. The accepted
conditional domain avoids that addition while retaining the explicit premises
and conservative failures above. Reconsider it if implementation, clock source,
kernel/boot relationship or namespace-migration trust changes.

The closed gate is `{context,observe,check,revoke}` with exactly matching
context. `observe()` checks the original owner's monotonic clock/cutoff before
controls are ready. `check()` additionally checks current permission after
startup. Both return that owner's accepted absolute `bigint`; there is no second
origin or allowance. `revoke(code)` synchronously notifies the owner. Methods
are bound to their original receiver. Replacing input/methods afterward cannot
redirect the operation. Time must be at or after T0, nonregressive and strictly
before the original deadline. `poll()` supplies an explicit local clock/gate
observation while a read is stalled; the caller owns polling and external bounds.

## Native reads, observations and lifetime

`open()` retains the complete expected case route and procfs anchor, checks
filesystem identities/types, then checks the observer's own namespace views.
It borrows clock-only observation. `beforeStart()` switches irreversibly to
permission checks and requires the exact runtime child to be absent: only
ENOENT from its opening establishes that observation. Another opening error
does not establish absence. No child is created or alternate name selected.

`afterStart()` opens that exact child from retained case, checks cgroup2/domain
and retains its **newly observed** identity. It does not pretend that inode was
known before creation. Its bounded `cgroup.procs` read must identify one init.
Repeated PIDs and unstable order are supported; the distinct process count and
received bytes have separate limits. This file enumerates direct membership,
not a recursive census or an atomic snapshot.

For a candidate, the I/O owner opens a retained numeric proc directory and fixed
stat/status/cgroup files, reads stat before/after, and opens only the fixed
PID/cgroup/time namespace magic links. Namespace files are checked as nsfs;
proc/cgroup paths otherwise use retained descriptor routes and O_NOFOLLOW.
The [kernel filesystem identifiers](https://github.com/torvalds/linux/blob/v6.18/include/uapi/linux/magic.h)
identify these filesystem types, not trust in an arbitrary supplied port.

PID, PPID and starttime must agree across the stat reads; scheduling state and
comm may change. Comm is not an identity oracle and may contain whitespace or
parentheses. Zombie/dead observations reject. Starttime is in ticks since boot,
not elapsed nanoseconds from the operation's T0. Subject membership must equal
the exact prepared global leaf path. In this profile NSpid/NStgid contain the
observer PID and one container PID; init's internal PID is1. A different
required namespace, disappeared candidate, ambiguity or overflow fails conservatively.
It never scans the host or searches again until a favorable identity appears.

`observeExecution(observations)` consumes the capture owner's already persisted
R/S records. The launch codec checks their closed grammar; operation, profile,
time and launcher/child correlation must match. Native reads correlate launcher
and program in init's PID/cgroup namespace; the program's observed parent must
be that launcher. Each subject is checked once and occupies one fixed slot.
No program input, callback boolean or HTTP success supplies this result.

The original gate is checked around native admission/await boundaries. A late
opening is adopted before a post-await check, so cancellation cannot discard
its handle. Work and close pending remain separate. `stop()` revokes once and
begins close; no late completion restores permission. `close()` prevents new
work, joins admitted reads and attempts each owned handle's close once.
`join()` observes this local close when started. Unmatched candidates close
without retaining a scan history. Rejected closes retain their handles without
retry; `unconfirmedCloses` counts those fixed-budget references and closure stays
unknown. First failure, revocation error and failed
cleanup remain separate; no native messages/stacks enter diagnostics.

Passive frozen snapshots contain the fixed subject metadata, source byte counts
and hashes, current pending step, leaf identity, source-control references and
I/O/cleanup state. `mayExec` means the local conditional init check currently
permits the next phase; it is not a continuously observed lease.
`executionObserved` requires both fixed launcher/program observations and no
placement failure. Explicit `collect()` copies the retained original proc bytes;
snapshots never recopy those payloads. In offset mode collection also includes
the exterior clock observer and a rejected clock observation's partial originals;
metadata identifies its role and known offset prefix. Collection is neither durability nor an
authenticated receipt. Inspect originals under the publication policy before
transmitting them.

## Composition and limits

The [activated attempt](provenance-acquisition-attempt.md#activated-composition)
uses this owner between [Start](provenance-acquisition-activation.md) and Exec,
then observes R/S during capture. The qualified runtime/configuration and absence
of migration authority support admission before Exec; later subject samples
corroborate that premise. There is no new ACK before each spawn. A program too
brief to observe leaves insufficient evidence, rather than a fabricated pass.
Finite diagnostic programs may remain observable for their declared interval.

Neither empty membership, HTTP close, a signal receipt nor completed JavaScript
settles pending native Start/Exec effects. The outer admitted laboratory owner
retains physical retirement and must exclude reuse when that evidence is unknown.
These components do not rewrite S/W record truths. `externalClosure`,
`clockAdmission` and `releaseAdmission` always remain `unqualified`.

Tests use finite Linux-shaped syscall ports and literal native/control data;
composition also uses ordinary files, a Unix peer and the existing startup
owners. They qualify no real procfs/cgroup/FIFO/container topology, scheduling,
resource reservation, storage custody, real client, CI signing or release.
MJS is dynamically tested outside runtime TypeScript; this nondistributed
retained experiment has no production TDD claim.
