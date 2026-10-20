# Experimental Linux acquisition host control

This internal adapter encodes control over **already prepared and identified**
Linux cgroup v2 groups. It adds independently opened supervisor/watchdog routes
and an explicit external-guard entry to the
[process coordination](provenance-acquisition-process.md) domain. It creates no
group, unit, container, mount, filter or resource policy and runs no acquisition
client. Imports perform no native group opening or launch.

The implementation and synthetic controls do not qualify a Linux deployment,
delegation, native clock, resource budget, physical termination, custody or
release capability. [Release policy](../releases.md#qualify-mechanisms-before-claiming-readiness)
owns operational authority and qualification. A prepared path or successful
test double is not admission of an actual host.

## Owners and assumptions

`scripts/provenance-acquisition-host-profile.mjs` owns the closed input/report
domains. `provenance-acquisition-host-io.mjs` owns native openings, bounded reads,
one-shot requests and retained-handle closure. `provenance-acquisition-host.mjs`
owns one controller's revocation, clock observations and current report.
`provenance-acquisition-host-guard.mjs` owns the separate deadline loop and its
explicit entry. Process actors compose a controller without routing its stop
requests through the parent.

The bootstrap and host are trusted. They must establish ownership/delegation,
an admitted mount/namespace topology, stable prepared groups and actual process
placement before use. The supplied root must be the owned delegated subtree,
not an arbitrary manager-owned node. The adapter checks its specified native
identities, filesystem, domain and own membership; it does not configure or
authenticate those environmental premises, resist a hostile privileged manager,
or prove that Docker/systemd will preserve them. No native host is discovered.

## Prepared profile

`copyHostProfile(profile)` validates and copies an exact ordinary-data object:

| Field | Domain |
| --- | --- |
| `operationId` | Existing 32-character lowercase hexadecimal acquisition token |
| `t0MonotonicNs` | Common absolute monotonic origin, decimal uint64 string |
| `stopAtNs`, `observeUntilNs` | Elapsed uint64 strings with `0 < stopAtNs < observeUntilNs`; neither is renewed |
| `pollMs` | Explicit integer in 1–5000 ms; protocol observation interval, not measured scheduling sensitivity |
| `root` | `{path, identity}`; canonical absolute path, at most 4096 UTF-8 bytes and 64 components; `{dev, ino}` uint64 strings, nonzero inode |
| `groups` | Exactly `case`, `supervisor`, `watchdog`, `guard`; each a nonempty chain of at most 16 `{name, identity}` components relative to the root |

Names are 1–128 ASCII letters/digits or `_.@-`, excluding `.` and `..`.
The four leaves must be distinct and none may contain another; controllers and
guard therefore lie outside the target. Shared intermediate paths must have
the same expected identity. Cyclic ancestor identities, leaf aliases, sparse or
extended arrays, accessors, unknown fields and exotic prototypes reject.
The caller supplies expected identities independently of the newly opened node.
The complete process wire budget still applies; individual field limits do not
promise that every maximum-size combination fits.

## Native I/O boundary

`await openAcquisitionHost(profile, role, port?)` accepts supervisor, watchdog
or guard. The default port uses prepared Node standard filesystem APIs and
requires Linux. The optional syscall-shaped port is a trusted synthetic-test
boundary, not a user plugin or an alternate qualification route.

Opening walks the root from `/` and group chains through retained
`/proc/self/fd/<fd>/<component>` references, requiring directory/no-follow
flags, live native directory identity and cgroup2 filesystem type. Each group
must expose the admitted `domain` type. All groups are checked before target
control files are returned. Only existing fixed target `cgroup.freeze`,
`cgroup.kill` and `cgroup.events` files are opened; own `cgroup.procs` must
contain the current process ID. No PID migration is performed. Native files
must have the expected type/device. A replacement pathname is not reopened as
the old target. Privileged mount changes and real kernel retention/permission
behavior still require their environmental qualification.

Type/events/procs reads are limited before materialization to 32/128/1024 bytes
plus one overflow-detection byte. These are closed experimental acceptance
limits: type admits `domain` plus LF; events admits exactly one `populated` and
one `frozen` binary field in either order; procs admits decimal process IDs and
must include the actor. The procs allowance covers the declared bounded
controller populations with margin; unstable/oversized output rejects rather
than being silently truncated or retried. Native PID lists can repeat; no
ordering or uniqueness assumption is used.

`freeze()` and `kill()` each attempt exactly one byte `1` at position zero and
retain the same promise on repeated calls. There is no thaw, retry, create,
configuration fallback or daemon command. Failed/short/ambiguous writes remain
unknown. An ACK says only that the syscall reported the expected transfer.
`observe()` reads the existing event handle, admits only one read operation at
a time and returns the two fields, not a closure verdict. `close()` excludes
new work, joins admitted reads/writes and attempts all owned closes once.
Partial-open cleanup preserves the original error and a separate close error.

## Controller and process binding

`await createAcquisitionHostController(profile, role, {clock?, openHost?})`
opens one route. Its default clock reads `process.hrtime.bigint()`; supplied
clocks/ports are trusted test boundaries. Future origins reject before native
opening; regression, invalid clocks, deadline or failed observation revoke.

| Call | Effect |
| --- | --- |
| `check()` | Explicit elapsed-clock sample; reaching the original stop cutoff requests containment |
| `contain(cause?)` | Immediate irreversible revocation, first failure retained, independent freeze and kill requests; does not wait for freeze or parent/peer RPC |
| `poll()` | At most one pending observation; repeated callers share its promise |
| `close()` | Idempotent owned-I/O join; native stalls may leave it pending |
| `snapshot()` | Frozen bounded metadata, no implicit clock sample or filesystem read |

There is no growing observation transcript. A stalled read retains one pending
observation; neither it nor a pending freeze prevents requesting kill. Closed
reports distinguish request state (`not_requested`, `pending`, `acknowledged`,
`unknown`), current observation, native-handle closure, pending I/O and first
failure. Reports contain no paths or native error text. Later observations may
show a group populated again; an earlier empty sample is not a permanent seal.

`createAcquisitionProcessSession` optionally accepts `host` with this profile.
Its operation/origin must match both actor contexts and its observation horizon
cannot extend their deadline. Each actor opens its own route before successful
initialization; peer/channel/controller failure invokes it locally before fault
notification. Late initialization cannot erase an already requested stop.
Host closure is joined before local ending/file receipts; host errors stay
visible. Reports then add `host`; without the option, existing calls, wire
shapes and reports retain their original domain. Record v1 does not change.

The process parent does not launch the external guard or an acquisition client.
The future bootstrap must separately place, launch and check that guard before
admitting client work. A process-session ready report alone does not establish
that guard, native resource enforcement or authority to acquire anything.

## External guard and observations

`runAcquisitionHostGuard(profile, {clock?, wait?, createController?, onArmed?})`
owns an independent loop. It opens the guard's own route, optionally issues one
trusted nonblocking armed notification, samples the original clock and cuts
waits at both absolute boundaries. It never waits for native observation work
inside that loop; at most one poll notification remains outstanding.
An armed notification reports opened capabilities/current state, not an
authenticated host, current lease or permission to start a client.

The returned `{observation, settled}` separates the frozen final wait-boundary
report from the promise joining owned native I/O. A late callback does not
rewrite the boundary report. Native reads/writes/closes can stall and keep a
process alive: neither a timer nor this API guarantees physical shutdown by
the horizon. Such a result remains incomplete; do not retire/reuse the actual
environment or infer disappearance from a finished JavaScript wait.

The explicit entry takes exactly a prepared profile file path and its
independently supplied SHA-256. The reader requires a non-symlink regular file
with one link, 1–32768 bytes, complete read, exact digest and canonical JSON
without duplicate/extra/normalized representations. It does not scan an
environment or obtain credentials. When IPC is available, the entry sends
`{phase: "armed"|"boundary", observation}`; callback completion is local
transport progress, not custody. Its clock loop does not depend on parent IPC
remaining connected. Caller-owned profile/report bytes require the publication
content check before later transmission.

All reports keep `externalClosure`, `clockAdmission` and `releaseAdmission`
`unqualified`. Empty/frozen samples, file closes and syntactically complete
records do not prove lifecycle operations resolved, no late start, helper or
channel closure, storage durability or complete process-tree termination.

Diagnostics are closed `HOST_*` codes defined by the profile owner. Native
messages/paths are not forwarded. Existing record/process input domains still
apply at their boundaries. This MJS is documented/tested, not statically
checked by the runtime TypeScript compiler.

## Evidence domain

The registered focused command exercises synthetic syscall/clock ports, owned
ordinary files and finite local actors. A separate finite guard with synthetic
native calls checks parent-channel loss; it is not native containment or
timing-sensitivity evidence. Real cgroup permissions, namespace/delegation,
platform integration, resources, clocks and custody need separately authorized
qualified controls. No setup or operational pilot follows from importing,
testing or merging this tooling.

The interface references are the
[cgroup v2 specification](https://docs.kernel.org/admin-guide/cgroup-v2.html)
and the pinned [Node 22.12 filesystem manual](https://nodejs.org/download/release/v22.12.0/docs/api/fs.html).
They describe interfaces, not an admitted operational kernel/tool combination.
