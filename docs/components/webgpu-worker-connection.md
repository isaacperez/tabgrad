# The managed WebGPU connection

An ordinary Python call can only return a tensor's numbers once those numbers
exist. In a browser, however, GPU submission and readback complete through
asynchronous JavaScript callbacks. If Python blocks the same worker that must
run those callbacks, both sides wait for each other. The connection described
here places physical GPU work in an independent worker while keeping Python
and tensor semantics together.

This chapter is for contributors extending or diagnosing managed WebGPU
execution. It explains the concrete ownership boundary, not a new tensor
engine or a general worker framework. The
[integration architecture](../architecture/webgpu-integration.md) owns the
accepted placement and setup decision; the
[host reference](../reference/python-host.md) owns application-facing signatures.
The [physical backend](webgpu-backend.md) continues to own GPU numerical work.

## Separate the two connections

A managed application has two different reasons to communicate across workers.
The host needs to submit a Python script and learn when that script finishes.
Separately, the interpreter-local runtime needs to prepare and execute a finite
GPU program and obtain its result. These responsibilities have different
payloads, owners and failure meanings.

The [Python worker connection](python-worker-connection.md) carries scripts and
entry completion. The WebGPU connection carries backend programs, invocation
bindings, allocation identities and requested readback. It does not carry
remote `torch` calls or Python tensor wrappers. Tensor creation, shape
validation, derivative-history admission and program formation remain in the
interpreter's shared semantic runtime.

A **controller** is the host-held owner of the physical worker. A **connection**
is the single-use bundle passed to one Python binding. A **generation** denotes
that backend context's lifetime; retiring it permanently stops GPU admission
and publication. These names describe distinct ownership, not three workers.

The map shows ownership and communication. The supervision route belongs to
the host, so it can revoke GPU availability even while the interpreter is
parked. A port message is a delivery hint; shared state is the authority used
by the blocked consumer.

```mermaid
flowchart TB
    Host[Application host] -->|Owns| Interpreter[Interpreter worker and Pyodide]
    Host -->|Retains| Controller[GPU controller]
    Host <-->|Scripts and entry completion| Binding[Python binding]
    Interpreter --> Binding
    Binding -->|Owns| Runtime[Shared semantic runtime]
    Runtime --> CPU[Local CPU backend]
    Runtime --> Connected[Connected GPU backend]
    Controller -->|Owns| Physical[Physical GPU worker]
    Connected <-->|Finite work and shared results| Physical
    Controller -->|Independent retirement and wakeup| Connected
    Physical --> GPU[Existing WebGPU backend and device]
```

The physical worker is not another `RuntimeSession`. Moving execution there
does not create a competing operation registry, graph planner or
materialization policy. The connected backend implements the same physical
execution contract as the local backend used by direct JavaScript.

## Setup establishes one owner before work is admitted

`createWebGpuWorker` constructs the packaged worker, acquires its browser device
and waits for its capability snapshot. Device readiness does not evaluate an
expression or compile every possible pipeline. Program-specific preparation
stays with the physical backend and is performed on demand.

The returned controller remains in the host. Its transferable connection is
claimed atomically when `attachPython` begins, before interpreter validation,
asset loading or installation can fail. A second attachment cannot consume
that connection, including through a structured clone that shares its control
storage. A losing claimant does not retire the winner. A claimant that later
fails retires its own connection; retry requires a fresh owner, not reusing
the consumed bundle.

Attachment checks that the consuming execution environment permits
`Atomics.wait`. A page-owned interpreter cannot use this worker-wait profile.
Rejecting it before installation and numerical admission prevents a binding
that appears usable but deadlocks on its first observation. Attachment still
borrows Pyodide: neither failure nor close destroys host globals or the
interpreter.

Worker-construction failure releases locally created channel endpoints.
Cancellation during acquisition rejects setup promptly, but the controller
keeps ownership until late acquisition and cleanup are accounted for. It
does not terminate a still-acquiring producer and call that successful drain.
The host must likewise close a ready controller whose connection it never
consumes or cannot transfer.

## Send finite execution, not one message per tensor operation

The runtime first forms a demanded executable program and selects fresh
invocation bindings and retention obligations. The connected backend sends
that complete execution request to the physical worker. The worker reconstructs
the program and invokes the existing backend's preparation and execution
methods. A chain with many operations can therefore cross this boundary as
one finite program rather than many semantic remote calls.

The current numerical payload domain is contiguous float32. Host input bytes
are copied before transfer so sending them cannot detach storage still owned
by the semantic runtime. Resident bindings instead use opaque allocation
identities belonging to this connection. Resident results and aliases retain
those identities; they do not read intermediate tensors back into Python.
An observation separately requests the demanded result's host bytes.

The invocation owns its program definition. Neither endpoint stages the last
full program between requests or retains it merely because an allocation
remains resident. The physical backend may reuse its prepared pipeline, which
is different from keeping a completed invocation's graph and bindings alive.
Adding a supported computation extends the existing admission, lowering and
backend owners, not a Python-specific operation list in the transport.

This private wire representation is not a public extension interface. Its
encoding may change together with both endpoints while preserving the
capability, lifetime and observation contracts. Its float32 specialization
does not imply that arbitrary data types are already supported.

## Shared completion separates publication from physical drain

Each accepted physical request owns a bounded completion record. It contains
fixed control fields, bounded failure diagnostics and a payload sized to the
requested result. It is not a global queue of completed tensor data. The
producer writes bytes and then atomically publishes their status. A shared
pulse wakes the consumer; the consumer reads that pulse before checking status
so publication between inspection and waiting cannot be missed.

A successful result is published after the physical ticket drains. Python can
then consume it and retire the request without running interpreter-local
callbacks. Failure is different: the producer can publish an error while
submitted work, staging or mapping still has obligations. The request reports
the error promptly, but its semantic pins remain until drain or explicit
terminal loss accounting.

The sequence follows one ordinary observation. Preparation and submission
callbacks run in the physical worker, which stays active while Python waits.
The runtime request resumes its existing steps rather than starting a second
calculation.

```mermaid
sequenceDiagram
    participant Python as Python frontend
    participant Runtime as Interpreter-local runtime
    participant Connection as Connected backend
    participant Producer as Physical GPU worker
    Python->>Runtime: request ordinary observation
    Runtime->>Connection: execute formed program and bindings
    Connection->>Producer: finite execution request
    Runtime->>Connection: consume shared ticket
    Connection->>Connection: inspect state and park interpreter
    Producer->>Producer: prepare, submit and drain GPU work
    Producer-->>Connection: publish allocation identities and wake
    Connection-->>Runtime: resume the same execution request
    Runtime->>Connection: request result readback
    Connection->>Producer: read resident allocation
    Producer->>Producer: copy, map and retire staging
    Producer-->>Connection: publish host bytes and wake
    Connection-->>Runtime: return independent observed bytes
    Runtime-->>Python: convert to ordinary Python containers
```

Promise observers are optional notification mechanisms over that same state.
The connection creates them only when an asynchronous consumer requests one.
Ordinary synchronous observation does not enqueue unused Promise reactions
that retain its result until Python returns to JavaScript.

The failure path needs the same discipline. Python may catch an error and
continue within one uninterrupted entry. Physical drain can finish meanwhile,
but local port callbacks still cannot run. The connected backend therefore
checks outstanding shared records at subsequent synchronous backend
checkpoints. Drain listeners retire the corresponding request pins directly,
without requiring Promise reactions. Completed records leave the pending set
before semantic retirement can trigger a nested allocation release. Work
whose drain is still outstanding remains owned; the check is not an early
release policy.

## Preserve progress with selective drain inspection

An observed failure can remain physically live across later observations. Its
resources must remain owned, but its unchanged drain state does not need to be
read on every checkpoint. The accepted
[progress decision](https://github.com/isaacperez/tabgrad/issues/211#issuecomment-6078519433)
uses shared notification for those failures and a consumer index that preserves
the original order of progress. The
[research evidence](https://github.com/isaacperez/tabgrad/issues/211#issuecomment-6078192180)
records the alternatives, controlled publication schedules and independent
challenge. This decision refines inspection work within the existing connection;
shared result and drain fields remain authoritative.

A completion joins the notification directory only after its error has been
observed while drain is still outstanding. The consumer sends a private drain
subscription with the request identity, completion record and shared notification
path. Until acknowledgment is visible in shared state, the consumer continues
inspecting that completion directly. The physical worker installs the path on
its live request and acknowledges it. A subscription arriving after completion
still receives a hint and acknowledgment, without creating completed-request
history or fabricating physical drain.

The producer marks the path before and after publishing a changed shared record.
A distinct publication-in-progress bit lets the consumer retain an inspection
obligation after claiming a hint during publication. That obligation persists
until a refresh starts with publication no longer in progress, or the completion
retires. A hint nominates a record for inspection; it cannot replace the shared
status, bounded diagnostic or drain field. Acknowledgment and publication state
use separate bits, so installing a subscription cannot accidentally claim that
physical work finished. Port delivery remains optional for blocked consumers.

The consumer maintains one balanced index of live admissions, augmented by
counts of entries eligible for inspection. Unresolved results, unacknowledged subscriptions, changed
records and publications in progress remain eligible. Each checkpoint keeps an
admission cursor rather than copying the candidates of its ancestors. Eligibility
survives nested checkpoints until the outermost pass finishes. A checkpoint
collects newly published hints after semantic callbacks and considers them in
admission order; an earlier admission already passed by its cursor belongs to
another checkpoint. Retirement removes transport ownership before invoking
semantic callbacks, preserving nested release and exactly-once cleanup.

Request identities are private to this connection. The worker's lookup retains
only live accepted work and removes it on settlement. Notification branches and
index nodes are removed with their current owners. Identity exhaustion,
subscription failure or notification allocation failure must preserve direct
inspection and the original observed error rather than introduce an admission
limit or lose cleanup. Terminal generation or accounting changes make every
live obligation eligible and preserve the original ordered shared-state
inspection, including truthful unknown physical completion.

Ordinary successful requests allocate no notification path and perform no
notification-marking atomics. They still pay for live request identity and lookup
bookkeeping. The first undrained failure constructs the consumer index in
O(L log L) work for L live admissions; selection, activation and retirement use
O(log L) index operations. Shared notification paths add allocation and atomic
work for enrolled failures. These costs are additional to necessary result
inspection and physical ownership; fewer completion visits do not measure total
execution time or process memory.

Full scanning preserves behavior but repeats unchanged inspection. A shared
pulse can skip a checkpoint with no publication, yet a new request's publication
still forces it to inspect older unchanged failures. Enrolling every request
avoids subscriptions but charges ordinary success for notification allocation
and marking. A shared queue of changed identities is another possible design;
its capacity, reuse, publication and nested-progress contracts require their own
qualification. The accepted lazy directory and active-admission index have
specific preservation evidence; the decision does not establish optimality.

The controlled Node-worker prototype reduces completion visits without changing
the recorded outcomes and cleanup. Its qualified ordinary one-float,
128-observation timing cohort adds a median 3.826 microseconds per observation;
the other three cohorts have unresolved measurement sensitivity. This accepted
tradeoff establishes neither negligible overhead nor a general latency budget.
Physical-GPU failure frequency, browser/Pyodide latency, process memory and
whole-model impact remain outside those measurements. Reconsider the mechanism
if representative evidence shows unacceptable ordinary cost, a simpler
preserving notification mechanism, lost progress or retention beyond live work.


The pending-completion owner keeps one changed flag per live admission, rather
than a growing change counter. Its active index belongs to the consumer;
shared notification words and publication flags belong to the paired endpoints.
The notification directory prunes retired paths. Request lookup in the physical
worker ends with its existing finite work promise, and late subscriptions only
hint and acknowledge existing shared state. None of these private records is a
public operation, a physical completion authority or a completed-request cache.

## Supervision is independent; reclamation is not guessed

Controller close or lifetime abort retires the generation and wakes observers
from outside the interpreter. New GPU work is rejected, and an already parked
observer reports failure instead of accepting stale success. Independent CPU
work keeps its own semantics. This revocation does not report that a Python
script or binding has closed gracefully.

The physical worker joins accepted preparation and work before closing its
backend. A graceful acknowledgement allows the controller to release its
worker and channel ownership. Repeated close shares the same result. The
Python binding's cooperative close joins the script and session before
retiring its installation; the controller's revocation is a separate lifetime
action.

An observed worker failure without acknowledgement is explicitly accounted as
unknown physical completion. It wakes waiters, but does not manufacture zero
GPU usage. Diagnostics retain the producer's last known owned and pending
counters and mark those owned obligations as unknown. Those snapshots are not
the hardware's exact live VRAM, and cannot include bytes the producer never
had an opportunity to report. The host must report known interpreter
termination by revoking its controller as well as its script connection.
Silent hangs and loss of the supervisor itself are not automatically detected.

Physical error transport preserves the error code, message, bounded scalar
locators such as backend, phase and program slot, and the immediate native
cause's name and message. The consumer reconstructs a diagnostic cause rather
than retaining the original exception identity. It does not transfer a live
exception, nested cause graph, arbitrary object fields, complete program or remote stack.
Truncation is explicit. The semantic runtime can attach its own invocation
context to the received diagnostic. Applications must not infer cross-realm
exception identity from that information.

Setup uses the same bounded diagnostic projection. A worker acquisition failure
rejects `createWebGpuWorker` with the host's `BACKEND_LOAD_FAILED` classification
and `worker-setup` phase. Its diagnostic cause preserves the acquisition
error's code, message and phase, with the immediate native cause beneath it
when readable. Missing WebGPU and a missing adapter therefore remain
distinguishable from rejected adapter or device acquisition. Unreadable
diagnostic properties cannot replace the primary rejection or stop cleanup;
truncation is explicit, and short locators are preserved while larger text
is reduced to fit the fixed budget. Receiving this diagnostic is not a cleanup
acknowledgment: only the separate closure/loss protocol accounts for physical
completion.

## Costs and qualification boundaries

Program transfer scales with the selected definition and required host
bindings, not every operation ever recorded in the session. Result storage
scales with demanded output, and resident identity maps scale with live owned
allocations. Pending completion records scale with accepted, not-yet-retired
work. Completed observation history is not a transport cache. A request that
is still physically draining remains part of that live set even after its
logical error is delivered.

Readback needs shared result storage and an independently owned host array;
Python list conversion adds interpreter-side containers and numeric objects.
These are real linear costs in output length, not free consequences of shared
memory. GPU counters describe device-owned buffers and boundary bytes, not
total browser memory, garbage-collector retention or process RSS. Quantitative
claims require the separate [performance procedure](../performance.md),
including an adequate representative workload and declared limits.

The [managed GPU browser check](../../scripts/run-python-webgpu-tests.mjs)
qualifies ordinary observation without JSPI, numerical transport, competing
attachment, independent revocation before delayed acknowledgement and rejected
placement. Separate profiles exercise deliberate device destruction, physical
worker failure and host-reported interpreter termination, including truthful
unknown-completion accounting and alias lifetime. The test-only acknowledgement
gate follows real GPU queue completion; it controls publication timing, not
natural pending-hardware behavior, acquisition or arithmetic. Controlled unit
tests supplement those integrated failure boundaries. Named qualification does not
establish universal browser support or whole-model throughput.
