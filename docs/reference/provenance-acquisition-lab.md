# Experimental Linux acquisition laboratory

This retained experiment prepares and retires one private Docker laboratory,
optionally running one explicitly selected diagnostic case. It is contributor
tooling outside the browser distribution. Prepare-only creates no container,
image, FIFO or acquisition case. Neither mode requests a signature, upload,
package publication or deployment. Importing its modules performs no I/O.
Native use requires the separate authority and qualification in the
[release policy](../releases.md#qualify-mechanisms-before-claiming-readiness).

This reference is for a contributor inspecting preparation before a native
experiment. Read the lifecycle, then consult the input and evidence contracts.
The [activated attempt](provenance-acquisition-attempt.md#activated-composition)
owns the later capture/control/Start/placement/Exec order; preparation does not
change its reports or provide its operational admission.
The separate [diagnostic case contract](provenance-acquisition-lab-cases.md)
defines those inputs and the three-laboratory experiment that consumes them.

## Domain and process ownership

The narrow candidate is Linux x86-64, systemd255, a complete cgroup2/procfs view
in the initial observer PID/cgroup namespaces, and Docker29.9.1 with managed
containerd. Tools, clock view, privilege and bounded private scratch storage
must be independently admitted before use. Profile syntax, an archive filename
or a locally computed hash admits none of them. Free space is not reservation.
Resource values are required experiment inputs rather than performance thresholds.

The exterior custodian stays outside one uniquely named transient service.
The system manager runs a fixed keeper in `keeper` using
`DelegateSubgroup=keeper`; the delegated unit root contains no processes.
The keeper creates `work` and its `infra`, `case`, `supervisor`, `watchdog` and
`guard` children, launches one fixed worker, then only waits. The worker writes
`0` once to `work/infra/cgroup.procs` and verifies native membership before any
version probe or daemon. Daemon/containerd/helpers remain inside work. The
inner three-control protocol gains no extra actor role.

The candidate assumes trusted bootstrap/native tools and manager, with no
competing privileged creation, migration, path replacement or identity reuse
between first correlation and observation. It is not containment against
hostile root. The outer caller admits filesystem capacity and owns scratch,
evidence and host teardown. This owner does not install tools, disable stock
services, delete another socket, remove scratch recursively, unmount storage
or tear down a VM.

## Inputs and entry

`createAcquisitionLab(input,{io,clock?})` copies closed ordinary data before
selecting callbacks and binds I/O methods once. Construction reads no clock
and launches nothing. The native entry receives an explicit profile and its
independently expected SHA256; it never discovers configuration.

| Field | Closed domain |
| --- | --- |
| `context` | `{operationId,t0MonotonicNs,deadlineNs,sourceRevision}`; lowercase32hex token, decimal uint64 times, positive millisecond-aligned duration at most2147483647ms, lowercase40hex source identity |
| `roots` | Exactly `cgroup`, `proc`, `scratch`, `evidence`, `tools`, `pythonEnvironment`, each `{path,identity:{dev,ino}}`; expected distinct directories |
| `slice` | `{name:"system.slice",identity:{dev,ino}}` below the complete cgroup root |
| `tools` | Exactly `node`, `python`, `env`, `systemdRun`, `systemctl`, `busctl`, `journalctl`, `dockerd`, `containerd`, `shim`, `runc`; each `{path,realPath,identity:{dev,ino},bytes,sha256}` |
| `expected` | Exactly `node`, `python`, `dockerd`, `containerd`, `runc`, `systemd`; version expectations, with Python3.11.patch, Docker29.9.1 and systemd255 fixed to this recipe |
| `namespaces` | Exactly `pid`, `cgroup`, `time`, each an independently expected `{dev,ino}` |
| `limits` | Positive safe integer `prepareMs`, `retireMs`, `stopMs`, `pollMs`, `tasks`, `cpuPercent`, `observationBytes`; decimal safe uint64 `memoryBytes`, `swapBytes`, `storageBytes`, allowing zero only for swap |
| Optional `diagnostic` | Exactly `{path,sha256,case}`: absolute canonical plan path, independently expected hash and one of `A`, `B`, `C`; absent means prepare-only |

Device/inode values are canonical decimal uint64 strings with nonzero inode.
Paths are canonical absolute well-formed strings, exclude controls/backslashes,
and have at most4096 UTF8 bytes. Scratch/evidence/tool roots cannot contain
one another. Tool paths/identities cannot alias. The Docker files have fixed
basenames in the borrowed prefix. Python must use
`pythonEnvironment/bin/python` from the already prepared repository virtual
environment, without installation, repair or global fallback. Its resolved
executable is independently identified/hashed like the other tools. The
supplied source identity must match admitted source; its syntax does not verify
a checkout.

The canonical profile has at most32KiB. The derived private socket must fit
Linux's108-byte `sun_path`, including its terminating NUL. Observation capacity
is below Node's maximum Buffer length, independently per command channel and
record. Preparation plus retirement allowances fit the original whole budget;
poll/stop allowances fit their phases. The caller admits aggregate storage
separately: `storageBytes` records that bound, not a quota created by this process.

The separately authorized native command is:

```text
node scripts/provenance-acquisition-lab-entry.mjs prepare PROFILE_FILE EXPECTED_SHA256
```

`keeper` and `worker` are fixed internal roles consuming the exact exclusive
profile copy/hash. Native I/O needs exterior privileged cgroup control;
delegation to the service does not grant that exterior capability.

### Observing inputs without invented identities

`createLabInputCandidate(plan,{io?,clock?})` accepts an earlier, closed input
stage: the same expected paths, content hashes, versions and budgets, with no
T0, namespace identities or device/inode placeholders. `context` contains only
`operationId`, `deadlineNs` and `sourceRevision`; roots contain only `path`,
tools omit `identity`, and `slice` is the literal `system.slice`. Other fields
retain the profile domains above. It does not discover a tool or choose a
resource allowance.

Explicit `run()` samples one original monotonic T0, opens the presented roots
through retained routes, observes the slice and its own proc/ns identities,
and identifies the expected executable files. The presented proc view must
have one observer PID level. That is a consistency check, not proof of the
initial host view. Tool sizes/modes/identities are observed; their supplied
content hashes remain **pending verification by laboratory open**. No tool
bytes are hashed a second time merely to materialize this stage.

The caller must supply already protected scratch/evidence roots and admitted
tools/environment. Observation creates no directory, service, cgroup or
reservation. It publishes exclusive private `input.proc.*` originals,
`input-profile.json` and `input-report.json` below the existing evidence prefix.
The canonical profile has its own 32KiB limit; proc/report capacity remains
independent. The report binds the input-plan hash, observed process and profile
record. `collect()` is explicit and copies profile bytes only after local work
and handle cleanup succeed. Snapshots contain metadata and closed error codes.
Failure preserves originals already published and reports unpreserved records;
it never overwrites an earlier candidate. A late opening after revocation stays
owned until its one close settles. A bounded cleanup wait reports pending or
unknown rather than renewing permission.

`createLabBootstrap(plan,{inputIo?,labIo?,clock?})` composes that stage with the
existing laboratory prepare/retire owner. It selects laboratory I/O only after
successful input observation and cleanup. Both stages retain the first T0:
time spent observing consumes the original preparation allowance. No new
clock origin or retry is introduced. `stop()` blocks the next stage and
revokes a laboratory already started. The default native entries are explicit:

```text
node scripts/provenance-acquisition-lab-input-entry.mjs observe PLAN_FILE EXPECTED_PLAN_SHA256
node scripts/provenance-acquisition-lab-input-entry.mjs prepare PLAN_FILE EXPECTED_PLAN_SHA256
```

`observe` writes only the input candidate; `prepare` additionally invokes the
privileged prepare/retire recipe above, including one case only when the
input explicitly selects `diagnostic`. `observe` never runs a case. These
commands require their respective operational authority; import, valid input
or a local test provides none. `presentedViewAdmission`, `externalClosure`,
`clockAdmission` and `releaseAdmission` remain `unqualified`.

## Manager and daemon recipe

The custodian verifies roots/tool hashes, creates exclusive scratch/configuration
paths and issues one `systemd-run --system --wait --quiet` request. There is no
replace, restart, automatic collection or second registration. The service has
Type=exec, Delegate=yes, Restart=no, KillMode=control-group, TERM/final KILL,
finite start/stop/runtime limits, zero randomized runtime extra, CollectMode=inactive,
and explicit memory/swap/task/CPU limits. These are observed manager settings,
not measured physical bounds or guaranteed termination times.

The service starts an independently admitted [GNU `env -i`](https://www.gnu.org/software/coreutils/manual/html_node/env-invocation.html) helper before the
first Node, with only PATH/LANG/LC_ALL. Closing the CLI environment alone would
not close the [environment constructed by systemd](https://www.freedesktop.org/software/systemd/man/255/systemd.exec.html#Environment%20Variables%20in%20Spawned%20Processes). Type=exec initially
acknowledges `env`, so keeper/process/readiness correlation remains necessary.
This bootstrap depends on the admitted manager, loader and helper; it does not
defeat a hostile loader before `env` runs. Worker/tool children receive the same
closed environment, excluding inherited Docker/containerd overrides and contexts.

The worker requires `/run/containerd/containerd.sock` to be absent and refuses
stock adoption. It checks the published daemon JSON, validates it, then launches
one dockerd with private Unix socket, PID, data and exec roots. Configuration
selects cgroupfs/vfs and disables containerd-snapshotter, application bridge,
iptables/ip6tables, forwarding, masquerading and userland proxy. No TCP listener
or external containerd is selected. Exact version observations and bounded GETs
`/v1.56/version` and `/v1.56/info` supplement native correlation. There are no
mutating API requests or HTTP retries.

The examined [Moby managed supervisor](https://github.com/moby/moby/blob/b26fb77d3e7b01f9d21b89539c1ab428f5ca431f/daemon/internal/containerd/server/supervisor/remote_daemon.go)
defines private root/state/config/PID/gRPC/debug paths. The worker retains
generated v2 TOML and the admitted containerd's effective `config dump`; prepared
Python3.11 parses them with standard-library `tomllib`. Semantic checks reject
imports, proxy plugins, remote endpoints or unexpected root/state/socket routes
and require migrated ttrpc. The dump derives from an identified file/binary;
it is not a server configuration query. Actual executable/argv, parent, birth,
namespace, membership and socket observations corroborate it. Versions, managed
mode and absence of restart still require native qualification.

Bounded `busctl call` uses GetUnit and typed Properties.GetAll Unit/Service,
including the validated returned object path. Unit-before/Service/Unit-after
binds the same nonzero InvocationID and settings, without claiming an atomic
snapshot. Selected uint64 fields must be safe integers. Originals retain other
fields without admitting unsafe/sentinel numbers as policy. A failed/changed
manager binding cannot be reaccepted by a later favorable sample.

## Lifecycle and retirement

`run()` performs one preparation/readiness attempt, optionally one diagnostic,
then retires that environment;
it is not a server for arbitrary callers. Repeated run/close calls share their
original operation. `stop()` revokes work once. No late result restores permission.
Checks share one original monotonic history/cutoff; phase allowances cannot renew
it. Readiness requires correlated keeper, manager invocation, native groups,
worker/daemon/containerd birth/membership, profile and worker record. CLI0 or a
caller boolean provides none of those facts.

The selected diagnostic adds a closed exterior start record only after that
correlation. It binds the profile, copied diagnostic plan, case, exact ready
record hash and worker birth/proc identity. The verified worker accepts it once
and runs only that case. Preparation retains its first T0; the work phase then
uses the same whole cutoff minus the declared retirement reserve. The case's
complete allowance must still fit before that reserve. There is no fresh
laboratory allowance or arbitrary interior executor. An unchanged prepare-only
consumer never enters this phase.

The exterior binds the keeper record and actual manager/proc identities before
targeting the unit. Missing/ambiguous ownership leaves retirement unknown. A
late keeper checks the original cutoff before starting a worker/tool. The
manager runtime is an independent backstop if the custodian is lost.

Retirement revokes work and independently starts keeper freeze and work kill,
once each, before awaiting either. The keeper-frozen sample precedes the
work-empty sample while the preparer-owned work group remains stable. Originals
are saved outside the unit before normal whole-unit cgroup.kill. A failed or
bounded-out boundary does not suppress that exact owned final containment
request, but cannot establish successful retirement. Pending/failed writes are
never retried or silently settled.

After whole-unit kill the custodian observes waiter exit/close, same InvocationID,
no pending job/restart and actual failed service result. Forced SIGKILL remains
forced rather than normal program success. Original readback precedes
reset-failed of that exact registration. Scratch/configuration/evidence remain
with the caller. Local preservation is neither off-host custody nor durability
after teardown; the operational plan must admit that separate retention channel.
An unobserved pre-case worker entry remains unknown despite an earlier empty
work sample and final containment request; it blocks successful retirement.

At the original cutoff or cleanup wait, I/O may remain pending. The owner retains
it, blocks reuse and reports unknown. JavaScript cancellation does not settle
the system; there is no universal physical termination deadline.

## Originals and known prefixes

Ordinary originals are private exclusive files published without replacement.
Command stdout/stderr have independent logical reserves. The shared raw writer
owns short-write progress, submitted/confirmed counts and incremental hashes.
Preallocated length or a zero-filled tail cannot reveal written extent.
Snapshots contain metadata rather than payload copies.

The exterior launcher retains its settled terminal/capture metadata in the
`launcher` snapshot even if keeper/readiness evidence never appears. Preservation
selects `manager.wait.waiter.result.json` and independent bounded `.stdout` and
`.stderr` originals before requiring child evidence. A settled spawn failure
does not need a child close event. An observed empty channel is an empty original;
an unavailable channel stays missing. Each publication is attempted once under
the original retirement cutoff, retains its first error, and does not suppress
the other known originals, including already observed command/manager failures.
Normal retirement reuses that same original set.
These records neither bind a unit nor settle incomplete capture or retirement;
missing required child evidence still blocks complete preservation and collection.

Process originals use the process-role prefix and a lowercase reader-key suffix:
`statBefore` becomes `statbefore`, `statAfter` becomes `statafter`, while `status`
and `cgroup` keep their names. Their bytes and publication order are unchanged.
The process JSON retains the shared reader's original `sources` keys and their
byte counts/hashes; lowercasing a key locates its corresponding raw file.
If a later publication fails, earlier originals remain and the process JSON is
not published as though the complete set had been saved.

Completed worker commands publish result/capture metadata. The ready or partial
ending identifies worker originals and known command prefixes; the keeper
identifies the initial worker-launch prefix separately. The exterior verifies
their actual identities, capacities, confirmed counts and hashes. Missing or
substituted evidence blocks preservation/collection. A failed HTTP response
retains its bounded received prefix and failure metadata instead of dropping it.
Selected diagnostics publish an updated worker ending, bound to that same
ready/worker/plan, with the nine last-confirmed case prefixes. Exterior readback
also checks these originals. A partial preparation preserves the known subset;
missing objects cannot become a complete diagnostic. An unavailable producer
observation remains explicitly unavailable even for a zero-length prefix.

Forced retirement can interrupt a later daemon/worker-launch write. Only the
last recorded prefix is known; continuation/final EOF stay explicitly unknown.
`worker.retained.json` never describes these as complete captures.
`locallyPreserved`/`locallyComplete` cover this bounded preparation protocol and
identified originals, including recorded uncertainty. They do not claim complete
daemon output, physical closure, custody or release readiness. First cause and
cleanup failures remain separate closed codes, without native text or private
paths in diagnostics. Inspect originals before publication.

### Early startup diagnostics

If the exterior launcher has exited and closed before readiness and preparation
has failed, preservation requests one diagnostic collection. It does not run
without a launch, while that launcher remains pending, or after verified
readiness. The lifecycle has already attempted the authorized containment
sequence before preservation; diagnostics cannot delay its initiation or grant
a new target. Repeated preservation reuses the same collection, including its
failure or pending result, without another query.

`lab-startup.mjs` owns these unbound observations separately from the manager
observations used for ownership. It requests `GetUnit` for the generated service,
then `GetAll` Unit and Service using the returned typed object path. Unit `Id`
must match before requesting Service. These three raw observations are not an
atomic snapshot or a matching-properties/invocation proof. A missing unit or
invalid reply stops that sequence without preventing the independent journal
request. No diagnostic result updates ownership or weakens its checks.

The identified `journalctl` receives exactly:

```text
--system --boot --unit=tabgrad-lab-OPERATION.service --no-pager --no-tail --output=json
--output-fields=MESSAGE,PRIORITY,SYSLOG_IDENTIFIER,_PID,_SYSTEMD_UNIT,_SYSTEMD_INVOCATION_ID,UNIT,OBJECT_SYSTEMD_UNIT,COREDUMP_UNIT
```

`OPERATION` is the profile's lowercase32hex operation, never a pattern or caller
query. The fixed current-boot/unit selection can include system-manager and
coredump messages about that service. It is not the program's raw stdout/stderr
or proof of their producer. JSON also includes the format's mandatory cursor,
realtime/monotonic timestamps and boot ID. The reader's default long-field
omission remains in effect; `null`, arrays or a byte-cut JSON prefix are retained
as received, without interpreting them as complete program text. There is no
follow, pager, broad fallback, other host, synchronization request or retry.
An empty, inaccessible, truncated or late answer remains inconclusive.

The four possible commands reuse the command/file owners, with labels
`startup.path`, `.unit`, `.service`, `.journal`, bounded separate channel files,
and each settled command's `.result.json`. `startup.json` records a settled
collection's selection, statuses and command metadata. The returned
`startupDiagnostics` snapshot also identifies known commands/prefixes when a
query or publication remains pending. It contains no channel payload. A query
not started at the original cutoff differs from an initiated operation whose
result is unknown. Late completion cannot start further reads or publish past
the original retirement gate. The caller retains responsibility for pending
native resources and physical host closure.

Known launcher/failure originals are saved independently of this collection;
failed or pending diagnostics cannot suppress them or replace the first
preparation cause. A failed diagnostic command still retains available capture
and terminal metadata; a failed publication remains unpreserved. No incomplete
collection becomes readiness or successful retirement. The maximum additional
logical reservation is thirteen observation capacities: two channels plus one
result record for each of four commands, and one collection record. The caller
must include that maximum within the already admitted aggregate storage,
alongside other originals; a per-channel bound alone does not admit that total
or reserve physical space. No extra storage or time allowance is created.

The reader is an external systemd255 tool, independently admitted and identified
like the other executables; this module does not discover, install or upgrade
it. Its [upstream source](https://github.com/systemd/systemd/blob/v255/src/journal/journalctl.c)
is LGPL-2.1-or-later. Tabgrad invokes the supplied executable and redistributes
no systemd source or binary. The laboratory maintainer owns its identity,
compatible invocation and security-updated host admission. The
[systemd255 journal contract](https://www.freedesktop.org/software/systemd/man/255/journalctl.html)
defines selection/encoding; actual availability, effective access and usefulness
need native evidence rather than finite controls. Message contents can include
private process/path context and remain in the admitted private custody; only
inspected safe derivatives may be published.

The [accepted diagnostic method](https://github.com/isaacperez/tabgrad/issues/314#issuecomment-6474885574)
keeps the service's existing descriptors. Direct `--pipe` forwarding would share
writers with the launcher and require separate pending-prefix/cancellation
qualification. Service-directed files have their own extent/identity/cutoff
obligations; launcher verbosity or manager status alone need not contain the
program's error. The targeted reader avoids that descriptor coupling at the
cost of an admitted tool and private data source. This choice does not promise
the earliest error, a native fix, complete diagnostics or producer authentication.
Reconsider it if the identified reader cannot provide useful bounded observations
under these constraints; do not silently switch capture methods.

## Organization and controls

`lab-profile` owns inputs/recipes, `lab-manager` typed D-Bus projection, and
`lab-daemon` the specific configuration/API checks. `lab-startup` owns unbound
early-failure observations through the shared command/file owners. `lab-command` owns children,
bounded streams and once-only handle close; `lab-files` owns exclusive originals,
tool identity and readback. `lab-kernel` owns retained native routes and three
retirement targets. `lab-io` composes them for exterior/keeper/worker; `lab` owns
exterior lifecycle/cutoffs, and `lab-entry` selects fixed explicit roles.
`lab-input` observes expected inputs into an identified candidate;
`lab-bootstrap` composes it with preparation without rebasing time.
The existing path/process observer and payload writer remain shared; placement
preserves its policy, ordering and error family.

Finite controls cover closed inputs, exact arguments, typed/native mismatches,
self-entry, stock refusal, configuration/API originals, late ownership,
independent freeze/kill, unknown cleanup, forced results, separate worker evidence,
prefix loss and HTTP reset. They use ordinary files and finite Node children,
plus TOML parsing in prepared Python. They never probe host cgroups/procfs, start
systemd/Docker, prepare containers/FIFO, sign or publish. MJS is dynamically
tested outside runtime TypeScript; Python helper/tests are in Ruff/Pyright
discovery. All `externalClosure`, `clockAdmission` and `releaseAdmission` flags
remain `unqualified`; native qualification needs a separately authorized run.
