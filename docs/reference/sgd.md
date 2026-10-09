# Basic CPU SGD

Ordinary SGD operates on contiguous CPU float32 tensors. The
[SGD architecture](../architecture/cpu-sgd.md) owns numerical, ordering and
lifetime decisions; the [compatibility evidence](../compatibility.md#cpu-sgd-evidence)
identifies the native reference and qualified environments.

## Python calls

```python
torch.optim.SGD(params, lr=0.001, momentum=0, dampening=0,
                weight_decay=0, nesterov=False, *, maximize=False,
                foreach=None, differentiable=False, fused=None)
optimizer.zero_grad(set_to_none=True)
optimizer.step(closure=None)
```

`params` is a nonempty ordered iterable of unnamed tensors or group dictionaries.
A group can be empty. Its dictionary identity and custom metadata survive;
its `params` becomes an owned list of the original tensor objects. Nontracking
leaves and retained nonleaves are valid. Unretained nonleaves reject. Repeats
inside a group warn and update per occurrence; duplicates across groups reject.

Reserved group fields (`params`, `param_names` and optimizer options) require
keys of exact builtin `str` type. Additional metadata may use other key types
when inert and nonaliasing: its keys must not impersonate reserved fields through
custom equality. Dictionary subclasses and their native-phase callbacks remain
covered within this domain. Hidden reserved-key aliases are outside the
guarantee; detection or explicit rejection of every such violation is not
promised.

`defaults`, `param_groups` and initially empty `state` are inspectable. Changing
a group's learning rate or inert metadata is valid. Replacing groups or parameter
lists, changing membership or injecting state is excluded and rejects before
updates, including after a normal closure return. Momentum state is not fabricated.

Momentum, dampening and weight decay must be zero. Nesterov/maximize accept
false forms; foreach/fused accept `None` or false forms. Differentiable `False`
is supported; constructor-valid `0`/`None` preserve native `step` rejection
before the closure. Invalid Python binding and intrinsic constructor errors
preserve their class and phase, without promising exact wording. Native-valid
options outside this subset reject explicitly. Named parameters, tensor rates,
custom scalar/truthiness types, hooks, group addition, state serialization,
momentum, higher-order training and GPU optimization are excluded.

Constructor normalization publishes a fresh parameter list before extracting
named tuples. If extraction fails, that list and earlier groups' progress
remain visible; an iterable that fails before its list is complete leaves
the original container in place. These invalid-call effects do not add support
for named parameters.

The constructor reads each group's parameters again at the native extraction,
eligibility, duplicate-warning and disjointness phases. It reads previous
groups before comparing names, including the additional containment call used
to form a mismatch error. Getter, setter, default and warning effects retain
their order, original exceptions and earlier progress. Internal admission and
registration inspect the literal stored fields without extra virtual dictionary
calls or custom-key comparisons. Native-valid unsupported options reject after
intrinsic validation.

Builtin bool/int/float rates include infinity and NaN. Negative global rates
reject; negative group rates are valid. An actual update checks `-lr` against
the native integer or finite float32 range and rounds directly to float32.
Absent gradients skip this conversion. Each element receives one nearest/ties-even
rounding of `parameter + coefficient * gradient`, preserving overflow
cancellation. NaN category is guaranteed, not payload. Public multiplication
followed by addition has a different rounding contract.

`zero_grad()` removes associations, leaving exposed gradients valid. False
builtin bool/int/float/str/None truthiness instead preserves gradient identity,
applies native detach/disable-tracking metadata, then writes positive zero.
Tracked views can reject before writing. Views created in `no_grad` retain
caller-mode-sensitive guards. Earlier reset progress survives later failure;
aliases retain their own tracking and history.

Each group's `params` dictionary getter runs immediately before that group's
reset. Its effects can clear, install or replace the current gradient used by
reset. A thrown getter preserves its exception and earlier groups' progress.

`step()` returns `None`, or the exact result of a closure run once with recording
enabled. A throwing closure preserves its exception/effects without SGD updates.
The caller's mode is always restored. Each group selects gradient identities
at native per-occurrence phases, interleaved with dictionary option access,
and updates current numerical values in parameter order. Absent gradients skip;
present zero/empty gradients and zero rates still increment the alias version.
The update preserves parameter identity and does not replace its gradient
association; caller code can change that association. Earlier updates survive
later failure.

Group dictionary access can clear or replace an association after its identity
was captured; the update still uses that captured gradient. Recursive steps
retain independent captures. See the [capture contract](../architecture/cpu-sgd.md#capture-ownership-across-python-reentry)
and [bounded compatibility evidence](../compatibility.md#group-dictionary-capture-evidence).

```python
import torch
p = torch.tensor([2., 3.], dtype=torch.float32, requires_grad=True)
optimizer = torch.optim.SGD([p], lr=0.125)
for _ in range(2):
    optimizer.zero_grad()
    (p * p).sum().backward()
    optimizer.step()
assert p.tolist() == [1.125, 1.6875]
```

Run this ordinary script through a [managed binding](python-host.md). An optimizer
keeps parameter wrappers alive. Its finalizer holds only a private semantic lease;
binding close supplies deterministic session drain.

## JavaScript calls

```typescript
session.sgd(parameters: Tensor[] | SGDParameterGroup[], options?: SGDOptions): SGD
optimizer.zeroGrad(setToNone?: boolean): void
optimizer.step<Result>(closure?: () => Result): Result | undefined
optimizer.close(): void
```

Options use `lr`, `momentum`, `dampening`, `weightDecay`, `nesterov`, `maximize`,
`foreach`, `differentiable` and `fused`. Numeric fields require numbers and modes
require booleans. Omitted options use Python defaults with false mode flags.
`null`, unknown options and malformed values reject. Parameters and group `params`
must be actual arrays. Group dictionaries and tensor objects retain identity;
parameter arrays are copied. Groups expose `paramGroups`, state is a `Map`, and
numeric reset requires an actual boolean. Exported `SGD` requires session
construction. Closures are synchronous: a returned Promise is an opaque result.

Every parameter position must contain an eligible tensor; missing positions
reject with `INVALID_TENSOR`. Indexed getters run in parameter order and retain
their effects and original exceptions. Registration rechecks lifetime after
those accesses and acquires no optimizer roots on failed admission. Earlier
validation failures keep their precedence over that admission check.
The admitted indexed sequence also determines the copied public parameter
arrays and the targets of `step` and `zeroGrad`. Later getter and iterator
accesses retain their effects and original exceptions without replacing those
admitted occurrences.

```javascript
const p = session.tensor([2, 3], { requiresGrad: true });
const optimizer = session.sgd([p], { lr: 0.125 });
for (let step = 0; step < 2; step += 1) {
  optimizer.zeroGrad();
  const product = p.mul(p); const loss = product.sum();
  loss.backward(); loss.close(); product.close();
  optimizer.step();
}
console.log(Array.from(await p.toArray())); // [1.125, 1.6875]
optimizer.close(); p.close(); await session.close();
```

## Host lifetime and failures

Session, optimizer and original public parameter-handle close guards run in that
priority before calls and again after normal closure return: `CLOSED_SESSION`,
`CLOSED_OPTIMIZER`, `CLOSED_TENSOR`. Throwing closures retain their exception.
These are Tabgrad host extensions, not native error claims.

After a reset dictionary getter returns normally, session/optimizer checks and each
target's public-handle check precede its reset. These checks preserve earlier
accepted resets when a later target closes.

Registration retains one semantic identity edge per occurrence, without payload
clones or completed-step history. Close independently retires all occurrences
and aggregates failures; caller parameters, gradients and associations survive.
Accepted writes/observations retain captures through reset, replacement and drop.
Physical failure creates the existing terminal mutation barrier and reaches
observation or session drain.

Fixed-owner checks retain optimizer, parameter, gradient, alias and old saved
history across 16/64/128 drained steps at lengths 32/4096/65536. Logical ownership
and allocated/reserved Wasm bytes are distinct from host heap/RSS. These bounded
observations establish no universal memory or speed claim.
