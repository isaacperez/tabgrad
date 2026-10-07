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
}
