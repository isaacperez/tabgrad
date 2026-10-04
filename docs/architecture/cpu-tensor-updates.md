# Persistent CPU tensor updates

This chapter explains the accepted contract for an equal-shape contiguous CPU
`float32` update. Its reader is a contributor who understands
[semantic state](semantic-state.md) and needs to preserve tensor identity,
deferred reads, differentiation and release while replacing a tensor's current
numbers. Public release support is established separately by the
[compatibility record](../compatibility.md), not by architectural acceptance.

## Separate an alias family from its numerical data

A parameter can acquire new numbers while remaining the same public tensor.
Its existing whole-storage views must see those numbers too. A calculation
admitted before the update, however, is entitled to the earlier numbers. These
requirements distinguish three identities: the public handle, the mutable
alias family shared by a tensor and its views, and an immutable numerical
backing containing one captured set of bytes.

The alias family owns the current logical value and mutation counter. Each
operation, saved derivative operand and observation captures a particular
logical value. That snapshot identifies its backing, expected family version
and writer outcome. Resolving its numbers never consults a later current value.
An update changes the family once; it does not scan or rewrite every alias.

The selected physical arrangement shares the source's immutable backing with
the destination's new logical value. This sharing does not make the tensors
public aliases. Their families, counters and writer outcomes remain separate.
Updating the source afterward replaces only its current value; the destination
still owns the captured bytes. Updating the destination invalidates a save of
that destination even when the new bytes happen to be equal. A numerical no-op
is still a version transition.

This choice uses the existing immutable numerical-program and read-only
backend binding boundaries. Publication changes ownership and visibility; it
does not require a destination numerical copy kernel. It neither establishes
zero control cost nor implies that sharing is faster than another arrangement.

## Preserve the bounded observable contract

The decision covers scalars, empty tensors and equal-shape whole-storage views
of contiguous CPU `float32` values. General strides, offsets, broadcasting,
conversion and cross-device or cross-session copies are outside this domain.
Those boundaries are not claims that PyTorch rejects the broader calls.

The Python contract is `Tensor.copy_(other, non_blocking=False)` and the
`torch.no_grad()` context. Copy returns the same destination object, preserves
its shape and alias identity, and advances its family version exactly once
after successful admission, including self-copy, empty copy and equal-data
copy. The source is captured before that transition, so whole-storage overlap
is well defined. The CPU boolean option does not change numerical semantics.

The pinned native reference accepts positional source, `other=` and positional
or keyword boolean `non_blocking`. Its effective `other` keyword differs from
the `src` label in the consulted versioned documentation. Binding/type failures
precede inplace guards, and the observed tracked-leaf guard precedes a shape
mismatch. Native guard and source-edge failures leave destination state
unchanged. Session, open-handle, supported-domain and resource validation are
separate Tabgrad integration boundaries.

The direct JavaScript contract is `Tensor.copy_(source)` and
`RuntimeSession.noGrad(callback)`, with synchronous and Promise-returning
callback forms that preserve the callback's result. Python and JavaScript use
one runtime mode owner; frontends normalize arguments and translate errors.
The JavaScript callback interface is an integration contract, not a native
PyTorch Promise API.

## Recording mode and derivative identity

Recording mode belongs to one execution environment. Python's joined asyncio
tasks on that environment share the mode; independent interpreter/session
namespaces keep separate owners. A scope captures the previous mode, disables
recording, then restores that captured value on exit, synchronous throw or
Promise settlement. Overlapping lifetimes do not use an aggregate nesting
count: if two scopes enter while the first is disabled, exiting the first can
restore enabled mode and exiting the second can restore disabled mode. A mode
transition neither flushes unrelated pure work nor resets at interpreter-entry
completion. Explicit tracked factories still produce tracked true leaves in
no-grad, and explicit differentiation of an existing graph remains available.

With recording disabled, a legal copy preserves tracking, a true leaf's stable
derivative anchor and a nonleaf's existing recipe. With recording enabled,
plain-to-plain copy stays plain, while a tracked source promotes a plain
destination. Legal nonleaf copy binds the old destination and source edges
before replacing the current destination entry. Its derivative contributes
zero to the old destination and the incoming gradient to the source. Self-copy
can combine these paths. The zero path remains connected: an executed old
node may validate saved operands and consume history through it.

Tracked-leaf active writes and ordinary tracked views of tracked leaves retain
native guards. A legal ordinary whole-storage nonleaf view write rebases base
history with the required shape transformations. Previously admitted outputs
retain their bound edges; current view queries resolve current entries. A
stale ordinary child can rebase toward the ultimate base rather than preserving
an old parent entry, while a new child binds its current parent's edge. Plain
ordinary aliases inherit tracking when their base is promoted.

Views created in no-grad retain native creation provenance even when their
base was plain. A tracked such view can advertise tracking without a normal
leaf accumulator. It may be an invalid derivative root or an unused input,
while active arithmetic or copy involving it produces a valid tracked node
whose input edges are all absent. A stale special view can keep readable
numbers and tracking while current-edge resolution fails. A dirty source view
can therefore reject copy before destination admission; a special destination
view can reject promotion. No-grad child creation can use the current epoch
without resolving a dirty parent's edge, whereas active child creation resolves
it. These rules require separate advertised tracking, current-entry
provenance/epoch and bound historical edges; detachment or ordinary-leaf
substitution would change the observable behavior.

Saved numeric operands and consumable derivative call state are also separate.
Direct copy history itself is reusable without retained-graph mode. View-copy
base history has consumable state even without saved numerical operands.
After source traversal consumes it, another source traversal fails, while a
current base/destination cutoff can succeed without executing that history.
Source-only requests can likewise avoid an old consumed multiplication.

Before admitting seeds or derivative operations, differentiation resolves
native-required current entries, identifies executed nodes and validates their
consumable state and every saved operand against its expected alias version.
This includes plain saves and saved positions whose requested contribution is
mathematically pruned. Unexecuted cutoff/connectivity-only nodes need no such
save validation. Failure admits no partial derivative operations and consumes
no saves. Successfully admitted derivative operations own their captured
numeric inputs independently after the history releases its saves.

## Account for numeric ownership exactly once

A semantic pin is an obligation to keep a captured backing usable. The backend
still owns the actual allocation and its last physical access. The following
names identify ownership units, not required implementation classes:

| Pin | Owner and retirement |
| --- | --- |
| Current-family pin F | One per live alias family's current version; retired once when superseded or the final public family handle closes. |
| Captured-snapshot pin R | Each operation input occurrence, save or observation owns its exact snapshot; its owner releases that capture, never a later current value. |
| Effect-source pin Q | A mandatory update owns its captured source through responsibility completion and physical drain, including after all public handles close. |

Admission transactionally reserves new F and Q on the captured source backing.
Commit installs F and retires the old F once. Publication changes the new
version's writer outcome; it acquires no second F and does not transfer Q into
F. Closing or superseding the pending destination retires its F without
cancelling Q. Publication cannot resurrect that retired pin. Existing R owners
remain independent, and Q retires independently after the effect drains.

If the new version fails, it cannot fall back to old bytes. Its numeric F can
retire once no physical access remains while failed-state metadata stays
available for subsequent errors. A previously closed or superseded F cannot
retire twice. Failure to publish the destination does not poison a valid
source backing. A closed base's private leaf/view anchor can preserve required
derivative metadata without retaining obsolete numerical data.

One backing and backend generation have one physical materialization owner.
Two slots borrowing that backing are read leases, not two allocation owners;
invocation rollback cannot release either borrowed allocation. Physical release
requires the final numeric pin and final access/drain to end. Release failure
is distinct from logical reference retirement; idempotent release does not
prove successful reclamation or safe reuse.

External-retention accounting uses these backing pins as its unit. A family
root counts once, repeated numerical input positions count per occurrence, and
different shapes sharing a backing are canonicalized. A reference subtraction
defined for another ownership unit cannot be reused without reconciling it.

## Admit, progress and publish through the ordinary path

Validation and resource reservation precede the version transition. A failed
reservation releases tentative pins and leaves current value, counter and
history unchanged. After commit, the immutable source snapshot and its writer
outcome are fixed, including for self-copy. Updates follow admission order and
are mandatory effects even when the caller drops the returned handle.

The existing request owner forms the finite demanded source program, advances
its numerical work and publishes the captured destination version. A frontend
entry schedules the coalesced ordinary progress point; observations and managed
Python completion advance the same closure directly. Close rejects new
admission but drives and joins already admitted effects and source dependencies.
Unrelated discarded pure roots stay undemanded. This requires neither another
scheduler nor timer/threshold flushing or compiled execution.

Backing readiness is not publication. Host-ready and resident fast paths must
check the destination's writer outcome before success. Publication requires
predecessor and source success and a valid captured backend generation. Logical
result settlement can precede physical drain; request pins and leases survive
until drain. Completed producer and predecessor links detach when their
responsibilities end instead of preserving a chain of completed updates.

For example, a read before an update captures version zero; a read between two
updates captures version one; a later read captures version two. Superseding
version one retires its current-family pin but leaves its effect-source pin
and the middle read's snapshot pin intact. Both updates must progress even if
their public handles close. Each read then retires its own capture, regardless
of the family's current version when execution finishes.

## Carry causal outcomes through payload-free gradients

A derivative can need no forward numbers, as when the requested input is the
root itself or a sum supplies an incoming seed. Numerical readiness alone must
not make such a derivative appear successful before its copied root publishes.
Derivative admission therefore captures the root snapshot's causal effect
prerequisites independently of derivative-node traversal. Pure operations
propagate captured input prerequisites; returned derivatives carry the root
prerequisites and those of actually traversed history entries.

Each returned derivative owns a control capture C for those exact writer
outcomes. It is budgeted control ownership, not another numeric F/R/Q pin.
Downstream uses and accepted observations acquire independent captures of the
same outcomes. Closing the last derivative handle releases its C; an accepted
observation retains its capture through result and physical drain. A pending
or failed prerequisite prevents success even when a seed is already ready.
Dropping all C captures cannot cancel the mandatory effect, Q or its undelivered
error responsibility. Completed control dependencies detach into bounded
terminal metadata rather than retained source programs or effect chains.

Requested gradient inputs capture their current derivative-entry identity and
provenance for matching and validation, not an unconditional dependency on
their latest numeric version. An old bound successful output differentiated to
its stable leaf therefore does not acquire a later no-grad update's outcome.
A new current-root capture does acquire that outcome even though the leaf
anchor is unchanged. This distinction preserves old-output independence
without allowing a current-root cutoff to bypass a failed write.

## Failure, delivery and recovery

A committed update is never silently undone, decremented or replayed. Source,
preparation, execution, predecessor or publication failure makes its committed
version terminally failed. Observing that version reports its causal error.
Valid earlier captures and a still-valid source retain their own outcomes.

An admitted mandatory-effect failure establishes a session mutation barrier.
New writes fail admission without another version advance; admitted ordered
successors fail causally without performing their write. Independent pure
observations of valid captures can still complete. Further writes require a
fresh session. This is an explicit Tabgrad backend/effect recovery policy,
not a result established by PyTorch's synchronous numerical oracle.

The session owns an undelivered causal-error responsibility even for a dropped
effect. An owning observation, managed completion/synchronization or close
delivers that responsibility once; accessing a failed snapshot may still
report its causal failure. Readback failure does not replay a write or reverse
successful publication. Physical drain and cleanup errors preserve the first
causal outcome and permit independent cleanup to continue. Unknown completion
does not authorize byte reuse: a bounded terminal owner quarantines its lease
until backend terminal cleanup. Causal provenance is not permission to retain
numeric graphs indefinitely.

## Bound retained state by live obligations

Consider a fixed true-leaf parameter, its existing aliases and a constant. Each
iteration forms a fresh squared loss, requests its gradient, then updates the
parameter under no-grad from its old value and that gradient. Temporary loss,
gradient and replacement handles close after admission. At a checkpoint after
source completion and physical drain, the live families own one current backing
pin each, leaf anchors stay stable, completed producer/effect links detach and
consumed saves retire. Required retained owners depend on that fixed live
graph and outstanding work, not the number of completed iterations.

This is a structural bound conditional on those transfers, not a measured
memory plateau. Retained outputs or undrained requests legitimately increase
live state. Arbitrary active copies can also preserve observable zero-edge
history and old saved checks, so constant history per public handle is not a
general guarantee. Actual live history, payloads, queued effects, control
captures and undelivered errors remain subject to explicit count/byte budgets.
Exhausted admission fails transactionally; it cannot flush unrelated work to
manufacture space. Reserved Wasm capacity and process memory are different
quantities from live semantic payload.

## Alternatives and reconsideration

Fresh immutable copying preserves the same semantic contract but requires a
byte-preserving backend copy and destination allocation. Physical inplace
execution is also viable if it snapshots every entitled old numerical owner,
orders hazards and obtains an exclusive write lease. It must isolate partial
writes and cannot treat borrowed read-only bindings as writable scratch. A
hybrid mutating live storage inherits those obligations; reuse of dead
backings can remain a backend optimization under the immutable contract.

Sharing was selected for its fit with immutable formation and read-only
bindings, without adding physical-write hazards or an unconditional destination
copy. This is a structural decision, not a measured latency or total-memory
winner. Public mutable backing access or partial-view writes require a new
contract; evidence of material sharing/control costs can justify reconsidering
the physical arrangement. Switching arrangement is less expensive than
changing public identity, derivative, visibility or recovery semantics. None
of the alternatives requires a separate numerical engine or dependency.

## Decision evidence

[Research #159](https://github.com/isaacperez/tabgrad/issues/159) records the
[exact accepted contract](https://github.com/isaacperez/tabgrad/issues/159#issuecomment-5981001039),
[acceptance](https://github.com/isaacperez/tabgrad/issues/159#issuecomment-5981103938)
and [independent challenge](https://github.com/isaacperez/tabgrad/issues/159#issuecomment-5981015057).
The bounded native evidence includes
[active-copy connectivity](https://github.com/isaacperez/tabgrad/issues/159#issuecomment-5980820661)
and [history lifetime, promotion and calling forms](https://github.com/isaacperez/tabgrad/issues/159#issuecomment-5980860688),
alongside the earlier methods and contrary results retained in that issue.
Its reference is PyTorch 2.14.0 build
`08187d9e0fba026dc8217405802ab5381dc88d90`, CPU `float32`, with one native
intra/inter-op thread. Native query families establish selected reference
semantics; they do not qualify Tabgrad allocation release, asynchronous fault
handling, browser support or performance. Those claims require evidence from
the actual implementation and environments they describe.
