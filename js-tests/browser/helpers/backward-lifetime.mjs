/** Public semantic lifetime controls shared by Node and real browser consumers. */
function equal(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}

export async function checkBackwardLifetime(session, semanticOwnership) {
  await checkTrackingEpochTransitions(session);
  const x = session.tensor([2, 3], { requiresGrad: true });
  const assigned = session.tensor([10, 20]); x.grad = assigned;
  const product = x.mul(x); const root = product.sum(); product.close(); x.close();
  root.backward(); root.close();
  equal([...await assigned.toArray()], [14, 26], 'closed leaf exposure retains accumulator endpoint');
  assigned.close();

  const leaf = session.tensor([2, 3], { requiresGrad: true });
  const mid = leaf.add(leaf); const child = mid.sum(); const untracked = session.tensor([1, 1]);
  try { child.backward(undefined, { inputs: [mid, untracked] }); throw new Error('untracked input accepted'); }
  catch (error) { if (error.code !== 'GRADIENT_NOT_TRACKED') throw error; }
  const prior = session.tensor([10, 20]); mid.grad = prior;
  mid.close(); child.backward(); child.close(); untracked.close();
  equal([...await prior.toArray()], [10, 20], 'closed nonleaf exposure leaves only weak retention hook');
  prior.close(); leaf.close();

  const a = session.tensor([2, 3], { requiresGrad: true }); const b = session.tensor([5, 7], { requiresGrad: true });
  a.grad = b; b.grad = a; a.close();
  equal([...await b.grad.toArray()], [2, 3], 'external root preserves mutual association');
  b.grad.close(); b.close();
  session.diagnostics();

  const owner = session.tensor([2, 3], { requiresGrad: true });
  let baseline;
  for (let iteration = 0; iteration < 32; iteration += 1) {
    const square = owner.mul(owner); const output = square.sum(); square.close(); output.backward(); output.close();
    let gradient = owner.grad;
    equal([...await gradient.toArray()], [4, 6], 'association reset permits fresh acquisition');
    if (semanticOwnership !== undefined) {
      const now = semanticOwnership(session);
      const live = Object.fromEntries(Object.entries(now).filter(([key]) => !key.startsWith('collector')));
      if (baseline === undefined) baseline = live; else equal(live, baseline, 'fixed roots bound semantic owning occurrences');
    }
    const alias = gradient.view([1, 2]);
    const zero = session.tensor([0, 0]);
    session.noGrad(() => gradient.copy_(zero)); zero.close();
    owner.grad = null; gradient.close();
    equal([...await alias.toArray()], [0, 0], 'clearing preserves exposed former gradient alias');
    alias.close();
  }
  owner.close();
  const diagnostics = session.diagnostics();
  equal([diagnostics.liveTensorHandles, diagnostics.liveTensorValues, diagnostics.liveDerivativeNodes, diagnostics.liveSavedValues, diagnostics.liveAllocationBytes], [0, 0, 0, 0, 0], 'semantic lifetime teardown');
}

/** Existing aliases observe base promotion, lazy resolution and special provenance. */
export async function checkTrackingEpochTransitions(session) {
  for (const throughView of [false, true]) {
    const base = session.tensor([0, 0]); const ordinary = base.view([2]); const nested = ordinary.view([1, 2]);
    const special = session.noGrad(() => base.view([2]));
    const specialNested = session.noGrad(() => special.view([1, 2]));
    const source = session.tensor([5, 7], { requiresGrad: true }); const handles = [base, ordinary, nested, special, specialNested];
    equal(handles.map(handle => handle.requiresGrad), [false, false, false, false, false], 'initial plain tracking');
    (throughView ? ordinary : base).copy_(source);
    equal(handles.map(handle => handle.requiresGrad), [true, true, true, true, true], 'old aliases see active promotion');
    const root = nested.sum(); const [gradient] = session.grad(root, [source]);
    equal([...await gradient.toArray()], [1, 1], 'lazy ordinary rebase preserves source derivative');
    equal(handles.map(handle => handle.requiresGrad), [true, true, true, true, true], 'tracking after lazy entry resolution');
    for (const handle of [special, specialNested]) {
      try { handle.sum(); throw new Error('dirty special view admitted an active operation'); }
      catch (error) { if (error.code !== 'INPLACE_VIEW') throw error; }
    }
    const plain = session.tensor([9, 11]); session.noGrad(() => base.copy_(plain));
    equal(handles.map(handle => handle.requiresGrad), [true, true, true, true, true], 'plain no-grad write preserves promoted tracking');
    const child = nested.view([2]); equal(child.requiresGrad, true, 'new child of unresolved old ordinary alias');
    base.close(); equal(nested.requiresGrad, true, 'closed base exposure preserves promoted tracking');
    for (const handle of [child, plain, gradient, root, source, ...handles.toReversed()]) handle.close();
  }
}

export const pythonBackwardLifetimeChecks = `
import torch, gc, weakref

def backward_lifetime_controls():
    for through_view in (False, True):
        base=torch.tensor([0.,0.],dtype=torch.float32)
        ordinary=base.view(2);nested=ordinary.view(1,2)
        with torch.no_grad():
            special=base.view(2);special_nested=special.view(1,2)
        source=torch.tensor([5.,7.],dtype=torch.float32,requires_grad=True)
        aliases=(base,ordinary,nested,special,special_nested)
        assert [v.requires_grad for v in aliases]==[False]*5
        (ordinary if through_view else base).copy_(source)
        assert [v.requires_grad for v in aliases]==[True]*5
        gradient=torch.autograd.grad(nested.sum(),source)[0]
        assert gradient.tolist()==[1.,1.]
        assert [v.requires_grad for v in aliases]==[True]*5
        for view in (special,special_nested):
            try:view.sum()
            except RuntimeError:pass
            else:raise AssertionError('dirty special view admitted active operation')
        with torch.no_grad():base.copy_(torch.tensor([9.,11.],dtype=torch.float32))
        assert [v.requires_grad for v in aliases]==[True]*5
        assert nested.view(2).requires_grad
        del aliases,base,ordinary,nested,special,special_nested,source,gradient,view
        gc.collect()
    leaf = torch.tensor([2., 3.], dtype=torch.float32, requires_grad=True)
    assigned = torch.tensor([10., 20.], dtype=torch.float32)
    leaf.grad = assigned
    root = (leaf * leaf).sum()
    reference = weakref.ref(leaf)
    del leaf
    gc.collect()
    assert reference() is None
    root.backward()
    assert assigned.tolist() == [14., 26.]
    del root, assigned
    a = torch.tensor([2., 3.], dtype=torch.float32, requires_grad=True)
    b = torch.tensor([5., 7.], dtype=torch.float32, requires_grad=True)
    a.grad = b; b.grad = a
    del a
    gc.collect()
    assert b.grad.tolist() == [2., 3.]
    del b
    gc.collect()
    for iteration in range(32):
        owner = torch.tensor([2., 3.], dtype=torch.float32, requires_grad=True)
        owner.grad = owner.view(2)
        del owner
        gc.collect()
    owner = torch.tensor([2., 3.], dtype=torch.float32, requires_grad=True)
    for iteration in range(16):
        (owner * owner).sum().backward()
        gradient = owner.grad
        assert gradient.tolist() == [4., 6.]
        alias = gradient.view(1, 2)
        with torch.no_grad(): gradient.copy_(torch.tensor([0., 0.], dtype=torch.float32))
        owner.grad = None
        del gradient
        gc.collect()
        assert alias.tolist() == [[0., 0.]]
        del alias
    del owner
backward_lifetime_controls()
gc.collect()
assert torch._runtime_session.diagnostics().liveTensorHandles == 0
assert torch._runtime_session.diagnostics().liveTensorValues == 0
assert torch._runtime_session.diagnostics().liveDerivativeNodes == 0
assert torch._runtime_session.diagnostics().liveSavedValues == 0
`;

/** Actual effect failures, without claiming native backend-fault correspondence. */
export async function checkBackwardFaults(createSession) {
  const fault = new Error('controlled backward effect failure');
  const session = createSession({ beforeCopyPublication() { throw fault; } });
  const x = session.tensor([2, 3], { requiresGrad: true }); const seed = session.tensor([5, 7]);
  const view = x.view([2]); view.backward(seed); const gradient = x.grad;
  const alias = gradient.view([1, 2]); const nested = alias.view([2]);
  let directObserved = false;
  try { await gradient.toArray(); }
  catch (error) { if (error !== fault && error.cause !== fault) throw error; directObserved = true; }
  if (!directObserved) throw new Error('acquisition writer failure did not reach its gradient');
  x.grad = null; gradient.close(); alias.close();
  let observed = false;
  try { await nested.toArray(); }
  catch (error) { if (error !== fault && error.cause !== fault) throw error; observed = true; }
  if (!observed) throw new Error('acquisition writer failure did not reach its public gradient view');
  equal([...await seed.toArray()], [5, 7], 'failed acquisition leaves independent caller seed readable');
  const fresh = session.tensor([2], { requiresGrad: true });
  try { fresh.backward(); throw new Error('terminal writer barrier admitted a gradient'); }
  catch (error) { if (error.code !== 'MUTATION_FAILED') throw error; }
  if (fresh.grad !== null) throw new Error('terminal barrier changed gradient association');
  await session.close();
  equal([session.diagnostics().liveTensorHandles, session.diagnostics().liveTensorValues, session.diagnostics().liveRequestLeases], [0, 0, 0], 'fault teardown');

  const dropped = createSession({ beforeCopyPublication() { throw fault; } });
  const owner = dropped.tensor([2], { requiresGrad: true }); const incoming = dropped.tensor([5]);
  owner.backward(incoming); owner.grad = null; owner.close(); incoming.close();
  let joined = false;
  try { await dropped.close(); }
  catch (error) { if (error !== fault && !(error instanceof AggregateError && error.errors.includes(fault))) throw error; joined = true; }
  if (!joined) throw new Error('closing dropped gradient lost its mandatory failure');
  equal([dropped.diagnostics().liveTensorValues, dropped.diagnostics().liveRequestLeases], [0, 0], 'unobserved effect teardown');
}

/** The real Python boundary joins a failed effect even after wrappers disappear. */
export async function checkPythonBackwardFaults(binding, CpuBackend) {
  const execute = CpuBackend.prototype.execute;
  const fault = new Error('controlled managed backward failure');
  let injected = false;
  CpuBackend.prototype.execute = function (...arguments_) {
    if (!injected) { injected = true; throw fault; }
    return execute.apply(this, arguments_);
  };
  let delivered = false;
  try {
    try {
      await binding.runPythonAsync(`
import torch, gc
def dropped_backward_effect():
    x = torch.tensor([2., 3.], dtype=torch.float32, requires_grad=True)
    (x * x).sum().backward()
    x.grad = None
    del x
    gc.collect()
dropped_backward_effect()
`);
    } catch (error) {
      if (error !== fault && error.cause !== fault) throw error;
      delivered = true;
    }
  } finally { CpuBackend.prototype.execute = execute; }
  if (!delivered || !injected) throw new Error('managed completion lost a dropped backward effect failure');
  await binding.runPythonAsync(`
def terminal_backward_barrier():
    fresh = torch.tensor([2.], dtype=torch.float32, requires_grad=True)
    try: fresh.backward()
    except Exception as error:
        assert 'failed write' in str(error).lower()
    else: raise AssertionError('terminal backward admitted a fresh slot')
    assert fresh.grad is None
terminal_backward_barrier()
gc.collect()
assert torch._runtime_session.diagnostics().liveRequestLeases == 0
`);
}

/** Independently fallible cycle retirement keeps an accepted read pinned. */
export async function checkBackwardCleanup(createSession, CpuBackend, Ticket, semanticOwnership) {
  await checkBackwardReplacementCleanup(createSession, CpuBackend, semanticOwnership);
  const session = createSession();
  const x = session.tensor([2], { requiresGrad: true }); const y = session.tensor([3], { requiresGrad: true });
  for (const owner of [x, y]) {
    const square = owner.mul(owner); const root = square.sum(); square.close(); root.backward(); root.close();
    await owner.grad.toArray();
  }
  const gx = x.grad; const gy = y.grad;
  const vx = gx.view([1]); const vy = gy.view([1]);
  x.grad = vx; gx.grad = x; y.grad = vy; gy.grad = y;
  const read = CpuBackend.prototype.read; const release = CpuBackend.prototype.release;
  let resume; const gate = new Promise(resolve => { resume = resolve; });
  const faults = [new Error('independent cycle release one'), new Error('independent pinned release two')];
  let released = 0;
  CpuBackend.prototype.read = function (...arguments_) {
    const values = read.apply(this, arguments_); return new Ticket(gate.then(() => values), gate);
  };
  CpuBackend.prototype.release = function (allocation) {
    release.call(this, allocation);
    throw faults[Math.min(released++, faults.length - 1)];
  };
  try {
    const observing = gx.toArray();
    gx.close(); gy.close(); vx.close(); vy.close(); x.close(); y.close();
    const closing = session.close();
    if (session.diagnostics().liveRequestLeases === 0 || session.diagnostics().liveTensorValues === 0) throw new Error('cycle collection released the pending read pin');
    resume();
    const outcomes = await Promise.allSettled([observing, closing]);
    if (outcomes[1].status !== 'rejected') throw new Error('session close lost independent cleanup errors');
    const errors = []; const pending = [outcomes[1].reason]; const seen = new Set();
    while (pending.length !== 0) {
      const error = pending.pop(); if (seen.has(error)) continue; seen.add(error); errors.push(error);
      if (error instanceof AggregateError) pending.push(...error.errors);
      if (error?.cause !== undefined) pending.push(error.cause);
    }
    if (!faults.every(fault => errors.includes(fault))) throw new Error('close did not collect both independent physical cleanup errors');
    if (released < 2) throw new Error('independent releases were abandoned');
    equal([session.diagnostics().liveTensorValues, session.diagnostics().liveRequestLeases, session.diagnostics().liveAllocationBytes], [0, 0, 0], 'fallible pinned-cycle teardown');
  } finally {
    resume(); CpuBackend.prototype.read = read; CpuBackend.prototype.release = release;
    await session.close().catch(() => undefined);
  }
}

/** A committed replacement must enqueue its effect before fallible old-owner retirement. */
export async function checkBackwardReplacementCleanup(createSession, CpuBackend, semanticOwnership) {
  const cleanup = new Error('controlled previous gradient child release');
  const writer = new Error('controlled committed replacement writer');
  let publications = 0;
  const session = createSession({ beforeCopyPublication() { publications += 1; throw writer; } });
  const x = session.tensor([2], { requiresGrad: true }); const mid = x.add(x); const root = mid.sum();
  const plain = session.tensor([1]);
  try { root.backward(undefined, { inputs: [mid, plain] }); throw new Error('untracked input accepted'); }
  catch (error) { if (error.code !== 'GRADIENT_NOT_TRACKED') throw error; }
  const old = session.tensor([10]); const left = session.tensor([3]); const right = session.tensor([4]);
  const child = left.add(right); equal([...await child.toArray()], [7], 'previous child resident');
  left.close(); right.close(); old.grad = child; mid.grad = old; old.close(); child.close();
  const release = CpuBackend.prototype.release;
  let releases = 0;
  CpuBackend.prototype.release = function (allocation) {
    release.call(this, allocation);
    if (releases++ === 0) throw cleanup;
  };
  try {
    let retired = false;
    try { root.backward(undefined, { inputs: [mid] }); }
    catch (error) { if (error !== cleanup) throw error; retired = true; }
    if (!retired || releases === 0) throw new Error('previous gradient child did not retire with its controlled release failure');
    if (mid.grad === null) throw new Error('cleanup failure rolled back the committed replacement');
    mid.grad.close(); mid.grad = null; root.close(); mid.close(); x.close(); plain.close();
    let delivered = false;
    try { await session.close(); }
    catch (error) { if (error !== writer && !(error instanceof AggregateError && error.errors.includes(writer))) throw error; delivered = true; }
    if (!delivered || publications !== 1) throw new Error(`committed replacement lost its mandatory writer: publications=${publications}, delivered=${delivered}`);
    equal([session.diagnostics().liveTensorHandles, session.diagnostics().liveTensorValues,
      session.diagnostics().liveDerivativeNodes, session.diagnostics().liveRequestLeases,
      session.diagnostics().liveAllocationBytes], [0, 0, 0, 0, 0], 'replacement cleanup teardown');
    if (semanticOwnership !== undefined) {
      for (const [key, count] of Object.entries(semanticOwnership(session))) {
        if (!key.startsWith('collector')) equal(count, 0, `replacement cleanup ${key}`);
      }
    }
  } finally { CpuBackend.prototype.release = release; await session.close().catch(() => undefined); }
}

/** Python views retain acquisition qualification after the slot and original wrapper disappear. */
export async function checkPythonBackwardAliasFault(binding, CpuBackend) {
  const execute = CpuBackend.prototype.execute;
  const fault = new Error('controlled Python alias acquisition writer');
  let injected = false;
  CpuBackend.prototype.execute = function (...arguments_) {
    if (!injected) { injected = true; throw fault; }
    return execute.apply(this, arguments_);
  };
  try {
    await binding.runPythonAsync(`
import torch, gc
def acquired_alias_fault():
    x=torch.tensor([2.,3.],dtype=torch.float32,requires_grad=True)
    seed=torch.tensor([5.,7.],dtype=torch.float32)+torch.tensor([0.,0.],dtype=torch.float32)
    x.view(2).backward(seed)
    gradient=x.grad
    alias=gradient.view(1,2).view(2)
    x.grad=None
    del gradient
    gc.collect()
    try:alias.tolist()
    except Exception as error:
        cause=getattr(error,'js_error',None)
        messages=[]
        while cause is not None:
            messages.append(str(cause))
            cause=getattr(cause,'cause',None)
        assert any('controlled Python alias acquisition writer' in message for message in messages),messages
    else:raise AssertionError('public Python gradient view lost acquisition writer failure')
    assert seed.tolist()==[5.,7.]
acquired_alias_fault()
gc.collect()
assert torch._runtime_session.diagnostics().liveTensorValues==0
assert torch._runtime_session.diagnostics().liveRequestLeases==0
`);
    if (!injected) throw new Error('Python alias control did not inject its acquisition failure');
  } finally { CpuBackend.prototype.execute = execute; }
}

/** Actual Python GC must not turn automatic physical cleanup into an ignored error. */
export async function checkPythonFinalizationFault(binding, CpuBackend) {
  const release = CpuBackend.prototype.release;
  const fault = new Error('controlled Python finalization release');
  let calls = 0;
  CpuBackend.prototype.release = function (allocation) { release.call(this, allocation); calls += 1; throw fault; };
  try {
    await binding.runPythonAsync(`
import torch, gc, sys
ignored_finalizer_errors=[]
previous_unraisable_hook=sys.unraisablehook
sys.unraisablehook=lambda event:ignored_finalizer_errors.append(type(event.exc_value).__name__)
def drop_resident_wrapper():
    x=torch.tensor([2.],dtype=torch.float32)+torch.tensor([3.],dtype=torch.float32)
    assert x.tolist()==[5.]
    del x
    gc.collect()
try:drop_resident_wrapper()
finally:sys.unraisablehook=previous_unraisable_hook
assert not ignored_finalizer_errors,ignored_finalizer_errors
assert torch._runtime_session.diagnostics().liveTensorValues==0
`);
    let delivered = false;
    try { await binding.close(); }
    catch (error) { if (error !== fault && error.cause !== fault) throw error; delivered = true; }
    if (!delivered || calls === 0) throw new Error('automatic Python cleanup was not delivered by session close');
  } finally { CpuBackend.prototype.release = release; await binding.close().catch(() => undefined); }
}
