import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { readFile } from "node:fs/promises";
import { loadPyodide } from "pyodide";
import { attachPython } from "../../../dist/python.js";
import { getTestTensorVersion, getTestRuntimeOwnership, getTestRuntimeSemanticOwnership } from "../../../dist/testing.js";
import { pythonSGDChecks } from "../../browser/helpers/sgd-cases.mjs";
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

test("Python SGD host closures preserve close priority and original exceptions", { timeout: 20_000 }, async () => {
  const interpreter = await loadPyodide(); const binding = await attachPython(interpreter);
  try { await binding.runPythonAsync(pythonSGDHostChecks); }
  finally { await binding.close(); }
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
