import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { loadPyodide } from "pyodide";
import { attachPython } from "../../../dist/python.js";
import { getTestTensorVersion, getTestRuntimeOwnership, getTestRuntimeSemanticOwnership } from "../../../dist/testing.js";
import { pythonSGDChecks } from "../../browser/helpers/sgd-cases.mjs";
import { pythonSGDConstructorCostSource } from "./sgd-constructor-cost.mjs";
import { pythonSGDHostChecks, checkPythonSGDFixedOwners, checkPythonSGDTeardown } from "../../browser/helpers/sgd-lifetime.mjs";
import { WebAssemblyCpuBackend } from "../../../dist/backends/cpu/cpu-backend.js";

before(() => mock.method(globalThis, "fetch", async (url) => {
  try { return new Response(await readFile(url)); }
  catch { return new Response(null, { status: 404 }); }
}));
after(() => mock.restoreAll());

test("Python SGD matches the pinned native corpus", { timeout: 30_000 }, async () => {
  const oracle = JSON.parse(await readFile(new URL("../../fixtures/python-tensor-oracle.json", import.meta.url), "utf8"));
  const interpreter = await loadPyodide();
  interpreter.globals.set("inspect_sgd_version", getTestTensorVersion);
  const binding = await attachPython(interpreter);
  try { await binding.runPythonAsync(pythonSGDChecks(oracle)); }
  finally { await binding.close(); }
});

test("Python SGD normalizes valid named tuples before rejecting deferred support", { timeout: 20_000 }, async () => {
  const interpreter = await loadPyodide(); const binding = await attachPython(interpreter);
  try {
    await binding.runPythonAsync(`
import torch, gc
def check_named_rejection():
    p = torch.tensor([2.], dtype=torch.float32)
    original = [('weight', p)]
    group = {'params': original}
    try: torch.optim.SGD([group])
    except NotImplementedError: pass
    else: raise AssertionError('named parameters became supported')
    assert group['params'] is not original
    assert len(group['params']) == 1 and group['params'][0] is p
    assert group['param_names'] == ['weight'] and group['lr'] == 0.001
check_named_rejection()
del check_named_rejection
gc.collect()
`);
    const ownership = getTestRuntimeOwnership(interpreter.runPython("torch._runtime_session"));
    assert.ok(Object.values(ownership).every((count) => count === 0));
  } finally { await binding.close(); }
});

test("Python SGD registers final stored members and rejects late unsupported options", { timeout: 20_000 }, async () => {
  const interpreter = await loadPyodide(); const binding = await attachPython(interpreter);
  try {
    await binding.runPythonAsync(`
import torch, gc
def check_constructor_registration():
    for mode in ('setter', 'getter', 'later-members', 'later-option'):
        p = torch.tensor([2.], dtype=torch.float32)
        q = torch.tensor([3.], dtype=torch.float32)
        class Group(dict):
            reads = 0
            writes = 0
            def __getitem__(self, key):
                if key == 'params':
                    self.reads += 1
                    if mode == 'getter' and self.reads == 2: return [q]
                return dict.__getitem__(self, key)
            def __setitem__(self, key, value):
                if key == 'params':
                    self.writes += 1
                    if mode == 'setter' and self.writes == 1: value = [q]
                dict.__setitem__(self, key, value)
        class Later(dict):
            def setdefault(self, key, default):
                value = dict.setdefault(self, key, default)
                if key == 'fused':
                    dict.__setitem__(first, 'params' if mode == 'later-members' else 'momentum', [q] if mode == 'later-members' else 1)
                return value
        original = [p]
        first = Group(params=original)
        later = Later(params=[])
        groups = [first, later] if mode.startswith('later-') else [first]
        if mode == 'later-option':
            try: torch.optim.SGD(groups, lr=0.5)
            except NotImplementedError: pass
            else: raise AssertionError('late unsupported option was ignored')
            assert dict.__getitem__(first, 'momentum') == 1
            assert dict.__getitem__(later, 'fused') is None
            continue
        optimizer = torch.optim.SGD(groups, lr=0.5)
        assert first.reads == (6 if mode == 'later-members' else 5)
        assert optimizer.param_groups[0] is first
        assert dict.__getitem__(first, 'params') is not original
        assert dict.__getitem__(first, 'params')[0] is q
        p.grad = torch.tensor([1.], dtype=torch.float32)
        q.grad = torch.tensor([1.], dtype=torch.float32)
        optimizer.step()
        assert p.tolist() == [2.] and q.tolist() == [2.5]
check_constructor_registration()
del check_constructor_registration
gc.collect()
`);
    const session = interpreter.runPython("torch._runtime_session");
    assert.ok(Object.values(getTestRuntimeOwnership(session)).every((count) => count === 0));
    assert.ok(Object.entries(getTestRuntimeSemanticOwnership(session))
      .filter(([key]) => !key.startsWith("collector")).every(([, count]) => count === 0));
  } finally { await binding.close(); }
});

test("Python SGD host closures preserve close priority and original exceptions", { timeout: 20_000 }, async () => {
  const interpreter = await loadPyodide(); const binding = await attachPython(interpreter);
  try { await binding.runPythonAsync(pythonSGDHostChecks); }
  finally { await binding.close(); }
});

test("actual Python capture views expire independently of borrowed callback proxies", { timeout: 20_000 }, async () => {
  const interpreter = await loadPyodide(); const binding = await attachPython(interpreter);
  try {
    await binding.runPythonAsync(`
import torch, gc
from pyodide.ffi import JsException
def check_capture_expiry():
    p = torch.tensor([2.], dtype=torch.float32)
    gradient = torch.tensor([3.], dtype=torch.float32)
    p.grad = gradient
    optimizer = torch.optim.SGD([p])
    views = []
    def collect(scope):
        views.append(scope)
        assert scope.capture(0)
        gradient._handle.close()
        p.grad = None
    optimizer._lease.withGroup(0, collect)
    for operation in (lambda: views[0].hasGradient(0), lambda: views[0].capture(0), lambda: views[0].apply(0)):
        try: operation()
        except JsException as error: assert 'scope has expired' in str(error)
        else: raise AssertionError('escaped capture view remained usable')
    assert p.tolist() == [2.]
check_capture_expiry()
del check_capture_expiry
gc.collect()
assert torch._runtime_session.diagnostics().liveTensorHandles == 0
assert torch._runtime_session.diagnostics().liveTensorValues == 0
`);
    const semantic = getTestRuntimeSemanticOwnership(interpreter.runPython("torch._runtime_session"));
    assert.equal(semantic.optimizerCaptureOccurrences, 0);
    assert.equal(semantic.optimizerCaptureScopes, 0);
  } finally { await binding.close(); }
});

test("Python derivatives preserve saved-detachment causes and lifetime categories after SGD reset", { timeout: 20_000 }, async () => {
  const interpreter = await loadPyodide();
  const binding = await attachPython(interpreter);
  try {
    await binding.runPythonAsync(`
import torch, gc
from pyodide.ffi import JsException
def check_derivative_errors():
    for differentiate in (lambda saved, x: saved.backward(), lambda saved, x: torch.autograd.grad(saved, x)):
        p = torch.tensor([2.], dtype=torch.float32, requires_grad=True)
        x = torch.tensor([3.], dtype=torch.float32, requires_grad=True)
        g = x * x
        saved = g * x
        p.grad = g
        optimizer = torch.optim.SGD([p])
        optimizer.zero_grad(False)
        assert not g.requires_grad and x.requires_grad and p.grad is g
        try:
            differentiate(saved, x)
        except RuntimeError as error:
            assert isinstance(error.__cause__, JsException)
            assert error.__cause__.js_error.code == 'SAVED_DETACHED'
        else:
            raise AssertionError('saved detachment accepted')
        saved._handle.close()
        try:
            differentiate(saved, x)
        except JsException as error:
            assert error.js_error.code == 'CLOSED_TENSOR'
            assert error.__cause__ is None
        else:
            raise AssertionError('closed derivative output accepted')
check_derivative_errors()
del check_derivative_errors
gc.collect()
`);
    assert.equal(interpreter.runPython("torch._runtime_session.diagnostics().liveTensorHandles"), 0);
  } finally { await binding.close(); }
});

test("Python basic SGD preserves wrapper and gradient identity", { timeout: 20_000 }, async () => {
  const interpreter = await loadPyodide();
  const binding = await attachPython(interpreter);
  try {
    await binding.runPythonAsync(`
import torch, gc
def check_sgd():
    p = torch.tensor([2.], dtype=torch.float32, requires_grad=True)
    p.grad = torch.tensor([3.], dtype=torch.float32)
    gradient = p.grad
    group = {'params': [p], 'lr': 0.5, 'tag': 'kept'}
    parameters = group['params']
    optimizer = torch.optim.SGD([group])
    assert optimizer.param_groups[0] is group
    assert group['params'] is not parameters
    assert group['params'][0] is p
    assert optimizer.step() is None
    assert p.tolist() == [0.5]
    assert p.grad is gradient
    optimizer.zero_grad(set_to_none=False)
    assert p.grad is gradient and gradient.tolist() == [0.]
    optimizer.zero_grad()
    assert p.grad is None and gradient.tolist() == [0.]
    assert not optimizer.state
check_sgd()
del check_sgd
gc.collect()
`);
    assert.equal(interpreter.runPython("torch._runtime_session.diagnostics().liveTensorHandles"), 0);
  } finally { await binding.close(); }
});

test("Python SGD fixed-owner training retires optimizer and completed history", { timeout: 30_000 }, async () => {
  const interpreter = await loadPyodide(); const binding = await attachPython(interpreter);
  try {
    for (const length of [32, 4096, 65536]) await checkPythonSGDFixedOwners(binding, interpreter, length, getTestRuntimeOwnership, getTestRuntimeSemanticOwnership);
  } finally { await binding.close(); }
});

test("Python SGD drains closed sessions, dropped writers and independent finalizer faults", { timeout: 30_000 }, async () => {
  const interpreter = await loadPyodide();
  await checkPythonSGDTeardown(attachPython, interpreter, WebAssemblyCpuBackend);
});

test("the public Python SGD example executes unchanged", { timeout: 20_000 }, async () => {
  const reference = await readFile(new URL("../../../docs/reference/sgd.md", import.meta.url), "utf8");
  const source = reference.match(/```python\n(import torch[\s\S]*?)\n```/)[1];
  const interpreter = await loadPyodide(); const binding = await attachPython(interpreter);
  try { await binding.runPythonAsync(source); }
  finally { await binding.close(); }
});

function assertConstructorWork(histories) {
  for (const { dimensions: [G, P], rows } of histories) for (const { metrics, beforeKeys } of rows) {
    assert.equal(metrics.nameComparisons ?? 0, 0);
    assert.equal(metrics.nameGates ?? 0, G * (G - 1) / 2);
    assert.equal(metrics.priorSetRebuilds ?? 0, G * (G - 1) / 2);
    assert.equal(metrics.normalizedGroups, G);
    assert.equal(metrics.normalizedParameters ?? 0, P);
    assert.equal(metrics.classifierCalls, 1);
    assert.equal(metrics.defaultKeys ?? 0, G > 1 ? 9 : 0);
    assert.equal(metrics.classifierGroups ?? 0, G > 1 ? G : 0);
    assert.equal(metrics.groupKeys ?? 0, G > 1 ? beforeKeys : 0);
    assert.equal(metrics.classifierParameters ?? 0, G > 1 ? P : 0);
    assert.equal(metrics.identityChecks ?? 0, G > 1 ? P : 0);
    assert.equal(metrics.classifierFast ?? 0, G > 1 ? 1 : 0);
  }
}

// Calibrate statement counters before using the independently varied matrix.
test("Python SGD constructor work counters resolve prefix and classifier costs", { timeout: 30_000 }, async () => {
  const interpreter = await loadPyodide(); const binding = await attachPython(interpreter);
  const pilot = [];
  for (const G of [1, 2, 3]) for (const P of [1, 2]) for (const K of [0, 1]) pilot.push([G, P, K, 1, "fresh"]);
  try {
    await binding.runPythonAsync(pythonSGDConstructorCostSource);
    const source = await readFile(new URL("../../../python/torch/optim.py", import.meta.url));
    assert.equal(interpreter.runPython("_COST_SOURCE_SHA"), createHash("sha256").update(source).digest("hex"));
    console.log("SGD constructor source " + interpreter.runPython("_COST_SOURCE_SHA"));
    interpreter.globals.set("_cost_dimensions", JSON.stringify(pilot));
    await binding.runPythonAsync("_cost_results = constructor_cost_cases(json.loads(_cost_dimensions))");
    const results = JSON.parse(interpreter.runPython("json.dumps(_cost_results)"));
    assertConstructorWork(results);
    for (const history of results) console.log("SGD constructor calibration " + JSON.stringify({ ...history, rows: history.rows.map(({ values, ...row }) => row) }));
    const dimensions = [];
    for (const G of [1, 2, 8, 32, 128]) for (const P of [1, 8, 128]) dimensions.push([G, P, 0, 1, "fresh"]);
    for (const K of [0, 8, 64]) for (const R of [1, 4]) for (const regime of ["fresh", "reused"]) dimensions.push([32, 8, K, R, regime]);
    dimensions.push([2, 0, 0, 1, "fresh"], [8, 0, 0, 1, "fresh"], [2, 0, 0, 4, "shared-empty"]);
    interpreter.globals.set("_cost_dimensions", JSON.stringify(dimensions));
    await binding.runPythonAsync("_cost_results = constructor_cost_cases(json.loads(_cost_dimensions))");
    const primary = JSON.parse(interpreter.runPython("json.dumps(_cost_results)"));
    assertConstructorWork(primary);
    for (const history of primary) console.log("SGD constructor structural rows " + JSON.stringify({ ...history, rows: history.rows.map(({ values, ...row }) => row) }));
    await binding.runPythonAsync("_cost_fallbacks = constructor_classifier_fallbacks(); gc.collect()");
    const fallbacks = JSON.parse(interpreter.runPython("json.dumps(_cost_fallbacks)"));
    assert.equal(fallbacks.length, 12);
    for (const row of fallbacks) {
      assert.equal(row.result, false); assert.deepEqual(row.events, []); assert.equal(row.unchanged, true);
      assert.equal(row.metrics.classifierCalls, 1); assert.equal(row.metrics.classifierFast ?? 0, 0);
      console.log("SGD classifier fallback " + JSON.stringify(row));
    }
    const session = interpreter.runPython("torch._runtime_session");
    assert.ok(Object.values(getTestRuntimeOwnership(session)).every((count) => count === 0));
    assert.ok(Object.entries(getTestRuntimeSemanticOwnership(session))
      .filter(([key]) => !key.startsWith("collector")).every(([, count]) => count === 0));
  } finally { await binding.close(); }
});
