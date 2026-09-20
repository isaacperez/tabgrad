# Semantic value lifetimes

A tensor can remain useful after the calculation that produced it has finished.
Keeping its numbers does not require keeping every earlier calculation alive.
Conversely, closing an input handle cannot discard numbers that a pending
calculation still needs. This chapter explains how the semantic lifetime owner
in [`src/runtime.ts`](../../src/runtime.ts) preserves both requirements. It is
for contributors changing execution or frontend ownership, rather than a guide
to calling the public tensor API.

The [semantic architecture](../architecture/semantic-state.md) distinguishes a
public tensor identity, a logical value and its physical storage. Here those
roles are represented by a handle's `TensorState`, its `TensorValue`, and an
entry in the session's `MaterializationTable`. A materialization is the stored
numerical result associated with a value; its backend allocation has a separate
release obligation.

## Who keeps a value alive?

The session accounts for three execution owners: an open handle, an uncompleted
producer that consumes the value, and an accepted observation request. An
operation may consume the same input more than once; each input position owns
its corresponding reference. Releasing a handle ends only that handle's
ownership. The result of a lazy operation can therefore outlive its input
handles without losing the inputs it needs to compute.

An `OperationRecord` is an immutable description of an admitted call, including
its input values and definition. A value's link to that producer is an owning
edge, not a permanent historical archive. The session removes the link when the
producer is no longer needed for execution. Neither removing that edge nor
releasing a handle changes the logical value's metadata or numerical meaning.

For example, consider a chain whose intermediate handles are closed while its
final result is still pending. Before execution, producer edges keep the chain
usable. After successful execution has installed the resident materializations,
those edges are released. An intermediate with another open handle retains its
own stored result; an intermediate with no remaining owner releases its
materialization. The final result does not retain the completed upstream chain.

## Releasing an owner must release its references

Dependency release first detaches the producer and then releases each input
reference. This makes repeated release a no-op and keeps operation-record
accounting aligned with the records still owned by values. The immutable record
itself is not rewritten. When the final value reference disappears, the session
also removes the value from its live set and releases its materialization.

This ordering matters even if an application retains a closed tensor handle.
The handle can still reach its value object, but that object must not keep a
released producer chain alive. Removing entries from a live-value table alone
would not remove references held by other JavaScript objects.

A pending graph can be much deeper than the JavaScript call stack. The session
therefore follows final-owner release with an explicit worklist rather than
recursive calls. Each entry means "release one owning reference", not "visit
this value once". When another owner remains, traversal stops at that value;
when the count reaches zero, the session removes its live state, releases any
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

The `liveOperationRecords` diagnostic counts producer records still owned by
values, not all operations ever performed or all materialized result handles.
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

Causal provenance is stored separately from owning edges. An observation error
can retain its immutable executable program and operation information without
retaining the occurrence-specific tensor graph. The
[runtime observation component](runtime-observation.md) explains request pins,
queue retirement and session drain; those pins protect accepted work even if
its public handle closes before completion.

## Costs and extension boundary

For a release that reaches `V` newly unowned values and `E` input references,
semantic bookkeeping takes `O(V + E)` work. Each producer detaches once, and
each owning input position is processed once when that producer detaches.
The temporary worklist takes at most `O(E + 1)` reference slots and the host
call stack is constant with graph depth. A retained owner forms a boundary:
the traversal does not descend into its still-owned producer. The worklist is
local to the release call and is discarded when that call ends; it is not a
session history or a numerical allocation cache.

Release does not scan unrelated session values, move numerical data or
dispatch a kernel. These bounds describe semantic traversal, not the backend's
physical deallocation cost or the time the JavaScript garbage collector takes
to reclaim unreachable objects. Materialization release is
still delegated to the backend; this lifetime rule does not implement
within-program allocation reuse or make a claim about total process memory.

The rule follows ownership rather than an operation name or input shape. Other
semantic owners, such as derivative history, must retain the values and facts
they actually need under the [architectural lifetime contract](../architecture/memory-and-performance.md).
Forward completion is not permission to discard an independently owned saved
value. That distinction permits reclaimable execution records without treating
every historical operation as a permanent owner.
