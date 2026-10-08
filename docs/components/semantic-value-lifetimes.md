# Semantic value lifetimes

A tensor can remain useful after the calculation that produced it has finished.
Keeping its numbers does not require keeping every earlier calculation alive.
Conversely, closing an input handle cannot discard numbers that a pending
calculation still needs. This chapter explains how the semantic lifetime owner
in [`src/runtime/runtime.ts`](../../src/runtime/runtime.ts) preserves both requirements. It is
for contributors changing execution or frontend ownership, rather than a guide
to calling the public tensor API.

The [semantic architecture](../architecture/semantic-state.md) distinguishes a
public tensor identity, a logical value and its physical storage. Here those
roles are represented by a public exposure's `TensorState`, its independently
owned `TensorIdentity`, a mutable numerical `TensorFamily`,
captured `TensorValue` metadata and a shared `StorageState`. The private
`tensor-family.ts` and `tensor-value.ts` separate semantic identity from captured
numbers. Numeric descriptors retain only a shared version counter, not a family
or its newer current value. The session's `MaterializationTable` keys
host or resident data by storage identity. Its backend allocation has a separate
release obligation.

## Who keeps a value alive?

The session accounts for one current numeric pin per live alias family (F),
each pure input occurrence or saved operand (R), and each accepted observation
or mandatory effect capture (Q). Multiple views share F; they do not add
independent numeric current pins. Captured values independently retain storage.
Payload-free writer outcomes (C) are separate control owners. A [history pin](derivative-history.md) protects the same logical value
and storage while owning no physical allocation. An
operation may consume the same input more than once; each input position owns
its corresponding reference. Releasing a handle ends only that handle's
ownership. The result of a lazy operation can therefore outlive its input
handles without losing the inputs it needs to compute.

A numerical descriptor gaining its first owner captures only pending or failed
writer outcomes. Successful publication is terminal and does not need a new
control reference. An already-owned descriptor keeps its acquired snapshot
until release, even if a writer completes meanwhile; retention and release
must traverse the same snapshot. Pending-only snapshots retain their reuse.
A delivered failure still belongs to subsequent captures: delivering its error
responsibility does not turn the captured failure into success.

An `OperationRecord` is an immutable description of admitted numerical work,
including its input values and definition. Shared storage's link to that producer is an owning
edge, not a permanent historical archive. The session removes the link when the
producer is no longer needed for execution. Neither removing that edge nor
releasing a handle changes the logical value's metadata or numerical meaning.

For example, consider a chain whose intermediate handles are closed while its
final result is still pending. Before execution, producer edges keep the chain
usable. After successful execution has installed the resident materializations,
those edges are released. An intermediate with another open handle retains its
own stored result. An intermediate with no remaining owner releases any
materialization it has; execution can also reclaim private scratch before
publishing survivors, as described in [CPU invocation storage](cpu-invocation-storage.md).
The final result does not retain the completed upstream chain.

## Releasing an owner must release its references

Dependency release first detaches the producer and then releases each input
reference. This makes repeated release a no-op and keeps operation-record
accounting aligned with the records still owned by values. The immutable record
itself is not rewritten. When the final value reference disappears, the session
removes that value from its live set. Only the final shared-storage reference
releases its materialization and pending producer inputs.

This ordering matters even if an application retains a closed tensor handle.
The handle can still reach its value object, but that object must not keep a
released producer chain alive. Removing entries from a live-value table alone
would not remove references held by other JavaScript objects.

A pending graph can be much deeper than the JavaScript call stack. The session
therefore follows final-owner release with an explicit worklist rather than
recursive calls. Each entry means "release one owning reference", not "visit
this value once". When another owner remains, traversal stops at that value;
when the shared count reaches zero, the session releases any
resident allocation, detaches its producer and schedules that producer's input
references. Inputs are inserted in reverse order so that processing remains
depth-first and left-to-right.

This distinction is essential for shared graphs. Two input positions may refer
to the same value, and both references must end. A set of already visited values
would incorrectly suppress the second decrement. Conversely, an independently
retained ancestor must remain usable: releasing a dependant is not permission
to detach that ancestor's producer while its other owners still need it.

Successful materialization uses the same producer-detachment responsibility
without dropping the computed value's remaining owners. All returned resident
materializations are installed before completed input edges are released.
Final-handle release, session close and observation retirement use final-owner
release; none needs a separate traversal policy or a graph-depth limit.

Physical release is fallible, but an exception must not abandon independent
logical responsibilities. Each retirement walk records release failures while
finishing the remaining input occurrences. A handle also retires its ordinary
value even if releasing its derivative history fails. Completed-program cleanup
detaches every completed producer and attempts its input releases before
reporting failures; it does not leave later completed edges attached merely
because an earlier allocation release failed. Saved history pins follow the
same rule in their [own owner](derivative-history.md).

The association is removed before its backend release attempt. Logical
bookkeeping therefore cannot be used to retry that same allocation or claim
that physical release succeeded. Errors remain observable under the
[public close contract](../javascript-api.md#create-compute-observe-and-release);
the backend still owns physical accounting and its terminal close. This rule
does not authorize continuing numerical execution through invalid backend state
or suppressing a reference-count invariant violation.

The `liveOperationRecords` diagnostic counts producer records still owned by
storage records, not all operations ever performed or all materialized result handles.
Successful materialization can reduce that count while result handles remain
open. Diagnostics describe logical ownership; checking actual graph references
is a separate requirement when verifying retention.

## Failures do not all end the same lifetime

An execution failure leaves an unmaterialized, still-owned result dependent on
its inputs. The session retains those producer edges so another observation
still has the computation it needs. Closing the final owner releases them.
A readback failure occurs after materialization, so it does not restore the
already released producer history. A later observation can copy the resident
result without rerunning the producer.

A cleanup error after successful materialization is different from a failed
kernel: the published resident associations remain, and completed producers
stay detached. That observation reports the cleanup error with its invocation
context rather than pretending numerical execution never completed. It does
not rebuild already retired edges or automatically retry physical cleanup.

Causal provenance is stored separately from owning edges. An observation error
can retain its immutable executable program and operation information without
retaining the occurrence-specific tensor graph. The
[runtime observation component](runtime-observation.md) explains request pins,
queue retirement and session drain; those pins protect accepted work even if
its public handle closes before completion.

## Costs and extension boundary

Every family current, numerical input occurrence and accepted request owns a
value reference and contributes one shared-storage reference. A shape-only alias
adds a semantic identity with a strong base-identity occurrence and optional
derivative entry; it has no additional F pin or numerical producer. Closing a
base exposure therefore cannot destroy a sibling. Semantic base identities can
remain owned even after their public exposures close.
Each identity also records its structural root, derived once from its immediate
parent's root or itself. Copy and current-history rebasing consult that root
without walking the chain again. This adds one reference slot per identity;
the root is already reachable through the unchanged base chain. It adds no
semantic owning occurrence. Retention, retirement, cycle collection and tracking
ancestry still follow their existing immediate-parent relationships. This
constant root lookup does not bound other tracking or derivative-history work.
Storage retains its original value descriptor to preserve the producing
operation's shape and provenance during formation, even when that original
value has no owners. This is one descriptor per live storage, not a retained
history. The live-value diagnostic counts values with semantic owners.

Shared producer dependencies detach once after successful publication, even
when several aliases remain. No alias scan is needed to publish materialization
or determine whether the last storage owner has disappeared. Saved derivative
operands add references at these same semantic owners; physical allocation and
completion remain backend responsibilities. CPU copy moves the family current/version once at admission while older R/Q
pins retain immutable backing. Publication releases no second F pin. The
[copy reference](../reference/tensor-copy.md) defines the finite capture budgets.

For a release that reaches `V` newly unowned values and `E` input references,
semantic bookkeeping takes `O(V + E)` work. Each producer detaches once, and
each owning input position is processed once when that producer detaches.
The temporary worklist takes at most `O(E + 1)` reference slots and the host
call stack is constant with graph depth. A retained owner forms a boundary:
the traversal does not descend into its still-owned producer. The worklist is
local to the release call and is discarded when that call ends; it is not a
session history or a numerical allocation cache.

Numerical reference release does not scan unrelated session values, move numerical data or
dispatch a kernel. These bounds describe semantic traversal, not the backend's
physical deallocation cost or the time the JavaScript garbage collector takes
to reclaim unreachable objects. Materialization release is
still delegated to the backend; this lifetime rule does not implement
within-program allocation reuse or make a claim about total process memory.

Gradient associations add owning identity occurrences and can form cycles
through views, history or other associations. The runtime coalesces collection
after exposure/association retirement only while associations exist, and flushes
scheduled work at diagnostics and shutdown. It marks public exposure roots,
strong base/gradient occurrences, nonleaf history owners, history input edges
and strong leaf endpoints; weak nonleaf hooks and canonical lookups are excluded.
It then scans identities and breaks unreachable associations before ordinary
iterative retirement. A pass costs `O(I + H + E)` for the identity registry,
reachable history and owning edges. Persistent associations can therefore add
global traversal to repeated temporary retirement; coalescing is not a promise
of constant work per backward call. Plain inference without associations has no
scheduled pass. Request/effect pins remain independent until physical drain.
The internal semantic diagnostic reconciles identity references with exposure,
base, association and leaf-endpoint occurrences and reports cumulative collector
work separately. It does not change historical public diagnostic fields.

The rule follows ownership rather than an operation name or input shape. Other
semantic owners, such as derivative history, must retain the values and facts
they actually need under the [architectural lifetime contract](../architecture/memory-and-performance.md).
Forward completion is not permission to discard an independently owned saved
value. That distinction permits reclaimable execution records without treating
every historical operation as a permanent owner.
