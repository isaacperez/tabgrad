# CPU backward and persistent gradient state

Functional differentiation returns tensors to its caller. Training also needs
a gradient associated with each parameter: successive backward calls can add
to it, another tensor can be assigned to it, and clearing the association must
leave previously exposed gradients alive. These are observable tensor
semantics, not just a place to store derivative numbers.

This chapter owns the accepted integration contract for contiguous CPU
float32 backward and persistent gradients. Read [semantic state](semantic-state.md),
[automatic differentiation](autograd-and-training.md) and
[persistent CPU updates](cpu-tensor-updates.md) for the shared foundations.
The [compatibility record](../compatibility.md#python-tensor-evidence) and
[functional API reference](../reference/functional-gradients.md) establish
implemented public behavior; architectural acceptance alone establishes no
released backward or training capability.

## Native call boundary

The contract covers addition, multiplication, total sum, whole-storage
shape views and supported active/no-grad copy history. Scalar, singleton,
multidimensional and empty shapes follow the same rules. Python presents the
native positional-or-keyword signature and returns `None`:

```python
Tensor.backward(gradient=None, retain_graph=None, create_graph=False, inputs=None)
```

This is an architectural API contract, not an executable Tabgrad tutorial.
Ordinary first order with non-retained history is the bounded mode.
`retain_graph=None/False` and `create_graph=False`, including native accepted
integer false forms, preserve native binding behavior. Enabled retained or
higher-order modes are explicit unsupported extensions, not native-invalid
arguments. Invalid bindings such as `create_graph=None` retain their native
error class. Broader dtypes, layouts, devices, hooks, custom derivatives, JVP
and compilation require their own capability contracts.

| Argument or observation | Required behavior within this domain |
| --- | --- |
| Omitted `inputs` | Accumulate into used true leaves. |
| Explicit `inputs` | Accept a tensor, a nonempty iterable, or an exact dictionary whose values are tensors; deduplicate repeated targets, ignore disconnected tracked targets, reject untracked targets. |
| Explicit nonleaf target | Install persistent gradient retention during request metadata setup; assignment alone does not install it. |
| Omitted seed | Supply a unit seed only for an output with one element, at any rank. |
| Explicit seed | Accept a tensor or native one-element sequence/`None` forms; require exact shape, including empty dimensions. A tracked seed is valid in first-order backward. |
| Special no-grad view | Keep advertised tracking separate from a true leaf accumulator; selection cannot fabricate the latter. |
| Functional differentiation | Return selected gradients without automatic leaf accumulation; already retained nonleaf destinations can still receive contributions. |

Do not import the narrower functional API's tracked-seed or unused-input
restrictions into backward. Python normalization and error presentation belong
at the frontend; tensor semantics belong to the shared runtime. Native warning
categories and diagnostic behavior are qualified against the pinned oracle,
not inferred from a convenient implementation.

## A gradient association belongs to a tensor identity

Each semantic tensor identity has an initially absent gradient association.
It is separate from the numerical alias family, which owns the current value
and mutation version. Two tensors can share numerical storage and versions
while having different tracking, history and gradient associations.

Reading or assigning `.grad` does not blindly resolve the tensor's current
derivative entry. In particular, reading a dirty special view's absent gradient
can succeed even when resolving its leaf metadata would fail. Assignment
preserves the exact assigned tensor identity, tracking and history after native
shape, dtype, device and self-object validation. Nontracking tensors,
nonleaves and views can own assigned gradients. Assigning the exact owner
object to its own slot rejects; assigning a distinct view of its storage is
valid and can make accumulation mutate the parameter's numerical family.

Clearing with `None` releases only the association. Existing gradient objects
and their aliases remain valid. Numerical reset through an existing no-grad
copy of zeros instead preserves the gradient object and alias family while
changing its numbers and version. Neither transition implies an unprovided
`zero_` or `detach` operation.

## Leaf accumulation and nonleaf retention differ

For a true leaf, first acquisition conditionally clones or acquires a detached
mutable alias according to native incoming-gradient ownership and layout.
Covered view-derived seeds can share the acquired gradient's numerical family
and version counter while its tracking differs; direct caller-held seed
controls clone. This is conditional behavior, not a universal alias promise.
Eligibility concerns semantic tensor identity and ownership, not a physical
pointer comparison or the reference count of every tensor sharing storage.

Subsequent leaf contributions add in place to the existing gradient identity.
An assigned tracked gradient retains its tracking/history, and existing aliases
observe the new numerical value and version. Accumulation suppresses new
recording internally; it cannot rely on bypassing a public `copy_` guard.

A selected nonleaf retains gradients differently: first acquisition clones,
then later accumulation replaces its association with `old + incoming`.
Previously exposed gradient objects keep their old values. Later default
backward and functional differentiation can update this retained destination.
Retention can publish before that node's recipe or saved-state validation
fails, including a functional input cutoff.

The receiving association follows actual native current-entry rebasing.
Active direct nonleaf copy and direct view copy move it away from the old
entry; no-grad direct nonleaf copy preserves that entry. A write to an ordinary
view's base only dirties the view. Until a native-required resolution moves its
current entry, old bound graphs can still reach its old retention association.
Reading `.grad` does not force that resolution. Moving the receiving
association does not reset the slot's numbers.

## Progress and failure belong to executing nodes

Argument, handle, session and binding validation can precede traversal.
Saved-version and consumed-history checks occur when the corresponding node
executes. They do not prevalidate the entire selected graph transactionally.
Successful recipes consume their own state in non-retained mode; a failing
recipe keeps its unconsumed state. Every required save of an executing node is
checked, including positions whose requested numerical contribution is pruned.
Cutoffs do not execute their ancestors.

An endpoint becomes ready after all its selected incoming contributions arrive.
Pinned native CPU ready-node priority explains construction-order dependent
partial progress. Reproduce the covered traces; neither FIFO, argument order
nor a global graph sort is an equivalent rule. Equal priorities, reentrancy and
concurrent construction do not gain a new universal public ordering promise.

This matters even without persistent gradients. If a newer good multiplication
executes before an older multiplication with a mutated save, native functional
differentiation consumes the good recipe before the later saved-version error.
Retrying, or requesting the good branch separately, can then fail with consumed
history. Leaving the good branch reusable would change user-visible behavior.
The [versioned compatibility evidence](../compatibility.md#functional-failure-progress)
records the historical discrepancy and bounds qualified functional behavior. The per-node rule here
supersedes the former whole-selected saved-preflight/no-partial-derivative
architectural guarantee for both functional and accumulating differentiation.

Earlier committed gradient changes survive a later semantic traversal error.
A new call can encounter consumed successful history or accumulate again; it
does not roll back, resume or automatically retry the old invocation. Atomicity
applies to an individual reserved association/family transition: acquire
tentative ownership, publish once, and retire the old association once.

## Stable aliases over immutable logical values

The selected arrangement preserves a leaf gradient's semantic identity and
mutable numerical alias family over successive immutable logical values.
Ordinary addition creates the next value; an ordered versioned effect publishes
it to the family. Retained nonleaf replacement publishes a new gradient
identity instead. Captured observations and saved operands keep their specific
logical versions and causal outcomes rather than following later family values.
Updating a gradient can invalidate a save of its gradient or parameter family.

Per-tensor tracking, history entry, provenance and gradient association must be
separated coherently from shared numerical value/version ownership. Each
invocation owns its selection, readiness, contributions and failure progress.
The extension reuses operation admission, executable programs, CPU kernels,
requests, tickets and materialization. No second derivative executor or special
training numerical loop owns these operations.

Each committed gradient version retains root, explicit seed, relevant traversed
history and previous gradient writer prerequisites, plus its own update
outcome. Payload-free cutoffs still retain their causal controls. A later
semantic invocation error cannot become a failed gate retroactively poisoning
earlier successful commits. Those gradients remain readable once their own
dependencies succeed. A failed root, seed, relevant history writer or previous
gradient write still fails the dependent version.

Accepted gradient effects remain mandatory after association reset,
replacement, handle drop or a later traversal error. Their numerical and
failure-delivery responsibilities cannot be canceled by losing public owners.
They retain compact causal outcomes, not whole completed payload histories.
Managed entry progress, observation and close drive the ordinary finite closure.
Close bars new work, drains accepted work and retires independent owners with
safe physical completion and cleanup-failure aggregation.

A semantic native error fails that invocation and permits a corrected or fresh
call. Physical mutation failure follows the
[terminal session mutation barrier](cpu-tensor-updates.md#failure-delivery-and-recovery):
no fallback to old bytes, automatic retry, rollback or resume. Mandatory failure
delivery and repeated observation of a captured failure remain distinct.
These deferred execution/close rules are Tabgrad host integration, not a claim
that native CPU tensors expose promises.

## Public exposure does not own the association

The direct JavaScript surface is:

```typescript
Tensor.backward(gradient?: Tensor, options?: {
  inputs?: readonly Tensor[];
  retainGraph?: boolean;
  createGraph?: boolean;
}): void
// grad getter/setter: Tensor | null
```

An omitted seed is implicit; omitted inputs select used true leaves. Explicit
inputs require a nonempty actual array. Mode fields require strict JavaScript
booleans; enabled modes are unsupported in this subset. Malformed options,
containers and unknown fields raise `TypeError`; invalid tensor seeds/entries
use stable gradient runtime errors. Python preserves its independently
normalized native error classes. This is a JavaScript integration contract,
not an assertion that PyTorch has a native JavaScript API.

Repeated gradient reads return the canonical currently open exposed tensor
object for that gradient identity, including an open assigned tensor. Leaf
accumulation preserves it; nonleaf replacement and clearing select a different
association. Closing that object invalidates all references to the same object,
but does not clear the association or cancel effects. A later read can create
a new open handle for the still-owned identity; the old closed object stays
invalid. A shape view, rather than a second property read, provides an
independently closeable numerical alias. Clearing the slot leaves previously
exposed handles valid.

Python preserves native `is` through one canonical live wrapper, which owns
one public-handle lease rather than one lease per property read. The association
owns semantic identity independently. Finalization retires only the wrapper's
lease. Canonical lookup must not become a strong root retaining unexposed
identities forever. Explicit Tabgrad close and later wrapper reacquisition are
host extensions absent from native tensors; ordinary idempotence and cleanup
error delivery still apply.

## Cycles and bounded ownership

Closing a parameter exposure releases its external root, not every semantic
owner. A live true-leaf history endpoint can strongly retain the leaf identity
and its gradient association. Avoid a redundant self-backlink to its leaf node.
Retained-nonleaf receiving hooks are non-owning links: graph references to a
recipe alone must not retain an otherwise unused nonleaf gradient slot. Real
public, view-base and assigned-gradient owners still preserve its identity.

Valid own-view and mutual gradient assignments can create first-order cycles.
Weak associations or clearing on public close would lose observable state;
reference counting alone cannot reclaim unreachable cycles. Semantic
identity/history/gradient owners therefore own cycle responsibility. Account
for every owning edge occurrence and external public, request, history and
pending causal root. Serialize logical retirement before independently
fallible physical cleanup, retaining pins until physical work drains.

For live parameter/gradient identities `L`, reachable history nodes `V`, owning
edge occurrences `E`, in-flight work `Q` and explicitly retained aliases or
captures `A`, structural retention is `O(L + V + E + Q + A)`, not the number of
completed backward calls. Saved payload counts canonical numerical backings
and actual pin occurrences separately. Undrained work and caller-retained old
aliases are legitimate owners, not leaks.

A disposable affected-closure trial-deletion model provides cycle-retirement
controls, not a selected production collector. A trial can cost `O(Vc + Ec)`;
repeated triggers can repeat that work. A bounded implementation plan must map
actual owners, choose an algorithm/trigger that satisfies this contract and
qualify cleanup failures; unresolved material choices return to research.

Production qualification must exercise repeated fresh backward, accumulation,
association and numerical reset, own-view/mutual cycles, dropped exposure,
partial semantic progress, backend failure and close in the packaged CPU and
Python/JavaScript paths. Measure post-drain owner counts and physical reclamation
separately from reserved allocator capacity, Wasm memory and process RSS.
Abstract cycle controls and existing functional/copy measurements cannot
qualify a new gradient owner, bounded RSS or a performance advantage.

## Alternatives and evidence

Replacing the exposed tensor on every leaf contribution is incompatible with
native identity and alias observations; it remains correct only where native
nonleaf retention requires replacement. Stable physical storage with captured
snapshots is observably viable but requires writable bindings, last-reader
coordination and a snapshot policy at the numerical boundary. Hybrid exclusive
physical reuse has the same obligations whenever a physical write occurs.

Successive immutable logical values were selected for coherence with accepted
copy/snapshot/outcome owners and fewer independently mutable mechanisms, not
because measurements establish superior speed or memory. Adequate production
measurements showing material backing-allocation cost can justify reconsidering
physical reuse if it preserves all captures, aliases and outcomes.

[Research #167](https://github.com/isaacperez/tabgrad/issues/167) records the
[exact conclusion](https://github.com/isaacperez/tabgrad/issues/167#issuecomment-5996463772),
[acceptance](https://github.com/isaacperez/tabgrad/issues/167#issuecomment-5996846553)
and [independent challenge](https://github.com/isaacperez/tabgrad/issues/167#issuecomment-5996491997).
Its pinned native PyTorch 2.14.0 CPU evidence distinguishes public behavior,
build diagnostics and Tabgrad host invariants. Wheel commit
`08187d9e0fba026dc8217405802ab5381dc88d90` and explanatory tagged source
`2b3ec34829036a65cd9d1398ea72a0167dc37470` are distinct identities.
The [native matrix](https://github.com/isaacperez/tabgrad/issues/167#issuecomment-5996427284),
[ownership controls](https://github.com/isaacperez/tabgrad/issues/167#issuecomment-5996429263)
and [production-foundation observations](https://github.com/isaacperez/tabgrad/issues/167#issuecomment-5996430687)
preserve reproducible inputs, failed attempts and limits. They establish the
contract and foundation constraints, not production backward qualification.
