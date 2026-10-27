# Experimental acquisition startup

This internal retained experiment composes the [process session](provenance-acquisition-process.md)
and [Linux host controls](provenance-acquisition-host.md). It launches three
fixed trusted Node entries over independently identified, already prepared
groups and files. It runs no acquisition client and configures no infrastructure.
Importing these modules performs no launch or native group operation.

The bootstrap must supply admitted ownership, delegation, permissions, initial
placement outside the case, clock/origin, hierarchy and resource policy. Those
premises are not established by a profile, IPC message or synthetic test.
Native execution requires separate authority and qualification under the
[release policy](../releases.md#qualify-mechanisms-before-claiming-readiness).

## Owners and entry

`provenance-acquisition-host-io.mjs` retains native identity, file and entry
ownership. Its explicit `enterAcquisitionHost(profile, role, {port?, clock?})`
opens the same identified prepared routes as the open-only operation. It also
opens the own role's `cgroup.procs` for writing, checks it matches the retained
read identity, and writes exactly one byte `0` once at position zero. This
targets the writer's process, never a supplied foreign PID. It then checks its
actual membership and the original clock before returning the route.

Entry is trusted initialization before any case, never migration after work
admission. Destination/common-ancestor permissions and Linux delegation still
apply. A failed or partial write is `HOST_ENTRY`, with an unknown effect and
no retry or rollback. Entry evidence distinguishes `not_requested`, `pending`,
`acknowledged`, `verified` and `unknown`; only `unknown` has `error: HOST_ENTRY`.
A successful write alone is not verified membership. Failure retains entry
state separately from handle-close uncertainty, including late successful
entry followed by clock failure. Existing `openAcquisitionHost` does not enter
or add entry fields to reports.

Node has already started before self-entry. Earlier memory charges need
separate observation; migration does not move them to the role budget. Direct
native birth in a group would require a different admitted launcher. This
adapter promises neither birth-time resource accounting nor physical shutdown.
See [Linux process organization and delegation](https://docs.kernel.org/admin-guide/cgroup-v2.html)
and the [examined zero/thread-group dispatch](https://github.com/torvalds/linux/blob/v6.18/kernel/cgroup/cgroup.c).
These sources explain the mechanism, not a qualified kernel/environment.

`createEnteringAcquisitionHostController` composes explicit entry with the
existing controller. The process owner's `createEnteringAcquisitionProcessSession`
requires a host profile and selects the fixed `provenance-acquisition-startup-actor.mjs`
entry; the original process factory keeps its open-only/default behavior.
Neither factory accepts an arbitrary native executable. Injected launch or
syscall factories remain trusted test boundaries.

## Creation and local permission

`await createAcquisitionStartup({process, guardProfile}, {forkActor?, forkGuard?})`
validates and copies inputs without launching or opening native cgroups:

- `process` has the exact host-bound process-session domain, including its
  independent contexts, header expectations, owned file identities and timing.
- `guardProfile` is exactly `{path, sha256}`. The existing bounded profile-file
  reader checks the original canonical bytes against that independent digest;
  the parsed profile must also equal the process host expectation. Field order
  in that expectation does not change its meaning.
- The remaining observation horizon plus cleanup wait must fit Node's signed
  32-bit timer range. The original origin, stop and observation cutoffs are not
  renewed. The process context's deadline remains separately governing.

`start()` first launches the fixed guard with empty environment/exec arguments,
explicit profile arguments and JSON IPC. An armed notification is insufficient:
the parent requires a completed usable observation and verified entry. It then
starts the existing supervisor/watchdog session and requires all three controls
to have observed an initially empty, unfrozen case before local admission.
Later populated samples are not a permanent-seal violation by themselves.
The calling bootstrap remains responsible for all other prerequisites.

The returned object provides `start()`, `supervisor.append(progress)`,
`stop(actor?, code?)`, `finish({observedUtc})` and `snapshot()`. Snapshot has no
implicit clock or file read. Append explicitly checks the original clock and
the composed local gate, then delegates record policy to the process session.
Invalid/repeated startup, partial launch, protocol/channel/peer failure or
deadline irreversibly excludes work. First failure is retained; late replies
cannot restore admission. Finish revokes synchronously and returns the same
promise on repeated calls. A local ready state is observed metadata, never an
authenticated host, current physical lease or authority to run a client.

Its immutable `context` is the process owner's copied operation, origin,
original operation cutoff and root. This cutoff differs from the host's
earlier work-admission cutoff and guard horizon. The separate
[Exec adapter](provenance-acquisition-exec.md) uses that binding and observed
permission; startup itself makes no Docker request or data-provenance claim.
The passive frozen `caseBinding` exposes the root and case component identities
from the validated host profile, so an activated caller can reject a different
placement route before effects. It performs no observation or I/O.
The [local acquisition caller](provenance-acquisition-attempt.md) joins startup
with separated program capture, completing capture's final permission check
before normal finish revokes it.

## Guard channel and lifetime

`provenance-acquisition-startup-protocol.mjs` owns canonical JSON strings within
the existing process message byte limit. Guard messages have exactly `version: 1`,
`profileSha256`, positive safe-integer `pid`, positive decimal uint64 `sequence`,
`phase` and the closed guard `report` including entry evidence. Phases are
`armed`, `observation`, `boundary`, `settled` and opening `failed`. The parent
checks its owned PID, independent digest/operation, increasing sequence,
phase order and monotonic report evidence. A send callback acknowledges no
receiver admission or custody. Stop messages contain exactly `version: 1`,
`operationId` and an existing process cause `code`; malformed input revokes.

The fixed startup guard entry uses the shared independent deadline loop, with
at most one poll and one ordinary notification in flight. Intermediate samples
may be skipped while a send is pending; no growing history is retained.
Boundary and settled receipts are distinct. Parent loss or stop requests
containment directly, retaining the original observation horizon; it does not
cancel that loop. A late native callback does not rewrite the frozen boundary.

The startup owner finishes the record session separately and waits for the
guard. It does not signal that guard before its original observation horizon;
owned-handle TERM/KILL requests and the local close-wait budget follow that
horizon. This join allowance does not extend work admission or the guard's
native observation horizon, and is not an external physical deadline.
Exit, channel loss, close, a settled receipt and native I/O closure are separate
observations. Missing receipts/close or pending I/O stay uncertain; a signal
request is not proof of termination. `finish` adds the original process parts
and their collection uncertainty rather than reconstructing missing bytes.

All reports retain `externalClosure`, `clockAdmission` and `releaseAdmission`
as `unqualified`. The finite local processes and synthetic syscall controls
test composition, failure and ownership. They establish no Linux admission,
resource sensitivity, custody, CI protection, signature or release capability.
