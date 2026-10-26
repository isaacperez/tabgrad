# Experimental local acquisition attempt

This retained internal caller composes [three-control startup](provenance-acquisition-startup.md)
with [separated program capture](provenance-acquisition-capture-attempt.md).
It owns their local execution and join, without another parser, writer,
supervisor, client or container. Construction/import performs no I/O. It is
outside the browser package and changes no tensor or release behavior.

## Entry and ownership

`createAcquisitionAttempt(captureInput,{startup,clock?,files?,fifo?,request?})`
takes the existing closed six-field capture input and an owned, unstarted
startup object. The latter retains its four record writers and three controls;
capture retains its five files, FIFO readers/sentinels and borrowed Exec.
The original daemon-only `createAcquisitionExec` entry remains independent.

Operation, original origin, root and allowed cutoff match through the capture
profile's existing validation. Startup callbacks are bound before effects;
later method replacement cannot redirect the operation. Optional ports are
trusted finite-test boundaries, not plugins, qualified tools or a native lab.
Original caller input is copied once. Capture's passive `timing` getter returns
that frozen timing copy for the caller's bounds/polling; it neither samples a
clock nor rereads the input. Mutation after construction changes neither recipe
nor limits. One accepted clock history spans preparation, gate and cleanup.

The preparer still admits all files/namespace mappings, tools, host placement,
resource policy, physical reservation and actual clock correlation. This
caller establishes none of those premises and performs no discovery/setup.

## Calls, ordering and failures

`open()` prepares capture only and publishes one promise before callbacks.
Repeated calls share it. A failed preparation returns its failed local state
without waiting for global join; otherwise a run waiting on preparation could
prevent its own cleanup. `run({observedUtc})` prepares if necessary, starts the
existing controls, checks their actual permission, then runs capture. The
explicit UTC must use the existing record domain and is forwarded to finish;
pre-run failure uses startup's existing diagnostic current-UTC convention.

Run publishes its promise before invoking callbacks; repeats share it without
another start or Exec. It does not infer permission from startup's start return
alone. The actual acknowledged client intent still precedes every daemon
request through the existing capture/Exec owner.

On the successful path capture must finish, including its final permission,
clock and owned-close checks, **before** `startup.finish()`. Finish revokes
permission synchronously, so overlapping these phases could incorrectly fail
a valid capture. Failure/stop instead revoke both owners promptly, starting
their cleanup without waiting for successful capture. `stop()` is synchronous
and idempotent; first failure and a separate cleanup error remain visible.
Reentrant cancellation or late startup/ACK cannot reenter work admission.

Closing joins capture and startup's original finish/collection. Its local wait
is bounded by the earlier of the original operation cutoff and the existing
cleanup allowance from the last accepted observation. It never resets T0,
extends authorization or shortens the guard's own observation/termination
policy. Clock regression, unavailable time or expiry excludes success. The
original clock/cutoff is checked after the final owned await too; normal finish
does not demand permission that it deliberately revoked.

`join()` observes the same local close-wait result without starting work.
Expired waits may leave admitted native/borrowed work pending; their owners
remain retained. Later completions update fresh observations without changing
previous snapshots or restoring failed/expired success. A resolved run/join
does not prove physical shutdown or storage durability.

## Results and limits

Passive frozen snapshots expose `capture` and `controls` current observations,
the original `captureResult`/`controlsResult` once returned, opening/work/control
close pending state, elapsed observation, first failure, cleanup error and
`cleanupWaitExpired`. The original bounded record parts are retained without
reencoding; no unbounded history or repeated payload copy is introduced.

`localComplete` requires successful capture, completed startup/record collection,
no owner failure and completed local work within the original wait. Record
format completeness is distinct from truth: this caller never populates
supervisor/watchdog facts from capture or upgrades their unknown/not-run values.
All original component diagnostics remain in their own reports. Aggregate
`ACQ_ATTEMPT_*` diagnostics distinguish input, protocol, permission, clock,
deadline, stop, capture, controls and cleanup failure without native messages.

`otherInputSeparation`, `payloadOrigin`, `externalClosure`, `clockAdmission`
and `releaseAdmission` remain `unqualified`. There is no added physical host
observer, validation, readonly conversion, custody, TUF/client acquisition,
CI signing, publication or release admission.

Finite tests exercise the actual startup/process/capture/FIFO/Exec owners with
ordinary files and a local Unix peer. Fixed child host syscalls and FIFO ports
are synthetic; separate finite startup ports hold or fail selected boundaries.
They verify original bytes, ordering, copied limits, cancellation/reentry,
uncertain closure and late facts. MJS is dynamically tested outside runtime
TypeScript; these controls establish no physical isolation, scheduling/RSS,
throughput, durability or real-service qualification. Native use requires the
separate authority and qualification in the [release policy](../releases.md#qualify-mechanisms-before-claiming-readiness).
