# Ordinary CPU SGD

An optimizer updates parameters using their associated gradients. Familiar
PyTorch training code resets gradients, computes a loss, calls backward and
then steps the optimizer. Matching a gradient-descent formula is insufficient:
the calls also expose defaults, argument errors, tensor identity, aliases and
partial progress. Those observations constrain the implementation even when
Tabgrad performs the numerical work differently.

This chapter owns the accepted ordinary contiguous CPU float32 basic SGD
contract. It is for contributors preserving that behavior, rather than an
installation tutorial or a claim that SGD is released. The
[compatibility record](../compatibility.md) establishes implemented support.
Read [gradient state](cpu-gradient-state.md) for tensor identities and
associations, [persistent updates](cpu-tensor-updates.md) for effects and
versions, and [automatic differentiation](autograd-and-training.md) for the
shared execution path.

## Native calls and the bounded domain

Python presents the native binding:

```python
torch.optim.SGD(params, lr=0.001, momentum=0, dampening=0,
                weight_decay=0, nesterov=False, *, maximize=False,
                foreach=None, differentiable=False, fused=None)
optimizer.zero_grad(set_to_none=True)
optimizer.step(closure=None)
```

These signatures describe architectural requirements. The domain covers
ordered unnamed parameter iterables and groups, built-in real scalar learning
rates, ordinary first-order gradients and basic updates. Parameters need not
be module parameters: nontracking leaves and retained nonleaves are valid.
Nonleaves without retention reject natively; gradient assignment alone does
not install retention. The gradient-state contract supplies that distinction.

The basic option values are momentum, dampening and weight decay zero;
Nesterov, maximize and differentiable false; foreach and fused unset or false.
Native false forms must preserve their supplied values in defaults/groups:
Nesterov/maximize also accept 0/None, and foreach/fused accept 0. Differentiable
0/None is different: construction succeeds, but step raises TypeError before
closure or updates, restoring recording mode. Uniform false coercion changes
the native phase and error.

Nondefault momentum/dampening/decay/Nesterov/maximize, enabled foreach/fused/
differentiable, tensor learning rates, named parameters, add_param_group,
state_dict/load_state_dict, hooks and arbitrary manual state injection are
explicit deferred native-valid capabilities. Python reset containers,
subclasses and custom truthiness are also deferred. They cannot be silently
ignored or described as native-invalid. Intrinsic native constructor validation
finishes before explicit rejection of a native-valid unsupported capability;
invalid bindings retain their native error class and precedence.

## Registration, groups and state

A group retains the caller's dictionary identity while owning a copied
parameter list. Parameter objects, order and repeated occurrences remain
observable; custom metadata is inert. Registration does not clone parameter
payloads. Empty groups are valid, while an empty outer parameter iterable and
a bare Tensor reject with the native ValueError and TypeError respectively.
Malformed parameters and duplicates across groups retain native errors.
Duplicates within a group retain the pinned native warning and update once
per occurrence rather than being silently deduplicated.

Defaults, param_groups and initially empty basic state remain inspectable.
Scalar learning-rate changes in existing groups are supported. A negative
global constructor rate raises ValueError, but a negative group rate is
natively accepted and updates accordingly. NaN/infinity do not acquire an
invented finiteness check; numerical qualification distinguishes categorical
exceptional results from a universal NaN payload/sign guarantee.

Changing other known options outside the domain rejects explicitly at the
actual group before that group's updates. Earlier groups retain their accepted
progress. Arbitrary structural tampering with group lists/maps is deferred;
ordinary supplied repeats, custom metadata and learning-rate changes are
covered. This boundary does not require a general optimizer framework.

## Gradient reset changes associations or metadata

An absent gradient means there is no associated tensor. A present zero
gradient is still a tensor with identity, tracking, history, aliases and a
version. The two reset forms preserve that difference.

Python zero_grad keeps native positional/keyword binding and truthiness for
exact built-in bool/int/float/str and None. None, 0, 0.0 and the empty string
perform numeric reset; true-like values drop associations. Nonzero numbers,
including NaN, and nonempty strings are true-like. Invalid arity and unknown
keywords retain TypeError. Direct JavaScript uses strict booleans instead.

A truthy reset releases each association without invalidating already exposed
gradient objects. Numeric reset preserves the exact gradient identity and
numerical alias family. Before publishing positive zeros, it detaches native
history or disables tracking as required for that gradient. A tracked view
with grad_fn rejects at its own reset; earlier reset progress survives.
Repeating the same gradient through two parameter slots performs two resets
and version transitions. Missing gradients are not fabricated and reset does
not create optimizer state.

Aliases see the numerical zero write while retaining their own tracking and
history metadata, including native rebasing. A saved tensor detached in place
subsequently raises the native detached-save error category, not merely a
version error. The gradient-state chapter's ordinary no-grad copy describes a
numerical transition; it alone does not implement this optimizer metadata
reset. Internal reset integration does not imply public zero_ or detach_ APIs.

## Step preserves identities and sequential progress

Basic step skips only absent gradients. Present zero or empty gradients and
learning rate zero still perform the native version/alias transition, including
invalidating older saves. Parameter identity and the gradient association
remain stable. Genuine parameter/gradient aliases can change gradient numbers
when an earlier parameter update changes their shared family.

For example, let parameters p and q start at 2 and 4, with p's gradient aliasing
q and q's gradient aliasing p. With rate 0.5 and order p then q, p becomes 0;
q then uses that updated gradient value and remains 4. Copying all gradients at
step entry would produce a different result. Current groups collect gradient
identities before arithmetic, but numerical captures follow the required
sequential native update order.

Constructor and relevant group setup validation precede that group's
arithmetic. An earlier group's updates survive a later semantic error. There
is no whole-optimizer transaction, rollback or automatic retry. Physical
mutation failures follow the existing terminal session barrier and mandatory
failure-delivery contract. Existing no-grad-view provenance and saved-version
guards remain observable, including metadata errors after a successful update.

An optional closure executes exactly once with recording temporarily enabled.
Step preserves its arbitrary return identity and restores the caller's mode.
A thrown closure starts no SGD update; its own accepted effects remain. No
closure means the native None return. The closure is ordinary user computation,
not a special training engine or permission to bypass validation.

## Direct JavaScript presentation and lifetime

The shared runtime supplies a session-constructed exported SGD class:

```typescript
session.sgd(parameters, options?)
SGD.zeroGrad(setToNone = true): void
SGD.step<T>(closure?: () => T): T | undefined
SGD.close(): void
```

This is an architectural interface sketch, not executable TypeScript. Direct
construction cannot forge an optimizer. Parameters are an actual nonempty
Tensor array or an array of groups whose parameters are actual Tensor arrays;
empty groups are valid. Options are omitted/undefined or an object with number
fields lr/momentum/dampening/weightDecay and strict boolean fields
nesterov/maximize/foreach/differentiable/fused. Nondefault/enabled capabilities
remain unsupported as above. Null, malformed and unknown top-level option
fields raise TypeError; omitted foreach/fused remain unselected.

Group objects retain supplied identity, normalize an owned parameter-array
copy and preserve custom inert metadata separately from known options. The
original Tensor objects and occurrence order remain visible. Defaults,
paramGroups and empty state use the shared semantic identity authority.
zeroGrad accepts only a boolean; closure must be omitted/undefined or a
function. Python binding/truthiness stays Python-specific.

The JS closure returns its exact value, including an opaque Promise, without
awaiting it. Recording scope ends on synchronous return; an asynchronous
callback scope is not promised. Session, optimizer and every registered public
handle are validated upfront before closure or resets. After normal closure
return, revalidate before any SGD update: closed/closing session raises
CLOSED_SESSION, then closed optimizer raises CLOSED_OPTIMIZER, then a closed
registered Tensor raises CLOSED_TENSOR.

Closing one of these during a closure cannot authorize hidden-root updates.
The closure's earlier effects remain accepted and recording mode is restored.
A thrown closure preserves its original exception/effects, without starting
SGD updates. Cleanup/restoration must neither start fresh closed-session work
nor replace the original exception with an incidental mode-access error.
These close rules are Tabgrad host extensions, not native PyTorch behavior.

Caller reentry is not confined to the closure. Both presentations can execute
caller code while processing a group: JavaScript property access and Python
dictionary access or comparison can change lifetime and gradient associations.
Learning-rate access can reenter after gradient discovery and before update
admission. Preserve lifetime validation at the applicable admission boundaries,
the original thrown exception, recording restoration and accepted earlier-group
progress. An option or coefficient error that occurs before the next lifetime
check keeps its precedence; the close priority does not move that check ahead
of earlier failures. A different validation algorithm must also preserve native
per-group gradient capture and sequential numerical alias effects. The
[known dictionary discrepancy](../compatibility.md#known-group-dictionary-limitation)
records where the current Python presentation does not yet meet that contract.

## Optimizer ownership and retirement

Registration owns one semantic identity edge per parameter occurrence.
Python's native lists/groups keep parameter wrappers live; an optimizer wrapper
also owns one private runtime lease finalized without a self-retaining
callback. Ordinary Python acquires no new required public close call.

JS can close a registered public Tensor object while optimizer roots still
preserve accepted state/work. Future step/zeroGrad reject that closed object
upfront; group references keep denoting the original object. There is no
automatic reopening or resurrection. A fresh optimizer requires eligible open
exposures; replacing registered exposure/group structure is deferred.

Optimizer close is idempotent, bars new optimizer work, independently attempts
retirement of every owning occurrence and aggregates cleanup failures. It does
not close caller parameter/gradient objects, clear associations or cancel
accepted writes. Pending effects retain captures until safe completion;
session close drives drain/failure delivery and invalidates the optimizer.
Python finalization retires its private lease under the same ownership rules.

The gradient-state authority owns cycles and logical retirement before
fallible physical cleanup. Optimizer registration joins those owners rather
than defining a second collector. Legitimately retained histories, aliases,
requests and saves can outlive close; neither close nor finalization guarantees
immediate physical reclamation or bounded RSS. A live optimizer does not
retain completed loss/step history merely because it remains alive.

## Ordinary arithmetic and qualification requirements

The native basic update is coefficient-bearing alpha-add. Separately rounded
float32 multiplication followed by addition is not generally equivalent.
In one selected cancellation case with p=50.29061508178711,
g=502.9061279296875 and lr=0.1, the pinned native result is
1.5394298316095956e-6 (bits 35ce9e68), while that composition gives positive
zero. Selected cancellation values remain native-valid; exclusions or a loose
tolerance cannot conceal this difference.

### Coefficient conversion and capture

Preserve built-in Python negation and type semantics before checked native
conversion of `alpha=-lr` to float32. The selected native scalar parser accepts
integer alpha in the signed64/unsigned64 range [-2^63, 2^64-1]; negating an
integer learning rate changes which boundary is accepted. Direct Boolean
alpha is invalid for float32, whereas Boolean lr negates to an integer.
Reject a finite float whose magnitude exceeds float32 maximum even when a
rounded cast would produce the finite endpoint. Real infinities and NaN remain
accepted; preserve ties-even conversion, underflow and signed zero rather than
saturating.
Validate when an update actually occurs: an absent gradient skips the update,
while an empty gradient still requires coefficient validation.

Capture the resulting coefficient bits as immutable per-invocation metadata
through the ordinary operation record, program formation and validation, CPU
dispatch, and versioned private Wasm ABI/artifact contract. Later group-rate
mutation must not change already captured work. The ordinary arithmetic owner
supplies this update; no optimizer-private loop or whole-step compilation is
introduced. Public alpha=1 addition and separately rounded public tensor
multiplication keep their contracts; this decision does not add public general
alpha-add. Forward, backward, reset and optimizer effects continue through the
ordinary operation/program/request/backend path.

### Rounding and the physical response

For the selected PyTorch 2.14.0 arm64 wheel, require one nearest/ties-even
float32 rounding of the exact float32 coefficient-times-gradient plus
parameter. Preserve signed zeros, subnormals, underflow, overflow and true
infinity/NaN classifications; NaN payload and sign are not guaranteed. A zero
rate does not skip arithmetic: zero times an infinite gradient produces NaN.
Finite product overflow must not introduce an intermediate infinity before a
canceling addition.

Use the qualified compensated float64 response: form the exact float32 product
in float64, retain the ordered TwoSum addition residual, and correct a high sum
on a float32 midpoint using that residual, including both overflow boundaries.
Every finite float32 product fits exactly in float64; the residual distinguishes
which side of a float32 rounding boundary the exact sum occupies. An uncorrected
float64 sum followed by a float32 cast can still double-round incorrectly.
Exceptional inputs use widened arithmetic with explicit zero/nonfinite handling.

SIMD128 promotes pairs to f64x2 for the product and residual arithmetic, applies
the same correction per lane, and uses the scalar helper for tails. Keep the
operation order; unsafe fast-math reassociation invalidates qualification.
This internal arithmetic requires neither std, a new dependency nor relaxed
SIMD, and does not change the tensor's CPU/float32/contiguous domain. The
disposable prototype's buffers and entry points do not define production ABI
signatures, allocation ownership or mutation ownership.

Compensation adds float64 operations and per-lane correction. No production
throughput or cost advantage is established. The compiled scalar/SIMD evidence
is bounded to the recorded Node/Wasm toolchain and native wheel; it does not
qualify browser integration or promise identical bits across all PyTorch builds.
Qualify the shared production path and each claimed environment independently.

A usable production capability requires qualified backward/gradient state,
that numerical response, metadata reset integration and maintained Python/JS/
browser traces. Alias/version/progress errors and closure-close cases require
actual integration evidence. Mandatory effect failure/drop/close/drain and
cycle retirement require real owner tests, not source analysis.

Fixed-owner repeated training must record post-drain parameter, gradient and
optimizer roots, history/save pins, logical/backing bytes, pending work and
causal outcomes separately. Include legitimate user-kept aliases/history and
allowed transient work. Structural state scales with live parameters/groups,
reachable owners and in-flight captures, not completed step count. Wasm
capacity, host heap and RSS are separate observations; stable identity counts
do not prove physical reclamation or a performance advantage.

## Alternatives, evidence and reconsideration

Momentum-inclusive single-tensor SGD is viable but adds independently acquired
first buffers, exposed state identities, two later buffer-version increments
and different first-new versus existing-buffer failure publication. Deferring
it reduces the first qualification surface without selecting a speed or memory
winner. Later support extends these owners and transitions without replacing
the basic Python signature.

Foreach/fused are native-valid CPU alternatives, not interchangeable flags.
Observed foreach Nesterov changes the gradient, while fused changes pinned
version diagnostics. Silently translating them to basic single-tensor behavior
would violate the contract. Separately rounded float32 mul/add and an
uncorrected float64 cast both fail selected native-valid cases; neither is a
fallback. Correcting a composition must not silently fuse existing public
mul/add rounding boundaries. The selected ordinary coefficient computation
avoids that change. Exact integer/software arithmetic is a possible alternative,
but the reference oracle is not a qualified production kernel and no unmeasured
performance disadvantage is assigned to it. Relaxed SIMD permits fused or
unfused results and cannot ensure this rounding contract. Waiting for all
optimizer-base surfaces does not remove arithmetic/reset obligations or justify
an unused framework.

[Contract research](https://github.com/isaacperez/tabgrad/issues/168), its
[reproducible evidence](https://github.com/isaacperez/tabgrad/issues/168#issuecomment-5998273869),
[independent challenge](https://github.com/isaacperez/tabgrad/issues/168#issuecomment-5998241160)
and [acceptance](https://github.com/isaacperez/tabgrad/issues/168#issuecomment-5998532488)
support this decision. The native oracle is PyTorch 2.14.0 wheel
08187d9e0fba026dc8217405802ab5381dc88d90; the explanatory v2.14 source tag is
a distinct identity. Sources, bounded controls, original/public hashes and
the preserved incomplete observation remain in those evidence records.

The 4096 selected mismatches refute general naive-composition equivalence, not
a universal error rate. Scalar/length controls support one float32-alpha
single-rounding discriminator on that arm64 wheel, not all hardware. Native
2/8/32-step observations do not qualify Tabgrad owners, Wasm capacity or cost.
Broader build diagnostics and NaN payload/sign guarantees remain limited.

[Numerical research](https://github.com/isaacperez/tabgrad/issues/172), its
[accepted exact response](https://github.com/isaacperez/tabgrad/issues/172#issuecomment-6039036110)
and [frozen methods, results and independent challenge](https://gist.github.com/isaacperez/ea455ff176abb907ff3a7e2657ea7e66/4027173778bdb687fbf8a746ac7fab5c59a6fad6)
support the coefficient and physical arithmetic decision. The corrected scalar
and SIMD128 Wasm variants each matched 32,674 selected element occurrences;
separate float32 composition differed 5017 times and an uncorrected float64 cast
156 times in each variant. These deliberate discriminators and the exact
integer reference support the response, not an exhaustive proof or error-rate
estimate. Production metadata, aliases/versions, gradient/reset effects,
lifetimes and browser user traces require their own integration evidence.

Reconsider the domain through explicit compatibility/architecture work when
momentum or broader APIs are needed, native-version changes alter covered
observations, numerical qualification changes the supported platform policy,
or real ownership/cost evidence contradicts these constraints. Changed native
builds, compiler flags/features or numerical domains require requalification.
Contrary native-valid results require revisiting the policy or qualification,
not loosening tolerances or excluding cases to protect an implementation.
Preserve the native behavior of already covered calls; internal freedom does
not authorize a different user optimizer.
