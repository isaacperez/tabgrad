function equal(actual, expected, name) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${name}: ${JSON.stringify(actual)} expected ${JSON.stringify(expected)}`);
}

function throwsCode(callback, expected) {
  try { callback(); }
  catch (error) { if (error.code === expected) return; throw error; }
  throw new Error(`Expected ${expected}`);
}

export async function checkSGDHostGuards(createSession, version) {
  for (const closed of ["tensor", "optimizer", "session", "optimizer-and-tensor", "all"]) {
    const session = createSession();
    const p = session.tensor([2], { requiresGrad: true }); const g = session.tensor([3]); p.grad = g;
    const optimizer = session.sgd([p]);
    const expected = ["session", "all"].includes(closed) ? "CLOSED_SESSION" : closed.startsWith("optimizer") ? "CLOSED_OPTIMIZER" : "CLOSED_TENSOR";
    const close = () => {
      if (["tensor", "optimizer-and-tensor", "all"].includes(closed)) p.close();
      if (["optimizer", "optimizer-and-tensor", "all"].includes(closed)) optimizer.close();
      if (["session", "all"].includes(closed)) void session.close();
    };
    try {
      throwsCode(() => optimizer.step(() => { close(); return {}; }), expected);
      equal(version(p), 0, "post-closure guards must precede any update");
      let calls = 0;
      throwsCode(() => optimizer.step(() => { calls += 1; }), expected);
      equal(calls, 0, "upfront guards must precede closure");
      throwsCode(() => optimizer.zeroGrad(), expected);
    } finally { optimizer.close(); await session.close(); }
  }
  for (const closed of ["tensor", "optimizer", "session"]) {
    const session = createSession(); const p = session.tensor([2], { requiresGrad: true }); const optimizer = session.sgd([p]);
    const original = new Error("original closure failure");
    try {
      session.noGrad(() => {
        try {
          optimizer.step(() => {
            if (closed === "tensor") p.close();
            if (closed === "optimizer") optimizer.close();
            if (closed === "session") void session.close();
            throw original;
          });
          throw new Error("closure exception lost");
        } catch (error) { if (error !== original) throw error; }
        if (closed !== "session") {
          const fresh = session.tensor([1], { requiresGrad: true }); const result = fresh.add(fresh);
          equal(result.requiresGrad, false, "throw restoration inside noGrad"); result.close(); fresh.close();
        }
      });
      equal(version(p), 0, "throwing closure cannot start SGD");
    } finally { optimizer.close(); await session.close(); }
  }
}

export async function checkSGDFaults(createSession, version, ownership, semantic, CpuBackend) {
  const progress = createSession();
  const p = progress.tensor([2]); const q = progress.tensor([4]); const g = progress.tensor([3]); const replacement = progress.tensor([9]);
  p.grad = g;
  const optimizer = progress.sgd([{ params: [p], lr: 0.5 }, { params: [q], lr: 0.5 }]);
  try {
    optimizer.paramGroups[1].momentum = 1;
    throwsCode(() => optimizer.step(), "UNSUPPORTED_OPTIMIZER");
    equal([version(p), version(q)], [1, 0], "earlier group progress");
    const observing = p.toArray();
    p.grad = replacement; optimizer.zeroGrad();
    g.close(); replacement.close(); p.close(); q.close(); optimizer.close();
    const closing = progress.close();
    equal([...await observing], [0.5], "accepted capture survives error/reset/replacement/drop");
    await closing;
    equal(ownership(progress).pendingCopies, 0, "progress effects drained");
  } finally { optimizer.close(); await progress.close(); }

  const fault = new Error("SGD mandatory physical writer failure"); let publications = 0;
  const failed = createSession({ beforeCopyPublication() { publications += 1; throw fault; } });
  const left = failed.tensor([2]); const right = failed.tensor([4]); const gradient = failed.tensor([3]);
  left.grad = gradient; right.grad = gradient;
  const failing = failed.sgd([left, right], { lr: 0.5 });
  try {
    failing.step();
    if (ownership(failed).pendingCopies === 0) throw new Error("cold SGD write was not retained while preparing");
    failing.zeroGrad(false);
    try { await left.toArray(); throw new Error("writer failure was hidden"); }
    catch (error) { if (error !== fault && error.cause !== fault) throw error; }
    const before = [version(left), version(right)];
    throwsCode(() => failing.step(), "MUTATION_FAILED");
    equal([version(left), version(right)], before, "terminal barrier rejected new mutations");
    equal(publications, 1, "failed physical context was not retried");
    gradient.close(); left.close(); right.close(); failing.close();
    await failed.close();
    equal([ownership(failed).pendingCopies, ownership(failed).undeliveredEffects, failed.diagnostics().liveTensorValues, failed.diagnostics().liveAllocationBytes], [0, 0, 0, 0], "failed write drain");
  } finally { failing.close(); await failed.close().catch(() => undefined); }

  const cleanup = createSession(); const first = cleanup.tensor([2]); const second = cleanup.tensor([4]);
  for (const parameter of [first, second]) {
    const computed = parameter.add(parameter);
    cleanup.noGrad(() => parameter.copy_(computed));
    await parameter.toArray(); computed.close();
  }
  const roots = cleanup.sgd([first, second, first]); first.close(); second.close();
  const release = CpuBackend.prototype.release; const faults = [new Error("first optimizer release"), new Error("second optimizer release")]; let calls = 0;
  CpuBackend.prototype.release = function (allocation) { release.call(this, allocation); throw faults[calls++]; };
  try {
    try { roots.close(); throw new Error("cleanup errors were lost"); }
    catch (error) {
      if (!(error instanceof AggregateError) || !faults.every((fault) => error.errors.includes(fault))) throw error;
    }
    equal(calls, 2, "independent physical releases");
    equal([semantic(cleanup).optimizerOccurrences, semantic(cleanup).optimizerRegistrations, semantic(cleanup).identities], [0, 0, 0], "logical retirement before physical errors");
    roots.close();
  } finally { CpuBackend.prototype.release = release; await cleanup.close(); }
}

/** Fixed-owner checkpoints distinguish logical pins, allocator capacity and host memory. */
export async function checkSGDFixedOwners(session, length, ownership, semantic) {
  const p = session.tensor(new Float32Array(length).fill(1), { requiresGrad: true });
  const alias = p.view([length]); const keptProduct = p.mul(p); const keptSave = keptProduct.sum();
  const optimizer = session.sgd([p], { lr: 0.001 }); const snapshots = [];
  let gradient;
  let previous = 0;
  try {
    for (const steps of [16, 64, 128]) {
      const start = performance.now();
      for (let index = previous; index < steps; index += 1) {
        optimizer.zeroGrad(false);
        const product = p.mul(p); const loss = product.sum();
        loss.backward(); loss.close(); product.close();
        gradient ??= p.grad;
        optimizer.step();
        const value = await p.toArray();
        if (value.length !== length || !Number.isFinite(value[0])) throw new Error("fixed-owner training result invalid");
      }
      const elapsed = performance.now() - start;
      const diagnostic = session.diagnostics();
      const owners = ownership(session); const identities = semantic(session);
      if (owners.pendingCopies !== 0 || owners.undeliveredEffects !== 0 || diagnostic.liveRequestLeases !== 0) throw new Error("checkpoint was not drained");
      snapshots.push({ steps, batchSteps: steps - previous, milliseconds: elapsed, owners,
        semantic: Object.fromEntries(Object.entries(identities).filter(([key]) => !key.startsWith("collector"))),
        history: { nodes: diagnostic.liveDerivativeNodes, saves: diagnostic.liveSavedValues, operations: diagnostic.liveOperationRecords, materializations: diagnostic.liveMaterializationRecords, values: diagnostic.liveTensorValues },
        physical: { liveBytes: diagnostic.liveAllocationBytes, reservedBytes: diagnostic.reservedAllocationBytes, wasmBytes: diagnostic.wasmMemoryBytes },
        host: typeof process !== "undefined" && process.memoryUsage ? process.memoryUsage()
          : globalThis.performance.memory ? { jsHeapUsedBytes: globalThis.performance.memory.usedJSHeapSize } : null });
      previous = steps;
    }
    for (const key of ["owners", "semantic", "history", "physical"]) {
      for (const snapshot of snapshots.slice(1)) equal(snapshot[key], snapshots[0][key], `fixed-owner ${key} stability`);
    }
    throwsCode(() => keptSave.backward(), "SAVED_VERSION_MISMATCH");
    keptSave.close(); keptProduct.close();
    if (session.diagnostics().liveSavedValues !== 0) throw new Error("retired user save still pinned");
    return snapshots;
  } finally { keptSave.close(); keptProduct.close(); optimizer.close(); gradient?.close(); alias.close(); p.close(); }
}

export const pythonSGDHostChecks = `
import torch, gc
from pyodide.ffi import JsException
def _check_sgd_hosts():
    for reset in (False, True):
        for closing in ('current', 'later-group', 'later-occurrence', 'optimizer', 'optimizer-and-tensor'):
            for throwing in (False, True):
                p = torch.tensor([2.], dtype=torch.float32, requires_grad=True)
                q = torch.tensor([4.], dtype=torch.float32)
                first = torch.tensor([3.], dtype=torch.float32)
                later = torch.tensor([5.], dtype=torch.float32)
                p.grad = first; q.grad = later
                original = LookupError('reset close sentinel'); calls = []
                class Group(dict):
                    armed = False
                    def __getitem__(self, key):
                        value = super().__getitem__(key)
                        if self.armed:
                            calls.append(key)
                            if key == 'params':
                                if closing == 'current': p._handle.close()
                                if closing.startswith('later') or closing == 'optimizer-and-tensor': q._handle.close()
                                if closing.startswith('optimizer'): optimizer._lease.close()
                                if throwing: raise original
                        return value
                group = Group(params=[p, q] if closing == 'later-occurrence' else [p])
                optimizer = torch.optim.SGD([group] if closing == 'later-occurrence' else [group, {'params': [q]}])
                group.armed = True
                with torch.no_grad():
                    try: optimizer.zero_grad(reset)
                    except LookupError as error: assert throwing and error is original
                    except JsException as error:
                        assert not throwing
                        assert error.js_error.code == ('CLOSED_OPTIMIZER' if closing.startswith('optimizer') else 'CLOSED_TENSOR')
                    else: raise AssertionError('reset admitted closed target')
                    if closing != 'current': assert not (p+p).requires_grad
                assert calls == ['params']
                assert later.tolist() == [5.]
                assert first.tolist() == ([0.] if not reset and closing.startswith('later') and not throwing else [3.])
                if closing.startswith('later'): assert p.grad is (None if reset and not throwing else first)
        for closing in ('tensor', 'optimizer', 'optimizer-and-tensor'):
            p = torch.tensor([2.], dtype=torch.float32)
            q = torch.tensor([4.], dtype=torch.float32)
            gradient = torch.tensor([3.], dtype=torch.float32); p.grad = gradient
            calls = []
            class Group(dict):
                armed = False
                def __getitem__(self, key):
                    if self.armed: calls.append(key)
                    return super().__getitem__(key)
            group = Group(params=[p])
            optimizer = torch.optim.SGD([group, {'params': [q]}]); group.armed = True
            if closing != 'optimizer': q._handle.close()
            if closing != 'tensor': optimizer._lease.close()
            try: optimizer.zero_grad(reset)
            except JsException as error: assert error.js_error.code == ('CLOSED_TENSOR' if closing == 'tensor' else 'CLOSED_OPTIMIZER')
            else: raise AssertionError('reset entry accepted closed owner')
            assert calls == [] and gradient.tolist() == [3.] and p.grad is gradient
    for closing in ('tensor', 'optimizer'):
        for outcome in ('coefficient', 'original', 'unsupported', 'admission'):
            p = torch.tensor([2.], dtype=torch.float32, requires_grad=True)
            q = torch.tensor([4.], dtype=torch.float32)
            p.grad = torch.tensor([3.], dtype=torch.float32)
            original = LookupError('dictionary close sentinel')
            class Group(dict):
                armed = False
                fired = False
                def __getitem__(self, key):
                    value = super().__getitem__(key)
                    if self.armed and key == 'momentum' and not self.fired:
                        self.fired = True
                        if closing == 'tensor': q._handle.close()
                        else: optimizer._lease.close()
                        if outcome == 'original': raise original
                        if outcome == 'unsupported': return 1
                    if self.armed and key == 'lr' and outcome == 'coefficient': return 'bad'
                    return value
            group = Group(params=[p], lr=0.5)
            optimizer = torch.optim.SGD([group, {'params': [q]}])
            group.armed = True
            with torch.no_grad():
                try: optimizer.step()
                except LookupError as error: assert outcome == 'original' and error is original
                except TypeError: assert outcome == 'coefficient'
                except NotImplementedError: assert outcome == 'unsupported'
                except JsException as error:
                    assert outcome == 'admission'
                    assert error.js_error.code == ('CLOSED_TENSOR' if closing == 'tensor' else 'CLOSED_OPTIMIZER')
                else: raise AssertionError('dictionary close was ignored')
                assert not (p+p).requires_grad
            assert p.tolist() == [2.]
    for restructure in ('parameters', 'group', 'state'):
        p = torch.tensor([2.], dtype=torch.float32, requires_grad=True)
        q = torch.tensor([4.], dtype=torch.float32)
        p.grad = torch.tensor([3.], dtype=torch.float32)
        optimizer = torch.optim.SGD([p], lr=0.5)
        def changed_structure():
            if restructure == 'parameters': optimizer.param_groups[0]['params'] = [q]
            elif restructure == 'group': optimizer.param_groups[0] = {'params': [q], 'lr': 0.5}
            else: optimizer.state[p]['injected'] = 1
        with torch.no_grad():
            try: optimizer.step(changed_structure)
            except NotImplementedError: pass
            else: raise AssertionError('closure used stale registered roots')
            assert not (p+p).requires_grad
        assert p.tolist() == [2.]
    for closed in ('tensor', 'optimizer', 'optimizer-and-tensor'):
        p = torch.tensor([2.], dtype=torch.float32, requires_grad=True)
        p.grad = torch.tensor([3.], dtype=torch.float32)
        optimizer = torch.optim.SGD([p])
        calls = []
        def closure():
            calls.append(1)
            if closed != 'optimizer': p._handle.close()
            if closed != 'tensor': optimizer._lease.close()
            return object()
        expected = 'CLOSED_TENSOR' if closed == 'tensor' else 'CLOSED_OPTIMIZER'
        for call in (lambda: optimizer.step(closure), optimizer.zero_grad):
            try: call()
            except JsException as error: assert error.js_error.code == expected
            else: raise AssertionError('closed owner accepted')
        assert calls == [1]
    p = torch.tensor([2.], dtype=torch.float32, requires_grad=True)
    optimizer = torch.optim.SGD([p])
    original = ValueError('original closure exception')
    def failing():
        optimizer._lease.close()
        raise original
    with torch.no_grad():
        try: optimizer.step(failing)
        except ValueError as error: assert error is original
        else: raise AssertionError('closure exception lost')
        assert not (p+p).requires_grad
_check_sgd_hosts()
del _check_sgd_hosts
gc.collect()
assert torch._runtime_session.diagnostics().liveTensorHandles == 0
assert torch._runtime_session.diagnostics().liveDerivativeNodes == 0
`;

export async function checkPythonSGDFixedOwners(binding, interpreter, length, ownership, semantic) {
  await binding.runPythonAsync(`
import torch, gc
_sgd_p = torch.tensor([1.] * ${length}, dtype=torch.float32, requires_grad=True)
_sgd_alias = _sgd_p.view(${length})
_sgd_kept = _sgd_p * _sgd_p
_sgd_save = _sgd_kept.sum()
_sgd_optimizer = torch.optim.SGD([_sgd_p], lr=0.001)
def _sgd_train(count):
    for _ in range(count):
        _sgd_optimizer.zero_grad(False)
        (_sgd_p * _sgd_p).sum().backward()
        _sgd_optimizer.step()
        assert len(_sgd_p.tolist()) == ${length}
    gc.collect()
`);
  const session = interpreter.runPython("torch._runtime_session");
  const snapshots = [];
  let previous = 0;
  try {
    for (const steps of [16, 64, 128]) {
      const start = performance.now();
      await binding.runPythonAsync(`_sgd_train(${steps - previous})`);
      const diagnostic = session.diagnostics();
      snapshots.push({ steps, batchSteps: steps - previous, milliseconds: performance.now() - start,
        owners: ownership(session), semantic: Object.fromEntries(Object.entries(semantic(session)).filter(([key]) => !key.startsWith("collector"))),
        history: { nodes: diagnostic.liveDerivativeNodes, saves: diagnostic.liveSavedValues, operations: diagnostic.liveOperationRecords, materializations: diagnostic.liveMaterializationRecords, values: diagnostic.liveTensorValues },
        physical: { liveBytes: diagnostic.liveAllocationBytes, reservedBytes: diagnostic.reservedAllocationBytes, wasmBytes: diagnostic.wasmMemoryBytes },
        host: typeof process !== "undefined" && process.memoryUsage ? process.memoryUsage() : globalThis.performance.memory ? { jsHeapUsedBytes: globalThis.performance.memory.usedJSHeapSize } : null });
      if (snapshots.at(-1).owners.pendingCopies !== 0 || snapshots.at(-1).owners.undeliveredEffects !== 0 || diagnostic.liveRequestLeases !== 0) throw new Error("Python SGD checkpoint not drained");
      previous = steps;
    }
    for (const key of ["owners", "semantic", "history", "physical"]) {
      for (const snapshot of snapshots.slice(1)) equal(snapshot[key], snapshots[0][key], `Python fixed-owner ${key} stability`);
    }
    await binding.runPythonAsync(`
try: _sgd_save.backward()
except RuntimeError: pass
else: raise AssertionError('saved version guard lost')
`);
    return snapshots;
  } finally {
    await binding.runPythonAsync("del _sgd_p, _sgd_alias, _sgd_kept, _sgd_save, _sgd_optimizer, _sgd_train; gc.collect()");
    equal([session.diagnostics().liveTensorHandles, session.diagnostics().liveTensorValues, session.diagnostics().liveDerivativeNodes, session.diagnostics().liveSavedValues, ownership(session).pendingCopies], [0, 0, 0, 0, 0], "Python optimizer finalization and retirement");
  }
}

export async function checkPythonSGDTeardown(attachPython, interpreter, CpuBackend) {
  for (const reset of [false, true]) for (const throwing of [false, true]) {
    const binding = await attachPython(interpreter);
    try {
      await binding.runPythonAsync(`
import torch
from pyodide.ffi import JsException
def closed_session_reset():
    p = torch.tensor([2.], dtype=torch.float32)
    p.grad = torch.tensor([3.], dtype=torch.float32)
    original = LookupError('reset session sentinel'); calls = []
    class Group(dict):
        armed = False
        def __getitem__(self, key):
            value = super().__getitem__(key)
            if self.armed:
                calls.append(key)
                if key == 'params':
                    optimizer._lease.close(); p._handle.close(); torch._runtime_session.close()
                    if ${throwing ? "True" : "False"}: raise original
            return value
    group = Group(params=[p]); optimizer = torch.optim.SGD([group]); group.armed = True
    try: optimizer.zero_grad(${reset ? "True" : "False"})
    except LookupError as error: assert ${throwing ? "True" : "False"} and error is original
    except JsException as error: assert not ${throwing ? "True" : "False"} and error.js_error.code == 'CLOSED_SESSION'
    else: raise AssertionError('reset session close was ignored')
    assert calls == ['params']
    try: optimizer.zero_grad(${reset ? "True" : "False"})
    except JsException as error: assert error.js_error.code == 'CLOSED_SESSION'
    else: raise AssertionError('closed reset invoked getter')
    assert calls == ['params']
closed_session_reset()
del closed_session_reset
`);
    } finally { await binding.close(); }
  }
  for (const throwing of [false, true]) {
    const binding = await attachPython(interpreter);
    try {
      await binding.runPythonAsync(`
import torch
from pyodide.ffi import JsException
def closed_session_closure():
    p = torch.tensor([2.], dtype=torch.float32, requires_grad=True)
    optimizer = torch.optim.SGD([p]); calls = []; original = ValueError('original')
    def closure():
        calls.append(1)
        torch._runtime_session.close()
        if ${throwing ? "True" : "False"}: raise original
        return object()
    try: optimizer.step(closure)
    except ValueError as error: assert ${throwing ? "True" : "False"} and error is original
    except JsException as error: assert not ${throwing ? "True" : "False"} and error.js_error.code == 'CLOSED_SESSION'
    else: raise AssertionError('session close was ignored')
    assert calls == [1]
    try: optimizer.step(closure)
    except JsException as error: assert error.js_error.code == 'CLOSED_SESSION'
    else: raise AssertionError('closed session invoked closure')
    assert calls == [1]
closed_session_closure()
del closed_session_closure
`);
    } finally { await binding.close(); }
  }
  const failed = await attachPython(interpreter);
  const execute = CpuBackend.prototype.execute;
  const fault = new Error("dropped Python SGD mandatory writer"); let calls = 0;
  CpuBackend.prototype.execute = function (...arguments_) { calls += 1; throw fault; };
  try {
    let delivered = false;
    try {
      await failed.runPythonAsync(`
import torch, gc
def dropped_sgd_effect():
    p = torch.tensor([2.], dtype=torch.float32)
    p.grad = torch.tensor([3.], dtype=torch.float32)
    optimizer = torch.optim.SGD([p], lr=0.5)
    optimizer.step(); optimizer.zero_grad()
    del optimizer, p
    gc.collect()
dropped_sgd_effect()
del dropped_sgd_effect
`);
    } catch (error) { if (error !== fault && error.cause !== fault) throw error; delivered = true; }
    if (!delivered || calls !== 1) throw new Error("managed SGD drain lost or retried its writer failure");
  } finally { CpuBackend.prototype.execute = execute; await failed.close(); }

  const finalized = await attachPython(interpreter);
  await finalized.runPythonAsync(`
import torch, gc, sys
_sgd_first = torch.tensor([2.], dtype=torch.float32) + torch.tensor([2.], dtype=torch.float32)
_sgd_second = torch.tensor([3.], dtype=torch.float32) + torch.tensor([3.], dtype=torch.float32)
assert _sgd_first.tolist() == [4.] and _sgd_second.tolist() == [6.]
_sgd_owner = torch.optim.SGD([_sgd_first, _sgd_second])
_sgd_first._handle.close(); _sgd_second._handle.close()
del _sgd_first, _sgd_second
`);
  const release = CpuBackend.prototype.release;
  const faults = [new Error("optimizer finalize first release"), new Error("optimizer finalize second release")]; let releases = 0;
  CpuBackend.prototype.release = function (allocation) { release.call(this, allocation); throw faults[releases++]; };
  try {
    await finalized.runPythonAsync(`
_sgd_unraisable = []; _sgd_previous_hook = sys.unraisablehook
sys.unraisablehook = lambda event: _sgd_unraisable.append(type(event.exc_value).__name__)
try:
    del _sgd_owner
    gc.collect()
finally: sys.unraisablehook = _sgd_previous_hook
assert not _sgd_unraisable
assert torch._runtime_session.diagnostics().liveTensorValues == 0
del _sgd_unraisable, _sgd_previous_hook
`);
    try { await finalized.close(); throw new Error("optimizer finalization failure lost"); }
    catch (error) {
      if (!(error instanceof AggregateError) || !faults.every(fault => error.errors.includes(fault))) throw error;
    }
    equal(releases, 2, "independent optimizer finalizer cleanup");
  } finally { CpuBackend.prototype.release = release; await finalized.close().catch(() => undefined); }

  const captureFailure = await attachPython(interpreter);
  await captureFailure.runPythonAsync(`
import torch, gc
from pyodide.ffi import JsException
_capture_p = torch.tensor([2.], dtype=torch.float32)
_capture_seed = torch.tensor([3.], dtype=torch.float32)
_capture_g = _capture_seed + _capture_seed
assert _capture_g.tolist() == [6.]
del _capture_seed
gc.collect()
_capture_p.grad = _capture_g
_capture_original = LookupError('original capture callback')
class _CaptureGroup(dict):
    armed = False
    def __getitem__(self, key):
        value = super().__getitem__(key)
        if self.armed and key == 'lr':
            _capture_g._handle.close()
            _capture_p.grad = None
            raise _capture_original
        return value
_capture_group = _CaptureGroup(params=[_capture_p], lr=0.5)
_capture_owner = torch.optim.SGD([_capture_group])
_capture_group.armed = True
`);
  const captureFault = new Error("Python capture physical release"); let captureReleases = 0;
  CpuBackend.prototype.release = function (allocation) { release.call(this, allocation); captureReleases += 1; throw captureFault; };
  try {
    await captureFailure.runPythonAsync(`
def _check_capture_causes():
    try: _capture_owner.step()
    except BaseExceptionGroup as error:
        assert len(error.exceptions) == 2
        assert error.exceptions[0] is _capture_original
        assert isinstance(error.exceptions[1], JsException)
        assert 'Python capture physical release' in str(error.exceptions[1])
    else: raise AssertionError('capture primary/cleanup causes lost')
    assert _capture_p.tolist() == [2.]
_check_capture_causes()
del _check_capture_causes, _capture_owner, _capture_group, _CaptureGroup
del _capture_original, _capture_p, _capture_g
gc.collect()
assert torch._runtime_session.diagnostics().liveTensorHandles == 0
assert torch._runtime_session.diagnostics().liveTensorValues == 0
`);
    equal(captureReleases, 1, "Python capture independent retirement");
  } finally { CpuBackend.prototype.release = release; await captureFailure.close(); }
}
